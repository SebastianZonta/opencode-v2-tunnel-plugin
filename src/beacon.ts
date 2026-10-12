import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";

export const BEACON_PORT = 41837;
export const BEACON_INTERVAL_MS = 3_000;
// Dead beacons linger ~3 heartbeats (ticket 05); mDNS entries keep the
// registry default (30 s) via a null per-entry TTL.
export const BEACON_TTL_FACTOR = 3;

export interface BeaconPayload {
  v: string;
  id: string;
  name: string;
  port: number;
  addresses: string[];
}

export function isBeaconPayload(v: unknown): v is BeaconPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.v === "string" &&
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.port === "number" &&
    (p.addresses === undefined ||
      (Array.isArray(p.addresses) &&
        p.addresses.every((a) => typeof a === "string")))
  );
}

// Non-internal IPv4s for peers to reach us on. Empty on weird nets;
// peerUrl() then falls back to loopback.
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifs of Object.values(networkInterfaces())) {
    for (const ni of ifs ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

export interface BeaconSelf {
  v: string;
  id: string;
  name: string;
  port: number;
}

export class Beacon {
  private sock: Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // False when another local hub holds the rendezvous port (Bun's dgram
  // has no shared bind): we still announce, we just can't listen.
  private listening = false;

  constructor(
    private self: () => BeaconSelf,
    private onPeer: (p: BeaconPayload) => void,
    private opts: {
      port?: number;
      target?: string;
      targetPort?: number;
      intervalMs?: number;
    } = {},
  ) {}

  private get listenPort(): number {
    return this.opts.port ?? BEACON_PORT;
  }

  private get sendPort(): number {
    return this.opts.targetPort ?? this.listenPort;
  }

  get ttlMs(): number {
    return (this.opts.intervalMs ?? BEACON_INTERVAL_MS) * BEACON_TTL_FACTOR;
  }

  /** False when the rendezvous port was taken: send-only mode. */
  get isListening(): boolean {
    return this.listening;
  }

  async start(): Promise<void> {
    if (this.sock) return;
    const sock = createSocket("udp4");
    this.sock = sock;
    sock.on("message", (msg) => this.handle(msg));
    // Beacons are best-effort fallback: a bind failure (port held by
    // another local hub, filtered net) degrades to send-only and must
    // never break the hub.
    await new Promise<void>((resolve) => {
      const bindErr = () => resolve();
      sock.once("error", bindErr);
      sock.bind({ port: this.listenPort, exclusive: false }, () => {
        sock.off("error", bindErr);
        this.listening = true;
        // Runtime send failures are routine on filtered nets; ignore.
        sock.on("error", () => {});
        sock.setBroadcast(true);
        resolve();
      });
    });
    this.beat();
    this.timer = setInterval(() => this.beat(), this.opts.intervalMs ?? BEACON_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const sock = this.sock;
    this.sock = null;
    if (sock) await new Promise<void>((resolve) => sock.close(() => resolve()));
  }

  private beat(): void {
    const sock = this.sock;
    if (!sock) return;
    const s = this.self();
    const payload: BeaconPayload = {
      v: s.v,
      id: s.id,
      name: s.name,
      port: s.port,
      addresses: lanAddresses(),
    };
    sock.send(
      Buffer.from(JSON.stringify(payload)),
      this.sendPort,
      this.opts.target ?? "255.255.255.255",
      () => {},
    );
  }

  private handle(msg: Buffer): void {
    let v: unknown;
    try {
      v = JSON.parse(msg.toString("utf8"));
    } catch {
      return;
    }
    if (!isBeaconPayload(v) || v.id === this.self().id) return;
    this.onPeer(v);
  }
}
