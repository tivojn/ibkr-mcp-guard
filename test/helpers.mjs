// Shared fakes for the offline tests (no test cases here).
import http from 'node:http';

export const IBKR = {
  mcp: 'https://api.ibkr.com/v1/api/mcp-public',
  www: 'Bearer resource_metadata="https://api.ibkr.com/v1/api/mcp-public/.well-known/oauth-protected-resource"',
  rmUrl: 'https://api.ibkr.com/v1/api/mcp-public/.well-known/oauth-protected-resource',
  rm: { resource: 'https://api.ibkr.com/v1/api/mcp-public', authorization_servers: ['https://api.ibkr.com'], scopes_supported: ['mcp.read', 'mcp.write'] },
  asUrl: 'https://api.ibkr.com/.well-known/oauth-authorization-server',
  as: {
    issuer: 'https://api.ibkr.com',
    authorization_endpoint: 'https://api.ibkr.com/oauth2/authorize',
    token_endpoint: 'https://api.ibkr.com/oauth2/api/v1/token',
    revocation_endpoint: 'https://api.ibkr.com/oauth2/api/v1/token/revoke',
    userinfo_endpoint: 'https://api.ibkr.com/oauth2/api/v1/userinfo',
    registration_endpoint: 'https://api.ibkr.com/oauth2/register',
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['openid', 'profile', 'email', 'account-ids', 'mcp.read', 'mcp.write', 'mcp.orders.submit'],
  },
};

// Tool names from IBKR's public MCP server (34 tools; the alert/watchlist CRUD names here are approximations).
export const REAL_TOOLS = [
  'get_account_balances', 'get_account_positions', 'get_account_summary', 'get_account_orders', 'get_account_trades',
  'get_pa_allocation', 'get_pa_performance_all_periods', 'get_price_snapshot', 'get_price_history', 'get_option_data',
  'get_option_parameters', 'search_contracts', 'search_futures', 'get_combo_identifier', 'create_order_instruction',
  'delete_order_instruction', 'get_order_instructions', 'create_alert', 'get_alerts', 'update_alert', 'delete_alert',
  'set_alert_status', 'create_watchlist', 'get_watchlists', 'update_watchlist', 'delete_watchlist', 'company_themes',
  'company_connections', 'theme_details', 'search_investment_topics', 'whats_new', 'provide_customer_feedback',
];

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake fetch: routes {'GET url' | 'POST url': (req) => Response}; records calls. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const key = method + ' ' + String(url).split('?')[0];
    const body = init.body === undefined ? undefined : String(init.body);
    const call = { method, url: String(url), headers: init.headers || {}, body };
    calls.push(call);
    const route = routes[key];
    if (!route) return new Response('not found', { status: 404 });
    return route(call);
  };
  fn.calls = calls;
  return fn;
}

/** Routes for IBKR discovery (anonymous 401 + both metadata documents). */
export function ibkrDiscoveryRoutes(mcpUrl = IBKR.mcp) {
  return {
    ['POST ' + mcpUrl]: () => new Response(null, { status: 401, headers: { 'www-authenticate': IBKR.www } }),
    ['GET ' + IBKR.rmUrl]: () => json(IBKR.rm),
    ['GET ' + IBKR.asUrl]: () => json(IBKR.as),
  };
}

/** A memory store. */
export function memoryStore(initial = null) {
  let v = initial === null ? null : JSON.stringify(initial);
  return { kind: 'memory', read: () => v, write: t => { v = t; }, clear: () => { v = null; }, peek: () => (v ? JSON.parse(v) : null) };
}

/**
 * A fake upstream MCP server over real HTTP on 127.0.0.1 (Streamable HTTP, JSON or SSE answers).
 * opts: {token, tools, sse, scope (granted on sign-in), onCall}
 */
export async function startFakeUpstream({ token = 'test-access-token', tools, sse = false, scope = 'openid account-ids mcp.read mcp.write', onCall = () => ({ content: [{ type: 'text', text: 'ok' }] }) } = {}) {
  const calls = [];
  const auth = { registrations: [], tokenRequests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const origin = 'http://127.0.0.1:' + server.address().port;
      const u = new URL(req.url, origin);
      const out = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      // a tiny authorization server on the same origin, for the end-to-end sign-in
      if (req.method === 'GET' && u.pathname === '/.well-known/oauth-protected-resource') return out(200, { resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['mcp.read', 'mcp.write'] });
      if (req.method === 'GET' && u.pathname === '/.well-known/oauth-authorization-server') {
        return out(200, { issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', revocation_endpoint: origin + '/revoke', code_challenge_methods_supported: ['S256'] });
      }
      if (req.method === 'POST' && u.pathname === '/register') { auth.registrations.push(JSON.parse(body)); return out(201, { client_id: 'fake-client' }); }
      if (req.method === 'POST' && u.pathname === '/token') {
        const p = Object.fromEntries(new URLSearchParams(body));
        auth.tokenRequests.push(p);
        return out(200, { access_token: token, refresh_token: 'test-refresh', expires_in: 3600, token_type: 'Bearer', scope });
      }
      if (req.method === 'POST' && u.pathname === '/revoke') return out(200, {});
      if (req.method !== 'POST' || u.pathname !== '/mcp') { res.writeHead(404); res.end(); return; }
      if (req.headers.authorization !== 'Bearer ' + token) {
        res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1:' + server.address().port + '/.well-known/oauth-protected-resource"' });
        res.end();
        return;
      }
      let m;
      try { m = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      calls.push(m);
      if (!('id' in m)) { res.writeHead(202); res.end(); return; }
      let result;
      if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-ibkr', version: '1' } };
      else if (m.method === 'tools/list') result = { tools: tools || [] };
      else if (m.method === 'tools/call') result = onCall(m.params);
      else { send(res, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } }); return; }
      send(res, { jsonrpc: '2.0', id: m.id, result }, m.method === 'initialize');
    });
  });
  function send(res, msg, init) {
    const headers = init ? { 'mcp-session-id': 'sess-1' } : {};
    if (sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
      res.end(': hello\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\ndata: ' + JSON.stringify(msg) + '\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(msg));
    }
  }
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + server.address().port + '/mcp', calls, auth, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
