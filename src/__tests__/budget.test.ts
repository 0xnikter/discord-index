/**
 * A client rejects an oversized tool result outright, so an untrimmed `wide` search over many hits
 * returns nothing at all. These assert the trim fits, keeps what matched, and says that it happened.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fitToBudget, type SearchHit, type SearchResult } from "../search.js";

const msg = (i: number, matched: boolean, size: number) => ({
  ts: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
  author: `user${i % 5}`,
  content: `m${i} `.padEnd(size, "x"),
  jump_url: `https://discord.com/channels/1/2/${i}`,
  matched,
});

const hit = (id: number, count: number, matchedAt: number[], size = 60): SearchHit => ({
  tier: "default",
  window_id: id,
  channel: `chan-${id}`,
  category: "cat",
  start: new Date(1_700_000_000_000).toISOString(),
  end: new Date(1_700_000_100_000).toISOString(),
  score: 1 / id,
  matched_by: ["keyword", "semantic"],
  jump_url: `https://discord.com/channels/1/2/${id}`,
  messages: Array.from({ length: count }, (_, i) => msg(i, matchedAt.includes(i), size)),
});

const result = (hits: SearchHit[]): SearchResult => ({
  hits,
  freshness: { last_sync: new Date(1_700_000_000_000).toISOString(), minutes_behind: 2, stale: false },
  mode_used: "hybrid",
  notes: [],
  scope: "team",
  tiers: ["default"],
});

/** Must match the transport's serialisation, indent included. */
const size = (r: SearchResult) => JSON.stringify(r, null, 2).length;
/** The shape that produced the 74,578-character rejection: wide context, limit 10. */
const overflowing = () => result(Array.from({ length: 10 }, (_, i) => hit(i + 1, 100, [50])));

test("a result that already fits is returned untouched", () => {
  const r = result([hit(1, 5, [2])]);
  const out = fitToBudget(r, 100_000);
  assert.deepEqual(out, r);
  assert.equal(out.truncated, undefined);
});

test("the reported wide-context overflow is brought under budget", () => {
  const r = overflowing();
  assert.ok(size(r) > 74_000, `fixture should reproduce the overflow, got ${size(r)}`);
  assert.ok(size(fitToBudget(r, 40_000)) <= 40_000);
});

test("every matched message survives when context is dropped", () => {
  const r = result(Array.from({ length: 10 }, (_, i) => hit(i + 1, 100, [40, 50, 60])));
  for (const h of fitToBudget(r, 40_000).hits) {
    assert.equal(h.messages.filter((m) => m.matched).length, 3);
  }
});

test("the trim announces itself rather than shrinking silently", () => {
  const out = fitToBudget(overflowing(), 40_000);
  assert.equal(out.truncated, true);
  assert.match(out.notes.join(" "), /trimmed/i);
  assert.match(out.notes.join(" "), /of \d+ messages/);
});

test("trimmed messages stay chronological and contiguous around the match", () => {
  for (const h of fitToBudget(overflowing(), 40_000).hits) {
    const ts = h.messages.map((m) => Date.parse(m.ts));
    assert.deepEqual([...ts].sort((a, b) => a - b), ts);
  }
});

test("whole hits are dropped from the bottom, never the top hit", () => {
  const r = result(Array.from({ length: 40 }, (_, i) => hit(i + 1, 60, Array.from({ length: 60 }, (_, k) => k), 200)));
  const out = fitToBudget(r, 20_000);
  assert.ok(size(out) <= 20_000);
  assert.ok(out.hits.length >= 1);
  assert.equal(out.hits[0].window_id, 1);
});

test("a single hit larger than the whole budget is still returned, trimmed", () => {
  const r = result([hit(1, 400, Array.from({ length: 400 }, (_, k) => k), 300)]);
  const out = fitToBudget(r, 8_000);
  assert.ok(size(out) <= 8_000);
  assert.equal(out.hits.length, 1);
  assert.equal(out.truncated, true);
});

test("freshness, scope and tiers survive every trim path", () => {
  const r = result(Array.from({ length: 20 }, (_, i) => hit(i + 1, 100, [50], 200)));
  const out = fitToBudget(r, 10_000);
  assert.equal(out.scope, "team");
  assert.deepEqual(out.freshness, r.freshness);
  assert.deepEqual(out.tiers, ["default"]);
});
