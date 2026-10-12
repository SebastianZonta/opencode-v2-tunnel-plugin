Type: research

Status: resolved

## Question

What can an opencode plugin actually do? Establish the capability facts that constrain this effort's spec: plugin runtime (language, Node/Bun APIs available), whether a plugin can run a background daemon/listener (TCP/UDP/mDNS) while opencode runs, how commands and tools are exposed (`hub start/stop`, `hub peers`, `hub send`, inbox), permission model, packaging/distribution, and any hard limits (no raw sockets? no background tasks?). Cite the opencode plugin docs.

Decide only capability facts; protocol design is separate tickets.

## Answer

Researched 2026-10-12 against primary sources (opencode docs + `packages/plugin` / `packages/opencode/src/plugin` source, Bun Node-compat docs).

**Runtime: JS/TS on Bun, in-process, unsandboxed.**
- A plugin is a JS/TS module exporting one or more plugin functions; opencode loads it with a plain dynamic `import()` at startup and calls each export with `{ project, directory, worktree, client, $ }` (`$` = Bun shell API). No sandbox: plugins get full Bun/Node APIs, arbitrary shell via `$`, and arbitrary npm deps (`package.json` in config dir, `bun install` at startup). Sources: https://opencode.ai/docs/plugins/ (`Create a plugin`, `Dependencies`, `Basic structure`); loader source (`await import(plugin)`, `BunProc.install`), e.g. https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts and forks' `packages/opencode/src/plugin/index.ts`.
- `node:net` and `node:dgram` are both fully implemented in Bun (green status), so TCP listeners and UDP multicast (mDNS/discovery) from inside a plugin are runtime-supported. Source: https://bun.sh/docs/runtime/nodejs-apis. No built-in mDNS helper — needs an npm dep (e.g. `multicast-dns`, `bonjour-service`). No raw IP sockets (neither Node nor Bun offers them without native/root helpers) — irrelevant for this effort.

**Background listener: YES while opencode runs, NO beyond it.**
- Plugin init runs once at startup in the opencode process; module-level state persists for process lifetime (hooks cached in a process singleton). Nothing stops init from opening a TCP server / UDP multicast socket and keeping it alive; there is a `dispose?` hook for teardown in current `Hooks` type. So `hub start` = open listener + start discovery loop; `hub stop` = close + dispose. Limits: (a) listener dies with the opencode process — no system daemon, no autostart, no delivery while opencode is closed; (b) no documented push API to inject an unsolicited message into a live agent session — inbound side must be a **poll-based inbox**: a custom tool (e.g. `hub_inbox`) reading an in-memory/file queue, optionally surfaced via `event` hook / `tui.toast.show` notification. Event catalog (`session.*`, `message.*`, `tool.execute.*`, `permission.*`, `tui.*`, `server.connected`, `shell.env`) has no "deliver message to agent" event. Source: https://opencode.ai/docs/plugins/ (`Events`).

**Commands vs tools: `hub ...` surface = custom tools (+ optional slash-command markdown).**
- v1 plugins expose agent-callable functions via the `tool()` helper (Zod args + `execute(args, ctx)` with `{ agent, sessionID, messageID, directory, worktree }`); filename (or `<file>_<export>`) becomes the tool name; a plugin tool with a built-in's name takes precedence. So `hub_peers`, `hub_send`, `hub_inbox`, `hub_start/stop` are tools, gated per-tool by permissions. Sources: https://opencode.ai/docs/plugins/ (`Custom tools`), https://opencode.ai/docs/custom-tools/.
- Slash commands (`/hub ...`) are NOT registered by v1 plugin code; they come from the `command` config field or `commands/*.md` files (global `~/.config/opencode/commands/`, project `.opencode/commands/`), with `$ARGUMENTS`/`$1..` placeholders. A plugin can ship companion `.md` command files, and its `config` hook can mutate config (community manual documents injecting commands/agents/MCP via `config` hook: https://github.com/joshuadavidthomas/opencode-plugins-manual). `command.execute.before` / `tui.command.execute` hooks can intercept. So: agent path = tools; human path = thin `/hub` markdown commands that call the tools. Source: https://opencode.ai/docs/commands/.
- (v2 note, beta, not our target: `Plugin.define({id, setup})` with `ctx.command.transform`, `ctx.tool`, `ctx.session.prompt`, `ctx.event`. Source: https://v2.opencode.ai/build/plugins.md.)

**Permission model: per-tool allow/ask/deny, permissive defaults.**
- `permission` config keys on tool name (`hub_send: "allow"`, wildcards like `hub_*: "ask"` supported), plus granular per-input patterns, `external_directory`, `doom_loop` guards; defaults mostly `allow`. Plugins can also programmatically answer via the `permission.ask` hook. Practical consequence: spec should name stable tool keys (`hub_*`) and recommend `allow` for read-only (`hub_peers`, `hub_inbox`) and `ask`/`allow` at user discretion for `hub_send`. Source: https://opencode.ai/docs/permissions/.

**Packaging/distribution: local dir or npm, auto-installed.**
- Local: drop `.js/.ts` in `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global), loaded at startup. npm: list in config `plugin: [...]`, auto-installed with Bun at startup, cached in `~/.cache/opencode/node_modules/`. Load order: global config → project config → global plugin dir → project plugin dir. No store/review process. Source: https://opencode.ai/docs/plugins/ (`Use a plugin`, `Load order`).

**Hard limits / constraints for the LAN P2P spec:**
1. No delivery while opencode is closed; presence must tolerate peers vanishing (timeout-based, no graceful leave guaranteed).
2. Inbox is poll-based (`hub_inbox` tool); no true push into the agent. Incoming-request latency = agent's poll cadence.
3. Two opencode instances = two independent permission scopes; each user approves their own `hub_*` tools.
4. OS firewall may block inbound TCP / UDP multicast — setup must document allowing the chosen port; same-subnet multicast required for mDNS-style discovery.
5. No raw sockets; TCP+UDP-multicast only. Fine for v1.
6. Target v1 plugin API (`@opencode-ai/plugin` named-export functions); v2 API is beta and breaking (`Plugin.define` default export).

**Open risks:** (a) exact unsolicited-arrival UX untested — prototype must confirm a tool-poll loop is acceptable; (b) `multicast-dns`-under-Bun on the users' LANs untested; (c) concurrent opencode processes on one machine (port conflicts) need spec attention.
