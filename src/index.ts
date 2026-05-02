#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { EventEmitter } from "node:events";
import { z } from "zod";

// --- Buffer sizes ---

const NOTIFICATION_BUFFER_MAX = 1000;
const STDERR_BUFFER_MAX = 10000;
const PROTOCOL_BUFFER_MAX = 1000;

// --- State ---

interface NotificationEntry {
  seq: number;
  method: string;
  params: unknown;
  received_at: string;
}

interface StderrEntry {
  seq: number;
  level?: string;
  text: string;
  ts: string;
}

interface ProtocolEntry {
  seq: number;
  direction: "in" | "out";
  method?: string;
  id?: string | number;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  ts: string;
}

interface BoundedBuffer<T extends { seq: number }> {
  entries: T[];
  seq: number;
  dropped: number;
}

interface WrapState {
  client: Client | null;
  transport: StdioClientTransport | null;
  command: string;
  args: string[];
  stderr: BoundedBuffer<StderrEntry>;
  notifications: BoundedBuffer<NotificationEntry>;
  protocol: BoundedBuffer<ProtocolEntry> & { enabled: boolean };
  events: EventEmitter;
}

function makeBuffer<T extends { seq: number }>(): BoundedBuffer<T> {
  return { entries: [], seq: 0, dropped: 0 };
}

function pushBounded<T extends { seq: number }>(
  buf: BoundedBuffer<T>,
  entry: Omit<T, "seq">,
  max: number,
): T {
  buf.seq += 1;
  const seqd = { ...(entry as object), seq: buf.seq } as T;
  buf.entries.push(seqd);
  if (buf.entries.length > max) {
    buf.entries.shift();
    buf.dropped += 1;
  }
  return seqd;
}

const LOG_LEVEL_RE = /\b(TRACE|DEBUG|INFO|WARN|ERROR)\b/;

function parseLogLevel(line: string): string | undefined {
  const head = line.length > 80 ? line.slice(0, 80) : line;
  const m = LOG_LEVEL_RE.exec(head);
  return m ? m[1] : undefined;
}

// --- Process Management ---

async function startWrappedServer(state: WrapState): Promise<string> {
  if (state.client) {
    throw new Error(
      `Server is already running (pid: ${state.transport?.pid}). Stop it first, or use restart_server.`,
    );
  }

  // Reset all per-run buffers (preserve protocol.enabled across restarts).
  state.stderr = makeBuffer<StderrEntry>();
  state.notifications = makeBuffer<NotificationEntry>();
  const protocolEnabled = state.protocol.enabled;
  state.protocol = { ...makeBuffer<ProtocolEntry>(), enabled: protocolEnabled };

  const transport = new StdioClientTransport({
    command: state.command,
    args: state.args,
    stderr: "pipe",
  });

  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        const entry = pushBounded(
          state.stderr,
          {
            text: line,
            level: parseLogLevel(line),
            ts: new Date().toISOString(),
          },
          STDERR_BUFFER_MAX,
        );
        state.events.emit("stderr", entry);
      }
    });
  }

  const client = new Client({ name: "mcp-wrap-client", version: "1.0.0" });

  client.fallbackNotificationHandler = async (n) => {
    const entry = pushBounded(
      state.notifications,
      {
        method: n.method,
        params: n.params,
        received_at: new Date().toISOString(),
      },
      NOTIFICATION_BUFFER_MAX,
    );
    state.events.emit("notification", entry);
  };

  await client.connect(transport);

  // Wrap transport.send/onmessage for protocol logging. Must come AFTER
  // client.connect, since Protocol.connect installs its own onmessage handler
  // and we wrap on top of it.
  const origSend = transport.send.bind(transport);
  transport.send = async (msg: JSONRPCMessage) => {
    if (state.protocol.enabled) {
      const m = msg as {
        method?: string;
        id?: string | number;
        params?: unknown;
      };
      const entry = pushBounded(
        state.protocol,
        {
          direction: "out",
          method: m.method,
          id: m.id,
          params: m.params,
          ts: new Date().toISOString(),
        },
        PROTOCOL_BUFFER_MAX,
      );
      state.events.emit("protocol", entry);
    }
    return origSend(msg);
  };
  const origOnMsg = transport.onmessage;
  transport.onmessage = (msg: JSONRPCMessage) => {
    if (state.protocol.enabled) {
      const m = msg as {
        method?: string;
        id?: string | number;
        params?: unknown;
        result?: unknown;
        error?: unknown;
      };
      const entry = pushBounded(
        state.protocol,
        {
          direction: "in",
          method: m.method,
          id: m.id,
          params: m.params,
          result: m.result,
          error: m.error,
          ts: new Date().toISOString(),
        },
        PROTOCOL_BUFFER_MAX,
      );
      state.events.emit("protocol", entry);
    }
    origOnMsg?.(msg);
  };

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
    state.stderr.entries.length > 0
      ? `\n\nRecent stderr:\n${state.stderr.entries.map((e) => e.text).join("\n")}`
      : "";

  return `Server stopped (pid: ${pid}).${stderr}`;
}

// --- wait_for primitive ---

type WaitCondition =
  | { type: "notification"; method: string; uri?: string }
  | { type: "stderr_match"; regex: string }
  | { type: "resource_update"; uri: string };

function matchCondition(
  cond: WaitCondition,
  entry: NotificationEntry | StderrEntry,
): boolean {
  if (cond.type === "stderr_match") {
    return new RegExp(cond.regex).test((entry as StderrEntry).text);
  }
  const n = entry as NotificationEntry;
  if (cond.type === "notification") {
    if (n.method !== cond.method) return false;
    if (cond.uri) {
      const params = n.params as { uri?: string } | undefined;
      return params?.uri === cond.uri;
    }
    return true;
  }
  // resource_update: sugar for notifications/resources/updated with matching uri
  if (n.method !== "notifications/resources/updated") return false;
  const params = n.params as { uri?: string } | undefined;
  return params?.uri === cond.uri;
}

async function waitFor(
  state: WrapState,
  cond: WaitCondition,
  timeoutMs: number,
  sinceSeq: number | undefined,
): Promise<{ matched: boolean; elapsed_ms: number; payload?: unknown }> {
  const channel: "notification" | "stderr" =
    cond.type === "stderr_match" ? "stderr" : "notification";
  const startSeq =
    sinceSeq ??
    (channel === "stderr" ? state.stderr.seq : state.notifications.seq);
  const start = Date.now();

  // Catch-up scan: if a matching entry already arrived after startSeq, return now.
  const buf =
    channel === "stderr" ? state.stderr.entries : state.notifications.entries;
  for (const e of buf) {
    if (e.seq > startSeq && matchCondition(cond, e)) {
      return { matched: true, elapsed_ms: Date.now() - start, payload: e };
    }
  }

  return new Promise((resolve) => {
    const listener = (entry: NotificationEntry | StderrEntry) => {
      if (matchCondition(cond, entry)) {
        clearTimeout(timer);
        state.events.off(channel, listener);
        resolve({
          matched: true,
          elapsed_ms: Date.now() - start,
          payload: entry,
        });
      }
    };
    const timer = setTimeout(() => {
      state.events.off(channel, listener);
      resolve({ matched: false, elapsed_ms: Date.now() - start });
    }, timeoutMs);
    state.events.on(channel, listener);
  });
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
    command,
    args,
    stderr: makeBuffer<StderrEntry>(),
    notifications: makeBuffer<NotificationEntry>(),
    protocol: { ...makeBuffer<ProtocolEntry>(), enabled: false },
    events: new EventEmitter(),
  };
  // wait_for can spawn many short-lived listeners; lift the warning threshold.
  state.events.setMaxListeners(0);

  const server = new McpServer({ name: "mcp-wrap", version: "1.0.0" });

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const okText = (text: string) => ({
    content: [{ type: "text" as const, text }],
  });
  const okJson = (data: unknown) => okText(JSON.stringify(data, null, 2));
  const errorResult = (text: string) => ({
    content: [{ type: "text" as const, text }],
    isError: true,
  });
  const requireRunning = (): Client => {
    if (!state.client) {
      throw new Error("Server is not running. Call start_server first.");
    }
    return state.client;
  };

  // --- Tool: start_server ---
  server.registerTool(
    "start_server",
    {
      description: "Start the wrapped MCP server process.",
    },
    async () => {
      try {
        return okText(await startWrappedServer(state));
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
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
        return okText(await stopWrappedServer(state));
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
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
        return okText(await startWrappedServer(state));
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
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
      try {
        const client = requireRunning();
        const result = await client.listTools();
        return okJson(result.tools);
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
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
      try {
        const client = requireRunning();
        const result = await client.callTool({
          name,
          arguments: toolArgs ?? {},
        });
        const isError = "isError" in result && result.isError === true;

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
        return errorResult(
          `Error calling tool '${name}': ${errMsg(error)}\n\nCheck get_server_stderr for details.`,
        );
      }
    },
  );

  // --- Tool: get_server_stderr ---
  server.registerTool(
    "get_server_stderr",
    {
      description:
        "Get stderr output from the wrapped MCP server. With no arguments, returns the entire buffer as plain text and clears it (legacy behavior). With since_seq, returns structured entries with seq > since_seq without clearing the buffer; pass next_seq from the previous response to paginate. With regex, filters lines server-side.",
      inputSchema: {
        since_seq: z
          .number()
          .optional()
          .describe(
            "Cursor: return only entries with seq > since_seq. Pass 0 to read all buffered entries without clearing.",
          ),
        regex: z
          .string()
          .optional()
          .describe("Server-side regex filter applied to entry text."),
      },
    },
    async ({ since_seq, regex }) => {
      try {
        if (since_seq === undefined && regex === undefined) {
          if (state.stderr.entries.length === 0) {
            return okText("(no stderr output captured)");
          }
          const text = state.stderr.entries.map((e) => e.text).join("\n");
          state.stderr.entries = [];
          return okText(text);
        }
        const re = regex ? new RegExp(regex) : undefined;
        const lines = state.stderr.entries
          .filter((e) => e.seq > (since_seq ?? 0))
          .filter((e) => !re || re.test(e.text));
        const dropped = state.stderr.dropped;
        state.stderr.dropped = 0;
        return okJson({
          lines,
          next_seq: state.stderr.seq,
          dropped,
        });
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
      }
    },
  );

  // --- Tool: get_notifications ---
  server.registerTool(
    "get_notifications",
    {
      description:
        "Return server-initiated MCP notifications received from the wrapped server (tools/list_changed, resources/updated, resources/list_changed, prompts/list_changed, notifications/message, etc.). Cursor-based: pass next_seq from the previous response as since_seq to paginate. Buffer is bounded; dropped_since_last_call is non-zero when the buffer overflowed since the last successful read.",
      inputSchema: {
        since_seq: z
          .number()
          .optional()
          .describe(
            "Cursor: return only notifications with seq > since_seq. Omit or pass 0 to return all buffered notifications.",
          ),
      },
    },
    async ({ since_seq }) => {
      try {
        const cutoff = since_seq ?? 0;
        const notifications = state.notifications.entries.filter(
          (e) => e.seq > cutoff,
        );
        const dropped_since_last_call = state.notifications.dropped;
        state.notifications.dropped = 0;
        return okJson({
          notifications,
          next_seq: state.notifications.seq,
          dropped_since_last_call,
        });
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
      }
    },
  );

  // --- Resource proxy tools ---

  server.registerTool(
    "list_resources",
    {
      description: "List MCP resources exposed by the wrapped server.",
    },
    async () => {
      try {
        const client = requireRunning();
        return okJson(await client.listResources());
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
      }
    },
  );

  server.registerTool(
    "list_resource_templates",
    {
      description:
        "List MCP resource templates exposed by the wrapped server.",
    },
    async () => {
      try {
        const client = requireRunning();
        return okJson(await client.listResourceTemplates());
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
      }
    },
  );

  server.registerTool(
    "read_resource",
    {
      description: "Read an MCP resource by URI from the wrapped server.",
      inputSchema: {
        uri: z.string().describe("Resource URI to read."),
      },
    },
    async ({ uri }) => {
      try {
        const client = requireRunning();
        return okJson(await client.readResource({ uri }));
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
      }
    },
  );

  server.registerTool(
    "subscribe_resource",
    {
      description:
        "Subscribe to updates for an MCP resource. Subsequent notifications/resources/updated events arrive via get_notifications.",
      inputSchema: {
        uri: z.string().describe("Resource URI to subscribe to."),
      },
    },
    async ({ uri }) => {
      try {
        const client = requireRunning();
        await client.subscribeResource({ uri });
        return okJson({ ok: true, uri });
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
      }
    },
  );

  server.registerTool(
    "unsubscribe_resource",
    {
      description: "Unsubscribe from updates for an MCP resource.",
      inputSchema: {
        uri: z.string().describe("Resource URI to unsubscribe from."),
      },
    },
    async ({ uri }) => {
      try {
        const client = requireRunning();
        await client.unsubscribeResource({ uri });
        return okJson({ ok: true, uri });
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
      }
    },
  );

  // --- Tool: wait_for ---
  server.registerTool(
    "wait_for",
    {
      description:
        "Block until a matching event arrives or timeout_ms elapses. Useful for race-sensitive verification (e.g., wait for resources/updated after triggering a state change). Returns { matched, elapsed_ms, payload? }.",
      inputSchema: {
        condition: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("notification"),
            method: z.string(),
            uri: z.string().optional(),
          }),
          z.object({
            type: z.literal("stderr_match"),
            regex: z.string(),
          }),
          z.object({
            type: z.literal("resource_update"),
            uri: z.string(),
          }),
        ]),
        timeout_ms: z.number().int().positive(),
        since_seq: z
          .number()
          .optional()
          .describe(
            "Wait for events with seq > since_seq. Defaults to the current seq (i.e., 'from now').",
          ),
      },
    },
    async ({ condition, timeout_ms, since_seq }) => {
      try {
        const result = await waitFor(
          state,
          condition as WaitCondition,
          timeout_ms,
          since_seq,
        );
        return okJson(result);
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
      }
    },
  );

  // --- Protocol log (debug-only) ---

  server.registerTool(
    "set_protocol_logging",
    {
      description:
        "Enable or disable raw MCP protocol logging (off by default). Verbose; only useful when debugging wire-level issues.",
      inputSchema: {
        enabled: z.boolean(),
      },
    },
    async ({ enabled }) => {
      state.protocol.enabled = enabled;
      return okText(`protocol logging: ${enabled ? "on" : "off"}`);
    },
  );

  server.registerTool(
    "get_protocol_log",
    {
      description:
        "Return raw MCP protocol log entries (only populated while set_protocol_logging is on). Cursor-based; pass next_seq from the previous response as since_seq to paginate.",
      inputSchema: {
        since_seq: z.number().optional(),
        regex: z
          .string()
          .optional()
          .describe(
            "Server-side regex filter applied to JSON.stringify(entry).",
          ),
      },
    },
    async ({ since_seq, regex }) => {
      try {
        const cutoff = since_seq ?? 0;
        const re = regex ? new RegExp(regex) : undefined;
        const entries = state.protocol.entries
          .filter((e) => e.seq > cutoff)
          .filter((e) => !re || re.test(JSON.stringify(e)));
        const dropped = state.protocol.dropped;
        state.protocol.dropped = 0;
        return okJson({
          entries,
          next_seq: state.protocol.seq,
          dropped,
          enabled: state.protocol.enabled,
        });
      } catch (error) {
        return errorResult(`Error: ${errMsg(error)}`);
      }
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
