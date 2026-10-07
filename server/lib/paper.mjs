// Opt-in PAPER MODE (IBKR_MCP_GUARD_PAPER=1): order submission, for IBKR paper accounts only.
//
//   gate      Before EVERY submit the account ids this sign-in can see are read fresh from IBKR (the account tools'
//             answers are scanned for ids like DU1234567 / U1234567). The submit goes through only if at least one id
//             was found and every id is a paper account (prefix DU or DF). If the call's arguments name an account,
//             it must be a paper id from that fresh list. Nothing about the verdict is cached beyond the one call.
//   listing   submit tools (everything the default policy blocks) are listed with PAPER_PREFIX only while the session
//             is verified paper-only; otherwise they stay hidden (and are refused if called by name).
//   audit     every submit attempt (allowed, refused or cancelled) is appended to <data dir>/paper-orders.log as one
//             JSON line: time, tool, decision, reason, accounts seen, a read-back of the order and its arguments.
//             Tokens never reach this file.

import fs from 'node:fs';
import path from 'node:path';
import { PAPER_PREFIX, classify } from './policy.mjs';
import { ensureDir } from './store.mjs';

export { PAPER_PREFIX };
export const PAPER_LOG = 'paper-orders.log';

/** IBKR account ids: DU/DF = paper (individual / advisor), U/F/I = live. */
export const ACCOUNT_ID = /\b(?:DU|DF|U|F|I)\d{5,}\b/g;
const PAPER_ID = /^(?:DU|DF)\d{5,}$/;
export const isPaperId = id => PAPER_ID.test(String(id));

/** Every account-id-looking string anywhere in a value (scanned as JSON, so nested text is included). */
export function findAccountIds(value) {
  let s;
  try { s = typeof value === 'string' ? value : JSON.stringify(value); } catch { return []; }
  return [...new Set(String(s || '').match(ACCOUNT_ID) || [])];
}

const ACCOUNT_KEY = /^(?:acct|account)(?:_?ids?|_?numbers?|s)?$/i;

function walk(value, visit, depth = 0) {
  if (depth > 6 || !value || typeof value !== 'object') return;
  for (const [k, v] of Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value)) {
    visit(k, v);
    walk(v, visit, depth + 1);
  }
}

/**
 * The accounts an order's arguments name: ids found anywhere in them, plus any value under an account-like key
 * (accountId, acctId, account, accounts, ...), even if it does not look like an id (it is then refused).
 */
export function accountArgs(args) {
  const out = new Set(findAccountIds(args ?? {}));
  walk(args, (k, v) => {
    if (!ACCOUNT_KEY.test(k)) return;
    for (const x of Array.isArray(v) ? v : [v]) if ((typeof x === 'string' || typeof x === 'number') && String(x).trim()) out.add(String(x).trim());
  });
  return [...out];
}

/** Upstream tools read for account ids, the known ones first: read-class tools whose name mentions account(s). */
export const ACCOUNT_TOOLS = Object.freeze(['get_account_positions', 'get_account_balances', 'get_account_summary', 'get_account_orders']);
export function accountToolNames(tools = []) {
  const list = (Array.isArray(tools) ? tools : []).filter(t => t && typeof t.name === 'string');
  const reads = list.filter(t => /accounts?/i.test(t.name) && classify(t) === 'read').map(t => t.name);
  const known = new Set(reads);
  const first = list.length ? ACCOUNT_TOOLS.filter(n => known.has(n)) : [...ACCOUNT_TOOLS];
  return [...new Set([...first, ...reads])].slice(0, 8);
}

/**
 * Read the account ids this sign-in can see, fresh from IBKR: every account tool is called (in parallel, no
 * arguments) and its whole answer scanned. extraIds (e.g. from the sign-in's userinfo) are added.
 * -> {accounts: [{id, paper}], sources: [{tool, ids} | {tool, error}]}
 */
export async function readAccounts({ client, tools, extraIds = [], timeoutMs = 30000 }) {
  const names = accountToolNames(tools);
  const settled = await Promise.allSettled(names.map(n => client.callTool(n, {}, { timeoutMs })));
  const ids = new Set(findAccountIds(extraIds));
  const sources = settled.map((s, i) => {
    if (s.status !== 'fulfilled') return { tool: names[i], error: String(s.reason?.message || 'failed').slice(0, 200) };
    const found = findAccountIds(s.value);
    for (const id of found) ids.add(id);
    return { tool: names[i], ids: found };
  });
  return { accounts: [...ids].sort().map(id => ({ id, paper: isPaperId(id) })), sources };
}

const label = a => a.id + (a.paper ? ' (paper)' : ' (LIVE)');

/** The paper gate. accounts: the fresh read; argIds: accounts named by the order (accountArgs). */
export function paperVerdict({ accounts = [], argIds = [] } = {}) {
  const refuse = reason => ({ allowed: false, reason });
  if (!accounts.length) return refuse('No account ids could be read from IBKR, so the guard cannot confirm that this sign-in only reaches paper accounts.');
  const live = accounts.filter(a => !a.paper);
  if (live.length) return refuse('This sign-in can see non-paper (live) account(s): ' + live.map(a => a.id).join(', ') + '. Paper mode only submits when every visible account is a paper account (DU…/DF…). Sign out and sign in with your PAPER login.');
  const seen = new Set(accounts.map(a => a.id));
  for (const id of argIds) {
    if (!isPaperId(id)) return refuse('The order names account "' + String(id).slice(0, 40) + '", which is not a paper account id (DU…/DF…).');
    if (!seen.has(id)) return refuse('The order names account ' + id + ', which is not among the accounts this sign-in can see (' + accounts.map(a => a.id).join(', ') + ').');
  }
  return { allowed: true, reason: 'Every account this sign-in can see is a paper account: ' + accounts.map(label).join(', ') + '.' };
}

const READ_BACK = [
  ['account', /^(?:acct|account)(?:_?ids?|s)?$/i],
  ['side', /^(?:side|action|buy_?sell)$/i],
  ['quantity', /^(?:qty|quantity|total_?quantity|order_?qty|size|shares)$/i],
  ['symbol', /^(?:symbol|ticker|local_?symbol)$/i],
  ['conid', /^(?:conid|con_?id|contract_?id)$/i],
  ['orderType', /^(?:order_?type|ord_?type|type)$/i],
  ['price', /^(?:price|lmt_?price|limit_?price|aux_?price|stop_?price|trigger_?price)$/i],
  ['tif', /^(?:tif|time_?in_?force)$/i],
];
const scalar = v => (['string', 'number', 'boolean'].includes(typeof v) ? String(v) : Array.isArray(v) && v.length && v.every(x => ['string', 'number'].includes(typeof x)) ? v.join(', ') : null);

/** A plain read-back of an order's arguments: {account, side, quantity, symbol, orderType, price, tif} (when present). */
export function readBack(args) {
  const out = {};
  const prices = [];
  walk(args, (k, v) => {
    const s = scalar(v);
    if (s === null) return;
    for (const [field, re] of READ_BACK) {
      if (!re.test(k)) continue;
      if (field === 'price') { if (prices.length < 4) prices.push(/^price$/i.test(k) ? s : s + ' (' + k + ')'); }
      else if (!(field in out)) out[field] = s.slice(0, 80);
      break;
    }
  });
  if (prices.length) out.price = prices.join(', ');
  if (out.conid) out.symbol = out.symbol ? out.symbol + ' (conid ' + out.conid + ')' : 'conid ' + out.conid;
  delete out.conid;
  return out;
}

/** The elicitation text for a paper submit. */
export function confirmMessage(name, args, accounts) {
  const r = readBack(args);
  const paperIds = accounts.map(a => a.id).join(', ');
  const lines = [
    'Submit this order to your IBKR PAPER account?',
    '',
    'Account: ' + (r.account || '(not named — IBKR picks it; this sign-in sees only ' + paperIds + ')'),
    'Side: ' + (r.side || '(not given)'),
    'Quantity: ' + (r.quantity || '(not given)'),
    'Symbol: ' + (r.symbol || '(not given)'),
    'Order type: ' + (r.orderType || '(not given)'),
    ...(r.price ? ['Price: ' + r.price] : []),
    'Time in force: ' + (r.tif || '(not given)'),
    '',
    'Tool: ' + name,
    'Full arguments: ' + truncatedJson(args, 1500),
    '',
    'Every account this sign-in can see is a paper account (' + paperIds + '). This is a simulated order; live accounts are refused.',
  ];
  return lines.join('\n');
}

export function truncatedJson(v, max = 2000) {
  let s;
  try { s = JSON.stringify(v ?? {}); } catch { s = '"(unserialisable)"'; }
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** The append-only audit log of paper submit attempts (JSON lines, mode 0600). */
export function createPaperLog(dir, now = () => Date.now()) {
  const file = dir ? path.join(dir, PAPER_LOG) : '';
  return {
    file,
    append(entry) {
      if (!file) return;
      ensureDir(dir);
      fs.appendFileSync(file, JSON.stringify({ time: new Date(now()).toISOString(), ...entry }) + '\n', { mode: 0o600 });
    },
    /** The last `limit` entries, oldest first. */
    read(limit = 20) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
      const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)));
      return text.split('\n').filter(Boolean).slice(-n).map(l => { try { return JSON.parse(l); } catch { return { unreadable: l.slice(0, 200) }; } });
    },
  };
}
