import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Hearth, loadConfig } from '../src/hearth.js';
import { createHandler, normalizeRouting, start } from '../src/server.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { listCdpTargets, safeChatUrl, sendChatPrompt, targetContains } from '../src/cdp.js';

const waitFor = async (fn, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('timed out waiting for condition');
};

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hearth-test-'));
  const root = path.join(base, 'root'); const data = path.join(base, 'data'); await mkdir(root);
  const config = { host: '127.0.0.1', port: 0, data_dir: data, roots: [root], command_timeout_ms: 5000, max_output_bytes: 1024, artifact_preview_bytes: 100, max_artifact_bytes: 1024 * 1024, max_concurrent_jobs: 4, recipe_max_steps: 20, dispatch_inline_budget_ms: 100, mailbox_max_arrivals: 16, mailbox_max_bytes: 32768, future_result_inline_bytes: 16384, max_concurrent_futures: 4, future_input_max_bytes: 262144, oracle: { command: 'oracle.cmd', armed: false }, wake: { armed: false, cdp_url: 'http://127.0.0.1:9223', quiet_ms: 15000, debounce_ms: 500, cooldown_ms: 60000, max_attempts: 2, probe_ttl_ms: 600000, probe_interval_ms: 2000, timeout_ms: 120000 } };
  const hearth = await new Hearth(config).init();
  t.after(async () => { if (hearth.db) await hearth.close(); await rm(base, { recursive: true, force: true }); });
  return { hearth, base, root, data, config };
}

function clientFor(handler, name) {
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) });
  const client = new Client({ name, version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  return { client, transport };
}

function structured(result) {
  return result.structuredContent || JSON.parse(result.content[0].text);
}

test('modern MCP discovery exposes exactly seven tools and concurrent calls share state', async t => {
  const { hearth } = await fixture(t); const handler = createHandler(hearth); t.after(() => handler.close());
  const a = clientFor(handler, 'a'); const b = clientFor(handler, 'b');
  await Promise.all([a.client.connect(a.transport), b.client.connect(b.transport)]);
  t.after(() => Promise.all([a.client.close(), b.client.close()]));
  assert.equal(a.client.getProtocolEra(), 'modern');
  assert.equal(a.client.getNegotiatedProtocolVersion(), '2026-07-28');
  const discovery = await a.client.discover(); assert(discovery.supportedVersions.includes('2026-07-28'));
  const names = (await a.client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['artifact','fs','machine','recipe','run','task','ui']);
  const results = await Promise.all([a.client.callTool({ name: 'machine', arguments: { operation: 'host_info' } }), b.client.callTool({ name: 'machine', arguments: { operation: 'host_info' } })]);
  assert(results.every(value => structured(value).state === 'completed'));
});

test('MCP schemas reject unknown fields and expose a closed scatter envelope', async t => {
  const { hearth, root } = await fixture(t); const handler = createHandler(hearth); t.after(() => handler.close());
  const c = clientFor(handler, 'schema-test'); await c.client.connect(c.transport); t.after(() => c.client.close());
  const tools = Object.fromEntries((await c.client.listTools()).tools.map(tool => [tool.name, tool]));
  const fsVariants = tools.fs.inputSchema.anyOf || tools.fs.inputSchema.oneOf || [tools.fs.inputSchema]; assert(fsVariants.every(variant => variant.additionalProperties === false));
  assert.match(JSON.stringify(tools.fs.inputSchema), /\"data\"/);
  const runSchema = JSON.stringify(tools.run.inputSchema); assert.match(runSchema, /machine\.host_info/); assert.match(runSchema, /fs\.stat/); assert.match(runSchema, /task\.list/); assert.match(runSchema, /run\.events/); assert.match(runSchema, /\$future/); assert(!runSchema.includes('\"tool\"'));
  const badFile = path.join(root, 'bad.txt'); let rejected = false;
  try { const result = await c.client.callTool({ name: 'fs', arguments: { operation: 'write', path: badFile, content: 'must-not-write' } }); rejected = Boolean(result.isError); } catch { rejected = true; }
  assert.equal(rejected, true); await assert.rejects(() => readFile(badFile));
  rejected = false; try { const result = await c.client.callTool({ name: 'run', arguments: { operation: 'checkpoint', run_id: 'wrong-field', objective: 'x' } }); rejected = Boolean(result.isError); } catch { rejected = true; }
  assert.equal(rejected, true);
});

test('MCP closed scatter accepts typed future references and executes the dependency DAG', async t => {
  const { hearth, root } = await fixture(t); const file = path.join(root, 'scatter-ref.txt'); await writeFile(file, 'scatter-ref');
  const handler = createHandler(hearth); t.after(() => handler.close());
  const c = clientFor(handler, 'scatter-ref-schema'); await c.client.connect(c.transport); t.after(() => c.client.close());
  const first = structured(await c.client.callTool({ name: 'run', arguments: { operation: 'scatter', calls: [
    { kind: 'fs.stat', path: file },
    { kind: 'fs.read', path: { $future: 0, $path: 'result.path' } }
  ] } }));
  assert.equal(first.state, 'pending'); assert.equal(first.futures.length, 2);
  await waitFor(() => first.futures.every(item => ['completed','blocked'].includes(hearth.db.prepare('SELECT state FROM futures WHERE id=?').get(item.id)?.state)));
  const dependency = hearth.db.prepare('SELECT state,result,error FROM futures WHERE id=?').get(first.futures[1].id);
  assert.equal(dependency.state, 'completed', dependency.error || 'dependent future should complete');
  assert.equal(JSON.parse(dependency.result).data, 'scatter-ref');
});

test('localhost /mcp serves modern discovery and rejects foreign Origin', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hearth-http-')); const root = path.join(base, 'root'); await mkdir(root);
  const configFile = path.join(base, 'config.json');
  await writeFile(configFile, JSON.stringify({ host: '127.0.0.1', port: 0, data_dir: path.join(base, 'data'), roots: [root] }));
  const runtime = await start(configFile); t.after(async () => { await runtime.close(); await rm(base, { recursive: true, force: true }); });
  const url = new URL(`http://127.0.0.1:${runtime.http.address().port}/mcp`);
  const client = new Client({ name: 'socket-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport = new StreamableHTTPClientTransport(url); await client.connect(transport); t.after(() => client.close());
  assert((await client.discover()).supportedVersions.includes('2026-07-28'));
  const rejected = await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(rejected.status, 403);
});

test('filesystem confines paths, detects conflicts, writes atomically, and undoes', async t => {
  const { hearth, root, base } = await fixture(t); const file = path.join(root, 'note.txt');
  const written = await hearth.fsTool({ operation: 'write', path: file, data: 'one', expected_sha256: null });
  assert.equal(written.state, 'completed');
  assert.equal((await hearth.fsTool({ operation: 'write', path: file, data: 'bad', expected_sha256: 'wrong' })).state, 'conflict');
  const patched = await hearth.fsTool({ operation: 'patch', path: file, expected_sha256: written.sha256, replacements: [{ old: 'one', new: 'two' }] });
  assert.equal(await readFile(file, 'utf8'), 'two');
  assert.equal((await hearth.fsTool({ operation: 'undo', receipt_id: patched.receipt.id })).state, 'completed');
  assert.equal(await readFile(file, 'utf8'), 'one');
  const concurrent = await Promise.all([hearth.fsTool({ operation: 'patch', path: file, replacements: [{ old: 'one', new: 'A' }] }), hearth.fsTool({ operation: 'patch', path: file, replacements: [{ old: 'one', new: 'B' }] })]);
  assert.deepEqual(concurrent.map(value => value.state).sort(), ['completed','conflict']);
  assert.match(await readFile(file, 'utf8'), /^(A|B)$/);
  const outside = path.join(base, 'outside'); await mkdir(outside);
  try { await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); assert.rejects(() => hearth.fsTool({ operation: 'write', path: path.join(root, 'escape', 'x'), data: 'x' }), /symlink/); } catch (error) { if (!['EPERM','UNKNOWN'].includes(error.code)) throw error; }
});

test('large output spills to a searchable and ranged artifact with a hard cap', async t => {
  const { hearth } = await fixture(t);
  const result = await hearth.machine({ operation: 'exec', command: process.execPath, args: ['-e', "process.stdout.write('A'.repeat(3000)+'NEEDLE')"] });
  assert.equal(result.state, 'completed'); assert(result.artifact?.id); assert.equal(result.preview.length <= 110, true);
  const found = await hearth.artifact({ operation: 'search', id: result.artifact.id, query: 'NEEDLE' }); assert.equal(found.matches.length, 1);
  const ranged = await hearth.artifact({ operation: 'range', id: result.artifact.id, offset: 2990, limit: 30 }); assert.match(ranged.data, /NEEDLE/);
  hearth.config.max_artifact_bytes = 1000;
  const capped = await hearth.exec({ command: process.execPath, args: ['-e', "process.stdout.write('X'.repeat(10000))"] }, { inlineLimit: 10 });
  assert.equal(capped.output_truncated, true); assert(capped.artifact.size <= 1000);
  const marker = path.join(hearth.config.roots[0], 'child-survived.txt');
  const timed = await hearth.exec({ command: process.execPath, args: ['-e', "require('node:child_process').spawn(process.execPath,['-e',`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),500)`]);setInterval(()=>{},1000)"], timeout_ms: 100 });
  assert.equal(timed.timed_out, true); await new Promise(resolve => setTimeout(resolve, 700)); assert.rejects(() => readFile(marker));
});

test('filesystem serializes concurrent patch computation and undo checks', async t => {
  const { hearth, root } = await fixture(t); const file = path.join(root, 'race.txt');
  const written = await hearth.fsTool({ operation: 'write', path: file, data: 'x', expected_sha256: null });
  const [first, second] = await Promise.all([
    hearth.fsTool({ operation: 'patch', path: file, expected_sha256: written.sha256, replacements: [{ old: 'x', new: 'a' }] }),
    hearth.fsTool({ operation: 'patch', path: file, expected_sha256: written.sha256, replacements: [{ old: 'x', new: 'b' }] })
  ]);
  assert.deepEqual([first.state, second.state].sort(), ['completed', 'conflict']);
  const done = first.state === 'completed' ? first : second;
  const undo = hearth.fsTool({ operation: 'undo', receipt_id: done.receipt.id });
  const write = hearth.fsTool({ operation: 'write', path: file, data: 'later', expected_sha256: done.sha256 });
  assert.deepEqual((await Promise.all([undo, write])).map(result => result.state), ['completed', 'conflict']);
  assert.equal(await readFile(file, 'utf8'), 'x');
});
test('filesystem retries transient atomic replace failures for mutation and undo', async t => {
  const { hearth, root } = await fixture(t); const file = path.join(root, 'rename-retry.txt'); await writeFile(file, 'before');
  const realRename = hearth.renameFile.bind(hearth);
  const inject = count => {
    let remaining = count; let attempts = 0;
    hearth.renameFile = async (...args) => { attempts++; if (remaining-- > 0) { const error = new Error('transient file lock'); error.code = 'EPERM'; throw error; } return realRename(...args); };
    return () => attempts;
  };
  const mutationAttempts = inject(2);
  const changed = await hearth.fsTool({ operation: 'patch', path: file, replacements: [{ old: 'before', new: 'after' }] });
  assert.equal(changed.state, 'completed'); assert.equal(changed.replace_attempts, 3); assert.equal(mutationAttempts(), 3); assert.equal(await readFile(file, 'utf8'), 'after');
  const undoAttempts = inject(1);
  const undone = await hearth.fsTool({ operation: 'undo', receipt_id: changed.receipt.id });
  assert.equal(undone.state, 'completed'); assert.equal(undone.replace_attempts, 2); assert.equal(undoAttempts(), 2); assert.equal(await readFile(file, 'utf8'), 'before');
});

test('durable delayed and dependent tasks return immediately, run concurrently, and recover', async t => {
  const { hearth, root, config } = await fixture(t);
  const start = Date.now();
  const submitted = await hearth.task({ operation: 'submit', jobs: [
    { command: process.execPath, args: ['-e', "setTimeout(()=>console.log('first'),120)"], delay_ms: 80 },
    { command: process.execPath, args: ['-e', "setTimeout(()=>console.log('parallel'),120)"], delay_ms: 80 },
    { command: process.execPath, args: ['-e', "console.log('dependent')"], dependencies: [0] }
  ] });
  assert.equal(submitted.state, 'pending'); assert(Date.now() - start < 100);
  const [one, two, three] = submitted.jobs.map(j => j.id);
  await waitFor(async () => (await hearth.task({ operation: 'get', id: one })).state === 'running' && (await hearth.task({ operation: 'get', id: two })).state === 'running');
  await waitFor(async () => (await hearth.task({ operation: 'get', id: three })).state === 'completed');
  await assert.rejects(() => hearth.task({ operation: 'submit', jobs: [{ command: process.execPath, dependencies: [4] }] }), /invalid batch dependency/);
  await assert.rejects(() => hearth.task({ operation: 'submit', jobs: [
    { command: process.execPath, dependencies: [1] }, { command: process.execPath, dependencies: [0] }
  ] }), /cyclic batch dependencies/);
  const futureId = 'late-bound-future';
  const missing = await hearth.task({ operation: 'submit', job: { command: process.execPath, args: ['-e', "console.log('after future')"], dependencies: [futureId] } });
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal((await hearth.task({ operation: 'get', id: missing.jobs[0].id })).state, 'queued');
  const created = new Date().toISOString();
  hearth.db.prepare('INSERT INTO jobs(id,at,updated_at,state,run_at,spec,dependencies,result) VALUES(?,?,?,?,?,?,?,?)').run(futureId, created, created, 'completed', created, '{}', '[]', '{}');
  const lateDone = await waitFor(async () => { const value = await hearth.task({ operation: 'get', id: missing.jobs[0].id }); return value.state === 'completed' ? value : null; }); assert.match(lateDone.result.output, /after future/);
  const failedDependency = 'failed-future';
  const blocked = await hearth.task({ operation: 'submit', job: { command: process.execPath, dependencies: [failedDependency] } });
  hearth.db.prepare('INSERT INTO jobs(id,at,updated_at,state,run_at,spec,dependencies,error) VALUES(?,?,?,?,?,?,?,?)').run(failedDependency, created, created, 'blocked', created, '{}', '[]', 'failed');
  const blockedDone = await waitFor(async () => { const value = await hearth.task({ operation: 'get', id: blocked.jobs[0].id }); return value.state === 'blocked' ? value : null; }); assert.match(blockedDone.error, /dependency/);
  const cancelled = await hearth.task({ operation: 'submit', job: { command: process.execPath, args: ['-e', "require('node:fs').writeFileSync(process.argv[1],'ran')", path.join(root, 'cancelled.txt')], delay_ms: 200 } });
  assert.equal((await hearth.task({ operation: 'cancel', id: cancelled.jobs[0].id })).state, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 300)); assert.rejects(() => readFile(path.join(root, 'cancelled.txt')));
  const survivor = await hearth.task({ operation: 'submit', job: { command: process.execPath, args: ['-e', "console.log('recovered')"], delay_ms: 300 } });
  clearInterval(hearth.timer); hearth.timer = null; hearth.event('runtime.stopped', null, {}); hearth.db.close(); hearth.db = null;
  const restarted = await new Hearth(config).init();
  try { const done = await waitFor(async () => { const value = await restarted.task({ operation: 'get', id: survivor.jobs[0].id }); return value.state === 'completed' ? value : null; }); assert.match(done.result.output, /recovered/); } finally { await restarted.close(); }
});

test('slow dispatch detaches and completion piggybacks with route isolation and completion order', async t => {
  const { hearth } = await fixture(t); hearth.config.dispatch_inline_budget_ms = 5; const original = hearth.executePrimitive.bind(hearth); const gates = new Map();
  hearth.executePrimitive = (tool, input, routing) => input.operation === 'controlled' ? new Promise((resolve, reject) => gates.set(input.name, { resolve, reject })) : original(tool, input, routing);
  const routeA = { conversation_key: 'test:a', source: 'local' }; const routeB = { conversation_key: 'test:b', source: 'local' };
  const startedAt = Date.now(); const one = structured(await hearth.dispatch('machine', { operation: 'controlled', name: 'one' }, routeA)); const two = structured(await hearth.dispatch('machine', { operation: 'controlled', name: 'two' }, routeA));
  assert.equal(one.state, 'pending'); assert.equal(two.state, 'pending'); assert(Date.now() - startedAt < 250);
  gates.get('two').resolve({ state: 'completed', value: 2 }); await waitFor(() => hearth.db.prepare('SELECT mailbox_seq FROM futures WHERE id=?').get(two.future_id)?.mailbox_seq);
  assert.deepEqual(structured(await hearth.dispatch('machine', { operation: 'host_info' }, routeB)).arrivals, []);
  const first = structured(await hearth.dispatch('machine', { operation: 'host_info' }, routeA)); assert.equal(first.arrivals[0].future_id, two.future_id);
  gates.get('one').resolve({ state: 'completed', value: 1 }); await waitFor(() => hearth.db.prepare('SELECT mailbox_seq FROM futures WHERE id=?').get(one.future_id)?.mailbox_seq);
  const second = structured(await hearth.dispatch('machine', { operation: 'host_info' }, routeA)); assert.equal(second.arrivals[0].future_id, one.future_id); assert(second.arrivals[0].seq > first.arrivals[0].seq);
});

test('same turn retries re-offer the prior cursor before a new turn acknowledges it', async t => {
  const { hearth } = await fixture(t); const route = { conversation_key: 'test:retry', source: 'local', turn_key: 'turn-one' }; hearth.ensureMailbox(route); const at = new Date().toISOString();
  hearth.db.prepare("INSERT INTO futures(id,route_key,kind,tool,dependencies,state,detached,at,updated_at,completed_at,result,mailbox_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run('retry-future', route.conversation_key, 'generic', 'machine', '[]', 'completed', 1, at, at, at, '{"state":"completed"}', 1);
  const first = structured(await hearth.dispatch('machine', { operation: 'host_info' }, route)); assert.equal(first.arrivals[0].future_id, 'retry-future');
  const retry = structured(await hearth.dispatch('machine', { operation: 'host_info' }, route)); assert.equal(retry.arrivals[0].future_id, 'retry-future'); assert.equal(retry.arrivals[0].seq, first.arrivals[0].seq);
  const next = structured(await hearth.dispatch('machine', { operation: 'host_info' }, { ...route, turn_key: 'turn-two' })); assert.deepEqual(next.arrivals, []);
});

test('same turn distinct request keys acknowledge the prior offer', async t => {
  const { hearth } = await fixture(t); const base = { conversation_key: 'test:req-key', source: 'local', turn_key: 'same-turn' }; hearth.ensureMailbox(base); const at = new Date().toISOString();
  hearth.db.prepare("INSERT INTO futures(id,route_key,kind,tool,dependencies,state,detached,at,updated_at,completed_at,result,mailbox_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run('request-key-future', base.conversation_key, 'generic', 'machine', '[]', 'completed', 1, at, at, at, '{\"state\":\"completed\"}', 1);
  const first = structured(await hearth.dispatch('machine', { operation: 'host_info' }, { ...base, request_key: 'request-a' })); assert.equal(first.arrivals.length, 1);
  const second = structured(await hearth.dispatch('machine', { operation: 'host_info' }, { ...base, request_key: 'request-b' })); assert.deepEqual(second.arrivals, []);
});

test('mailbox bounds arrivals and spills oversized detached JSON to artifact', async t => {
  const { hearth } = await fixture(t); hearth.config.dispatch_inline_budget_ms = 2; hearth.config.mailbox_max_arrivals = 1; hearth.config.mailbox_max_bytes = 900; hearth.config.future_result_inline_bytes = 256;
  const original = hearth.executePrimitive.bind(hearth); const gates = [];
  hearth.executePrimitive = (tool, input, routing) => input.operation === 'controlled' ? new Promise(resolve => gates.push(resolve)) : original(tool, input, routing);
  const route = { conversation_key: 'test:bounded', source: 'local' };
  const a = structured(await hearth.dispatch('machine', { operation: 'controlled' }, route)); const b = structured(await hearth.dispatch('machine', { operation: 'controlled' }, route));
  gates[0]({ state: 'completed', body: '界'.repeat(1000) }); await waitFor(() => hearth.db.prepare('SELECT mailbox_seq FROM futures WHERE id=?').get(a.future_id)?.mailbox_seq); gates[1]({ state: 'completed', value: 'small' });
  await waitFor(() => hearth.db.prepare('SELECT COUNT(*) AS n FROM futures WHERE route_key=? AND mailbox_seq IS NOT NULL').get(route.conversation_key).n === 2);
  const first = structured(await hearth.dispatch('machine', { operation: 'host_info' }, route)); assert.equal(first.arrivals.length, 1); assert(first.arrivals[0].result.artifact?.id); assert.equal(first.arrivals[0].result.artifact.media_type, 'application/json'); assert(Buffer.byteLength(JSON.stringify(first.arrivals)) <= 900);
  hearth.config.max_output_bytes = 5000; const body = await hearth.artifact({ operation: 'read', id: first.arrivals[0].result.artifact.id, limit: 5000 }); assert.deepEqual(JSON.parse(body.data), { state: 'completed', body: '界'.repeat(1000) });
  const second = structured(await hearth.dispatch('machine', { operation: 'host_info' }, route)); assert.equal(second.arrivals.length, 1); assert.equal(second.arrivals[0].future_id, b.future_id);
  assert.notEqual(a.future_id, b.future_id);
});

test('heterogeneous task calls start concurrently and resolve future references and failures', async t => {
  const { hearth, root } = await fixture(t); const route = { conversation_key: 'test:dag', source: 'local' }; const original = hearth.executePrimitive.bind(hearth); const started = []; const gates = new Map();
  hearth.executePrimitive = (tool, input, routing) => input.operation === 'controlled' ? (started.push(input.name), new Promise((resolve, reject) => gates.set(input.name, { resolve, reject }))) : original(tool, input, routing);
  const submitted = await hearth.task({ operation: 'submit', calls: [
    { tool: 'machine', input: { operation: 'controlled', name: 'a' } },
    { tool: 'fs', input: { operation: 'controlled', name: 'b' } }
  ] }, route);
  assert.equal(submitted.state, 'pending'); await waitFor(() => started.length === 2); assert.deepEqual(started.sort(), ['a','b']); gates.get('a').resolve({ state: 'completed', path: root }); gates.get('b').resolve({ state: 'completed' });
  await waitFor(() => submitted.futures.every(({ id }) => hearth.db.prepare('SELECT state FROM futures WHERE id=?').get(id).state === 'completed'));
  const refs = await hearth.task({ operation: 'submit', calls: [
    { tool: 'machine', input: { operation: 'controlled', name: 'source' } },
    { tool: 'fs', dependencies: [0], input: { operation: 'stat', path: { $future: 0, $path: 'result.path' } } },
    { tool: 'machine', dependencies: ['missing-future'], input: { operation: 'host_info' } }
  ] }, route);
  await waitFor(() => gates.has('source')); gates.get('source').resolve({ state: 'completed', path: root });
  const stat = await waitFor(() => { const row = hearth.db.prepare('SELECT state,result FROM futures WHERE id=?').get(refs.futures[1].id); return row.state === 'completed' && JSON.parse(row.result); }); assert.equal(stat.type, 'directory');
  const blocked = await waitFor(() => { const row = hearth.db.prepare('SELECT state,error FROM futures WHERE id=?').get(refs.futures[2].id); return row.state === 'blocked' && row; }); assert.match(blocked.error, /missing/);
  const failed = await hearth.task({ operation: 'submit', calls: [{ tool: 'machine', input: { operation: 'controlled', name: 'fail' } }, { tool: 'machine', dependencies: [0], input: { operation: 'host_info' } }] }, route);
  await waitFor(() => gates.has('fail')); gates.get('fail').resolve({ state: 'blocked', error: 'nope' }); const dependent = await waitFor(() => { const row = hearth.db.prepare('SELECT state,error FROM futures WHERE id=?').get(failed.futures[1].id); return row.state === 'blocked' && row; }); assert.match(dependent.error, /did not complete/);
  const missingPath = await hearth.task({ operation: 'submit', calls: [{ tool: 'fs', input: { operation: 'stat', path: { $future: refs.futures[0].id, $path: 'result.no_such_path' } } }] }, route); const missingPathRow = await waitFor(() => { const row = hearth.db.prepare('SELECT state,error FROM futures WHERE id=?').get(missingPath.futures[0].id); return row.state === 'blocked' && row; }); assert.match(missingPathRow.error, /path not found/);
  await assert.rejects(() => hearth.task({ operation: 'submit', calls: [{ tool: 'machine', dependencies: [1], input: { operation: 'host_info' } }, { tool: 'machine', dependencies: [0], input: { operation: 'host_info' } }] }, route), /cyclic/);
  await assert.rejects(() => hearth.task({ operation: 'submit', calls: [{ tool: 'task', input: { operation: 'submit', calls: [] } }] }, route), /recursive/);
  const nested = await hearth.task({ operation: 'submit', calls: [{ tool: 'task', input: { operation: 'submit', job: { command: process.execPath, args: ['-e', "console.log('nested durable')"] } } }] }, route);
  const nestedResult = await waitFor(() => { const row = hearth.db.prepare('SELECT state,result FROM futures WHERE id=?').get(nested.futures[0].id); return row.state === 'completed' && JSON.parse(row.result); });
  const nestedJob = nestedResult.jobs[0].id; await waitFor(() => hearth.db.prepare('SELECT state,mailbox_seq FROM futures WHERE id=?').get(nestedJob)?.state === 'completed'); assert(hearth.db.prepare('SELECT mailbox_seq FROM futures WHERE id=?').get(nestedJob).mailbox_seq);
});

test('wide DAG scheduling is fair and generic work starts with durable pool full', async t => {
  const { hearth } = await fixture(t); const route = { conversation_key: 'test:fair', source: 'local' }; const original = hearth.executePrimitive.bind(hearth); const started = [];
  hearth.config.max_concurrent_jobs = 1; hearth.config.max_concurrent_futures = 2;
  const durable = await hearth.task({ operation: 'submit', job: { command: process.execPath, args: ['-e', 'setTimeout(()=>{},1000)'] } }, route); await waitFor(() => hearth.active.has(durable.jobs[0].id));
  hearth.executePrimitive = (tool, input, routing) => input.operation === 'controlled' ? (started.push(input.name), Promise.resolve({ state: 'completed', value: input.name })) : original(tool, input, routing);
  const calls = Array.from({ length: 10 }, (_, index) => index < 9 ? { tool: 'machine', dependencies: [9], input: { operation: 'controlled', name: `dependent-${index}` } } : { tool: 'machine', input: { operation: 'controlled', name: 'source' } });
  const submitted = await hearth.task({ operation: 'submit', calls }, route); await waitFor(() => started.includes('source')); await waitFor(() => submitted.futures.every(item => hearth.db.prepare('SELECT state FROM futures WHERE id=?').get(item.id).state === 'completed'));
  const independent = await hearth.task({ operation: 'submit', calls: [{ tool: 'machine', input: { operation: 'controlled', name: 'independent' } }] }, route); await waitFor(() => started.includes('independent')); await waitFor(async () => (await hearth.task({ operation: 'get', id: independent.futures[0].id }, route)).state === 'completed');
});

test('task routing, generic cancellation, job dependency arrival, and persistence guards', async t => {
  const { hearth } = await fixture(t); const a = { conversation_key: 'test:jobs-a', source: 'local' }; const b = { conversation_key: 'test:jobs-b', source: 'local' };
  const job = await hearth.task({ operation: 'submit', job: { command: process.execPath, delay_ms: 500 } }, a);
  await assert.rejects(() => hearth.task({ operation: 'get', id: job.jobs[0].id }, b), /not found/); await assert.rejects(() => hearth.task({ operation: 'wait', id: job.jobs[0].id, timeout_ms: 10 }, b), /not found/); await assert.rejects(() => hearth.task({ operation: 'cancel', id: job.jobs[0].id }, b), /not found/);
  assert.equal((await hearth.task({ operation: 'list' }, b)).jobs.length, 0);
  const at = new Date().toISOString(); hearth.ensureMailbox(a); hearth.db.prepare("INSERT INTO futures(id,route_key,kind,tool,input,dependencies,state,detached,at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run('queued-dependency', a.conversation_key, 'generic', 'machine', '{}', '[]', 'running', 1, at, at);
  const queued = await hearth.task({ operation: 'submit', calls: [{ tool: 'machine', dependencies: ['queued-dependency'], input: { operation: 'host_info' } }] }, a); const cancelled = await hearth.task({ operation: 'cancel', id: queued.futures[0].id }, a); assert.equal(cancelled.state, 'cancelled'); assert.equal(hearth.db.prepare('SELECT state,mailbox_seq FROM futures WHERE id=?').get(queued.futures[0].id).state, 'cancelled');
  let release; hearth.executePrimitive = () => new Promise(resolve => { release = resolve; }); const running = await hearth.task({ operation: 'submit', calls: [{ tool: 'machine', input: { operation: 'controlled' } }] }, a); await waitFor(() => hearth.futureActive.has(running.futures[0].id)); assert.equal((await hearth.task({ operation: 'cancel', id: running.futures[0].id }, a)).state, 'blocked'); release({ state: 'completed' });
  const dep = 'known-failed'; hearth.db.prepare('INSERT INTO jobs(id,at,updated_at,state,run_at,spec,dependencies,error) VALUES(?,?,?,?,?,?,?,?)').run(dep, at, at, 'blocked', at, '{}', '[]', 'failed'); const dependent = await hearth.task({ operation: 'submit', job: { command: process.execPath, dependencies: [dep] } }, a); await waitFor(() => hearth.db.prepare('SELECT state,mailbox_seq FROM futures WHERE id=?').get(dependent.jobs[0].id).mailbox_seq); assert.equal(hearth.db.prepare('SELECT state FROM futures WHERE id=?').get(dependent.jobs[0].id).state, 'blocked');
  await assert.rejects(() => hearth.task({ operation: 'submit', job: { command: process.execPath, args: ['--password', 'value'] } }), /secret-like/); await assert.rejects(() => hearth.task({ operation: 'submit', job: { command: process.execPath, args: ['--token=value'] } }), /secret-like/); await assert.rejects(() => hearth.task({ operation: 'submit', job: { command: 'x', args: ['x'.repeat(300000)] } }), /too large/);
});

test('recipes reject indirect scatter at create and run time', async t => {
  const { hearth } = await fixture(t); const definition = { description: '', steps: [{ primitive: 'task.submit', input: { calls: [{ tool: 'recipe', input: { operation: 'run', name: 'loop' } }] } }] };
  assert.throws(() => hearth.recipe({ operation: 'create', name: 'loop', steps: definition.steps }), /recursive task scatter/);
  hearth.db.prepare('INSERT INTO recipes(name,at,definition) VALUES(?,?,?)').run('old-loop', new Date().toISOString(), JSON.stringify(definition)); const result = await hearth.recipe({ operation: 'run', name: 'old-loop' }); assert.equal(result.state, 'blocked'); assert.match(result.error, /recursive task scatter/);
});

test('startup reconciles terminal and missing durable job mailbox bridges and stale wake claims', async t => {
  const { hearth, config } = await fixture(t); const route = { conversation_key: 'test:reconcile', source: 'local' }; hearth.ensureMailbox(route); const at = new Date().toISOString();
  hearth.db.prepare('INSERT INTO jobs(id,at,updated_at,state,run_at,spec,dependencies,result) VALUES(?,?,?,?,?,?,?,?)').run('terminal-job', at, at, 'completed', at, '{}', '[]', '{"state":"completed","value":1}');
  for (const id of ['terminal-job','missing-job']) hearth.db.prepare("INSERT INTO futures(id,route_key,kind,tool,dependencies,state,detached,at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, route.conversation_key, 'job', 'machine', '[]', 'running', 1, at, at);
  hearth.db.prepare('UPDATE mailboxes SET wake_claimed_at=?,last_wake_at=?,wake_attempts=1 WHERE route_key=?').run(at, at, route.conversation_key); clearInterval(hearth.timer); hearth.timer = null; hearth.db.close(); hearth.db = null;
  const restarted = await new Hearth(config).init(); try { assert.equal(restarted.db.prepare('SELECT state FROM futures WHERE id=?').get('terminal-job').state, 'completed'); assert.equal(restarted.db.prepare('SELECT state FROM futures WHERE id=?').get('missing-job').state, 'blocked'); const mailbox = restarted.db.prepare('SELECT wake_claimed_at,wake_due_at FROM mailboxes WHERE route_key=?').get(route.conversation_key); assert.equal(mailbox.wake_claimed_at, null); assert(Date.parse(mailbox.wake_due_at) > Date.now()); } finally { await restarted.close(); }
});

test('config clamps wake controls and rejects truthy non-boolean arming', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hearth-config-')); const root = path.join(base, 'root'); await mkdir(root); const file = path.join(base, 'config.json'); t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(file, JSON.stringify({ roots: [root], oracle: { armed: 'false' }, wake: { armed: false } })); await assert.rejects(() => loadConfig(file), /must be booleans/);
  await writeFile(file, JSON.stringify({ roots: [root], wake: { quiet_ms: 0, debounce_ms: -1, cooldown_ms: 0, max_attempts: 99, probe_ttl_ms: 1, probe_interval_ms: 1, timeout_ms: 1 } })); const config = await loadConfig(file); assert.deepEqual([config.wake.quiet_ms,config.wake.debounce_ms,config.wake.cooldown_ms,config.wake.max_attempts,config.wake.probe_ttl_ms,config.wake.probe_interval_ms,config.wake.timeout_ms], [100,0,1000,10,1000,100,1000]);
});

test('graceful close awaits detached future and active durable job persistence', async t => {
  const { hearth, data } = await fixture(t); hearth.config.dispatch_inline_budget_ms = 2; let release; hearth.executePrimitive = () => new Promise(resolve => { release = resolve; }); const pending = structured(await hearth.dispatch('machine', { operation: 'controlled' }, { conversation_key: 'test:close', source: 'local' }));
  hearth.executePrimitive = Hearth.prototype.executePrimitive.bind(hearth); const route = { conversation_key: 'test:close-job', source: 'local' }; const submitted = await hearth.task({ operation: 'submit', job: { command: process.execPath, args: ['-e', "setTimeout(()=>console.log('closed cleanly'),150)"] } }, route); await waitFor(() => hearth.active.has(submitted.jobs[0].id));
  const closing = hearth.close(); await assert.rejects(() => hearth.task({ operation: 'submit', job: { command: process.execPath } }), /closing/); release({ state: 'completed', value: 1 }); await closing;
  const reopened = new Hearth({ ...hearth.config, data_dir: data }); await reopened.init(); try { assert.equal(reopened.db.prepare('SELECT state,mailbox_seq FROM futures WHERE id=?').get(pending.future_id).state, 'completed'); const job = reopened.db.prepare('SELECT state,result FROM jobs WHERE id=?').get(submitted.jobs[0].id); assert.equal(job.state, 'completed'); assert.match(JSON.parse(job.result).output, /closed cleanly/); const bridge = reopened.db.prepare('SELECT state,mailbox_seq FROM futures WHERE id=?').get(submitted.jobs[0].id); assert.equal(bridge.state, 'completed'); assert(bridge.mailbox_seq); } finally { await reopened.close(); }
});

test('generic interrupted futures block on restart while durable exec jobs recover', async t => {
  const { hearth, config } = await fixture(t); const route = { conversation_key: 'test:restart', source: 'local' }; hearth.ensureMailbox(route); const created = new Date().toISOString();
  hearth.db.prepare("INSERT INTO futures(id,route_key,kind,tool,input,dependencies,state,detached,at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run('interrupted-generic', route.conversation_key, 'generic', 'machine', JSON.stringify({ operation: 'host_info' }), '[]', 'running', 1, created, created);
  const job = await hearth.task({ operation: 'submit', job: { command: process.execPath, args: ['-e', "console.log('durable')"], delay_ms: 300 } }, route);
  clearInterval(hearth.timer); hearth.timer = null; hearth.event('runtime.stopped', null, {}); hearth.db.close(); hearth.db = null;
  const restarted = await new Hearth(config).init();
  try { const generic = restarted.db.prepare('SELECT state,error,mailbox_seq FROM futures WHERE id=?').get('interrupted-generic'); assert.equal(generic.state, 'blocked'); assert(generic.mailbox_seq); const done = await waitFor(async () => { const value = await restarted.task({ operation: 'get', id: job.jobs[0].id }); return value.state === 'completed' ? value : null; }); assert.match(done.result.output, /durable/); }
  finally { await restarted.close(); }
});

test('inline pending task submission exposes an OpenAI route probe', async t => {
  const { hearth } = await fixture(t); const route = { conversation_key: 'openai:inline-probe', source: 'openai' };
  const result = structured(await hearth.dispatch('task', { operation: 'submit', calls: [{ tool: 'machine', input: { operation: 'host_info' } }] }, route));
  assert.equal(result.state, 'pending'); assert.match(result.route_probe.nonce, /^hearth-route:/); assert(Array.isArray(result.arrivals));
});

test('route probe binds only a unique exact ChatGPT target and wake stays disarmed', async t => {
  const { hearth } = await fixture(t); const seen = [];
  hearth.cdp = { listTargets: async () => [{ id: 'target-a', url: 'https://chatgpt.com/c/example', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/a' }, { id: 'target-b', url: 'https://chatgpt.com/c/other', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/b' }], contains: async (target, nonce) => (seen.push([target.id, nonce]), target.id === 'target-a') };
  const route = { conversation_key: 'openai:test-route', source: 'openai' }; hearth.ensureMailbox(route); const probe = hearth.routeProbe(route.conversation_key); assert.match(probe.nonce, /^hearth-route:/);
  await hearth.tickRoutes(); await waitFor(() => hearth.db.prepare('SELECT target_id FROM mailboxes WHERE route_key=?').get(route.conversation_key).target_id === 'target-a');
  const bound = hearth.db.prepare('SELECT target_id,target_url,probe_nonce FROM mailboxes WHERE route_key=?').get(route.conversation_key); assert.deepEqual({ ...bound }, { target_id: 'target-a', target_url: 'https://chatgpt.com/c/example', probe_nonce: null }); assert(seen.every(([, nonce]) => nonce === probe.nonce));
  hearth.db.prepare("INSERT INTO futures(id,route_key,kind,tool,dependencies,state,detached,at,updated_at,completed_at,result,mailbox_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run('ready-wake', route.conversation_key, 'generic', 'machine', '[]', 'completed', 1, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), '{"state":"completed"}', 1);
  hearth.db.prepare('UPDATE mailboxes SET last_activity_at=?,wake_due_at=? WHERE route_key=?').run(new Date(Date.now() - 30000).toISOString(), new Date(Date.now() - 1000).toISOString(), route.conversation_key); await hearth.tickRoutes(); assert.equal(hearth.db.prepare('SELECT wake_attempts FROM mailboxes WHERE route_key=?').get(route.conversation_key).wake_attempts, 0);
});

test('OpenAI routing normalizes fingerprints and persistence excludes raw identifiers', async t => {
  const { hearth, data } = await fixture(t); const raw = { session: 'raw-session-canary', subject: 'raw-subject-canary', organization: 'raw-org-canary', request: 'raw-request-canary/attempt' };
  const normalized = normalizeRouting({ 'openai/session': raw.session, 'openai/subject': raw.subject, 'openai/organization': raw.organization }, raw.request, 'fallback'); assert.match(normalized.conversation_key, /^openai:[a-f0-9]{64}$/); assert.equal(normalized.turn_key.length, 64); assert(!JSON.stringify(normalized).includes('raw-'));
  const handler = createHandler(hearth); t.after(() => handler.close()); const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'routing-test', version: '1' }, 'openai/session': raw.session, 'openai/subject': raw.subject, 'openai/organization': raw.organization };
  const response = await handler.fetch(new Request('http://test.local/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': raw.request, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'machine' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'machine', arguments: { operation: 'host_info' }, _meta: meta } }) })); assert.equal(response.status, 200); await response.text();
  assert(hearth.db.prepare('SELECT route_key FROM mailboxes WHERE route_key=?').get(normalized.conversation_key)); hearth.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const files = await readdir(data, { withFileTypes: true }); const persisted = Buffer.concat(await Promise.all(files.filter(entry => entry.isFile()).map(async entry => await readFile(path.join(data, entry.name))))).toString('latin1'); for (const canary of Object.values(raw)) assert(!persisted.includes(canary));
});

test('route probe failures back off and one stale target does not abort binding', async t => {
  const { hearth } = await fixture(t); const route = { conversation_key: 'openai:probe-backoff', source: 'openai' }; hearth.ensureMailbox(route); const probe = hearth.routeProbe(route.conversation_key); let failList = true; hearth.cdp = { listTargets: async () => { if (failList) throw new Error('offline'); return [{ id: 'stale', url: 'https://chatgpt.com/c/stale' }, { id: 'good', url: 'https://chatgpt.com/c/good' }]; }, contains: async target => { if (target.id === 'stale') throw new Error('gone'); return target.id === 'good'; } };
  await hearth.tickRoutes(); await waitFor(() => !hearth.binding); const next = hearth.db.prepare('SELECT probe_next_at FROM mailboxes WHERE route_key=?').get(route.conversation_key).probe_next_at; assert(Date.parse(next) > Date.now()); hearth.db.prepare('UPDATE mailboxes SET probe_next_at=? WHERE route_key=?').run(new Date(Date.now() - 1).toISOString(), route.conversation_key); failList = false; await hearth.tickRoutes(); await waitFor(() => !hearth.binding); assert.equal(hearth.db.prepare('SELECT target_id FROM mailboxes WHERE route_key=?').get(route.conversation_key).target_id, 'good'); assert(probe.nonce);
});

test('CDP target validation requires stable conversation URLs and safe sockets', async () => {
  const originalFetch = globalThis.fetch; const calls = []; globalThis.fetch = async (url, options) => { calls.push(options); return { ok: true, json: async () => [
    { type: 'page', id: 'ok', url: 'https://chatgpt.com/c/abc-123/?query=gone#hash', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/x' },
    { type: 'page', id: 'root', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/root' },
    { type: 'page', id: 'plugin', url: 'https://chatgpt.com/plugins', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/plugin' },
    { type: 'page', id: 'transient', url: 'https://chatgpt.com/c/WEB:request', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/transient' },
    { type: 'page', id: 'bad-scheme', url: 'https://chatgpt.com/c/y', webSocketDebuggerUrl: 'wss://127.0.0.1:9223/y' },
    { type: 'page', id: 'bad-port', url: 'https://chatgpt.com/c/z', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/z' }
  ] }; };
  try { const targets = await listCdpTargets('http://127.0.0.1:9223'); assert.deepEqual(targets.map(target => target.id), ['ok']); assert.equal(safeChatUrl(targets[0].url), 'https://chatgpt.com/c/abc-123'); for (const url of ['https://chatgpt.com/','https://chatgpt.com/new','https://chatgpt.com/plugins','https://chatgpt.com/g/x/project','https://chatgpt.com/c/WEB:request','https://chatgpt.com:444/c/x']) assert.equal(safeChatUrl(url), null); assert.equal(calls[0].redirect, 'error'); await assert.rejects(() => targetContains({ webSocketDebuggerUrl: 'wss://127.0.0.1:9223/x' }, 'nonce', 'http://127.0.0.1:9223'), /unsafe/); } finally { globalThis.fetch = originalFetch; }
});

test('CDP nonce lookup expands at most one Hearth disclosure before rechecking', async () => {
  const OriginalWebSocket = globalThis.WebSocket; const expressions = [];
  class FakeWebSocket {
    listeners = new Map();
    addEventListener(name, fn) { this.listeners.set(name, fn); if (name === 'open') queueMicrotask(fn); }
    send(body) { const request = JSON.parse(body); expressions.push(request.params.expression); const value = request.id !== 1; queueMicrotask(() => this.listeners.get('message')({ data: JSON.stringify({ id: request.id, result: { result: { value } } }) })); }
    close() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  try { assert.equal(await targetContains({ webSocketDebuggerUrl: 'ws://127.0.0.1:9223/x' }, 'hearth-route:exact', 'http://127.0.0.1:9223'), true); assert.equal(expressions.length, 3); assert.match(expressions[1], /button\[aria-expanded=/); assert.match(expressions[1], /hearth/); assert.match(expressions[1], /tool.*output.*result/); assert(!expressions[1].includes("querySelectorAll('button')")); assert.equal(eval(expressions[1].replace("document.querySelectorAll('button[aria-expanded=\"false\"]')", "[{parentElement:null,innerText:'Hearth tool result',click(){}}]")), true); assert.match(expressions[2], /hearth-route:exact/); } finally { globalThis.WebSocket = OriginalWebSocket; }
});

test('route binding and wake reject non-conversation ChatGPT pages', async t => {
  const { hearth } = await fixture(t); const route = { conversation_key: 'openai:unstable-url', source: 'openai' }; hearth.ensureMailbox(route); hearth.routeProbe(route.conversation_key); let inspected = 0; hearth.cdp = { listTargets: async () => [{ id: 'home', url: 'https://chatgpt.com/' }], contains: async () => (++inspected, true) }; await hearth.tickRoutes(); await waitFor(() => !hearth.binding); assert.equal(inspected, 0); assert.equal(hearth.db.prepare('SELECT target_id FROM mailboxes WHERE route_key=?').get(route.conversation_key).target_id, null);
  hearth.config.oracle.armed = true; hearth.config.wake.armed = true; const at = new Date().toISOString(); hearth.db.prepare('UPDATE mailboxes SET target_id=?,target_url=?,last_activity_at=?,wake_due_at=? WHERE route_key=?').run('home', 'https://chatgpt.com/', new Date(Date.now()-30000).toISOString(), new Date(Date.now()-1).toISOString(), route.conversation_key); hearth.db.prepare("INSERT INTO futures(id,route_key,kind,tool,dependencies,state,detached,at,updated_at,completed_at,result,mailbox_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run('unstable-ready', route.conversation_key, 'generic', 'machine', '[]', 'completed', 1, at, at, at, '{"state":"completed"}', 1); let woke = false; hearth.exec = async () => (woke = true); await hearth.tickRoutes(); assert.equal(woke, false); assert.equal(hearth.db.prepare('SELECT target_id FROM mailboxes WHERE route_key=?').get(route.conversation_key).target_id, null);
});

test('armed wake CDP failures cool down and exhaust bounded attempts', async t => {
  const { hearth } = await fixture(t); hearth.config.oracle.armed = true; hearth.config.wake.armed = true; hearth.config.wake.quiet_ms = 100; hearth.config.wake.cooldown_ms = 1000; hearth.config.wake.max_attempts = 2; const route = { conversation_key: 'openai:wake-failure', source: 'openai' }; hearth.ensureMailbox(route); let lists = 0; hearth.cdp = { listTargets: async () => { lists++; throw new Error('offline'); } }; const at = new Date().toISOString(); hearth.db.prepare('UPDATE mailboxes SET target_id=?,target_url=?,last_activity_at=?,wake_due_at=? WHERE route_key=?').run('target', 'https://chatgpt.com/c/stable', new Date(Date.now()-30000).toISOString(), new Date(Date.now()-1).toISOString(), route.conversation_key); hearth.db.prepare("INSERT INTO futures(id,route_key,kind,tool,dependencies,state,detached,at,updated_at,completed_at,result,mailbox_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run('failure-ready', route.conversation_key, 'generic', 'machine', '[]', 'completed', 1, at, at, at, '{"state":"completed"}', 1);
  await hearth.tickRoutes(); let mailbox = hearth.db.prepare('SELECT wake_attempts,last_wake_at,wake_due_at FROM mailboxes WHERE route_key=?').get(route.conversation_key); assert.equal(mailbox.wake_attempts, 1); assert(mailbox.last_wake_at); assert(Date.parse(mailbox.wake_due_at) > Date.now()); await hearth.tickRoutes(); assert.equal(lists, 1);
  hearth.db.prepare('UPDATE mailboxes SET last_wake_at=?,wake_due_at=? WHERE route_key=?').run(new Date(Date.now()-2000).toISOString(), new Date(Date.now()-1).toISOString(), route.conversation_key); await hearth.tickRoutes(); mailbox = hearth.db.prepare('SELECT wake_attempts,wake_due_at FROM mailboxes WHERE route_key=?').get(route.conversation_key); assert.equal(lists, 2); assert.equal(mailbox.wake_attempts, 2); assert.equal(mailbox.wake_due_at, null); await hearth.tickRoutes(); assert.equal(lists, 2);
});

test('armed wake validates target URL and honors quiet cooldown and attempts', async t => {
  const { hearth } = await fixture(t); hearth.config.wake.armed = true; hearth.config.wake.quiet_ms = 100; hearth.config.wake.cooldown_ms = 1000; const route = { conversation_key: 'openai:wake-test', source: 'openai' }; hearth.ensureMailbox(route); const target = { id: 'wake-target', url: 'https://chatgpt.com/c/wake', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/wake' }; const calls = [];
  hearth.cdp = { listTargets: async () => [target], contains: async () => false, send: async (seen, prompt) => { calls.push({ seen, prompt }); hearth.db.prepare('UPDATE mailboxes SET offered_seq=1 WHERE route_key=?').run(route.conversation_key); return { state: 'completed' }; } }; const at = new Date().toISOString();
  hearth.db.prepare('UPDATE mailboxes SET target_id=?,target_url=?,bound_at=?,last_activity_at=? WHERE route_key=?').run(target.id, target.url, at, new Date(Date.now() - 1000).toISOString(), route.conversation_key); hearth.db.prepare("INSERT INTO futures(id,route_key,kind,tool,dependencies,state,detached,at,updated_at,completed_at,result,mailbox_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run('wake-ready', route.conversation_key, 'generic', 'machine', '[]', 'completed', 1, at, at, at, '{"state":"completed"}', 1); hearth.db.prepare('UPDATE mailboxes SET wake_due_at=? WHERE route_key=?').run(new Date(Date.now() - 1).toISOString(), route.conversation_key);
  await hearth.tickRoutes(); await waitFor(() => calls.length === 1); assert.equal(calls[0].seen.id, 'wake-target'); assert.match(calls[0].prompt, /machine with operation host_info exactly once/); assert.match(calls[0].prompt, /without polling/); assert.match(calls[0].prompt, /hearth-wake:/); await waitFor(() => !hearth.waking); await hearth.tickRoutes(); assert.equal(calls.length, 1);
  hearth.db.prepare('UPDATE mailboxes SET target_id=?,target_url=?,last_activity_at=?,last_wake_at=NULL,wake_attempts=0,wake_due_at=? WHERE route_key=?').run(target.id, target.url, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 1).toISOString(), route.conversation_key); hearth.cdp.listTargets = async () => [{ ...target, url: 'https://chatgpt.com/c/other' }]; await hearth.tickRoutes(); assert.equal(calls.length, 1); assert.equal(hearth.db.prepare('SELECT target_id FROM mailboxes WHERE route_key=?').get(route.conversation_key).target_id, null);
});

test('recipes substitute argv data, cannot override primitive operations, record stats, and suggest traces', async t => {
  const { hearth, root } = await fixture(t);
  await writeFile(path.join(root, 'safe.txt'), 'safe');
  await hearth.recipe({ operation: 'create', name: 'no-override', steps: [
    { primitive: 'fs.read', input: { operation: 'write', path: path.join(root, 'safe.txt'), data: 'unsafe' } }
  ] });
  assert.equal((await hearth.recipe({ operation: 'run', name: 'no-override' })).state, 'completed');
  assert.equal(await readFile(path.join(root, 'safe.txt'), 'utf8'), 'safe');
  assert.equal((await hearth.recipe({ operation: 'create', name: 'echo', steps: [
    { primitive: 'machine.exec', input: { command: process.execPath, args: ['-e', "console.log(process.argv[1])", '${word}'] } },
    { primitive: 'machine.exec', input: { command: process.execPath, args: ['-e', "console.log('done')"] } }
  ] })).state, 'completed');
  for (let i = 0; i < 3; i++) { const run = await hearth.recipe({ operation: 'run', name: 'echo', params: { word: 'hello; not-shell' } }); assert.equal(run.state, 'completed'); assert.match(run.results[0].output, /hello; not-shell/); }
  const stats = await hearth.recipe({ operation: 'stats', name: 'echo' }); assert.equal(stats.runs, 3);
  const suggestions = await hearth.recipe({ operation: 'suggest', threshold: 3 }); assert.deepEqual(suggestions.suggestions[0], { pattern: ['machine.exec','machine.exec'], count: 3 });
});

test('run checkpoints and due continuations remain explicit and dry-run', async t => {
  const { hearth } = await fixture(t);
  await assert.rejects(() => hearth.run({ operation: 'checkpoint', objective: 'ship sk-abcdefghijklmnop' }), /secret-like/);
  const checkpoint = await hearth.run({ operation: 'checkpoint', objective: 'ship', acceptance_criteria: ['passes'], next_actions: ['test'] });
  const scheduled = await hearth.run({ operation: 'schedule_continuation', run_id: checkpoint.id, delay_ms: 30, prompt: 'continue' }); assert.equal(scheduled.state, 'pending'); assert.equal(scheduled.armed, false);
  const due = await waitFor(async () => { const result = await hearth.run({ operation: 'continuation_status', id: scheduled.id }); return result.state === 'blocked' ? result : null; });
  assert.match(due.result.reason, /no Oracle/);
  const targeted = await hearth.run({ operation: 'schedule_continuation', run_id: checkpoint.id, delay_ms: 0, prompt: 'continue', target: { session: 'session-id' } });
  const dry = await waitFor(async () => { const result = await hearth.run({ operation: 'continuation_status', id: targeted.id }); return result.state === 'pending' && result.result?.dry_run ? result : null; }); assert.equal(dry.result.command, 'oracle.cmd');
  assert.equal((await hearth.run({ operation: 'close', id: checkpoint.id })).run_state, 'closed');
});

test('UI bridge has bounded deterministic output or exact platform limitation', async t => {
  const { hearth } = await fixture(t);
  const unsafe = await hearth.ui({ operation: 'action', target: { name: 'anything' }, action: 'click', allow_fallback: true });
  assert.equal(unsafe.state, 'blocked'); assert.match(unsafe.limitation, /explicit hwnd or process_id/);
  const result = await hearth.ui({ operation: 'snapshot', max_depth: 0, max_nodes: 1, timeout_ms: 10000 });
  if (process.platform === 'win32') { assert.match(result.state, /completed|partial/); assert.equal(result.node_count, 1); assert.equal(result.truncated, true); assert.equal(typeof result.tree.controlType, 'string'); }
  else { assert.equal(result.state, 'blocked'); assert.match(result.limitation, /Windows UI Automation/); }
});

test('Windows UIA invokes only the disposable fixture button', { skip: process.platform !== 'win32' && 'requires Windows' }, async t => {
  const { hearth } = await fixture(t);
  const readyFile = path.join(hearth.config.data_dir, 'uia-ready.json'); const actionFile = path.join(hearth.config.data_dir, 'uia-action.txt');
  const child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',path.resolve('test/uia-fixture.ps1'),'-ReadyFile',readyFile,'-ActionFile',actionFile], { stdio: ['ignore','ignore','pipe'], windowsHide: true });
  t.after(() => child.kill());
  child.once('error', error => { throw error; });
  const ready = await waitFor(async () => { try { return JSON.parse((await readFile(readyFile, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; } }, 10000);
  const snapshot = await hearth.ui({ operation: 'snapshot', hwnd: ready.hwnd, max_depth: 3, max_nodes: 20 });
  assert.match(snapshot.state, /completed|partial/);
  const button = snapshot.tree.children.find(node => node.automationId === 'HearthInvokeButton');
  assert(button); assert(button.patterns.includes('invoke'));
  const invoked = await hearth.ui({ operation: 'action', hwnd: ready.hwnd, target: { automation_id: 'HearthInvokeButton', control_type: 'Button' }, action: 'invoke' });
  assert.equal(invoked.state, 'completed'); assert.equal(invoked.method, 'uia.invoke');
  assert.equal(await waitFor(async () => { try { return (await readFile(actionFile, 'utf8')).trim(); } catch { return null; } }), 'invoked');
});


test('Windows cmd shims execute through ComSpec', { skip: process.platform !== 'win32' }, async t => {
  const { hearth, root } = await fixture(t);
  const script = path.join(root, 'echo-args.cmd');
  await writeFile(script, '@echo off\r\necho %~1^|%~2\r\n');
  const result = await hearth.exec({ command: script, args: ['alpha', 'two words'] });
  assert.equal(result.state, 'completed');
  assert.match(result.output, /\[stdout\] alpha\|two words/);
});


test('CDP wake writes the exact bounded prompt and submits it', async () => {
  const OriginalWebSocket = globalThis.WebSocket; const requests = [];
  class FakeWebSocket {
    listeners = new Map();
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); if (name === 'open') queueMicrotask(fn); }
    send(body) {
      const request = JSON.parse(body); requests.push(request);
      const value = request.method === 'Runtime.evaluate' && request.params?.expression?.includes('inComposer') ? { inComposer: false, inConversation: false } : true;
      const result = request.method === 'Runtime.evaluate' ? { result: { value } } : {};
      queueMicrotask(() => (this.listeners.get('message') || []).forEach(fn => fn({ data: JSON.stringify({ id: request.id, result }) })));
    }
    close() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const prompt = 'Continue and consume arrivals. Wake token: hearth-wake:test';
    const result = await sendChatPrompt({ url: 'https://chatgpt.com/c/wake-test', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/wake' }, prompt, 'http://127.0.0.1:9223', 1000);
    assert.equal(result.state, 'completed'); assert.equal(result.confirmation, 'composer-cleared');
    assert.deepEqual(requests.map(request => request.method), ['Runtime.evaluate','Input.insertText','Runtime.evaluate','Input.dispatchKeyEvent','Input.dispatchKeyEvent','Runtime.evaluate']);
    assert.equal(requests[1].params.text, prompt); assert.equal(requests[3].params.type, 'rawKeyDown');
  } finally { globalThis.WebSocket = OriginalWebSocket; }
});


test('explicit detach returns a future immediately even for a fast primitive', async t => {
  const { hearth } = await fixture(t);
  const route1 = { conversation_key: 'local:explicit-detach', source: 'local', turn_key: 'turn-a' };
  const first = structured(await hearth.dispatch('machine', { operation: 'host_info', detach: true }, route1));
  assert.equal(first.state, 'pending'); assert(first.future_id);
  await waitFor(() => hearth.db.prepare('SELECT state FROM futures WHERE id=?').get(first.future_id)?.state === 'completed');
  const second = structured(await hearth.dispatch('machine', { operation: 'host_info' }, { ...route1, turn_key: 'turn-b' }));
  assert.equal(second.arrivals.length, 1); assert.equal(second.arrivals[0].future_id, first.future_id);
  assert.equal(second.arrivals[0].result.hostname, os.hostname());
});

test('run.scatter exposes heterogeneous future DAGs through the orchestration tool', async t => {
  const { hearth, root } = await fixture(t); const file = path.join(root, 'scatter.txt'); await writeFile(file, 'scatter');
  const route = { conversation_key: 'local:run-scatter', source: 'local', turn_key: 'turn-a' };
  const first = structured(await hearth.dispatch('run', { operation: 'scatter', calls: [
    { kind: 'machine.host_info' },
    { kind: 'fs.stat', path: file }
  ] }, route));
  assert.equal(first.state, 'pending'); assert.equal(first.futures.length, 2);
  await waitFor(() => first.futures.every(item => hearth.db.prepare('SELECT state FROM futures WHERE id=?').get(item.id)?.state === 'completed'));
  const second = structured(await hearth.dispatch('machine', { operation: 'host_info' }, { ...route, turn_key: 'turn-b' }));
  const delivered = [...(first.arrivals || []), ...second.arrivals].map(item => item.future_id);
  assert.deepEqual(new Set(delivered), new Set(first.futures.map(item => item.id)));
});
test('closed scatter batches read-only runtime diagnostics through the MCP schema', async t => {
  const { hearth } = await fixture(t); const handler = createHandler(hearth); t.after(() => handler.close());
  const c = clientFor(handler, 'diagnostic-scatter'); await c.client.connect(c.transport); t.after(() => c.client.close());
  const checkpoint = structured(await c.client.callTool({ name: 'run', arguments: { operation: 'checkpoint', objective: 'diagnostic scatter' } }));
  const first = structured(await c.client.callTool({ name: 'run', arguments: { operation: 'scatter', calls: [
    { kind: 'artifact.list', limit: 2 },
    { kind: 'task.list', limit: 8 },
    { kind: 'run.get', id: checkpoint.id },
    { kind: 'run.events', entity_id: checkpoint.id, limit: 8 }
  ] } }));
  assert.equal(first.state, 'pending'); assert.equal(first.futures.length, 4);
  await waitFor(() => first.futures.every(item => hearth.db.prepare('SELECT state FROM futures WHERE id=?').get(item.id)?.state === 'completed'));
  const results = first.futures.map(item => JSON.parse(hearth.db.prepare('SELECT result FROM futures WHERE id=?').get(item.id).result));
  assert.equal(results[0].state, 'completed'); assert(Array.isArray(results[0].artifacts));
  assert.equal(results[1].state, 'completed'); assert(Array.isArray(results[1].futures));
  assert.equal(results[2].state, 'completed'); assert.equal(results[2].run.id, checkpoint.id);
  assert.equal(results[3].state, 'completed'); assert(results[3].events.some(event => event.entity_id === checkpoint.id));
});
