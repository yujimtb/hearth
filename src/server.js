import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { Hearth, loadConfig } from './hearth.js';

const toolDescriptions = {
  machine: 'Host info, bounded foreground/parallel exec, and process list/kill.',
  fs: 'Contained list/read/search/stat and atomic write/patch/undo with SHA-256 concurrency.',
  task: 'Immediate-return durable exec jobs and heterogeneous dependent future calls with status/wait/cancel/list.',
  artifact: 'Metadata, bounded range reads, and search for spilled large output.',
  ui: 'Serialized normalized Windows UI Automation snapshot/query/action.',
  recipe: 'Bounded declarative recipes, parameters, stats, traces, and repetition suggestions.',
  run: 'Durable checkpoints and explicit delayed Oracle continuation records.'
};

const fingerprint = value => createHash('sha256').update(value).digest('hex');

export function normalizeRouting(meta = {}, requestId, fallbackSeed = randomUUID()) {
  const openaiSession = typeof meta['openai/session'] === 'string' && meta['openai/session'].trim() && meta['openai/session'].length <= 4096 ? meta['openai/session'] : null;
  const localConversation = typeof meta['hearth/conversation'] === 'string' && meta['hearth/conversation'].trim() && meta['hearth/conversation'].length <= 4096 ? meta['hearth/conversation'] : null;
  const prefix = typeof requestId === 'string' ? requestId.split('/', 1)[0].trim() : '';
  return {
    conversation_key: openaiSession ? `openai:${fingerprint(openaiSession)}` : `local:${fingerprint(`hearth-local\0${localConversation || fallbackSeed}`)}`,
    source: openaiSession ? 'openai' : 'local',
    ...(prefix && { turn_key: fingerprint(prefix) })
  };
}

export function createHandler(hearth) {
  return createMcpHandler(({ requestInfo }) => {
    const requestId = requestInfo?.headers.get('x-request-id'); const requestFallback = randomUUID();
    const server = new McpServer(
      { name: 'hearth', version: '0.1.0' },
      { capabilities: { tools: {} }, instructions: 'Local-first Windows operation. All results expose explicit state.' }
    );
    for (const [name, description] of Object.entries(toolDescriptions)) {
      server.registerTool(name, { description, inputSchema: z.object({ operation: z.string() }).loose() }, (input, ctx) => hearth.dispatch(name, input, normalizeRouting(ctx.mcpReq._meta, requestId, ctx.sessionId || requestFallback)));
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
