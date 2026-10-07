// End-to-end: spawn the real server over stdio against a local fake upstream MCP server (IBKR_MCP_GUARD_UPSTREAM).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REAL_TOOLS, startFakeUpstream } from './helpers.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.mjs');
const tools = [...REAL_TOOLS, 'place_order', 'submit_order'].map(name => ({ name, description: 'd', inputSchema: { type: 'object' } }));

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const onRequest = { handler: null };
  child.stderr.on('data', d => { stderr += d; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      const m = JSON.parse(line); // stdout must carry JSON-RPC only
      if (m.method && 'id' in m) { const result = onRequest.handler?.(m) ?? {}; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n'); }
      else if (m.method) notifications.push(m);
      else { pending.get(m.id)?.(m); pending.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise(resolve => { const id = nextId++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const stop = () => new Promise(resolve => { child.on('exit', resolve); child.stdin.end(); });
  return { child, rpc, notify, stop, notifications, onRequest, stderr: () => stderr };
}

const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

test('stdio round trip: sign in through the browser flow, list, call, block, sign out', async () => {
  const up = await startFakeUpstream({ tools, onCall: p => ({ content: [{ type: 'text', text: 'upstream:' + p.name }] }) });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-guard-e2e-'));
  const s = startServer({ IBKR_MCP_GUARD_UPSTREAM: up.url, IBKR_MCP_GUARD_STORE: 'file', IBKR_MCP_GUARD_NO_BROWSER: '1', CLAUDE_PLUGIN_DATA: data, IBKR_MCP_GUARD_READONLY: '' });
  try {
    const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'ibkr-mcp-guard');
    s.notify('notifications/initialized');
    assert.deepEqual((await s.rpc('ping')).result, {});

    let list = await s.rpc('tools/list', {});
    assert.deepEqual(list.result.tools.map(t => t.name), ['ibkr_sign_in', 'ibkr_status', 'ibkr_sign_out']);

    // calling an IBKR tool while signed out starts the sign-in and says so
    const r = await s.rpc('tools/call', { name: 'get_account_balances', arguments: {} });
    assert.equal(r.result.isError, true);
    const link = /(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)/.exec(r.result.content[0].text)[1];
    const auth = new URL(link);
    assert.equal(auth.searchParams.get('scope'), 'openid account-ids mcp.read mcp.write');
    assert.equal(up.auth.registrations[0].token_endpoint_auth_method, 'none');

    // the "browser" approves: IBKR redirects to the loopback callback
    const cb = await fetch(auth.searchParams.get('redirect_uri') + '?code=abc&state=' + auth.searchParams.get('state'));
    assert.equal(cb.status, 200);
    assert.ok(await waitFor(() => s.notifications.some(n => n.method === 'notifications/tools/list_changed')));
    assert.equal(up.auth.tokenRequests[0].resource, up.url);

    const authFile = fs.readdirSync(data).find(f => f.startsWith('auth-'));
    assert.equal(fs.statSync(path.join(data, authFile)).mode & 0o777, 0o600);

    list = await s.rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    assert.ok(names.includes('get_account_balances') && names.includes('create_order_instruction'));
    assert.ok(!names.includes('place_order') && !names.includes('submit_order'));

    const ok = await s.rpc('tools/call', { name: 'get_account_balances', arguments: {} });
    assert.equal(ok.result.content[0].text, 'upstream:get_account_balances');
    const blocked = await s.rpc('tools/call', { name: 'place_order', arguments: {} });
    assert.equal(blocked.result.isError, true);
    assert.ok(!up.calls.some(m => m.params?.name === 'place_order'));

    const st = await s.rpc('tools/call', { name: 'ibkr_status', arguments: {} });
    assert.match(st.result.content[0].text, /^Signed in/);
    const out = await s.rpc('tools/call', { name: 'ibkr_sign_out', arguments: {} });
    assert.match(out.result.content[0].text, /Signed out/);

    assert.ok(!s.stderr().includes('test-access-token'), 'token leaked to stderr');
  } finally {
    await s.stop();
    await up.close();
  }
});

test('stdio: with elicitation, a draft is confirmed by the client before it is sent', async () => {
  const up = await startFakeUpstream({ tools, onCall: p => ({ content: [{ type: 'text', text: 'upstream:' + p.name }] }) });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-guard-e2e-'));
  // seed a signed-in file store (the file name is derived from the upstream URL)
  const { createHash } = await import('node:crypto');
  fs.writeFileSync(path.join(data, 'auth-' + createHash('sha256').update(up.url).digest('hex').slice(0, 16) + '.json'),
    JSON.stringify({ client: { client_id: 'c', redirect_uri: 'http://127.0.0.1:1/callback', issuer: 'x' }, tokens: { access: 'test-access-token', refresh: '', expires: Date.now() + 3600e3, scope: 'mcp.read mcp.write' } }), { mode: 0o600 });
  const s = startServer({ IBKR_MCP_GUARD_UPSTREAM: up.url, IBKR_MCP_GUARD_STORE: 'file', IBKR_MCP_GUARD_NO_BROWSER: '1', CLAUDE_PLUGIN_DATA: data });
  const asked = [];
  let approve = false;
  s.onRequest.handler = m => { asked.push(m.method); return approve ? { action: 'accept', content: { approve: true } } : { action: 'cancel' }; };
  try {
    await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'test', version: '1' } });
    s.notify('notifications/initialized');
    const no = await s.rpc('tools/call', { name: 'create_order_instruction', arguments: { qty: 1 } });
    assert.match(no.result.content[0].text, /Cancelled/);
    assert.ok(!up.calls.some(m => m.params?.name === 'create_order_instruction'));
    approve = true;
    const yes = await s.rpc('tools/call', { name: 'create_order_instruction', arguments: { qty: 1 } });
    assert.equal(yes.result.content[0].text, 'upstream:create_order_instruction');
    assert.deepEqual(asked, ['elicitation/create', 'elicitation/create']);
  } finally {
    await s.stop();
    await up.close();
  }
});
