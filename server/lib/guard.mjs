// The guard: an MCP server whose tools are its own three (sign in / status / sign out) plus IBKR's upstream tools
// filtered and annotated by policy.mjs. Upstream calls go through the policy before anything is sent.

import fs from 'node:fs';
import path from 'node:path';
import { classify, visibleTools } from './policy.mjs';
import { ensureDir } from './store.mjs';

export const SUPPORTED_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const DEFAULT_VERSION = '2025-06-18';
const TOOLS_TTL_MS = 10 * 60 * 1000;

export const INSTRUCTIONS = [
  'ibkr-mcp-guard connects to Interactive Brokers\' official MCP server through a safety guard.',
  'It is READ-ONLY plus order DRAFTS: account balances, positions, orders, trades, market data, option data, research, alerts and watchlists can be read;',
  'alerts, watchlists and feedback can be changed; order *instructions* (drafts) can be created or deleted, but nothing is ever sent to the market —',
  'the user reviews and approves drafts themselves inside IBKR. Tools that place, submit or transmit orders are removed, and order submission (mcp.orders.submit) is never requested.',
  'If the user is not signed in, call ibkr_sign_in (a browser window opens; the user approves, then asks again). ibkr_status shows the connection.',
  'Report numbers only from tool results, say when data was retrieved, and do not give personalised financial advice.',
].join(' ');

const GUARD_TOOLS = [
  {
    name: 'ibkr_sign_in',
    title: 'Sign in to Interactive Brokers',
    description: 'Start signing in to Interactive Brokers in the user\'s browser (read + order-draft access only; order submission is never requested). Returns immediately; the user approves in the browser and then asks again.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'ibkr_status',
    title: 'IBKR connection status',
    description: 'Show whether the user is signed in to Interactive Brokers, the account ids, granted scopes, token expiry, and confirm that order submission was not granted.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ibkr_sign_out',
    title: 'Sign out of Interactive Brokers',
    description: 'Sign out of Interactive Brokers: revoke the tokens at IBKR and delete them from this computer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];
export const GUARD_TOOL_NAMES = Object.freeze(GUARD_TOOLS.map(t => t.name));

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const rpcError = (code, message) => Object.assign(new Error(message), { code });

/**
 * createGuard({upstreamUrl, auth, client, dataDir, readOnly, version, peer, log, storeKind})
 *   auth   createAuth() instance; client: createClient() instance; peer: {request, notify} towards the MCP client.
 * -> {handle(message)}
 */
export function createGuard({ upstreamUrl, auth, client, dataDir, readOnly = false, version = '0.0.0', peer, log = () => {}, storeKind = '', now = () => Date.now() }) {
  let clientCaps = {};
  let memo = null; // {tools, at}
  const watched = new WeakSet();
  const cacheFile = dataDir ? path.join(dataDir, 'tools-cache.json') : '';

  function readCache() {
    if (!cacheFile) return null;
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      return c && c.url === upstreamUrl && Array.isArray(c.tools) ? c : null;
    } catch { return null; }
  }
  function writeCache(tools) {
    if (!cacheFile) return;
    try {
      ensureDir(dataDir);
      fs.writeFileSync(cacheFile, JSON.stringify({ url: upstreamUrl, savedAt: new Date(now()).toISOString(), tools }), { mode: 0o600 });
    } catch (e) { log('could not write the tool cache: ' + e.message); }
  }

  /** The upstream tool list: live when signed in (memoised 10 min), else the cached list, else []. */
  async function upstreamTools({ refresh = false } = {}) {
    if (!refresh && memo && now() - memo.at < TOOLS_TTL_MS) return memo.tools;
    if (auth.status().signedIn) {
      try {
        const tools = await client.listTools();
        memo = { tools, at: now() };
        writeCache(tools);
        return tools;
      } catch (e) {
        log('upstream tools/list failed: ' + (e.code || '') + ' ' + e.message);
      }
    }
    return memo?.tools || readCache()?.tools || [];
  }

  function watch(result) {
    const done = result?.done;
    if (!done || watched.has(done)) return;
    watched.add(done);
    done.then(async r => {
      if (r?.state !== 'signed-in') { if (r?.error) log('sign-in ended: ' + r.error); return; }
      log('signed in to Interactive Brokers');
      client.reset?.();
      memo = null;
      await upstreamTools({ refresh: true }).catch(() => {});
      try { peer?.notify('notifications/tools/list_changed'); } catch {}
    }, () => {});
  }

  async function beginSignIn(prefix = '') {
    const r = await auth.start();
    watch(r);
    if (r.state === 'error') return text(prefix + 'Could not start the Interactive Brokers sign-in: ' + r.error, true);
    const link = r.url ? '\n\nIf no browser window opened, open this link yourself:\n' + r.url : '';
    const opened = r.browserFailed || !r.url ? 'Please open the sign-in link below' : r.reused ? 'A sign-in is already waiting in your browser' : 'I opened your browser to sign in to Interactive Brokers';
    return text(prefix + opened + '. Approve access there (read + order drafts only — order submission is never requested), then ask again.' + link, Boolean(prefix));
  }

  function statusText() {
    const s = auth.status();
    const lines = [
      s.signedIn ? 'Signed in to Interactive Brokers.' : auth.waiting?.() ? 'Not signed in yet — a sign-in is waiting for approval in the browser.' : 'Not signed in. Call ibkr_sign_in to connect.',
      'Account ids: ' + (s.accountIds.length ? s.accountIds.join(', ') : s.signedIn ? '(not reported by IBKR)' : '—'),
      'Scopes granted: ' + (s.scopesGranted.length ? s.scopesGranted.join(' ') : '—'),
      'Scopes requested: ' + s.scopesRequested.join(' '),
      'Order submission (mcp.orders.submit) granted: ' + (s.orderSubmissionGranted ? 'YES — unexpected; submit tools stay blocked by the guard anyway. Consider signing out.' : 'no'),
      'Access token expires: ' + (s.expiresAt || '—') + (s.renewable ? ' (renews automatically)' : ''),
      'Mode: ' + (readOnly ? 'read-only (IBKR_MCP_GUARD_READONLY=1: drafts and writes hidden)' : 'read + writes (alerts, watchlists) + order drafts'),
      'Token storage: ' + (storeKind === 'keychain' ? 'macOS Keychain' : storeKind === 'file' ? 'file (mode 0600) in ' + dataDir : storeKind || '—'),
      'Upstream: ' + upstreamUrl,
      ...(s.lastError ? ['Last sign-in error: ' + s.lastError] : []),
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...s, readOnly, upstream: upstreamUrl, storage: storeKind } };
  }

  async function confirmDraft(name, args) {
    if (!clientCaps?.elicitation || !peer) return true; // the host's own tool approval applies (destructiveHint: true)
    try {
      const r = await peer.request('elicitation/create', {
        message: 'Create/change an IBKR order DRAFT with ' + name + '?\n\n' + JSON.stringify(args ?? {}, null, 2).slice(0, 2000) +
          '\n\nNothing is sent to the market. You review and approve drafts yourself inside IBKR.',
        requestedSchema: {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Approve this draft', description: 'Create/change the order draft in IBKR', default: true } },
          required: ['approve'],
        },
      });
      return r?.action === 'accept' && r?.content?.approve !== false;
    } catch (e) {
      log('elicitation failed: ' + e.message);
      return false;
    }
  }

  async function callUpstream(name, args) {
    const known = (await upstreamTools()).find(t => t.name === name);
    const cls = classify(known || name);
    if (cls === 'block') return text('Blocked by ibkr-mcp-guard: ' + name + ' would place/submit/transmit an order. This guard never sends orders to the market — create an order draft instead and approve it yourself inside IBKR.', true);
    if (readOnly && cls !== 'read') return text('Blocked by ibkr-mcp-guard: read-only mode (IBKR_MCP_GUARD_READONLY=1) hides tools that change anything, including ' + name + '.', true);
    if (!auth.status().signedIn) return beginSignIn('You are not signed in to Interactive Brokers yet, so ' + name + ' was not called. ');
    if (cls === 'draft' && !(await confirmDraft(name, args))) return text('Cancelled: the order draft was not created or changed. Nothing was sent to IBKR.', true);
    try {
      return await client.callTool(name, args && typeof args === 'object' ? args : {});
    } catch (e) {
      if (e.code === 'needs_auth') return beginSignIn('Your Interactive Brokers sign-in has expired, so ' + name + ' was not completed. ');
      if (e.code === 'rpc') throw rpcError(Number.isInteger(e.rpcCode) ? e.rpcCode : -32603, e.message);
      return text('Interactive Brokers request failed: ' + e.message, true);
    }
  }

  async function handle(m) {
    const method = m?.method;
    const params = m?.params && typeof m.params === 'object' ? m.params : {};
    switch (method) {
      case 'initialize': {
        clientCaps = params.capabilities && typeof params.capabilities === 'object' ? params.capabilities : {};
        const asked = String(params.protocolVersion || '');
        return {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : DEFAULT_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'ibkr-mcp-guard', title: 'IBKR (guarded)', version },
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping':
        return {};
      case 'tools/list': {
        const upstream = visibleTools(await upstreamTools(), { readOnly }).filter(t => !GUARD_TOOL_NAMES.includes(t.name));
        return { tools: [...GUARD_TOOLS, ...upstream] };
      }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!name) throw rpcError(-32602, 'tools/call needs a tool name.');
        if (name === 'ibkr_sign_in') {
          if (auth.status().signedIn && (await auth.token().catch(() => ''))) return text('Already signed in to Interactive Brokers. Use ibkr_status for details, or ibkr_sign_out to disconnect.');
          return beginSignIn();
        }
        if (name === 'ibkr_status') return statusText();
        if (name === 'ibkr_sign_out') {
          const r = await auth.signOut();
          memo = null;
          client.reset?.();
          try { peer?.notify('notifications/tools/list_changed'); } catch {}
          return text(r.hadTokens ? 'Signed out of Interactive Brokers' + (r.revoked ? ' (tokens revoked at IBKR)' : '') + ' and removed the tokens from this computer.' : 'You were not signed in.');
        }
        return callUpstream(name, params.arguments);
      }
      default:
        if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
        if (method === 'resources/list') return { resources: [] };
        if (method === 'prompts/list') return { prompts: [] };
        throw rpcError(-32601, 'Method not found: ' + String(method));
    }
  }

  return { handle, upstreamTools };
}
