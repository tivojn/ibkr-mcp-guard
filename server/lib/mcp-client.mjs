// Upstream MCP client: Streamable HTTP (MCP 2025-06-18 transport).
//
// Every JSON-RPC message is a POST to the server URL with `Accept: application/json, text/event-stream`. The answer is
// either one JSON body or an SSE stream carrying it (other messages on the stream are skipped). The Mcp-Session-Id
// returned by `initialize` is echoed on every later request; a 404 for a dropped session re-initializes once.
//
// Credentials come from getToken({force}) (a bearer). A 401 asks getToken({force: true}) once (a refresh) and retries;
// a second 401 raises McpError('needs_auth'). No error message ever carries a header value or token.

import { anySignal } from './signal.mjs';
export const LATEST = '2025-06-18';
export const SUPPORTED = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const LIMIT = 8 * 1024 * 1024; // largest answer read

export class McpError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Parse an SSE text into [{event, data}] (a blank line ends an event; ':' lines are comments). */
export function parseSse(text) {
  const out = [];
  let event = 'message';
  let data = [];
  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    if (raw === '') {
      if (data.length) out.push({ event, data: data.join('\n') });
      event = 'message';
      data = [];
      continue;
    }
    if (raw.startsWith(':')) continue;
    const at = raw.indexOf(':');
    const field = at < 0 ? raw : raw.slice(0, at);
    const value = at < 0 ? '' : raw.slice(at + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length) out.push({ event, data: data.join('\n') });
  return out;
}

const isAnswer = (m, id) => m && typeof m === 'object' && m.id === id && ('result' in m || 'error' in m);

/** The JSON-RPC answer with this id inside an SSE text, or undefined if it has not arrived yet. */
export function answerIn(text, id) {
  for (const ev of parseSse(text)) {
    if (ev.event !== 'message') continue;
    let m;
    try { m = JSON.parse(ev.data); } catch { continue; }
    for (const one of Array.isArray(m) ? m : [m]) if (isAnswer(one, id)) return one;
  }
  return undefined;
}

const header = (r, name) => (typeof r?.headers?.get === 'function' ? r.headers.get(name) : r?.headers?.[name.toLowerCase()]) || '';
const drain = async r => { try { await r.body?.cancel?.(); } catch {} };

async function bodyText(r, stopWhen) {
  const reader = r.body?.getReader?.();
  if (!reader) {
    const t = typeof r.text === 'function' ? await r.text() : '';
    if (t.length > LIMIT) throw new McpError('protocol', 'The server answer was too large.');
    return t;
  }
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > LIMIT) throw new McpError('protocol', 'The server answer was too large.');
      text += decoder.decode(value, { stream: true });
      if (stopWhen?.(text)) break;
    }
  } finally {
    reader.cancel?.().catch?.(() => {});
  }
  return text + decoder.decode();
}

const combine = (signal, ms) => {
  const t = AbortSignal.timeout(ms);
  return signal ? anySignal([signal, t]) : t;
};

const why = (err, signal) => {
  if (err instanceof McpError) return err;
  if (signal?.aborted && signal.reason?.name !== 'TimeoutError') return new McpError('aborted', 'The request was cancelled.');
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new McpError('timeout', 'The server did not answer in time.');
  return new McpError('transport', 'Could not reach the server.');
};

/**
 * createClient({url, getToken, fetchImpl, clientInfo, timeoutMs})
 * -> {connect, listTools, callTool, request, close, info}
 */
export function createClient({ url, getToken, fetchImpl = globalThis.fetch, clientInfo = { name: 'ibkr-mcp-guard', version: '0' }, timeoutMs = 60000 } = {}) {
  let session = '';
  let version = '';
  let nextId = 1;
  let ready = null;
  let info = null;

  async function post(message, { signal, retried = {} } = {}) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (session) h['Mcp-Session-Id'] = session;
    if (version) h['MCP-Protocol-Version'] = version;
    if (getToken) {
      const token = await getToken({ force: Boolean(retried.auth) });
      if (token) h.Authorization = 'Bearer ' + token;
    }
    let r;
    try {
      r = await fetchImpl(url, { method: 'POST', headers: h, body: JSON.stringify(message), redirect: 'error', signal });
    } catch (e) {
      throw why(e, signal);
    }
    const wwwAuthenticate = header(r, 'www-authenticate');
    if (r.status === 401 || (r.status === 403 && /invalid_token|insufficient_scope/.test(wwwAuthenticate))) {
      await drain(r);
      if (getToken && !retried.auth) return post(message, { signal, retried: { ...retried, auth: true } }); // refresh once
      throw new McpError('needs_auth', 'Interactive Brokers needs you to sign in again.', { status: r.status, wwwAuthenticate });
    }
    if (r.status === 404 && session && message.method !== 'initialize' && !retried.session) {
      await drain(r);
      session = '';
      ready = null;
      await connect({ signal });
      return post(message, { signal, retried: { ...retried, session: true } });
    }
    if (r.status === 202 || r.status === 204) { await drain(r); return undefined; }
    if (!r.ok) {
      await drain(r);
      throw new McpError('http', 'The server answered HTTP ' + r.status + '.', { status: r.status });
    }
    const sid = header(r, 'mcp-session-id');
    if (sid && message.method === 'initialize') session = /^[\x21-\x7e]{1,512}$/.test(sid) ? sid : '';
    if (!('id' in message)) { await drain(r); return undefined; }
    const type = header(r, 'content-type').toLowerCase();
    if (type.includes('text/event-stream')) {
      const text = await bodyText(r, t => answerIn(t, message.id) !== undefined);
      const m = answerIn(text, message.id);
      if (!m) throw new McpError('protocol', 'The server stream ended without an answer.');
      return m;
    }
    let m;
    try { m = JSON.parse(await bodyText(r)); } catch (e) {
      if (e instanceof McpError) throw e;
      throw new McpError('protocol', 'The server answer was not JSON.');
    }
    const one = (Array.isArray(m) ? m : [m]).find(x => isAnswer(x, message.id));
    if (!one) throw new McpError('protocol', 'The server answered something else.');
    return one;
  }

  async function request(method, params, { signal, timeout = timeoutMs } = {}) {
    const s = combine(signal, timeout);
    const id = nextId++;
    let m;
    try {
      m = await post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, { signal: s });
    } catch (e) {
      throw why(e, s);
    }
    if (!m) throw new McpError('protocol', 'The server did not answer ' + method + '.');
    if (m.error) throw new McpError('rpc', String(m.error?.message || 'The server refused ' + method + '.').slice(0, 500), { rpcCode: m.error?.code });
    return m.result;
  }

  async function initialize({ signal } = {}) {
    let result;
    try {
      result = await request('initialize', { protocolVersion: LATEST, capabilities: {}, clientInfo }, { signal });
    } catch (e) {
      if (e.code !== 'rpc' || !/version/i.test(e.message)) throw e;
      result = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo }, { signal });
    }
    const v = String(result?.protocolVersion || '');
    if (!SUPPORTED.includes(v)) throw new McpError('protocol', 'The upstream server speaks MCP ' + (v || '(unknown)') + ', which is not supported.');
    version = v;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { signal: combine(signal, timeoutMs) }).catch(() => {});
    info = { protocolVersion: v, serverInfo: result.serverInfo || {}, capabilities: result.capabilities || {} };
    return info;
  }

  function connect({ signal } = {}) {
    if (!ready) ready = initialize({ signal }).catch(e => { ready = null; throw e; });
    return ready;
  }

  return {
    connect,
    info: () => info,
    request,
    /** Every tool, following nextCursor (at most 50 pages). */
    async listTools({ signal } = {}) {
      await connect({ signal });
      const tools = [];
      let cursor;
      for (let page = 0; page < 50; page++) {
        const r = await request('tools/list', cursor ? { cursor } : {}, { signal });
        for (const t of r?.tools || []) if (t && typeof t.name === 'string') tools.push(t);
        cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
        if (!cursor) break;
      }
      return tools;
    },
    async callTool(name, args = {}, { signal, timeoutMs: t } = {}) {
      await connect({ signal });
      return request('tools/call', { name: String(name), arguments: args && typeof args === 'object' ? args : {} }, { signal, timeout: t || timeoutMs });
    },
    /** Forget the session (e.g. after signing in as someone else). */
    reset() { session = ''; version = ''; ready = null; info = null; },
  };
}
