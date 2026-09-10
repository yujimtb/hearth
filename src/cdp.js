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


export async function sendChatPrompt(target, prompt, endpoint, timeoutMs = 30000) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) throw new Error('bounded wake prompt required');
  if (!safeChatUrl(target?.url)) throw new Error('unsafe ChatGPT target URL');
  const socketUrl = safeWebSocketUrl(target?.webSocketDebuggerUrl, endpoint);
  if (!socketUrl) throw new Error('unsafe CDP websocket URL');
  const socket = new WebSocket(socketUrl); let seq = 0; const pending = new Map(); let closed = false;
  const close = error => {
    if (closed) return; closed = true;
    for (const waiter of pending.values()) waiter.reject(error || new Error('CDP websocket closed')); pending.clear();
    try { socket.close(); } catch {}
  };
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP websocket open timed out')), timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket failed')); }, { once: true });
  });
  socket.addEventListener('message', event => {
    let message; try { message = JSON.parse(String(event.data)); } catch { return; }
    const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || 'CDP command failed')); else waiter.resolve(message.result);
  });
  socket.addEventListener('close', () => close(new Error('CDP websocket closed')));
  const rpc = (method, params = {}) => timeout(new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  }), timeoutMs, `CDP ${method} timed out`);
  try {
    await opened;
    const focus = await rpc('Runtime.evaluate', { expression: `(() => { const e=document.querySelector('#prompt-textarea[contenteditable="true"]'); if(!e) return false; e.focus(); const s=getSelection(),r=document.createRange(); r.selectNodeContents(e); s.removeAllRanges(); s.addRange(r); return true; })()`, returnByValue: true });
    if (focus?.result?.value !== true) throw new Error('ChatGPT composer not available');
    await rpc('Input.insertText', { text: prompt });
    const needle = JSON.stringify(prompt);
    const inserted = await rpc('Runtime.evaluate', { expression: `Boolean((document.querySelector('#prompt-textarea[contenteditable="true"]')?.innerText||'').includes(${needle}))`, returnByValue: true });
    if (inserted?.result?.value !== true) throw new Error('wake prompt was not inserted');
    await rpc('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await new Promise(resolve => setTimeout(resolve, 250));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await rpc('Runtime.evaluate', { expression: `(() => { const composer=(document.querySelector('#prompt-textarea[contenteditable="true"]')?.innerText||''); return { inComposer: composer.includes(${needle}), inConversation: document.documentElement?.innerText?.includes(${needle}) === true }; })()`, returnByValue: true });
      const value = status?.result?.value;
      if (value && value.inComposer === false) return { state: 'completed', confirmation: value.inConversation ? 'conversation' : 'composer-cleared' };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('wake prompt remained in composer');
  } finally { close(); }
}
