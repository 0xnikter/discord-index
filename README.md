# discord-index

Searchable index over a Discord server, exposed to Claude as MCP tools.

Discord's message-search endpoint is closed to bots, so no MCP server that talks to the Discord API
live can offer real search — the ceiling is 100 messages per call, one channel at a time. This project
gets around that by keeping a local index: [DiscordChatExporter][dce] pulls the messages, SQLite FTS5 +
OpenAI embeddings rank them, and a small MCP server serves four tools.

[dce]: https://github.com/Tyrrrz/DiscordChatExporter

```
Discord ──DCE exportguild --after──▶ export/*.json ──▶ SQLite (FTS5 + embeddings) ──▶ MCP ──▶ Claude
```

## MCP tools

| Tool | Purpose |
|---|---|
| `search_messages` | Hybrid keyword + semantic search. Returns conversation **windows**, not isolated messages, each with jump URLs. |
| `get_context` | Messages before/after a given message id — for reading around a hit. |
| `list_channels` | Indexed channels with message counts and last activity. |
| `sync_status` | Totals, embedding coverage, freshness, and the last sync run (including its error). |

## Setup

```bash
pnpm install
pnpm fetch-dce                 # self-contained DCE binary, no .NET or Docker needed
cp .env.example .env           # fill in DISCORD_TOKEN + DISCORD_GUILD_ID
pnpm build
node dist/cli.js sync --since 2026-06-01   # bounded first backfill; drop --since for all history
```

The Discord bot needs **View Channels + Read Message History and nothing else**, plus the
Message Content intent in the developer portal. It only ever sees channels it has been granted access to.

Register with Claude Code:

```bash
claude mcp add discord-index -- node /absolute/path/to/discord-index/dist/cli.js serve
```

## How it works

**Windows.** Messages are grouped into conversation windows that break on a 30-minute silence, 50
messages, or 4000 characters. Windows are the unit of retrieval: they give the embedding real
conversational context and keep the vector count ~50x lower than per-message embedding, which is what
makes brute-force cosine viable without a vector database.

**Hybrid ranking.** FTS5/BM25 finds exact strings (error text, ticket ids, library names); embeddings
find concepts. The two rankings are combined with Reciprocal Rank Fusion, so BM25 and cosine never
have to be put on a common scale. `mode: "keyword"` or `"semantic"` forces one side.

**Incremental sync.** `--after` is a real server-side cursor, so a quiet channel costs exactly one
Discord request per run. An unchanged open window keeps its embedding across syncs (matched by content
hash), so an idle server costs zero embedding calls.

**Freshness is explicit.** Every search result carries a `freshness` block, and a stale index says so
in a `warning` rather than quietly answering from old data. `sync` hard-fails if any message ends up
without a window, because such a message would be silently unsearchable.

## Operating

```bash
node dist/cli.js sync                      # incremental: only messages newer than the watermark
node dist/cli.js sync --since 2026-06-01   # bounded backfill (cheap first run)
node dist/cli.js sync --full               # re-fetch all history
node dist/cli.js reindex                   # rebuild windows + embeddings from stored messages,
                                           # no Discord calls (use after changing WINDOW_GAP_MINUTES)
node dist/cli.js sync --seed ./fixture     # index local example data, no token needed
node dist/cli.js status
node dist/cli.js search "database migration" --mode hybrid --channel engineering
```

**Messages are fetched once and stored permanently.** An incremental sync only asks for messages
newer than the watermark, so existing ones are never re-fetched — which is why `reindex` can change
the windowing rules without touching Discord, re-billing only the embeddings.

**Run `sync --full` weekly.** The incremental cursor filters on message id, so it never revisits an
old message that was edited or notices one that was deleted. The weekly full pass repairs both.

**Cadence.** With ~40 channels a run costs ~41 Discord requests — about 0.14 req/s against a 50 req/s
bot limit, so even a 5-minute timer is far below any threshold. 30 minutes is the default and is
usually plenty for a knowledge index.

**Keep `INCLUDE_THREADS=Active`.** `All` re-checks every archived thread on every run — archived
threads never change, and a server with hundreds of them turns a 41-request sync into a 500-request one.

**Embedding cost.** `text-embedding-3-small` at $0.02/1M tokens. A 200k-message backfill is roughly
6M tokens (~$0.12); steady-state incremental syncs are a fraction of a cent. Without `OPENAI_API_KEY`
everything still works keyword-only, and says so in the result `notes`.

## Deploying for a team

The HTTP transport requires a bearer token — **the server refuses to start without one**, so there is
no way to accidentally publish your archive unauthenticated. stdio needs no token.

### One-click on AWS

[`deploy/aws/cloudformation.yaml`](deploy/aws/cloudformation.yaml) provisions one EC2 instance (Graviton,
Ubuntu 24.04), an encrypted gp3 volume, an Elastic IP, a security group open only on 80/443, and Caddy
for automatic HTTPS. SSH is closed by default — shell access is via SSM Session Manager.

```bash
aws cloudformation deploy \
  --template-file deploy/aws/cloudformation.yaml \
  --stack-name discord-index \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
      VpcId=vpc-xxx SubnetId=subnet-xxx \
      Domain=discord-mcp.example.com \
      DiscordToken=... DiscordGuildId=... \
      McpAuthToken="$(openssl rand -hex 32)" \
      OpenAiApiKey=...
```

Then point your domain's A record at the `PublicIp` in the stack Outputs. Caddy issues the certificate
on first request. The stack only reports success once `/healthz` answers, so a broken boot rolls back
with a reason instead of hanging.

Build the first index:

```bash
aws ssm start-session --target <instance-id>
cd /opt/discord-index && docker compose run --rm sync node dist/cli.js sync --full
```

### Anywhere else

```bash
cp .env.example .env    # set DISCORD_TOKEN, DISCORD_GUILD_ID, MCP_AUTH_TOKEN, DOMAIN
docker compose up -d --build
```

Three services: the MCP server, a sync loop (`SYNC_INTERVAL_SECONDS`, default 1800), and Caddy.

### Hardening

What the stack does and does not protect:

| | |
|---|---|
| SSH | **Closed by default** — no ingress rule unless you set `AllowedSshCidr`. Shell access is SSM Session Manager. `fail2ban` is installed to guard `sshd` if you do open it. |
| MCP endpoint | Bearer token, plus a per-IP limiter: 300 req/min, and 10 failed auths in 5 minutes locks the IP out for the rest of the window (`429` + `Retry-After`). Rejections are logged with the client IP. |
| Network | `AllowedMcpCidr` is **required** — there is no permissive default. Use `0.0.0.0/0` only behind a CDN or tunnel. |
| OS | `unattended-upgrades` enabled at boot. |
| Secrets | Held in Secrets Manager and fetched at boot by the instance role — **never written into user-data**, which any process on the box can read via IMDS and which persists for the life of the instance. |
| Metadata | IMDSv2 required (`HttpTokens: required`) with `HttpPutResponseHopLimit: 1`, so an SSRF in the app cannot reach user-data or the role credentials. |
| Container | Runs as the unprivileged `node` user, not root. |
| Disk | Root volume encrypted. |

The limiter is not credential defence — a 256-bit token is not brute-forceable. It bounds runaway
clients and caps the damage from a token that leaks into a shell history or a committed config. If a
token does leak, redeploy with a new `McpAuthToken`; there is no revocation list.

Behind a proxy the limiter keys on `X-Forwarded-For`, which is client-controlled — so set
`TRUST_PROXY=false` if you ever expose the server directly instead of through the bundled Caddy.

### Role-scoped access

A single shared token cannot express "cofounders only" — the server sees one identity for every
caller. Give each role its own token instead:

Rules match the Discord **category/channel ID** as well as the name — prefer IDs, because a category
renamed in Discord silently stops matching a name rule and quietly widens access:

```yaml
exclude:
  categories: ["000000000000000000"]   # never indexed at all

roles:
  - name: team
    tokenEnv: MCP_TOKEN_TEAM
    denyCategories: ["000000000000000000"]
  - name: marketing
    tokenEnv: MCP_TOKEN_MARKETING
    allowCategories: [Growth, Product]
  - name: cofounder
    tokenEnv: MCP_TOKEN_COFOUNDER
```

Policy lives in a YAML (or JSON) file that `POLICY_FILE` points at — see
[`policy.example.yaml`](policy.example.yaml). It contains **no secrets**: tokens are referenced by
environment variable name (`tokenEnv`), so the file is meant to be committed and reviewed, while the
tokens come from your secret store. Without `POLICY_FILE`, `MCP_AUTH_TOKEN` is a single full-access role.

A role whose `tokenEnv` is unset **aborts startup** rather than silently denying that role — or, far
worse, silently allowing it. The sync process reads only the `exclude:` block and never resolves
tokens, so it does not need any role's credentials.

Scoping is applied **inside the SQL of every tool**, never as a post-filter, so a denied channel
cannot leak through a code path that forgot to filter. That covers the non-obvious paths too:
`get_context` on a known message id in a denied channel returns "not in the index" — identical to a
message that does not exist, so the error itself reveals nothing — and `sync_status` counts are
scoped, because totals over channels you cannot read still leak their size.

### Tiers: separate databases, one endpoint

A tier is a group of categories stored in **its own database file**. A channel lives in exactly one
tier, so nothing is duplicated. A role lists the tiers it may read, and tiers it may not read are
**never opened** — so a forgotten filter in a future query cannot leak them, because the data is not
in any file that process has open.

```yaml
tiers:
  - name: cofounder
    categories: ["000000000000000000"]

roles:
  - name: team
    tokenEnv: MCP_TOKEN_TEAM
    tiers: [common]                 # cofounder database never opened
  - name: cofounder
    tokenEnv: MCP_TOKEN_COFOUNDER
    tiers: [common, cofounder]      # one search, both tiers, fused
```

Multi-tier roles are still **one MCP endpoint and one search**: each tier is queried with the same
SQL and contributes its own ranking, and Reciprocal Rank Fusion merges them — so BM25 scores computed
over different corpora are never compared, only ranks.

### Two layers, for two different questions

| | |
|---|---|
| `EXCLUDE_CATEGORIES` / `EXCLUDE_CHANNELS` | **Never indexed.** The content is not in the database at all, so no role, no misconfiguration, and nobody reading the file can reach it. Use for anything that must not be stored. |
| Role `denyCategories` / `allowCategories` | **Indexed but filtered per caller.** Use when some roles legitimately need the content and others must not see it. |

Excluding at index time is strictly stronger; role scoping is what lets cofounders search their own
channels while nobody else can.

### Audit log

Every tool call is logged as JSON to stderr (collected by journald / `docker logs`), and to
`AUDIT_LOG_PATH` if set: timestamp, tool, role, client IP, arguments, result count, and any error.

With a shared team token this attributes to a **role, not a person**. If you need to know *who* ran a
query, each person needs their own token.

### Teammates connect with

```bash
claude mcp add --transport http discord-index https://discord-mcp.example.com/mcp \
  -H "Authorization: Bearer <token>"
```

Add `-s project` to write a `.mcp.json` your repo can commit, configuring everyone at once.

> **A shared index flattens Discord's per-channel permissions.** The bearer token authenticates *who*,
> but every holder can then search everything the bot indexed. Scope the bot's role to channels the
> whole team may read before sharing the endpoint, and verify with `node dist/cli.js channels`.

## Tests

```bash
pnpm seed     # example channels indexed locally, no Discord token needed
pnpm smoke    # drives all four tools over real MCP stdio
```

## Limits

- **Brute-force vector search.** Every window embedding is scanned per semantic query. Fine to roughly
  50k windows (~2.5M messages); past that, move the vectors to sqlite-vec or pgvector.
- **Deletions** are only caught by `sync --full`.
- **Node 24+ required.** `better-sqlite3` is a native module that aborts the process with no output on
  an older ABI, so `cli.js` refuses to start below Node 24. Note that some version managers hand
  `pnpm run` / `npm run` a *different* Node than the one you installed with — if a `pnpm <script>` fails
  the version check, invoke `node dist/cli.js ...` directly.
