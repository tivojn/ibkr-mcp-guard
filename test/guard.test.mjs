import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GUARD_TOOL_NAMES, createGuard } from '../server/lib/guard.mjs';
import { DRAFT_PREFIX } from '../server/lib/policy.mjs';
import { REAL_TOOLS } from './helpers.mjs';

const UP = 'https://api.ibkr.com/v1/api/mcp-public';
const upstreamTools = [...REAL_TOOLS, 'place_order', 'submit_order', 'transmit_order'].map(name => ({ name, description: 'd:' + name, inputSchema: { type: 'object' } }));

function fakeAuth({ signedIn = false } = {}) {
  const a = {
    signedIn,
    starts: 0,
    status: () => ({ signedIn: a.signedIn, accountIds: [], scopesGranted: [], scopesRequested: ['openid', 'account-ids', 'mcp.read', 'mcp.write'], orderSubmissionGranted: false, expiresAt: null, renewable: false }),
    start: async () => { a.starts++; return { state: 'waiting', url: 'https://api.ibkr.com/oauth2/authorize?x=1', done: new Promise(() => {}) }; },
    token: async () => (a.signedIn ? 'tok' : ''),
    signOut: async () => ({ hadTokens: true, revoked: true }),
    waiting: () => false,
  };
  return a;
}
function fakeClient() {
  const c = { calls: [], listTools: async () => upstreamTools, callTool: async (name, args) => { c.calls.push([name, args]); return { content: [{ type: 'text', text: 'called ' + name }] }; }, reset() {} };
  return c;
}
const mk = (o = {}) => {
  const auth = o.auth || fakeAuth(o);
  const client = o.client || fakeClient();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-guard-'));
  const g = createGuard({ upstreamUrl: UP, auth, client, dataDir: dir, readOnly: o.readOnly, peer: o.peer, version: '9.9.9' });
  return { g, auth, client, dir };
};

test('initialize negotiates the protocol version and gives instructions', async () => {
  const { g } = mk();
  const r = await g.handle({ method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } });
  assert.equal(r.protocolVersion, '2025-03-26');
  assert.match(r.instructions, /DRAFTS/);
  assert.equal(r.serverInfo.version, '9.9.9');
  const r2 = await g.handle({ method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(r2.protocolVersion, '2025-06-18');
  await assert.rejects(g.handle({ method: 'nope' }), e => e.code === -32601);
});

test('signed out with no cache: only the guard tools are listed', async () => {
  const { g } = mk();
  const r = await g.handle({ method: 'tools/list' });
  assert.deepEqual(r.tools.map(t => t.name), GUARD_TOOL_NAMES);
});

test('signed in: upstream tools filtered, drafts prefixed, cache written and used after sign-out', async () => {
  const { g, auth, dir } = mk({ signedIn: true });
  const names = (await g.handle({ method: 'tools/list' })).tools.map(t => t.name);
  for (const n of ['place_order', 'submit_order', 'transmit_order']) assert.ok(!names.includes(n), n);
  assert.ok(names.includes('get_account_positions'));
  const tools = (await g.handle({ method: 'tools/list' })).tools;
  const draft = tools.find(t => t.name === 'create_order_instruction');
  assert.ok(draft.description.startsWith(DRAFT_PREFIX));
  assert.equal(draft.annotations.destructiveHint, true);
  assert.equal(tools.find(t => t.name === 'create_alert').annotations.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === 'get_price_snapshot').annotations.readOnlyHint, true);
  assert.ok(fs.existsSync(path.join(dir, 'tools-cache.json')));

  // a fresh guard, signed out, lists the cached tools
  auth.signedIn = false;
  const g2 = createGuard({ upstreamUrl: UP, auth, client: fakeClient(), dataDir: dir });
  const cached = (await g2.handle({ method: 'tools/list' })).tools.map(t => t.name);
  assert.ok(cached.includes('get_account_balances'));
  assert.ok(!cached.includes('place_order'));
});

test('a blocked tool is refused even when called directly', async () => {
  const { g, client } = mk({ signedIn: true });
  const r = await g.handle({ method: 'tools/call', params: { name: 'place_order', arguments: { conid: 1 } } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Blocked/);
  assert.equal(client.calls.length, 0);
});

test('signed out: an upstream call starts sign-in and returns a sign-in result', async () => {
  const { g, auth, client } = mk();
  const r = await g.handle({ method: 'tools/call', params: { name: 'get_account_balances', arguments: {} } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not signed in/);
  assert.match(r.content[0].text, /oauth2\/authorize/);
  assert.equal(auth.starts, 1);
  assert.equal(client.calls.length, 0);
});

test('ibkr_sign_in / ibkr_status / ibkr_sign_out', async () => {
  const { g, auth } = mk();
  const r = await g.handle({ method: 'tools/call', params: { name: 'ibkr_sign_in' } });
  assert.match(r.content[0].text, /opened your browser/i);
  assert.equal(r.isError, undefined);
  auth.signedIn = true;
  const r2 = await g.handle({ method: 'tools/call', params: { name: 'ibkr_sign_in' } });
  assert.match(r2.content[0].text, /Already signed in/);
  const st = await g.handle({ method: 'tools/call', params: { name: 'ibkr_status' } });
  assert.match(st.content[0].text, /Order submission \(mcp\.orders\.submit\) granted: no/);
  assert.equal(st.structuredContent.orderSubmissionGranted, false);
  const so = await g.handle({ method: 'tools/call', params: { name: 'ibkr_sign_out' } });
  assert.match(so.content[0].text, /Signed out/);
});

test('read and draft calls pass through; read-only mode refuses drafts and writes', async () => {
  const { g, client } = mk({ signedIn: true });
  assert.equal((await g.handle({ method: 'tools/call', params: { name: 'get_account_positions', arguments: {} } })).content[0].text, 'called get_account_positions');
  assert.equal((await g.handle({ method: 'tools/call', params: { name: 'create_order_instruction', arguments: { side: 'BUY' } } })).content[0].text, 'called create_order_instruction');
  assert.equal(client.calls.length, 2);

  const ro = mk({ signedIn: true, readOnly: true });
  for (const n of ['create_order_instruction', 'create_alert']) {
    const r = await ro.g.handle({ method: 'tools/call', params: { name: n, arguments: {} } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /read-only/);
  }
  const names = (await ro.g.handle({ method: 'tools/list' })).tools.map(t => t.name);
  assert.ok(!names.includes('create_order_instruction') && !names.includes('create_alert') && names.includes('get_account_balances'));
  assert.equal(ro.client.calls.length, 0);
});

test('with the elicitation capability, a draft asks first; decline sends nothing', async () => {
  const asked = [];
  let answer = { action: 'decline' };
  const peer = { request: async (method, params) => { asked.push([method, params]); return answer; }, notify() {} };
  const { g, client } = mk({ signedIn: true, peer });
  await g.handle({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } });
  const r = await g.handle({ method: 'tools/call', params: { name: 'create_order_instruction', arguments: { qty: 1 } } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Cancelled/);
  assert.equal(client.calls.length, 0);
  assert.equal(asked[0][0], 'elicitation/create');
  assert.equal(asked[0][1].requestedSchema.properties.approve.type, 'boolean');

  answer = { action: 'accept', content: { approve: true } };
  await g.handle({ method: 'tools/call', params: { name: 'create_order_instruction', arguments: { qty: 1 } } });
  assert.equal(client.calls.length, 1);

  // reads never ask
  await g.handle({ method: 'tools/call', params: { name: 'get_account_balances', arguments: {} } });
  assert.equal(asked.length, 2);
});

test('an expired sign-in during a call starts sign-in again', async () => {
  const client = fakeClient();
  client.callTool = async () => { throw Object.assign(new Error('x'), { code: 'needs_auth' }); };
  const { g, auth } = mk({ signedIn: true, client });
  const r = await g.handle({ method: 'tools/call', params: { name: 'get_account_balances', arguments: {} } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /expired/);
  assert.equal(auth.starts, 1);
});
