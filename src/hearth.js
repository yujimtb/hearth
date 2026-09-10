import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { listCdpTargets, safeChatUrl, targetContains } from './cdp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = new Set(['machine','fs','task','artifact','ui','recipe','run']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const killProcess = (child, signal = 'SIGTERM') => {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref();
  else { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } }
};
const now = () => new Date().toISOString();
const sha256 = data => createHash('sha256').update(data).digest('hex');
const json = value => JSON.stringify(value);
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const assertNoSecrets = value => {
  const visit = (item, key = '') => {
    if (/(secret|token|password|api.?key|credential|authorization)/i.test(key)) throw new Error(`refusing to persist secret-like field: ${key}`);
    if (typeof item === 'string' && (/\b(?:sk|Bearer)[-_ ][A-Za-z0-9_-]{12,}/i.test(item) || /^--(?:password|token|api[-_]?key|secret|credential|authorization)(?:=|$)/i.test(item))) throw new Error('refusing to persist secret-like value');
    if (Array.isArray(item)) item.forEach(entry => visit(entry));
    else if (item && typeof item === 'object') Object.entries(item).forEach(([name, entry]) => visit(entry, name));
  };
  visit(value);
};
const assertRecipeNoScatter = definition => {
  if (definition.steps?.some(step => step.primitive === 'task.submit' && step.input?.calls !== undefined)) throw new Error('recursive task scatter through recipes is not allowed');
};
const clampNumber = (value, min, max, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return Math.min(max, Math.max(min, value));
};

export async function loadConfig(file = process.env.HEARTH_CONFIG || 'config.json') {
  const defaults = {
    host: '127.0.0.1', port: 3000, data_dir: '.hearth',
    roots: [path.resolve('..'), path.resolve('../../work')], command_timeout_ms: 30_000,
    max_output_bytes: 65_536, artifact_preview_bytes: 4096, max_artifact_bytes: 16 * 1024 * 1024,
    max_concurrent_jobs: 4, recipe_max_steps: 50,
    dispatch_inline_budget_ms: 100, mailbox_max_arrivals: 16, mailbox_max_bytes: 32_768,
    future_result_inline_bytes: 16_384, max_concurrent_futures: 4, future_input_max_bytes: 262_144,
    oracle: { command: 'C:\\nvm4w\\nodejs\\oracle.cmd', armed: false },
    wake: { armed: false, cdp_url: 'http://127.0.0.1:9223', quiet_ms: 15_000, debounce_ms: 500, cooldown_ms: 60_000, max_attempts: 2, probe_ttl_ms: 600_000, probe_interval_ms: 2_000, timeout_ms: 120_000 }
  };
  let supplied = {};
  try { supplied = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = { ...defaults, ...supplied, oracle: { ...defaults.oracle, ...supplied.oracle }, wake: { ...defaults.wake, ...supplied.wake } };
  config.data_dir = path.resolve(config.data_dir);
  config.roots = config.roots.map(root => path.resolve(root));
  config.dispatch_inline_budget_ms = clampNumber(config.dispatch_inline_budget_ms, 1, 1000, 'dispatch_inline_budget_ms');
  config.mailbox_max_arrivals = clampNumber(config.mailbox_max_arrivals, 1, 64, 'mailbox_max_arrivals');
  config.mailbox_max_bytes = clampNumber(config.mailbox_max_bytes, 512, 1_048_576, 'mailbox_max_bytes');
  config.future_result_inline_bytes = clampNumber(config.future_result_inline_bytes, 256, config.max_artifact_bytes, 'future_result_inline_bytes');
  config.max_concurrent_futures = clampNumber(config.max_concurrent_futures, 1, 32, 'max_concurrent_futures');
  config.future_input_max_bytes = clampNumber(config.future_input_max_bytes, 1024, 1_048_576, 'future_input_max_bytes');
  if (typeof config.oracle.armed !== 'boolean' || typeof config.wake.armed !== 'boolean') throw new Error('oracle.armed and wake.armed must be booleans');
  config.wake.quiet_ms = clampNumber(config.wake.quiet_ms, 100, 3_600_000, 'wake.quiet_ms');
  config.wake.debounce_ms = clampNumber(config.wake.debounce_ms, 0, 60_000, 'wake.debounce_ms');
  config.wake.cooldown_ms = clampNumber(config.wake.cooldown_ms, 1000, 86_400_000, 'wake.cooldown_ms');
  config.wake.max_attempts = clampNumber(config.wake.max_attempts, 1, 10, 'wake.max_attempts');
  config.wake.probe_ttl_ms = clampNumber(config.wake.probe_ttl_ms, 1000, 86_400_000, 'wake.probe_ttl_ms');
  config.wake.probe_interval_ms = clampNumber(config.wake.probe_interval_ms, 100, 60_000, 'wake.probe_interval_ms');
  config.wake.timeout_ms = clampNumber(config.wake.timeout_ms, 1000, 300_000, 'wake.timeout_ms');
  if (config.host !== '127.0.0.1' && config.host !== '::1' && config.host !== 'localhost') throw new Error('Hearth v0 only binds localhost');
  const cdp = new URL(config.wake.cdp_url);
  if (cdp.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(cdp.hostname)) throw new Error('wake.cdp_url must be loopback HTTP');
  return config;
}

export class Hearth {
  constructor(config) {
    this.config = config;
    this.db = null;
    this.timer = null;
    this.active = new Map();
    this.futureActive = new Map();
    this.detachedActive = new Set();
    this.cdp = config.cdp || { listTargets: listCdpTargets, contains: (target, nonce) => targetContains(target, nonce, config.wake.cdp_url) };
    this.closing = false;
    this.uiTail = Promise.resolve();
    this.fsTail = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.config.data_dir, { recursive: true });
    await fs.mkdir(path.join(this.config.data_dir, 'artifacts'), { recursive: true });
    await fs.mkdir(path.join(this.config.data_dir, 'backups'), { recursive: true });
    this.db = new DatabaseSync(path.join(this.config.data_dir, 'hearth.db'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, at TEXT NOT NULL, file TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, media_type TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, at TEXT NOT NULL, target TEXT NOT NULL, backup TEXT, before_sha256 TEXT, after_sha256 TEXT, undone_at TEXT);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL, run_at TEXT NOT NULL, spec TEXT NOT NULL, dependencies TEXT NOT NULL, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS recipes(name TEXT PRIMARY KEY, at TEXT NOT NULL, definition TEXT NOT NULL, runs INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, last_run TEXT);
      CREATE TABLE IF NOT EXISTS traces(id INTEGER PRIMARY KEY, at TEXT NOT NULL, trace_id TEXT NOT NULL, position INTEGER NOT NULL, operation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS continuations(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, at TEXT NOT NULL, due_at TEXT NOT NULL, state TEXT NOT NULL, target TEXT, prompt TEXT NOT NULL, result TEXT, FOREIGN KEY(run_id) REFERENCES runs(id));
      CREATE TABLE IF NOT EXISTS mailboxes(route_key TEXT PRIMARY KEY, source TEXT NOT NULL, ack_seq INTEGER NOT NULL DEFAULT 0, offered_seq INTEGER NOT NULL DEFAULT 0, last_turn_key TEXT, last_activity_at TEXT NOT NULL, probe_nonce TEXT UNIQUE, probe_expires_at TEXT, probe_next_at TEXT, target_id TEXT, target_url TEXT, bound_at TEXT, wake_due_at TEXT, wake_attempts INTEGER NOT NULL DEFAULT 0, wake_cursor INTEGER NOT NULL DEFAULT 0, last_wake_at TEXT, wake_claimed_at TEXT);
      CREATE TABLE IF NOT EXISTS futures(id TEXT PRIMARY KEY, batch_id TEXT, route_key TEXT NOT NULL, kind TEXT NOT NULL, tool TEXT, input TEXT, dependencies TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, detached INTEGER NOT NULL DEFAULT 1, at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, result TEXT, error TEXT, mailbox_seq INTEGER, FOREIGN KEY(route_key) REFERENCES mailboxes(route_key), UNIQUE(route_key,mailbox_seq));
      CREATE INDEX IF NOT EXISTS idx_jobs_state_run ON jobs(state, run_at);
      CREATE INDEX IF NOT EXISTS idx_cont_state_due ON continuations(state, due_at);
      CREATE INDEX IF NOT EXISTS idx_traces_trace_pos ON traces(trace_id, position);
      CREATE INDEX IF NOT EXISTS idx_futures_state ON futures(state,at);
      CREATE INDEX IF NOT EXISTS idx_futures_batch ON futures(batch_id);
      CREATE INDEX IF NOT EXISTS idx_futures_mailbox ON futures(route_key,mailbox_seq);`);
    this.db.prepare("UPDATE jobs SET state='queued', updated_at=? WHERE state='running'").run(now());
    const interrupted = this.db.prepare("SELECT id FROM futures WHERE kind IN ('dispatch','generic') AND state='running'").all();
    this.db.prepare("UPDATE futures SET detached=1 WHERE kind IN ('dispatch','generic') AND state='running'").run();
    for (const row of interrupted) await this.completeFuture(row.id, { state: 'blocked', error: 'interrupted by restart; automatic replay suppressed' }, 'blocked');
    for (const future of this.db.prepare("SELECT f.id,j.state,j.result,j.error FROM futures f LEFT JOIN jobs j ON j.id=f.id WHERE f.kind='job' AND f.state='running'").all()) {
      if (!future.state) await this.completeFuture(future.id, { state: 'blocked', error: 'durable job record is missing' }, 'blocked');
      else if (!['queued','running'].includes(future.state)) await this.completeFuture(future.id, parse(future.result, { state: future.state, error: future.error }), future.state);
    }
    for (const mailbox of this.db.prepare('SELECT route_key,wake_attempts,last_wake_at FROM mailboxes WHERE wake_claimed_at IS NOT NULL').all()) {
      const due = mailbox.wake_attempts >= this.config.wake.max_attempts ? null : new Date(Math.max(Date.now() + this.config.wake.cooldown_ms, Date.parse(mailbox.last_wake_at || 0) + this.config.wake.cooldown_ms)).toISOString();
      this.db.prepare('UPDATE mailboxes SET wake_claimed_at=NULL,wake_due_at=? WHERE route_key=?').run(due, mailbox.route_key);
    }
    this.event('runtime.started', null, { pid: process.pid });
    this.timer = setInterval(() => { void this.tick(); }, 100);
    this.timer.unref();
    await this.tick();
    return this;
  }

  async close() {
    if (!this.db || this.closing) return;
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.tickPromise) await this.tickPromise;
    while (this.active.size || this.futureActive.size || this.detachedActive.size) {
      await Promise.allSettled([...this.active.values(), ...this.futureActive.values()].map(item => item.promise).filter(Boolean).concat([...this.detachedActive]));
    }
    this.event('runtime.stopped', null, {});
    this.db.close(); this.db = null;
  }

  event(kind, entityId, data) {
    if (this.db) this.db.prepare('INSERT INTO events(at,kind,entity_id,data) VALUES(?,?,?,?)').run(now(), kind, entityId, json(data));
  }

  result(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  }

  async putArtifact(data, mediaType = 'text/plain') {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const id = randomUUID();
    const file = path.join(this.config.data_dir, 'artifacts', id);
    await fs.writeFile(file, buffer);
    const info = { id, state: 'completed', size: buffer.length, sha256: sha256(buffer), media_type: mediaType, created_at: now() };
    this.db.prepare('INSERT INTO artifacts(id,at,file,size,sha256,media_type) VALUES(?,?,?,?,?,?)').run(id, info.created_at, file, info.size, info.sha256, mediaType);
    this.event('artifact.created', id, { size: info.size, media_type: mediaType });
    return info;
  }

  artifactRow(id) {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id);
    if (!row) throw new Error(`artifact not found: ${id}`);
    return row;
  }

  async artifact(input) {
    const op = input.operation;
    if (op === 'list') return { state: 'completed', artifacts: this.db.prepare('SELECT id,at,size,sha256,media_type FROM artifacts ORDER BY at DESC LIMIT ?').all(input.limit || 50) };
    const row = this.artifactRow(input.id);
    if (op === 'metadata') return { state: 'completed', artifact: { id: row.id, created_at: row.at, size: row.size, sha256: row.sha256, media_type: row.media_type } };
    const body = await fs.readFile(row.file);
    if (op === 'read' || op === 'range') {
      const offset = Math.max(0, input.offset || 0);
      const limit = Math.min(input.limit || this.config.max_output_bytes, this.config.max_output_bytes);
      return { state: offset + limit < body.length ? 'partial' : 'completed', id: row.id, offset, total: body.length, data: body.subarray(offset, offset + limit).toString(input.encoding || 'utf8') };
    }
    if (op === 'search') {
      const text = body.toString('utf8');
      const needle = String(input.query || '');
      const matches = [];
      let at = 0;
      while (needle && matches.length < (input.limit || 50) && (at = text.indexOf(needle, at)) >= 0) { matches.push({ offset: at, preview: text.slice(Math.max(0, at - 80), at + needle.length + 80) }); at += Math.max(needle.length, 1); }
      return { state: 'completed', id: row.id, matches };
    }
    throw new Error(`unsupported artifact operation: ${op}`);
  }

  async exec(spec, controls = {}) {
    if (!spec || typeof spec.command !== 'string' || !spec.command) throw new Error('command is required');
    const cwd = spec.cwd ? await this.safePath(spec.cwd, false) : this.config.roots[0];
    if (controls.cancelled) return { state: 'cancelled', duration_ms: 0 };
    const timeoutMs = Math.min(Math.max(spec.timeout_ms || this.config.command_timeout_ms, 1), 300_000);
    const started = Date.now();
    const env = { ...process.env, ...(spec.env || {}) };
    return await new Promise(resolve => {
      const child = spawn(spec.command, spec.args || [], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32' });
      controls.child = child;
      const chunks = []; let bytes = 0; let overflow = false; let timedOut = false;
      const collect = (source, chunk) => {
        const tagged = Buffer.concat([Buffer.from(`[${source}] `), chunk]);
        const keep = tagged.subarray(0, Math.max(0, this.config.max_artifact_bytes - bytes));
        if (keep.length) { chunks.push(keep); bytes += keep.length; }
        if (keep.length < tagged.length) { overflow = true; killProcess(child); }
      };
      child.stdout.on('data', chunk => collect('stdout', chunk));
      child.stderr.on('data', chunk => collect('stderr', chunk));
      const timer = setTimeout(() => { timedOut = true; killProcess(child); setTimeout(() => killProcess(child, 'SIGKILL'), 500).unref(); }, timeoutMs);
      child.once('error', error => { clearTimeout(timer); resolve({ state: 'blocked', error: error.message, duration_ms: Date.now() - started }); });
      child.once('close', async (code, signal) => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks);
        const base = { state: timedOut || overflow ? 'partial' : code === 0 ? 'completed' : 'blocked', exit_code: code, signal, timed_out: timedOut, output_truncated: overflow, duration_ms: Date.now() - started };
        if (output.length > (controls.inlineLimit || this.config.max_output_bytes)) {
          const artifact = await this.putArtifact(output);
          resolve({ ...base, preview: output.subarray(0, this.config.artifact_preview_bytes).toString('utf8'), artifact });
        } else resolve({ ...base, output: output.toString('utf8') });
      });
    });
  }

  async machine(input) {
    if (input.operation === 'host_info') return { state: 'completed', hostname: os.hostname(), platform: process.platform, release: os.release(), arch: process.arch, node: process.version, pid: process.pid };
    if (input.operation === 'exec') { const result = await this.exec(input); this.event('machine.exec', null, { command: input.command, state: result.state }); return result; }
    if (input.operation === 'batch') {
      const commands = input.commands || [];
      if (commands.length > 16) throw new Error('at most 16 commands');
      return { state: 'completed', results: await Promise.all(commands.map(command => this.exec(command))) };
    }
    if (input.operation === 'process_list') {
      const command = process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | Select-Object Id,ProcessName,CPU | ConvertTo-Json -Compress']] : ['ps', ['-eo', 'pid,comm']];
      return this.exec({ command: command[0], args: command[1], timeout_ms: 10_000 });
    }
    if (input.operation === 'process_kill') {
      if (!Number.isInteger(input.pid) || input.pid <= 0 || input.pid === process.pid) throw new Error('safe pid required');
      process.kill(input.pid, input.signal || 'SIGTERM');
      return { state: 'completed', pid: input.pid };
    }
    throw new Error(`unsupported machine operation: ${input.operation}`);
  }

  async safePath(candidate, allowMissing = true) {
    const absolute = path.resolve(candidate);
    const root = this.config.roots.find(rootPath => absolute === rootPath || absolute.startsWith(rootPath + path.sep));
    if (!root) throw new Error('path is outside configured roots');
    let rootReal;
    try { rootReal = await fs.realpath(root); } catch { throw new Error(`configured root does not exist: ${root}`); }
    let probe = absolute;
    while (true) {
      try {
        const real = await fs.realpath(probe);
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error('path escapes root through symlink');
        break;
      } catch (error) {
        if (error.message === 'path escapes root through symlink') throw error;
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }
    if (!allowMissing) await fs.access(absolute);
    return absolute;
  }

  async fileHash(file) { try { return sha256(await fs.readFile(file)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

  async mutateFile(target, data, expected) {
    const operation = async () => {
      const file = await this.safePath(target);
      const before = await this.fileHash(file);
      if (expected !== undefined && expected !== before) return { state: 'conflict', path: file, expected_sha256: expected, actual_sha256: before };
      const receiptId = randomUUID(); let backup = null;
      if (before) { backup = path.join(this.config.data_dir, 'backups', receiptId); await fs.copyFile(file, backup); }
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
      try { await fs.writeFile(temp, data); await fs.rename(temp, file); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
      const after = await this.fileHash(file);
      this.db.prepare('INSERT INTO receipts(id,at,target,backup,before_sha256,after_sha256) VALUES(?,?,?,?,?,?)').run(receiptId, now(), file, backup, before, after);
      this.event('fs.mutated', receiptId, { target: file, before, after });
      return { state: 'completed', path: file, sha256: after, receipt: { id: receiptId, operation: 'undo' } };
    };
    const promise = this.fsTail.then(operation, operation); this.fsTail = promise.catch(() => {}); return promise;
  }

  async fsTool(input) {
    if (input.operation === 'list') {
      const dir = await this.safePath(input.path, false);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return { state: 'completed', path: dir, entries: entries.slice(0, input.limit || 1000).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file' })), truncated: entries.length > (input.limit || 1000) };
    }
    if (input.operation === 'stat') { const file = await this.safePath(input.path, false); const stat = await fs.stat(file); return { state: 'completed', path: file, size: stat.size, modified_at: stat.mtime.toISOString(), type: stat.isDirectory() ? 'directory' : 'file', sha256: stat.isFile() ? await this.fileHash(file) : null }; }
    if (input.operation === 'read') {
      const file = await this.safePath(input.path, false); const body = await fs.readFile(file); const offset = Math.max(0, input.offset || 0); const limit = Math.min(input.limit || this.config.max_output_bytes, this.config.max_output_bytes);
      return { state: offset + limit < body.length ? 'partial' : 'completed', path: file, offset, total: body.length, sha256: sha256(body), data: body.subarray(offset, offset + limit).toString(input.encoding || 'utf8') };
    }
    if (input.operation === 'search') {
      const base = await this.safePath(input.path, false); const query = String(input.query || ''); const matches = []; const max = Math.min(input.limit || 100, 1000); const maxEntries = Math.min(input.max_entries || 10_000, 50_000); let visited = 0;
      const walk = async file => { if (matches.length >= max || visited >= maxEntries) return; visited++; const stat = await fs.lstat(file); if (stat.isSymbolicLink()) return; if (stat.isDirectory()) { for (const name of await fs.readdir(file)) await walk(path.join(file, name)); } else if (stat.size <= 2_000_000) { const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/); lines.forEach((line, i) => { if (matches.length < max && line.includes(query)) matches.push({ path: file, line: i + 1, text: line.slice(0, 500) }); }); } }; await walk(base);
      return { state: visited >= maxEntries || matches.length >= max ? 'partial' : 'completed', matches, visited, truncated: visited >= maxEntries || matches.length >= max };
    }
    if (input.operation === 'write') return this.mutateFile(input.path, input.data ?? '', input.expected_sha256);
    if (input.operation === 'patch') {
      const file = await this.safePath(input.path, false); let text = await fs.readFile(file, 'utf8'); const original = text;
      for (const replacement of input.replacements || []) { const parts = text.split(replacement.old); if (parts.length !== 2) return { state: 'conflict', path: file, error: 'each old value must match exactly once' }; text = parts[0] + replacement.new + parts[1]; }
      if (text === original) return { state: 'completed', path: file, sha256: sha256(text), changed: false };
      const expected = input.expected_sha256 !== undefined ? input.expected_sha256 : sha256(Buffer.from(original));
      return this.mutateFile(file, text, expected);
    }
    if (input.operation === 'undo') {
      const operation = async () => {
        const row = this.db.prepare('SELECT * FROM receipts WHERE id=?').get(input.receipt_id);
        if (!row) throw new Error('receipt not found');
        if (row.undone_at) return { state: 'superseded', receipt_id: row.id, undone_at: row.undone_at };
        const current = await this.fileHash(row.target);
        if (current !== row.after_sha256) return { state: 'conflict', expected_sha256: row.after_sha256, actual_sha256: current };
        if (row.backup) {
          const temp = path.join(path.dirname(row.target), `.${path.basename(row.target)}.${randomUUID()}.tmp`);
          try { await fs.copyFile(row.backup, temp); await fs.rename(temp, row.target); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
        } else await fs.unlink(row.target);
        const at = now(); this.db.prepare('UPDATE receipts SET undone_at=? WHERE id=?').run(at, row.id); this.event('fs.undo', row.id, { target: row.target });
        return { state: 'completed', receipt_id: row.id, sha256: await this.fileHash(row.target) };
      };
      const promise = this.fsTail.then(operation, operation); this.fsTail = promise.catch(() => {}); return promise;
    }
    throw new Error(`unsupported fs operation: ${input.operation}`);
  }

  jobView(row) { return { id: row.id, state: row.state, created_at: row.at, updated_at: row.updated_at, run_at: row.run_at, dependencies: parse(row.dependencies, []), spec: parse(row.spec, {}), result: parse(row.result), error: row.error }; }

  ensureMailbox(routing) {
    const routeKey = routing?.conversation_key || `local:${randomUUID()}`; const source = routing?.source || 'local'; const at = now();
    this.db.prepare('INSERT OR IGNORE INTO mailboxes(route_key,source,last_activity_at) VALUES(?,?,?)').run(routeKey, source, at);
    return routeKey;
  }

  beginRequest(routing) {
    const routeKey = this.ensureMailbox(routing); const row = this.db.prepare('SELECT ack_seq,offered_seq,last_turn_key FROM mailboxes WHERE route_key=?').get(routeKey); const retry = Boolean(routing?.turn_key && row.last_turn_key === routing.turn_key); const nextAck = retry ? row.ack_seq : row.offered_seq;
    this.db.prepare('UPDATE mailboxes SET ack_seq=?,last_turn_key=?,last_activity_at=?,wake_due_at=NULL,wake_attempts=0,wake_claimed_at=NULL,offered_seq=? WHERE route_key=?').run(nextAck, routing?.turn_key || null, now(), nextAck, routeKey);
    return routeKey;
  }

  async storedFutureResult(result) {
    const body = json(result); const size = Buffer.byteLength(body); const limit = Math.min(this.config.future_result_inline_bytes, Math.max(128, this.config.mailbox_max_bytes - 320));
    if (size <= limit) return result;
    if (size > this.config.max_artifact_bytes) return { state: 'blocked', error: `detached result exceeds max_artifact_bytes (${size})` };
    const artifact = await this.putArtifact(Buffer.from(body), 'application/json');
    return { state: result?.state || 'completed', artifact, spilled: true };
  }

  async completeFuture(id, result, forcedState) {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM futures WHERE id=?').get(id); if (!row || !['queued','running'].includes(row.state)) return row && parse(row.result);
    const sourceState = result?.state || 'completed'; const stored = await this.storedFutureResult(result); const state = forcedState || (['blocked','cancelled','conflict'].includes(stored?.state || sourceState) ? stored.state : 'completed'); const at = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT state,detached,route_key FROM futures WHERE id=?').get(id);
      if (!current || !['queued','running'].includes(current.state)) { this.db.exec('COMMIT'); return parse(this.db.prepare('SELECT result FROM futures WHERE id=?').get(id)?.result); }
      let seq = null;
      if (current.detached) seq = Number(this.db.prepare('SELECT COALESCE(MAX(mailbox_seq),0)+1 AS seq FROM futures WHERE route_key=?').get(current.route_key).seq);
      this.db.prepare('UPDATE futures SET state=?,updated_at=?,completed_at=?,result=?,error=?,mailbox_seq=? WHERE id=?').run(state, at, at, json(stored), stored?.error || null, seq, id);
      if (seq) {
        const mailbox = this.db.prepare('SELECT last_activity_at FROM mailboxes WHERE route_key=?').get(current.route_key);
        const due = new Date(Math.max(Date.parse(mailbox.last_activity_at) + this.config.wake.quiet_ms, Date.now() + this.config.wake.debounce_ms)).toISOString();
        this.db.prepare('UPDATE mailboxes SET wake_due_at=? WHERE route_key=?').run(due, current.route_key);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return stored;
  }

  cancelQueuedFuture(id) {
    const at = now(); this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT route_key FROM futures WHERE id=? AND kind='generic' AND state='queued'").get(id);
      if (!row) { const state = this.db.prepare('SELECT state FROM futures WHERE id=?').get(id)?.state; this.db.exec('COMMIT'); return state; }
      const seq = Number(this.db.prepare('SELECT COALESCE(MAX(mailbox_seq),0)+1 AS seq FROM futures WHERE route_key=?').get(row.route_key).seq); const result = { state: 'cancelled', id };
      this.db.prepare("UPDATE futures SET state='cancelled',updated_at=?,completed_at=?,result=?,mailbox_seq=? WHERE id=? AND state='queued'").run(at, at, json(result), seq, id);
      const mailbox = this.db.prepare('SELECT last_activity_at FROM mailboxes WHERE route_key=?').get(row.route_key); const due = new Date(Math.max(Date.parse(mailbox.last_activity_at) + this.config.wake.quiet_ms, Date.now() + this.config.wake.debounce_ms)).toISOString(); this.db.prepare('UPDATE mailboxes SET wake_due_at=? WHERE route_key=?').run(due, row.route_key);
      this.db.exec('COMMIT'); return 'cancelled';
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  arrivalView(row) { return { seq: row.mailbox_seq, future_id: row.id, state: row.state, result: parse(row.result), completed_at: row.completed_at }; }

  offerArrivals(routeKey) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const mailbox = this.db.prepare('SELECT ack_seq FROM mailboxes WHERE route_key=?').get(routeKey); const rows = this.db.prepare("SELECT id,state,result,error,completed_at,mailbox_seq FROM futures WHERE route_key=? AND mailbox_seq>? ORDER BY mailbox_seq").all(routeKey, mailbox.ack_seq); const arrivals = []; let bytes = 2;
      for (const row of rows) {
        if (arrivals.length >= this.config.mailbox_max_arrivals) break;
        let item = this.arrivalView(row); let itemBytes = Buffer.byteLength(json(item)) + (arrivals.length ? 1 : 0);
        if (bytes + itemBytes > this.config.mailbox_max_bytes && !arrivals.length) {
          item = { seq: row.mailbox_seq, future_id: row.id, state: 'blocked', result: { state: 'blocked', error: 'stored arrival exceeds mailbox byte limit' }, completed_at: row.completed_at };
          itemBytes = Buffer.byteLength(json(item));
        }
        if (bytes + itemBytes > this.config.mailbox_max_bytes) break;
        arrivals.push(item); bytes += itemBytes;
      }
      if (arrivals.length) this.db.prepare('UPDATE mailboxes SET offered_seq=? WHERE route_key=?').run(arrivals.at(-1).seq, routeKey);
      else this.db.prepare('UPDATE mailboxes SET offered_seq=ack_seq WHERE route_key=?').run(routeKey);
      this.db.exec('COMMIT'); return arrivals;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  dispatchResult(output, routeKey, isError = false, extra = {}) {
    const value = { ...output, ...extra, arrivals: this.offerArrivals(routeKey) };
    return { ...this.result(value), ...(isError && { isError: true }) };
  }

  replaceReferenceIndexes(value, ids) {
    if (Array.isArray(value)) return value.map(item => this.replaceReferenceIndexes(item, ids));
    if (!value || typeof value !== 'object') return value;
    const keys = Object.keys(value);
    if (keys.length === 2 && keys.includes('$future') && keys.includes('$path') && Number.isInteger(value.$future)) return { ...value, $future: ids[value.$future] };
    return Object.fromEntries(Object.entries(value).map(([key,item]) => [key, this.replaceReferenceIndexes(item, ids)]));
  }

  referenceIds(value, found = []) {
    if (Array.isArray(value)) value.forEach(item => this.referenceIds(item, found));
    else if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 2 && keys.includes('$future') && keys.includes('$path')) found.push(value.$future);
      else Object.values(value).forEach(item => this.referenceIds(item, found));
    }
    return found;
  }

  resolveReferences(value, routeKey, batchIds) {
    if (Array.isArray(value)) return value.map(item => this.resolveReferences(item, routeKey, batchIds));
    if (!value || typeof value !== 'object') return value;
    const keys = Object.keys(value);
    if (keys.length === 2 && keys.includes('$future') && keys.includes('$path')) {
      const ref = Number.isInteger(value.$future) ? batchIds[value.$future] : value.$future;
      const row = typeof ref === 'string' ? this.db.prepare('SELECT route_key,state,result,error FROM futures WHERE id=?').get(ref) : null;
      if (!row || row.route_key !== routeKey) throw new Error('referenced future is missing');
      if (row.state !== 'completed') throw new Error(`referenced future did not complete: ${ref} (${row.state})`);
      let resolved = { state: row.state, result: parse(row.result), error: row.error };
      const parts = String(value.$path).split('.'); if (parts.length > 32 || parts.some(part => !part || ['__proto__','prototype','constructor'].includes(part))) throw new Error('unsafe future path');
      for (const part of parts) { if (!resolved || !Object.prototype.hasOwnProperty.call(resolved, part)) throw new Error(`future path not found: ${value.$path}`); resolved = resolved[part]; }
      return resolved;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolveReferences(item, routeKey, batchIds)]));
  }

  async submitCalls(calls, routing) {
    if (this.closing) throw new Error('Hearth is closing');
    if (!Array.isArray(calls) || !calls.length) throw new Error('calls must be a non-empty array');
    if (calls.length > 64) throw new Error('at most 64 calls');
    if (Buffer.byteLength(json(calls)) > this.config.future_input_max_bytes) throw new Error('calls input is too large');
    assertNoSecrets(calls); const routeKey = this.ensureMailbox(routing); const ids = calls.map(() => randomUUID()); const batchId = randomUUID(); const created = now();
    const dependencies = calls.map((call, index) => {
      if (!tools.has(call.tool)) throw new Error(`unknown tool: ${call.tool}`);
      if (call.tool === 'task' && call.input?.operation === 'submit' && call.input?.calls !== undefined) throw new Error('recursive task scatter is not allowed');
      const refs = this.referenceIds(call.input || {}); const values = [...(call.dependencies || []), ...refs];
      return [...new Set(values.map(value => { if (Number.isInteger(value)) { if (value < 0 || value >= ids.length || value === index) throw new Error(`invalid batch dependency index: ${value}`); return ids[value]; } if (typeof value !== 'string' || !value) throw new Error('dependency must be a future ID or valid batch index'); return value; }))];
    });
    const indexes = new Map(ids.map((id, index) => [id,index])); const visiting = new Set(); const visited = new Set();
    const visit = index => { if (visiting.has(index)) throw new Error('cyclic batch dependencies'); if (visited.has(index)) return; visiting.add(index); dependencies[index].forEach(id => { if (indexes.has(id)) visit(indexes.get(id)); }); visiting.delete(index); visited.add(index); }; calls.forEach((_, index) => visit(index));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      calls.forEach((call, index) => this.db.prepare("INSERT INTO futures(id,batch_id,route_key,kind,tool,input,dependencies,state,detached,at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(ids[index], batchId, routeKey, 'generic', call.tool, json(this.replaceReferenceIndexes(call.input || {}, ids)), json(dependencies[index]), 'queued', 1, created, created));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    void this.tick(); return { state: 'pending', batch_id: batchId, futures: ids.map(id => ({ id, state: 'queued' })) };
  }

  async task(input, routing) {
    if (this.closing) throw new Error('Hearth is closing');
    if (input.operation === 'submit' && input.calls !== undefined) {
      if (input.job !== undefined || input.jobs !== undefined) throw new Error('calls and job/jobs are mutually exclusive');
      return this.submitCalls(input.calls, routing);
    }
    if (input.operation === 'submit') {
      const specs = input.jobs || [input.job || input];
      if (specs.length > 64) throw new Error('at most 64 jobs');
      if (Buffer.byteLength(json(specs)) > this.config.future_input_max_bytes) throw new Error('jobs input is too large');
      assertNoSecrets(specs);
      const ids = specs.map(() => randomUUID()); const created = now();
      const dependencies = specs.map((spec, index) => (spec.dependencies || []).map(value => {
        if (Number.isInteger(value)) { if (value < 0 || value >= ids.length || value === index) throw new Error(`invalid batch dependency index: ${value}`); return ids[value]; }
        if (typeof value !== 'string' || !value) throw new Error('dependency must be a job ID or valid batch index');
        return value;
      }));
      const indexes = new Map(ids.map((id, index) => [id, index])); const visiting = new Set(); const visited = new Set();
      const visit = index => {
        if (visiting.has(index)) throw new Error('cyclic batch dependencies');
        if (visited.has(index)) return;
        visiting.add(index); for (const id of dependencies[index]) if (indexes.has(id)) visit(indexes.get(id)); visiting.delete(index); visited.add(index);
      };
      specs.forEach((_, index) => visit(index));
      const routeKey = routing && this.ensureMailbox(routing);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        specs.forEach((spec, index) => {
          const runAt = spec.run_at || new Date(Date.now() + (spec.delay_ms || 0)).toISOString();
          this.db.prepare('INSERT INTO jobs(id,at,updated_at,state,run_at,spec,dependencies) VALUES(?,?,?,?,?,?,?)').run(ids[index], created, created, 'queued', runAt, json({ command: spec.command, args: spec.args || [], cwd: spec.cwd, env: spec.env, timeout_ms: spec.timeout_ms }), json(dependencies[index]));
          if (routeKey) this.db.prepare("INSERT INTO futures(id,route_key,kind,tool,dependencies,state,detached,at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(ids[index], routeKey, 'job', 'machine', '[]', 'running', 1, created, created);
          this.event('task.submitted', ids[index], { run_at: runAt, dependencies: dependencies[index] });
        });
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      void this.tick();
      return { state: 'pending', jobs: ids.map(id => ({ id, state: 'queued' })) };
    }
    if (input.operation === 'get' || input.operation === 'status') {
      const routeKey = routing && this.ensureMailbox(routing); const future = routeKey ? this.db.prepare('SELECT * FROM futures WHERE id=? AND route_key=?').get(input.id, routeKey) : this.db.prepare('SELECT * FROM futures WHERE id=?').get(input.id);
      const job = routeKey ? (future?.kind === 'job' ? this.db.prepare('SELECT * FROM jobs WHERE id=?').get(input.id) : null) : this.db.prepare('SELECT * FROM jobs WHERE id=?').get(input.id);
      if (job) return this.jobView(job);
      if (!future) throw new Error('job or future not found');
      return { id: future.id, batch_id: future.batch_id, state: future.state, tool: future.tool, created_at: future.at, updated_at: future.updated_at, dependencies: parse(future.dependencies, []), result: parse(future.result), error: future.error };
    }
    if (input.operation === 'list') {
      const limit = Math.min(100, Math.max(1, Number.isInteger(input.limit) ? input.limit : 100));
      if (!routing) return { state: 'completed', jobs: this.db.prepare('SELECT id,state,at,updated_at,run_at,error FROM jobs ORDER BY at DESC LIMIT ?').all(limit), futures: [] };
      const routeKey = this.ensureMailbox(routing); const futures = this.db.prepare('SELECT id,batch_id,kind,state,tool,at,updated_at,error FROM futures WHERE route_key=? ORDER BY at DESC LIMIT ?').all(routeKey, limit);
      const jobIds = futures.filter(row => row.kind === 'job').map(row => row.id); const jobs = jobIds.map(id => this.db.prepare('SELECT id,state,at,updated_at,run_at,error FROM jobs WHERE id=?').get(id)).filter(Boolean);
      return { state: 'completed', jobs, futures };
    }
    if (input.operation === 'cancel') {
      const routeKey = routing && this.ensureMailbox(routing); const future = routeKey ? this.db.prepare('SELECT id,kind,state FROM futures WHERE id=? AND route_key=?').get(input.id, routeKey) : this.db.prepare('SELECT id,kind,state FROM futures WHERE id=?').get(input.id);
      const row = routeKey ? (future?.kind === 'job' ? this.db.prepare('SELECT state FROM jobs WHERE id=?').get(input.id) : null) : this.db.prepare('SELECT state FROM jobs WHERE id=?').get(input.id);
      if (row) {
        if (['completed','blocked','cancelled'].includes(row.state)) return { state: 'superseded', id: input.id, previous_state: row.state };
        this.active.get(input.id)?.kill?.(); this.db.prepare("UPDATE jobs SET state='cancelled',updated_at=? WHERE id=?").run(now(), input.id); this.event('task.cancelled', input.id, {}); if (future) await this.completeFuture(input.id, { state: 'cancelled', id: input.id }, 'cancelled'); return { state: 'cancelled', id: input.id };
      }
      if (!future || future.kind !== 'generic') throw new Error('job or future not found');
      if (future.state === 'queued') {
        const state = this.cancelQueuedFuture(input.id); if (state === 'cancelled') return { state, id: input.id };
        if (state === 'running') return { state: 'blocked', id: input.id, error: 'running generic futures cannot be cancelled safely' };
        return { state: 'superseded', id: input.id, previous_state: state };
      }
      if (future.state === 'running') return { state: 'blocked', id: input.id, error: 'running generic futures cannot be cancelled safely' };
      return { state: 'superseded', id: input.id, previous_state: future.state };
    }
    if (input.operation === 'wait') {
      const deadline = Date.now() + Math.min(input.timeout_ms || 30_000, 120_000);
      while (Date.now() < deadline) { const result = await this.task({ operation: 'get', id: input.id }, routing); if (!['queued','running'].includes(result.state)) return result; await sleep(50); }
      return { state: 'pending', id: input.id };
    }
    throw new Error(`unsupported task operation: ${input.operation}`);
  }

  async tick() {
    if (!this.db || this.closing || this.ticking) return this.tickPromise; this.ticking = true;
    this.tickPromise = this.runTick();
    try { return await this.tickPromise; } finally { this.ticking = false; this.tickPromise = null; }
  }

  async runTick() {
    try {
      await this.tickRoutes();
      if (this.closing || !this.db) return;
      const dueContinuations = this.db.prepare("SELECT * FROM continuations WHERE state='scheduled' AND due_at<=?").all(now());
      for (const continuation of dueContinuations) {
        const built = this.buildOracle(continuation);
        this.db.prepare("UPDATE continuations SET state=?,result=? WHERE id=?").run(built.state, json(built), continuation.id);
        this.event('continuation.due', continuation.id, built);
      }
      const queued = this.db.prepare("SELECT * FROM jobs WHERE state='queued' AND run_at<=? ORDER BY run_at").all(now());
      for (const row of queued) {
        if (this.closing || this.active.size >= this.config.max_concurrent_jobs) break;
        const deps = parse(row.dependencies, []); let waiting = false; let failed = null;
        for (const id of deps) { const dep = this.db.prepare('SELECT state FROM jobs WHERE id=?').get(id); if (dep && !['queued','running','completed'].includes(dep.state)) { failed = id; break; } if (!dep || dep.state !== 'completed') waiting = true; }
        if (failed) { const error = `dependency did not complete: ${failed}`; this.db.prepare("UPDATE jobs SET state='blocked',updated_at=?,error=? WHERE id=?").run(now(), error, row.id); if (this.db.prepare('SELECT id FROM futures WHERE id=?').get(row.id)) await this.completeFuture(row.id, { state: 'blocked', error }, 'blocked'); continue; }
        if (waiting) continue;
        const claimed = this.db.prepare("UPDATE jobs SET state='running',updated_at=? WHERE id=? AND state='queued'").run(now(), row.id);
        if (!claimed.changes) continue;
        const controls = { cancelled: false }; const active = { promise: null, kill: () => { controls.cancelled = true; killProcess(controls.child); } };
        this.active.set(row.id, active);
        active.promise = Promise.resolve().then(() => this.exec(parse(row.spec), controls)).then(async result => {
          const existing = this.db.prepare('SELECT state FROM jobs WHERE id=?').get(row.id);
          if (existing?.state !== 'cancelled') this.db.prepare('UPDATE jobs SET state=?,updated_at=?,result=?,error=? WHERE id=?').run(result.state, now(), json(result), result.error || null, row.id);
          this.event('task.finished', row.id, { state: existing?.state === 'cancelled' ? 'cancelled' : result.state });
          if (this.db.prepare('SELECT id FROM futures WHERE id=?').get(row.id)) await this.completeFuture(row.id, existing?.state === 'cancelled' ? { state: 'cancelled', id: row.id } : result, existing?.state === 'cancelled' ? 'cancelled' : result.state);
        }).catch(async error => { if (this.db) { this.db.prepare("UPDATE jobs SET state='blocked',updated_at=?,error=? WHERE id=? AND state!='cancelled'").run(now(), error.message, row.id); if (this.db.prepare('SELECT id FROM futures WHERE id=?').get(row.id)) await this.completeFuture(row.id, { state: 'blocked', error: error.message }, 'blocked'); } }).finally(() => { this.active.delete(row.id); if (!this.closing) void this.tick(); });
      }
      const slots = this.config.max_concurrent_futures - this.futureActive.size;
      if (slots > 0) {
        const queuedFutures = this.db.prepare("SELECT * FROM futures WHERE kind='generic' AND state='queued' ORDER BY at").all();
        for (const row of queuedFutures) {
          if (this.closing || this.futureActive.size >= this.config.max_concurrent_futures) break;
          const deps = parse(row.dependencies, []); let waiting = false; let failed = null;
          for (const id of deps) { const dep = this.db.prepare('SELECT route_key,state FROM futures WHERE id=?').get(id); if (!dep || dep.route_key !== row.route_key) { failed = `dependency is missing: ${id}`; break; } if (dep.state !== 'completed') { if (['queued','running'].includes(dep.state)) waiting = true; else failed = `dependency did not complete: ${id} (${dep.state})`; break; } }
          if (failed) { await this.completeFuture(row.id, { state: 'blocked', error: failed }, 'blocked'); continue; }
          if (waiting) continue;
          const claimed = this.db.prepare("UPDATE futures SET state='running',started_at=?,updated_at=? WHERE id=? AND state='queued'").run(now(), now(), row.id); if (!claimed.changes) continue;
          const active = { promise: null }; this.futureActive.set(row.id, active);
          active.promise = Promise.resolve().then(() => this.resolveReferences(parse(row.input, {}), row.route_key, [])).then(input => this.executePrimitive(row.tool, input, { conversation_key: row.route_key, source: 'internal' })).then(result => this.completeFuture(row.id, result)).catch(error => this.completeFuture(row.id, { state: 'blocked', error: error.message }, 'blocked')).finally(() => { this.futureActive.delete(row.id); if (!this.closing) void this.tick(); });
        }
      }
    } finally {}
  }

  async tickRoutes() {
    if (this.closing) return;
    if (!this.binding) {
      const probes = this.db.prepare("SELECT * FROM mailboxes WHERE target_id IS NULL AND probe_nonce IS NOT NULL AND probe_expires_at>? AND (probe_next_at IS NULL OR probe_next_at<=?) LIMIT 4").all(now(), now());
      if (probes.length) {
        this.binding = true;
        const next = new Date(Date.now() + this.config.wake.probe_interval_ms).toISOString();
        const work = Promise.resolve().then(async () => {
          const targets = (await this.cdp.listTargets(this.config.wake.cdp_url)).filter(target => safeChatUrl(target.url));
          for (const mailbox of probes) {
            const found = await Promise.all(targets.map(async target => { try { return await this.cdp.contains(target, mailbox.probe_nonce) ? target : null; } catch { return null; } })); const matches = found.filter(Boolean);
            if (matches.length === 1) { const target = matches[0]; this.db.prepare('UPDATE mailboxes SET target_id=?,target_url=?,bound_at=?,probe_nonce=NULL,probe_expires_at=NULL,probe_next_at=NULL WHERE route_key=?').run(target.id, safeChatUrl(target.url), now(), mailbox.route_key); }
            else this.db.prepare('UPDATE mailboxes SET probe_next_at=? WHERE route_key=?').run(next, mailbox.route_key);
          }
        }).catch(error => { if (this.db) { probes.forEach(mailbox => this.db.prepare('UPDATE mailboxes SET probe_next_at=? WHERE route_key=?').run(next, mailbox.route_key)); this.event('route.bind_failed', null, { error: error.message }); } }).finally(() => { this.binding = false; this.detachedActive.delete(work); });
        this.detachedActive.add(work);
      }
    }
    if (this.config.wake.armed !== true || this.config.oracle.armed !== true || this.waking) return;
    const timestamp = now(); const quietCutoff = new Date(Date.now() - this.config.wake.quiet_ms).toISOString(); const cooldownCutoff = new Date(Date.now() - this.config.wake.cooldown_ms).toISOString();
    const routes = this.db.prepare("SELECT * FROM mailboxes WHERE target_id IS NOT NULL AND wake_claimed_at IS NULL AND wake_due_at IS NOT NULL AND wake_due_at<=? AND last_activity_at<=? AND (last_wake_at IS NULL OR last_wake_at<=?) AND wake_attempts<? AND EXISTS(SELECT 1 FROM futures WHERE route_key=mailboxes.route_key AND mailbox_seq>mailboxes.ack_seq) ORDER BY wake_due_at LIMIT 8").all(timestamp, quietCutoff, cooldownCutoff, this.config.wake.max_attempts);
    if (!routes.length) return;
    let targets; try { targets = await this.cdp.listTargets(this.config.wake.cdp_url); } catch (error) {
      const failedAt = now(); const retryAt = new Date(Date.now() + this.config.wake.cooldown_ms).toISOString();
      for (const route of routes) this.db.prepare('UPDATE mailboxes SET wake_attempts=wake_attempts+1,last_wake_at=?,wake_due_at=CASE WHEN wake_attempts+1>=? THEN NULL ELSE ? END WHERE route_key=?').run(failedAt, this.config.wake.max_attempts, retryAt, route.route_key);
      this.event('route.wake_validation_failed', null, { error: error.message }); return;
    }
    const route = routes.find(candidate => targets.some(target => target.id === candidate.target_id && safeChatUrl(target.url) === candidate.target_url));
    for (const candidate of routes.filter(candidate => !targets.some(target => target.id === candidate.target_id && safeChatUrl(target.url) === candidate.target_url))) this.db.prepare('UPDATE mailboxes SET target_id=NULL,target_url=NULL,bound_at=NULL,wake_due_at=NULL WHERE route_key=?').run(candidate.route_key);
    if (!route) return;
    const claimed = now(); const cursor = this.db.prepare('SELECT MAX(mailbox_seq) AS seq FROM futures WHERE route_key=?').get(route.route_key).seq; const update = this.db.prepare('UPDATE mailboxes SET wake_claimed_at=?,wake_due_at=NULL,wake_attempts=wake_attempts+1,last_wake_at=?,wake_cursor=? WHERE route_key=? AND wake_claimed_at IS NULL').run(claimed, claimed, cursor, route.route_key); if (!update.changes) return;
    this.waking = true;
    const wake = this.exec({ command: this.config.oracle.command, args: ['--engine','browser','--browser-attach-running','--remote-chrome',new URL(this.config.wake.cdp_url).host,'--browser-tab',route.target_id,'--browser-model-strategy','current','--no-notify','Continue this conversation and call Hearth once to consume ready arrivals.'], timeout_ms: this.config.wake.timeout_ms }, { inlineLimit: 4096 }).then(result => this.event('route.wake', null, { state: result.state })).catch(error => this.event('route.wake', null, { state: 'blocked', error: error.message })).finally(() => {
      if (this.db) {
        const current = this.db.prepare('SELECT ack_seq,wake_attempts,wake_due_at FROM mailboxes WHERE route_key=?').get(route.route_key); const max = this.db.prepare('SELECT MAX(mailbox_seq) AS seq FROM futures WHERE route_key=?').get(route.route_key).seq;
        const retry = current.ack_seq < max && current.wake_attempts < this.config.wake.max_attempts ? current.wake_due_at || new Date(Date.now() + this.config.wake.cooldown_ms).toISOString() : null;
        this.db.prepare('UPDATE mailboxes SET wake_claimed_at=NULL,wake_due_at=? WHERE route_key=?').run(retry, route.route_key);
      }
      this.waking = false; this.detachedActive.delete(wake);
    });
    this.detachedActive.add(wake);
  }

  substitute(value, params) {
    if (typeof value === 'string') return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, key) => { if (!(key in params)) throw new Error(`missing parameter: ${key}`); return String(params[key]); });
    if (Array.isArray(value)) return value.map(item => this.substitute(item, params));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.substitute(item, params)]));
    return value;
  }

  async runRecipe(name, params = {}) {
    const row = this.db.prepare('SELECT * FROM recipes WHERE name=?').get(name); if (!row) throw new Error('recipe not found');
    const definition = parse(row.definition); const traceId = randomUUID(); const results = [];
    if (definition.steps.length > this.config.recipe_max_steps) throw new Error('recipe step limit exceeded');
    try {
      assertRecipeNoScatter(definition);
      for (let i = 0; i < definition.steps.length; i++) {
        const step = this.substitute(definition.steps[i], params); this.db.prepare('INSERT INTO traces(at,trace_id,position,operation) VALUES(?,?,?,?)').run(now(), traceId, i, step.primitive);
        if (step.primitive === 'machine.exec') results.push(await this.exec(step.input));
        else if (step.primitive === 'fs.read') results.push(await this.fsTool({ ...step.input, operation: 'read' }));
        else if (step.primitive === 'fs.write') results.push(await this.fsTool({ ...step.input, operation: 'write' }));
        else if (step.primitive === 'fs.patch') results.push(await this.fsTool({ ...step.input, operation: 'patch' }));
        else if (step.primitive === 'task.submit') results.push(await this.task({ ...step.input, operation: 'submit' }));
        else throw new Error(`recipe primitive not allowed: ${step.primitive}`);
        if (results.at(-1)?.state === 'blocked' || results.at(-1)?.state === 'conflict') throw new Error(`step ${i} ${results.at(-1).state}`);
      }
      this.db.prepare('UPDATE recipes SET runs=runs+1,last_run=? WHERE name=?').run(now(), name); this.event('recipe.ran', name, { trace_id: traceId, state: 'completed' });
      return { state: 'completed', name, trace_id: traceId, results };
    } catch (error) { this.db.prepare('UPDATE recipes SET runs=runs+1,failures=failures+1,last_run=? WHERE name=?').run(now(), name); this.event('recipe.ran', name, { trace_id: traceId, state: 'blocked', error: error.message }); return { state: 'blocked', name, trace_id: traceId, results, error: error.message }; }
  }

  recipe(input) {
    if (input.operation === 'create') {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(input.name)) throw new Error('invalid recipe name');
      const definition = { description: input.description || '', steps: input.steps || [] }; if (!definition.steps.length || definition.steps.length > this.config.recipe_max_steps) throw new Error('recipe requires bounded steps'); assertNoSecrets(definition); assertRecipeNoScatter(definition);
      this.db.prepare('INSERT INTO recipes(name,at,definition) VALUES(?,?,?)').run(input.name, now(), json(definition)); this.event('recipe.created', input.name, { steps: definition.steps.length }); return { state: 'completed', name: input.name };
    }
    if (input.operation === 'list') return { state: 'completed', recipes: this.db.prepare('SELECT name,at,runs,failures,last_run FROM recipes ORDER BY name').all() };
    if (input.operation === 'get' || input.operation === 'stats') { const row = this.db.prepare('SELECT * FROM recipes WHERE name=?').get(input.name); if (!row) throw new Error('recipe not found'); return { state: 'completed', ...row, definition: parse(row.definition) }; }
    if (input.operation === 'run') return this.runRecipe(input.name, input.params || {});
    if (input.operation === 'delete') { const result = this.db.prepare('DELETE FROM recipes WHERE name=?').run(input.name); return { state: result.changes ? 'completed' : 'superseded', name: input.name }; }
    if (input.operation === 'suggest') {
      const threshold = Math.max(2, input.threshold || 3); const minLength = Math.max(2, input.min_length || 2); const traces = new Map();
      for (const row of this.db.prepare('SELECT trace_id,position,operation FROM traces ORDER BY trace_id,position').all()) { if (!traces.has(row.trace_id)) traces.set(row.trace_id, []); traces.get(row.trace_id).push(row.operation); }
      const counts = new Map(); for (const ops of traces.values()) for (let size = minLength; size <= Math.min(5, ops.length); size++) for (let i = 0; i <= ops.length - size; i++) { const key = ops.slice(i, i + size).join(' -> '); counts.set(key, (counts.get(key) || 0) + 1); }
      const suggestions = [...counts].filter(([, count]) => count >= threshold).sort((a,b) => b[1] - a[1]).map(([pattern,count]) => ({ pattern: pattern.split(' -> '), count })); return { state: 'completed', suggestions };
    }
    throw new Error(`unsupported recipe operation: ${input.operation}`);
  }

  buildOracle(continuation) {
    const target = parse(continuation.target, {}) || {}; const args = [];
    if (target.session) args.push('--followup', target.session); else if (target.browser_tab) args.push('--browser-tab', target.browser_tab); else return { state: 'blocked', reason: 'continuation is due but no Oracle session or browser_tab target is configured' };
    args.push(continuation.prompt);
    if (!this.config.oracle.armed) return { state: 'pending', due: true, dry_run: true, command: this.config.oracle.command, args };
    return { state: 'pending', due: true, dry_run: false, command: this.config.oracle.command, args, reason: 'armed adapter command is exposed for explicit execution; no secrets are stored' };
  }

  async run(input) {
    if (input.operation === 'checkpoint') {
      const id = input.id || randomUUID(); const existing = this.db.prepare('SELECT state,at FROM runs WHERE id=?').get(id); const body = { objective: input.objective, acceptance_criteria: input.acceptance_criteria || [], summary: input.summary || '', next_actions: input.next_actions || [], pending_task_ids: input.pending_task_ids || [] }; assertNoSecrets(body); const at = now();
      if (existing) this.db.prepare("UPDATE runs SET updated_at=?,state='open',body=? WHERE id=?").run(at, json(body), id); else this.db.prepare("INSERT INTO runs(id,at,updated_at,state,body) VALUES(?,?,?,?,?)").run(id, at, at, 'open', json(body));
      this.event('run.checkpoint', id, body); return { state: 'completed', id, run_state: 'open', ...body };
    }
    if (input.operation === 'list') return { state: 'completed', runs: this.db.prepare('SELECT id,at,updated_at,state,body FROM runs ORDER BY updated_at DESC LIMIT ?').all(input.limit || 100).map(row => ({ ...row, body: parse(row.body) })) };
    if (input.operation === 'get') {
      const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(input.id); if (!row) throw new Error('run not found'); const continuations = this.db.prepare('SELECT id,due_at,state,target,prompt,result FROM continuations WHERE run_id=? ORDER BY due_at').all(input.id).map(c => ({ ...c, target: parse(c.target), result: parse(c.result) })); return { state: 'completed', run: { ...row, body: parse(row.body), continuations } };
    }
    if (input.operation === 'close') { const result = this.db.prepare("UPDATE runs SET state='closed',updated_at=? WHERE id=? AND state='open'").run(now(), input.id); this.event('run.closed', input.id, {}); return { state: result.changes ? 'completed' : 'superseded', id: input.id, run_state: 'closed' }; }
    if (input.operation === 'schedule_continuation') {
      const run = this.db.prepare('SELECT id FROM runs WHERE id=?').get(input.run_id); if (!run) throw new Error('run not found'); const id = randomUUID(); const dueAt = input.run_at || new Date(Date.now() + (input.delay_ms || 0)).toISOString(); const target = input.target || null; assertNoSecrets({ target, prompt: input.prompt });
      this.db.prepare("INSERT INTO continuations(id,run_id,at,due_at,state,target,prompt) VALUES(?,?,?,?,?,?,?)").run(id, input.run_id, now(), dueAt, 'scheduled', target ? json(target) : null, input.prompt || 'Continue the stored Hearth run.'); this.event('continuation.scheduled', id, { run_id: input.run_id, due_at: dueAt }); void this.tick(); return { state: 'pending', id, due_at: dueAt, armed: Boolean(this.config.oracle.armed), target_configured: Boolean(target?.session || target?.browser_tab) };
    }
    if (input.operation === 'continuation_status') { const row = this.db.prepare('SELECT * FROM continuations WHERE id=?').get(input.id); if (!row) throw new Error('continuation not found'); return { state: row.state, ...row, target: parse(row.target), result: parse(row.result) }; }
    if (input.operation === 'events') {
      const limit = Math.min(input.limit || 100, 1000); const rows = input.entity_id ? this.db.prepare('SELECT * FROM events WHERE entity_id=? ORDER BY id DESC LIMIT ?').all(input.entity_id, limit) : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
      return { state: 'completed', events: rows.map(row => ({ ...row, data: parse(row.data) })) };
    }
    throw new Error(`unsupported run operation: ${input.operation}`);
  }

  async ui(input) {
    const operation = async () => {
      if (input.allow_fallback && !input.hwnd && !input.process_id) return { state: 'blocked', limitation: 'fallback input requires an explicit hwnd or process_id scope' };
      if (process.platform !== 'win32') return { state: 'blocked', limitation: 'Windows UI Automation requires an interactive Windows desktop session' };
      const payload = Buffer.from(JSON.stringify(input)).toString('base64');
      const result = await this.exec({ command: 'powershell.exe', args: ['-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',path.join(here,'uia.ps1'),'-RequestBase64',payload], timeout_ms: Math.min(input.timeout_ms || 15_000, 30_000), cwd: this.config.roots[0] }, { inlineLimit: this.config.max_artifact_bytes });
      const text = result.output || ''; const line = text.split(/\r?\n/).find(value => value.startsWith('[stdout] '));
      if (!line) return { ...result, state: 'blocked', limitation: 'UIA bridge returned no structured response' };
      const parsed = parse(line.slice(9), { state: 'blocked', limitation: 'UIA bridge returned malformed JSON' });
      if (Buffer.byteLength(line) <= this.config.max_output_bytes) return parsed;
      const artifact = await this.putArtifact(line.slice(9), 'application/json');
      return { state: 'partial', node_count: parsed.node_count, truncated: true, errors: parsed.errors || [], artifact, preview: line.slice(9, 9 + this.config.artifact_preview_bytes) };
    };
    const promise = this.uiTail.then(operation, operation); this.uiTail = promise.catch(() => {}); return promise;
  }

  executePrimitive(tool, input, routing) {
    if (tool === 'machine') return this.machine(input);
    if (tool === 'fs') return this.fsTool(input);
    if (tool === 'task') return this.task(input, routing);
    if (tool === 'artifact') return this.artifact(input);
    if (tool === 'ui') return this.ui(input);
    if (tool === 'recipe') return this.recipe(input);
    if (tool === 'run') return this.run(input);
    throw new Error('unknown tool');
  }

  routeProbe(routeKey) {
    const mailbox = this.db.prepare('SELECT source,target_id,probe_nonce,probe_expires_at FROM mailboxes WHERE route_key=?').get(routeKey);
    if (mailbox.source !== 'openai' || mailbox.target_id) return null;
    if (!mailbox.probe_nonce || Date.parse(mailbox.probe_expires_at) <= Date.now()) {
      const nonce = `hearth-route:${randomUUID()}`; const expires = new Date(Date.now() + this.config.wake.probe_ttl_ms).toISOString();
      this.db.prepare('UPDATE mailboxes SET probe_nonce=?,probe_expires_at=?,probe_next_at=? WHERE route_key=?').run(nonce, expires, now(), routeKey); void this.tick();
      return { nonce, expires_at: expires };
    }
    return { nonce: mailbox.probe_nonce, expires_at: mailbox.probe_expires_at };
  }

  async dispatch(tool, input, routing = {}) {
    if (this.closing) throw new Error('Hearth is closing');
    const routeKey = this.beginRequest(routing); const id = randomUUID(); const created = now();
    this.db.prepare("INSERT INTO futures(id,route_key,kind,tool,dependencies,state,detached,at,updated_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, routeKey, 'dispatch', tool, '[]', 'running', 0, created, created, created);
    let finished = false; let detached = false; let value; let failed = false;
    const operation = Promise.resolve().then(() => this.executePrimitive(tool, input, routing)).then(async output => { finished = true; value = output; if (detached) await this.completeFuture(id, output); return output; }).catch(async error => { finished = true; failed = true; value = { state: 'blocked', error: error.message }; this.event('tool.error', tool, value); if (detached) await this.completeFuture(id, value, 'blocked'); return value; });
    const won = await Promise.race([operation.then(() => true), sleep(this.config.dispatch_inline_budget_ms).then(() => false)]);
    if (won && finished) { this.db.prepare('DELETE FROM futures WHERE id=?').run(id); const probe = value?.state === 'pending' && this.routeProbe(routeKey); return this.dispatchResult(value, routeKey, failed, probe ? { route_probe: probe } : {}); }
    const arrivals = this.offerArrivals(routeKey); detached = true; this.db.prepare('UPDATE futures SET detached=1 WHERE id=?').run(id);
    if (finished) await this.completeFuture(id, value, failed ? 'blocked' : undefined);
    const probe = this.routeProbe(routeKey); const output = { state: 'pending', future_id: id, ...(probe && { route_probe: probe }), arrivals };
    const tracked = operation.finally(() => this.detachedActive.delete(tracked)); this.detachedActive.add(tracked);
    return this.result(output);
  }
}
