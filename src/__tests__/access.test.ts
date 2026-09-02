/**
 * Access control is the one thing here that must not regress silently: a leak is invisible until
 * someone reads content they should not have. These assert the isolation properties directly.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDb } from "../db.js";
import { resolveRole, scopeFor, type Role } from "../roles.js";
import { getContext, listChannels, search } from "../search.js";

const ALLOWED = "Product";
const DENIED = "Boardroom";

function seed(dir: string) {
  const db = openDb(join(dir, "index.db"));
  const channel = db.prepare(
    `INSERT INTO channels (id, name, category, category_id, type, topic, guild_id, guild_name, last_synced_at, message_count)
     VALUES (?, ?, ?, ?, '0', NULL, 'g', 'G', ?, 2)`,
  );
  channel.run("c-open", "engineering", ALLOWED, "cat-open", Date.now());
  channel.run("c-secret", "board", DENIED, "cat-secret", Date.now());

  const win = db.prepare(
    `INSERT INTO windows (channel_id, start_ts, end_ts, msg_count, text, text_hash, is_open) VALUES (?, ?, ?, 1, ?, ?, 0)`,
  );
  const msg = db.prepare(
    `INSERT INTO messages (id, channel_id, author_id, author_name, content, ts, jump_url, window_id, reply_to)
     VALUES (?, ?, 'u', 'ada', ?, ?, 'https://x', ?, ?)`,
  );
  const fts = db.prepare(`INSERT INTO messages_fts (message_id, content, author_name) VALUES (?, ?, 'ada')`);

  const now = Date.now();
  const openWin = win.run("c-open", now, now, "public widget release", "h1").lastInsertRowid as number;
  const secretWin = win.run("c-secret", now, now, "widget acquisition price", "h2").lastInsertRowid as number;

  msg.run("m-open", "c-open", "the widget release is public", now, openWin, null);
  fts.run("m-open", "the widget release is public");
  // Deliberately replies ACROSS the boundary: a Discord forward does exactly this.
  msg.run("m-secret", "c-secret", "SECRET widget acquisition price is 40 million", now, secretWin, "m-open");
  fts.run("m-secret", "SECRET widget acquisition price is 40 million");
  return db;
}

const role = (over: Partial<Role> = {}): Role => ({
  name: "team",
  token: "x".repeat(16),
  tiers: ["common"],
  denyCategories: [DENIED],
  denyChannels: [],
  ...over,
});

test("a denied category never appears in search results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "di-"));
  try {
    const db = seed(dir);
    const r = await search(db, "widget", {}, { mode: "keyword", scope: scopeFor(role()) });
    const text = JSON.stringify(r);
    assert.ok(!text.includes("SECRET"), "denied content leaked into search results");
    assert.ok(text.includes("public"), "allowed content should still be returned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reply chain cannot pull content out of a denied category", async () => {
  const dir = mkdtempSync(join(tmpdir(), "di-"));
  try {
    const db = seed(dir);
    // The allowed message is replied to FROM the denied one, so an unscoped walk would follow it.
    const r = await search(db, "widget release", {}, { mode: "keyword", scope: scopeFor(role()), context: "wide" });
    assert.ok(!JSON.stringify(r).includes("SECRET"), "reply walk crossed the deny boundary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("get_context on a denied id is indistinguishable from a missing message", () => {
  const dir = mkdtempSync(join(tmpdir(), "di-"));
  try {
    const db = seed(dir);
    const denied = () => getContext(db, "m-secret", 5, 5, scopeFor(role()));
    const missing = () => getContext(db, "does-not-exist", 5, 5, scopeFor(role()));
    assert.throws(denied, /not in the index/, "a denied id must not be retrievable");
    assert.throws(missing, /not in the index/);
    // Identical message: the error itself must not confirm the id exists.
    let a = "", b = "";
    try { denied(); } catch (e) { a = (e as Error).message.replace("m-secret", "ID"); }
    try { missing(); } catch (e) { b = (e as Error).message.replace("does-not-exist", "ID"); }
    assert.equal(a, b, "the error reveals whether the id exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list_channels hides denied channels", () => {
  const dir = mkdtempSync(join(tmpdir(), "di-"));
  try {
    const db = seed(dir);
    const names = (listChannels(db, scopeFor(role())) as { channel: string }[]).map((c) => c.channel);
    assert.deepEqual(names, ["engineering"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unrestricted role sees everything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "di-"));
  try {
    const db = seed(dir);
    const full = role({ name: "admin", denyCategories: [] });
    const r = await search(db, "widget", {}, { mode: "keyword", scope: scopeFor(full) });
    assert.ok(JSON.stringify(r).includes("SECRET"), "an unrestricted role should reach everything");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("token comparison rejects prefixes and is length-independent", () => {
  const roles = [role({ token: "a".repeat(32) })];
  assert.equal(resolveRole(roles, "a".repeat(32))?.name, "team");
  assert.equal(resolveRole(roles, "a".repeat(31)), null, "a prefix must not authenticate");
  assert.equal(resolveRole(roles, "a".repeat(33)), null);
  assert.equal(resolveRole(roles, ""), null);
});
