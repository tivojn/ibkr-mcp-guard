// The guard: an MCP server whose tools are its own three (sign in / status / sign out) plus IBKR's upstream tools
// filtered and annotated by policy.mjs. Upstream calls go through the policy before anything is sent.
// In opt-in paper mode (paper: true) it adds ibkr_paper_log, and order submission goes through the paper gate
// (paper.mjs): a fresh account read before every submit, paper (DU…/DF…) accounts only, confirmation, audit log.

import fs from 'node:fs';
import path from 'node:path';
import { accountArgs, confirmMessage, createPaperLog, paperVerdict, readAccounts, readBack, truncatedJson } from './paper.mjs';
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

export const PAPER_INSTRUCTIONS = [
  'PAPER MODE is on (IBKR_MCP_GUARD_PAPER=1): order-submission tools are available ONLY while every account this sign-in can see is an IBKR paper account (ids starting DU or DF).',
  'Before every submit the guard re-reads the account ids from IBKR and refuses if any live account is visible, if none can be read, or if the order names an account that is not one of those paper accounts.',
  'Each submit is confirmed with the user (or by the host\'s approval prompt) and recorded in a local audit log (ibkr_paper_log). Paper orders are simulated; this is not financial advice.',
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

const PAPER_LOG_TOOL = {
  name: 'ibkr_paper_log',
  title: 'IBKR paper order log',
  description: 'Show the latest entries of the local paper-order audit log: every paper-mode submit attempt, whether it was allowed, refused or cancelled, and why.',
  inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500, description: 'How many recent entries to show (default 20).' } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const PAPER_TOOL_NAMES = Object.freeze([PAPER_LOG_TOOL.name]);

/** The guard's own tools as listed in this mode (sign-in wording differs in paper mode). */
function guardTools(paper) {
  if (!paper) return GUARD_TOOLS;
  return [
    { ...GUARD_TOOLS[0], description: 'Start signing in to Interactive Brokers in the user\'s browser. PAPER MODE: this sign-in also asks for order submission (mcp.orders.submit) — use your IBKR PAPER login; orders are only ever let through to paper (DU…) accounts. Returns immediately; the user approves in the browser and then asks again.' },
    { ...GUARD_TOOLS[1], description: 'Show whether the user is signed in to Interactive Brokers, granted scopes and token expiry; in paper mode also the accounts seen (labelled paper/live, read fresh from IBKR) and whether paper order submission is allowed right now, and why.' },
    GUARD_TOOLS[2],
    PAPER_LOG_TOOL,
  ];
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const rpcError = (code, message) => Object.assign(new Error(message), { code });

/**
 * createGuard({upstreamUrl, auth, client, dataDir, readOnly, version, peer, log, storeKind, paper, paperNoConfirm})
 *   auth   createAuth() instance; client: createClient() instance; peer: {request, notify} towards the MCP client.
 *   paper  opt-in paper mode (IBKR_MCP_GUARD_PAPER=1); paperNoConfirm skips the elicitation prompt for paper submits.
 * -> {handle(message)}
 */
export function createGuard({ upstreamUrl, auth, client, dataDir, readOnly = false, version = '0.0.0', peer, log = () => {}, storeKind = '', now = () => Date.now(), paper = false, paperNoConfirm = false }) {
  let clientCaps = {};
  let memo = null; // {tools, at}
  let paperVisible = false; // whether the paper submit tools are currently listed (re-evaluated, never trusted for a call)
  const paperLog = createPaperLog(dataDir, now);
  const notifyListChanged = () => { try { peer?.notify('notifications/tools/list_changed'); } catch {} };
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
      if (paper) await paperSession().then(v => { paperVisible = v.allowed; }, () => { paperVisible = false; });
      notifyListChanged();
    }, () => {});
  }

  /** Why the user must sign in again when the saved sign-in belongs to the other mode ('' otherwise). */
  function modeChangeNote() {
    const s = auth.status();
    if (!s.modeMismatch) return '';
    return s.mode === 'paper'
      ? 'Paper mode is on, but your saved sign-in was made without order submission, so you need to sign in again (use your IBKR PAPER login). '
      : 'Paper mode is off, but your saved sign-in was made in paper mode (with order submission), so you need to sign in again. ';
  }

  async function beginSignIn(prefix = '') {
    const r = await auth.start();
    watch(r);
    if (r.state === 'error') return text(prefix + 'Could not start the Interactive Brokers sign-in: ' + r.error, true);
    const link = r.url ? '\n\nIf no browser window opened, open this link yourself:\n' + r.url : '';
    const opened = r.browserFailed || !r.url ? 'Please open the sign-in link below' : r.reused ? 'A sign-in is already waiting in your browser' : 'I opened your browser to sign in to Interactive Brokers';
    const what = paper
      ? 'Approve access there. PAPER MODE: this sign-in also asks for order submission, so sign in with your IBKR PAPER login (the Live/Paper switch on the login page); orders are only ever let through to paper (DU…) accounts. Then ask again.'
      : 'Approve access there (read + order drafts only — order submission is never requested), then ask again.';
    return text(prefix + opened + '. ' + what + link, Boolean(prefix));
  }

  // ---- paper mode

  /** A fresh read of the account ids this sign-in can see (never cached). */
  async function freshAccounts() {
    const tools = await upstreamTools();
    return readAccounts({ client, tools, extraIds: auth.status().accountIds || [] });
  }

  /** Is the session paper-only right now? -> {allowed, reason, accounts} (fresh read; for listing and status). */
  async function paperSession() {
    if (!paper) return { allowed: false, reason: 'Paper mode is off (set IBKR_MCP_GUARD_PAPER=1).', accounts: [] };
    if (readOnly) return { allowed: false, reason: 'Read-only mode (IBKR_MCP_GUARD_READONLY=1) overrides paper mode.', accounts: [] };
    if (!auth.status().signedIn) return { allowed: false, reason: modeChangeNote() || 'Not signed in.', accounts: [] };
    let read;
    try { read = await freshAccounts(); } catch (e) { return { allowed: false, reason: 'Could not read the account ids from IBKR: ' + e.message, accounts: [] }; }
    return { ...paperVerdict({ accounts: read.accounts }), accounts: read.accounts, sources: read.sources };
  }

  /** The gate for one submit: the session check plus the accounts the order names. */
  async function paperGate(args) {
    const session = await paperSession();
    if (session.allowed !== paperVisible) { paperVisible = session.allowed; notifyListChanged(); }
    if (!session.allowed) return session;
    return { ...paperVerdict({ accounts: session.accounts, argIds: accountArgs(args) }), accounts: session.accounts };
  }

  /** Ask before a paper submit -> {asked, ok}. Without elicitation the host's approval applies (destructiveHint). */
  async function confirmPaper(name, args, accounts) {
    if (paperNoConfirm) return { asked: false, ok: true };
    if (!clientCaps?.elicitation || !peer) return { asked: false, ok: true };
    try {
      const r = await peer.request('elicitation/create', {
        message: confirmMessage(name, args, accounts),
        requestedSchema: {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Approve this PAPER order', description: 'Submit the simulated order to your IBKR paper account', default: false } },
          required: ['approve'],
        },
      });
      return { asked: true, ok: r?.action === 'accept' && r?.content?.approve === true };
    } catch (e) {
      log('elicitation failed: ' + e.message);
      return { asked: true, ok: false };
    }
  }

  async function paperSubmit(name, args) {
    const summary = readBack(args);
    const record = (decision, reason, accounts = []) => {
      try {
        paperLog.append({ tool: name, decision, allowed: decision === 'submitted' || decision === 'failed', reason, accounts: accounts.map(a => a.id + (a.paper ? ' (paper)' : ' (live)')), order: summary, args: truncatedJson(args) });
      } catch (e) { log('could not write the paper order log: ' + e.message); }
    };
    const refuse = (reason, accounts) => { record('refused', reason, accounts); return text('Refused by ibkr-mcp-guard (paper mode): ' + reason + ' Nothing was sent to IBKR.', true); };
    if (readOnly) return refuse('Read-only mode (IBKR_MCP_GUARD_READONLY=1) overrides paper mode; ' + name + ' is not available.');
    if (!auth.status().signedIn) {
      record('refused', 'not signed in');
      return beginSignIn(modeChangeNote() + 'You are not signed in to Interactive Brokers, so ' + name + ' was not called. ');
    }
    let gate = await paperGate(args);
    if (!gate.allowed) return refuse(gate.reason, gate.accounts);
    const c = await confirmPaper(name, args, gate.accounts);
    if (!c.ok) {
      record('cancelled', 'cancelled by the user', gate.accounts);
      return text('Cancelled: the paper order was not submitted. Nothing was sent to IBKR.', true);
    }
    if (c.asked) { // the user may have taken a while: check again right before sending
      gate = await paperGate(args);
      if (!gate.allowed) return refuse(gate.reason, gate.accounts);
    }
    try {
      const r = await client.callTool(name, args && typeof args === 'object' ? args : {});
      record(r?.isError ? 'failed' : 'submitted', r?.isError ? 'IBKR answered with an error' : gate.reason, gate.accounts);
      return r;
    } catch (e) {
      record('failed', 'IBKR request failed: ' + e.message, gate.accounts);
      if (e.code === 'needs_auth') return beginSignIn('Your Interactive Brokers sign-in has expired, so ' + name + ' was not completed. ');
      if (e.code === 'rpc') throw rpcError(Number.isInteger(e.rpcCode) ? e.rpcCode : -32603, e.message);
      return text('Interactive Brokers request failed: ' + e.message, true);
    }
  }

  function paperLogText(args) {
    const entries = paperLog.read(args?.limit);
    const lines = entries.length
      ? entries.map(e => [e.time, e.decision, e.tool, e.order && Object.keys(e.order).length ? JSON.stringify(e.order) : '', e.accounts?.length ? 'accounts: ' + e.accounts.join(', ') : '', e.reason ? '— ' + e.reason : ''].filter(Boolean).join(' '))
      : ['No paper orders logged yet.'];
    return { content: [{ type: 'text', text: 'Paper order log (' + (paperLog.file || 'no data directory') + '):\n' + lines.join('\n') }], structuredContent: { file: paperLog.file, entries } };
  }

  async function statusText() {
    const s = auth.status();
    const p = paper ? await paperSession() : null;
    if (p) paperVisible = p.allowed;
    const submitLine = paper
      ? 'Order submission (mcp.orders.submit) granted: ' + (s.orderSubmissionGranted ? 'yes' + (s.scopesReportedByIbkr ? '' : ' (as requested; IBKR did not echo the granted scopes)') : s.signedIn ? 'no — paper submits will be refused by IBKR' : '—')
      : 'Order submission (mcp.orders.submit) granted: ' + (s.orderSubmissionGranted ? 'YES — unexpected; submit tools stay blocked by the guard anyway. Consider signing out.' : 'no');
    const lines = [
      s.signedIn ? 'Signed in to Interactive Brokers.' : auth.waiting?.() ? 'Not signed in yet — a sign-in is waiting for approval in the browser.' : 'Not signed in. Call ibkr_sign_in to connect.',
      ...(s.modeMismatch ? ['Sign in again: ' + modeChangeNote().trim()] : []),
      'Account ids: ' + (s.accountIds.length ? s.accountIds.join(', ') : s.signedIn ? '(not reported by IBKR)' : '—'),
      'Scopes granted: ' + (s.scopesGranted.length ? s.scopesGranted.join(' ') : '—'),
      'Scopes requested: ' + s.scopesRequested.join(' '),
      submitLine,
      'Access token expires: ' + (s.expiresAt || '—') + (s.renewable ? ' (renews automatically)' : ''),
      'Mode: ' + (readOnly ? 'read-only (IBKR_MCP_GUARD_READONLY=1: drafts and writes hidden)' : 'read + writes (alerts, watchlists) + order drafts') + (paper ? ' + PAPER order submission' : ''),
      ...(p ? [
        'Paper mode: on (IBKR_MCP_GUARD_PAPER=1)' + (paperNoConfirm ? ', confirmation prompt off (IBKR_MCP_GUARD_PAPER_NO_CONFIRM=1)' : ''),
        'Accounts seen (read fresh from IBKR): ' + (p.accounts.length ? p.accounts.map(a => a.id + (a.paper ? ' (paper)' : ' (LIVE)')).join(', ') : s.signedIn ? '(none could be determined)' : '—'),
        'Paper order submission allowed now: ' + (p.allowed ? 'yes' : 'no') + ' — ' + p.reason,
        'Paper order log: ' + (paperLog.file || '—'),
      ] : ['Paper mode: off']),
      'Token storage: ' + (storeKind === 'keychain' ? 'macOS Keychain' : storeKind === 'file' ? 'file (mode 0600) in ' + dataDir : storeKind || '—'),
      'Upstream: ' + upstreamUrl,
      ...(s.lastError ? ['Last sign-in error: ' + s.lastError] : []),
    ];
    const paperInfo = p ? { enabled: true, confirm: !paperNoConfirm, accounts: p.accounts, submitAllowed: p.allowed, reason: p.reason, log: paperLog.file } : { enabled: false };
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...s, readOnly, paper: paperInfo, upstream: upstreamUrl, storage: storeKind } };
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
    if (cls === 'block' && paper) return paperSubmit(name, args);
    if (cls === 'block') return text('Blocked by ibkr-mcp-guard: ' + name + ' would place/submit/transmit an order. This guard never sends orders to the market — create an order draft instead and approve it yourself inside IBKR.', true);
    if (readOnly && cls !== 'read') return text('Blocked by ibkr-mcp-guard: read-only mode (IBKR_MCP_GUARD_READONLY=1) hides tools that change anything, including ' + name + '.', true);
    if (!auth.status().signedIn) return beginSignIn(modeChangeNote() + 'You are not signed in to Interactive Brokers yet, so ' + name + ' was not called. ');
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
          instructions: paper ? INSTRUCTIONS + ' ' + PAPER_INSTRUCTIONS : INSTRUCTIONS,
        };
      }
      case 'ping':
        return {};
      case 'tools/list': {
        const tools = await upstreamTools();
        let paperSubmit = false;
        if (paper) { // re-evaluated on every listing; a change is announced with list_changed
          paperSubmit = (await paperSession().catch(() => ({ allowed: false }))).allowed;
          if (paperSubmit !== paperVisible) { paperVisible = paperSubmit; notifyListChanged(); }
        }
        const own = guardTools(paper);
        const ownNames = [...GUARD_TOOL_NAMES, ...PAPER_TOOL_NAMES];
        const upstream = visibleTools(tools, { readOnly, paperSubmit }).filter(t => !ownNames.includes(t.name));
        return { tools: [...own, ...upstream] };
      }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!name) throw rpcError(-32602, 'tools/call needs a tool name.');
        if (name === 'ibkr_sign_in') {
          if (auth.status().signedIn && (await auth.token().catch(() => ''))) return text('Already signed in to Interactive Brokers. Use ibkr_status for details, or ibkr_sign_out to disconnect.');
          const note = modeChangeNote();
          const r = await beginSignIn();
          return note ? { ...r, content: [{ type: 'text', text: note + r.content[0].text }] } : r;
        }
        if (name === 'ibkr_status') return statusText();
        if (name === 'ibkr_paper_log') return paperLogText(params.arguments);
        if (name === 'ibkr_sign_out') {
          const r = await auth.signOut();
          memo = null;
          paperVisible = false;
          client.reset?.();
          notifyListChanged();
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
