# 01: Skeleton plugin with loopback messaging

**What to build:** the plugin loads in opencode and messages itself: `hub start` opens the HTTP listener, `hub send` to self lands in `hub inbox`, `hub stop` closes everything. This proves scaffold + HTTP + tool wiring end to end before any networking.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Plugin loads at opencode startup from local dir (v1 plugin API)
- [x] `hub_start` binds HTTP on 41737 (auto-increment on `EADDRINUSE`); `hub_stop` closes it
- [x] `POST /v1/messages` with the v1 envelope (from wayfinder 03 — decision, not demo):
      `{id, from, to, type: request|response|error, inReplyTo?, text ≤64KB, ts}`;
      mismatched `to` dropped; receiver queues to inbox, replies `200 {"status":"queued"}`
- [x] `hub_send` + `hub_inbox` round-trip to self works; `hub_peers` runs (empty is fine)
