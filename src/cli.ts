#!/usr/bin/env node
// better-sqlite3 is a native module built against the running Node ABI. On an older Node it does not
// throw - it aborts the process with no output - so check before anything tries to open the database.
// (A version manager can hand `pnpm run` a different Node than the one used to install.)
const MIN_NODE_MAJOR = 24;
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(
    `discord-index needs Node >= ${MIN_NODE_MAJOR}, got ${process.version} (${process.execPath}).\n` +
      `better-sqlite3 was built for a newer ABI and will crash silently on this one.\n` +
      `Run it with Node ${MIN_NODE_MAJOR}+ directly instead of through a package-manager script.\n`,
  );
  process.exit(1);
}

import { openDb } from "./db.js";
import { serveHttp, serveStdio } from "./mcp.js";
import { listChannels, search, syncStatus } from "./search.js";
import { reindex, sync } from "./sync.js";

const USAGE = `discord-index

  sync [--full] [--since DATE] [--seed DIR]
                                Fetch from Discord (or --seed a local fixture) and index
  reindex                       Rebuild windows + embeddings from stored messages (no Discord calls)
  serve [--transport stdio|http]  Run the MCP server (default: stdio)
  status                        Print index health
  channels                      List indexed channels
  search <query> [--mode m] [--context narrow|normal|wide] [--channel c] [--limit n]
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    return value;
  };
  // Positionals are everything up to the first flag; flag values are consumed by `flag()`.
  const positionals = rest.slice(0, rest.findIndex((a) => a.startsWith("--")) === -1 ? rest.length : rest.findIndex((a) => a.startsWith("--")));

  switch (command) {
    case "sync":
      await sync({ full: rest.includes("--full"), since: flag("since"), seedDir: flag("seed") });
      break;
    case "reindex":
      await reindex();
      break;
    case "serve":
      if ((flag("transport") ?? "stdio") === "http") await serveHttp();
      else await serveStdio();
      break;
    case "status":
      console.log(JSON.stringify(syncStatus(openDb()), null, 2));
      break;
    case "channels":
      console.log(JSON.stringify(listChannels(openDb()), null, 2));
      break;
    case "search": {
      const query = positionals.join(" ");
      if (!query) throw new Error('search needs a query, e.g. search "database migration"');
      const limitRaw = flag("limit");
      const result = await search(
        openDb(),
        query,
        { channel: flag("channel"), author: flag("author"), after: flag("after"), before: flag("before") },
        { mode: flag("mode") as any, limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined, context: flag("context") as any },
      );
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      process.stdout.write(USAGE);
      // process.exit() truncates pending stdio writes; set the code and let node drain and exit.
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error) => {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const token = process.env.DISCORD_TOKEN;
  process.stderr.write(`${token && token.length >= 16 ? text.split(token).join("<DISCORD_TOKEN>") : text}\n`);
  process.exitCode = 1;
});
