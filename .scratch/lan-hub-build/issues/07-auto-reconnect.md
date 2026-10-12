# 07: Restart reconnect (stable id + remembered address)

**What to build:** make "known ids skip re-pairing" (03) actually hold. Today the
plugin mints a random uuid per launch, so every opencode restart reads as a
*changed* peer: TOFU entry shows `paired:no`, sends get 403, and on a network
where mDNS and beacons are both filtered (unicast TCP works, multicast does not)
`hub_peers` comes back empty and only `hub_add` recovers it.

**Blocked by:** 03 (pairing + TOFU store), 05 (beacon fallback).

**Status:** done (45/45 bun tests, tsc clean)

- [x] Instance id persists in `~/.config/opencode/hub-id.json` (load-or-create) and the plugin passes it to `HubCore` instead of `createId()`
- [x] `hub-peers.json` records the last seen `port`/`addresses` per paired peer, kept current by mDNS, beacon and manual-add sightings (heartbeat churn suppressed)
- [x] `redeemPairingCode` captures the address the peer was already seen at
- [x] `HubCore.reconnect()` re-probes remembered addresses from `start()`, in the background so a dead peer cannot delay the listener
- [x] Tests: id stable across loads, address remembered at pairing, reconnect with discovery never started

**Known limits:** one identity per machine, so two hub instances on one machine
(open risk §7.3) share it and collide on the peer id. A peer that moves (DHCP) or
takes a new port is only found by discovery or `hub_add` again —
`shortcut: reconnect trusts the last address it saw; DHCP moves need discovery or hub_add`.

**Not in this ticket:** pairing still has no wire step — a code only validates
inside the process that issued it, so entering it on the *other* machine fails
with "unknown pairing code". Each side has to redeem its own code locally
(`hub_pair <peer>` then `hub_pair <peer> <that code>`), as `fallback.test.ts`
does.
