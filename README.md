# mcp-wrap

An MCP server that wraps another MCP server, exposing tools to manage its lifecycle. This lets an LLM (e.g. via Claude Code) stop, rebuild, and restart your MCP server without the agent harness needing to reconnect.

## Why

When developing MCP servers with Claude Code, the LLM can edit your server's source code but can't restart the MCP process — that connection is managed by the agent harness. mcp-wrap sits in between: Claude Code connects to mcp-wrap (which stays running), and mcp-wrap manages the actual server as a child process.

```
Claude Code <--stdio--> mcp-wrap <--stdio--> your MCP server (child process)
```

Typical workflow:
1. LLM edits your server code
2. Calls `restart_server` (or `stop_server` + rebuild + `start_server`)
3. Calls `get_tools` to discover available tools
4. Calls `call_tool` to test them

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

mcp-wrap exposes 6 tools to the LLM:

| Tool | Description |
|------|-------------|
| `start_server` | Spawn the wrapped server as a child process and connect to it |
| `stop_server` | Stop the wrapped server and show recent stderr |
| `restart_server` | Stop then start in one call (convenience for post-rebuild) |
| `get_tools` | List the wrapped server's tools with their input schemas |
| `call_tool` | Call a tool on the wrapped server by name with arguments |
| `get_server_stderr` | View the last 200 lines of the wrapped server's stderr output |

### call_tool

The `call_tool` tool accepts:
- `name` (string) — the tool name on the wrapped server
- `arguments` (object, optional) — a JSON object matching the tool's input schema

Arguments are passed through directly, no double-serialization needed.

## How it works

mcp-wrap is itself an MCP server using stdio transport. It uses the MCP SDK's `Client` and `StdioClientTransport` to connect to the wrapped server as a child process. The wrapped server's stderr is captured into a ring buffer (last 200 lines) for debugging visibility.

When the wrapped server crashes unexpectedly, mcp-wrap detects the disconnection and resets its state — subsequent tool calls will return a clear "server is not running" error rather than hanging.

## License

MIT
