# discord-index

Search your team's Discord the way you'd ask a colleague, from inside Claude.

```
you:  what did we decide about switching the queue backend?

→  #engineering, 14 Mar
   ada:   redis is dropping jobs under load, we lose ~2% on spikes
   grace: SQS then? we already pay for it
   ada:   yes, and it gives us the retry semantics for free
   (+ the surrounding messages, with jump links)
```

Not a keyword grep. Ask in your own words and it finds the conversation, even
when none of your words appear in it.

## Why this exists

Discord's message-search endpoint is **closed to bots**. Every MCP server that
queries the Discord API live is stuck at 100 messages per call, one channel at a
time — fine for "read me the last few messages in #general", useless for "where
did we discuss this".

So this keeps its own index. It fetches your history once, stores it in SQLite,
and searches locally:

```
Discord API ──▶ SQLite (FTS5 + embeddings) ──▶ MCP ──▶ Claude
```

On a real 59k-message server, a query takes well under a second.

## What makes the answers useful

**It returns conversations, not matching lines.** A hit that says
*"actually the rewrite broke staging"* is worthless without what came before it.
Each result is assembled from Discord's own structure, in order of how reliable
that structure is:

1. **Reply chains** — Discord states them outright, so they survive any time gap.
   A reply three days later is still the same conversation.
2. **The whole thread**, when the hit is in one.
3. **Time-adjacent messages**, because most people just post the next message
   without hitting reply.

Hits from the same discussion are merged into one result, and every message is
tagged `matched: true/false` so the model can tell the hit from its context.

**Hybrid ranking.** SQLite FTS5/BM25 finds exact strings — error text, ticket
ids, library names. Embeddings find meaning: *"someone was unhappy about waiting
too long"* surfaces a complaint about load times with no shared words. The two
rankings are fused with Reciprocal Rank Fusion, so BM25 scores and cosine
distances never have to be put on a common scale.

**Stale answers announce themselves.** Every result carries a freshness block,
and a lagging index says so instead of quietly answering from old data.

## Four tools

| Tool | What it does |
|---|---|
| `search_messages` | Hybrid search. Returns conversations with jump URLs. `context: wide` for "the whole discussion". |
| `get_context` | Messages around a given id, for reading further. |
| `list_channels` | What's indexed, with message counts. |
| `sync_status` | Totals, embedding coverage, freshness, last run and its error. |

## Quick start

You need a Discord bot with **View Channels** + **Read Message History** and the
**Message Content** intent enabled. That intent is not optional: without it the
API returns history with empty `content`.

```bash
pnpm install
cp .env.example .env      # DISCORD_TOKEN, DISCORD_GUILD_ID, OPENAI_API_KEY
pnpm build
node dist/cli.js sync --since 2026-06-01   # bounded first backfill
claude mcp add discord-index -- node $PWD/dist/cli.js serve
```

No bot token handy? See it work on example data first:

```bash
pnpm seed && pnpm smoke
```

## Deploying for a team

**Anywhere with Docker** — the MCP server, a sync loop, and Caddy for TLS:

```bash
docker compose up -d --build
```

**On AWS** — [`deploy/aws/cloudformation.yaml`](deploy/aws/cloudformation.yaml)
provisions a Graviton instance, encrypted volume, Elastic IP, and automatic
HTTPS. Secrets go to Secrets Manager, never into user-data.

Either way, the HTTP transport **requires a bearer token and refuses to start
without one**, so there's no way to accidentally publish your archive.

```bash
claude mcp add --transport http discord-index https://your.host/mcp \
  -H "Authorization: Bearer $TOKEN"
```

## Controlling who sees what

Policy lives in a YAML file that holds **no secrets** — tokens are referenced by
environment variable name, so it belongs in version control where changes to
who-can-read-what get reviewed like code.

```yaml
tiers:
  - name: leadership
    categories: ["1234567890"]     # Discord category id

roles:
  - name: team
    tokenEnv: MCP_TOKEN_TEAM
    tiers: [common]                # leadership database is never opened
  - name: leadership
    tokenEnv: MCP_TOKEN_LEADERSHIP
    tiers: [common, leadership]    # one search, both tiers, fused
```

Each tier is a **separate database file**. A role that can't read a tier never
opens it, so a forgotten filter in some future query can't leak it — the data
isn't in any file that process has open. Within a tier, `denyCategories` and
`allowCategories` narrow further, enforced in the SQL of every tool rather than
as a post-filter.

Rules match Discord **IDs** as well as names. Prefer IDs: renaming a category
silently stops a name rule from matching, which quietly widens access.

Two layers, for two different questions:

| | |
|---|---|
| `exclude:` | **Never indexed.** Not in any database, so nothing can reach it. Adding a rule also purges what was already stored. |
| Role tiers / deny | **Indexed but filtered per caller.** For content some roles legitimately need. |

## Costs and limits

**Embeddings** are the only paid part: `text-embedding-3-small` at $0.02/1M
tokens. A 59k-message backfill is roughly **$0.11**. Incremental syncs re-embed
only what changed, so a quiet cycle costs nothing. Without `OPENAI_API_KEY`
everything still works, keyword-only, and says so in the results.

**Rate limits.** Every channel shares one Discord bucket — measured at 5
requests/second — so concurrency hides latency but cannot raise the ceiling. A
full incremental pass is about one request per channel. Sync runs on a loop with
the interval measured from the end of the previous run, so runs never overlap,
and a single-writer lock covers manual runs and container restarts.

**Scale.** Semantic search scores every window vector in memory, cached per
process. Comfortable to roughly 50k windows (~2.5M messages); past that, move the
vectors to sqlite-vec or pgvector.

**Deletions** are only reconciled by `sync --full`. Run it weekly.

**Node 24+.** `better-sqlite3` aborts with no output on an older ABI, so the CLI
refuses to start below 24. Some version managers hand `pnpm run` a different Node
than the one you installed with — if a script fails the check, call
`node dist/cli.js` directly.

## Ideas, bugs, "why does it do that"

Open an issue, or find me at **[@0xnick__](https://x.com/0xnick__)**. Genuinely
interested in what breaks and what's missing — especially from anyone running it
against a server shaped differently from ours.

## License

MIT.
