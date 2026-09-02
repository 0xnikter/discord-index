import { config, embeddingsEnabled } from "./config.js";
import { type DB, blobToFloats } from "./db.js";
import { dot, embedQuery } from "./embed.js";
import { THREAD_TYPES } from "./discord.js";
import { DEFAULT_TIER, FULL_SCOPE, type Scope } from "./roles.js";

/** An open tier database. Window ids repeat across tiers, so every id is namespaced by tier. */
export interface TierDb {
  tier: string;
  db: DB;
}

export type SearchMode = "hybrid" | "keyword" | "semantic";

export interface SearchFilters {
  channel?: string;
  author?: string;
  after?: string;
  before?: string;
}

export interface SearchHit {
  tier: string;
  window_id: number;
  channel: string;
  category: string | null;
  start: string;
  end: string;
  score: number;
  matched_by: string[];
  jump_url: string;
  messages: { ts: string; author: string; content: string; jump_url: string; matched: boolean }[];
}

interface Row {
  id: string;
  ts: number;
  author_name: string;
  content: string;
  jump_url: string;
}

export interface SearchResult {
  hits: SearchHit[];
  freshness: { last_sync: string | null; minutes_behind: number | null; stale: boolean; warning?: string };
  mode_used: SearchMode;
  notes: string[];
  /** Which role's visibility produced these results. */
  scope: string;
  /** Tier databases actually searched. */
  tiers: string[];
  /** Set when the response was trimmed to fit the size budget; `notes` says what was dropped. */
  truncated?: boolean;
}

const RRF_K = 60;
/**
 * How far to reach when assembling a conversation. A lookup for an error string wants a tight
 * result; "what did we decide about X" wants the discussion. One fixed reach is wrong for both.
 */
export const CONTEXT_LEVELS = {
  narrow: { windowMs: 30 * 60_000, maxMessages: 10 },
  normal: { windowMs: 6 * 60 * 60_000, maxMessages: 25 },
  wide: { windowMs: 48 * 60 * 60_000, maxMessages: 100 },
} as const;
export type ContextLevel = keyof typeof CONTEXT_LEVELS;

/** Hits in one channel closer than this are the same discussion, and are merged rather than listed apart. */
const MERGE_ADJACENT_MS = 24 * 60 * 60_000;
const CANDIDATES = 120;
// Top-scoring messages pulled from FTS before filters and window-grouping are applied.
const FTS_CANDIDATE_MESSAGES = 2000;

function toMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (value.trim() === "") throw new Error("Date filters must not be empty");
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid date: "${value}" (expected ISO, e.g. 2026-08-01)`);
  return parsed;
}

/** FTS5 treats bare punctuation as syntax; quoting each term keeps user queries from throwing. */
function sanitizeFtsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) throw new Error(`Query "${query}" has no searchable terms`);
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/** `%` and `_` in a name would otherwise act as wildcards and match the wrong authors. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Freshness of the least recently synced tier, so the answer never claims to be fresher than its stalest source. */
function worstFreshness(tiers: TierDb[]) {
  const all = tiers.map((t) => freshness(t.db));
  const behind = all.filter((f) => f.minutes_behind !== null);
  if (behind.length === 0) return all[0];
  return behind.reduce((worst, f) => ((f.minutes_behind ?? 0) > (worst.minutes_behind ?? 0) ? f : worst));
}

function freshness(db: DB) {
  const row = db.prepare(`SELECT MAX(last_synced_at) AS ts FROM channels`).get() as { ts: number | null };
  if (row.ts === null) {
    return { last_sync: null, minutes_behind: null, stale: true, warning: "Index is empty - run `sync` first." };
  }
  const minutesBehind = Math.round((Date.now() - row.ts) / 60_000);
  const stale = minutesBehind > config.staleAfterMinutes;
  return {
    last_sync: new Date(row.ts).toISOString(),
    minutes_behind: minutesBehind,
    stale,
    // A stale index must announce itself rather than quietly answering from old data.
    ...(stale ? { warning: `Index is ${minutesBehind}m behind; newer Discord activity is NOT in these results.` } : {}),
  };
}

function keywordRanking(db: DB, query: string, filters: SearchFilters, limit: number, scope: Scope): number[] {
  // The role predicate goes in first so no later edit can accidentally place it after a LIMIT.
  const clauses: string[] = ["m.window_id IS NOT NULL", `(${scope.sql})`];
  const params: unknown[] = [sanitizeFtsQuery(query), ...scope.params];

  if (filters.channel) { clauses.push("c.name = ?"); params.push(filters.channel); }
  if (filters.author) { clauses.push("m.author_name LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(filters.author)}%`); }
  const after = toMs(filters.after);
  if (after !== null) { clauses.push("m.ts >= ?"); params.push(after); }
  const before = toMs(filters.before);
  if (before !== null) { clauses.push("m.ts <= ?"); params.push(before); }

  // bm25() is only legal in a direct query of the FTS table, so scoring stays in the CTE - but every
  // filter is pushed in as a message_id constraint. A LIMIT applied before filtering silently
  // returns nothing whenever the term is common enough to fill the cap from other channels.
  const matchParam = params.shift();
  const rows = db
    .prepare(`
      WITH eligible AS (
        SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id
        WHERE ${clauses.join(" AND ")}
      ),
      hits AS (
        SELECT message_id, bm25(messages_fts) AS score
        FROM messages_fts
        WHERE messages_fts MATCH ? AND message_id IN (SELECT id FROM eligible)
        ORDER BY score ASC
        LIMIT ${FTS_CANDIDATE_MESSAGES}
      )
      SELECT m.window_id AS window_id, MIN(hits.score) AS score
      FROM hits
      JOIN messages m ON m.id = hits.message_id
      GROUP BY m.window_id
      ORDER BY score ASC
      LIMIT ?
    `)
    .all(...params, matchParam, limit) as { window_id: number }[];
  return rows.map((r) => r.window_id);
}

interface VectorCache {
  version: string;
  rows: { id: number; vec: Float32Array }[];
}
const vectorCache = new Map<DB, VectorCache>();

/**
 * Window vectors for one database, cached until the window table changes. The cache key is the
 * embedded-window count plus the newest window id, which is enough to notice a sync.
 */
function embeddedVectors(db: DB): { id: number; vec: Float32Array }[] {
  // data_version changes whenever ANOTHER connection commits to this file, which is exactly the
  // sync process. Counting rows cannot see an edit that re-embeds a window in place: the row count
  // and the highest id both stay the same, and the cache would serve the pre-edit vector forever.
  const [{ data_version: dataVersion }] = db.pragma("data_version") as { data_version: number }[];
  const { n } = db
    .prepare(`SELECT COUNT(*) AS n FROM windows WHERE embedding IS NOT NULL AND embed_model = ?`)
    .get(config.embedModel) as { n: number };
  const version = `${dataVersion}:${n}`;

  const cached = vectorCache.get(db);
  if (cached && cached.version === version) return cached.rows;

  const rows = (
    db
      .prepare(`SELECT id, embedding FROM windows WHERE embedding IS NOT NULL AND embed_model = ?`)
      .all(config.embedModel) as { id: number; embedding: Buffer }[]
  ).map((r) => ({ id: r.id, vec: blobToFloats(r.embedding) }));
  vectorCache.set(db, { version, rows });
  return rows;
}

function semanticRanking(db: DB, queryVec: Float32Array, filters: SearchFilters, limit: number, scope: Scope): number[] {
  // Vectors from a previous EMBED_MODEL are not comparable with the current query vector, and a
  // same-dimension model swap is undetectable at score time, so filter them out here.
  const clauses: string[] = ["w.embedding IS NOT NULL", "w.embed_model = ?", `(${scope.sql})`];
  const params: unknown[] = [config.embedModel, ...scope.params];
  if (filters.channel) { clauses.push("c.name = ?"); params.push(filters.channel); }
  const after = toMs(filters.after);
  if (after !== null) { clauses.push("w.end_ts >= ?"); params.push(after); }
  const before = toMs(filters.before);
  if (before !== null) { clauses.push("w.start_ts <= ?"); params.push(before); }
  if (filters.author) {
    clauses.push("EXISTS (SELECT 1 FROM messages m WHERE m.window_id = w.id AND m.author_name LIKE ? ESCAPE '\\')");
    params.push(`%${escapeLike(filters.author)}%`);
  }

  // Which windows the caller may see; the vectors themselves come from the process-wide cache.
  const allowed = new Set(
    (db.prepare(`SELECT w.id FROM windows w JOIN channels c ON c.id = w.channel_id WHERE ${clauses.join(" AND ")}`)
      .all(...params) as { id: number }[]).map((r) => r.id),
  );

  return embeddedVectors(db)
    .filter((r) => allowed.has(r.id))
    .map((r) => ({ id: r.id, score: dot(queryVec, r.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.id);
}

/** Reciprocal Rank Fusion: combines rankings without needing BM25 and cosine on a common scale. */
function fuse(rankings: { name: string; ids: string[] }[]): { id: string; score: number; matched_by: string[] }[] {
  const scores = new Map<string, { score: number; matched_by: string[] }>();
  for (const { name, ids } of rankings) {
    ids.forEach((id, rank) => {
      const entry = scores.get(id) ?? { score: 0, matched_by: [] };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.matched_by.push(name);
      scores.set(id, entry);
    });
  }
  return [...scores.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.score - a.score);
}

export async function search(
  target: DB | TierDb[],
  query: string,
  filters: SearchFilters = {},
  options: { mode?: SearchMode; limit?: number; scope?: Scope; context?: ContextLevel } = {},
): Promise<SearchResult> {
  // A bare handle is treated as the single default tier, so callers that do not use tiers are unchanged.
  const tiers: TierDb[] = Array.isArray(target) ? target : [{ tier: DEFAULT_TIER, db: target }];
  if (tiers.length === 0) throw new Error("no readable tiers for this role");
  const db = tiers[0].db;
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const scope = options.scope ?? FULL_SCOPE;
  const reach = CONTEXT_LEVELS[options.context ?? "normal"];
  const notes: string[] = [];
  let mode: SearchMode = options.mode ?? "hybrid";

  if ((mode === "hybrid" || mode === "semantic") && !embeddingsEnabled()) {
    notes.push("OPENAI_API_KEY unset - fell back to keyword-only ranking.");
    mode = "keyword";
  }
  if (mode !== "keyword") {
    const embedded = db.prepare(`SELECT COUNT(*) AS n FROM windows WHERE embedding IS NOT NULL`).get() as { n: number };
    if (embedded.n === 0) {
      notes.push("No windows are embedded yet - keyword-only ranking. Run `sync` to build embeddings.");
      mode = "keyword";
    }
  }

  // Each tier is queried with the same SQL and contributes its own ranking; RRF fuses them, so no
  // cross-database SQL and no attempt to compare BM25 scores computed over different corpora.
  const rankings: { name: string; ids: string[] }[] = [];
  const queryVec = mode === "semantic" || mode === "hybrid" ? await embedQuery(query) : null;
  for (const { tier, db: handle } of tiers) {
    if (mode === "keyword" || mode === "hybrid") {
      rankings.push({
        name: "keyword",
        ids: keywordRanking(handle, query, filters, CANDIDATES, scope).map((id) => `${tier}:${id}`),
      });
    }
    if (queryVec) {
      rankings.push({
        name: "semantic",
        ids: semanticRanking(handle, queryVec, filters, CANDIDATES, scope).map((id) => `${tier}:${id}`),
      });
    }
  }

  const fusedAll = fuse(rankings);

  // Several windows of one discussion would otherwise be returned as separate results, leaving the
  // caller to notice they belong together. Merge by channel and proximity first, then take the top N.
  const windowMeta = (tier: string, rawId: number) => {
    const handle = new Map(tiers.map((t) => [t.tier, t.db])).get(tier)!;
    return handle
      .prepare(`SELECT w.channel_id, w.start_ts, w.end_ts FROM windows w WHERE w.id = ?`)
      .get(rawId) as { channel_id: string; start_ts: number; end_ts: number };
  };

  const groups: { key: string; tier: string; ids: number[]; score: number; matched_by: string[]; from: number; to: number }[] = [];
  // Merge in time order so grouping is deterministic; score order made it depend on ranking.
  const byTime = fusedAll
    .map((entry) => {
      const tier = entry.id.slice(0, entry.id.indexOf(":"));
      return { entry, tier, rawId: Number(entry.id.slice(entry.id.indexOf(":") + 1)) };
    })
    .map((e) => ({ ...e, meta: windowMeta(e.tier, e.rawId) }))
    .sort((a, b) => (a.tier === b.tier ? (a.meta.channel_id === b.meta.channel_id ? a.meta.start_ts - b.meta.start_ts : a.meta.channel_id.localeCompare(b.meta.channel_id)) : a.tier.localeCompare(b.tier)));

  for (const { entry, tier, meta } of byTime) {
    const rawId = Number(entry.id.slice(entry.id.indexOf(":") + 1));
    const existing = groups.find(
      (g) =>
        g.tier === tier &&
        g.key === meta.channel_id &&
        meta.start_ts <= g.to + MERGE_ADJACENT_MS &&
        meta.end_ts >= g.from - MERGE_ADJACENT_MS,
    );
    if (existing) {
      existing.ids.push(rawId);
      // Max, not sum: five mediocre windows in one channel should not outrank the best single hit.
      existing.score = Math.max(existing.score, entry.score);
      existing.matched_by = [...new Set([...existing.matched_by, ...entry.matched_by])];
      existing.from = Math.min(existing.from, meta.start_ts);
      existing.to = Math.max(existing.to, meta.end_ts);
    } else {
      groups.push({ key: meta.channel_id, tier, ids: [rawId], score: entry.score, matched_by: entry.matched_by, from: meta.start_ts, to: meta.end_ts });
    }
  }
  const fused = groups.sort((a, b) => b.score - a.score).slice(0, limit);
  const byTier = new Map(tiers.map((t) => [t.tier, t.db]));

  /**
   * Expands a window into the conversation around it, in order of how reliable the signal is:
   *   1. reply chains  - Discord states these outright and they survive any time gap
   *   2. same thread   - a real thread IS the conversation unit
   *   3. time adjacency - the fallback, because most people just post the next message
   *      without hitting reply, so structure is absent for the majority of content
   */
  const conversationFor = (handle: DB, channelId: string, isThread: boolean, ids: string[], from: number, to: number) => {
    const scopeJoin = `JOIN channels c ON c.id = m.channel_id`;
    const half = Math.max(1, Math.floor(reach.maxMessages / 2));

    // Every statement here is scoped. The reply walk in particular can cross channels, because a
    // Discord forward or crosspost stores a reply_to pointing at another channel - so without the
    // predicate a hit in an allowed channel can drag denied content in behind it.
    const replyUp = handle.prepare(
      `SELECT m.reply_to AS id FROM messages m ${scopeJoin} WHERE m.id = ? AND m.reply_to IS NOT NULL AND (${scope.sql})`,
    );
    const replyDown = handle.prepare(`SELECT m.id FROM messages m ${scopeJoin} WHERE m.reply_to = ? AND (${scope.sql})`);

    const chain = new Set(ids);
    outer: for (let depth = 0; depth < 10; depth++) {
      let grew = false;
      for (const id of [...chain]) {
        const up = replyUp.get(id, ...scope.params) as { id: string } | undefined;
        if (up && !chain.has(up.id)) {
          chain.add(up.id);
          grew = true;
          if (chain.size >= reach.maxMessages) break outer;
        }
        for (const down of replyDown.all(id, ...scope.params) as { id: string }[]) {
          if (chain.has(down.id)) continue;
          chain.add(down.id);
          grew = true;
          // Checked inside the loop: one popular message can have hundreds of replies, and a
          // between-passes check would let them all in at once.
          if (chain.size >= reach.maxMessages) break outer;
        }
      }
      if (!grew) break;
    }

    // Centre the context on the match. Taking the earliest N of a span that starts before the hit
    // spends the whole budget on preceding context and truncates the matched messages themselves.
    const before = handle
      .prepare(
        `SELECT m.id, m.ts, m.author_name, m.content, m.jump_url FROM messages m ${scopeJoin}
         WHERE m.channel_id = ? AND m.ts < ? ${isThread ? "" : "AND m.ts >= ?"} AND (${scope.sql})
         ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(...(isThread ? [channelId, from] : [channelId, from, from - reach.windowMs]), ...scope.params, half) as Row[];
    const after = handle
      .prepare(
        `SELECT m.id, m.ts, m.author_name, m.content, m.jump_url FROM messages m ${scopeJoin}
         WHERE m.channel_id = ? AND m.ts >= ? ${isThread ? "" : "AND m.ts <= ?"} AND (${scope.sql})
         ORDER BY m.ts ASC LIMIT ?`,
      )
      .all(...(isThread ? [channelId, from] : [channelId, from, to + reach.windowMs]), ...scope.params, reach.maxMessages - half) as Row[];

    // The matched messages are unioned back in unconditionally, so no LIMIT can drop them.
    const core = handle
      .prepare(
        `SELECT m.id, m.ts, m.author_name, m.content, m.jump_url FROM messages m ${scopeJoin}
         WHERE m.id IN (${[...chain].map(() => "?").join(",")}) AND (${scope.sql})`,
      )
      .all(...chain, ...scope.params) as Row[];

    const merged = new Map<string, Row>();
    for (const r of [...before, ...after, ...core]) merged.set(r.id, r);
    return [...merged.values()].sort((a, b) => a.ts - b.ts);
  };

  const hits: SearchHit[] = fused.map(({ tier, ids, score, matched_by, from, to }) => {
    const handle = byTier.get(tier)!;
    const w = handle
      .prepare(`SELECT w.id, c.name AS channel, c.category FROM windows w JOIN channels c ON c.id = w.channel_id WHERE w.id = ?`)
      .get(ids[0]) as { id: number; channel: string; category: string | null };
    const core = handle
      .prepare(`SELECT id, ts, author_name, content, jump_url FROM messages WHERE window_id IN (${ids.map(() => "?").join(",")}) ORDER BY ts ASC`)
      .all(...ids) as { id: string; ts: number; author_name: string; content: string; jump_url: string }[];
    const channel = handle.prepare(`SELECT id, type FROM channels WHERE id = (SELECT channel_id FROM windows WHERE id = ?)`).get(ids[0]) as
      | { id: string; type: string }
      | undefined;
    const matched = new Set(core.map((m) => m.id));
    const messages = channel
      ? conversationFor(handle, channel.id, THREAD_TYPES.has(channel.type), core.map((m) => m.id), from, to)
      : core;
    return {
      tier,
      window_id: w.id,
      channel: w.channel,
      category: w.category,
      start: new Date(from).toISOString(),
      end: new Date(to).toISOString(),
      score: Number(score.toFixed(5)),
      matched_by,
      jump_url: core[0]?.jump_url ?? messages[0]?.jump_url ?? "",
      messages: messages.map((m) => ({
        ts: new Date(m.ts).toISOString(),
        author: m.author_name,
        content: m.content,
        jump_url: m.jump_url,
        // Marks which messages actually matched, so surrounding context is not mistaken for the hit.
        matched: matched.has(m.id),
      })),
    };
  });

  return {
    hits,
    // The oldest sync across every tier searched: reporting only the first tier's would call a
    // result fresh while a secondary tier's sync was wedged.
    freshness: worstFreshness(tiers),
    mode_used: mode,
    notes,
    scope: scope.role,
    tiers: tiers.map((t) => t.tier),
  };
}

export function getContext(target: DB | TierDb[], messageId: string, before = 15, after = 15, scope: Scope = FULL_SCOPE) {
  const tiers: TierDb[] = Array.isArray(target) ? target : [{ tier: DEFAULT_TIER, db: target }];
  // The message lives in exactly one tier; tiers this role cannot read were never opened.
  for (const { db: handle } of tiers) {
    const found = getContextIn(handle, messageId, before, after, scope);
    if (found) return found;
  }
  throw new Error(`Message ${messageId} is not in the index`);
}

function getContextIn(db: DB, messageId: string, before: number, after: number, scope: Scope) {
  // Scoped in the same lookup: an out-of-scope message must be indistinguishable from a missing one,
  // otherwise the error itself confirms that a denied channel contains that id.
  const anchor = db
    .prepare(`SELECT m.channel_id, m.ts FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ? AND (${scope.sql})`)
    .get(messageId, ...scope.params) as { channel_id: string; ts: number } | undefined;
  if (!anchor) return null;

  const earlier = db
    .prepare(`SELECT id, ts, author_name, content, jump_url FROM messages WHERE channel_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?`)
    .all(anchor.channel_id, anchor.ts, Math.min(before, 100)) as any[];
  const later = db
    .prepare(`SELECT id, ts, author_name, content, jump_url FROM messages WHERE channel_id = ? AND ts >= ? ORDER BY ts ASC LIMIT ?`)
    .all(anchor.channel_id, anchor.ts, Math.min(after, 100) + 1) as any[];
  const channel = db.prepare(`SELECT name FROM channels WHERE id = ?`).get(anchor.channel_id) as { name: string };

  return {
    channel: channel.name,
    anchor_message_id: messageId,
    messages: [...earlier.reverse(), ...later].map((m) => ({
      id: m.id,
      ts: new Date(m.ts).toISOString(),
      author: m.author_name,
      content: m.content,
      jump_url: m.jump_url,
      is_anchor: m.id === messageId,
    })),
  };
}

export function listChannels(target: DB | TierDb[], scope: Scope = FULL_SCOPE): unknown[] {
  const tiers: TierDb[] = Array.isArray(target) ? target : [{ tier: DEFAULT_TIER, db: target }];
  return tiers.flatMap(({ tier, db }) => listChannelsIn(db, scope).map((c) => ({ ...c, tier })));
}

function listChannelsIn(db: DB, scope: Scope) {
  return db
    .prepare(`
      SELECT c.name, c.category, c.message_count, c.last_message_ts, c.last_synced_at
      FROM channels c WHERE c.message_count > 0 AND (${scope.sql}) ORDER BY c.message_count DESC
    `)
    .all(...scope.params)
    .map((c: any) => ({
      channel: c.name,
      category: c.category,
      messages: c.message_count,
      last_message: c.last_message_ts ? new Date(c.last_message_ts).toISOString() : null,
      last_synced: c.last_synced_at ? new Date(c.last_synced_at).toISOString() : null,
    }));
}

export function syncStatus(target: DB | TierDb[], scope: Scope = FULL_SCOPE): Record<string, unknown> {
  const tiers: TierDb[] = Array.isArray(target) ? target : [{ tier: DEFAULT_TIER, db: target }];
  const per = tiers.map(({ tier, db }) => ({ tier, ...syncStatusIn(db, scope) }));
  return {
    messages: per.reduce((n, t) => n + t.messages, 0),
    channels: per.reduce((n, t) => n + t.channels, 0),
    windows: per.reduce((n, t) => n + t.windows, 0),
    embedded: per.reduce((n, t) => n + t.embedded, 0),
    embeddings_enabled: per[0]?.embeddings_enabled ?? false,
    freshness: per[0]?.freshness,
    tiers: per,
  };
}

interface TierStatus {
  messages: number;
  channels: number;
  windows: number;
  embedded: number;
  embeddings_enabled: boolean;
  freshness: ReturnType<typeof freshness>;
  last_run: unknown;
}

// Explicit: spreading a Record<string, number> loses the named fields under some inference paths,
// which compiled locally and failed in a clean container.
function syncStatusIn(db: DB, scope: Scope = FULL_SCOPE): TierStatus {
  // Counts are scoped too: totals over channels a role cannot read still leak their size.
  const totals = db
    .prepare(`
      SELECT (SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE (${scope.sql})) AS messages,
             (SELECT COUNT(*) FROM channels c WHERE c.message_count > 0 AND (${scope.sql})) AS channels,
             (SELECT COUNT(*) FROM windows w JOIN channels c ON c.id = w.channel_id WHERE (${scope.sql})) AS windows,
             (SELECT COUNT(*) FROM windows w JOIN channels c ON c.id = w.channel_id WHERE w.embedding IS NOT NULL AND (${scope.sql})) AS embedded
    `)
    .get(...scope.params, ...scope.params, ...scope.params, ...scope.params) as {
      messages: number;
      channels: number;
      windows: number;
      embedded: number;
    };
  const lastRun = db
    .prepare(`SELECT started_at, finished_at, channels_synced, messages_added, windows_embedded, error FROM sync_runs ORDER BY id DESC LIMIT 1`)
    .get() as any;

  return {
    ...totals,
    embeddings_enabled: embeddingsEnabled(),
    freshness: freshness(db),
    // Volume counters describe the whole corpus, so a scoped caller only gets timing and errors.
    last_run: lastRun
      ? {
          started: new Date(lastRun.started_at).toISOString(),
          finished: lastRun.finished_at ? new Date(lastRun.finished_at).toISOString() : null,
          error: lastRun.error,
          ...(scope.sql === "1=1"
            ? {
                channels: lastRun.channels_synced,
                messages_added: lastRun.messages_added,
                windows_embedded: lastRun.windows_embedded,
              }
            : {}),
        }
      : null,
  };
}

/** Unmatched messages kept on each side of a hit's matched span, tried largest-first. */
const CONTEXT_ALLOWANCES = [12, 6, 3, 1, 0];

/** Contiguous slice around the matched span, so a trimmed hit still reads as a conversation. */
function trimHit(hit: SearchHit, allowance: number): SearchHit {
  const first = hit.messages.findIndex((m) => m.matched);
  if (first === -1) return { ...hit, messages: hit.messages.slice(0, allowance * 2 + 1) };
  let last = first;
  for (let i = hit.messages.length - 1; i > first; i--) {
    if (hit.messages[i].matched) { last = i; break; }
  }
  return {
    ...hit,
    messages: hit.messages.slice(Math.max(0, first - allowance), Math.min(hit.messages.length, last + allowance + 1)),
  };
}

/**
 * Shrink a result to fit `maxChars`. A client rejects an oversized response outright, so an
 * untrimmed `wide` search over many hits returns nothing at all - trimming is what makes it answer.
 *
 * Order of sacrifice: surrounding context first (uniformly, so ranking is not distorted), then whole
 * hits from the bottom. Matched messages are never dropped from a surviving hit, except in the last
 * resort where one hit alone overflows. The top hit always survives.
 */
export function fitToBudget(result: SearchResult, maxChars: number): SearchResult {
  // Must measure the exact string the transport sends: indented JSON runs ~25% larger, and a budget
  // computed on the compact form leaves the real response over the limit.
  const size = (r: SearchResult) => JSON.stringify(r, null, 2).length;
  if (size(result) <= maxChars) return result;

  const originalHits = result.hits.length;
  const originalMessages = result.hits.reduce((n, h) => n + h.messages.length, 0);
  const report = (hits: SearchHit[]): SearchResult => {
    const keptMessages = hits.reduce((n, h) => n + h.messages.length, 0);
    const dropped = originalHits - hits.length;
    return {
      ...result,
      hits,
      truncated: true,
      notes: [
        ...result.notes,
        `Response trimmed to fit the size limit: ${keptMessages} of ${originalMessages} messages` +
          (dropped > 0 ? ` and ${hits.length} of ${originalHits} conversations` : "") +
          ". Narrow the query, lower `limit`, or call get_context on a jump_url to read a full conversation.",
      ],
    };
  };

  for (const allowance of CONTEXT_ALLOWANCES) {
    const candidate = report(result.hits.map((h) => trimHit(h, allowance)));
    if (size(candidate) <= maxChars) return candidate;
  }

  // Even matched-only text overflows: drop hits from the bottom, but never return zero hits.
  const floor = result.hits.map((h) => trimHit(h, 0));
  for (let keep = floor.length - 1; keep >= 1; keep--) {
    const candidate = report(floor.slice(0, keep));
    if (size(candidate) <= maxChars) return candidate;
  }

  // One hit whose matched messages alone overflow. Keep the earliest that fit rather than fail the
  // call; this is the only path that drops a matched message, and `truncated` reports it.
  const [top] = floor;
  let lo = 0;
  let hi = top.messages.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(report([{ ...top, messages: top.messages.slice(0, mid) }])) <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return report([{ ...top, messages: top.messages.slice(0, lo) }]);
}
