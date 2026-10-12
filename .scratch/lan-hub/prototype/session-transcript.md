# PROTOTYPE (throwaway) — faked hub session transcript

Two laptops, same WiFi. Everything below is invented output showing what the
decided protocol (tickets 01–04) would feel like. Purpose: expose UX awkwardness
before the spec is written. Not production, not tested, wipe freely.

## Machine A (Alba) — `hub start`

```
$ /hub start
hub: listening on :41737, advertising as "alba-mbp" (id 7f3a…)
hub: visible to LAN peers. `hub peers` to see who's around. `hub stop` to disappear.
```

State: serving HTTP on 41737, mDNS `_opencode-hub._tcp` published.

## Machine B (Bruno) — `hub start` (port clash demo)

Bruno already runs a second opencode instance on his own machine.

```
$ /hub start
hub: :41737 busy (your other instance?), bound :41738 instead.
hub: advertising as "bruno-x1" (id 9c11…) with port 41738.
```

State: peers learn the real port from mDNS SRV — nothing to configure.

## A sees B — `hub peers`

```
$ /hub peers
PEER      NAME       PAIRED   LAST SEEN
9c11…     bruno-x1   no       just now
```

## A initiates pairing — `hub pair`

```
$ /hub pair bruno-x1
hub: code for bruno-x1: 482-916 (expires in 5:00, single use).
Tell Bruno; their agent runs: /hub pair 482-916
```

Alba phones Bruno the digits. Bruno's agent:

```
$ /hub pair 482-916
hub: paired with alba-mbp (id 7f3a…). They can now message you.
```

State (both sides): TOFU store gains `{id, name, pairedAt}`.

## A sends a request — `hub send`

```
$ /hub send bruno-x1 "summarize the auth module in 5 bullets, return text only"
hub: request 3fa8… sent to bruno-x1. Reply arrives in your inbox (`hub inbox`).
```

Wire: `POST bruno:41738/v1/messages`
`{"id":"3fa8…","from":"7f3a…","to":"9c11…","type":"request","text":"summarize…","ts":"…"}`
→ `200 {"status":"queued"}` (queued into Bruno's `hub_inbox`, agent polls it).

Unpaired-sender case (for contrast): `POST` from unknown id → `403 Paired peers only`.

## B answers — inbox + reply

Bruno's agent polls:

```
$ /hub inbox
[1] from alba-mbp (req 3fa8…, 12:04:11): "summarize the auth module in 5 bullets…"
```

Bruno's agent works, then replies. OPEN UX QUESTION — how is the reply
correlated? Option X (shown): explicit flag:

```
$ /hub send alba-mbp --in-reply-to 3fa8… "1. … 2. …"
hub: response to 3fa8… sent.
```

Option Y: `hub reply 1 "1. …"` (inbox-number addressing).

## A reads the reply

```
$ /hub inbox
[1] from bruno-x1 (resp to 3fa8…, 12:06:02): "1. … 2. … 3. … 4. … 5. …"
```

Polling wart: Alba's agent only sees this when it next runs `hub inbox` —
there is no push (plugin capability finding). Latency = poll cadence.

## Timeout case — peer vanishes

Bruno closes his laptop. After ~3× heartbeat interval:

```
$ /hub peers
(no peers visible)
$ /hub inbox
[2] system: bruno-x1 gone (timeout). Request 3fa8… unanswered — expired, not retried.
```

## Opt out — `hub stop`

```
$ /hub stop
hub: unpublished, listener closed. You're invisible. TOFU store kept (re-pair skipped next time).
hub: `hub unpair bruno-x1` to forget them entirely.
```
