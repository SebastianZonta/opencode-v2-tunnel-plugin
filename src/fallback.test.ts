import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HubCore } from "./hub";
import { PeerRegistry } from "./peers";
import {
  Beacon,
  isBeaconPayload,
  type BeaconPayload,
} from "./beacon";

const tmpPeers = () => join(mkdtempSync(join(tmpdir(), "hub-")), "peers.json");

const hubs: HubCore[] = [];
const beacons: Beacon[] = [];
afterEach(async () => {
  await Promise.all(beacons.splice(0).map((b) => b.stop()));
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
});
const trackHub = (h: HubCore) => (hubs.push(h), h);
const trackBeacon = (b: Beacon) => (beacons.push(b), b);

const waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("beacon payload", () => {
  test("accepts a well-formed announcement", () => {
    expect(
      isBeaconPayload({ v: "1", id: "a", name: "A", port: 41737, addresses: [] }),
    ).toBe(true);
  });

  test("rejects malformed datagrams", () => {
    expect(isBeaconPayload("junk")).toBe(false);
    expect(isBeaconPayload({})).toBe(false);
    expect(
      isBeaconPayload({ v: "1", id: "a", name: "A", port: "41737" }),
    ).toBe(false);
    expect(
      isBeaconPayload({ v: "1", id: "a", name: "A", port: 41737, addresses: [1] }),
    ).toBe(false);
  });
});

describe("beacon transport (loopback)", () => {
  test("two beacons discover each other and ignore self", async () => {
    const seenA: BeaconPayload[] = [];
    const seenB: BeaconPayload[] = [];
    const a = trackBeacon(
      new Beacon(
        () => ({ v: "1", id: "a", name: "A", port: 1111 }),
        (p) => seenA.push(p),
        { port: 41951, target: "127.0.0.1", targetPort: 41952, intervalMs: 50 },
      ),
    );
    const b = trackBeacon(
      new Beacon(
        () => ({ v: "1", id: "b", name: "B", port: 2222 }),
        (p) => seenB.push(p),
        { port: 41952, target: "127.0.0.1", targetPort: 41951, intervalMs: 50 },
      ),
    );
    await a.start();
    await b.start();
    expect(a.isListening).toBe(true);
    expect(b.isListening).toBe(true);
    await waitFor(() => seenA.length > 0 && seenB.length > 0);
    expect(seenA.every((p) => p.id === "b" && p.port === 2222)).toBe(true);
    expect(seenB.every((p) => p.id === "a" && p.port === 1111)).toBe(true);
  });

  test("bind conflict degrades to send-only instead of throwing", async () => {
    const heard: BeaconPayload[] = [];
    const a = trackBeacon(
      new Beacon(
        () => ({ v: "1", id: "a", name: "A", port: 1111 }),
        (p) => heard.push(p),
        { port: 41953, target: "127.0.0.1", targetPort: 41953, intervalMs: 50 },
      ),
    );
    await a.start();
    // Same rendezvous port: no shared bind on this runtime, so send-only.
    const b = trackBeacon(
      new Beacon(
        () => ({ v: "1", id: "b", name: "B", port: 2222 }),
        () => {},
        { port: 41953, target: "127.0.0.1", targetPort: 41953, intervalMs: 50 },
      ),
    );
    await b.start();
    expect(b.isListening).toBe(false);
    await waitFor(() => heard.some((p) => p.id === "b"));
  });

  test("unicast targets reach a peer that broadcast never touches", async () => {
    const heard: BeaconPayload[] = [];
    // A's broadcast twin goes to itself only; B learns A solely through
    // the unicast target — the filtered-network path.
    const a = trackBeacon(
      new Beacon(
        () => ({ v: "1", id: "a", name: "A", port: 1111 }),
        () => {},
        {
          port: 41958,
          target: "127.0.0.1",
          targetPort: 41958,
          intervalMs: 50,
          unicastTargets: () => [{ host: "127.0.0.1", port: 41959 }],
        },
      ),
    );
    const b = trackBeacon(
      new Beacon(
        () => ({ v: "1", id: "b", name: "B", port: 2222 }),
        (p) => heard.push(p),
        { port: 41959, intervalMs: 50 },
      ),
    );
    await a.start();
    await b.start();
    await waitFor(() => heard.some((p) => p.id === "a" && p.port === 1111));
  });
});

describe("registry beacon expiry", () => {
  test("beacon entries expire at their own TTL, mDNS entries keep 30 s", () => {
    const r = new PeerRegistry(30_000);
    r.upsert({ id: "beacon-peer", name: "B", port: 1, lastSeen: 1000, ttlMs: 150 });
    r.upsert({ id: "mdns-peer", name: "M", port: 2, lastSeen: 1000 });
    expect(r.list(1000).map((p) => p.id).sort()).toEqual([
      "beacon-peer",
      "mdns-peer",
    ]);
    expect(r.list(1151).map((p) => p.id)).toEqual(["mdns-peer"]);
  });
});

describe("hub fallback (two hubs over loopback)", () => {
  test("hub hears UDP beacons with the sender's real id and port", async () => {
    const hub = trackHub(
      new HubCore("fa", "FA", { peersPath: tmpPeers(), beaconPort: 41954 }),
    );
    await hub.start(41781);
    const ext = trackBeacon(
      new Beacon(
        () => ({ v: "1", id: "ext", name: "EXT", port: 5555 }),
        () => {},
        { port: 41955, target: "127.0.0.1", targetPort: 41954, intervalMs: 50 },
      ),
    );
    await ext.start();
    await waitFor(() => hub.peers().some((p) => p.id === "ext"));
    expect(hub.peers().find((p) => p.id === "ext")?.port).toBe(5555);
  });

  test("GET /v1/info reports identity for manual entry", async () => {
    const a = trackHub(new HubCore("fa", "FA", { peersPath: tmpPeers() }));
    const portA = await a.start(41783);
    const res = await fetch(`http://127.0.0.1:${portA}/v1/info`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ v: "1", id: "fa", name: "FA" });
  });

  test("manual add, pair, and send by number", async () => {
    const a = trackHub(new HubCore("fa", "FA", { peersPath: tmpPeers() }));
    const b = trackHub(new HubCore("fb", "FB", { peersPath: tmpPeers() }));
    const portA = await a.start(41784);
    await b.start(41785);
    const peer = await b.addPeerFromAddress("127.0.0.1", portA);
    expect(peer.id).toBe("fa");
    b.redeemPairingCode(b.issuePairingCode(), "fa", "FA");
    a.redeemPairingCode(a.issuePairingCode(), "fb", "FB");
    expect((await b.sendToPeer("1", "via manual entry")).status).toBe("queued");
    expect(a.inbox().map((m) => m.text)).toEqual(["via manual entry"]);
  });

  test("manual add to a dead address throws", async () => {
    const b = trackHub(new HubCore("fb", "FB", { peersPath: tmpPeers() }));
    await b.start(41786);
    await expect(b.addPeerFromAddress("127.0.0.1", 41999)).rejects.toThrow(
      /cannot reach/,
    );
  });
});

// Restart reconnect: presence is live-only, so the address a paired peer was
// last seen at is stored with the pairing and re-probed on the next start.
describe("restart reconnect", () => {
  test("pairing remembers where the peer was seen", async () => {
    const path = tmpPeers();
    const b = trackHub(new HubCore("fb", "FB", { peersPath: tmpPeers() }));
    const portB = await b.start(41791);
    const a = trackHub(new HubCore("fa", "FA", { peersPath: path }));
    await a.start(41792);
    await a.addPeerFromAddress("127.0.0.1", portB);
    a.redeemPairingCode(a.issuePairingCode(), "fb", "FB");

    const store = JSON.parse(readFileSync(path, "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(store).toContainEqual(
      expect.objectContaining({
        id: "fb",
        port: portB,
        addresses: ["127.0.0.1"],
      }),
    );
  });

  test("a restarted hub re-probes the remembered address (no discovery)", async () => {
    const path = tmpPeers();
    const b = trackHub(new HubCore("fb", "FB", { peersPath: tmpPeers() }));
    const portB = await b.start(41793);
    const a1 = new HubCore("fa", "FA", { peersPath: path });
    await a1.start(41794);
    await a1.addPeerFromAddress("127.0.0.1", portB);
    a1.redeemPairingCode(a1.issuePairingCode(), "fb", "FB");
    await a1.stop();

    // Never started: no mDNS, no beacons — only the remembered address.
    const a2 = trackHub(new HubCore("fa", "FA", { peersPath: path }));
    await a2.reconnect();
    const peer = a2.peers().find((p) => p.id === "fb");
    expect(peer?.paired).toBe(true);
    expect(peer?.addresses).toEqual(["127.0.0.1"]);
    expect(peer?.port).toBe(portB);
  });
});

// Filtered network: mDNS and beacons both gone. reconnect() runs once at
// start, so without a background refresh the paired peer expires out of
// presence (~TTL) and never comes back.
describe("filtered-network refresh", () => {
  test("paired peer stays present with no discovery traffic", async () => {
    const b = trackHub(new HubCore("fb", "FB", { peersPath: tmpPeers() }));
    const portB = await b.start(41795);
    // Custom beacon port: hears nothing. The one-shot mDNS entry expires
    // with the 300 ms registry timeout; only the refresh keeps it alive.
    const a = trackHub(
      new HubCore("fa", "FA", {
        peersPath: tmpPeers(),
        peerTimeoutMs: 300,
        reconnectIntervalMs: 100,
        beaconPort: 41957,
      }),
    );
    await a.start(41796);
    await a.addPeerFromAddress("127.0.0.1", portB);
    a.redeemPairingCode(a.issuePairingCode(), "fb", "FB");
    await new Promise((r) => setTimeout(r, 900));
    const peer = a.peers().find((p) => p.id === "fb");
    expect(peer?.paired).toBe(true);
    expect(Date.now() - (peer?.lastSeen ?? 0)).toBeLessThan(300);
  });

  test("without refresh the entry expires (never-started control)", async () => {
    const b = trackHub(new HubCore("fb", "FB", { peersPath: tmpPeers() }));
    const portB = await b.start(41797);
    // Never started: no timer armed, no discovery at all.
    const a = trackHub(
      new HubCore("fa", "FA", { peersPath: tmpPeers(), peerTimeoutMs: 300 }),
    );
    await a.addPeerFromAddress("127.0.0.1", portB);
    a.redeemPairingCode(a.issuePairingCode(), "fb", "FB");
    await new Promise((r) => setTimeout(r, 700));
    expect(a.peers().find((p) => p.id === "fb")).toBeUndefined();
  });
});
