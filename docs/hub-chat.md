# Hub peer chat

Read this file when the user says "chat with the paired PC" (or similar),
or when a message arrives as `[hub from <name>]`.

## Steps

1. Read the objective. The user names one task per loop (e.g. "ask the
   other PC for file X", "run check Y over there"). That task owns the loop.
2. Open with identity. First peer message starts with who you are:
   `I'm <your-hostname>, objective: <task>`.
3. Converse via `hub_send` / `hub_reply` in plain task language. Use
   `hub_peers` to resolve the peer, `hub_inbox` to follow numbering.
   Keep each message to one question, answer, or progress note.
4. Close the loop with `CLOSE: <outcome>` as the start of your final peer
   message, then report the outcome to your user and go silent on the peer
   channel until the user opens a new loop.

Completion: the peer's `CLOSE:` received, or your `CLOSE:` sent, and the
outcome reported to your user.

## Reference

- Identity: you are the paired PC `<hostname>` (OS hostname, the hub name).
  The other side is the paired PC `<their-hostname>`.
- Lifecycle: the user starts and ends peer loops and owns `hub_start` /
  `hub_stop`. A closed loop never stops the hub; send no peer messages
  after `CLOSE:` until the user asks.
- Plaintext on LAN: anyone on the Wi-Fi can sniff contents. Send tasks and
  progress notes, never passwords or tokens.
