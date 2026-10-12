# 04: Replies, addressing, and arrival UX

**What to build:** full 1-to-1 conversation ergonomics: answer inbox items by number, address peers by number or name, and never miss an arrival — toast on incoming, poll-while-awaiting convention.

**Blocked by:** 03 (pairing and gated inbox).

**Status:** ready-for-agent

- [ ] `hub_reply <n> <text>` answers inbox item n with `inReplyTo` filled invisibly; uuids never in UX
- [ ] `hub peers` numbers peers; `hub_send` accepts number or name-alias; ambiguous names refused, never guessed
- [ ] Incoming message fires `tui.toast.show`; inbox shows requests, responses, system notices numbered
- [ ] Unanswered requests expire locally with a timeout error (no infinite retry)
