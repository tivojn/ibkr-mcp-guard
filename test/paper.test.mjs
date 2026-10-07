// Paper mode (IBKR_MCP_GUARD_PAPER=1): scopes, mode changes, the DU gate, listing, confirmation, audit log, status.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GUARD_TOOL_NAMES, createGuard } from '../server/lib/guard.mjs';
import { PAPER_SCOPES, SCOPES, assertScopes, authorizeUrl, createAuth, registrationBody } from '../server/lib/oauth.mjs';
import {
  PAPER_PREFIX, accountArgs, accountToolNames, confirmMessage, createPaperLog, findAccountIds, isPaperId, paperVerdict, readBack,
} from '../server/lib/paper.mjs';
import { IBKR, REAL_TOOLS, fakeFetch, ibkrDiscoveryRoutes, json, memoryStore } from './helpers.mjs';

const UP = 'https://api.ibkr.com/v1/api/mcp-public';
const SUBMIT_TOOLS = ['place_order', 'cancel_order', 'modify_order'];
const upstreamTools = [...REAL_TOOLS, ...SUBMIT_TOOLS].map(name => ({ name, description: 'd:' + name, inputSchema: { type: 'object' } }));
const ACCOUNT_TOOLS = ['get_account_positions', 'get_account_balances', 'get_account_summary', 'get_account_orders'];
const ORDER = { accountId: 'DU1234567', conid: 265598, symbol: 'AAPL', side: 'BUY', quantity: 10, orderType: 'LMT', price: 180, tif: 'DAY' };

// ---------------------------------------------------------------- scopes and sign-in mode

test('default mode never requests order submission; the assertion still throws without the paper flag', () => {
  assert.deepEqual([...SCOPES], ['openid', 'account-ids', 'mcp.read', 'mcp.write']);
  assert.throws(() => assertScopes(['mcp.orders.submit']), /never asks for order submission/);
  assert.throws(() => assertScopes(['mcp.orders.submit'], { paper: 'yes' }), /order submission/); // only a literal true
  assert.throws(() => assertScopes(['orders.submit'], { paper: true }), /order submission/); // other spellings never
  assert.throws(() => createAuth({ store: memoryStore(), scopes: [...SCOPES, 'mcp.orders.submit'] }));
  assert.throws(() => registrationBody({ redirectUri: 'http://127.0.0.1:1/callback', scopes: PAPER_SCOPES }));
  assert.throws(() => authorizeUrl({ as: IBKR.as, clientId: 'c', redirectUri: 'http://127.0.0.1:1/callback', scopes: PAPER_SCOPES, state: 's', challenge: 'x' }));
  const def = createAuth({ store: memoryStore() });
  assert.ok(!def.scopes().includes('mcp.orders.submit'));
  assert.equal(def.status().mode, 'default');
});

test('paper mode requests SCOPES + mcp.orders.submit through the explicit paper flag', () => {
  assert.deepEqual(assertScopes(PAPER_SCOPES, { paper: true }), [...SCOPES, 'mcp.orders.submit']);
  const a = createAuth({ store: memoryStore(), paper: true });
  assert.deepEqual(a.scopes(), [...SCOPES, 'mcp.orders.submit']);
  assert.equal(a.status().mode, 'paper');
  assert.equal(registrationBody({ redirectUri: 'http://127.0.0.1:1/callback', scopes: PAPER_SCOPES, paper: true }).scope, 'openid account-ids mcp.read mcp.write mcp.orders.submit');
});

function flowFetch(registered, scopeGranted) {
  let n = 0;
  return fakeFetch({
    ...ibkrDiscoveryRoutes(),
    ['POST ' + IBKR.as.registration_endpoint]: c => { registered.push(JSON.parse(c.body)); return json({ client_id: 'client-' + (++n) }, 201); },
    ['POST ' + IBKR.as.token_endpoint]: () => json({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600, token_type: 'Bearer', ...(scopeGranted ? { scope: scopeGranted } : {}) }),
  });
}

test('paper sign-in asks for orders.submit, re-registers a default-mode client, and remembers the token mode', async () => {
  const registered = [];
  const store = memoryStore({ client: { client_id: 'old', redirect_uri: 'http://127.0.0.1:1/callback', issuer: 'https://api.ibkr.com' } });
  let opened = '';
  const auth = createAuth({ store, paper: true, fetchImpl: flowFetch(registered), openUrl: async u => { opened = u; } });
  const r = await auth.start();
  const u = new URL(opened);
  assert.equal(u.searchParams.get('scope'), 'openid account-ids mcp.read mcp.write mcp.orders.submit');
  assert.equal(registered.length, 1, 'a client registered for the default scopes is replaced');
  assert.equal(registered[0].scope, 'openid account-ids mcp.read mcp.write mcp.orders.submit');
  await fetch(u.searchParams.get('redirect_uri') + '?code=c&state=' + u.searchParams.get('state'));
  assert.equal((await r.done).state, 'signed-in');
  const s = auth.status();
  assert.equal(s.signedIn, true);
  assert.equal(s.tokenMode, 'paper');
  assert.equal(s.orderSubmissionGranted, true);
  assert.equal(s.scopesReportedByIbkr, false, 'IBKR did not echo a scope: status says so');
  assert.equal(store.peek().tokens.requested, 'openid account-ids mcp.read mcp.write mcp.orders.submit');

  // the same store, now opened in default mode: the paper token does not count; a fresh sign-in is needed
  const def = createAuth({ store, fetchImpl: flowFetch(registered) });
  assert.equal(def.status().signedIn, false);
  assert.equal(def.status().modeMismatch, true);
  assert.equal(await def.token(), '');
});

test('a default-mode token (also one saved before 0.2.0) does not work in paper mode', async () => {
  const legacy = { client: { client_id: 'c', redirect_uri: 'http://127.0.0.1:1/callback', issuer: 'https://api.ibkr.com' }, tokens: { access: 'a', refresh: 'r', expires: Date.now() + 3600e3, scope: 'mcp.read mcp.write' } };
  const def = createAuth({ store: memoryStore(legacy) });
  assert.equal(def.status().signedIn, true, 'default mode keeps working with an old token');
  assert.equal(await def.token(), 'a');
  const paper = createAuth({ store: memoryStore(legacy), paper: true });
  assert.equal(paper.status().signedIn, false);
  assert.equal(paper.status().modeMismatch, true);
  assert.equal(paper.status().tokenMode, 'default');
  assert.equal(await paper.token(), '');
});

// ---------------------------------------------------------------- paper.mjs

test('account ids: found anywhere in a JSON answer, DU/DF are paper', () => {
  const answer = { content: [{ type: 'text', text: JSON.stringify({ accounts: [{ accountId: 'DU1234567' }, { id: 'DF7654321' }], note: 'U98765432 x' }) }] };
  assert.deepEqual(findAccountIds(answer).sort(), ['DF7654321', 'DU1234567', 'U98765432']);
  assert.deepEqual(findAccountIds({ conid: 265598, orderId: '123456789', text: 'XU1234567 DU12' }), []);
  assert.ok(isPaperId('DU1234567') && isPaperId('DF1234567'));
  for (const id of ['U1234567', 'F1234567', 'I1234567', 'DU12', 'du1234567']) assert.ok(!isPaperId(id), id);
});

test('accountArgs: ids anywhere plus any value under an account-like key', () => {
  assert.deepEqual(accountArgs({ symbol: 'AAPL', qty: 1 }), []);
  assert.deepEqual(accountArgs({ accountId: 'DU1234567' }), ['DU1234567']);
  assert.deepEqual(accountArgs({ order: { acctId: 'All' } }), ['All']);
  assert.deepEqual(accountArgs({ orders: [{ account: 'U7654321' }] }), ['U7654321']);
  assert.deepEqual(accountArgs({ note: 'from U1111111' }), ['U1111111']);
});

test('paperVerdict: allowed only when every account is paper and named accounts are among them', () => {
  const du = [{ id: 'DU1234567', paper: true }];
  assert.equal(paperVerdict({ accounts: du }).allowed, true);
  assert.match(paperVerdict({ accounts: [] }).reason, /No account ids/);
  assert.match(paperVerdict({ accounts: [...du, { id: 'U7654321', paper: false }] }).reason, /U7654321/);
  assert.match(paperVerdict({ accounts: du, argIds: ['DU9999999'] }).reason, /not among the accounts/);
  assert.match(paperVerdict({ accounts: du, argIds: ['U7654321'] }).reason, /not a paper account/);
  assert.match(paperVerdict({ accounts: du, argIds: ['All'] }).reason, /not a paper account/);
  assert.equal(paperVerdict({ accounts: du, argIds: ['DU1234567'] }).allowed, true);
});

test('read-back and account tool choice', () => {
  assert.deepEqual(readBack(ORDER), { account: 'DU1234567', symbol: 'AAPL (conid 265598)', side: 'BUY', quantity: '10', orderType: 'LMT', price: '180', tif: 'DAY' });
  assert.equal(readBack({ orders: [{ lmtPrice: 1, auxPrice: 2 }] }).price, '1 (lmtPrice), 2 (auxPrice)');
  const m = confirmMessage('place_order', ORDER, [{ id: 'DU1234567', paper: true }]);
  for (const s of ['PAPER', 'Account: DU1234567', 'Side: BUY', 'Quantity: 10', 'Order type: LMT', 'Price: 180', 'Time in force: DAY']) assert.ok(m.includes(s), s);
  assert.deepEqual(accountToolNames(upstreamTools), ['get_account_positions', 'get_account_balances', 'get_account_summary', 'get_account_orders', 'get_account_trades']);
  assert.deepEqual(accountToolNames([]), ACCOUNT_TOOLS);
});

// ---------------------------------------------------------------- the guard in paper mode

function fakeAuth({ signedIn = true, mismatch = false, accountIds = [] } = {}) {
  const a = {
    signedIn, starts: 0,
    status: () => ({ signedIn: a.signedIn && !mismatch, mode: 'paper', tokenMode: mismatch ? 'default' : 'paper', modeMismatch: mismatch, accountIds, scopesGranted: ['mcp.read', 'mcp.orders.submit'], scopesRequested: [...PAPER_SCOPES], orderSubmissionGranted: true, scopesReportedByIbkr: true, expiresAt: null, renewable: true }),
    start: async () => { a.starts++; return { state: 'waiting', url: 'https://api.ibkr.com/oauth2/authorize?x=1', done: new Promise(() => {}) }; },
    token: async () => (a.signedIn ? 'tok' : ''),
    signOut: async () => ({ hadTokens: true, revoked: true }),
    waiting: () => false,
  };
  return a;
}
/** Account tools answer with `ids` (a JSON text, as IBKR does); every call is recorded. */
function fakeClient(ids = ['DU1234567']) {
  const c = {
    ids, calls: [],
    listTools: async () => upstreamTools,
    callTool: async (name, args) => {
      c.calls.push([name, args]);
      if (ACCOUNT_TOOLS.includes(name)) return { content: [{ type: 'text', text: JSON.stringify({ accounts: c.ids.map(id => ({ accountId: id, netLiquidation: 1000000 })) }) }] };
      return { content: [{ type: 'text', text: 'called ' + name }] };
    },
    reset() {},
  };
  c.submits = () => c.calls.filter(([n]) => SUBMIT_TOOLS.includes(n));
  c.accountReads = () => c.calls.filter(([n]) => ACCOUNT_TOOLS.includes(n)).length;
  return c;
}
function peerFake(answer = { action: 'accept', content: { approve: true } }) {
  const p = { asked: [], notes: [], answer, request: async (method, params) => { p.asked.push([method, params]); return p.answer; }, notify: m => p.notes.push(m) };
  return p;
}
async function mk({ paper = true, ids, auth, peer = peerFake(), elicitation = false, paperNoConfirm = false, readOnly = false } = {}) {
  const client = fakeClient(ids);
  const a = auth || fakeAuth();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-guard-paper-'));
  const g = createGuard({ upstreamUrl: UP, auth: a, client, dataDir: dir, peer, paper, paperNoConfirm, readOnly });
  await g.handle({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: elicitation ? { elicitation: {} } : {} } });
  const call = (name, args) => g.handle({ method: 'tools/call', params: { name, arguments: args } });
  const list = async () => (await g.handle({ method: 'tools/list' })).tools;
  const log = () => createPaperLog(dir).read(100);
  return { g, client, auth: a, dir, peer, call, list, log };
}

test('default mode is unchanged: submit tools hidden and refused, no account reads, status says paper off', async () => {
  const t = await mk({ paper: false });
  const names = (await t.list()).map(x => x.name);
  for (const n of SUBMIT_TOOLS) assert.ok(!names.includes(n), n);
  assert.ok(!names.includes('ibkr_paper_log'));
  const r = await t.call('place_order', ORDER);
  assert.match(r.content[0].text, /^Blocked by ibkr-mcp-guard/);
  assert.equal(t.client.calls.length, 0);
  const st = await t.call('ibkr_status', {});
  assert.match(st.content[0].text, /Paper mode: off/);
  assert.equal(st.structuredContent.paper.enabled, false);
  assert.equal(t.client.accountReads(), 0);
  assert.deepEqual(t.log(), []);
});

test('all accounts DU: submit tools listed with the paper prefix; a submit reads accounts fresh, goes through and is logged', async () => {
  const t = await mk();
  const tools = await t.list();
  const names = tools.map(x => x.name);
  assert.deepEqual(names.slice(0, 4), [...GUARD_TOOL_NAMES, 'ibkr_paper_log']);
  const place = tools.find(x => x.name === 'place_order');
  assert.ok(place.description.startsWith(PAPER_PREFIX));
  assert.equal(place.annotations.destructiveHint, true);
  assert.equal(place.annotations.readOnlyHint, false);
  assert.match(tools.find(x => x.name === 'ibkr_sign_in').description, /PAPER login/);

  const before = t.client.accountReads();
  const r = await t.call('place_order', ORDER);
  assert.equal(r.content[0].text, 'called place_order');
  assert.ok(t.client.accountReads() > before, 'accounts read again right before the submit');
  const before2 = t.client.accountReads();
  await t.call('place_order', { ...ORDER, accountId: undefined });
  assert.ok(t.client.accountReads() > before2, 'and again for the next submit (no cached verdict)');
  assert.equal(t.client.submits().length, 2);
  const [e] = t.log();
  assert.equal(e.decision, 'submitted');
  assert.equal(e.allowed, true);
  assert.equal(e.tool, 'place_order');
  assert.deepEqual(e.accounts, ['DU1234567 (paper)']);
  assert.equal(e.order.side, 'BUY');
  assert.ok(!JSON.stringify(t.log()).includes('tok'), 'no token in the log');
  assert.equal(fs.statSync(path.join(t.dir, 'paper-orders.log')).mode & 0o777, 0o600);
});

test('refused when any live account is visible, when no id can be read, and for named accounts', async () => {
  const live = await mk({ ids: ['DU1234567', 'U7654321'] });
  assert.ok(!(await live.list()).some(x => x.name === 'place_order'), 'hidden while a live account is visible');
  let r = await live.call('place_order', ORDER);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Refused.*U7654321/s);
  assert.equal(live.client.submits().length, 0);
  assert.equal(live.log()[0].decision, 'refused');

  const none = await mk({ ids: [] });
  r = await none.call('place_order', ORDER);
  assert.match(r.content[0].text, /No account ids could be read/);
  assert.equal(none.client.submits().length, 0);

  const failing = await mk();
  failing.client.callTool = async () => { throw Object.assign(new Error('boom'), { code: 'http' }); };
  r = await failing.call('place_order', ORDER);
  assert.match(r.content[0].text, /No account ids could be read/);

  const du = await mk();
  for (const [accountId, why] of [['DU9999999', /not among the accounts/], ['U7654321', /not a paper account/], ['All', /not a paper account/]]) {
    r = await du.call('place_order', { ...ORDER, accountId });
    assert.equal(r.isError, true, accountId);
    assert.match(r.content[0].text, why, accountId);
  }
  assert.equal(du.client.submits().length, 0);
  assert.equal(du.log().length, 3);
  assert.ok(du.log().every(e => e.decision === 'refused' && e.allowed === false));
});

test('userinfo account ids count too: a live id there blocks paper submits', async () => {
  const t = await mk({ auth: fakeAuth({ accountIds: ['U5555555'] }) });
  const r = await t.call('place_order', ORDER);
  assert.match(r.content[0].text, /U5555555/);
  assert.equal(t.client.submits().length, 0);
});

test('visibility follows the fresh account read and announces changes with list_changed', async () => {
  const t = await mk();
  assert.ok((await t.list()).some(x => x.name === 'place_order'));
  assert.equal(t.peer.notes.filter(n => n === 'notifications/tools/list_changed').length, 1);
  await t.list();
  assert.equal(t.peer.notes.length, 1, 'no notification without a change');
  t.client.ids = ['DU1234567', 'U7654321'];
  assert.ok(!(await t.list()).some(x => x.name === 'place_order'));
  assert.equal(t.peer.notes.length, 2);
  t.client.ids = ['DU1234567'];
  await t.call('place_order', ORDER); // the submit's own fresh read notices the change as well
  assert.equal(t.peer.notes.length, 3);
  await t.call('ibkr_sign_out', {});
  assert.equal(t.peer.notes.length, 4);

  const out = await mk({ auth: fakeAuth({ signedIn: false }) });
  assert.ok(!(await out.list()).some(x => x.name === 'place_order'), 'hidden while signed out');
});

test('elicitation: a plain read-back; cancel sends nothing, approve submits', async () => {
  const peer = peerFake({ action: 'cancel' });
  const t = await mk({ elicitation: true, peer });
  let r = await t.call('place_order', ORDER);
  assert.match(r.content[0].text, /Cancelled: the paper order was not submitted/);
  assert.equal(t.client.submits().length, 0);
  const [method, params] = peer.asked[0];
  assert.equal(method, 'elicitation/create');
  for (const s of ['PAPER', 'Account: DU1234567', 'Side: BUY', 'Quantity: 10', 'Symbol: AAPL', 'Order type: LMT', 'Price: 180', 'Time in force: DAY']) assert.ok(params.message.includes(s), s);
  assert.equal(params.requestedSchema.properties.approve.type, 'boolean');
  assert.equal(t.log()[0].decision, 'cancelled');

  peer.answer = { action: 'accept', content: { approve: false } };
  await t.call('place_order', ORDER);
  assert.equal(t.client.submits().length, 0, 'accept with approve=false is not an approval');

  peer.answer = { action: 'accept', content: { approve: true } };
  const reads = t.client.accountReads();
  r = await t.call('place_order', ORDER);
  assert.equal(r.content[0].text, 'called place_order');
  assert.ok(t.client.accountReads() >= reads + 2 * ACCOUNT_TOOLS.length, 'accounts re-read after the user approved');
  assert.equal(t.log().at(-1).decision, 'submitted');
});

test('a live account appearing while the user is deciding still refuses the submit', async () => {
  const peer = peerFake();
  const t = await mk({ elicitation: true, peer });
  peer.request = async () => { t.client.ids = ['DU1234567', 'U7654321']; return { action: 'accept', content: { approve: true } }; };
  const r = await t.call('place_order', ORDER);
  assert.match(r.content[0].text, /Refused.*U7654321/s);
  assert.equal(t.client.submits().length, 0);
});

test('IBKR_MCP_GUARD_PAPER_NO_CONFIRM skips the prompt; without elicitation the host approval applies', async () => {
  const t = await mk({ elicitation: true, paperNoConfirm: true });
  assert.equal((await t.call('place_order', ORDER)).content[0].text, 'called place_order');
  assert.equal(t.peer.asked.length, 0);
  const st = await t.call('ibkr_status', {});
  assert.match(st.content[0].text, /confirmation prompt off/);

  const host = await mk({ elicitation: false });
  assert.equal((await host.call('place_order', ORDER)).content[0].text, 'called place_order');
  assert.equal(host.peer.asked.length, 0);
});

test('drafts still ask in paper mode even with NO_CONFIRM (it only covers paper submits)', async () => {
  const t = await mk({ elicitation: true, paperNoConfirm: true });
  await t.call('create_order_instruction', { side: 'BUY' });
  assert.equal(t.peer.asked.length, 1);
});

test('ibkr_status in paper mode: accounts labelled from a fresh read, grant, and why submits are (not) allowed', async () => {
  const ok = await mk();
  let st = await ok.call('ibkr_status', {});
  assert.match(st.content[0].text, /Paper mode: on/);
  assert.match(st.content[0].text, /Accounts seen \(read fresh from IBKR\): DU1234567 \(paper\)/);
  assert.match(st.content[0].text, /mcp\.orders\.submit\) granted: yes/);
  assert.match(st.content[0].text, /Paper order submission allowed now: yes/);
  assert.equal(st.structuredContent.paper.submitAllowed, true);
  assert.deepEqual(st.structuredContent.paper.accounts, [{ id: 'DU1234567', paper: true }]);

  const live = await mk({ ids: ['DU1234567', 'U7654321'] });
  st = await live.call('ibkr_status', {});
  assert.match(st.content[0].text, /U7654321 \(LIVE\)/);
  assert.match(st.content[0].text, /allowed now: no — This sign-in can see non-paper/);
});

test('ibkr_paper_log shows the latest entries', async () => {
  const t = await mk({ ids: ['DU1234567', 'U7654321'] });
  await t.call('place_order', ORDER);
  await t.call('cancel_order', { orderId: 1 });
  const r = await t.call('ibkr_paper_log', { limit: 1 });
  assert.equal(r.structuredContent.entries.length, 1);
  assert.equal(r.structuredContent.entries[0].tool, 'cancel_order');
  assert.match(r.content[0].text, /refused cancel_order/);
});

test('a sign-in from the other mode is not used: the call asks to sign in again', async () => {
  const t = await mk({ auth: fakeAuth({ mismatch: true }) });
  const r = await t.call('place_order', ORDER);
  assert.match(r.content[0].text, /sign in again/);
  assert.equal(t.auth.starts, 1);
  const r2 = await t.call('get_account_balances', {});
  assert.match(r2.content[0].text, /sign in again/);
  const r3 = await t.call('ibkr_sign_in', {});
  assert.match(r3.content[0].text, /sign in again.*PAPER login/s);
  assert.equal(t.client.calls.length, 0);
  assert.equal(t.log()[0].reason, 'not signed in');
});
