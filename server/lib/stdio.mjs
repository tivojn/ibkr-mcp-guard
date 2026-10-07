// Newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio transport), server side.
// handler(message) is called for each request/notification from the client; its return value (for a request) is
// sent back as the result, a thrown {code, message} as the error. request(method, params) sends a request to the
// client (e.g. elicitation/create) and resolves with its result.

export function createStdioServer({ input = process.stdin, output = process.stdout, handler, onClose = () => {} }) {
  let buffer = '';
  let nextId = 1;
  const waiting = new Map();
  const LIMIT = 16 * 1024 * 1024;

  const write = m => { output.write(JSON.stringify(m) + '\n'); };

  let inflight = 0;
  let ended = false;
  const maybeClose = () => { if (ended && inflight === 0) onClose(); };

  async function dispatch(m) {
    inflight++;
    try { await answer(m); } finally { inflight--; maybeClose(); }
  }

  async function answer(m) {
    const isRequest = m && typeof m === 'object' && typeof m.method === 'string' && 'id' in m && m.id !== null;
    try {
      const result = await handler(m);
      if (isRequest) write({ jsonrpc: '2.0', id: m.id, result: result ?? {} });
    } catch (e) {
      if (isRequest) write({ jsonrpc: '2.0', id: m.id, error: { code: Number.isInteger(e?.code) ? e.code : -32603, message: String(e?.message || 'Internal error').slice(0, 1000) } });
    }
  }

  function take(line) {
    let m;
    try { m = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    for (const one of Array.isArray(m) ? m : [m]) {
      if (!one || typeof one !== 'object') continue;
      if (typeof one.method !== 'string' && 'id' in one) {
        const w = waiting.get(one.id);
        if (w) { waiting.delete(one.id); clearTimeout(w.timer); if (one.error) w.reject(Object.assign(new Error(one.error.message || 'Client error'), { code: one.error.code })); else w.resolve(one.result); }
        continue;
      }
      void dispatch(one);
    }
  }

  input.setEncoding?.('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > LIMIT) { buffer = ''; return; }
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) take(line);
    }
  });
  input.on('end', () => {
    for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error('The client disconnected.')); }
    waiting.clear();
    ended = true;
    maybeClose();
  });

  return {
    notify(method, params) { write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); },
    request(method, params, { timeoutMs = 5 * 60 * 1000 } = {}) {
      const id = 'guard-' + nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(Object.assign(new Error('The client did not answer in time.'), { code: 'timeout' })); }, timeoutMs);
        timer.unref?.();
        waiting.set(id, { resolve, reject, timer });
        write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      });
    },
  };
}
