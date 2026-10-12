import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HubCore,
  peerUrl,
  isNotice,
  type Envelope,
} from "./hub";

const hubs: HubCore[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
});

const tmpPeers = () => join(mkdtempSync(join(tmpdir(), "hub-")), "peers.json");
const track = (h: HubCore) => (hubs.push(h), h);
const mk = (id: string, name: string, opts: Record<string, unknown> = {}) =>
  track(new HubCore(id, name, { peersPath: tmpPeers(), ...opts }));

describe("peer addressing", () => {
  test("number resolves 1-based into the peers list", () => {
    const hub = mk("a", "A");
    hub.addPeer({ id: "b", name: "B", port: 1, addresses: [] });
    expect(hub.resolvePeer("1").id).toBe("b");
  });

  test("name resolves; unknown name and out-of-range number throw", () => {
    const hub = mk("a", "A");
    hub.addPeer({ id: "b", name: "B", port: 1, addresses: [] });
    expect(hub.resolvePeer("B").id).toBe("b");
    expect(() => hub.resolvePeer("Z")).toThrow(/unknown peer/);
    expect(() => hub.resolvePeer("2")).toThrow(/no peer #2/);
  });

  test("ambiguous name is refused, never guessed", () => {
    const hub = mk("a", "A");
    hub.addPeer({ id: "b1", name: "B", port: 1, addresses: [] });
    hub.addPeer({ id: "b2", name: "B", port: 2, addresses: [] });
    expect(() => hub.resolvePeer("B")).toThrow(/ambiguous/);
  });

  test("peerUrl prefers non-loopback IPv4 and brackets IPv6", () => {
    expect(
      peerUrl({ port: 41737, addresses: ["169.254.1.2", "192.168.1.5"] }),
    ).toBe("http://192.168.1.5:41737/v1/messages");
    expect(peerUrl({ port: 1, addresses: ["::1", "fe80::1"] })).toBe(
      "http://[fe80::1]:1/v1/messages",
    );
    expect(peerUrl({ port: 1, addresses: [] })).toBe(
      "http://127.0.0.1:1/v1/messages",
    );
  });
});

describe("send by number-or-name (two hubs over loopback)", () => {
  test("sendToPeer delivers a request; reply round-trips with inReplyTo", async () => {
    const a = mk("a", "A");
    const b = mk("b", "B");
    const portA = await a.start(41771);
    const portB = await b.start(41772);
    a.addPeer({ id: "b", name: "B", port: portB, addresses: ["127.0.0.1"] });
    b.addPeer({ id: "a", name: "A", port: portA, addresses: ["127.0.0.1"] });
    // Pair both ways (inbox gate is receiver-side).
    b.redeemPairingCode(b.issuePairingCode(), "a", "A");
    a.redeemPairingCode(a.issuePairingCode(), "b", "B");

    expect(await a.sendToPeer("B", "hello b")).toEqual({ status: "queued" });
    expect(await a.sendToPeer("1", "again")).toEqual({ status: "queued" });
    expect(b.inbox()).toHaveLength(2);

    expect(await b.reply(1, "hi a")).toEqual({ status: "queued" });
    const answers = a.inbox().filter((m) => !isNotice(m));
    expect(answers).toHaveLength(1);
    const ans = answers[0] as Envelope;
    expect(ans.type).toBe("response");
    expect(ans.inReplyTo).toBe((b.inbox()[0] as Envelope).id);
  });

  test("sendToPeer refuses unpaired peers; reply to missing item throws", async () => {
    const a = mk("a", "A");
    await a.start(41773);
    a.addPeer({ id: "b", name: "B", port: 41779, addresses: ["127.0.0.1"] });
    await expect(a.sendToPeer("B", "hi")).rejects.toThrow(/not paired/);
    expect(() => a.reply(1, "hi")).toThrow(/no inbox item #1/);
  });
});

describe("request timeouts become local notices", () => {
  test("unanswered request expires into a notice; answered one does not", async () => {
    let now = 1_000_000;
    const a = mk("a", "A", { now: () => now, requestTimeoutMs: 1_000 });
    const b = mk("b", "B", { now: () => now });
    const portB = await b.start(41774);
    const portA = await a.start(41775);
    a.addPeer({ id: "b", name: "B", port: portB, addresses: ["127.0.0.1"] });
    b.addPeer({ id: "a", name: "A", port: portA, addresses: ["127.0.0.1"] });
    b.redeemPairingCode(b.issuePairingCode(), "a", "A");
    a.redeemPairingCode(a.issuePairingCode(), "b", "B");

    await a.sendToPeer("B", "are you there?");
    now += 1_001;
    const items = a.inbox();
    expect(items).toHaveLength(1);
    expect(isNotice(items[0])).toBe(true);
    expect((items[0] as { text: string }).text).toMatch(/timed out/);
    // No retry, no second notice on next poll.
    expect(a.inbox()).toHaveLength(1);

    // Answered before expiry leaves no notice.
    await a.sendToPeer("B", "second try");
    await b.reply(2, "yes");
    now += 1_001;
    expect(a.inbox().filter(isNotice)).toHaveLength(1); // only the old one
  });
});

describe("arrival callback (toast seam)", () => {
  test("onMessage fires for each queued message", async () => {
    const seen: Envelope[] = [];
    const hub = mk("a", "A", { onMessage: (m: Envelope) => seen.push(m) });
    const port = await hub.start(41776);
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "m1",
        from: "a",
        to: "a",
        type: "request",
        text: "loop",
        ts: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe("loop");
  });
});
