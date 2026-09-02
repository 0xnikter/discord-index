import { config, embeddingsEnabled } from "./config.js";
import { type DB, blobToFloats } from "./db.js";
import { dot, embedQuery } from "./embed.js";
import { FULL_SCOPE, type Scope } from "./roles.js";

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

export interface SearchResult {
  hits: SearchHit[];
  freshness: { last_sync: string | null; minutes_behind: number | null; stale: boolean; warning?: string };
  mode_used: SearchMode;
  notes: string[];
  /** Which role's visibility produced these results. */
  scope: string;
  /** Tier databases actually searched. */
  tiers: string[];
}

const RRF_K = 60;
/**
 * How far to reach when assembling the conversation around a hit. Applied at RETRIEVAL time, not
 * indexing, so it can be generous without blurring any embedding.
 */
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
  if (!value) return null;
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
  if (filters.author) { clauses.push("m.author_name LIKE ?"); params.push(`%${filters.author}%`); }
  const after = toMs(filters.after);
  if (after !== null) { clauses.push("m.ts >= ?"); params.push(after); }
  const before = toMs(filters.before);
  if (before !== null) { clauses.push("m.ts <= ?"); params.push(before); }

  // bm25() is an FTS5 auxiliary function: it is only legal in a direct query of the FTS table,
  // so scoring happens in the CTE and the joins/filters/aggregation happen outside it.
  const matchParam = params.shift();
  const rows = db
    .prepare(`
      WITH hits AS (
        SELECT message_id, bm25(messages_fts) AS score
        FROM messages_fts
        WHERE messages_fts MATCH ?
        ORDER BY score ASC
        LIMIT ${FTS_CANDIDATE_MESSAGES}
      )
      SELECT m.window_id AS window_id, MIN(hits.score) AS score
      FROM hits
      JOIN messages m ON m.id = hits.message_id
      JOIN channels c ON c.id = m.channel_id
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      GROUP BY m.window_id
      ORDER BY score ASC
      LIMIT ?
    `)
    .all(matchParam, ...params, limit) as { window_id: number }[];
  return rows.map((r) => r.window_id);
}

function semanticRanking(db: DB, queryVec: Float32Array, filters: SearchFilters, limit: number, scope: Scope): number[] {
  const clauses: string[] = ["w.embedding IS NOT NULL", `(${scope.sql})`];
  const params: unknown[] = [...scope.params];
  if (filters.channel) { clauses.push("c.name = ?"); params.push(filters.channel); }
  const after = toMs(filters.after);
  if (after !== null) { clauses.push("w.end_ts >= ?"); params.push(after); }
  const before = toMs(filters.before);
  if (before !== null) { clauses.push("w.start_ts <= ?"); params.push(before); }
  if (filters.author) {
    clauses.push("EXISTS (SELECT 1 FROM messages m WHERE m.window_id = w.id AND m.author_name LIKE ?)");
    params.push(`%${filters.author}%`);
  }

  const rows = db
    .prepare(`SELECT w.id, w.embedding FROM windows w JOIN channels c ON c.id = w.channel_id WHERE ${clauses.join(" AND ")}`)
    .all(...params) as { id: number; embedding: Buffer }[];

  return rows
    .map((r) => ({ id: r.id, score: dot(queryVec, blobToFloats(r.embedding)) }))
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
  const tiers: TierDb[] = Array.isArray(target) ? target : [{ tier: "common", db: target }];
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
  for (const entry of fusedAll) {
    const tier = entry.id.slice(0, entry.id.indexOf(":"));
    const rawId = Number(entry.id.slice(entry.id.indexOf(":") + 1));
    const meta = windowMeta(tier, rawId);
    const existing = groups.find(
      (g) =>
        g.tier === tier &&
        g.key === meta.channel_id &&
        meta.start_ts <= g.to + MERGE_ADJACENT_MS &&
        meta.end_ts >= g.from - MERGE_ADJACENT_MS,
    );
    if (existing) {
      existing.ids.push(rawId);
      existing.score += entry.score;
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
    const chain = new Set(ids);
    const replyUp = handle.prepare(`SELECT reply_to FROM messages WHERE id = ? AND reply_to IS NOT NULL`);
    const replyDown = handle.prepare(`SELECT id FROM messages WHERE reply_to = ?`);

    // Walk both directions; bounded so a long chain cannot return an entire channel.
    for (let depth = 0; depth < 10 && chain.size < reach.maxMessages; depth++) {
      let grew = false;
      for (const id of [...chain]) {
        const up = replyUp.get(id) as { reply_to: string } | undefined;
        if (up && !chain.has(up.reply_to)) { chain.add(up.reply_to); grew = true; }
        for (const down of replyDown.all(id) as { id: string }[]) {
          if (!chain.has(down.id)) { chain.add(down.id); grew = true; }
        }
      }
      if (!grew) break;
    }

    // A thread is small and self-contained, so return all of it; otherwise reach out in time.
    const sql = isThread
      ? `SELECT id, ts, author_name, content, jump_url FROM messages WHERE channel_id = ? ORDER BY ts ASC LIMIT ?`
      : `SELECT id, ts, author_name, content, jump_url FROM messages
         WHERE channel_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT ?`;
    const rows = (isThread
      ? handle.prepare(sql).all(channelId, reach.maxMessages)
      : handle.prepare(sql).all(channelId, from - reach.windowMs, to + reach.windowMs, reach.maxMessages)
    ) as { id: string; ts: number; author_name: string; content: string; jump_url: string }[];

    const extra = chain.size > ids.length
      ? (handle
          .prepare(`SELECT id, ts, author_name, content, jump_url FROM messages WHERE id IN (${[...chain].map(() => "?").join(",")})`)
          .all(...chain) as typeof rows)
      : [];

    const merged = new Map(rows.map((r) => [r.id, r]));
    for (const r of extra) merged.set(r.id, r);
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
      ? conversationFor(handle, channel.id, channel.type === "11" || channel.type === "12", core.map((m) => m.id), from, to)
      : core;
    return {
      tier,
      window_id: w.id,
      channel: w.channel,
      category: w.category,
      start: new Date(messages[0]?.ts ?? from).toISOString(),
      end: new Date(messages[messages.length - 1]?.ts ?? to).toISOString(),
      score: Number(score.toFixed(5)),
      matched_by,
      jump_url: messages[0]?.jump_url ?? "",
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

  return { hits, freshness: freshness(db), mode_used: mode, notes, scope: scope.role, tiers: tiers.map((t) => t.tier) };
}

export function getContext(target: DB | TierDb[], messageId: string, before = 15, after = 15, scope: Scope = FULL_SCOPE) {
  const tiers: TierDb[] = Array.isArray(target) ? target : [{ tier: "common", db: target }];
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
  const tiers: TierDb[] = Array.isArray(target) ? target : [{ tier: "common", db: target }];
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
  const tiers: TierDb[] = Array.isArray(target) ? target : [{ tier: "common", db: target }];
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
    last_run: lastRun
      ? {
          started: new Date(lastRun.started_at).toISOString(),
          finished: lastRun.finished_at ? new Date(lastRun.finished_at).toISOString() : null,
          channels: lastRun.channels_synced,
          messages_added: lastRun.messages_added,
          windows_embedded: lastRun.windows_embedded,
          error: lastRun.error,
        }
      : null,
  };
}
