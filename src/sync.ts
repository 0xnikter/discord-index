import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  config,
  embeddingsEnabled,
  WINDOW_GAP_MINUTES,
  WINDOW_MAX_CHARS,
  WINDOW_MAX_MESSAGES,
} from "./config.js";
import { type DB, floatsToBlob, openDb, tierDbPath } from "./db.js";
import { embedTexts } from "./embed.js";
import { DEFAULT_TIER, loadExclusions, loadTiers, tierForChannel } from "./roles.js";
import { DiscordClient, mapConcurrent, type FetchedChannel, type FetchedMessage } from "./discord.js";

interface ChannelExport {
  guild: { id: string; name: string };
  channel: FetchedChannel;
  messages: FetchedMessage[];
}

const log = (msg: string) => process.stderr.write(`${scrubToken(msg)}\n`);

/** Last line of defence: never let the bot token reach a log line, an error message, or journald. */
function scrubToken(text: string): string {
  const token = process.env.DISCORD_TOKEN;
  // A short value (a test placeholder like "x") would match everywhere and mangle the output;
  // real Discord tokens are ~60+ characters.
  return token && token.length >= 16 ? text.split(token).join("<DISCORD_TOKEN>") : text;
}

/**
 * Pulls every readable channel concurrently. Throughput comes from channel-level fan-out: one channel
 * is capped at 5 req/s by Discord and ~2 req/s by latency, so the work is spread across channels.
 */
async function fetchGuild(
  afterMs: number | null,
  onChannel: (data: ChannelExport) => void,
): Promise<void> {
  const client = new DiscordClient(config.discordToken, {
    requestsPerSecond: config.requestsPerSecond,
    onWarn: (m) => log(`! ${m}`),
  });
  const guildName = await client.guildName(config.guildId);
  const channels = await client.listChannels(config.guildId, config.includeThreads);
  log(`> ${channels.length} readable channels/threads, ${config.fetchConcurrency} at a time`);

  // Discord snowflakes embed a millisecond timestamp, so a watermark converts into a cursor without
  // needing to know any message id.
  const afterId = afterMs === null ? undefined : String((BigInt(afterMs) - 1420070400000n) << 22n);

  let done = 0;
  let unreadable = 0;
  const truncated: string[] = [];
  await mapConcurrent(channels, config.fetchConcurrency, async (channel) => {
    const result = await client.fetchMessages(channel.id, afterId);
    done++;
    if (done % 25 === 0) log(`  ${done}/${channels.length} channels`);
    if (result === null) {
      unreadable++;
      return;
    }
    if (result.truncated) {
      truncated.push(channel.name);
      log(`! #${channel.name} became unreadable mid-fetch; only part of its history was retrieved`);
    }
    // Handed over as soon as it lands: an interrupted run keeps everything already fetched.
    onChannel({ guild: { id: config.guildId, name: guildName }, channel, messages: result.messages });
  });

  if (unreadable > 0) log(`= ${unreadable} channels not readable by this bot (permissions), skipped`);
  if (truncated.length > 0) {
    log(`! ${truncated.length} channel(s) only partly fetched: ${truncated.join(", ")} - run 'sync --full' once readable`);
  }
}

function isExcluded(data: ChannelExport, exclusions: { categories: string[]; channels: string[] }): boolean {
  // Ids, not names: a category renamed in Discord must not silently stop matching an exclude rule.
  // Names are still accepted so a config can be written before the ids are looked up.
  const categoryId = data.channel.categoryId ?? "";
  const categoryName = (data.channel.categoryName ?? "").toLowerCase();
  const channelId = data.channel.id;
  const channelName = data.channel.name.toLowerCase();
  return (
    exclusions.categories.includes(categoryId) ||
    exclusions.categories.includes(categoryName) ||
    exclusions.channels.includes(channelId) ||
    exclusions.channels.includes(channelName)
  );
}

/** Deletes one channel's rows from a tier database. Used by both exclusion purging and re-tiering. */
function deleteChannel(db: DB, channelId: string): number {
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?`).get(channelId) as { n: number }).n;
  db.prepare(`DELETE FROM messages_fts WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)`).run(channelId);
  db.prepare(`DELETE FROM windows WHERE channel_id = ?`).run(channelId);
  db.prepare(`DELETE FROM messages WHERE channel_id = ?`).run(channelId);
  db.prepare(`DELETE FROM channels WHERE id = ?`).run(channelId);
  return before;
}

/**
 * Removes anything already indexed that now matches an exclusion rule. Without this, `exclude:` only
 * stops future writes and previously-indexed content stays searchable forever - which would quietly
 * defeat excluding a category after the fact.
 */
function purgeExcluded(db: DB, rules: { categories: string[]; channels: string[] }): { name: string; messages: number }[] {
  const channels = db
    .prepare(`SELECT id, name, category, category_id, message_count FROM channels`)
    .all() as { id: string; name: string; category: string | null; category_id: string | null; message_count: number }[];

  const doomed = channels.filter(
    (c) =>
      rules.categories.includes(c.category_id ?? "") ||
      rules.categories.includes((c.category ?? "").toLowerCase()) ||
      rules.channels.includes(c.id) ||
      rules.channels.includes(c.name.toLowerCase()),
  );
  if (doomed.length === 0) return [];

  const purge = db.transaction((ids: string[]) => {
    for (const id of ids) deleteChannel(db, id);
  });
  purge(doomed.map((c) => c.id));
  return doomed.map((c) => ({ name: c.name, messages: c.message_count }));
}

/** Union of the policy file's `exclude:` block and the EXCLUDE_* env overrides. */
function exclusions(): { categories: string[]; channels: string[] } {
  const policy = loadExclusions(process.env);
  return {
    categories: [...new Set([...policy.categories.map((c) => c.toLowerCase()), ...config.excludeCategoriesEnv])],
    channels: [...new Set([...policy.channels.map((c) => c.toLowerCase()), ...config.excludeChannelsEnv])],
  };
}

function upsertExport(db: DB, data: ChannelExport): number {
  const upsertChannel = db.prepare(`
    INSERT INTO channels (id, name, category, category_id, type, topic, guild_id, guild_name, last_synced_at)
    VALUES (@id, @name, @category, @category_id, @type, @topic, @guild_id, @guild_name, @now)
    ON CONFLICT(id) DO UPDATE SET
      name = @name, category = @category, category_id = @category_id, type = @type, topic = @topic,
      last_synced_at = @now
  `);
  const upsertMessage = db.prepare(`
    INSERT INTO messages (id, channel_id, author_id, author_name, content, ts, edited_ts, jump_url, attachments, reply_to)
    VALUES (@id, @channel_id, @author_id, @author_name, @content, @ts, @edited_ts, @jump_url, @attachments, @reply_to)
    ON CONFLICT(id) DO UPDATE SET
      content = @content, edited_ts = @edited_ts, author_name = @author_name, attachments = @attachments,
      reply_to = @reply_to
  `);
  const existing = db.prepare(`SELECT 1 AS present FROM messages WHERE id = ?`);
  const deleteFts = db.prepare(`DELETE FROM messages_fts WHERE message_id = ?`);
  const insertFts = db.prepare(`INSERT INTO messages_fts (message_id, content, author_name) VALUES (?, ?, ?)`);

  const now = Date.now();
  upsertChannel.run({
    id: data.channel.id,
    name: data.channel.name,
    category: data.channel.categoryName,
    category_id: data.channel.categoryId,
    type: data.channel.type,
    topic: data.channel.topic,
    guild_id: data.guild.id,
    guild_name: data.guild.name,
    now,
  });

  // Filtering already happened in the fetcher, which knows Discord's numeric message types.
  let added = 0;
  for (const m of data.messages) {
    upsertMessage.run({
      id: m.id,
      channel_id: data.channel.id,
      author_id: m.authorId,
      author_name: m.authorName,
      content: m.content,
      ts: m.timestamp,
      edited_ts: m.editedTimestamp,
      jump_url: `https://discord.com/channels/${data.guild.id}/${data.channel.id}/${m.id}`,
      attachments: JSON.stringify(m.attachments),
      reply_to: m.replyTo,
    });
    // Only pay the FTS scan when a row is actually being replaced; on a backfill this is never hit.
    if (existing.get(m.id)) deleteFts.run(m.id);
    insertFts.run(m.id, m.content, m.authorName);
    added++;
  }
  return added;
}

/**
 * Windows are conversation slices: they break on a long silence, a message cap, or a char cap.
 * Only the trailing (open) window of a channel is rebuilt on each sync; closed windows are immutable.
 */
function rebuildWindows(db: DB, channelId: string): void {
  // The open window is rebuilt every sync. Carry its embedding across by content hash so an idle
  // channel costs no embedding calls at all.
  const salvaged = new Map<string, { embedding: Buffer; model: string }>();
  for (const row of db
    .prepare(`SELECT text_hash, embedding, embed_model FROM windows WHERE channel_id = ? AND is_open = 1 AND embedding IS NOT NULL`)
    .all(channelId) as { text_hash: string; embedding: Buffer; embed_model: string }[]) {
    salvaged.set(row.text_hash, { embedding: row.embedding, model: row.embed_model });
  }

  db.prepare(`UPDATE messages SET window_id = NULL WHERE window_id IN (SELECT id FROM windows WHERE channel_id = ? AND is_open = 1)`).run(channelId);
  db.prepare(`DELETE FROM windows WHERE channel_id = ? AND is_open = 1`).run(channelId);

  // Rebuild from the oldest message that has no window, not from the newest closed window: a
  // backfill can insert messages OLDER than an existing closed window, and anchoring on that
  // window's end would skip them forever, wedging the orphan guard on every later run.
  const unwindowed = db
    .prepare(`SELECT MIN(ts) AS ts FROM messages WHERE channel_id = ? AND window_id IS NULL`)
    .get(channelId) as { ts: number | null };
  if (unwindowed.ts === null) return;

  // Closed windows at or after that point must go too, otherwise the backfilled messages would be
  // windowed alongside content that is already in a window.
  db.prepare(`UPDATE messages SET window_id = NULL WHERE window_id IN (SELECT id FROM windows WHERE channel_id = ? AND end_ts >= ?)`).run(channelId, unwindowed.ts);
  db.prepare(`DELETE FROM windows WHERE channel_id = ? AND end_ts >= ?`).run(channelId, unwindowed.ts);

  const boundary = db
    .prepare(`SELECT COALESCE(MAX(end_ts), 0) AS ts FROM windows WHERE channel_id = ? AND is_open = 0`)
    .get(channelId) as { ts: number };

  const messages = db
    .prepare(`SELECT id, author_name, content, ts FROM messages WHERE channel_id = ? AND ts >= ? AND window_id IS NULL ORDER BY ts ASC`)
    .all(channelId, Math.min(boundary.ts, unwindowed.ts)) as { id: string; author_name: string; content: string; ts: number }[];
  if (messages.length === 0) return;

  const channel = db.prepare(`SELECT name FROM channels WHERE id = ?`).get(channelId) as { name: string };
  const insertWindow = db.prepare(`
    INSERT INTO windows (channel_id, start_ts, end_ts, msg_count, text, text_hash, is_open)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const assign = db.prepare(`UPDATE messages SET window_id = ? WHERE id = ?`);

  const gapMs = WINDOW_GAP_MINUTES * 60_000;
  let batch: typeof messages = [];
  let chars = 0;

  const flush = (isOpen: boolean) => {
    if (batch.length === 0) return;
    const text = `#${channel.name}\n` + batch.map((m) => `${m.author_name}: ${m.content}`).join("\n");
    const hash = createHash("sha256").update(text).digest("hex");
    const info = insertWindow.run(
      channelId,
      batch[0].ts,
      batch[batch.length - 1].ts,
      batch.length,
      text,
      hash,
      isOpen ? 1 : 0,
    );
    for (const m of batch) assign.run(info.lastInsertRowid, m.id);
    const reuse = salvaged.get(hash);
    if (reuse) {
      db.prepare(`UPDATE windows SET embedding = ?, embed_model = ? WHERE id = ?`).run(reuse.embedding, reuse.model, info.lastInsertRowid);
    }
    batch = [];
    chars = 0;
  };

  for (const m of messages) {
    const gapBroken = batch.length > 0 && m.ts - batch[batch.length - 1].ts > gapMs;
    if (gapBroken || batch.length >= WINDOW_MAX_MESSAGES || chars >= WINDOW_MAX_CHARS) flush(false);
    batch.push(m);
    chars += m.content.length;
  }
  // The trailing batch stays open: the next sync may extend this conversation.
  flush(true);

  refreshWindowText(db, channelId, unwindowed.ts);
}

/**
 * Re-derives each window's text from its current messages. An edited message changes its window's
 * hash, which drops the stale embedding so the next embed pass regenerates it.
 */
function refreshWindowText(db: DB, channelId: string, since: number): void {
  const channel = db.prepare(`SELECT name FROM channels WHERE id = ?`).get(channelId) as { name: string };
  // Windows entirely older than the oldest touched message cannot have changed, so re-hashing them
  // every five minutes was pure work.
  const windows = db
    .prepare(`SELECT id, text_hash FROM windows WHERE channel_id = ? AND end_ts >= ?`)
    .all(channelId, since) as { id: number; text_hash: string }[];
  const members = db.prepare(`SELECT author_name, content FROM messages WHERE window_id = ? ORDER BY ts ASC`);
  const update = db.prepare(`UPDATE windows SET text = ?, text_hash = ?, embedding = NULL, embed_model = NULL WHERE id = ?`);

  for (const w of windows) {
    const rows = members.all(w.id) as { author_name: string; content: string }[];
    const text = `#${channel.name}\n` + rows.map((m) => `${m.author_name}: ${m.content}`).join("\n");
    const hash = createHash("sha256").update(text).digest("hex");
    if (hash !== w.text_hash) update.run(text, hash, w.id);
  }
}

async function embedPendingWindows(db: DB): Promise<number> {
  if (!embeddingsEnabled()) {
    log("! OPENAI_API_KEY unset - skipping embeddings, search will be keyword-only");
    return 0;
  }
  const pending = db
    .prepare(`SELECT id, text FROM windows WHERE embedding IS NULL OR embed_model != ? ORDER BY id`)
    .all(config.embedModel) as { id: number; text: string }[];
  if (pending.length === 0) return 0;

  log(`> embedding ${pending.length} windows with ${config.embedModel}`);
  const vectors = await embedTexts(
    pending.map((w) => w.text),
    (done, total) => log(`  ${done}/${total}`),
  );
  const update = db.prepare(`UPDATE windows SET embedding = ?, embed_model = ? WHERE id = ?`);
  db.transaction(() => {
    pending.forEach((w, i) => update.run(floatsToBlob(vectors[i]), config.embedModel, w.id));
  })();
  return pending.length;
}

/**
 * Single-writer lock. The scheduler loop cannot overlap by construction (it sleeps only after a run
 * finishes), but a manual sync or a container restart can collide with one in flight - and two
 * writers on the same SQLite file is a corruption risk, not just an error.
 */
function acquireLock(): () => void {
  const path = join(dirname(config.dbPath), ".sync.lock");
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    let alive = false;
    try {
      // Signal 0 tests for existence without touching the process.
      process.kill(holder, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      throw new Error(`Another sync is already running (pid ${holder}). Refusing to run a second writer.`);
    }
    // The holder died (killed, OOM, restart) and left the lock behind.
    log(`! clearing stale lock from dead pid ${holder}`);
    rmSync(path, { force: true });
  }

  const fd = openSync(path, "wx");
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return () => rmSync(path, { force: true });
}

/**
 * Rebuilds windows and embeddings from messages already in SQLite, without touching Discord.
 * Messages are fetched once and stored permanently, so changing the windowing rules is a local
 * operation - only the embedding is re-billed.
 */
export async function reindex(): Promise<void> {
  const releaseLock = acquireLock();
  const db = openDb();
  const dbs = new Map<string, DB>([[DEFAULT_TIER, db]]);
  // Every existing tier is opened up front. Opening them lazily during ingest meant the purge below
  // could only ever see the default tier, and a channel that moved tiers was never cleaned out of
  // the one it left.
  for (const tier of loadTiers(process.env)) {
    const path = tierDbPath(tier.name);
    if (existsSync(path)) dbs.set(tier.name, openDb(path));
  }
  for (const tier of loadTiers(process.env)) {
    const path = tierDbPath(tier.name);
    if (existsSync(path)) dbs.set(tier.name, openDb(path));
  }

  try {
    for (const [tier, handle] of dbs) {
      const channels = handle.prepare(`SELECT id FROM channels`).all() as { id: string }[];
      log(`> tier ${tier}: rebuilding windows for ${channels.length} channels`);
      handle.transaction(() => {
        handle.prepare(`UPDATE messages SET window_id = NULL`).run();
        handle.prepare(`DELETE FROM windows`).run();
        for (const c of channels) rebuildWindows(handle, c.id);
      })();
      const embedded = await embedPendingWindows(handle);
      const stats = handle.prepare(`SELECT COUNT(*) n, AVG(msg_count) avg FROM windows`).get() as { n: number; avg: number };
      log(`= tier ${tier}: ${stats.n} windows (avg ${stats.avg?.toFixed(1)} messages), ${embedded} embedded`);
    }
  } finally {
    for (const handle of dbs.values()) handle.close();
    releaseLock();
  }
}

export async function sync(options: { full?: boolean; since?: string; seedDir?: string } = {}): Promise<void> {
  const releaseLock = acquireLock();
  const db = openDb();

  // A run killed mid-flight leaves its row open forever, so sync_status would keep reporting
  // "in progress" for a syncer that is dead. The lock above proves nothing else is running now.
  const abandoned = db
    .prepare(`UPDATE sync_runs SET finished_at = ?, error = ? WHERE finished_at IS NULL`)
    .run(Date.now(), "process died before finishing (marked on the next run)");
  if (abandoned.changes > 0) log(`! marked ${abandoned.changes} abandoned sync run(s) as failed`);
  const dbs = new Map<string, DB>([[DEFAULT_TIER, db]]);
  const run = db
    .prepare(`INSERT INTO sync_runs (started_at) VALUES (?)`)
    .run(Date.now());
  const runId = run.lastInsertRowid;

  try {
    // Across every tier: a channel routed to another tier file advances only that file, so reading
    // the default alone would skip a newly added tier's history on non-full runs.
    let watermarkTs: number | null = null;
    for (const handle of dbs.values()) {
      const row = handle.prepare(`SELECT MAX(ts) AS ts FROM messages`).get() as { ts: number | null };
      if (row.ts !== null) watermarkTs = watermarkTs === null ? row.ts : Math.max(watermarkTs, row.ts);
    }
    const watermark = { ts: watermarkTs };
    let sinceMs: number | null = null;
    if (options.since) {
      sinceMs = Date.parse(options.since);
      if (Number.isNaN(sinceMs)) throw new Error(`--since must be a date, got "${options.since}"`);
    }
    // --since bounds a backfill; once there is history, the watermark drives the incremental run.
    const afterMs =
      options.full || watermark.ts === null
        ? sinceMs
        : Math.max(watermark.ts - config.syncOverlapMinutes * 60_000, sinceMs ?? 0);

    const tiers = loadTiers(process.env);
    let added = 0;
    let channels = 0;
    let deleted = 0;

    // One database per tier. A channel is written to exactly one of them, so nothing is duplicated
    // and a role simply never opens a tier it cannot read.
    const touchedByTier = new Map<string, string[]>();
    const dbFor = (tier: string): DB => {
      let handle = dbs.get(tier);
      if (!handle) {
        handle = openDb(tierDbPath(tier));
        dbs.set(tier, handle);
      }
      return handle;
    };

    const excluded: string[] = [];
    const excludeRules = exclusions();

    // Applies to every tier database, not just the default one.
    for (const [tier, handle] of dbs) {
      for (const removed of purgeExcluded(handle, excludeRules)) {
        log(`= purged #${removed.name} from tier ${tier} (${removed.messages.toLocaleString()} messages, now excluded)`);
      }
    }

    // Written channel-by-channel as each one lands, so a stall or an interrupt keeps the work
    // already done instead of discarding the entire fetch.
    const ingest = (data: ChannelExport) => {
      // Nothing new means nothing to rebuild. Marking it touched made every sync rewrite every
      // channel's open window and re-hash its text for no reason.
      if (data.messages.length === 0 && !options.full) return;
      if (isExcluded(data, excludeRules)) {
        excluded.push(`#${data.channel.name}${data.channel.categoryName ? ` (${data.channel.categoryName})` : ""}`);
        return;
      }
      const tier = tierForChannel(tiers, data.channel.categoryId, data.channel.categoryName);

      // A channel whose category moved it to another tier must not stay readable in the tier it
      // left: promoting a category into a restricted tier would otherwise fail open.
      for (const [otherTier, otherDb] of dbs) {
        if (otherTier === tier) continue;
        const removed = deleteChannel(otherDb, data.channel.id);
        if (removed > 0) log(`= moved #${data.channel.name} out of tier ${otherTier} into ${tier} (${removed} messages)`);
      }

      const handle = dbFor(tier);
      handle.transaction(() => {
        added += upsertExport(handle, data);
        // Only a full run sees a channel's complete id set, so only it can tell a deleted message
        // from one that simply predates the incremental cursor.
        if (options.full) {
          const ids = new Set(data.messages.map((m) => m.id));
          const stored = handle.prepare(`SELECT id FROM messages WHERE channel_id = ?`).all(data.channel.id) as { id: string }[];
          const gone = stored.filter((r) => !ids.has(r.id)).map((r) => r.id);
          if (gone.length > 0) {
            for (let i = 0; i < gone.length; i += 500) {
              const batch = gone.slice(i, i + 500);
              const marks = batch.map(() => "?").join(",");
              handle.prepare(`DELETE FROM messages_fts WHERE message_id IN (${marks})`).run(...batch);
              handle.prepare(`DELETE FROM messages WHERE id IN (${marks})`).run(...batch);
            }
            deleted += gone.length;
          }
        }
      })();
      const touched = touchedByTier.get(tier);
      if (touched) touched.push(data.channel.id);
      else touchedByTier.set(tier, [data.channel.id]);
      channels++;
    };

    // Seeding reads local JSON instead of calling Discord, so the pipeline can be exercised - and
    // demonstrated - without a bot token.
    if (options.seedDir) {
      log(`> seeding from ${options.seedDir} (no Discord calls)`);
      for (const file of readdirSync(options.seedDir).filter((f) => f.endsWith(".json"))) {
        ingest(JSON.parse(readFileSync(join(options.seedDir, file), "utf8")) as ChannelExport);
      }
    } else {
      await fetchGuild(afterMs, ingest);
    }

    // Include every open tier, so a tier with only leftover orphans is still repaired.
    for (const tier of dbs.keys()) if (!touchedByTier.has(tier)) touchedByTier.set(tier, []);

    for (const [tier, channelIds] of touchedByTier) {
      const handle = dbFor(tier);
      handle.transaction(() => {
        // Any channel carrying messages without a window is rebuilt too, not just the ones touched
        // in this run - otherwise a run interrupted after persisting messages leaves them
        // permanently unsearchable, and the orphan check below would block every later sync.
        const orphaned = handle
          .prepare(`SELECT DISTINCT channel_id FROM messages WHERE window_id IS NULL`)
          .all() as { channel_id: string }[];
        for (const channelId of new Set([...channelIds, ...orphaned.map((o) => o.channel_id)])) {
          rebuildWindows(handle, channelId);
        }
        handle.exec(`
          UPDATE channels SET
            message_count   = (SELECT COUNT(*) FROM messages WHERE channel_id = channels.id),
            last_message_ts = (SELECT MAX(ts)  FROM messages WHERE channel_id = channels.id)
        `);
      })();
    }

    for (const [tier, handle] of dbs) {
      const orphaned = handle.prepare(`SELECT COUNT(*) AS n FROM messages WHERE window_id IS NULL`).get() as { n: number };
      if (orphaned.n > 0) {
        throw new Error(`${orphaned.n} messages in tier "${tier}" were left without a window and would be invisible to search - this is a bug in window rebuilding, not a recoverable state`);
      }
    }

    let embedded = 0;
    for (const [tier, handle] of dbs) {
      const n = await embedPendingWindows(handle);
      if (n > 0) log(`  tier ${tier}: ${n} windows embedded`);
      embedded += n;
    }
    const failure = null;
    db.prepare(
      `UPDATE sync_runs SET finished_at = ?, channels_synced = ?, messages_added = ?, windows_embedded = ?, error = ? WHERE id = ?`,
    ).run(Date.now(), channels, added, embedded, failure, runId);

    log(`= synced ${channels} channels, ${added} messages${deleted > 0 ? `, ${deleted} deleted` : ""}, ${embedded} windows embedded`);
    log(`= tiers: ${[...dbs.keys()].join(", ")}`);
    if (excluded.length > 0) log(`= excluded from the index: ${excluded.join(", ")}`);
  } catch (error) {
    const message = scrubToken(error instanceof Error ? error.message : String(error));
    db.prepare(`UPDATE sync_runs SET finished_at = ?, error = ? WHERE id = ?`).run(Date.now(), message, runId);
    throw error;
  } finally {
    for (const handle of dbs.values()) handle.close();
    releaseLock();
  }
}
