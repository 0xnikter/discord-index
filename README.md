# discord-index

**Every message your team ever sent, searchable in about a second, from inside Claude.**

Stop asking "didn't we discuss this somewhere?". Ask the question in plain
language and get the actual conversation back, with links.

```
you:  what did we decide about switching the queue backend?

→  #engineering, 14 Mar
   ada:   redis is dropping jobs under load, we lose ~2% on spikes
   grace: SQS then? we already pay for it
   ada:   yes, and it gives us the retry semantics for free
   (+ the surrounding messages, with jump links)
```

Measured on a real 3 year old server, not estimated:

| | |
|---|---|
| **59,000 messages** | indexed across 371 channels |
| **0.2 ms** | to search the index itself |
| **~1 second** | end to end, almost all of it one API call to turn your question into a vector |
| **$0.11** | one time cost to build the whole index |
| **5 minutes** | how far behind it ever gets |
| **$0 and 0.2 ms** | if you skip embeddings: keyword search only, nothing leaves your machine |

It finds things you cannot grep for. Ask *"someone was unhappy about waiting too
long"* and it returns a complaint about load times that shares not one word with
your question.

## How it works, in one paragraph

It does **not** search Discord when you ask a question. It keeps its own copy.

A background job downloads your server's message history into a local SQLite
database, then re-syncs every 5 minutes to pick up whatever is new. Your
questions are answered from that local index, so a search takes milliseconds and
touches Discord not at all.

```
Discord API ──(every 5 min)──▶ SQLite index ──(instant)──▶ your question
```

## Why it has to work that way

Discord's message search endpoint is closed to bots. A bot can only page through
history, 100 messages at a time, one channel at a time.

That is why every "search my Discord" MCP server you have tried is useless: at
query time they can read you the last few messages in a channel and nothing
more. Finding where something was discussed is out of reach.

Keeping a local index removes the limit entirely. It costs one slow first
backfill, then a few seconds every 5 minutes to stay current.

## What leaves your network, and what gets stored

Worth reading before you point this at a company server.

* **Message text is sent to OpenAI** to be turned into embeddings. That is what
  makes meaning-based search work. **Leave `OPENAI_API_KEY` empty and nothing
  leaves your machine**: search falls back to keywords only, and says so in
  every result.
* **The index stores** message text, author name and id, timestamps, edits, and
  attachment metadata. Search is attributed, so "what did Sam say about X" is a
  normal query for anyone holding a token.
* **DMs are never indexed.** The bot only ever sees server channels and threads.
* **The bot sees exactly what its Discord role sees.** Restricting it there is
  the strongest control you have, and it costs nothing.
* **Deleted messages stay searchable** until the next `sync --full`. The
  incremental sync cannot detect a deletion.
* **Write your `exclude:` rules before the first sync.** A first run with no
  `--since` fetches the whole server history and embeds all of it. Adding an
  exclusion later purges the index, but cannot un-send anything to OpenAI.
* **Every tool call is logged** with role, client IP, arguments, and result
  count. Set `AUDIT_LOG_PATH` to keep that in a file.

## What makes the answers useful

**It returns conversations, not matching lines.** A hit that reads *"yeah let's
do that"* tells you nothing without the messages around it. Each result is
assembled using Discord's own structure, in order of how reliable that structure
is:

1. **Reply chains.** Discord records these explicitly, so they survive any gap
   in time. A reply three days later is still the same conversation.
2. **The whole thread**, when the hit is inside one.
3. **Neighbouring messages**, because most people just post the next message
   without hitting reply.

Results from the same discussion are merged into one, and every message is
tagged `matched: true` or `false`, so the model can tell the hit from the
context around it.

**Two kinds of search at once.** Keyword search (SQLite FTS5) finds exact
strings: error text, ticket numbers, library names. Embedding search finds
meaning: *"someone was unhappy about waiting too long"* will surface a complaint
about load times that shares no words with your question. The two rankings are
combined with Reciprocal Rank Fusion, so scores from the two very different
systems never have to be compared directly.

**A stale index says so.** Every result carries a freshness block, and an index
that has fallen behind reports it instead of quietly answering from old data.

## The four tools

| Tool | What it does |
|---|---|
| `search_messages` | Search. Returns conversations with jump links. Pass `context: wide` for a whole discussion. |
| `get_context` | Messages around a given id, to read further. |
| `list_channels` | What is indexed, with message counts. |
| `sync_status` | Totals, embedding coverage, freshness, last run and any error. |

## Step 1: create the Discord bot

This takes about five minutes and is the fiddliest part of the setup. Do it
before touching the code.

**Create the application**

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and click **New Application**. Name it anything.
2. Open the **Bot** tab, click **Reset Token**, and copy the token. It is shown once. This is your `DISCORD_TOKEN`.

**Turn on the one intent that matters**

3. Still on the **Bot** tab, scroll to **Privileged Gateway Intents** and enable **Message Content Intent**. Save.

   This is not optional. Without it Discord returns your message history with
   every `content` field empty, and the sync stops with an error. You do not
   need Server Members Intent or Presence Intent.

**Invite the bot with the narrowest possible permissions**

4. Open **OAuth2 → URL Generator**.
5. Under **Scopes**, tick **`bot`** only. Leave `applications.commands` unticked.
6. Under **Bot Permissions**, tick exactly two boxes:
   * **View Channels** (under General Permissions)
   * **Read Message History** (under Text Permissions)

   Tick nothing else. Never tick **Administrator**: it overrides per channel
   restrictions, so the bot would see every private channel on the server.
7. Copy the generated URL at the bottom, open it, and pick your server. You need
   the Manage Server permission to do this.

**Optional but recommended: take away its ability to post**

   Server permissions are the union of every role the bot holds, and `@everyone`
   usually grants Send Messages. So the bot can post, even though you never
   ticked that box. Guild level permissions cannot be removed, only channel
   level ones can. On each category you give it access to, add a permission
   overwrite for the bot's role that **denies** Send Messages, Add Reactions, and
   Create Threads. This tool never writes to Discord, but a permission it does
   not hold cannot be misused at all.

**Get your server id**

8. In Discord: **Settings → Advanced → Developer Mode** on. Then right click your
   server icon and choose **Copy Server ID**. This is your `DISCORD_GUILD_ID`.

**Decide what it can read**

9. The bot sees every channel `@everyone` can see. Private channels that deny
   `@everyone` stay invisible unless you explicitly add the bot's role to them.
   Before the first sync, go through your channel list and deny the bot's role
   anywhere it should not read: HR, finance, anything quoting credentials.

   After the first sync, `node dist/cli.js channels` prints exactly what it
   reached. That listing is the real audit, so check it.

## Step 2: run it

**Node 24 or newer, and pnpm.** `better-sqlite3` crashes with no error message on
older versions, so the CLI refuses to start below 24. Note that some version
managers hand `pnpm run` a different Node than the one you installed with. If a
script trips the version check, call `node dist/cli.js` directly.

```bash
pnpm install
pnpm build
cp .env.example .env      # fill in DISCORD_TOKEN, DISCORD_GUILD_ID, OPENAI_API_KEY
```

First backfill. Start bounded, so you see the result in minutes rather than
hours:

```bash
node dist/cli.js sync --since 2026-06-01
node dist/cli.js channels          # check what the bot actually reached
```

Connect it to Claude Code:

```bash
claude mcp add discord-index -- node $PWD/dist/cli.js serve
```

Start a new session and ask it something. From then on a sync runs in the
background and the index stays current.

No Discord bot yet? See the whole thing work on example data first, no account
needed:

```bash
pnpm install && pnpm build && pnpm seed && pnpm smoke
```

## Deploying for a team

**Anywhere with Docker.** Three containers: the MCP server, a sync loop, and
Caddy for TLS.

```bash
cp .env.example .env
openssl rand -hex 32          # generate a token
```

Now edit `.env` and set two values. Edit them in place rather than appending, or
you end up with two copies of the same key and different tools disagree about
which one wins:

| Variable | Value |
|---|---|
| `SITE_ADDRESS` | your hostname, for example `mcp.your-domain.com`. Leave it empty and Caddy serves **plain HTTP**, sending your token across the wire in the clear. |
| `MCP_AUTH_TOKEN` | the token you just generated. The server refuses to start over HTTP without one. |

```bash
docker compose up -d --build
```

DNS for `SITE_ADDRESS` must already point at the box. Caddy requests a Let's
Encrypt certificate for it on the first request.

**On AWS.** [`deploy/aws/cloudformation.yaml`](deploy/aws/cloudformation.yaml)
provisions a Graviton instance, roughly $20 a month with the default
`t4g.small`, volume, and Elastic IP. It requires you to restrict port 443 to
your own address range or a CDN's, so nobody can reach the origin directly. It
also sets up an encrypted volume, IMDSv2, SSH closed in favour of SSM Session
Manager, automatic security updates, a non root container, and secrets pulled
from Secrets Manager at boot rather than baked into user data.

Either way, teammates connect with one command:

```bash
claude mcp add --transport http discord-index https://your.host/mcp \
  -H "Authorization: Bearer $TOKEN"
```

## Controlling who sees what

Access rules live in a YAML file that contains **no secrets**. Tokens are
referenced by environment variable name, so the file belongs in version control,
where a change to who can read what gets reviewed like any other change.

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
    tiers: [common, leadership]    # one search across both, results merged
```

Each tier is a **separate database file**. A role that cannot read a tier never
opens that file, so a mistake in some future query cannot leak it: the data is
not in anything that process has open. Inside a tier, `denyCategories` and
`allowCategories` narrow further, applied inside the SQL of every tool rather
than filtered afterwards.

Rules match Discord **ids** as well as names. Prefer ids. Renaming a category in
Discord silently stops a name based rule from matching, which quietly widens
access.

Three levels of strictness, strongest first:

| Setting | Meaning |
|---|---|
| `exclude:` | **Never indexed.** Not in any database, so nothing can reach it. Adding a rule also deletes whatever was already stored. |
| Tier a role cannot read | **Stored, in a file that process never opens.** |
| `denyCategories` | **Stored and open, filtered out of every query.** |

## Costs and limits

**Embeddings are the only thing you pay for.** `text-embedding-3-small` at $0.02
per million tokens. Indexing 59,000 messages costs about **$0.11**. Incremental
syncs only re-embed what changed, so a quiet 5 minute cycle costs nothing. With
no `OPENAI_API_KEY` the cost is zero and search stays keyword only.

**Rate limits.** Every channel shares a single Discord bucket, measured at 5
requests per second, so running more requests in parallel hides latency but
cannot raise the ceiling. An incremental pass is about one request per channel.
The interval is measured from the end of the previous run, so syncs never
overlap, and a single writer lock covers manual runs and container restarts.

**Scale.** Semantic search scores every window vector in memory, cached per
process. Comfortable up to roughly 50,000 windows, about 2.5 million messages.
Past that, move the vectors to sqlite-vec or pgvector.

**Deletions** are only reconciled by `sync --full`, since the incremental cursor
cannot see them. Nothing automates it. Schedule it if deleted content genuinely
has to disappear.

**No backups.** The index can be rebuilt by re-syncing, which is why there is no
backup story, but losing the volume costs you a full backfill and re-embed.

**A shared token cannot be revoked for one person.** Issuing one role per person
is supported today, one `tokenEnv` each, and is what you want if people leave.

## Ideas, bugs, "why does it do that"

Open an issue, or find me at [@0xnick__](https://x.com/0xnick__). Genuinely
interested in what breaks and what is missing, especially from anyone running it
against a server shaped differently from mine.

## License

MIT.
