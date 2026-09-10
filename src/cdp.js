const loopback = hostname => ['127.0.0.1', 'localhost', '::1'].includes(hostname);
const timeout = (promise, ms, message) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
]);

export function safeChatUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || !['chatgpt.com', 'chat.openai.com'].includes(url.hostname) || !/^\/c\/[A-Za-z0-9-]+\/?$/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/$/, ''); url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}

function safeWebSocketUrl(value, endpoint) {
  try {
    const socket = new URL(value); const base = new URL(endpoint);
    if (socket.protocol !== 'ws:' || socket.username || socket.password || !loopback(socket.hostname)) return null;
    if (socket.port !== base.port) return null;
    return socket.toString();
  } catch { return null; }
}

export async function listCdpTargets(endpoint, timeoutMs = 2000) {
  const base = new URL(endpoint);
  if (!loopback(base.hostname) || base.protocol !== 'http:' || base.username || base.password) throw new Error('CDP endpoint must be loopback HTTP');
  const response = await timeout(fetch(new URL('/json/list', base), { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }), timeoutMs, 'CDP target list timed out');
  if (!response.ok) throw new Error(`CDP target list failed: ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('CDP target list was not an array');
  return rows.slice(0, 64).filter(row => row?.type === 'page' && typeof row.id === 'string' && row.id.length <= 256 && safeChatUrl(row.url) && safeWebSocketUrl(row.webSocketDebuggerUrl, base));
}

export async function targetContains(target, nonce, endpoint, timeoutMs = 2000) {
  const socketUrl = safeWebSocketUrl(target?.webSocketDebuggerUrl, endpoint);
  if (!socketUrl) throw new Error('unsafe CDP websocket URL');
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl); let settled = false; let expanded = false;
    const finish = (error, value = false) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.close(); } catch {} error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('CDP evaluation timed out')), timeoutMs);
    const needle = JSON.stringify(nonce);
    const check = `Boolean(document.documentElement?.innerText?.includes(${needle}))`;
    // ponytail: one scoped disclosure click only; use a DOM-specific adapter if ChatGPT markup changes.
    const expand = `(() => { for (const button of document.querySelectorAll('button[aria-expanded="false"]')) { let node=button; for(let depth=0;node&&depth<4;depth++,node=node.parentElement) { const text=(node.innerText||'').slice(0,4000).toLowerCase(); if (text.includes('hearth')&&['tool','output','result'].some(word=>text.includes(word))) { button.click(); return true; } } } return false; })()`;
    const evaluate = (id, expression) => socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    socket.addEventListener('open', () => evaluate(1, check));
    socket.addEventListener('message', event => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id === 1) {
        if (message.result?.result?.value === true) finish(null, true);
        else evaluate(2, expand);
      } else if (message.id === 2) {
        if (message.result?.result?.value === true) { expanded = true; evaluate(3, check); }
        else finish(null, false);
      } else if (message.id === 3 && expanded) finish(null, message.result?.result?.value === true);
    });
    socket.addEventListener('error', () => finish(new Error('CDP websocket failed')));
    socket.addEventListener('close', () => finish(null, false));
  });
}
