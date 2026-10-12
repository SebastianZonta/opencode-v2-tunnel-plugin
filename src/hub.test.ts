import { describe, test, expect, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";
import { HubCore, MAX_TEXT_BYTES, type Envelope } from "./hub";

const hubs: HubCore[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
});

const envelope = (over: Record<string, unknown> = {}): Envelope =>
  ({
    id: "m1",
    from: "peer-a",
    to: "peer-a",
    type: "request",
    text: "hello lan",
    ts: new Date("2026-10-12T00:00:00.000Z").toISOString(),
    ...over,
  }) as Envelope;

const post = (port: number, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("HubCore start/stop", () => {
  test("binds the requested port and releases it on stop", async () => {
    const hub = new HubCore("peer-a", "A");
    hubs.push(hub);
    const port = await hub.start(41737);
    expect(port).toBeGreaterThanOrEqual(41737);
    await hub.stop();
    // Port is free again: a second hub can take it.
    const hub2 = new HubCore("peer-a", "A");
    hubs.push(hub2);
    expect(await hub2.start(port)).toBe(port);
  });

  test("increments the port when the requested one is taken", async () => {
    const squatter: Server = createServer((_, res) => res.end());
    await new Promise<void>((r) => squatter.listen(41739, "127.0.0.1", r));
    try {
      const hub = new HubCore("peer-a", "A");
      hubs.push(hub);
      expect(await hub.start(41739)).toBe(41740);
    } finally {
      squatter.close();
    }
  });
});

describe("POST /v1/messages", () => {
  test("valid envelope is queued and visible in the inbox", async () => {
    const hub = new HubCore("peer-a", "A");
    hubs.push(hub);
    const port = await hub.start(41741);
    const res = await post(port, envelope());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "queued" });
    expect(hub.inbox()).toHaveLength(1);
    expect(hub.inbox()[0].text).toBe("hello lan");
  });

  test("envelope for another recipient is dropped, not queued", async () => {
    const hub = new HubCore("peer-a", "A");
    hubs.push(hub);
    const port = await hub.start(41742);
    const res = await post(port, envelope({ to: "someone-else" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "dropped" });
    expect(hub.inbox()).toHaveLength(0);
  });

  test("malformed envelopes are rejected with 400", async () => {
    const hub = new HubCore("peer-a", "A");
    hubs.push(hub);
    const port = await hub.start(41743);
    const bad = [
      { nope: true },
      envelope({ text: undefined }),
      envelope({ type: "shout" }),
      envelope({ text: "x".repeat(MAX_TEXT_BYTES + 1) }),
      envelope({ ts: 123 }),
      envelope({ type: "response" }),
    ];
    for (const body of bad) {
      const res = await post(port, body);
      expect(res.status).toBe(400);
    }
    expect(hub.inbox()).toHaveLength(0);
  });

  test("response with inReplyTo is queued", async () => {
    const hub = new HubCore("peer-a", "A");
    hubs.push(hub);
    const port = await hub.start(41745);
    const res = await post(
      port,
      envelope({ id: "m2", type: "response", inReplyTo: "m1" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "queued" });
    expect(hub.inbox()).toHaveLength(1);
    expect(hub.inbox()[0].inReplyTo).toBe("m1");
  });
});

describe("send loopback", () => {
  test("send to self lands in the inbox", async () => {
    const hub = new HubCore("peer-a", "A");
    hubs.push(hub);
    const port = await hub.start(41744);
    const result = await hub.send(
      `http://127.0.0.1:${port}/v1/messages`,
      envelope(),
    );
    expect(result).toEqual({ status: "queued" });
    expect(hub.inbox()).toHaveLength(1);
  });
});
