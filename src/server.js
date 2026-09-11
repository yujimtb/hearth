import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { Hearth, loadConfig } from './hearth.js';

const detach = { detach: z.boolean().optional().describe('Return a future immediately even if this operation is fast.') };
const op = shape => z.strictObject({ ...shape, ...detach });
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const dependencies = z.array(z.union([nonNegativeInt, z.string().min(1)])).max(64).optional();
const envSchema = z.record(z.string(), z.string());
const expectedSha = z.union([z.string().regex(/^[a-f0-9]{64}$/i), z.null()]).optional();
const futureRef = z.strictObject({
  $future: z.union([nonNegativeInt, z.string().min(1)]).describe('Batch index or same-conversation future ID.'),
  $path: z.string().min(1).max(512).describe('Dot path inside the referenced future wrapper, e.g. result.path.')
});
const fromFuture = schema => z.union([schema, futureRef]);

const execSpec = z.strictObject({
  command: z.string().min(1).describe('Executable path/name. No shell parsing; put each argument in args.'),
  args: z.array(z.string()).max(256).optional(), cwd: z.string().optional(), env: envSchema.optional(),
  timeout_ms: positiveInt.max(300000).optional()
});
const jobSpec = z.strictObject({
  command: z.string().min(1), args: z.array(z.string()).max(256).optional(), cwd: z.string().optional(), env: envSchema.optional(),
  timeout_ms: positiveInt.max(300000).optional(), delay_ms: nonNegativeInt.optional(), run_at: z.string().optional(), dependencies
});
const targetSchema = z.strictObject({
  automation_id: z.string().optional(), name: z.string().optional(),
  control_type: z.string().optional().describe('UIA control type, e.g. button, edit, window; case-insensitive.')
});
const uiRoot = { process_id: positiveInt.optional(), hwnd: nonNegativeInt.optional() };
const replacements = z.array(z.strictObject({ old: z.string(), new: z.string() })).max(128);

const machineInput = z.discriminatedUnion('operation', [
  op({ operation: z.literal('host_info') }),
  op({ operation: z.literal('exec'), ...execSpec.shape }),
  op({ operation: z.literal('batch'), commands: z.array(execSpec).max(16) }),
  op({ operation: z.literal('process_list') }),
  op({ operation: z.literal('process_kill'), pid: positiveInt, signal: z.string().optional() })
]);

const fsInput = z.discriminatedUnion('operation', [
  op({ operation: z.literal('list'), path: z.string(), limit: positiveInt.max(1000).optional() }),
  op({ operation: z.literal('stat'), path: z.string() }),
  op({ operation: z.literal('read'), path: z.string(), offset: nonNegativeInt.optional(), limit: positiveInt.optional(), encoding: z.string().optional() }),
  op({ operation: z.literal('search'), path: z.string(), query: z.string(), limit: positiveInt.max(1000).optional(), max_entries: positiveInt.max(50000).optional() }),
  op({ operation: z.literal('write'), path: z.string(), data: z.string().describe('File contents. Use data, not content.'), expected_sha256: expectedSha }),
  op({ operation: z.literal('patch'), path: z.string(), replacements, expected_sha256: expectedSha }),
  op({ operation: z.literal('undo'), receipt_id: z.string().min(1) })
]);

const taskInput = z.union([
  op({ operation: z.literal('submit'), job: jobSpec }),
  op({ operation: z.literal('submit'), jobs: z.array(jobSpec).min(1).max(64) }),
  op({ operation: z.literal('get'), id: z.string().min(1) }),
  op({ operation: z.literal('status'), id: z.string().min(1) }),
  op({ operation: z.literal('list'), limit: positiveInt.max(100).optional() }),
  op({ operation: z.literal('cancel'), id: z.string().min(1) }),
  op({ operation: z.literal('wait'), id: z.string().min(1), timeout_ms: positiveInt.max(120000).optional() })
]);

const artifactInput = z.discriminatedUnion('operation', [
  op({ operation: z.literal('list'), limit: positiveInt.max(100).optional() }),
  op({ operation: z.literal('metadata'), id: z.string().min(1) }),
  op({ operation: z.literal('read'), id: z.string().min(1), offset: nonNegativeInt.optional(), limit: positiveInt.optional(), encoding: z.string().optional() }),
  op({ operation: z.literal('range'), id: z.string().min(1), offset: nonNegativeInt.optional(), limit: positiveInt.optional(), encoding: z.string().optional() }),
  op({ operation: z.literal('search'), id: z.string().min(1), query: z.string(), limit: positiveInt.max(1000).optional() })
]);

const uiInput = z.union([
  op({ operation: z.literal('snapshot'), ...uiRoot, max_depth: nonNegativeInt.max(12).optional(), max_nodes: positiveInt.max(5000).optional(), timeout_ms: positiveInt.max(30000).optional() }),
  op({ operation: z.literal('query'), ...uiRoot, target: targetSchema, max_depth: nonNegativeInt.max(12).optional(), max_nodes: positiveInt.max(5000).optional(), timeout_ms: positiveInt.max(30000).optional() }),
  op({ operation: z.literal('action'), ...uiRoot, target: targetSchema, action: z.enum(['invoke','focus']), allow_fallback: z.boolean().optional(), timeout_ms: positiveInt.max(30000).optional() }),
  op({ operation: z.literal('action'), ...uiRoot, target: targetSchema, action: z.literal('set_value'), value: z.string(), allow_fallback: z.boolean().optional(), timeout_ms: positiveInt.max(30000).optional() }),
  op({ operation: z.literal('action'), ...uiRoot, target: targetSchema, action: z.literal('click'), allow_fallback: z.literal(true), timeout_ms: positiveInt.max(30000).optional() }),
  op({ operation: z.literal('action'), ...uiRoot, target: targetSchema, action: z.literal('key'), virtual_key: nonNegativeInt.max(255), allow_fallback: z.literal(true), timeout_ms: positiveInt.max(30000).optional() })
]);

const recipeFsRead = z.strictObject({ path: z.string(), offset: nonNegativeInt.optional(), limit: positiveInt.optional(), encoding: z.string().optional() });
const recipeFsWrite = z.strictObject({ path: z.string(), data: z.string(), expected_sha256: expectedSha });
const recipeFsPatch = z.strictObject({ path: z.string(), replacements, expected_sha256: expectedSha });
const recipeTaskSubmit = z.union([z.strictObject({ job: jobSpec }), z.strictObject({ jobs: z.array(jobSpec).min(1).max(64) })]);
const recipeStep = z.discriminatedUnion('primitive', [
  z.strictObject({ primitive: z.literal('machine.exec'), input: execSpec }),
  z.strictObject({ primitive: z.literal('fs.read'), input: recipeFsRead }),
  z.strictObject({ primitive: z.literal('fs.write'), input: recipeFsWrite }),
  z.strictObject({ primitive: z.literal('fs.patch'), input: recipeFsPatch }),
  z.strictObject({ primitive: z.literal('task.submit'), input: recipeTaskSubmit })
]);
const recipeInput = z.union([
  op({ operation: z.literal('create'), name: z.string().min(1).max(80), description: z.string().optional(), steps: z.array(recipeStep).min(1).max(50) }),
  op({ operation: z.literal('list') }),
  op({ operation: z.literal('get'), name: z.string().min(1) }),
  op({ operation: z.literal('stats'), name: z.string().min(1) }),
  op({ operation: z.literal('run'), name: z.string().min(1), params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }),
  op({ operation: z.literal('delete'), name: z.string().min(1) }),
  op({ operation: z.literal('suggest'), threshold: positiveInt.optional(), min_length: positiveInt.optional() })
]);

const scatterCall = shape => z.strictObject({ ...shape, dependencies });
const scatterString = fromFuture(z.string());
const scatterNonEmptyString = fromFuture(z.string().min(1));
const scatterPositiveInt = fromFuture(positiveInt);
const scatterNonNegativeInt = fromFuture(nonNegativeInt);
const scatterExpectedSha = fromFuture(z.union([z.string().regex(/^[a-f0-9]{64}$/i), z.null()])).optional();
const scatterExec = {
  command: scatterNonEmptyString,
  args: fromFuture(z.array(scatterString).max(256)).optional(),
  cwd: scatterString.optional(),
  env: fromFuture(z.record(z.string(), scatterString)).optional(),
  timeout_ms: fromFuture(positiveInt.max(300000)).optional()
};
const scatterReplacements = fromFuture(z.array(z.strictObject({ old: scatterString, new: scatterString })).max(128));
const scatterTarget = fromFuture(z.strictObject({
  automation_id: scatterString.optional(), name: scatterString.optional(), control_type: scatterString.optional()
}));
const scatterParams = fromFuture(z.record(z.string(), fromFuture(z.union([z.string(), z.number(), z.boolean()]))));
const scatterAction = z.discriminatedUnion('kind', [
  scatterCall({ kind: z.literal('machine.host_info') }),
  scatterCall({ kind: z.literal('machine.process_list') }),
  scatterCall({ kind: z.literal('machine.exec'), ...scatterExec }),
  scatterCall({ kind: z.literal('fs.list'), path: scatterString, limit: fromFuture(positiveInt.max(1000)).optional() }),
  scatterCall({ kind: z.literal('fs.stat'), path: scatterString }),
  scatterCall({ kind: z.literal('fs.read'), path: scatterString, offset: scatterNonNegativeInt.optional(), limit: scatterPositiveInt.optional(), encoding: scatterString.optional() }),
  scatterCall({ kind: z.literal('fs.search'), path: scatterString, query: scatterString, limit: fromFuture(positiveInt.max(1000)).optional(), max_entries: fromFuture(positiveInt.max(50000)).optional() }),
  scatterCall({ kind: z.literal('fs.write'), path: scatterString, data: scatterString, expected_sha256: scatterExpectedSha }),
  scatterCall({ kind: z.literal('fs.patch'), path: scatterString, replacements: scatterReplacements, expected_sha256: scatterExpectedSha }),
  scatterCall({ kind: z.literal('fs.undo'), receipt_id: scatterNonEmptyString }),
  scatterCall({ kind: z.literal('artifact.list'), limit: fromFuture(positiveInt.max(100)).optional() }),
  scatterCall({ kind: z.literal('artifact.metadata'), id: scatterNonEmptyString }),
  scatterCall({ kind: z.literal('artifact.read'), id: scatterNonEmptyString, offset: scatterNonNegativeInt.optional(), limit: scatterPositiveInt.optional(), encoding: scatterString.optional() }),
  scatterCall({ kind: z.literal('artifact.search'), id: scatterNonEmptyString, query: scatterString, limit: fromFuture(positiveInt.max(1000)).optional() }),
  scatterCall({ kind: z.literal('task.get'), id: scatterNonEmptyString }),
  scatterCall({ kind: z.literal('task.status'), id: scatterNonEmptyString }),
  scatterCall({ kind: z.literal('task.list'), limit: fromFuture(positiveInt.max(100)).optional() }),
  scatterCall({ kind: z.literal('run.get'), id: scatterNonEmptyString }),
  scatterCall({ kind: z.literal('run.list'), limit: fromFuture(positiveInt.max(100)).optional() }),
  scatterCall({ kind: z.literal('run.events'), limit: fromFuture(positiveInt.max(1000)).optional(), entity_id: scatterString.optional() }),
  scatterCall({ kind: z.literal('ui.query'), process_id: scatterPositiveInt.optional(), hwnd: scatterNonNegativeInt.optional(), target: scatterTarget, max_depth: fromFuture(nonNegativeInt.max(12)).optional(), max_nodes: fromFuture(positiveInt.max(5000)).optional(), timeout_ms: fromFuture(positiveInt.max(30000)).optional() }),
  scatterCall({ kind: z.literal('ui.action'), process_id: scatterPositiveInt.optional(), hwnd: scatterNonNegativeInt.optional(), target: scatterTarget, action: z.enum(['invoke','focus']), allow_fallback: fromFuture(z.boolean()).optional(), timeout_ms: fromFuture(positiveInt.max(30000)).optional() }),
  scatterCall({ kind: z.literal('recipe.run'), name: scatterNonEmptyString, params: scatterParams.optional() })
]);
const continuationTarget = z.union([z.strictObject({ session: z.string().min(1) }), z.strictObject({ browser_tab: z.string().min(1) })]);
const runInput = z.union([
  op({ operation: z.literal('scatter'), calls: z.array(scatterAction).min(1).max(64).describe('Closed heterogeneous envelope. Each kind maps to a known Hearth primitive and runs as a future.') }),
  op({ operation: z.literal('checkpoint'), id: z.string().min(1).optional().describe('Existing durable run ID to update; omit only when creating a new run.'), objective: z.string().optional(), acceptance_criteria: z.array(z.string()).optional(), summary: z.string().optional(), next_actions: z.array(z.string()).optional(), pending_task_ids: z.array(z.string()).optional() }),
  op({ operation: z.literal('list'), limit: positiveInt.max(100).optional() }),
  op({ operation: z.literal('get'), id: z.string().min(1) }),
  op({ operation: z.literal('close'), id: z.string().min(1) }),
  op({ operation: z.literal('schedule_continuation'), run_id: z.string().min(1), delay_ms: nonNegativeInt.optional(), run_at: z.string().optional(), target: continuationTarget.optional(), prompt: z.string().optional() }),
  op({ operation: z.literal('continuation_status'), id: z.string().min(1) }),
  op({ operation: z.literal('events'), limit: positiveInt.max(1000).optional(), entity_id: z.string().optional() })
]);

const toolSpecs = {
  machine: { description: 'Local host/process operations. exec uses command + argv; no shell parsing. Add detach:true to get a future immediately.', inputSchema: machineInput },
  fs: { description: 'Contained filesystem operations with SHA-256 CAS and undo. write uses data (not content). Unknown fields are rejected.', inputSchema: fsInput },
  task: { description: 'Durable delayed/dependent executable jobs. submit accepts job or jobs; use status/get/wait/cancel/list afterward only when needed.', inputSchema: taskInput },
  artifact: { description: 'Read-only metadata/range/search for large outputs spilled by Hearth.', inputSchema: artifactInput, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  ui: { description: 'Windows UI Automation. Prefer query + semantic action (invoke/focus/set_value); physical click/key requires allow_fallback:true and a scoped process/hwnd.', inputSchema: uiInput },
  recipe: { description: 'Bounded declarative reusable workflows over a closed primitive set, plus stats/traces/suggestions.', inputSchema: recipeInput },
  run: { description: 'Durable work checkpoints/continuations plus scatter: a closed typed heterogeneous future envelope. checkpoint updates with id; unknown fields are rejected.', inputSchema: runInput }
};

const fingerprint = value => createHash('sha256').update(value).digest('hex');

export function normalizeRouting(meta = {}, requestId, fallbackSeed = randomUUID()) {
  const openaiSession = typeof meta['openai/session'] === 'string' && meta['openai/session'].trim() && meta['openai/session'].length <= 4096 ? meta['openai/session'] : null;
  const localConversation = typeof meta['hearth/conversation'] === 'string' && meta['hearth/conversation'].trim() && meta['hearth/conversation'].length <= 4096 ? meta['hearth/conversation'] : null;
  const full = typeof requestId === 'string' ? requestId.trim() : '';
  const prefix = full ? full.split('/', 1)[0].trim() : '';
  return {
    conversation_key: openaiSession ? `openai:${fingerprint(openaiSession)}` : `local:${fingerprint(`hearth-local\0${localConversation || fallbackSeed}`)}`,
    source: openaiSession ? 'openai' : 'local',
    ...(prefix && { turn_key: fingerprint(prefix) }),
    ...(full && { request_key: fingerprint(full) })
  };
}

export function createHandler(hearth) {
  return createMcpHandler(({ requestInfo }) => {
    const requestId = requestInfo?.headers.get('x-request-id'); const requestFallback = randomUUID();
    const server = new McpServer(
      { name: 'hearth', version: '0.1.0' },
      { capabilities: { tools: {} }, instructions: 'Local-first Windows operation. Prefer detached futures and arrival piggybacking over polling. All results expose explicit state.' }
    );
    for (const [name, spec] of Object.entries(toolSpecs)) {
      server.registerTool(name, spec, (input, ctx) => hearth.dispatch(name, input, normalizeRouting(ctx.mcpReq._meta, requestId, ctx.sessionId || requestFallback)));
    }
    return server;
  });
}

export async function start(configFile) {
  const hearth = await new Hearth(await loadConfig(configFile)).init();
  const handler = createHandler(hearth); const nodeHandler = toNodeHandler(handler);
  const hostGuard = localhostHostValidation(); const originGuard = localhostOriginValidation();
  const http = createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { res.writeHead(400).end(); return; }
    if (pathname !== '/mcp' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    if (!hostGuard(req, res) || !originGuard(req, res)) return;
    void nodeHandler(req, res);
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(hearth.config.port, hearth.config.host, resolve); });
  const close = async () => { await new Promise(resolve => http.close(resolve)); await handler.close(); await hearth.close(); };
  return { hearth, handler, http, close, address: `http://${hearth.config.host}:${hearth.config.port}/mcp` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runtime = await start(process.env.HEARTH_CONFIG);
  console.log(`Hearth listening at ${runtime.address}`);
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await runtime.close(); };
  process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
}
