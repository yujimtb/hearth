import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const sha256 = data => createHash('sha256').update(data).digest('hex');
const json = value => JSON.stringify(value);
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const assertNoSecrets = value => {
  const visit = (item, key = '') => {
    if (/(secret|token|password|api.?key|credential|authorization)/i.test(key)) throw new Error(`refusing to persist secret-like field: ${key}`);
    if (typeof item === 'string' && /\b(?:sk|Bearer)[-_ ][A-Za-z0-9_-]{12,}/i.test(item)) throw new Error('refusing to persist secret-like value');
    if (Array.isArray(item)) item.forEach(entry => visit(entry));
    else if (item && typeof item === 'object') Object.entries(item).forEach(([name, entry]) => visit(entry, name));
  };
  visit(value);
};

export async function loadConfig(file = process.env.HEARTH_CONFIG || 'config.json') {
  const defaults = {
    host: '127.0.0.1', port: 3000, data_dir: '.hearth',
    roots: [path.resolve('..'), path.resolve('../../work')], command_timeout_ms: 30_000,
    max_output_bytes: 65_536, artifact_preview_bytes: 4096, max_artifact_bytes: 16 * 1024 * 1024,
    max_concurrent_jobs: 4, recipe_max_steps: 50,
    oracle: { command: 'C:\\nvm4w\\nodejs\\oracle.cmd', armed: false }
  };
  let supplied = {};
  try { supplied = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = { ...defaults, ...supplied, oracle: { ...defaults.oracle, ...supplied.oracle } };
  config.data_dir = path.resolve(config.data_dir);
  config.roots = config.roots.map(root => path.resolve(root));
  if (config.host !== '127.0.0.1' && config.host !== '::1' && config.host !== 'localhost') throw new Error('Hearth v0 only binds localhost');
  return config;
}

export class Hearth {
  constructor(config) {
    this.config = config;
    this.db = null;
    this.timer = null;
    this.active = new Map();
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
      CREATE INDEX IF NOT EXISTS idx_jobs_state_run ON jobs(state, run_at);
      CREATE INDEX IF NOT EXISTS idx_cont_state_due ON continuations(state, due_at);
      CREATE INDEX IF NOT EXISTS idx_traces_trace_pos ON traces(trace_id, position);`);
    this.db.prepare("UPDATE jobs SET state='queued', updated_at=? WHERE state='running'").run(now());
    this.event('runtime.started', null, { pid: process.pid });
    this.timer = setInterval(() => { void this.tick(); }, 100);
    this.timer.unref();
    await this.tick();
    return this;
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    for (const child of this.active.values()) child.kill?.();
    await Promise.allSettled([...this.active.values()].map(item => item.promise));
    this.event('runtime.stopped', null, {});
    this.db.close();
  }

  event(kind, entityId, data) {
    this.db.prepare('INSERT INTO events(at,kind,entity_id,data) VALUES(?,?,?,?)').run(now(), kind, entityId, json(data));
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
    const timeoutMs = Math.min(Math.max(spec.timeout_ms || this.config.command_timeout_ms, 1), 300_000);
    const started = Date.now();
    const env = { ...process.env, ...(spec.env || {}) };
    return await new Promise(resolve => {
      const child = spawn(spec.command, spec.args || [], { cwd, env, shell: false, windowsHide: true });
      controls.child = child;
      const chunks = []; let bytes = 0; let overflow = false; let timedOut = false;
      const collect = (source, chunk) => {
        if (bytes < this.config.max_artifact_bytes) { const keep = chunk.subarray(0, this.config.max_artifact_bytes - bytes); chunks.push(Buffer.from(`[${source}] `), keep); bytes += keep.length + source.length + 3; }
        if (bytes >= this.config.max_artifact_bytes) { overflow = true; child.kill(); }
      };
      child.stdout.on('data', chunk => collect('stdout', chunk));
      child.stderr.on('data', chunk => collect('stderr', chunk));
      const timer = setTimeout(() => { timedOut = true; child.kill(); setTimeout(() => child.kill('SIGKILL'), 500).unref(); }, timeoutMs);
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

  async task(input) {
    if (input.operation === 'submit') {
      const specs = input.jobs || [input.job || input];
      if (specs.length > 64) throw new Error('at most 64 jobs');
      assertNoSecrets(specs);
      const ids = specs.map(() => randomUUID()); const created = now();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        specs.forEach((spec, index) => {
          const runAt = spec.run_at || new Date(Date.now() + (spec.delay_ms || 0)).toISOString();
          const dependencies = (spec.dependencies || []).map(value => {
            if (Number.isInteger(value)) { if (value < 0 || value >= ids.length || value === index) throw new Error(`invalid batch dependency index: ${value}`); return ids[value]; }
            if (typeof value !== 'string' || !value) throw new Error('dependency must be a job ID or valid batch index');
            return value;
          });
          this.db.prepare('INSERT INTO jobs(id,at,updated_at,state,run_at,spec,dependencies) VALUES(?,?,?,?,?,?,?)').run(ids[index], created, created, 'queued', runAt, json({ command: spec.command, args: spec.args || [], cwd: spec.cwd, env: spec.env, timeout_ms: spec.timeout_ms }), json(dependencies));
          this.event('task.submitted', ids[index], { run_at: runAt, dependencies });
        });
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      void this.tick();
      return { state: 'pending', jobs: ids.map(id => ({ id, state: 'queued' })) };
    }
    if (input.operation === 'get' || input.operation === 'status') { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(input.id); if (!row) throw new Error('job not found'); return this.jobView(row); }
    if (input.operation === 'list') return { state: 'completed', jobs: this.db.prepare('SELECT * FROM jobs ORDER BY at DESC LIMIT ?').all(input.limit || 100).map(row => this.jobView(row)) };
    if (input.operation === 'cancel') {
      const row = this.db.prepare('SELECT state FROM jobs WHERE id=?').get(input.id); if (!row) throw new Error('job not found');
      if (['completed','blocked','cancelled'].includes(row.state)) return { state: 'superseded', id: input.id, previous_state: row.state };
      this.active.get(input.id)?.kill?.(); this.db.prepare("UPDATE jobs SET state='cancelled',updated_at=? WHERE id=?").run(now(), input.id); this.event('task.cancelled', input.id, {}); return { state: 'cancelled', id: input.id };
    }
    if (input.operation === 'wait') {
      const deadline = Date.now() + Math.min(input.timeout_ms || 30_000, 120_000);
      while (Date.now() < deadline) { const result = await this.task({ operation: 'get', id: input.id }); if (!['queued','running'].includes(result.state)) return result; await sleep(50); }
      return { state: 'pending', id: input.id };
    }
    throw new Error(`unsupported task operation: ${input.operation}`);
  }

  async tick() {
    if (!this.db || this.ticking) return; this.ticking = true;
    try {
      const dueContinuations = this.db.prepare("SELECT * FROM continuations WHERE state='scheduled' AND due_at<=?").all(now());
      for (const continuation of dueContinuations) {
        const built = this.buildOracle(continuation);
        this.db.prepare("UPDATE continuations SET state=?,result=? WHERE id=?").run(built.state, json(built), continuation.id);
        this.event('continuation.due', continuation.id, built);
      }
      if (this.active.size >= this.config.max_concurrent_jobs) return;
      const queued = this.db.prepare("SELECT * FROM jobs WHERE state='queued' AND run_at<=? ORDER BY run_at LIMIT ?").all(now(), this.config.max_concurrent_jobs * 2);
      for (const row of queued) {
        if (this.active.size >= this.config.max_concurrent_jobs) break;
        const deps = parse(row.dependencies, []); let waiting = false; let failed = null;
        for (const id of deps) { const dep = this.db.prepare('SELECT state FROM jobs WHERE id=?').get(id); if (!dep || !['queued','running','completed'].includes(dep.state)) { failed = id; break; } if (dep.state !== 'completed') waiting = true; }
        if (failed) { this.db.prepare("UPDATE jobs SET state='blocked',updated_at=?,error=? WHERE id=?").run(now(), `dependency did not complete: ${failed}`, row.id); continue; }
        if (waiting) continue;
        this.db.prepare("UPDATE jobs SET state='running',updated_at=? WHERE id=? AND state='queued'").run(now(), row.id);
        const controls = {}; const promise = this.exec(parse(row.spec), controls).then(result => {
          const existing = this.db.prepare('SELECT state FROM jobs WHERE id=?').get(row.id);
          if (existing?.state !== 'cancelled') this.db.prepare('UPDATE jobs SET state=?,updated_at=?,result=?,error=? WHERE id=?').run(result.state, now(), json(result), result.error || null, row.id);
          this.event('task.finished', row.id, { state: existing?.state === 'cancelled' ? 'cancelled' : result.state });
        }).catch(error => this.db.prepare("UPDATE jobs SET state='blocked',updated_at=?,error=? WHERE id=?").run(now(), error.message, row.id)).finally(() => { this.active.delete(row.id); void this.tick(); });
        this.active.set(row.id, { promise, kill: () => controls.child?.kill() });
      }
    } finally { this.ticking = false; }
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
      for (let i = 0; i < definition.steps.length; i++) {
        const step = this.substitute(definition.steps[i], params); this.db.prepare('INSERT INTO traces(at,trace_id,position,operation) VALUES(?,?,?,?)').run(now(), traceId, i, step.primitive);
        if (step.primitive === 'machine.exec') results.push(await this.exec(step.input));
        else if (step.primitive === 'fs.read') results.push(await this.fsTool({ operation: 'read', ...step.input }));
        else if (step.primitive === 'fs.write') results.push(await this.fsTool({ operation: 'write', ...step.input }));
        else if (step.primitive === 'fs.patch') results.push(await this.fsTool({ operation: 'patch', ...step.input }));
        else if (step.primitive === 'task.submit') results.push(await this.task({ operation: 'submit', ...step.input }));
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
      const definition = { description: input.description || '', steps: input.steps || [] }; if (!definition.steps.length || definition.steps.length > this.config.recipe_max_steps) throw new Error('recipe requires bounded steps'); assertNoSecrets(definition);
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

  async dispatch(tool, input) {
    try {
      const output = tool === 'machine' ? await this.machine(input) : tool === 'fs' ? await this.fsTool(input) : tool === 'task' ? await this.task(input) : tool === 'artifact' ? await this.artifact(input) : tool === 'ui' ? await this.ui(input) : tool === 'recipe' ? await this.recipe(input) : tool === 'run' ? await this.run(input) : (() => { throw new Error('unknown tool'); })();
      return this.result(output);
    } catch (error) {
      const output = { state: 'blocked', error: error.message }; this.event('tool.error', tool, output); return { ...this.result(output), isError: true };
    }
  }
}
