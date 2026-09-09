# Hearth v0 bootstrap

Build a real, tested MCP runtime in this repository for ChatGPT Web to operate this Windows PC. The human wants a deliberately thin substrate that can grow reusable scaffolds from usage rather than a huge fixed toolkit. Use the installed Ponytail ruleset and keep the implementation small without cutting correctness, rollback, validation, or tests.

Environment:
- Windows 10/11 host DESKTOP-KQ7KOCE
- Node.js 24.19.0, npm 11.17.0
- pi is the required coding harness
- Ponytail is already installed in pi from D:\userdata\tools\ponytail
- Oracle CLI: C:\nvm4w\nodejs\oracle.cmd, browser-capable, has --followup and --browser-tab
- Oracle dedicated Chrome profile is C:\Users\mitob\.oracle\browser-profile, CDP port 9223
- Future ChatGPT connection should use OpenAI Secure MCP Tunnel. tunnel-client is not installed yet.
- Working roots should default to D:\userdata\docs\projects and D:\userdata\docs\work and be configurable.

Use the CURRENT @modelcontextprotocol/sdk rather than legacy protocol code. ChatGPT/Secure MCP Tunnel uses MCP 2026-07-28 server/discover, so the server must pass modern discovery as well as ordinary tools/list and tools/call. Prefer Streamable HTTP at /mcp, localhost-only by default. State must be shared safely across concurrent MCP clients.
## ChatGPT-facing surface

Keep the MCP surface static and small. Aim for these seven tools unless the SDK or implementation gives a compelling reason to merge one:
1. machine — host info, foreground exec, parallel batch exec, process list/kill. Commands have timeout/cwd/env and bounded output.
2. fs — list/read/search/stat plus atomic write/patch. Mutations must support expected_sha256 optimistic concurrency and automatic backups/undo receipts.
3. task — durable background/future jobs. Submit one or many exec jobs with delay and dependencies; return pending IDs immediately; status/wait/cancel/list. Multiple independent jobs should execute concurrently. Persist across server restart.
4. artifact — read/search/range metadata for large command outputs, logs, screenshots, diffs. Do not pour huge output into MCP context.
5. ui — Windows UI Automation accessibility snapshot/query/action first, with keyboard/mouse fallback. Keep the interface normalized enough to add CDP later. Implement and test at least snapshot plus one safe action against a test UI if possible.
6. recipe — server-side self-scaffolding registry. create/list/get/run/delete plus usage statistics and repeated-trace suggestions. Recipes are data behind this one static MCP tool; never dynamically add hundreds of MCP tools.
7. run — durable work state: objective, acceptance criteria, summary, next actions, pending task IDs, checkpoint/list/get/close. Include delayed wake/continuation records. Do not silently claim a continuation happened.

Use Node's built-in SQLite if suitable so there is no native third-party database build. Prefer no dependencies beyond MCP SDK, zod, and a minimal HTTP package only if the SDK examples need it.
## Runtime semantics

Every tool response should be structured, concise, and explicit about state: completed, pending, blocked, retryable, conflict, partial, cancelled, superseded. Large bodies go to artifacts with a preview.

Task dependencies should allow late-bound futures. A submitted task may depend on another task ID. The executor waits for dependencies without requiring another model turn. Delay may be expressed as delay_ms or run_at. On restart, runnable queued jobs should resume. Record an append-only event log sufficient for recipe suggestions and debugging.

Parallel MCP clients must be safe. SQLite transactions plus expected hashes are sufficient for v0. UI actions should be serialized with a lease/mutex because two clients clicking concurrently is unsafe.

For recipes, support a small declarative step format rather than eval. Steps may call machine exec or selected fs/task operations with parameter substitution. Keep recipe execution bounded and auditable. Trace primitive operation names and have recipe suggest report repeated contiguous patterns above a threshold; do not auto-create recipes without a model explicitly asking.

For continuation, implement the persistence and scheduler now. Add an Oracle adapter module that can build a command for a stored Oracle session/followup or browser tab, but default it to dry-run unless explicitly armed with enough target information. Never store API keys. The scheduler should be able to mark a continuation due and expose it through run/status even when no adapter target is configured.
## Acceptance

Do not stop at scaffolding. Finish a runnable v0 and validate it locally.
- npm install succeeds from a clean checkout.
- npm test passes.
- start server on 127.0.0.1 with a documented command.
- exercise server/discover, tools/list and at least one tools/call using an MCP client or an integration test.
- verify two concurrent clients/requests do not corrupt shared state.
- verify task submit returns immediately, delayed/dependent jobs later complete, and queued work survives a server restart if practical in test.
- verify fs expected_sha256 conflict behavior and undo/backup receipt.
- verify large exec output becomes an artifact and can be ranged/searched.
- verify recipe create/run/stats and repeated-trace suggestion on synthetic traces.
- verify run checkpoint and delayed continuation state.
- verify UI snapshot on this Windows machine if accessibility APIs are available. If Windows session restrictions prevent it, test the module deterministically and report the exact live limitation.

Write README.md with architecture, exact commands, ChatGPT Secure MCP Tunnel hookup, and the seven tool contracts. Include a sample config and .gitignore. Keep security local-first: localhost bind, configurable roots, no shell interpolation in recipe execution, no secrets in DB/logs.

Commit the finished v0 to the local git repo. Before committing inspect git diff and run tests again. If any dependency/API differs from assumptions, adapt using installed/current docs instead of stopping for clarification.
