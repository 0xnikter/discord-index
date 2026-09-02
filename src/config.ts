import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Minimal .env loader: we only need flat KEY=VALUE, and this keeps the dep list at three.
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(resolve(process.cwd(), ".env"));

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set. Copy .env.example to .env and fill it in.`);
  return value;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${key} must be an integer, got "${raw}"`);
  return parsed;
}

export const config = {
  get discordToken() { return required("DISCORD_TOKEN"); },
  get guildId() { return required("DISCORD_GUILD_ID"); },
  openaiKey: process.env.OPENAI_API_KEY ?? "",
  embedModel: process.env.EMBED_MODEL || "text-embedding-3-small",
  dbPath: resolve(process.env.DB_PATH || "./data/index.db"),
  /** Channels fetched concurrently. One channel is capped at ~2 req/s by latency, so fan out. */
  fetchConcurrency: int("FETCH_CONCURRENCY", 6),
  /** Global request budget. Discord's bot ceiling is ~50/s; staying under it avoids ban risk. */
  requestsPerSecond: int("DISCORD_REQUESTS_PER_SECOND", 8),
  syncOverlapMinutes: int("SYNC_OVERLAP_MINUTES", 15),
  includeThreads: process.env.INCLUDE_THREADS || "Active",
  policyFile: process.env.POLICY_FILE ?? "",
  /** Env overrides for the policy file's `exclude:` block; the union of both is applied. */
  excludeCategoriesEnv: (process.env.EXCLUDE_CATEGORIES ?? "").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean),
  excludeChannelsEnv: (process.env.EXCLUDE_CHANNELS ?? "").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean),
  staleAfterMinutes: int("STALE_AFTER_MINUTES", 60),
  /** Required for the HTTP transport. There is no unauthenticated HTTP mode. */
  authToken: process.env.MCP_AUTH_TOKEN ?? "",
  /** Trust X-Forwarded-For for client identity. True behind the bundled Caddy; false if exposed directly. */
  trustProxy: (process.env.TRUST_PROXY ?? "true") === "true",
  httpHost: process.env.HTTP_HOST || "127.0.0.1",
  httpPort: int("HTTP_PORT", 8087),
};

/** Semantic search is opt-in: without a key we run keyword-only rather than silently degrading rank quality. */
export const embeddingsEnabled = (): boolean => config.openaiKey.length > 0;

// Window construction. Embedding whole conversation windows rather than single messages keeps the
// vector count ~50x lower (brute-force cosine stays viable) and gives the embedding real context.
export const WINDOW_MAX_MESSAGES = 50;
export const WINDOW_MAX_CHARS = 4000;
export const WINDOW_GAP_MINUTES = int("WINDOW_GAP_MINUTES", 240);
