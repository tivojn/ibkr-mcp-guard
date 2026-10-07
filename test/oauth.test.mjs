import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SCOPES, assertScopes, authorizeUrl, challengeFor, createAuth, discover, openBrowser, parseWwwAuthenticate, pkce,
  registrationBody, tokenRecord, wellKnown,
} from '../server/lib/oauth.mjs';
import { IBKR, fakeFetch, ibkrDiscoveryRoutes, json, memoryStore } from './helpers.mjs';

test('parses the real IBKR WWW-Authenticate header', () => {
  const p = parseWwwAuthenticate(IBKR.www);
  assert.equal(p.scheme, 'bearer');
  assert.equal(p.params.resource_metadata, IBKR.rmUrl);
});

test('well-known URLs are path-inserted first (RFC 8414 / RFC 9728)', () => {
  assert.deepEqual(wellKnown('https://api.ibkr.com/v1/api/mcp-public', 'oauth-protected-resource'), [
    'https://api.ibkr.com/.well-known/oauth-protected-resource/v1/api/mcp-public',
    'https://api.ibkr.com/.well-known/oauth-protected-resource',
  ]);
  assert.equal(wellKnown('https://phx.example.com/auth', 'oauth-authorization-server')[0], 'https://phx.example.com/.well-known/oauth-authorization-server/auth');
  assert.equal(wellKnown('https://api.ibkr.com', 'oauth-authorization-server')[0], IBKR.asUrl);
});

test('discovery from the real IBKR metadata strings', async () => {
  const f = fakeFetch(ibkrDiscoveryRoutes());
  const d = await discover({ serverUrl: IBKR.mcp, wwwAuthenticate: IBKR.www, fetchImpl: f });
  assert.equal(d.resource, IBKR.mcp);
  assert.equal(d.issuer, 'https://api.ibkr.com');
  assert.equal(d.as.authorization_endpoint, 'https://api.ibkr.com/oauth2/authorize');
  assert.equal(d.as.token_endpoint, 'https://api.ibkr.com/oauth2/api/v1/token');
  assert.equal(d.as.registration_endpoint, 'https://api.ibkr.com/oauth2/register');
  assert.equal(d.resourceMetadataUrl, IBKR.rmUrl);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('discovery refuses an authorization server without S256', async () => {
  const routes = ibkrDiscoveryRoutes();
  routes['GET ' + IBKR.asUrl] = () => json({ ...IBKR.as, code_challenge_methods_supported: ['plain'] });
  await assert.rejects(discover({ serverUrl: IBKR.mcp, wwwAuthenticate: IBKR.www, fetchImpl: fakeFetch(routes) }), /S256/);
});

test('SCOPES never include order submission; the assertion throws', () => {
  assert.deepEqual([...SCOPES], ['openid', 'account-ids', 'mcp.read', 'mcp.write']);
  assert.throws(() => assertScopes(['mcp.read', 'mcp.orders.submit']), /never asks for order submission/);
  assert.throws(() => assertScopes('openid mcp.orders.submit'), /order submission/);
  assert.throws(() => registrationBody({ redirectUri: 'http://127.0.0.1:1/callback', scopes: ['mcp.orders.submit'] }));
  assert.throws(() => authorizeUrl({ as: IBKR.as, clientId: 'c', redirectUri: 'http://127.0.0.1:1/callback', scopes: [...SCOPES, 'mcp.orders.submit'], state: 's', challenge: 'x' }));
  assert.throws(() => createAuth({ store: memoryStore(), scopes: ['mcp.orders.submit'] }));
});

test('DCR body is a public native client for the exact loopback redirect', () => {
  const b = registrationBody({ redirectUri: 'http://127.0.0.1:53999/callback' });
  assert.deepEqual(b, {
    client_name: 'ibkr-mcp-guard',
    redirect_uris: ['http://127.0.0.1:53999/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
    scope: 'openid account-ids mcp.read mcp.write',
  });
});

test('PKCE S256 matches RFC 7636 appendix B', () => {
  // RFC 7636 Appendix B test vector
  assert.equal(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const p = pkce();
  assert.equal(p.method, 'S256');
  assert.ok(p.verifier.length >= 43 && p.verifier.length <= 128);
  assert.equal(p.challenge, challengeFor(p.verifier));
});

test('authorize URL carries PKCE, state and the RFC 8707 resource', () => {
  const u = new URL(authorizeUrl({ as: IBKR.as, clientId: 'cid', redirectUri: 'http://127.0.0.1:5/callback', state: 'st', challenge: 'ch', resource: IBKR.mcp }));
  assert.equal(u.origin + u.pathname, 'https://api.ibkr.com/oauth2/authorize');
  assert.equal(u.searchParams.get('scope'), 'openid account-ids mcp.read mcp.write');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('resource'), IBKR.mcp);
  assert.equal(u.searchParams.get('response_type'), 'code');
});

test('tokenRecord keeps the old refresh token unless rotated', () => {
  const a = tokenRecord({ access_token: 'a1', refresh_token: 'r1', expires_in: 600, token_type: 'Bearer' }, {}, 1000);
  assert.equal(a.expires, 1000 + 600000);
  const b = tokenRecord({ access_token: 'a2', expires_in: 600 }, a, 2000);
  assert.equal(b.refresh, 'r1');
  const c = tokenRecord({ access_token: 'a3', refresh_token: 'r2' }, b, 3000);
  assert.equal(c.refresh, 'r2');
  assert.throws(() => tokenRecord({}), /valid access token/);
});

test('openBrowser uses the platform command', async () => {
  const seen = [];
  const spawnImpl = (cmd, args) => { seen.push([cmd, args]); return { on: (ev, fn) => { if (ev === 'spawn') setImmediate(fn); }, unref() {} }; };
  await openBrowser('https://x.test/a?b=1&c=2', { platform: 'darwin', spawnImpl });
  await openBrowser('https://x.test/a', { platform: 'linux', spawnImpl });
  await openBrowser('https://x.test/a?b=1&c=2', { platform: 'win32', spawnImpl });
  assert.deepEqual(seen[0], ['open', ['https://x.test/a?b=1&c=2']]);
  assert.deepEqual(seen[1], ['xdg-open', ['https://x.test/a']]);
  assert.deepEqual(seen[2], ['cmd', ['/c', 'start', '""', 'https://x.test/a?b=1^&c=2']]);
});

// ---- the whole browser flow, with a fake IBKR and a real loopback callback server

function fullFlowFetch({ registered = [], tokenBodies = [], revoked = [] } = {}) {
  let n = 0;
  return fakeFetch({
    ...ibkrDiscoveryRoutes(),
    ['POST ' + IBKR.as.registration_endpoint]: c => { const b = JSON.parse(c.body); registered.push(b); return json({ client_id: 'client-' + (++n), redirect_uris: b.redirect_uris }, 201); },
    ['POST ' + IBKR.as.token_endpoint]: c => {
      const p = Object.fromEntries(new URLSearchParams(c.body));
      tokenBodies.push(p);
      if (p.grant_type === 'authorization_code') return json({ access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 3600, token_type: 'Bearer', scope: 'openid account-ids mcp.read mcp.write' });
      if (p.grant_type === 'refresh_token' && p.refresh_token === 'ref-1') return json({ access_token: 'acc-2', refresh_token: 'ref-2', expires_in: 3600, token_type: 'Bearer' });
      return json({ error: 'invalid_grant' }, 400);
    },
    ['GET ' + IBKR.as.userinfo_endpoint]: () => json({ sub: 'x', account_ids: ['U1234567'] }),
    ['POST ' + IBKR.as.revocation_endpoint]: c => { revoked.push(Object.fromEntries(new URLSearchParams(c.body)).token_type_hint); return new Response(null, { status: 200 }); },
  });
}

test('full sign-in: DCR, browser, state check, code exchange, refresh rotation, sign-out revoke', async () => {
  const registered = [], tokenBodies = [], revoked = [];
  const fetchImpl = fullFlowFetch({ registered, tokenBodies, revoked });
  const store = memoryStore();
  let opened = '';
  let clock = 1_000_000;
  const auth = createAuth({ store, fetchImpl, openUrl: async url => { opened = url; }, now: () => clock });
  const r = await auth.start();
  assert.equal(r.state, 'waiting');
  const u = new URL(opened);
  const redirect = u.searchParams.get('redirect_uri');
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].redirect_uris, [redirect]);
  assert.equal(u.searchParams.get('client_id'), 'client-1');
  assert.equal(u.searchParams.get('scope'), 'openid account-ids mcp.read mcp.write');
  assert.ok(!opened.includes('orders.submit'));

  // a second start while waiting reuses the flow
  const again = await auth.start();
  assert.equal(again.reused, true);

  // wrong state is rejected and the flow keeps waiting
  const bad = await fetch(redirect + '?code=abc&state=wrong');
  assert.equal(bad.status, 400);
  assert.equal(auth.status().signedIn, false);

  const ok = await fetch(redirect + '?code=the-code&state=' + u.searchParams.get('state'));
  assert.equal(ok.status, 200);
  const done = await r.done;
  assert.equal(done.state, 'signed-in');
  const ex = tokenBodies[0];
  assert.equal(ex.grant_type, 'authorization_code');
  assert.equal(ex.code, 'the-code');
  assert.equal(ex.redirect_uri, redirect);
  assert.equal(ex.resource, IBKR.mcp);
  assert.equal(challengeFor(ex.code_verifier), u.searchParams.get('code_challenge'));

  const s = auth.status();
  assert.equal(s.signedIn, true);
  assert.deepEqual(s.accountIds, ['U1234567']);
  assert.equal(s.orderSubmissionGranted, false);
  assert.equal(await auth.token(), 'acc-1');

  // forced refresh (as after a 401) rotates the refresh token
  assert.equal(await auth.token({ force: true }), 'acc-2');
  assert.equal(store.peek().tokens.refresh, 'ref-2');
  assert.equal(tokenBodies[1].resource, IBKR.mcp);

  // expiry-driven refresh: ref-2 is refused -> signed out, registration kept
  clock += 2 * 3600 * 1000;
  assert.equal(await auth.token(), '');
  assert.equal(auth.status().signedIn, false);
  assert.equal(store.peek().client.client_id, 'client-1');

  // second sign-in reuses the registration on the same port when free
  const r2 = await auth.start();
  const u2 = new URL(opened);
  assert.equal(u2.searchParams.get('redirect_uri'), redirect);
  assert.equal(registered.length, 1);
  await fetch(redirect + '?code=c2&state=' + u2.searchParams.get('state'));
  assert.equal((await r2.done).state, 'signed-in');

  const out = await auth.signOut();
  assert.equal(out.hadTokens, true);
  assert.deepEqual(revoked, ['refresh_token', 'access_token']);
  assert.equal(store.peek().tokens, undefined);
  assert.equal(auth.status().signedIn, false);
});

test('re-registers when the stored redirect port is taken', async () => {
  const net = await import('node:net');
  const blocker = net.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const registered = [];
  const store = memoryStore({ client: { client_id: 'old', redirect_uri: 'http://127.0.0.1:' + port + '/callback', issuer: 'https://api.ibkr.com' } });
  let opened = '';
  const auth = createAuth({ store, fetchImpl: fullFlowFetch({ registered }), openUrl: async url => { opened = url; } });
  await auth.start();
  const redirect = new URL(opened).searchParams.get('redirect_uri');
  assert.notEqual(redirect, 'http://127.0.0.1:' + port + '/callback');
  assert.equal(registered.length, 1);
  assert.equal(store.peek().client.redirect_uri, redirect);
  auth.cancel();
  blocker.close();
});

test('denied in the browser ends the flow with an error; the sign-in times out', async () => {
  let opened = '';
  const auth = createAuth({ store: memoryStore(), fetchImpl: fullFlowFetch(), openUrl: async url => { opened = url; } });
  const r = await auth.start();
  const u = new URL(opened);
  await fetch(u.searchParams.get('redirect_uri') + '?error=access_denied&state=' + u.searchParams.get('state'));
  const done = await r.done;
  assert.equal(done.state, 'error');
  assert.match(done.error, /cancelled or denied/);

  const slow = createAuth({ store: memoryStore(), fetchImpl: fullFlowFetch(), openUrl: async () => {}, loginMs: 30 });
  const r2 = await slow.start();
  assert.match((await r2.done).error, /timed out/);
});

test('status reports an unexpected orders.submit grant', async () => {
  const store = memoryStore({ client: { client_id: 'c', redirect_uri: 'http://127.0.0.1:1/callback', issuer: 'https://api.ibkr.com' }, tokens: { access: 'a', refresh: 'r', expires: Date.now() + 3600e3, scope: 'mcp.read mcp.orders.submit' } });
  const auth = createAuth({ store, fetchImpl: fullFlowFetch() });
  assert.equal(auth.status().orderSubmissionGranted, true);
});
