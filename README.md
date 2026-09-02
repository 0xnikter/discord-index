# discord-index

**Search your team's whole Discord from inside Claude, in about a second.**

```
you:  what did we decide about switching the queue backend?

→  #engineering, 14 Mar
   ada:   redis is dropping jobs under load, we lose ~2% on spikes
   grace: SQS then? we already pay for it
   ada:   yes, and it gives us the retry semantics for free
   (+ the surrounding messages, with jump links)
```

It searches by meaning, not just words. Ask *"someone was unhappy about waiting
too long"* and it finds a complaint about load times that shares no word with
your question.

## How it works

It does not query Discord when you ask. It keeps its own copy.

A background job downloads your message history into a local SQLite database and
re-syncs on a schedule, every 5 minutes in the deployment below. Questions are
answered from that index.

```
Discord API ──(every 5 min)──▶ SQLite index ──(instant)──▶ your question
```

It has to work this way: Discord's search endpoint is closed to bots. A bot can
only page through history 100 messages at a time, one channel at a time, which
is why every other "search my Discord" tool can only read you the last few
messages in a channel.

Results are whole conversations, not isolated lines. Each hit is expanded using
reply chains, the surrounding thread, and neighbouring messages, so *"yeah let's
do that"* arrives with the context that makes it mean something.

Measured on a real 3 year old server: **59,000 messages** across **371
channels**, **$0.11** to build the index, **~1 second** per search.

Message text is sent to OpenAI to create the embeddings. The index stores message
content, author, and timestamps. DMs are never touched.

## Tools

| Tool | Does |
|---|---|
| `search_messages` | Search. Returns conversations with jump links. |
| `get_context` | Messages around a given id. |
| `list_channels` | What is indexed. |
| `sync_status` | Totals, freshness, last error. |

## Step 1: create the Discord bot

**Create it**

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy it. Shown once. This is `DISCORD_TOKEN`.

**Enable the one intent that matters**

3. Same tab → **Privileged Gateway Intents** → enable **Message Content Intent** → Save.

   Without it Discord returns your history with every message body empty and the
   sync fails. You do not need the other two intents.

**Invite it**

4. **OAuth2 → URL Generator**.
5. Scopes: tick **`bot`** only.
6. Bot Permissions: tick exactly **View Channels** and **Read Message History**.

   Nothing else. Never **Administrator**: it overrides per channel restrictions,
   so the bot would read every private channel you have.
7. Open the generated URL, pick your server. Needs Manage Server.

**Optionally stop it posting**

   `@everyone` usually grants Send Messages, and server level permissions are the
   union of every role, so the bot can post even though you never ticked it. Only
   channel overwrites can take that back: on each category, deny Send Messages
   for the bot's role.

**Get the server id**

8. Discord **Settings → Advanced → Developer Mode** on, right click the server
   icon, **Copy Server ID**. This is `DISCORD_GUILD_ID`.

**Decide what it reads**

9. The bot sees every channel `@everyone` can see. Private channels stay hidden
   unless you add its role. Deny it anywhere it should not read before you sync.

## Try it without a Discord bot

Generated example data, so you can see what a result looks like before setting
anything up. No Discord token needed, and no OpenAI key either (it falls back to
keyword-only search and says so):

```bash
pnpm install && pnpm build
pnpm seed          # writes example channels, then indexes them
pnpm smoke         # runs every tool against that index
```

## Step 2: run it

Needs **Node 24+** and **pnpm**. `better-sqlite3` crashes silently on older Node,
so the CLI refuses to start below 24.

```bash
pnpm install
pnpm build
cp .env.example .env      # DISCORD_TOKEN, DISCORD_GUILD_ID, OPENAI_API_KEY (optional)
```

Build the index, starting bounded so you see results in minutes:

```bash
node dist/cli.js sync --since 2026-06-01
node dist/cli.js channels          # confirm what the bot actually reached
```

That is a one-time sync. Re-run it to refresh, or use the deployment below,
which does it on a timer.

Connect it:

```bash
claude mcp add discord-index -- node $PWD/dist/cli.js serve
```

Start a new Claude session and ask it something.

## Deploying for a team

Three containers: the MCP server, a sync loop, and Caddy for TLS.

```bash
cp .env.example .env
openssl rand -hex 32          # generate a token
```

Edit `.env` in place, do not append, or you get duplicate keys and tools
disagree about which wins:

| Variable | Value |
|---|---|
| `SITE_ADDRESS` | your hostname. Leave it empty and Caddy serves plain HTTP, sending your token in the clear. |
| `MCP_AUTH_TOKEN` | the token you generated. The server will not start over HTTP without one. |

```bash
docker compose up -d --build
```

DNS must already point at the box; Caddy gets a certificate on first request.
Then everyone connects with:

```bash
claude mcp add --transport http discord-index https://your.host/mcp \
  -H "Authorization: Bearer $TOKEN"
```

For AWS, [`deploy/aws/cloudformation.yaml`](deploy/aws/cloudformation.yaml) gives
you the same thing on a ~$20/month instance, with the origin locked to your own
address range so the endpoint cannot be reached directly.

## Who sees what

Access rules live in a YAML file holding **no secrets**, so it belongs in version
control. Tokens are named, not embedded.

```yaml
tiers:
  - name: leadership
    categories: ["1234567890"]     # Discord category id

roles:
  - name: team
    tokenEnv: MCP_TOKEN_TEAM
    tiers: [common]                # never opens the leadership database
  - name: leadership
    tokenEnv: MCP_TOKEN_LEADERSHIP
    tiers: [common, leadership]    # one search across both
```

Each tier is a separate database file. A role that cannot read a tier never opens
it, so a future bug cannot leak what is not in any open file. Match on ids rather
than names: renaming a category silently stops a name rule from matching.

`exclude:` is stronger still. Anything matching it is never indexed at all, and
adding a rule deletes whatever was already stored. Write those rules before your
first sync.

## Notes

* `sync --full` weekly. The incremental sync cannot see deletions.
* Semantic search holds every vector in memory. Fine to ~50,000 windows, roughly
  2.5M messages. Past that, move to sqlite-vec or pgvector.
* Discord rate limits every channel through one bucket at 5 requests/second, so
  parallelism hides latency but cannot raise the ceiling.

## Ideas and bugs

Open an issue or find me at [@0xnick__](https://x.com/0xnick__).

MIT.
