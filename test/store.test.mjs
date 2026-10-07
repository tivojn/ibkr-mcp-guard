import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStore, dataDir, fileStore, keychainStore } from '../server/lib/store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-guard-'));

test('data directory precedence', () => {
  assert.equal(dataDir({ CLAUDE_PLUGIN_DATA: '/a', PLUGIN_DATA: '/b', XDG_CONFIG_HOME: '/c' }), '/a');
  assert.equal(dataDir({ PLUGIN_DATA: '/b', XDG_CONFIG_HOME: '/c' }), '/b');
  assert.equal(dataDir({ XDG_CONFIG_HOME: '/c' }), path.join('/c', 'ibkr-mcp-guard'));
  assert.equal(dataDir({}), path.join(os.homedir(), '.config', 'ibkr-mcp-guard'));
});

test('file store writes with mode 0600 and round-trips', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp(), 'nested');
  const s = fileStore({ dir, account: 'https://api.ibkr.com/v1/api/mcp-public' });
  assert.equal(s.read(), null);
  s.write('{"tokens":{"access":"x"}}');
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(s.read(), '{"tokens":{"access":"x"}}');
  fs.chmodSync(s.file, 0o644);
  s.write('{}');
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  s.clear();
  assert.equal(s.read(), null);
});

test('IBKR_MCP_GUARD_STORE=file forces the file store; non-macOS uses the file store', () => {
  const dir = tmp();
  assert.equal(createStore({ account: 'u', env: { IBKR_MCP_GUARD_STORE: 'file', CLAUDE_PLUGIN_DATA: dir }, platform: 'darwin' }).kind, 'file');
  assert.equal(createStore({ account: 'u', env: { CLAUDE_PLUGIN_DATA: dir }, platform: 'linux' }).kind, 'file');
  assert.equal(createStore({ account: 'u', env: { CLAUDE_PLUGIN_DATA: dir }, platform: 'darwin' }).kind, 'keychain');
});

test('keychain store: chunks via stdin, never puts the secret on the command line', () => {
  const items = new Map();
  const argvSeen = [];
  const run = (cmd, args, { input } = {}) => {
    assert.equal(cmd, 'security');
    argvSeen.push(args.join(' '));
    if (args[0] === '-i') {
      for (const line of input.trim().split('\n')) {
        assert.ok(line.length < 4000, 'line too long for security -i');
        const m = /-a "([^"]+)" -l "[^"]+" -w "([^"]*)"/.exec(line);
        items.set(m[1], m[2]);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    const acct = args[args.indexOf('-a') + 1];
    if (args[0] === 'find-generic-password') return items.has(acct) ? { status: 0, stdout: items.get(acct) + '\n' } : { status: 44, stdout: '' };
    if (args[0] === 'delete-generic-password') { items.delete(acct); return { status: 0 }; }
    return { status: 1 };
  };
  const s = keychainStore({ account: 'https://api.ibkr.com/v1/api/mcp-public', run });
  const payload = JSON.stringify({ tokens: { access: 'A'.repeat(7000), refresh: 'R'.repeat(3000) }, note: 'ünïcode "quotes"' });
  s.write(payload);
  assert.ok(items.size >= 4);
  assert.equal(s.read(), payload);
  for (const a of argvSeen) assert.ok(!a.includes('AAAA'), 'secret leaked into argv');
  s.write('{"small":true}');
  assert.equal(s.read(), '{"small":true}');
  assert.equal(items.size, 2, 'stale chunks removed');
  s.clear();
  assert.equal(items.size, 0);
  assert.equal(s.read(), null);
});
