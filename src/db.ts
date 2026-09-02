import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { DEFAULT_TIER } from "./roles.js";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT,
  category_id     TEXT,
  type            TEXT,
  topic           TEXT,
  guild_id        TEXT NOT NULL,
  guild_name      TEXT,
  last_synced_at  INTEGER,
  last_message_ts INTEGER,
  message_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id),
  author_id   TEXT NOT NULL,
  author_name TEXT NOT NULL,
  content     TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  edited_ts   INTEGER,
  jump_url    TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  reply_to    TEXT,
  window_id   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_window     ON messages(window_id);
CREATE INDEX IF NOT EXISTS idx_messages_author     ON messages(author_name);

-- Standalone (not external-content) FTS: upserts stay a simple delete+insert with no trigger dance.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  content,
  author_name,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS windows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  TEXT NOT NULL REFERENCES channels(id),
  start_ts    INTEGER NOT NULL,
  end_ts      INTEGER NOT NULL,
  msg_count   INTEGER NOT NULL,
  text        TEXT NOT NULL,
  text_hash   TEXT NOT NULL,
  is_open     INTEGER NOT NULL DEFAULT 0,
  embedding   BLOB,
  embed_model TEXT
);
CREATE INDEX IF NOT EXISTS idx_windows_channel ON windows(channel_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_windows_chan_open ON windows(channel_id, is_open);

CREATE TABLE IF NOT EXISTS sync_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  channels_synced INTEGER NOT NULL DEFAULT 0,
  messages_added  INTEGER NOT NULL DEFAULT 0,
  windows_embedded INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);
`;

/** Database file for a tier. Tiers are separate files, so a tier a role cannot read is never opened. */
export function tierDbPath(tier: string): string {
  const base = config.dbPath.replace(/\.db$/, "");
  return tier === DEFAULT_TIER ? `${base}.db` : `${base}.${tier}.db`;
}

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` silently skips an existing
 * table, so without this an upgraded binary meets an old database and fails at query time.
 */
const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "channels", column: "category_id", ddl: "ALTER TABLE channels ADD COLUMN category_id TEXT" },
  { table: "messages", column: "reply_to", ddl: "ALTER TABLE messages ADD COLUMN reply_to TEXT" },
];

/** Indexes that must exist regardless of when the database was first created. */
const INDEXES: string[] = [
  "CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to)",
  "CREATE INDEX IF NOT EXISTS idx_channels_category ON channels(category_id)",
  "CREATE INDEX IF NOT EXISTS idx_windows_chan_open ON windows(channel_id, is_open)",
  "DROP INDEX IF EXISTS idx_windows_open",
];

function migrate(db: DB): void {
  for (const { table, column, ddl } of MIGRATIONS) {
    const exists = (db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
    if (!exists) db.exec(ddl);
  }
  for (const ddl of INDEXES) db.exec(ddl);
}

export function openDb(path: string = config.dbPath): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function floatsToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToFloats(buf: Buffer): Float32Array {
  // Copy: the Buffer's underlying pool is shared and may be reused by node.
  const copy = new ArrayBuffer(buf.byteLength);
  Buffer.from(copy).set(buf);
  return new Float32Array(copy);
}
