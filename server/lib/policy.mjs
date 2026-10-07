// The guard's tool policy. Every upstream tool is put in one of four classes before it is listed or called:
//
//   block  never listed, never called: anything that places, submits, transmits or executes an order (or buys/sells,
//          replies to an order confirmation, or changes a live order), and any tool whose definition mentions the
//          mcp.orders.submit scope.
//   draft  order instructions (IBKR's order DRAFTS): listed with a warning prefix and destructiveHint; a draft only
//          becomes an order when you approve it yourself inside IBKR.
//   write  changes something harmless in your account: alerts, watchlists, feedback (and any other mutating verb).
//   read   everything else.
//
// The classification is by name first (conservative), so a server cannot unblock a tool by annotating it read-only.
//
// In opt-in paper mode (paper.mjs) the guard may list the block class with PAPER_PREFIX instead, but only while the
// session is verified to reach paper accounts alone; each call is still gated on a fresh account check.

export const DRAFT_PREFIX = 'Creates/changes an order DRAFT (order instruction) only — nothing is sent to the market; you approve drafts inside IBKR.';
export const PAPER_PREFIX = 'PAPER ACCOUNT ONLY — submits a simulated order to your IBKR paper account (DU…). Refused for live accounts.';

const SUBMIT_SCOPE = /orders?\.submit/i;
const SUBMIT_VERBS = new Set(['place', 'submit', 'transmit', 'execute', 'send']);
const TRADE_WORDS = new Set(['buy', 'sell', 'trade', 'trades']);
const LIVE_ORDER_CHANGE = new Set(['modify', 'cancel', 'replace', 'update', 'create', 'delete', 'edit', 'change', 'new', 'reply', 'confirm', 'whatif']);
const READ_VERBS = new Set(['get', 'search', 'list', 'find', 'lookup', 'query', 'fetch', 'describe', 'show', 'whats', 'read', 'check']);
const MUTATE = new Set(['create', 'add', 'delete', 'remove', 'update', 'set', 'edit', 'modify', 'rename', 'provide', 'save', 'toggle', 'enable', 'disable', 'clear', 'reset', 'post', 'put', 'patch', 'move', 'cancel', 'replace', 'change', 'write', 'upload']);

const words = name => String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Does the tool declare that it needs the order-submission scope? Checked in its structured metadata (annotations,
 * _meta, securitySchemes, scopes, ...), not in its prose: a description that merely explains that drafts are submitted
 * inside IBKR must not hide the draft tool.
 */
export function requiresSubmitScope(tool) {
  if (!tool || typeof tool !== 'object') return false;
  const { name, title, description, inputSchema, outputSchema, ...meta } = tool;
  try { return SUBMIT_SCOPE.test(JSON.stringify(meta)); } catch { return true; }
}

/** classify(toolOrName) -> 'block' | 'draft' | 'write' | 'read' */
export function classify(tool) {
  const name = typeof tool === 'string' ? tool : tool?.name;
  const n = String(name || '').toLowerCase();
  const w = words(n);
  const isInstruction = /order_?instructions?/.test(n);
  const mentionsOrder = w.some(x => x === 'order' || x === 'orders');

  if (typeof tool === 'object' && requiresSubmitScope(tool)) return 'block';
  if (w.some(x => SUBMIT_VERBS.has(x)) && (mentionsOrder || isInstruction || w.some(x => TRADE_WORDS.has(x)) || SUBMIT_VERBS.has(w[0]))) {
    // send_feedback-style tools are not orders; only submit/place/transmit/execute verbs without an order context are refused
    if (!(w[0] === 'send' && !mentionsOrder && !isInstruction)) return 'block';
  }
  if (w.some(x => x === 'buy' || x === 'sell') && !READ_VERBS.has(w[0])) return 'block';
  if (mentionsOrder && !isInstruction && !READ_VERBS.has(w[0]) && w.some(x => LIVE_ORDER_CHANGE.has(x))) return 'block';

  if (isInstruction) return READ_VERBS.has(w[0]) ? 'read' : 'draft';
  if (READ_VERBS.has(w[0])) return 'read';
  if (w.some(x => MUTATE.has(x))) return 'write';
  if (/alert|watchlist|feedback/.test(n) && !READ_VERBS.has(w[0])) return 'write';
  if (typeof tool === 'object' && tool?.annotations?.readOnlyHint === false) return 'write';
  return 'read';
}

/** The tool as the guard lists it: description prefix and annotations set by class ('paper' = a paper-mode submit). */
export function decorate(tool, cls = classify(tool)) {
  const annotations = { ...(tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {}) };
  let description = typeof tool.description === 'string' ? tool.description : '';
  if (cls === 'paper') {
    description = PAPER_PREFIX + (description ? '\n\n' + description : '');
    Object.assign(annotations, { readOnlyHint: false, destructiveHint: true });
  } else if (cls === 'draft') {
    description = DRAFT_PREFIX + (description ? '\n\n' + description : '');
    Object.assign(annotations, { readOnlyHint: false, destructiveHint: true });
  } else if (cls === 'write') {
    Object.assign(annotations, { readOnlyHint: false, destructiveHint: false });
  } else {
    Object.assign(annotations, { readOnlyHint: true, destructiveHint: false });
  }
  const out = { ...tool, description, annotations };
  if (!out.inputSchema || typeof out.inputSchema !== 'object') out.inputSchema = { type: 'object' };
  return out;
}

/**
 * The upstream tools the guard exposes: blocked ones removed; with readOnly, drafts and writes removed too.
 * paperSubmit (paper mode, session verified paper-only, never with readOnly) lists the blocked ones as paper submits.
 */
export function visibleTools(tools, { readOnly = false, paperSubmit = false } = {}) {
  const out = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t.name !== 'string') continue;
    const cls = classify(t);
    if (cls === 'block') {
      if (paperSubmit && !readOnly) out.push(decorate(t, 'paper'));
      continue;
    }
    if (readOnly && cls !== 'read') continue;
    out.push(decorate(t, cls));
  }
  return out;
}
