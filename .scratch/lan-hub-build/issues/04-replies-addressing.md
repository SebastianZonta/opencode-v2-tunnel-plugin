# 04: Replies, addressing, and arrival UX

**What to build:** full 1-to-1 conversation ergonomics: answer inbox items by number, address peers by number or name, and never miss an arrival — toast on incoming, poll-while-awaiting convention.

**Blocked by:** 03 (pairing and gated inbox).

**Status:** done (commit feat(hub): replies, number-or-name addressing, timeout notices)

- [x] `hub_reply <n> <text>` answers inbox item n with `inReplyTo` filled invisibly; uuids never in UX
- [x] `hub peers` numbers peers; `hub_send` accepts number or name-alias; ambiguous names refused, never guessed
- [x] Incoming message fires `tui.toast.show`; inbox shows requests, responses, system notices numbered
- [x] Unanswered requests expire locally with a timeout error (no infinite retry)
