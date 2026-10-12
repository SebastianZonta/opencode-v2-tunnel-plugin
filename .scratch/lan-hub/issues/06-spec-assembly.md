Type: task

Status: resolved

## Question

Assemble the destination artifact: the build-ready spec at `.scratch/lan-hub/spec.md`, synthesizing the resolved tickets — [lan discovery](01-lan-discovery.md), [plugin capabilities](02-opencode-plugin-capabilities.md), [transport + envelope](03-transport-envelope.md), [pairing + trust](04-pairing-trust.md), [session prototype](05-session-prototype.md) — plus the [prototype transcript](../prototype/session-transcript.md).

The spec must cover: topology, discovery (primary + fallback), transport + full envelope schema, pairing/trust flow, plugin surface (tools `hub_start/stop/peers/send/reply/inbox/unpair/pair` + `/hub` slash commands, permissions), packaging/distribution, firewall/setup notes, the hostile-WiFi sniffing warning, and open risks. Text-only, 1-to-1, same-WiFi scope; everything else stays out.

AFK-able: the agent drives this alone from the five resolutions; no human input needed unless a contradiction between tickets surfaces (then ask).

## Answer

Spec assembled at [spec.md](../spec.md) 2026-10-12. Synthesized all five resolutions with no contradictions found (TXT-stays-tiny from 01 respected by TCP-after-discovery pairing from 04; poll-inbox + toast from 02/05; v1 plugin API throughout). Open risks carried into spec §7, including the two-machine Bun smoke test left for implementation.
