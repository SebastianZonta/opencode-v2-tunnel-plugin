import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import Bonjour from "bonjour-service";
import { Beacon, BEACON_PORT } from "./beacon";
import { PeerRegistry, type PeerAnnouncement, type PeerInfo } from "./peers";

export const MAX_TEXT_BYTES = 64 * 1024;
export const BASE_PORT = 41737;
// Bare name: the lib renders the wire type _opencode-hub._tcp.local (spec §2).
export const SERVICE_TYPE = "opencode-hub";
export const PROTO_VERSION = "1";
const PUBLISH_WAIT_MS = 5_000;
const MAX_NAME_TRIES = 10;
// Spec section 4: 6-digit, 5-minute, single-use pairing codes.
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

export interface PairedPeer {
  id: string;
  name: string;
  pairedAt: string; // ISO-8601
  // Where the peer was last seen. Presence is live-only, so this is what a
  // restarted hub re-probes instead of waiting for multicast it may never get.
  port?: number;
  addresses?: string[];
}

export interface HubOptions {
  peerTimeoutMs?: number;
  // TOFU store location; defaults to ~/.config/opencode/hub-peers.json.
  // Tests pass a temp file.
  peersPath?: string;
  now?: () => number;
  // Local expiry for unanswered requests; default 60 s. Tests inject less.
  requestTimeoutMs?: number;
  // UDP-beacon fallback (ticket 05): heartbeat interval, target host,
  // and rendezvous port. Defaults broadcast every 3 s on 41837; tests use
  // loopback + custom ports + short intervals.
  beaconIntervalMs?: number;
  beaconTarget?: string;
  beaconPort?: number;
  // Filtered-network refresh: how often remembered paired addresses are
  // re-probed while started. Default 15 s — under the 30 s presence TTL,
  // so paired peers stay listed where mDNS and beacons are both filtered.
  // Tests inject less.
  reconnectIntervalMs?: number;
  // Fired for each queued incoming message; the adapter wires it to
  // client.tui.showToast (ticket 04 arrival UX).
  onMessage?: (m: Envelope) => void;
}

export interface Envelope {
  id: string;
  from: string;
  to: string;
  type: "request" | "response" | "error";
  inReplyTo?: string;
  text: string;
  ts: string; // ISO-8601, per spec section 3
}

// Local system notice (e.g. request timeout). Lives in the inbox list so
// numbering matches hub_reply <n>; never sent on the wire.
export interface Notice {
  kind: "notice";
  text: string;
  ts: string; // ISO-8601
}

export function isNotice(v: unknown): v is Notice {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;
  return (
    n.kind === "notice" &&
    typeof n.text === "string" &&
    typeof n.ts === "string"
  );
}

export const createId = () => randomUUID();

export function isEnvelope(v: unknown): v is Envelope {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (
    typeof e.id !== "string" ||
    typeof e.from !== "string" ||
    typeof e.to !== "string"
  )
    return false;
  if (e.type !== "request" && e.type !== "response" && e.type !== "error")
    return false;
  if (typeof e.text !== "string" || Buffer.byteLength(e.text) > MAX_TEXT_BYTES)
    return false;
  if (typeof e.ts !== "string") return false;
  // Only requests open a thread; responses/errors must answer one.
  if (e.type === "request") {
    if (e.inReplyTo !== undefined && typeof e.inReplyTo !== "string")
      return false;
  } else if (typeof e.inReplyTo !== "string") return false;
  return true;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

export interface Peer extends PeerInfo {
  paired: boolean;
}

export class HubCore {
  private server: Server | null = null;
  private received: Array<Envelope | Notice> = [];
  private bonjour: Bonjour | null = null;
  private browser: Bonjour.Browser | null = null;
  private beacon: Beacon | null = null;
  private registry: PeerRegistry;
  private paired = new Map<string, PairedPeer>();
  private pendingCodes = new Map<string, number>(); // code -> issuedAt ms
  // Own outgoing requests awaiting a response: id -> {peer, sentAt ms}.
  private pending = new Map<string, { to: string; name: string; sentAt: number }>();
  private readonly peersPath: string;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly beaconIntervalMs?: number;
  private readonly beaconTarget?: string;
  private readonly beaconPort?: number;
  private readonly reconnectIntervalMs: number;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  onMessage: ((m: Envelope) => void) | null = null;
  advertisedName = "";
  port = 0;

  constructor(
    readonly id: string,
    readonly name: string,
    opts: HubOptions = {},
  ) {
    this.registry = new PeerRegistry(opts.peerTimeoutMs);
    this.peersPath = opts.peersPath ?? defaultPeersPath();
    this.now = opts.now ?? Date.now;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.beaconIntervalMs = opts.beaconIntervalMs;
    this.beaconTarget = opts.beaconTarget;
    this.beaconPort = opts.beaconPort;
    this.reconnectIntervalMs = opts.reconnectIntervalMs ?? 15_000;
    this.onMessage = opts.onMessage ?? null;
    this.loadPeers();
  }

  async start(port = BASE_PORT): Promise<number> {
    if (this.server) return this.port;
    for (let p = port; p < port + 100; p++) {
      const server = createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) json(res, 500, { status: "error" });
        });
      });
      const bound = await new Promise<boolean>((resolve) => {
        const onError = () => resolve(false);
        server.once("error", onError);
        server.listen(p, "0.0.0.0", () => {
          server.off("error", onError);
          resolve(true);
        });
      });
      if (bound) {
        this.server = server;
        this.port = p;
        await this.startDiscovery();
        // Not awaited: a dead peer's probe timeout must not delay the
        // listener becoming visible.
        void this.reconnect().catch(() => {});
        // Filtered nets kill mDNS and beacons while presence expires, so
        // re-probe remembered addresses in the background — or paired peers
        // vanish ~30 s after start and never come back.
        this.reconnectTimer = setInterval(() => {
          void this.reconnect().catch(() => {});
        }, this.reconnectIntervalMs);
        this.reconnectTimer.unref?.();
        return p;
      }
    }
    throw new Error("hub: no free port");
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.port = 0;
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (s)
      await new Promise<void>((resolve, reject) =>
        s.close((e) => (e ? reject(e) : resolve())),
      );
    this.browser?.stop();
    this.browser = null;
    await this.beacon?.stop();
    this.beacon = null;
    if (this.bonjour) {
      // Await the callback: goodbye (TTL 0) must flush before destroy()
      // closes the socket, or peers never see our `down`.
      const bj = this.bonjour;
      await new Promise<void>((resolve) => bj.unpublishAll(() => resolve()));
      bj.destroy();
      this.bonjour = null;
    }
    this.advertisedName = "";
    this.registry.clear();
  }

  inbox(): Array<Envelope | Notice> {
    this.sweepExpired();
    return [...this.received];
  }

  peers(): Peer[] {
    return this.registry.list().map((p) => ({ ...p, paired: this.paired.has(p.id) }));
  }

  isPaired(peerId: string): boolean {
    return peerId === this.id || this.paired.has(peerId);
  }

  // Manual presence entry: direct upsert for already-known identity.
  addPeer(a: PeerAnnouncement): void {
    this.learn(a);
  }

  // Last-resort manual entry (`hub add <ip:port>`): probe the address for
  // its identity first, so pairing (keyed on peer id) still works.
  // Warns apply at the tool layer: client-isolating APs may filter even
  // direct IP, so this can fail on dead-end networks.
  async addPeerFromAddress(host: string, port: number): Promise<Peer> {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`hub: bad port "${port}" — use ip:port`);
    const clean = host.replace(/^\[(.*)\]$/, "$1");
    const dst = clean.includes(":") ? `[${clean}]` : clean;
    let info: unknown;
    try {
      const res = await fetch(`http://${dst}:${port}/v1/info`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      info = await res.json();
    } catch (e) {
      throw new Error(
        `hub: cannot reach ${host}:${port} — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const rec = info as Record<string, unknown>;
    if (
      typeof rec?.id !== "string" ||
      typeof rec?.name !== "string" ||
      rec?.v !== PROTO_VERSION
    )
      throw new Error(`hub: ${host}:${port} is not a hub (bad /v1/info)`);
    this.learn({ id: rec.id, name: rec.name, port, addresses: [clean] });
    const found = this.peers().find((p) => p.id === rec.id);
    if (!found) throw new Error("hub: manual entry vanished");
    return found;
  }

  // Presence is live-only, so a paired peer's address is kept in the TOFU
  // record too: that is what reconnect() re-probes after a restart.
  // Auto-trust on discovery (same-LAN trust): any discovered peer is paired
  // without a code. hub_unpair remains as a manual block override.
  private learn(a: PeerAnnouncement): void {
    if (a.id === this.id) return;
    this.registry.upsert(a);
    const rec = this.paired.get(a.id);
    const addresses = a.addresses ?? [];
    if (!rec) {
      this.paired.set(a.id, {
        id: a.id,
        name: a.name,
        pairedAt: new Date(this.now()).toISOString(),
        port: a.port,
        addresses,
      });
      this.savePeers();
      return;
    }
    const key = (list?: string[]) => [...(list ?? [])].sort().join(",");
    const same = rec.port === a.port && key(rec.addresses) === key(addresses);
    if (same) return; // heartbeats every few seconds must not rewrite the file
    this.paired.set(a.id, { ...rec, port: a.port, addresses });
    this.savePeers();
  }

  // Restart path: paired peers are re-probed at their last known address, so
  // presence comes back on networks where mDNS and beacons are both filtered.
  // Best-effort — an unreachable peer simply stays absent.
  async reconnect(): Promise<void> {
    const targets = [...this.paired.values()].filter(
      (p) => p.port !== undefined && (p.addresses?.length ?? 0) > 0,
    );
    await Promise.all(
      targets.map(async (p) => {
        const port = p.port as number;
        for (const host of p.addresses ?? []) {
          try {
            await this.addPeerFromAddress(host, port);
            return;
          } catch {
            // next remembered address, or wait for discovery
          }
        }
      }),
    );
  }

  // Number (1-based into peers()), exact display name, or instance id.
  // Ambiguous names throw — never guessed (spec section 5).
  resolvePeer(ref: string): Peer {
    const list = this.peers();
    const byId = list.find((p) => p.id === ref);
    if (byId) return byId;
    if (/^\d+$/.test(ref)) {
      const peer = list[Number(ref) - 1];
      if (!peer) throw new Error(`hub: no peer #${ref}`);
      return peer;
    }
    const hits = list.filter((p) => p.name === ref);
    if (hits.length > 1)
      throw new Error(`hub: ambiguous peer name "${ref}" — use its number`);
    if (hits.length === 0) throw new Error(`hub: unknown peer "${ref}"`);
    return hits[0];
  }

  async sendToPeer(
    ref: string,
    text: string,
    type: "request" | "response" | "error" = "request",
    inReplyTo?: string,
  ): Promise<{ status: string }> {
    const peer = this.resolvePeer(ref);
    if (!this.isPaired(peer.id))
      throw new Error(`hub: ${peer.name} is not paired — pair first`);
    const env: Envelope = {
      id: createId(),
      from: this.id,
      to: peer.id,
      type,
      ...(inReplyTo !== undefined ? { inReplyTo } : {}),
      text,
      ts: new Date(this.now()).toISOString(),
    };
    const result = await this.send(peerUrl(peer), env);
    if (type === "request")
      this.pending.set(env.id, { to: peer.id, name: peer.name, sentAt: this.now() });
    return result;
  }

  // Answer inbox item n (1-based, same numbering hub_inbox shows).
  // The reply fills inReplyTo invisibly; uuids stay out of the UX.
  async reply(n: number, text: string): Promise<{ status: string }> {
    const item = this.inbox()[n - 1];
    if (!item) throw new Error(`hub: no inbox item #${n}`);
    if (isNotice(item)) throw new Error("hub: cannot reply to a system notice");
    const target =
      item.from === this.id
        ? {
            id: this.id,
            name: this.name,
            port: this.port,
            addresses: ["127.0.0.1"],
          }
        : this.peers().find((p) => p.id === item.from);
    if (!target) throw new Error("hub: sender left or is unknown — cannot reply");
    if (!this.isPaired(target.id))
      throw new Error("hub: sender is not paired — pair first");
    if (target.port === 0) throw new Error("hub: not started");
    return this.send(peerUrl(target), {
      id: createId(),
      from: this.id,
      to: target.id,
      type: "response",
      inReplyTo: item.id,
      text,
      ts: new Date(this.now()).toISOString(),
    });
  }

  // Unanswered requests expire locally into a notice. No retry, no second
  // notice (spec section 3). Lazy: runs on inbox()/reply().
  private sweepExpired(): void {
    const now = this.now();
    for (const [id, p] of this.pending) {
      if (now - p.sentAt > this.requestTimeoutMs) {
        this.pending.delete(id);
        this.received.push({
          kind: "notice",
          text: `request to ${p.name} timed out after ${Math.round(this.requestTimeoutMs / 1000)}s — no reply, not retried`,
          ts: new Date(now).toISOString(),
        });
      }
    }
  }

  issuePairingCode(): string {
    let code: string;
    do {
      code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    } while (this.pendingCodes.has(code));
    this.pendingCodes.set(code, this.now());
    return code;
  }

  redeemPairingCode(code: string, peerId: string, peerName: string): PairedPeer {
    const issuedAt = this.pendingCodes.get(code);
    this.pendingCodes.delete(code); // single-use: consumed whether valid or not
    if (issuedAt === undefined) throw new Error("hub: unknown pairing code");
    if (this.now() - issuedAt > PAIRING_CODE_TTL_MS)
      throw new Error("hub: pairing code expired");
    const seen = this.registry.list().find((p) => p.id === peerId);
    const peer: PairedPeer = {
      id: peerId,
      name: peerName,
      pairedAt: new Date(this.now()).toISOString(),
      ...(seen ? { port: seen.port, addresses: seen.addresses } : {}),
    };
    this.paired.set(peerId, peer);
    this.savePeers();
    return peer;
  }

  unpair(peerId: string): boolean {
    const removed = this.paired.delete(peerId);
    if (removed) this.savePeers();
    return removed;
  }

  private loadPeers(): void {
    let raw: string;
    try {
      raw = readFileSync(this.peersPath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const p of parsed) {
        if (
          typeof p === "object" &&
          p !== null &&
          typeof (p as Record<string, unknown>).id === "string" &&
          typeof (p as Record<string, unknown>).name === "string"
        ) {
          const rec = p as Record<string, unknown>;
          this.paired.set(rec.id as string, {
            id: rec.id as string,
            name: rec.name as string,
            pairedAt:
              typeof rec.pairedAt === "string"
                ? rec.pairedAt
                : new Date(0).toISOString(),
            ...(typeof rec.port === "number" ? { port: rec.port } : {}),
            ...(Array.isArray(rec.addresses)
              ? {
                  addresses: (rec.addresses as unknown[]).filter(
                    (a): a is string => typeof a === "string",
                  ),
                }
              : {}),
          });
        }
      }
    } catch {
      // Corrupt store reads as empty; next pair overwrites it.
    }
  }

  private savePeers(): void {
    mkdirSync(dirname(this.peersPath), { recursive: true });
    writeFileSync(
      this.peersPath,
      JSON.stringify([...this.paired.values()], null, 2),
    );
  }

  async send(
    url: string,
    env: Envelope,
  ): Promise<{ status: string }> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
      signal: AbortSignal.timeout(10_000),
    });
    return (await res.json()) as { status: string };
  }

  private async startDiscovery(): Promise<void> {
    this.bonjour = new Bonjour();
    await this.publish();
    this.browse();
    // UDP fallback runs alongside mDNS: same registry keyed on id, so a
    // peer seen both ways holds one entry. Where mDNS is filtered, beacons
    // are the only source; where it works, they are harmless duplicates.
    const beacon = new Beacon(
      () => ({ v: PROTO_VERSION, id: this.id, name: this.name, port: this.port }),
      (p) => {
        if (p.v !== PROTO_VERSION || p.id === this.id) return;
        this.learn({
          id: p.id,
          name: p.name,
          port: p.port,
          addresses: p.addresses,
          ttlMs: beacon.ttlMs,
        });
      },
      { intervalMs: this.beaconIntervalMs, target: this.beaconTarget, port: this.beaconPort,
        // Remembered paired addresses get every heartbeat by unicast too:
        // that is what the other side hears on networks where mDNS and
        // broadcast never arrive. Re-read per beat so it tracks pairing.
        unicastTargets: () =>
          [...this.paired.values()].flatMap((p) =>
            (p.addresses ?? []).map((host) => ({ host, port: BEACON_PORT })),
          ),
      },
    );
    this.beacon = beacon;
    await beacon.start();
  }

  // The lib refuses conflicting names instead of renaming (RFC 6762 §9),
  // so retry with a suffix until our probe finds the name free.
  private async publish(): Promise<void> {
    const bj = this.bonjour;
    if (!bj) return;
    for (let n = 1; n <= MAX_NAME_TRIES; n++) {
      const attempt = n === 1 ? this.name : `${this.name} (${n})`;
      const svc = bj.publish({
        name: attempt,
        type: SERVICE_TYPE,
        port: this.port,
        txt: { id: this.id, name: this.name, v: PROTO_VERSION },
      });
      const up = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), PUBLISH_WAIT_MS);
        timer.unref?.();
        svc.once("up", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (up) {
        this.advertisedName = attempt;
        return;
      }
      svc.stop();
    }
    throw new Error("hub: mDNS name conflict would not resolve");
  }

  private browse(): void {
    if (!this.bonjour) return;
    const browser = this.bonjour.find({ type: SERVICE_TYPE });
    this.browser = browser;
    browser.on("up", (svc) => {
      const id = svc.txt?.id;
      if (typeof id !== "string" || id === this.id) return;
      const name = typeof svc.txt?.name === "string" ? svc.txt.name : svc.name;
      this.learn({
        id,
        name,
        port: svc.port,
        addresses: svc.addresses ?? [],
      });
    });
    browser.on("down", (svc) => {
      const id = svc.txt?.id;
      if (typeof id === "string" && id !== this.id) this.registry.remove(id);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    // Identity probe for manual entry (`hub add`). Public by design:
    // pairing gates messages, not identity.
    if (req.method === "GET" && req.url === "/v1/info") {
      json(res, 200, { v: PROTO_VERSION, id: this.id, name: this.name });
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/messages") {
      res.writeHead(404).end();
      return;
    }
    let v: unknown;
    try {
      v = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!isEnvelope(v)) {
      res.writeHead(400).end();
      return;
    }
    if (v.to !== this.id) {
      json(res, 200, { status: "dropped" });
      return;
    }
    // Trust before content (spec section 4; v1 is plaintext-on-LAN gated by
    // pairing only). Loopback from self needs no pairing.
    if (!this.isPaired(v.from)) {
      json(res, 403, { status: "forbidden" });
      return;
    }
    this.received.push(v);
    if (v.type !== "request" && v.inReplyTo) this.pending.delete(v.inReplyTo);
    try {
      this.onMessage?.(v);
    } catch {
      // Arrival notification must never break receipt.
    }
    json(res, 200, { status: "queued" });
  }
}

// Prefer a LAN-reachable IPv4; loopback last, IPv6 bracketed.
export function peerUrl(peer: { port: number; addresses: string[] }): string {
  const v4 = peer.addresses.filter(
    (a) => a.includes(".") && !a.startsWith("127.") && !a.startsWith("169.254."),
  );
  const addr =
    v4[0] ?? peer.addresses.find((a) => a !== "::1") ??
    peer.addresses[0] ?? "127.0.0.1";
  const host = addr.includes(":") && !addr.startsWith("[") ? `[${addr}]` : addr;
  return `http://${host}:${peer.port}/v1/messages`;
}

const defaultPeersPath = () =>
  join(homedir(), ".config", "opencode", "hub-peers.json");
