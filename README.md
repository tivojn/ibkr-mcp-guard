# ibkr-mcp-guard

**IBKR (guarded)**: a small local MCP server that lets your AI assistant use **Interactive Brokers' official MCP server** through a safety guard. The assistant can read your account and market data and create order **drafts**. It can never send an order to the market.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by Interactive Brokers. It connects to IBKR's official public MCP server (`https://api.ibkr.com/v1/api/mcp-public`), [announced on 28 July 2026](https://www.interactivebrokers.com/en/general/about/mediaRelations/7-28-26.php), using IBKR's own browser sign-in.

- Runs locally over stdio. Needs Node.js 20 or newer and has **no npm dependencies**.
- Installs by URL as a plugin in **EnConvo**, **Claude Code** and **Codex**, or runs with `npx`.

## Safety guarantees

| | |
|---|---|
| **Never requests order submission** | It asks for the scopes `openid account-ids mcp.read mcp.write` and nothing else. If code ever asks for `mcp.orders.submit`, an assertion throws, and a test checks this. If IBKR grants that scope anyway, `ibkr_status` reports it. |
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

Before you first sign in, the tool list shows only these three tools. After that, the guard caches IBKR's tool list, so the tools still appear when you are signed out. Calling one while signed out starts a sign-in.

## Environment variables

| Variable | Effect |
|---|---|
| `IBKR_MCP_GUARD_READONLY=1` | Hide and refuse write and draft tools; reads only. |
| `IBKR_MCP_GUARD_STORE=file` | Use the `0600` file instead of the macOS Keychain. |
| `IBKR_MCP_GUARD_NO_BROWSER=1` | Don't open a browser; the sign-in result includes the link to open yourself (useful over SSH). |
| `CLAUDE_PLUGIN_DATA` / `PLUGIN_DATA` | Data directory (set by plugin hosts). Otherwise `$XDG_CONFIG_HOME/ibkr-mcp-guard` or `~/.config/ibkr-mcp-guard`. |
| `IBKR_MCP_GUARD_UPSTREAM` | Testing only: a different upstream MCP URL. A warning is logged to stderr. |

The data directory holds the token file (non-macOS, or with `STORE=file`) and `tools-cache.json`, the last tool list, which contains no secrets.

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
- tools/list filtering and the draft prefix
- the signed-out call and the 401 refresh
- SSE parsing
- the `0600` token file
- an end-to-end stdio round trip (sign-in, list, call, block, elicitation) against a local fake MCP server

## Disclaimer

This software is provided as is, under the MIT License, without warranty of any kind. It is **not financial advice**, and nothing it or your assistant outputs is a recommendation to buy or sell anything. AI assistants make mistakes: check every number and every draft yourself in IBKR before acting. **You use it at your own risk** and remain responsible for every action taken in your account. Interactive Brokers, IBKR and related marks belong to their owners.

## License

[MIT](LICENSE) © 2026 Adam Cohen
