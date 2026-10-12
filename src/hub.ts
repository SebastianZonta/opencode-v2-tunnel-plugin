import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";

export const MAX_TEXT_BYTES = 64 * 1024;
export const BASE_PORT = 41737;

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

export class HubCore {
  private server: Server | null = null;
  private received: Envelope[] = [];
  port = 0;

  constructor(
    readonly id: string,
    readonly name: string,
  ) {}

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
  }

  inbox(): Envelope[] {
    return [...this.received];
  }

  peers(): Array<{ id: string; name: string }> {
    return [];
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
    this.received.push(v);
    json(res, 200, { status: "queued" });
  }
}
