import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerIn, createClient, parseSse } from '../server/lib/mcp-client.mjs';
import { json, startFakeUpstream } from './helpers.mjs';

test('SSE parsing: comments, events, multi-line data', () => {
  const ev = parseSse(': c\n\nevent: message\ndata: {"a":\ndata: 1}\n\nevent: other\ndata: x\n\n');
  assert.deepEqual(ev, [{ event: 'message', data: '{"a":\n1}' }, { event: 'other', data: 'x' }]);
  const text = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n';
  assert.deepEqual(answerIn(text, 7).result, { ok: true });
  assert.equal(answerIn(text, 8), undefined);
});

test('JSON and SSE upstreams: initialize, session id echo, tools/list, tools/call', async () => {
  for (const sse of [false, true]) {
    const up = await startFakeUpstream({ sse, tools: [{ name: 'get_account_balances', inputSchema: { type: 'object' } }] });
    const c = createClient({ url: up.url, getToken: async () => 'test-access-token' });
    const tools = await c.listTools();
    assert.deepEqual(tools.map(t => t.name), ['get_account_balances']);
    const r = await c.callTool('get_account_balances', {});
    assert.equal(r.content[0].text, 'ok');
    assert.equal(c.info().protocolVersion, '2025-06-18');
    assert.ok(up.calls.some(m => m.method === 'notifications/initialized'));
    await up.close();
  }
});

test('tools/list follows nextCursor', async () => {
  const pages = { '': { tools: [{ name: 'a' }], nextCursor: 'p2' }, p2: { tools: [{ name: 'b' }] } };
  let session = '';
  const fetchImpl = async (url, init) => {
    const m = JSON.parse(init.body);
    if (m.method !== 'initialize') session = init.headers['Mcp-Session-Id'];
    if (!('id' in m)) return new Response(null, { status: 202 });
    if (m.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } }, 200, { 'mcp-session-id': 'S1' });
    return json({ jsonrpc: '2.0', id: m.id, result: pages[m.params.cursor || ''] });
  };
  const c = createClient({ url: 'https://x.test/mcp', fetchImpl });
  assert.deepEqual((await c.listTools()).map(t => t.name), ['a', 'b']);
  assert.equal(session, 'S1');
});

test('401 refreshes once and retries; a second 401 is needs_auth', async () => {
  const forced = [];
  let good = 'new-token';
  const fetchImpl = async (url, init) => {
    const m = JSON.parse(init.body);
    if (init.headers.Authorization !== 'Bearer ' + good) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } });
    if (!('id' in m)) return new Response(null, { status: 202 });
    return json({ jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools: [] } });
  };
  const getToken = async ({ force }) => { forced.push(force); return force ? 'new-token' : 'old-token'; };
  const c = createClient({ url: 'https://x.test/mcp', fetchImpl, getToken });
  await c.listTools();
  assert.deepEqual(forced.slice(0, 2), [false, true]);

  good = 'never';
  const c2 = createClient({ url: 'https://x.test/mcp', fetchImpl, getToken });
  await assert.rejects(c2.listTools(), e => e.code === 'needs_auth' && !/token/.test(e.message.replace('sign in', '')));
});

test('HTTP errors and timeouts are reported without credentials', async () => {
  const c = createClient({ url: 'https://x.test/mcp', fetchImpl: async () => new Response('boom', { status: 500 }), getToken: async () => 'secret-token' });
  await assert.rejects(c.listTools(), e => e.code === 'http' && !e.message.includes('secret-token'));
  const slow = createClient({ url: 'https://x.test/mcp', timeoutMs: 20, fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))) });
  await assert.rejects(slow.listTools(), e => e.code === 'timeout');
});
