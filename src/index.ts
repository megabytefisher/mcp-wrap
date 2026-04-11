#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

// --- State ---

interface WrapState {
  client: Client | null;
  transport: StdioClientTransport | null;
  stderrLines: string[];
  command: string;
  args: string[];
}

function appendStderr(state: WrapState, chunk: Buffer | string): void {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
  for (const line of text.split("\n")) {
    if (line.length > 0) {
      state.stderrLines.push(line);
    }
  }
}

// --- Process Management ---

async function startWrappedServer(state: WrapState): Promise<string> {
  if (state.client) {
    throw new Error(
      `Server is already running (pid: ${state.transport?.pid}). Stop it first, or use restart_server.`,
    );
  }

  state.stderrLines = [];

  const transport = new StdioClientTransport({
    command: state.command,
    args: state.args,
    stderr: "pipe",
  });

  // Attach stderr listener before start() to capture early output
  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on("data", (chunk: Buffer) => appendStderr(state, chunk));
  }

  const client = new Client({ name: "mcp-wrap-client", version: "1.0.0" });
  await client.connect(transport);

  // Handle unexpected disconnection (server crash)
  client.onclose = () => {
    state.client = null;
    state.transport = null;
  };

  state.client = client;
  state.transport = transport;

  return `Server started (pid: ${transport.pid}).`;
}

async function stopWrappedServer(state: WrapState): Promise<string> {
  if (!state.client) {
    throw new Error("Server is not running.");
  }

  const pid = state.transport?.pid;
  await state.client.close();
  state.client = null;
  state.transport = null;

  const stderr =
    state.stderrLines.length > 0
      ? `\n\nRecent stderr:\n${state.stderrLines.join("\n")}`
      : "";

  return `Server stopped (pid: ${pid}).${stderr}`;
}

// --- Main ---

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stderr.write(
      "Usage: mcp-wrap <command> [args...]\nExample: mcp-wrap node ./dist/server.js\n",
    );
    process.exit(1);
  }

  const state: WrapState = {
    client: null,
    transport: null,
    stderrLines: [],
    command,
    args,
  };

  const server = new McpServer({ name: "mcp-wrap", version: "1.0.0" });

  // --- Tool: start_server ---
  server.registerTool(
    "start_server",
    {
      description: "Start the wrapped MCP server process.",
    },
    async () => {
      try {
        const message = await startWrappedServer(state);
        return { content: [{ type: "text" as const, text: message }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Tool: stop_server ---
  server.registerTool(
    "stop_server",
    {
      description: "Stop the wrapped MCP server process.",
    },
    async () => {
      try {
        const message = await stopWrappedServer(state);
        return { content: [{ type: "text" as const, text: message }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Tool: restart_server ---
  server.registerTool(
    "restart_server",
    {
      description:
        "Restart the wrapped MCP server (stop then start). Convenient after a rebuild.",
    },
    async () => {
      try {
        if (state.client) {
          await stopWrappedServer(state);
        }
        const message = await startWrappedServer(state);
        return { content: [{ type: "text" as const, text: message }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Tool: get_tools ---
  server.registerTool(
    "get_tools",
    {
      description: "List the tools exposed by the wrapped MCP server.",
    },
    async () => {
      if (!state.client) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Server is not running. Call start_server first.",
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await state.client.listTools();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result.tools, null, 2) },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing tools: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Tool: call_tool ---
  server.registerTool(
    "call_tool",
    {
      description: "Call a tool on the wrapped MCP server.",
      inputSchema: {
        name: z
          .string()
          .describe("Name of the tool to call on the wrapped server"),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Arguments to pass to the tool, as a JSON object matching the tool's input schema",
          ),
      },
    },
    async ({ name, arguments: toolArgs }) => {
      if (!state.client) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Server is not running. Call start_server first.",
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await state.client.callTool({
          name,
          arguments: toolArgs ?? {},
        });
        const isError = "isError" in result && result.isError === true;

        // Extract text from content items, stringify non-text items
        let text: string;
        if ("content" in result && Array.isArray(result.content)) {
          const parts: string[] = [];
          for (const item of result.content as Array<Record<string, unknown>>) {
            if (item.type === "text" && typeof item.text === "string") {
              parts.push(item.text);
            } else {
              parts.push(JSON.stringify(item));
            }
          }
          text = parts.join("\n") || "(empty response)";
        } else {
          text = JSON.stringify(result, null, 2);
        }

        return {
          content: [{ type: "text" as const, text }],
          isError,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error calling tool '${name}': ${error instanceof Error ? error.message : String(error)}\n\nCheck get_server_stderr for details.`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Tool: get_server_stderr ---
  server.registerTool(
    "get_server_stderr",
    {
      description:
        "Get recent stderr output from the wrapped MCP server. Useful for debugging startup failures or tool errors.",
    },
    async () => {
      if (state.stderrLines.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "(no stderr output captured)" },
          ],
        };
      }
      const text = state.stderrLines.join("\n");
      state.stderrLines = [];
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );

  // Connect to the outer transport (Claude Code ↔ mcp-wrap)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `mcp-wrap: ready (will run: ${command} ${args.join(" ")})\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`mcp-wrap: fatal error: ${error}\n`);
  process.exit(1);
});
