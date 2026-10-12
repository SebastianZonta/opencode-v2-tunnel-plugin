import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HubCore, type Envelope } from "./hub";

const hubs: HubCore[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
});

const tmpPeers = () => join(mkdtempSync(join(tmpdir(), "hub-")), "peers.json");
const track = (h: HubCore) => (hubs.push(h), h);

const envelope = (over: Record<string, unknown> = {}): Envelope =>
  ({
    id: "m1",
    from: "sender",
    to: "receiver",
    type: "request",
    text: "hello",
    ts: new Date("2026-10-12T00:00:00.000Z").toISOString(),
    ...over,
  }) as Envelope;

describe("pairing codes", () => {
  test("issued code is 6 digits", () => {
    const hub = track(new HubCore("a", "A", { peersPath: tmpPeers() }));
    expect(hub.issuePairingCode()).toMatch(/^\d{6}$/);
  });

  test("redeem is single-use: second redeem of the same code fails", () => {
    const hub = track(new HubCore("a", "A", { peersPath: tmpPeers() }));
    const code = hub.issuePairingCode();
    hub.redeemPairingCode(code, "peer-b", "B");
    expect(() => hub.redeemPairingCode(code, "peer-b", "B")).toThrow();
  });

  test("redeem after 5-minute expiry fails", () => {
    let now = 1_000_000;
    const hub = track(
      new HubCore("a", "A", { peersPath: tmpPeers(), now: () => now }),
    );
    const code = hub.issuePairingCode();
    now += 5 * 60 * 1000 + 1;
    expect(() => hub.redeemPairingCode(code, "peer-b", "B")).toThrow();
  });

  test("redeem of an unknown code fails", () => {
    const hub = track(new HubCore("a", "A", { peersPath: tmpPeers() }));
    expect(() => hub.redeemPairingCode("000000", "peer-b", "B")).toThrow();
  });
});

describe("gated inbox (two hubs over loopback)", () => {
  test("unpaired sender gets 403 and nothing is queued", async () => {
    const receiver = track(
      new HubCore("receiver", "R", { peersPath: tmpPeers() }),
    );
    track(new HubCore("sender", "S", { peersPath: tmpPeers() }));
    const port = await receiver.start(41761);
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope()),
    });
    expect(res.status).toBe(403);
    expect(receiver.inbox()).toHaveLength(0);
  });

  test("paired sender gets 200 and the message is queued", async () => {
    const receiver = track(
      new HubCore("receiver", "R", { peersPath: tmpPeers() }),
    );
    track(new HubCore("sender", "S", { peersPath: tmpPeers() }));
    const port = await receiver.start(41762);
    receiver.redeemPairingCode(
      receiver.issuePairingCode(),
      "sender",
      "S",
    );
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope()),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "queued" });
    expect(receiver.inbox()).toHaveLength(1);
  });
});

describe("TOFU persistence", () => {
  test("known id skips re-pairing across restarts; unpair forgets", () => {
    const path = tmpPeers();
    const h1 = track(new HubCore("a", "A", { peersPath: path }));
    h1.redeemPairingCode(h1.issuePairingCode(), "peer-b", "B");
    expect(h1.isPaired("peer-b")).toBe(true);

    const h2 = track(new HubCore("a", "A", { peersPath: path }));
    expect(h2.isPaired("peer-b")).toBe(true);
    // peers() is LAN presence, not the TOFU store: nobody discovered here.
    expect(h2.peers()).toEqual([]);

    h2.unpair("peer-b");
    expect(h2.isPaired("peer-b")).toBe(false);
    const h3 = track(new HubCore("a", "A", { peersPath: path }));
    expect(h3.isPaired("peer-b")).toBe(false);
  });
});
