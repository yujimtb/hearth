import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Hearth } from '../src/hearth.js';
import { createHandler, start } from '../src/server.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const waitFor = async (fn, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('timed out waiting for condition');
};

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hearth-test-'));
  const root = path.join(base, 'root'); const data = path.join(base, 'data'); await mkdir(root);
  const config = { host: '127.0.0.1', port: 0, data_dir: data, roots: [root], command_timeout_ms: 5000, max_output_bytes: 1024, artifact_preview_bytes: 100, max_artifact_bytes: 1024 * 1024, max_concurrent_jobs: 4, recipe_max_steps: 20, oracle: { command: 'oracle.cmd', armed: false } };
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

test('large output spills to a searchable and ranged artifact', async t => {
  const { hearth } = await fixture(t);
  const result = await hearth.machine({ operation: 'exec', command: process.execPath, args: ['-e', "process.stdout.write('A'.repeat(3000)+'NEEDLE')"] });
  assert.equal(result.state, 'completed'); assert(result.artifact?.id); assert.equal(result.preview.length <= 110, true);
  const found = await hearth.artifact({ operation: 'search', id: result.artifact.id, query: 'NEEDLE' }); assert.equal(found.matches.length, 1);
  const ranged = await hearth.artifact({ operation: 'range', id: result.artifact.id, offset: 2990, limit: 30 }); assert.match(ranged.data, /NEEDLE/);
});

test('durable delayed and dependent tasks return immediately, run concurrently, and recover', async t => {
  const { hearth, config } = await fixture(t);
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
  const missing = await hearth.task({ operation: 'submit', job: { command: process.execPath, args: ['-e', "console.log('never')"], dependencies: ['missing-job'] } });
  const missingDone = await waitFor(async () => { const value = await hearth.task({ operation: 'get', id: missing.jobs[0].id }); return value.state === 'blocked' ? value : null; }); assert.match(missingDone.error, /dependency/);
  const survivor = await hearth.task({ operation: 'submit', job: { command: process.execPath, args: ['-e', "console.log('recovered')"], delay_ms: 300 } });
  clearInterval(hearth.timer); hearth.timer = null; hearth.event('runtime.stopped', null, {}); hearth.db.close(); hearth.db = null;
  const restarted = await new Hearth(config).init();
  try { const done = await waitFor(async () => { const value = await restarted.task({ operation: 'get', id: survivor.jobs[0].id }); return value.state === 'completed' ? value : null; }); assert.match(done.result.output, /recovered/); } finally { await restarted.close(); }
});

test('recipes substitute argv data, record stats, and suggest repeated contiguous traces', async t => {
  const { hearth } = await fixture(t);
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
  const invoked = await hearth.ui({ operation: 'action', hwnd: ready.hwnd, target: { automation_id: 'HearthInvokeButton' }, action: 'invoke' });
  assert.equal(invoked.state, 'completed'); assert.equal(invoked.method, 'uia.invoke');
  assert.equal(await waitFor(async () => { try { return (await readFile(actionFile, 'utf8')).trim(); } catch { return null; } }), 'invoked');
});
