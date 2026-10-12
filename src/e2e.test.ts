import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HubCore, isNotice, type Envelope } from "./hub";
import HubPlugin from "../.opencode/plugins/hub/index";

// The adapter's hub uses the real TOFU path (no injection seam, by design:
// ticket 03 dropped the env fallback as unspecced). Tests that drive it
// snapshot the real file and restore it, so runs leave no trace.
const REAL_PEERS = join(
  process.env.HOME ?? tmpdir(),
  ".config",
  "opencode",
  "hub-peers.json",
);
const snapshotRealPeers = (): string | null => {
  try {
    return readFileSync(REAL_PEERS, "utf8");
  } catch {
    return null;
  }
};
const restoreRealPeers = (snap: string | null) => {
  try {
    if (snap === null) unlinkSync(REAL_PEERS);
    else writeFileSync(REAL_PEERS, snap);
  } catch {
    /* best-effort */
  }
};

// Ticket 06: the prototype transcript
// (.scratch/lan-hub/prototype/session-transcript.md) run for real —
// two instances on one machine, every step logged pass/fail.
const tmpPeers = () => join(mkdtempSync(join(tmpdir(), "hub-")), "peers.json");

const hubs: HubCore[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
});
const track = (h: HubCore) => (hubs.push(h), h);

const waitFor = async (
  cond: () => boolean,
  what: string,
  ms = 20_000,
): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`e2e timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const step = (n: string) => console.log(`[e2e] PASS ${n}`);

describe("e2e: transcript loop, two instances one machine", () => {
  test("start, clash, discover, pair, send/reply, 403, timeout, unpair/stop", async () => {
    const pathA = tmpPeers();
    const pathB = tmpPeers();
    const a = track(
      new HubCore("e2e-a", "e2e-alba", {
        peersPath: pathA,
        requestTimeoutMs: 800,
      }),
    );
    const b = track(
      new HubCore("e2e-b", "e2e-bruno", {
        peersPath: pathB,
        requestTimeoutMs: 800,
      }),
    );

    // Transcript §A/B: A binds :41790, B asks for the same port (its own
    // other instance?) and gets the incremented one.
    const portA = await a.start(41790);
    expect(portA).toBe(41790);
    step("A listening");
    const portB = await b.start(41790);
    expect(portB).toBe(41791);
    step("B port clash increments");

    // Transcript §peers: mutual discovery over real mDNS, port from SRV.
    await waitFor(
      () =>
        a.peers().some((p) => p.id === "e2e-b" && p.port === portB) &&
        b.peers().some((p) => p.id === "e2e-a" && p.port === portA),
      "mutual discovery",
    );
    step("mutual discovery with SRV ports");

    // Transcript §pair: the code is conveyed out-of-band; each side issues
    // its own code and redeems it with the other's id (receiver-side gate:
    // each side pairs the other).
    const codeB = b.issuePairingCode();
    expect(codeB).toMatch(/^\d{6}$/);
    b.redeemPairingCode(codeB, "e2e-a", "e2e-alba");
    expect(() => b.redeemPairingCode(codeB, "e2e-a", "e2e-alba")).toThrow(); // single-use
    a.redeemPairingCode(a.issuePairingCode(), "e2e-b", "e2e-bruno");
    expect(a.peers().find((p) => p.id === "e2e-b")?.paired).toBe(true);
    step("pairing both ways");

    // Transcript §send: A sends by name, B reads its inbox.
    expect(await a.sendToPeer("e2e-bruno", "summarize in 5 bullets")).toEqual({
      status: "queued",
    });
    const got = b.inbox().filter((m) => !isNotice(m)) as Envelope[];
    expect(got).toHaveLength(1);
    expect(got[0].type).toBe("request");
    expect(got[0].text).toBe("summarize in 5 bullets");
    step("request delivered to B inbox");

    // Transcript §answer (Option Y, decided ticket 04): B replies by number.
    expect(await b.reply(1, "1. 2. 3. 4. 5.")).toEqual({ status: "queued" });
    const answers = a.inbox().filter((m) => !isNotice(m)) as Envelope[];
    expect(answers).toHaveLength(1);
    expect(answers[0].type).toBe("response");
    expect(answers[0].inReplyTo).toBe(got[0].id);
    step("reply round-trips with inReplyTo");

    // Transcript §unpaired contrast: unknown sender gets 403, nothing queued.
    const before = b.inbox().length;
    const res = await fetch(`http://127.0.0.1:${portB}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "stranger-1",
        from: "stranger",
        to: "e2e-b",
        type: "request",
        text: "let me in",
        ts: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(403);
    expect(b.inbox()).toHaveLength(before);
    step("unpaired sender 403, nothing queued");

    // Transcript §timeout: B vanishes with a request unanswered; the send
    // already queued registers pending, so it expires into exactly one
    // local notice. Sends after death fail fast (no hang).
    expect(await a.sendToPeer("e2e-bruno", "are you there?")).toEqual({
      status: "queued",
    });
    await b.stop();
    await expect(a.sendToPeer("e2e-bruno", "too late")).rejects.toThrow();
    step("killed peer fails fast, no hang");
    await new Promise((r) => setTimeout(r, 1_200));
    const notices = a.inbox().filter(isNotice);
    expect(notices).toHaveLength(1); // answered request left no notice
    expect(notices[0].text).toMatch(/timed out/);
    expect(a.inbox().filter(isNotice)).toHaveLength(1); // no dup
    step("unanswered request expires into one notice");

    // Transcript §stop: B's goodbye removes presence (A sees it go
    // invisible); unpair forgets, TOFU file drops the unpaired id while
    // the still-paired side keeps its store for next time.
    await waitFor(
      () => !a.peers().some((p) => p.id === "e2e-b"),
      "goodbye removes presence",
      10_000,
    );
    step("stopped peer disappears from peers");
    expect(a.unpair("e2e-b")).toBe(true);
    await a.stop();
    const store = JSON.parse(readFileSync(pathA, "utf8")) as Array<{
      id: string;
    }>;
    expect(store.some((p) => p.id === "e2e-b")).toBe(false); // unpaired gone
    const storeB = JSON.parse(readFileSync(pathB, "utf8")) as Array<{
      id: string;
    }>;
    expect(storeB.some((p) => p.id === "e2e-a")).toBe(true); // TOFU kept
    step("unpair/stop clean, TOFU kept for still-paired side");
  }, 60_000);
});

describe("e2e: arrival event through the real v2 plugin adapter", () => {
  test("incoming message emits RPC event with peer name and text", async () => {
    const snap = snapshotRealPeers();
    try {
      const emitted: Array<{ name: string; data: unknown }> = [];
      type ToolDef = {
        name: string;
        execute: (a: unknown, c: unknown) => Promise<{ content: string }>;
      };
      const tools: Record<string, ToolDef> = {};
      // Minimal stub of the v2 plugin context: capture tool registrations
      // and RPC emissions, run everything else for real.
      await HubPlugin.setup({
        rpc: {
          register: async () => ({
            events: {
              emit: async (name: string, data: unknown) => {
                emitted.push({ name, data });
              },
            },
          }),
        },
        tool: {
          transform: async (cb: (editor: { add: (t: ToolDef) => void }) => void) => {
            cb({ add: (t) => { tools[t.name] = t; } });
          },
        },
      } as never);
      const run = async (name: string, args: unknown) =>
        (await tools[name].execute(args, {})).content;

      // A second hub plays the peer: real HTTP, real pairing, real POST.
      const started = await run("hub_start", { port: 41795 });
      const aid = started.match(/\(([^)]+)\)/)?.[1] ?? "";
      expect(aid.length).toBeGreaterThan(0);
      const peer = track(
        new HubCore("e2e-toast-b", "e2e-toast-bruno", {
          peersPath: tmpPeers(),
        }),
      );
      const portPeer = await peer.start(41796);
      const added = await run("hub_add", { target: `127.0.0.1:${portPeer}` });
      const bid = added.match(/\(([^)]+)\)/)?.[1] ?? "";
      expect(bid).toBe("e2e-toast-b");
      // Pair both ways (inbox gate is receiver-side).
      const code = await run("hub_pair", { peer: "e2e-toast-bruno" });
      expect(
        await run("hub_pair", { peer: bid, code: code.match(/\d{6}/)?.[0] }),
      ).toMatch(/paired with/);
      peer.redeemPairingCode(peer.issuePairingCode(), aid, "hub");
      peer.addPeer({ id: aid, name: "hub", port: 41795, addresses: ["127.0.0.1"] });

      expect(emitted).toHaveLength(0);
      expect(await peer.sendToPeer("hub", "hello toast")).toEqual({
        status: "queued",
      });
      await new Promise((r) => setTimeout(r, 300)); // emit is fire-and-forget
      expect(emitted).toHaveLength(1);
      expect(emitted[0].name).toBe("message");
      const data = emitted[0].data as { from: string; name: string; text: string };
      expect(data.name).toBe("e2e-toast-bruno");
      expect(data.text).toBe("hello toast");
      step("arrival RPC event fires with peer name and text");
      // The CLI companion renders exactly this event as its toast.
      expect(`hub: message from ${data.name}`).toBe(
        "hub: message from e2e-toast-bruno",
      );

      await run("hub_stop", {});
      await peer.stop();
    } finally {
      restoreRealPeers(snap);
    }
  }, 60_000);
});
