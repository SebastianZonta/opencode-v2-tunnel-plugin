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
import { PeerRegistry, type PeerInfo } from "./peers";

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
}

export interface HubOptions {
  peerTimeoutMs?: number;
  // TOFU store location; defaults to ~/.config/opencode/hub-peers.json.
  // Tests pass a temp file.
  peersPath?: string;
  now?: () => number;
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
  private received: Envelope[] = [];
  private bonjour: Bonjour | null = null;
  private browser: Bonjour.Browser | null = null;
  private registry: PeerRegistry;
  private paired = new Map<string, PairedPeer>();
  private pendingCodes = new Map<string, number>(); // code -> issuedAt ms
  private readonly peersPath: string;
  private readonly now: () => number;
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
        return p;
      }
    }
    throw new Error("hub: no free port");
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.port = 0;
    if (s)
      await new Promise<void>((resolve, reject) =>
        s.close((e) => (e ? reject(e) : resolve())),
      );
    this.browser?.stop();
    this.browser = null;
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

  inbox(): Envelope[] {
    return [...this.received];
  }

  peers(): Peer[] {
    return this.registry.list().map((p) => ({ ...p, paired: this.paired.has(p.id) }));
  }

  isPaired(peerId: string): boolean {
    return peerId === this.id || this.paired.has(peerId);
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
    const peer: PairedPeer = {
      id: peerId,
      name: peerName,
      pairedAt: new Date(this.now()).toISOString(),
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
      this.registry.upsert({
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
    json(res, 200, { status: "queued" });
  }
}

const defaultPeersPath = () =>
  join(homedir(), ".config", "opencode", "hub-peers.json");
