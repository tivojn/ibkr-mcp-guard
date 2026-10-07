// OAuth 2.1 sign-in for the IBKR MCP server, as the MCP authorization spec describes it:
//
//   discover   the 401's WWW-Authenticate names the protected-resource metadata (RFC 9728); its authorization_servers[0]
//              gives the issuer, whose metadata (RFC 8414; path-inserted well-known URL first) gives the endpoints.
//   register   Dynamic Client Registration (RFC 7591) as a public native client (token_endpoint_auth_method none) with
//              the exact loopback redirect http://127.0.0.1:<port>/callback. The client_id is stored with its redirect;
//              the next sign-in listens on that port again, and registers anew only if the port is taken.
//   sign in    PKCE S256 (RFC 7636), a random state checked once, the system browser, a 10-minute limit, the code
//              exchanged with the `resource` parameter (RFC 8707) so the token is bound to the MCP server.
//   tokens     refreshed a minute before expiry and on a 401 (a rotated refresh token replaces the old one); revoked on
//              sign-out, then forgotten (the client registration is kept).
//
// Scopes are fixed: SCOPES. assertScopes() throws if mcp.orders.submit (or any *orders.submit) is ever asked for.
// Nothing here logs, and no error or status carries a token, code or verifier.

import { anySignal } from './signal.mjs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import nodeHttp from 'node:http';

export const IBKR_MCP_URL = 'https://api.ibkr.com/v1/api/mcp-public';
export const SCOPES = Object.freeze(['openid', 'account-ids', 'mcp.read', 'mcp.write']);
export const FORBIDDEN_SCOPES = Object.freeze(['mcp.orders.submit']);
export const LOGIN_MS = 10 * 60 * 1000;
export const CALLBACK_PATH = '/callback';
const SUBMIT = /orders?\.submit/i;

/** Throws if a forbidden scope is in the list; returns the list. */
export function assertScopes(scopes) {
  const list = (Array.isArray(scopes) ? scopes : String(scopes || '').split(/\s+/)).filter(Boolean);
  for (const s of list) {
    if (FORBIDDEN_SCOPES.includes(s) || SUBMIT.test(s)) throw new Error('Refusing to request scope ' + s + ': ibkr-mcp-guard never asks for order submission.');
  }
  return list;
}
assertScopes(SCOPES);

/** 'Bearer resource_metadata="…", scope="…"' -> {scheme, params} */
export function parseWwwAuthenticate(value) {
  const text = String(value || '').trim();
  const m = /^([A-Za-z][\w-]*)\s*(.*)$/s.exec(text);
  if (!m) return { scheme: '', params: {} };
  const params = {};
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let p;
  while ((p = re.exec(m[2]))) params[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
  return { scheme: m[1].toLowerCase(), params };
}

/** An https URL (or http on loopback, for tests) as a URL object, else null. */
export function safeUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol === 'https:') return x;
    if (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname)) return x;
    return null;
  } catch { return null; }
}

/** Well-known URLs for a resource or issuer: path-inserted first (RFC 8414 §3 / RFC 9728 §3), then the origin's. */
export function wellKnown(base, suffix) {
  const u = new URL(base);
  const tail = u.pathname.replace(/\/$/, '');
  const out = [];
  if (tail) out.push(u.origin + '/.well-known/' + suffix + tail);
  out.push(u.origin + '/.well-known/' + suffix);
  if (suffix === 'oauth-authorization-server') {
    if (tail) out.push(u.origin + tail + '/.well-known/openid-configuration');
    out.push(u.origin + '/.well-known/openid-configuration');
  }
  return out;
}

async function getJson(fetchImpl, url, signal) {
  let r;
  try {
    const t = AbortSignal.timeout(15000);
    r = await fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: signal ? anySignal([signal, t]) : t });
  } catch { return null; }
  if (!r.ok) { try { await r.body?.cancel?.(); } catch {} return null; }
  try { const j = await r.json(); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

/** Probe the server anonymously and return its WWW-Authenticate header ('' if none). */
export async function probe(serverUrl, { fetchImpl = globalThis.fetch, signal } = {}) {
  try {
    const r = await fetchImpl(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ibkr-mcp-guard', version: '0' } } }),
      redirect: 'error',
      signal: signal || AbortSignal.timeout(15000),
    });
    try { await r.body?.cancel?.(); } catch {}
    return r.headers.get('www-authenticate') || '';
  } catch { return ''; }
}

/** discover({serverUrl, wwwAuthenticate}) -> {resource, resourceMetadataUrl, issuer, as, scopesSupported} */
export async function discover({ serverUrl, wwwAuthenticate = '', fetchImpl = globalThis.fetch, signal } = {}) {
  const named = parseWwwAuthenticate(wwwAuthenticate).params.resource_metadata;
  const candidates = [...(named && safeUrl(named) ? [named] : []), ...wellKnown(serverUrl, 'oauth-protected-resource')];
  let rm = null;
  let rmUrl = '';
  for (const u of [...new Set(candidates)]) {
    rm = await getJson(fetchImpl, u, signal);
    if (rm) { rmUrl = u; break; }
  }
  const issuer = (Array.isArray(rm?.authorization_servers) && rm.authorization_servers.find(x => safeUrl(x))) || new URL(serverUrl).origin;
  let as = null;
  for (const u of wellKnown(issuer, 'oauth-authorization-server')) {
    as = await getJson(fetchImpl, u, signal);
    if (as?.authorization_endpoint && as?.token_endpoint) break;
    as = null;
  }
  if (!as) throw new Error('Interactive Brokers did not say how to sign in (no authorization server metadata).');
  for (const k of ['authorization_endpoint', 'token_endpoint']) if (!safeUrl(as[k])) throw new Error('The sign-in service gave an unsafe ' + k + '.');
  if (Array.isArray(as.code_challenge_methods_supported) && !as.code_challenge_methods_supported.includes('S256')) throw new Error('The sign-in service does not offer PKCE S256.');
  return {
    resource: typeof rm?.resource === 'string' && safeUrl(rm.resource) ? rm.resource : serverUrl,
    resourceMetadataUrl: rmUrl,
    issuer,
    as,
    scopesSupported: Array.isArray(rm?.scopes_supported) ? rm.scopes_supported : Array.isArray(as.scopes_supported) ? as.scopes_supported : [],
  };
}

export const challengeFor = verifier => crypto.createHash('sha256').update(verifier).digest('base64url');
export function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: challengeFor(verifier), method: 'S256' };
}

/** The RFC 7591 registration body: a public native client for exactly this redirect. */
export function registrationBody({ redirectUri, clientName = 'ibkr-mcp-guard', scopes = SCOPES }) {
  return {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
    scope: assertScopes(scopes).join(' '),
  };
}

export function authorizeUrl({ as, clientId, redirectUri, scopes = SCOPES, state, challenge, resource }) {
  const u = new URL(as.authorization_endpoint);
  const params = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: assertScopes(scopes).join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', resource };
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.href;
}

/** A token answer as kept: {access, refresh, expires, scope, idClaims}. A missing lifetime counts as one hour. */
export function tokenRecord(data, previous = {}, now = Date.now(), requested = SCOPES) {
  if (!data || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 131072) throw new Error('Sign-in did not return a valid access token.');
  if (data.token_type && String(data.token_type).toLowerCase() !== 'bearer') throw new Error('Sign-in returned an unsupported token type.');
  const seconds = Number(data.expires_in);
  const life = Number.isFinite(seconds) && seconds > 0 && seconds < 31536000 ? seconds : 3600;
  const refresh = typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : previous.refresh || '';
  return {
    access: data.access_token,
    refresh,
    expires: now + life * 1000,
    scope: typeof data.scope === 'string' ? data.scope : previous.scope || requested.join(' '),
    idClaims: typeof data.id_token === 'string' ? claims(data.id_token) : previous.idClaims || null,
  };
}

/** An ID token's claims, for display only (unverified, never used to authorize anything). */
function claims(jwt) {
  try {
    const c = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
    return c && typeof c === 'object' ? c : null;
  } catch { return null; }
}

/** Account ids from a userinfo answer or ID-token claims, in whatever spelling the server uses. */
export function accountIds(c) {
  if (!c || typeof c !== 'object') return [];
  const v = c.account_ids ?? c.accountIds ?? c['account-ids'] ?? c.accounts ?? c.acct_ids;
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  return list.map(x => (typeof x === 'object' ? x?.id ?? x?.accountId ?? '' : x)).map(String).filter(x => /^[\w.-]{1,40}$/.test(x)).slice(0, 20);
}

async function postForm(fetchImpl, url, body, signal) {
  let r;
  try {
    const t = AbortSignal.timeout(30000);
    r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(Object.entries(body).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString(),
      redirect: 'error',
      signal: signal ? anySignal([signal, t]) : t,
    });
  } catch { throw new Error('Could not reach the Interactive Brokers sign-in service.'); }
  let data = {};
  try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data: data && typeof data === 'object' ? data : {} };
}

const KNOWN = {
  invalid_grant: 'The sign-in expired or was already used. Sign in again.',
  access_denied: 'Access was denied.',
  invalid_client: 'The app registration was refused. Sign in again.',
  invalid_scope: 'The requested access was refused.',
  temporarily_unavailable: 'The sign-in service is busy. Try again.',
};
const failure = (what, r) => new Error(what + ' failed (HTTP ' + r.status + '). ' + (KNOWN[r.data?.error] || 'Please try again.'));

/** Open a URL in the system browser (macOS open, Linux xdg-open, Windows cmd /c start ""). */
export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let cmd;
    let args;
    if (platform === 'darwin') { cmd = 'open'; args = [url]; }
    else if (platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', url.replace(/&/g, '^&')]; }
    else { cmd = 'xdg-open'; args = [url]; }
    let child;
    try {
      child = spawnImpl(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: platform === 'win32' });
    } catch (e) { reject(e); return; }
    child.on?.('error', reject);
    child.on?.('spawn', () => { child.unref?.(); resolve(); });
    if (!child.on) resolve();
  });
}

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:36em;margin:4em auto;padding:0 1em"><h1>${title}</h1><p>${body}</p></body>`;

/**
 * createAuth({serverUrl, store, fetchImpl, openUrl, http, now, onChange, clientName, loginMs})
 * -> {start, cancel, token, signOut, status, flow}
 */
export function createAuth(o) {
  const {
    serverUrl = IBKR_MCP_URL,
    store,
    fetchImpl = globalThis.fetch,
    openUrl = url => openBrowser(url),
    http = nodeHttp,
    now = () => Date.now(),
    onChange = () => {},
    clientName = 'ibkr-mcp-guard',
    loginMs = LOGIN_MS,
  } = o;
  const scopes = assertScopes(o.scopes || SCOPES);
  let cache; // the stored record, read once
  let flow = null; // the sign-in in progress
  let state = { state: 'idle' };
  let refreshing = null;
  let discovered = null;
  let generation = 0;

  const load = (fresh = false) => {
    if (cache === undefined || fresh) {
      try { const v = JSON.parse(store.read() || 'null'); cache = v && typeof v === 'object' ? v : {}; } catch { cache = {}; }
    }
    return cache;
  };
  const save = v => { cache = v; store.write(JSON.stringify(v)); };
  const set = s => { state = s; try { onChange(s); } catch {} };

  async function metadata(signal) {
    if (!discovered) {
      const www = await probe(serverUrl, { fetchImpl, signal });
      discovered = await discover({ serverUrl, wwwAuthenticate: www, fetchImpl, signal });
    }
    return discovered;
  }

  function cancel() {
    generation++;
    if (flow) {
      clearTimeout(flow.expiry);
      flow.abort.abort();
      try { flow.server?.close(); flow.server?.closeAllConnections?.(); } catch {}
      flow.resolve?.({ state: 'cancelled' });
      flow = null;
    }
    if (['starting', 'waiting'].includes(state.state)) set({ state: 'idle' });
  }

  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
  });

  async function register(d, redirectUri, signal) {
    const endpoint = safeUrl(d.as.registration_endpoint) ? d.as.registration_endpoint : '';
    if (!endpoint) throw new Error('Interactive Brokers does not offer app registration.');
    let r;
    try {
      r = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(registrationBody({ redirectUri, clientName, scopes })), redirect: 'error', signal });
    } catch { throw new Error('Could not reach the Interactive Brokers sign-in service.'); }
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok || typeof data.client_id !== 'string' || !data.client_id) throw new Error('Registering with Interactive Brokers failed (HTTP ' + r.status + ').');
    return { client_id: data.client_id, redirect_uri: redirectUri, issuer: d.issuer, registered_at: now() };
  }

  async function userinfo(d, access) {
    if (!safeUrl(d.as.userinfo_endpoint)) return null;
    try {
      const r = await fetchImpl(d.as.userinfo_endpoint, { headers: { Authorization: 'Bearer ' + access, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  /**
   * Start a browser sign-in. Resolves as soon as the browser was opened (or the URL is ready) with
   * {state: 'waiting', url, done} — `done` resolves when the flow ends. A flow already waiting is reused.
   */
  async function start() {
    if (flow?.url) return { state: 'waiting', url: flow.url, done: flow.done, reused: true };
    if (flow?.ready) return flow.ready; // a start already under way
    cancel();
    const mine = { abort: new AbortController() };
    mine.done = new Promise(resolve => { mine.resolve = resolve; });
    flow = mine;
    const current = () => flow === mine && !mine.abort.signal.aborted;
    const finish = result => {
      if (flow !== mine) return;
      clearTimeout(mine.expiry);
      try { mine.server?.close(); mine.server?.closeAllConnections?.(); } catch {}
      flow = null;
      set(result.state === 'signed-in' ? { state: 'signed-in' } : { state: 'error', error: result.error });
      mine.resolve(result);
    };
    const fail = message => finish({ state: 'error', error: message });
    set({ state: 'starting' });
    mine.expiry = setTimeout(() => fail('Sign-in timed out after 10 minutes. Start again.'), loginMs);
    mine.expiry.unref?.();
    mine.ready = (async () => { try {
      const d = await metadata(mine.abort.signal);
      if (!current()) return { state: 'cancelled' };
      const saved = load(true);
      const { verifier, challenge } = pkce();
      const st = crypto.randomBytes(32).toString('hex');
      let client = saved.client && saved.client.issuer === d.issuer ? saved.client : null;

      // Listen on the registered redirect's port first; if it is taken, an ephemeral port and a new registration.
      const callbackHandler = (req, res) => void callback(req, res);
      let port = 0;
      const wanted = client ? Number(new URL(client.redirect_uri).port) : 0;
      if (wanted) {
        try { mine.server = http.createServer(callbackHandler); port = await listen(mine.server, wanted); } catch { try { mine.server.close(); } catch {} port = 0; }
      }
      if (!port) { mine.server = http.createServer(callbackHandler); port = await listen(mine.server, 0); }
      if (!current()) { try { mine.server.close(); } catch {} return { state: 'cancelled' }; }
      const redirectUri = 'http://127.0.0.1:' + port + CALLBACK_PATH;
      if (!client || client.redirect_uri !== redirectUri) {
        client = await register(d, redirectUri, mine.abort.signal);
        if (!current()) return { state: 'cancelled' };
        save({ ...load(), client });
      }

      async function callback(req, res) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const u = new URL(req.url, 'http://127.0.0.1');
        if (req.method !== 'GET' || u.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end('Not found'); return; }
        if (!current() || u.searchParams.getAll('state').length !== 1 || u.searchParams.get('state') !== st) {
          res.writeHead(400);
          res.end(PAGE('Sign-in did not match', 'This sign-in link is stale or was not started here. Ask your assistant to sign in to IBKR again.'));
          return;
        }
        if (mine.exchanging) { res.writeHead(409); res.end(PAGE('Already finishing', 'Sign-in is already being completed.')); return; }
        const code = u.searchParams.get('code');
        if (u.searchParams.has('error') || !code || code.length > 4096) {
          res.end(PAGE('Sign-in not completed', 'Interactive Brokers did not grant access. You can close this tab.'), () => fail('Sign-in was cancelled or denied in the browser.'));
          return;
        }
        mine.exchanging = true;
        try {
          const r = await postForm(fetchImpl, d.as.token_endpoint, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: client.client_id, resource: d.resource }, mine.abort.signal);
          if (!r.ok) throw failure('Interactive Brokers sign-in', r);
          if (!current()) { res.end(PAGE('Cancelled', 'This sign-in was cancelled.')); return; }
          const tokens = tokenRecord(r.data, {}, now(), scopes);
          const who = await userinfo(d, tokens.access);
          const ids = accountIds(who).length ? accountIds(who) : accountIds(tokens.idClaims);
          save({ ...load(), client, tokens, accountIds: ids });
          res.end(PAGE('Signed in to IBKR', 'You can close this tab and go back to your assistant.'), () => finish({ state: 'signed-in' }));
        } catch (e) {
          res.writeHead(400);
          res.end(PAGE('Sign-in failed', String(e.message).replace(/[<>&]/g, '') + ' Ask your assistant to sign in again.'), () => fail(e.message));
        }
      }

      mine.url = authorizeUrl({ as: d.as, clientId: client.client_id, redirectUri, scopes, state: st, challenge, resource: d.resource });
      set({ state: 'waiting' });
      try { await openUrl(mine.url); } catch { mine.browserFailed = true; }
      return { state: 'waiting', url: mine.url, done: mine.done, browserFailed: Boolean(mine.browserFailed) };
    } catch (e) {
      fail(String(e?.message || 'Sign-in failed.'));
      return { state: 'error', error: String(e?.message || 'Sign-in failed.'), done: mine.done };
    } })();
    return mine.ready;
  }

  /** The access token: refreshed when within a minute of expiry or when force is set; '' when not signed in. */
  async function token({ force = false } = {}) {
    let saved = load();
    if (!saved.tokens?.access) {
      saved = load(true); // another process may have signed in
      if (!saved.tokens?.access) return '';
    }
    if (!force && saved.tokens.expires > now() + 60000) return saved.tokens.access;
    // Another process sharing this store may already have refreshed (and rotated the refresh token).
    const used = saved.tokens.access;
    saved = load(true);
    if (!saved.tokens?.access) return '';
    if (saved.tokens.access !== used && saved.tokens.expires > now() + 60000) return saved.tokens.access;
    if (!saved.tokens.refresh) { save({ client: saved.client }); return ''; }
    if (refreshing) return refreshing;
    const gen = generation;
    refreshing = (async () => {
      const d = await metadata();
      const r = await postForm(fetchImpl, d.as.token_endpoint, { grant_type: 'refresh_token', refresh_token: saved.tokens.refresh, client_id: saved.client?.client_id || '', resource: d.resource });
      if (!r.ok) {
        if (r.status === 400 || r.status === 401) { save({ client: saved.client }); return ''; }
        throw failure('Renewing the IBKR sign-in', r);
      }
      if (gen !== generation) return '';
      const tokens = tokenRecord(r.data, saved.tokens, now(), scopes);
      save({ ...load(), tokens });
      return tokens.access;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  /** Revoke (refresh token, then access token), then forget the tokens; the client registration is kept. */
  async function signOut() {
    cancel();
    const saved = load(true);
    let revoked = false;
    if (saved.tokens) {
      try {
        const d = await metadata();
        if (safeUrl(d.as.revocation_endpoint)) {
          for (const [t, hint] of [[saved.tokens.refresh, 'refresh_token'], [saved.tokens.access, 'access_token']]) {
            if (!t) continue;
            const r = await postForm(fetchImpl, d.as.revocation_endpoint, { token: t, token_type_hint: hint, client_id: saved.client?.client_id || '' }).catch(() => null);
            if (r?.ok) revoked = true;
          }
        }
      } catch {}
    }
    if (saved.client) save({ client: saved.client });
    else { store.clear(); cache = {}; }
    set({ state: 'idle' });
    return { hadTokens: Boolean(saved.tokens), revoked };
  }

  function status() {
    const saved = load(true);
    const t = saved.tokens;
    const granted = t ? String(t.scope || '').split(/\s+/).filter(Boolean) : [];
    return {
      signedIn: Boolean(t?.access) && (t.expires > now() || Boolean(t.refresh)),
      flow: state.state,
      ...(state.error ? { lastError: state.error } : {}),
      accountIds: t ? saved.accountIds || [] : [],
      scopesGranted: granted,
      scopesRequested: [...scopes],
      orderSubmissionGranted: granted.some(s => SUBMIT.test(s)),
      expiresAt: t ? new Date(t.expires).toISOString() : null,
      renewable: Boolean(t?.refresh),
      clientRegistered: Boolean(saved.client?.client_id),
    };
  }

  return { start, cancel, token, signOut, status, waiting: () => Boolean(flow?.url), scopes: () => [...scopes] };
}
