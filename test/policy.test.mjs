import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DRAFT_PREFIX, PAPER_PREFIX, classify, decorate, requiresSubmitScope, visibleTools } from '../server/lib/policy.mjs';
import { REAL_TOOLS } from './helpers.mjs';

test('order submission tools are blocked', () => {
  for (const n of ['place_order', 'submit_order', 'transmit_order', 'execute_order', 'place_orders', 'submit_order_instruction',
    'transmit_order_instruction', 'buy_stock', 'sell', 'cancel_order', 'modify_order', 'reply_order', 'confirm_order', 'submit', 'place']) {
    assert.equal(classify(n), 'block', n);
  }
});

test('order instructions are drafts', () => {
  assert.equal(classify('create_order_instruction'), 'draft');
  assert.equal(classify('delete_order_instruction'), 'draft');
  assert.equal(classify('get_order_instructions'), 'read');
});

test('real tool names classify as expected', () => {
  const want = {
    create_alert: 'write', update_alert: 'write', delete_alert: 'write', set_alert_status: 'write',
    create_watchlist: 'write', update_watchlist: 'write', delete_watchlist: 'write', provide_customer_feedback: 'write',
    create_order_instruction: 'draft', delete_order_instruction: 'draft',
  };
  for (const n of REAL_TOOLS) {
    const expected = want[n] || 'read';
    assert.equal(classify(n), expected, n);
  }
  for (const n of REAL_TOOLS.filter(n => n.startsWith('get_') || n.startsWith('search_'))) assert.equal(classify(n), 'read', n);
});

test('a tool that requires mcp.orders.submit in its metadata is blocked, prose mentions are not', () => {
  const t1 = { name: 'get_price_snapshot', _meta: { requiredScopes: ['mcp.orders.submit'] } };
  const t2 = { name: 'some_tool', securitySchemes: [{ type: 'oauth2', scopes: ['mcp.read', 'mcp.orders.submit'] }] };
  const t3 = { name: 'create_order_instruction', description: 'Drafts are submitted later by the user (mcp.orders.submit is not needed here).' };
  assert.equal(requiresSubmitScope(t1), true);
  assert.equal(classify(t1), 'block');
  assert.equal(classify(t2), 'block');
  assert.equal(classify(t3), 'draft');
});

test('annotations cannot unblock a submit tool', () => {
  assert.equal(classify({ name: 'place_order', annotations: { readOnlyHint: true } }), 'block');
});

test('decorate sets the draft prefix and annotations', () => {
  const d = decorate({ name: 'create_order_instruction', description: 'Create an order instruction.', inputSchema: { type: 'object' } });
  assert.ok(d.description.startsWith(DRAFT_PREFIX));
  assert.ok(d.description.endsWith('Create an order instruction.'));
  assert.equal(d.annotations.destructiveHint, true);
  assert.equal(d.annotations.readOnlyHint, false);
  const w = decorate({ name: 'create_alert', description: 'x' });
  assert.deepEqual([w.annotations.readOnlyHint, w.annotations.destructiveHint], [false, false]);
  const r = decorate({ name: 'get_account_positions', description: 'x', annotations: { title: 'Positions' } });
  assert.equal(r.annotations.readOnlyHint, true);
  assert.equal(r.annotations.title, 'Positions');
  assert.deepEqual(r.inputSchema, { type: 'object' });
});

test('visibleTools removes blocked tools; read-only mode removes drafts and writes', () => {
  const tools = [...REAL_TOOLS, 'place_order', 'submit_order', 'transmit_order'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
  const v = visibleTools(tools).map(t => t.name);
  assert.equal(v.length, REAL_TOOLS.length);
  for (const n of ['place_order', 'submit_order', 'transmit_order']) assert.ok(!v.includes(n));
  assert.ok(v.includes('create_order_instruction'));
  const ro = visibleTools(tools, { readOnly: true }).map(t => t.name);
  assert.ok(!ro.includes('create_order_instruction'));
  assert.ok(!ro.includes('create_alert'));
  assert.ok(ro.includes('get_account_balances'));
  assert.ok(visibleTools(tools, { readOnly: true }).every(t => t.annotations.readOnlyHint === true));
});

test('paperSubmit lists blocked tools as paper submits; read-only and the default never do', () => {
  const tools = ['get_account_balances', 'place_order', 'cancel_order'].map(name => ({ name, description: 'x', inputSchema: { type: 'object' } }));
  const v = visibleTools(tools, { paperSubmit: true });
  const place = v.find(t => t.name === 'place_order');
  assert.ok(place.description.startsWith(PAPER_PREFIX));
  assert.deepEqual([place.annotations.readOnlyHint, place.annotations.destructiveHint], [false, true]);
  assert.ok(v.some(t => t.name === 'cancel_order'));
  assert.ok(!visibleTools(tools).some(t => t.name === 'place_order'));
  assert.ok(!visibleTools(tools, { paperSubmit: true, readOnly: true }).some(t => t.name === 'place_order'));
});

test('unrecognised tool names fail safe as order tools; IBKR research tools stay readable', () => {
  for (const n of ['company_themes', 'company_connections', 'theme_details', 'whats_new', 'search_investment_topics', 'get_account_summary']) assert.equal(classify(n), 'read', n);
  for (const n of ['stage_trade_ticket', 'preview_order', 'route_ticket', 'go']) assert.equal(classify(n), 'block', n);
});
