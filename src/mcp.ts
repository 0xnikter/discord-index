import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";
import { config } from "./config.js";
import { openDb, tierDbPath } from "./db.js";
import { getContext, listChannels, search, syncStatus, type ContextLevel, type SearchMode, type TierDb } from "./search.js";
import { checkRequest, clientIp, isLockedOut, recordAuthFailure } from "./rate-limit.js";
import { DEFAULT_TIER, FULL_SCOPE, loadRoles, resolveRole, scopeFor, type Role, type Scope } from "./roles.js";
import { audit, auditArgs } from "./audit.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
});

/** Opens only the tiers a role may read: an unreadable tier's file is never touched. */
function openTiers(tierNames: string[]): TierDb[] {
  return tierNames.map((tier) => ({ tier, db: openDb(tierDbPath(tier)) }));
}

export function buildServer(scope: Scope = FULL_SCOPE, ip = "local", tierNames: string[] = [DEFAULT_TIER]): McpServer {
  const db = openTiers(tierNames);
  const server = new McpServer({ name: "discord-index", version: "0.1.0" });

  server.registerTool(
    "search_messages",
    {
      title: "Search Discord",
      description:
        "Search the indexed Discord server. Returns whole CONVERSATIONS, not isolated messages: each hit is " +
        "assembled from reply chains, the surrounding thread, and neighbouring messages, with `matched: true` " +
        "marking the messages that actually matched. Hits from the same discussion are merged into one result. " +
        "Ranked by hybrid keyword + semantic relevance, with jump URLs. Use `context: \"wide\"` when asked for " +
        "a whole discussion. Always check `freshness`: if `stale` is true, recent activity is missing.",
      inputSchema: {
        query: z.string().describe("What to look for, e.g. 'why did we pick postgres' or an error string"),
        channel: z.string().optional().describe("Restrict to one channel by exact name, e.g. 'engineering'"),
        author: z.string().optional().describe("Restrict to an author (substring match on display name)"),
        after: z.string().optional().describe("Only messages at/after this ISO date, e.g. '2026-08-01'"),
        before: z.string().optional().describe("Only messages at/before this ISO date"),
        mode: z.enum(["hybrid", "keyword", "semantic"]).optional().describe("Default hybrid. Use keyword for exact strings (error text, IDs), semantic for conceptual questions."),
        context: z
          .enum(["narrow", "normal", "wide"])
          .optional()
          .describe(
            "How much conversation to return around each hit. 'wide' (±48h, up to 100 messages) for " +
              "'what did we decide about X' or 'show me the whole discussion'; 'normal' (default, ±6h) " +
              "for ordinary questions; 'narrow' when you only need the matching line.",
          ),
        limit: z.number().int().min(1).max(50).optional().describe("Max windows to return (default 10)"),
      },
    },
    async ({ query, channel, author, after, before, mode, limit, context }) => {
      try {
        const result = await search(db, query, { channel, author, after, before }, { mode: mode as SearchMode, limit, scope, context: context as ContextLevel });
        audit({ tool: "search_messages", role: scope.role, ip, args: auditArgs({ query, channel, author, after, before, mode, limit, context }), resultCount: result.hits.length });
        return json(result);
      } catch (error) {
        audit({ tool: "search_messages", role: scope.role, ip, args: auditArgs({ query, channel, author }), error: String(error) });
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_context",
    {
      title: "Get message context",
      description:
        "Fetch the messages immediately before and after a given message id, in chronological order. Use this " +
        "after search_messages when a hit looks relevant but you need the surrounding conversation to interpret it.",
      inputSchema: {
        message_id: z.string().describe("Discord message id (the trailing number of a jump_url)"),
        before: z.number().int().min(0).max(100).optional().describe("Messages before the anchor (default 15)"),
        after: z.number().int().min(0).max(100).optional().describe("Messages after the anchor (default 15)"),
      },
    },
    async ({ message_id, before, after }) => {
      try {
        const result = getContext(db, message_id, before, after, scope);
        audit({ tool: "get_context", role: scope.role, ip, args: auditArgs({ message_id, before, after }), resultCount: result.messages.length });
        return json(result);
      } catch (error) {
        audit({ tool: "get_context", role: scope.role, ip, args: auditArgs({ message_id }), error: String(error) });
        return fail(error);
      }
    },
  );

  server.registerTool(
    "list_channels",
    {
      title: "List indexed channels",
      description: "List every indexed channel with its message count and last activity. Use to discover exact channel names for search_messages.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = listChannels(db, scope);
        audit({ tool: "list_channels", role: scope.role, ip, args: {}, resultCount: result.length });
        return json(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "sync_status",
    {
      title: "Index health",
      description: "Index totals, embedding coverage, freshness, and the last sync run (including its error, if it failed). Use when results look incomplete or out of date.",
      inputSchema: {},
    },
    async () => {
      try {
        audit({ tool: "sync_status", role: scope.role, ip, args: {} });
        return json(syncStatus(db, scope));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}

export async function serveStdio(): Promise<void> {
  await buildServer().connect(new StdioServerTransport());
}

export async function serveHttp(): Promise<void> {
  const roles = loadRoles(process.env);
  // Refuse rather than serve the whole archive unauthenticated. Use stdio for local, token-free use.
  if (roles.length === 0) {
    throw new Error(
      "No access configured. Set MCP_AUTH_TOKEN (>=16 chars) for single-token access, or MCP_ROLES / " +
        "MCP_ROLES_FILE for role-scoped access. The stdio transport needs neither.",
    );
  }
  process.stderr.write(`roles configured: ${roles.map((r) => r.name).join(", ")}\n`);
  // Stateless: one transport per request, no session store to leak between callers.
  const httpServer = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end("not found");
      return;
    }

    const ip = clientIp(req.headers, req.socket.remoteAddress, config.trustProxy);
    const tooMany = (retryAfterSeconds: number, message: string) => {
      res
        .writeHead(429, { "content-type": "application/json", "retry-after": String(retryAfterSeconds) })
        .end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32002, message } }));
    };

    const lock = isLockedOut(ip);
    if (lock.locked) {
      tooMany(lock.retryAfterSeconds, "Too many failed authentication attempts");
      return;
    }
    const rate = checkRequest(ip);
    if (!rate.allowed) {
      tooMany(rate.retryAfterSeconds, "Rate limit exceeded");
      return;
    }

    const presented = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const role = presented ? resolveRole(roles, presented) : null;
    if (!role) {
      recordAuthFailure(ip);
      process.stderr.write(`[auth] rejected request from ${ip}\n`);
      res
        .writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer error="invalid_token"',
        })
        .end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    try {
      // A server per request, bound to the caller's role: no scope can outlive the request that set it.
      await buildServer(scopeFor(role), ip, role.tiers).connect(transport);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    }
  });

  httpServer.listen(config.httpPort, config.httpHost, () => {
    process.stderr.write(
      `discord-index MCP on http://${config.httpHost}:${config.httpPort}/mcp (bearer auth required)\n`,
    );
  });
}
