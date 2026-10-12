# 06: Two-machine end-to-end verification

**What to build:** the prototype transcript run for real: two machines, one WiFi, full session (start, port clash, pairing, send/reply, timeout, stop) green — clearing the spec's two-machine smoke-test risk.

**Blocked by:** 02 (LAN discovery), 03 (pairing and gated inbox), 04 (replies, addressing, arrival UX).

**Status:** ready-for-agent → automated part done (see below); two-machine run pending

- [x] Two instances discover, pair, exchange request → response, unpair/stop cleanly
- [x] Second instance on one machine gets incremented port and still works
- [x] Killed peer times out (no hang); unpaired sender gets 403
- [ ] Result logged (pass/fail per step) against the transcript in `.scratch/lan-hub/prototype/session-transcript.md`

Automated (`src/e2e.test.ts`, 41/41 suite green 2026-10-12): full loop
single-machine — start, clash→41791, real-mDNS mutual discovery with SRV
ports, both-ways pairing (+single-use enforced), request→inbox,
reply-by-number with inReplyTo, 403 for stranger, killed-peer send fails
fast, unanswered request→exactly one timeout notice, goodbye removes
presence, unpair drops the TOFU id while the still-paired side keeps its
store. Plus arrival-toast proof through the real `HubPlugin` adapter with a
stub client (`showToast` fired once, peer name + text). The toast test
snapshots/restores the real `~/.config/opencode/hub-peers.json` so runs
leave no trace (adapter has no path-injection seam by design).

## Manual: two machines, one WiFi (needs a second computer)

- [ ] On both: `hub_start` → each `hub_peers` shows the other (mDNS; else `hub_add <ip:port>`)
- [ ] Pair via code, `hub_send` by name both directions, `hub_reply` back
- [ ] Toast appears on arrival; `hub_inbox` numbering matches
- [ ] Stop one → other sees it vanish; unanswered request → timeout notice
- [ ] Note AP/client-isolation or firewall blocks in `docs/hub-setup.md` if hit
