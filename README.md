# ibkr-mcp-guard

**IBKR (guarded)**: a small local MCP server that lets your AI assistant use **Interactive Brokers' official MCP server** through a safety guard. The assistant can read your account and market data and create order **drafts**. It can never send an order to the market.

An opt-in [paper trading mode](#paper-trading-mode) lets the assistant submit orders to an IBKR **paper** (simulated) account, so you can test strategies. Live accounts can never receive orders.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by Interactive Brokers. It connects to IBKR's official public MCP server (`https://api.ibkr.com/v1/api/mcp-public`), [announced on 28 July 2026](https://www.interactivebrokers.com/en/general/about/mediaRelations/7-28-26.php), using IBKR's own browser sign-in.

- Runs locally over stdio. Needs Node.js 20 or newer and has **no npm dependencies**.
- Installs by URL as a plugin in **EnConvo**, **Claude Code** and **Codex**, or runs with `npx`.

## Safety guarantees

| | |
|---|---|
| **Never requests order submission** | It asks for the scopes `openid account-ids mcp.read mcp.write` and nothing else. If code ever asks for `mcp.orders.submit`, an assertion throws, and a test checks this. If IBKR grants that scope anyway, `ibkr_status` reports it. The only exception is the opt-in [paper trading mode](#paper-trading-mode), which you must turn on yourself. |
| **Submit tools removed** | Any upstream tool that places, submits, transmits or executes an order, or that requires `mcp.orders.submit`, is removed from the tool list and refused if called by name. This also covers buy/sell tools, replies to order confirmations, and changes to live orders. |
| **Drafts only** | Order *instructions* (`create_order_instruction`, `delete_order_instruction`) are IBKR's order drafts. They are listed with the warning *"Creates/changes an order DRAFT (order instruction) only — nothing is sent to the market; you approve drafts inside IBKR."* and marked `destructiveHint: true`. A draft becomes an order only when **you** approve it inside IBKR. |
| **Asks before drafting** | If your MCP client supports [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation), the guard asks you to Approve or Cancel each draft before sending it. Otherwise your host's own tool-approval prompt applies, which is triggered by `destructiveHint`. |
| **Tokens stay local** | **macOS:** stored in your login Keychain. **Elsewhere:** stored in a file with mode `0600`. Tokens are never logged. |
| **Nothing else leaves your machine** | The guard connects only to `api.ibkr.com`, plus `127.0.0.1` for the sign-in callback. There is no telemetry and no third-party server. |

Tool classes:

| Class | Examples | Behaviour |
|---|---|---|
| read | `get_account_balances`, `get_account_positions`, `get_account_summary`, `get_account_orders`, `get_account_trades`, `get_price_snapshot`, `get_price_history`, `get_option_data`, `search_contracts`, `whats_new` | Listed with `readOnlyHint: true`. |
| write | `create_alert`, `set_alert_status`, watchlist create/update/delete, `provide_customer_feedback` | Listed with `readOnlyHint: false, destructiveHint: false`. |
| draft | `create_order_instruction`, `delete_order_instruction` | Listed with the DRAFT prefix and `destructiveHint: true`; asks first when the client supports elicitation. |
| block | `place_order`, `submit_order`, `transmit_order`, any tool requiring `mcp.orders.submit` | Never listed, never called. |

Set `IBKR_MCP_GUARD_READONLY=1` to hide the write and draft tools as well.

## Install

### EnConvo

Open **Plugins → Install from URL** and paste:

```
https://github.com/tivojn/ibkr-mcp-guard
```

EnConvo reads `.mcp.json` and expands `${CLAUDE_PLUGIN_ROOT}`.

### Claude Code

As a plugin (this repo is its own marketplace):

```bash
claude plugin marketplace add https://github.com/tivojn/ibkr-mcp-guard
claude plugin install ibkr-mcp-guard@ibkr-mcp-guard
```

Inside Claude Code, the same commands are `/plugin marketplace add tivojn/ibkr-mcp-guard` followed by `/plugin install ibkr-mcp-guard@ibkr-mcp-guard`.

Or as a plain MCP server:

```bash
claude mcp add ibkr -- npx -y github:tivojn/ibkr-mcp-guard
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.ibkr]
command = "npx"
args = ["-y", "github:tivojn/ibkr-mcp-guard"]
startup_timeout_sec = 60   # the first npx run downloads the package
```

If you use a local clone, set `command = "node"` and `args = ["/path/to/ibkr-mcp-guard/server/index.mjs"]`. The repo also ships a `.codex-plugin/plugin.json` manifest for hosts that install Codex-format plugins by URL.

### Any other MCP client

```bash
npx -y github:tivojn/ibkr-mcp-guard        # stdio MCP server
# or from a clone:
node server/index.mjs
```

## First use

1. Ask your assistant to **"sign in to IBKR"**, or ask any IBKR question, such as "what are my positions?".
2. Your browser opens IBKR's sign-in page. The consent screen should list read access and order-instruction (draft) access only, **not order submission**. Approve it.
3. The tab says *Signed in to IBKR*. Go back to the assistant and ask again.

The guard's own tools work before you sign in:

- `ibkr_sign_in` opens the browser sign-in. It returns immediately and finishes in the background, and does nothing if you are already signed in.
- `ibkr_status` shows whether you are signed in, your account ids (if IBKR reports them), the granted scopes, when the token expires, and whether order submission was granted (it should say **no**).
- `ibkr_sign_out` revokes the tokens at IBKR and deletes them locally.
- `ibkr_paper_log` (only in [paper trading mode](#paper-trading-mode)) shows the latest paper-order audit entries.

Before you first sign in, the tool list shows only these three tools. After that, the guard caches IBKR's tool list, so the tools still appear when you are signed out. Calling one while signed out starts a sign-in.

## Environment variables

| Variable | Effect |
|---|---|
| `IBKR_MCP_GUARD_READONLY=1` | Hide and refuse write and draft tools; reads only. Also turns paper mode off. |
| `IBKR_MCP_GUARD_PAPER=1` | [Paper trading mode](#paper-trading-mode): order submission to IBKR **paper** accounts only. |
| `IBKR_MCP_GUARD_PAPER_NO_CONFIRM=1` | In paper mode, skip the guard's Approve/Cancel prompt before each paper order (for automated strategy runs). Has no effect outside paper mode. |
| `IBKR_MCP_GUARD_STORE=file` | Use the `0600` file instead of the macOS Keychain. |
| `IBKR_MCP_GUARD_NO_BROWSER=1` | Don't open a browser; the sign-in result includes the link to open yourself (useful over SSH). |
| `CLAUDE_PLUGIN_DATA` / `PLUGIN_DATA` | Data directory (set by plugin hosts). Otherwise `$XDG_CONFIG_HOME/ibkr-mcp-guard` or `~/.config/ibkr-mcp-guard`. |
| `IBKR_MCP_GUARD_UPSTREAM` | Testing only: a different upstream MCP URL. A warning is logged to stderr. |

The data directory holds the token file (non-macOS, or with `STORE=file`), `tools-cache.json` (the last tool list, which contains no secrets) and, in paper mode, `paper-orders.log`.

## Paper trading mode

Paper trading mode is for testing strategies on an IBKR **paper trading account** through IBKR's official connector. It is **off by default**. When it is off, nothing on this page applies and the guard behaves exactly as described above.

### What it does

With `IBKR_MCP_GUARD_PAPER=1`:

- **The sign-in also asks for order submission.** The guard requests `openid account-ids mcp.read mcp.write mcp.orders.submit`. Only this code path can ask for `mcp.orders.submit`; the default path still throws if anything asks for it.
- **Changing modes needs a new sign-in.** Each saved sign-in remembers which scopes it was made with. If you turn paper mode on or off, the old sign-in is not used, and the guard asks you to sign in again.
- **Order submission is gated to paper accounts.** The tools that the default mode removes (place, submit, cancel or modify orders, and so on) are allowed only when **every** account the sign-in can see is a paper account, meaning its id starts with `DU` or `DF`. Before **every** submit, the guard:
  1. reads the account ids again from IBKR, by calling the account tools (`get_account_positions`, `get_account_balances`, `get_account_summary`, `get_account_orders` and any other read tool whose name mentions accounts) and scanning their answers for account ids;
  2. refuses if it sees any non-paper id (`U…`, `F…`, `I…`), or if it cannot find any account id at all;
  3. refuses if the order's arguments name an account that is not one of those paper accounts.

  The result of this check is never cached. Each submit makes its own check.
- **Submit tools are shown only while the session is paper-only.** They are listed with the description prefix *"PAPER ACCOUNT ONLY — submits a simulated order to your IBKR paper account (DU…). Refused for live accounts."* and `destructiveHint: true`. The guard checks again on every `tools/list` and after each sign-in, and sends `notifications/tools/list_changed` when the answer changes. At other times the submit tools are hidden, and they are refused if called by name.
- **Every order is confirmed.** If your MCP client supports elicitation, the guard shows a plain read-back (account, side, quantity, symbol, order type, price if given, time in force) and asks you to Approve or Cancel. After you approve, it checks the accounts again before sending. Without elicitation, your host's own approval prompt applies, which is triggered by `destructiveHint`. For automated strategy runs, `IBKR_MCP_GUARD_PAPER_NO_CONFIRM=1` skips the guard's prompt. Even then, orders still go only to paper accounts.
- **Every attempt is logged.** Each paper submit attempt (submitted, failed, refused or cancelled) is added as one JSON line to `paper-orders.log` in the data directory (file mode `0600`). Each line records the time, the tool, the decision and reason, the accounts seen, a read-back of the order and its arguments. Tokens are never written to the log. Use the `ibkr_paper_log` tool (optional `limit`, default 20) to see recent entries.
- **`ibkr_status` shows the paper state:** whether paper mode is on, the accounts seen in a fresh read (each labelled paper or LIVE), whether `mcp.orders.submit` was granted, and whether submits are allowed right now and why.

`IBKR_MCP_GUARD_READONLY=1` overrides paper mode: the guard does not request the submit scope and no orders are submitted.

### Get a paper login

1. In IBKR's Client Portal, open **Settings → Paper Trading Account**. Create (or reset) your paper account there and note its username. Paper accounts start with simulated funds, normally USD 1,000,000.
2. When the guard opens IBKR's sign-in page, set the login page's **Live / Paper** switch to **Paper**, then sign in with the paper username.

IBKR's official MCP connector does accept paper logins. A paper sign-in through this guard has been checked: the account summary showed the paper account's USD 1,000,000 net liquidation value and no positions. If you sign in with a **live** login while paper mode is on, the guard sees the live account id and refuses every submit.

### Turn it on

Paper mode is set by an environment variable on the MCP server, so set it in your host's server configuration.

**EnConvo:** in the plugin's MCP server settings, add the environment variable `IBKR_MCP_GUARD_PAPER` with value `1` (and, if you want, `IBKR_MCP_GUARD_PAPER_NO_CONFIRM` = `1`). Then restart the server.

**Claude Code:** add it as a separate MCP server with the variable set:

```bash
claude mcp add -e IBKR_MCP_GUARD_PAPER=1 ibkr-paper -- npx -y github:tivojn/ibkr-mcp-guard
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.ibkr-paper]
command = "npx"
args = ["-y", "github:tivojn/ibkr-mcp-guard"]
env = { IBKR_MCP_GUARD_PAPER = "1" }
startup_timeout_sec = 60
```

After you turn it on, ask the assistant to **"sign in to IBKR"**, sign in with your **paper** login, and then run `ibkr_status`. It should show your `DU…` account labelled *paper* and *"Paper order submission allowed now: yes"*.

> Paper trading is simulated. Paper fills, prices and margin can differ from what would happen in a live account, and results in paper trading do not predict live results. This is not financial advice.

## Troubleshooting

- **The browser didn't open.** Use the link in the tool result, or set `IBKR_MCP_GUARD_NO_BROWSER=1`. The sign-in must finish on the same machine, because IBKR redirects to `http://127.0.0.1:<port>/callback`.
- **"Sign-in timed out".** The flow waits 10 minutes. Ask to sign in again.
- **"Sign-in did not match".** You opened an old sign-in tab. Start a new sign-in.
- **No IBKR tools after signing in.** Your client may ignore `notifications/tools/list_changed`. Restart the MCP server or reload tools.
- **Signed out unexpectedly.** IBKR refused to renew the token (for example, it was revoked or expired). Sign in again.
- **Reset everything.** Run `ibkr_sign_out`. Then:
  - On macOS, delete the Keychain items with service `ibkr-mcp-guard` (Keychain Access, or `security delete-generic-password -s ibkr-mcp-guard -a https://api.ibkr.com/v1/api/mcp-public`).
  - Elsewhere, delete the data directory.
- **Logs.** The server logs to stderr only. stdout carries MCP JSON-RPC.
- **Paper mode refuses every submit.** Run `ibkr_status`. *"This sign-in can see non-paper (live) account(s)"* means you signed in with a live login: sign out and sign in with your paper login. *"No account ids could be read"* means IBKR's account tools did not return any account id, so the guard cannot confirm that only paper accounts are visible.
- **"You need to sign in again" after changing paper mode.** This is expected: a sign-in made in one mode is not used in the other.
- **Why Node's `fetch`?** `api.ibkr.com` asks for an *optional* TLS client certificate. Chromium-based HTTP stacks treat that as fatal, but Node's `fetch` handles it.

## How it works

```
your AI host ──stdio (MCP)──▶ ibkr-mcp-guard ──HTTPS (MCP Streamable HTTP + OAuth bearer)──▶ api.ibkr.com/v1/api/mcp-public
                                   │ policy: block / draft / write / read
                                   └─ tokens: macOS Keychain or 0600 file
```

- **MCP server (stdio):** newline-delimited JSON-RPC 2.0 with `initialize`, `ping`, `tools/list` and `tools/call`.
  - Protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 are supported; 2025-06-18 is the default.
  - It sends `notifications/tools/list_changed` after sign-in and sign-out.
  - When the client supports it, it uses `elicitation/create` to confirm drafts.
- **Upstream client:** MCP Streamable HTTP. It accepts JSON or SSE answers, tracks `Mcp-Session-Id`, follows `tools/list` paging and applies timeouts. A 401 triggers one token refresh, and a second 401 starts a new sign-in.
- **Sign-in** (MCP authorization, OAuth 2.1):
  - Discovery from the `WWW-Authenticate` `resource_metadata` value ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)), then the authorization-server metadata ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414), path-inserted URL first).
  - Dynamic Client Registration ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)) as a public native client, with a loopback redirect `http://127.0.0.1:<port>/callback`. The registered port is reused when it is free; otherwise the guard registers again.
  - PKCE S256 ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), plus a random `state` that is checked on the callback.
  - The `resource` parameter ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)) is sent.
  - Refresh tokens are rotated, and tokens are revoked on sign-out.

### Development

```bash
npm test                 # node --test: offline, fake upstream + fake OAuth server
```

The tests cover:

- discovery using IBKR's real metadata strings
- the DCR body, PKCE (RFC 7636 test vector), state mismatch, and the scope assertion
- policy classification of the real tool names
- paper mode: the default path never asking for `mcp.orders.submit`, the paper scopes, mode changes needing a new sign-in, the DU/DF gate (live ids, unknown ids, accounts named in the order), tool visibility and `list_changed`, Approve/Cancel, `NO_CONFIRM`, the audit log and status
- tools/list filtering and the draft prefix
- the signed-out call and the 401 refresh
- SSE parsing
- the `0600` token file
- an end-to-end stdio round trip (sign-in, list, call, block, elicitation) against a local fake MCP server

## Disclaimer

This software is provided as is, under the MIT License, without warranty of any kind. It is **not financial advice**, and nothing it or your assistant outputs is a recommendation to buy or sell anything. AI assistants make mistakes: check every number and every draft yourself in IBKR before acting. **You use it at your own risk** and remain responsible for every action taken in your account. Interactive Brokers, IBKR and related marks belong to their owners.

## License

[MIT](LICENSE) © 2026 Adam Cohen
