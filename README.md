# Hearth v0

Hearth is a small local-first MCP server that gives ChatGPT a durable, bounded Windows operating substrate without turning every recipe into another MCP tool. It uses the current split MCP v2 packages and Node 24's built-in SQLite. The MCP layer is stateless; jobs, generic futures, per-conversation mailboxes, artifacts, runs, recipes, receipts, continuations, and append-only events share one WAL-mode database.

## Requirements and install

- Windows 10/11 and Node.js 24+
- Windows PowerShell 5.1 for UI Automation

```powershell
cd D:\userdata\docs\projects\hearth
npm install
Copy-Item config.example.json config.json
npm test
npm start
```

The server prints `Hearth listening at http://127.0.0.1:3000/mcp`. Override the config location with `$env:HEARTH_CONFIG='D:\path\config.json'`. The bind is deliberately localhost-only. `/mcp` accepts POST only; all other routes return 404. SDK Host and Origin safeguards reject DNS-rebinding and cross-origin requests.

Data defaults to `.hearth/hearth.db`, with artifacts and backups beside it. Keep `config.json`, the database, and artifacts private: they may contain user data and command output. Hearth does not intentionally store tunnel credentials or raw OpenAI routing identifiers.

## Architecture and safety

`src/server.js` mounts the MCP v2 `createMcpHandler` through the Node HTTP adapter. This supplies MCP 2026-07-28 `server/discover` and modern stateless calls while retaining the SDK's stateless legacy fallback. Each request gets a cheap `McpServer`; `src/hearth.js` owns shared SQLite and services.

Commands use direct executable/argv spawning (`shell: false`), bounded timeout and output, and a configurable concurrency cap. Large output spills to an artifact. Files must remain under configured roots after real-path/symlink checks. Writes and patches use same-directory temporary files plus rename, require an optional `expected_sha256`, and produce durable undo receipts. UI work is globally serialized and goes through a bounded STA PowerShell UIA bridge; fallback input is off unless `allow_fallback` is explicitly true and the request scopes it to an `hwnd` or `process_id`.

The seven ChatGPT-facing tools use strict operation-specific JSON Schemas. Unknown fields are rejected rather than silently discarded. `run.scatter` is deliberately closed-world: its `kind` discriminator can select only known Hearth primitives, so it cannot redispatch an arbitrary tool name plus arbitrary input. The only top-level tool that is entirely read-only is `artifact`, and it carries MCP read-only/idempotent annotations; the other six mix read and write operations, so a tool-level `readOnlyHint` would be inaccurate without splitting the public surface.

Every operation returns a concise `state`: normally `completed`, `pending`, `blocked`, `conflict`, `partial`, `cancelled`, or `superseded`. Tool errors also set MCP `isError`. Each Hearth-produced MCP response also includes bounded `arrivals` from previously detached work for the same conversation. Dispatch starts immediately and races `dispatch_inline_budget_ms` (100 ms by default); a slower operation returns `{state:"pending",future_id}` and its durable completion piggybacks on a later Hearth call without polling. Every tool also accepts the common transport hint `detach:true`, which forces that immediate future response even for a fast primitive and is stripped before primitive execution. Arrival `seq` values reflect completion order, not submission order, and large detached JSON spills to artifacts. Delivery is at-least-once: a retry of the same MCP request can re-offer the previous cursor, while the next distinct request acknowledges what was offered previously. Hearth fingerprints the full request ID for this retry distinction and does not persist the raw identifier.

## Seven static tool contracts

All tools accept a JSON object with `operation` plus operation fields.

### `machine`

- `host_info`
- `exec`: `command`, optional `args[]`, `cwd`, `env`, `timeout_ms`
- `batch`: `commands[]` using the exec shape; at most 16, run concurrently
- `process_list`
- `process_kill`: positive `pid`, optional `signal`; refuses Hearth's own PID

Output above `max_output_bytes` has `preview` and `artifact` instead of a large body. Capture is hard-capped by `max_artifact_bytes`.

### `fs`

- `list`: `path`, optional `limit`
- `read`: `path`, optional `offset`, `limit`, `encoding`
- `search`: `path`, `query`, optional `limit`, `max_entries`
- `stat`: `path`
- `write`: `path`, `data`, optional `expected_sha256` (`null` asserts the file does not exist)
- `patch`: `path`, `replacements: [{old,new}]`, optional `expected_sha256`; every `old` must occur exactly once
- `undo`: `receipt_id`; conflicts if the post-write hash no longer matches

Search skips symlinks and files over 2 MB. Reads and result counts are bounded.

### `task`

- `submit`: `job` or `jobs[]` for durable executable work. Each job uses `command` plus optional `args`, `cwd`, `env`, `timeout_ms`, `delay_ms`/`run_at`, and `dependencies`.
- `get`/`status`: `id`
- `wait`: `id`, optional bounded `timeout_ms`
- `cancel`: `id`; queued generic futures cancel atomically, while already-running generic work reports that it cannot be cancelled safely
- `list`: optional `limit`

Independent due jobs and generic futures run concurrently under separate configured caps. Failed or missing dependencies block dependents explicitly. Routed task status/list/wait/cancel access is isolated to the same conversation. Queued executable jobs survive restart and an interrupted durable exec job is requeued; interrupted generic work becomes `blocked` instead of replaying a possibly side-effecting call. The old open-world `calls:[{tool,input}]` descriptor is intentionally not exposed by the ChatGPT-facing MCP schema; heterogeneous orchestration is provided by the closed typed `run.scatter` contract below.

### `artifact`

- `list`: optional `limit`
- `metadata`: `id`
- `read`/`range`: `id`, optional `offset`, `limit`, `encoding`
- `search`: `id`, `query`, optional `limit`

### `ui`

- `snapshot`: optional `hwnd` or `process_id`, `max_depth` (max 12), `max_nodes` (max 5000)
- `query`: same root plus `target`
- `action`: same root, `target: {automation_id?,name?,control_type?}`, `action` (`invoke`, `focus`, `set_value`, or opted-in fallback `click`/`key`), optional `value`, `virtual_key`, `allow_fallback`

Nodes normalize names, automation IDs, classes, control types, process IDs, state, bounds, patterns, children, and snapshot-local locators. UIA needs the same interactive desktop and generally cannot automate elevated applications from a normal process; these cases return `blocked`, never silent input. Tests safely snapshot and invoke only a disposable WPF fixture.

### `recipe`

- `create`: `name`, optional `description`, `steps[]`
- `list`, `get`, `stats`, `delete`
- `run`: `name`, optional `params`
- `suggest`: optional `threshold` (default 3), `min_length` (default 2)

A step is `{primitive,input}`. Allowed primitives are `machine.exec`, `fs.read`, `fs.write`, `fs.patch`, and `task.submit`. `${name}` substitution occurs inside data/argv, never a shell string. Runs are sequential, bounded by `recipe_max_steps`, traced, counted, and auditable. Suggestions report repeated contiguous primitive patterns; they never auto-create recipes.

### `run`

- `checkpoint`: optional `id`, plus `objective`, `acceptance_criteria[]`, `summary`, `next_actions[]`, `pending_task_ids[]`; pass the existing `id` to update a durable run
- `scatter`: `calls[]` with a closed `kind` discriminated union. Current kinds cover selected `machine`, `fs`, `artifact`, semantic `ui`, and `recipe.run` primitives. Every call becomes a durable future immediately.
- `list`, `get`, `close`
- `schedule_continuation`: `run_id`, `prompt`, optional `delay_ms` or ISO `run_at`, optional `target: {session}` or `{browser_tab}`
- `continuation_status`: `id`
- `events`: optional `limit`, `entity_id`

Scatter dependencies may be batch indexes or same-conversation future IDs. A typed input field may instead be an exact future reference object `{$future: index-or-id, $path: "result.field"}`; that reference also creates the dependency automatically and is resolved only after the referenced future completes. The primitive itself remains fixed by `kind`, so dataflow does not become arbitrary redispatch. For example:

```json
{
  "operation": "scatter",
  "calls": [
    { "kind": "fs.stat", "path": "D:\\userdata\\docs\\projects\\hearth\\README.md" },
    { "kind": "fs.read", "path": { "$future": 0, "$path": "result.path" }, "limit": 4096 }
  ]
}
```

Independent calls can finish in any order and arrive by completion sequence. A dependent call waits without polling. Missing, failed, or cross-conversation references become explicit `blocked` futures.

Due continuation records are explicit. With no Oracle target they become `blocked`; with a target and default `oracle.armed: false`, they expose a safe dry-run command. Hearth stores no Oracle/API secret and does not claim an external continuation happened. Arming only changes command construction metadata in v0; execution remains an explicit machine/task operation.

## Secure MCP Tunnel hookup

Hearth does not need a public bind or inbound firewall rule. Obtain a tunnel ID in OpenAI Platform tunnel settings, associate it with the ChatGPT workspace, and create a runtime key with Tunnels **Read + Use**. Download the current Windows build from <https://github.com/openai/tunnel-client/releases/latest> (use v0.0.14 or newer for MCP 2026-07-28).

With Hearth already running:

```powershell
$env:CONTROL_PLANE_API_KEY = 'sk-...'
tunnel-client init `
  --sample sample_mcp_remote_no_auth `
  --profile hearth-local `
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef `
  --mcp-server-url http://127.0.0.1:3000/mcp
tunnel-client doctor --profile hearth-local --explain
tunnel-client run --profile hearth-local
```

Then enable ChatGPT developer mode, open Plugins, create an app, select **Tunnel**, and choose/paste that tunnel ID. Keep both Hearth and `tunnel-client` running. Never place the runtime key in Hearth config. This tunnel is for private/developer use, not public plugin submission.

Hearth hashes the tunnel's `openai/session` metadata with SHA-256 for mailbox routing and never passes raw OpenAI session, subject, organization, or request identifiers into persistence. Anonymous local stateless requests receive isolated request-scoped routes; local clients that need cross-request delivery can send `hearth/conversation` metadata. An early pending OpenAI response may include a reusable expiring `route_probe` nonce. The built-in loopback-only CDP binder can map that exact nonce to one unique ChatGPT tab with a stable `/c/<id>` conversation URL and persists only the route fingerprint, target ID, and stable conversation URL. Automatic wake is implemented but disabled by default; set `wake.armed:true` to enable it. It uses the already-bound loopback CDP target directly and does not require `oracle.armed`. When armed, Hearth wakes only a bound quiet conversation with undelivered terminal arrivals, using debounce, cooldown, and attempt limits; pending work alone never wakes a tab. The wake prompt asks ChatGPT to make one known-safe `machine.host_info` call, whose normal response piggybacks the ready arrivals, then continue the prior task from them. Oracle remains separate for explicitly scheduled continuation records.

## Validation

```powershell
npm test
```

The tests pin MCP `2026-07-28` and exercise discovery/list/call, strict schema rejection, the closed scatter contract including typed future references, two clients, fs conflict/undo/containment, spill/range/search, immediate delayed/dependent/concurrent jobs, automatic and explicit detachment, async mailbox isolation/completion order/request-key retry cursors/bounds, heterogeneous future DAGs and restart safety, routing metadata normalization, CDP route binding and bounded wake submission, recipe stats/traces/suggestions, due dry-run continuations, a bounded desktop snapshot, and a semantic invoke against a disposable WPF window. The live Secure MCP Tunnel path and ChatGPT model behavior are additionally verified manually because they require the signed-in browser environment.
