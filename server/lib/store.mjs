// Where the sign-in (OAuth client registration + tokens) is kept.
//
//   macOS     the login Keychain, through the `security` CLI: generic-password items with service "ibkr-mcp-guard" and
//             account = the MCP server URL. The secret is never put on a command line (where `ps` could see it): it is
//             written through `security -i` on stdin. That mode reads lines of at most ~4 KB, so the payload (JSON,
//             base64-encoded) is split over chunk items "<url>#1", "<url>#2", ...; the item "<url>" holds "v1:<chunks>".
//   elsewhere a JSON file with mode 0600 in the data directory (dataDir()).
//   IBKR_MCP_GUARD_STORE=file forces the file store on macOS too.
//
// The data directory also holds the (non-secret) cached upstream tool list.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SERVICE = 'ibkr-mcp-guard';
const CHUNK = 3000; // base64 characters per keychain item (well under the ~4 KB `security -i` line limit)

/** The plugin's data directory (not created here). */
export function dataDir(env = process.env) {
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  if (env.PLUGIN_DATA) return env.PLUGIN_DATA;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'ibkr-mcp-guard');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A file holding one secret JSON string, always mode 0600 (written to a temp file, then renamed). */
export function fileStore({ dir, account }) {
  const name = 'auth-' + createHash('sha256').update(String(account)).digest('hex').slice(0, 16) + '.json';
  const file = path.join(dir, name);
  return {
    kind: 'file',
    file,
    read() {
      try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
    },
    write(text) {
      ensureDir(dir);
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, String(text), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    },
    clear() {
      try { fs.unlinkSync(file); } catch {}
    },
  };
}

const quoteArg = s => '"' + String(s).replace(/(["\\])/g, '\\$1') + '"';

/** macOS Keychain store via the `security` CLI (see the header comment for the chunk layout). */
export function keychainStore({ account, service = SERVICE, run = spawnSync }) {
  const sec = (args, input) => run('security', args, { input, encoding: 'utf8', timeout: 15000 });
  const find = acct => {
    const r = sec(['find-generic-password', '-s', service, '-a', acct, '-w']);
    return r.status === 0 ? String(r.stdout).replace(/\n$/, '') : null;
  };
  const chunksIn = head => {
    const m = /^v1:(\d{1,4})$/.exec(head || '');
    return m ? Number(m[1]) : 0;
  };
  function remove(fromChunk, toChunk) {
    for (let i = fromChunk; i <= toChunk; i++) sec(['delete-generic-password', '-s', service, '-a', i ? account + '#' + i : account]);
  }
  return {
    kind: 'keychain',
    read() {
      const n = chunksIn(find(account));
      if (!n) return null;
      let b64 = '';
      for (let i = 1; i <= n; i++) {
        const part = find(account + '#' + i);
        if (part === null) return null;
        b64 += part;
      }
      try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return null; }
    },
    write(text) {
      const oldN = chunksIn(find(account));
      const b64 = Buffer.from(String(text), 'utf8').toString('base64');
      const parts = b64.match(new RegExp('.{1,' + CHUNK + '}', 'g')) || [''];
      const lines = parts.map((p, i) => `add-generic-password -U -s ${quoteArg(service)} -a ${quoteArg(account + '#' + (i + 1))} -l ${quoteArg(service)} -w ${quoteArg(p)}`);
      lines.push(`add-generic-password -U -s ${quoteArg(service)} -a ${quoteArg(account)} -l ${quoteArg(service)} -w ${quoteArg('v1:' + parts.length)}`);
      const r = sec(['-i'], lines.join('\n') + '\n');
      if (r.status !== 0 || /error|unknown command/i.test(String(r.stderr || ''))) throw new Error('Could not save the sign-in to the macOS Keychain.');
      if (oldN > parts.length) remove(parts.length + 1, oldN);
    },
    clear() {
      const n = chunksIn(find(account));
      remove(1, n);
      remove(0, 0);
    },
  };
}

/** The store for this server URL: Keychain on macOS (unless IBKR_MCP_GUARD_STORE=file), else a 0600 file. */
export function createStore({ account, env = process.env, platform = process.platform } = {}) {
  const forced = String(env.IBKR_MCP_GUARD_STORE || '').toLowerCase();
  if (platform === 'darwin' && forced !== 'file') return keychainStore({ account });
  return fileStore({ dir: dataDir(env), account });
}
