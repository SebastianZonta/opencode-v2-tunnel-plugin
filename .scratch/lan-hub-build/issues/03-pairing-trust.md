# 03: Pairing and gated inbox

**What to build:** trust before content: `hub pair` shows a 6-digit single-use 5-minute code, the other side submits it, and only then do messages flow — unpaired senders get HTTP 403 and paired peers persist across restarts.

**Blocked by:** 01 (skeleton plugin with loopback messaging).

**Status:** done (22/22 bun tests incl. 7 pairing, tsc clean; merged from subagent copy, commit 4dd5301)

- [ ] `hub_pair <peer>` issues code (6-digit, 5-min, single-use); `hub_pair <code>` redeems
- [ ] Pre-pairing, only name + id visible; `POST /v1/messages` from unpaired id → 403
- [ ] TOFU store (`~/.config/opencode/hub-peers.json`): known ids skip re-pairing, unknown/changed ids re-pair
- [ ] `hub_unpair <peer>` forgets; testable via manual IP without mDNS
