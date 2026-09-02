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

## What leaves your network, and what gets stored

Read this before pointing it at a company server.

- **Message text is sent to OpenAI** to be embedded — channel name, display names
  and message bodies. That is how semantic search works. **Omit `OPENAI_API_KEY`
  and nothing leaves your machine**: search falls back to keyword-only and says so
  in every result.
- **The index stores** message content, author name and id, timestamps, edits and
  attachment metadata. Search is **attributed** — "what did Sam say about X" is a
  first-class query. Everyone with a token can do that.
- **DMs are never indexed.** The bot only ever sees guild channels and threads.
- **The bot sees exactly what its Discord role sees.** Scope it there first: that
  is the strongest control available, and it costs nothing.
- **Deleted messages stay searchable until the next `sync --full`.** The
  incremental cursor cannot see a deletion. Run a full sync on a schedule if that
  matters to you.
- **Write your `exclude:` rules before the first sync.** A first run with no
  `--since` fetches the entire server history and embeds all of it. Adding an
  exclusion later purges the index, but cannot un-send anything to OpenAI.
- **Every tool call is logged** with role, client IP, arguments and result count.
  Set `AUDIT_LOG_PATH` to keep it in a file.

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

**Node 24+ and pnpm.** `better-sqlite3` aborts with no output on an older ABI, so
the CLI refuses to start below 24. Note that some version managers hand
`pnpm run` a *different* Node than the one you installed with — if a script trips
the version check, call `node dist/cli.js` directly.

```bash
pnpm install
pnpm build
cp .env.example .env      # DISCORD_TOKEN, DISCORD_GUILD_ID, OPENAI_API_KEY
node dist/cli.js sync --since 2026-06-01   # bounded first backfill
claude mcp add discord-index -- node $PWD/dist/cli.js serve
```

Getting the Discord side right takes longer than the install:

1. Create an app at [discord.com/developers](https://discord.com/developers/applications), add a bot, copy its token.
2. **Bot → Privileged Gateway Intents → enable Message Content.** Without it the
   API returns your history with empty `content` and the sync aborts.
3. Invite it with **View Channels + Read Message History** and nothing else.
   Denying Send Messages in the channel overrides is worth the extra minute.
4. Enable Developer Mode in Discord, right-click the server, Copy ID.

No bot token handy? See it work on example data, no Discord account needed:

```bash
pnpm install && pnpm build && pnpm seed && pnpm smoke
```

## Deploying for a team

**Anywhere with Docker** — the MCP server, a sync loop, and Caddy:

```bash
cp .env.example .env
# Required, or Caddy serves plain HTTP and your token crosses the wire in clear:
echo 'SITE_ADDRESS=mcp.your-domain.com' >> .env
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose up -d --build
```

`SITE_ADDRESS` must be a hostname whose DNS already points at the box — Caddy
gets a Let's Encrypt certificate for it on first request. Leaving it unset falls
back to `:80`, which is fine only behind a proxy or tunnel that terminates TLS
itself.

**On AWS** — [`deploy/aws/cloudformation.yaml`](deploy/aws/cloudformation.yaml)
provisions a Graviton instance (~$20/month with the default `t4g.small`, volume
and Elastic IP), and requires you to restrict port 443 to your own range or a
CDN's, so the origin cannot be reached directly. It also sets up: encrypted
volume, IMDSv2 required, SSH closed in favour of SSM Session Manager,
`unattended-upgrades`, a non-root container, and secrets fetched from Secrets
Manager at boot rather than baked into user-data.

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

**Deletions** are only reconciled by `sync --full` — the incremental cursor
cannot see them. Nothing automates this; schedule it if deleted content must
actually disappear.

**No backups.** The index is rebuildable by re-syncing, which is the reason
there is no backup story — but a lost volume costs you a full backfill and
re-embed.

**One shared token has no revocation.** Issuing one role per person is supported
today (one `tokenEnv` each) and is what you want if people leave.

**Node 24+.** `better-sqlite3` aborts with no output on an older ABI, so the CLI
refuses to start below 24. Some version managers hand `pnpm run` a different Node
than the one you installed with — if a script fails the check, call
`node dist/cli.js` directly.

## Tests

```bash
node --test dist/__tests__/*.test.js   # access-control isolation
pnpm seed && pnpm smoke                # whole pipeline over real MCP stdio, no token needed
```

The unit tests cover the property that must never regress quietly: that a role
cannot reach a category it was denied — through search, through a reply chain
that crosses the boundary, through `get_context` on a known id, or through
`list_channels`. They also check that a denied id and a nonexistent one produce
the *same* error, so the error itself cannot confirm the id exists.

Use `node --test` rather than `pnpm test` if your version manager hands pnpm an
older Node than the one you installed with.

## Ideas, bugs, "why does it do that"

Open an issue, or find me at **[@0xnick__](https://x.com/0xnick__)**. Genuinely
interested in what breaks and what's missing — especially from anyone running it
against a server shaped differently from ours.

## License

MIT.
