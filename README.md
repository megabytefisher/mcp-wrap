# mcp-wrap

An MCP server that wraps another MCP server, exposing tools to manage its lifecycle and observe its protocol traffic. This lets an LLM (e.g. via Claude Code) stop, rebuild, restart, and exercise your MCP server without the agent harness needing to reconnect.

## Why

When developing MCP servers with Claude Code, the LLM can edit your server's source code but can't restart the MCP process — that connection is managed by the agent harness. mcp-wrap sits in between: Claude Code connects to mcp-wrap (which stays running), and mcp-wrap manages the actual server as a child process.

```
Claude Code <--stdio--> mcp-wrap <--stdio--> your MCP server (child process)
```

Typical workflow:
1. LLM edits your server code
2. Calls `restart_server` (or `stop_server` + rebuild + `start_server`)
3. Calls `get_tools` / `list_resources` to discover what's exposed
4. Calls `call_tool` / `read_resource` to exercise it
5. Uses `get_server_stderr`, `get_notifications`, or `wait_for` to observe behavior

## Install

```bash
git clone https://github.com/megabytefisher/mcp-wrap.git
cd mcp-wrap
npm install
npm run build
```

## Usage

```
mcp-wrap <command> [args...]
```

mcp-wrap takes the wrapped server's command as its arguments. For example:

```bash
mcp-wrap node ./my-server/dist/index.js
mcp-wrap python my_server.py
mcp-wrap ./target/release/my-server --flag value
```

### Claude Code configuration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/mcp-wrap/dist/index.js", "node", "/path/to/my-server/dist/index.js"]
    }
  }
}
```

Or in Claude Code global settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/mcp-wrap/dist/index.js", "node", "/path/to/my-server/dist/index.js"]
    }
  }
}
```

## Tools

### Lifecycle

| Tool | Description |
|------|-------------|
| `start_server` | Spawn the wrapped server as a child process and connect to it |
| `stop_server` | Stop the wrapped server and show recent stderr |
| `restart_server` | Stop then start in one call (convenience for post-rebuild) |

### Tool proxy

| Tool | Description |
|------|-------------|
| `get_tools` | List the wrapped server's tools with their input schemas |
| `call_tool` | Call a tool on the wrapped server by name with arguments |

`call_tool` accepts `name` (string) and `arguments` (object, optional). Arguments are passed through directly — no double-serialization needed.

### Resource proxy

| Tool | Description |
|------|-------------|
| `list_resources` | List concrete resources exposed by the wrapped server |
| `list_resource_templates` | List resource templates exposed by the wrapped server |
| `read_resource` | Read a resource by URI |
| `subscribe_resource` | Subscribe to updates for a resource URI |
| `unsubscribe_resource` | Unsubscribe from updates for a resource URI |

Resource update notifications arrive via `get_notifications` (or `wait_for` for race-sensitive flows).

### Observability

| Tool | Description |
|------|-------------|
| `get_server_stderr` | Read captured stderr from the wrapped server. With no args, returns the buffer as plain text and clears it. With `since_seq` and/or `regex`, returns structured cursored entries without clearing. |
| `get_notifications` | Read server-initiated MCP notifications (`tools/list_changed`, `resources/updated`, `notifications/message`, etc.). Cursored via `since_seq` / `next_seq`. |
| `wait_for` | Block until a matching event arrives or `timeout_ms` elapses. Conditions: `notification` (by method, optional uri), `stderr_match` (regex), or `resource_update` (sugar for `notifications/resources/updated` on a uri). Returns `{ matched, elapsed_ms, payload? }`. |

Cursored tools return `next_seq`; pass it back as `since_seq` on the next call to paginate. Buffers are bounded — `dropped` / `dropped_since_last_call` is non-zero when entries were evicted.

### Protocol log (debug)

| Tool | Description |
|------|-------------|
| `set_protocol_logging` | Toggle raw MCP wire-level logging (off by default; verbose) |
| `get_protocol_log` | Read raw protocol entries while logging is on. Cursored, with optional `regex` filter. |

Only useful for debugging wire-level issues. Disabled by default to keep buffers cheap.

## How it works

mcp-wrap is itself an MCP server using stdio transport. It uses the MCP SDK's `Client` and `StdioClientTransport` to connect to the wrapped server as a child process. Stderr, notifications, and (optionally) raw protocol traffic are captured into bounded ring buffers.

When the wrapped server crashes unexpectedly, mcp-wrap detects the disconnection and resets its state — subsequent tool calls return a clear "server is not running" error rather than hanging. Per-run buffers (stderr, notifications, protocol log) are reset on every `start_server`; the protocol-logging on/off flag is preserved across restarts.

## License

MIT
