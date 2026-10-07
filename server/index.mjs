#!/usr/bin/env node
// ibkr-mcp-guard: a local stdio MCP server that proxies Interactive Brokers' official public MCP server
// (https://api.ibkr.com/v1/api/mcp-public) through a safety guard. See README.md.
//
// stdout carries only MCP JSON-RPC; logs go to stderr and never contain tokens.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuard } from './lib/guard.mjs';
import { createClient } from './lib/mcp-client.mjs';
import { IBKR_MCP_URL, createAuth, openBrowser } from './lib/oauth.mjs';
import { createStdioServer } from './lib/stdio.mjs';
import { createStore, dataDir } from './lib/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let version = '0.0.0';
try { version = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version || version; } catch {}

const log = msg => { try { process.stderr.write('[ibkr-mcp-guard] ' + msg + '\n'); } catch {} };
const env = process.env;
const truthy = v => /^(1|true|yes|on)$/i.test(String(v || ''));

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) { log('Node.js 20 or newer is required (found ' + process.versions.node + ').'); process.exit(1); }

const upstreamUrl = env.IBKR_MCP_GUARD_UPSTREAM || IBKR_MCP_URL;
if (upstreamUrl !== IBKR_MCP_URL) log('using a non-default upstream (IBKR_MCP_GUARD_UPSTREAM): ' + upstreamUrl);
const readOnly = truthy(env.IBKR_MCP_GUARD_READONLY);
const dir = dataDir(env);
const store = createStore({ account: upstreamUrl, env });

const auth = createAuth({
  serverUrl: upstreamUrl,
  store,
  clientName: 'ibkr-mcp-guard',
  openUrl: truthy(env.IBKR_MCP_GUARD_NO_BROWSER) ? async () => { throw new Error('browser disabled'); } : url => openBrowser(url),
});
const client = createClient({ url: upstreamUrl, getToken: o => auth.token(o), clientInfo: { name: 'ibkr-mcp-guard', version } });

let guard;
const server = createStdioServer({
  handler: m => guard.handle(m),
  onClose: () => { auth.cancel(); process.stdout.write('', () => process.exit(0)); },
});
guard = createGuard({ upstreamUrl, auth, client, dataDir: dir, readOnly, version, peer: server, log, storeKind: store.kind });

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('unhandledRejection', e => log('unhandled: ' + (e?.message || e)));
log('ready (v' + version + (readOnly ? ', read-only' : '') + ', storage: ' + store.kind + ')');
