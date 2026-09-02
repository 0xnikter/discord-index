/**
 * Discord message fetcher.
 *
 * Measured: every channel shares ONE rate-limit bucket at 5 requests/second
 * (x-ratelimit-limit 5 / reset-after 1s), against ~530 ms latency per call. Concurrency hides the
 * latency but cannot raise the ceiling, so the limiter is set just below it.
 */
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://discord.com/api/v10";
/** A Discord call is ~530 ms; anything past this is a dead socket, not a slow response. */
const REQUEST_TIMEOUT_MS = 20_000;

export interface FetchedChannel {
  id: string;
  name: string;
  type: string;
  topic: string | null;
  categoryId: string | null;
  categoryName: string | null;
}

export interface FetchedMessage {
  id: string;
  /** Message this one replies to. Real conversational structure, immune to time gaps. */
  replyTo: string | null;
  timestamp: number;
  editedTimestamp: number | null;
  content: string;
  authorId: string;
  authorName: string;
  attachments: { name: string; url: string }[];
}

/** Numeric channel types we can read message history from. Categories and voice are skipped. */
const TEXTUAL_TYPES = new Set([0, 5, 10, 11, 12, 15]);
/** Discord thread channel types, as stored in `channels.type`. */
export const THREAD_TYPES = new Set(["10", "11", "12"]);
const CATEGORY_TYPE = 4;
/** DEFAULT and REPLY. Everything else is a system notification carrying no searchable knowledge. */
const CONTENT_TYPES = new Set([0, 19]);

/**
 * Token bucket over all requests. Discord bans on sustained *invalid* requests, so the safe play is
 * to stay comfortably under the global ceiling rather than discover it.
 */
class RateLimiter {
  private tokens: number;
  private last = Date.now();

  constructor(private readonly ratePerSecond: number) {
    this.tokens = ratePerSecond;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.ratePerSecond, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000));
    }
  }
}

interface Bucket {
  remaining: number;
  resetAt: number;
}

export class DiscordClient {
  private readonly limiter: RateLimiter;
  private consecutive429 = 0;
  /** route -> bucket hash, learned from x-ratelimit-bucket, and the state of each bucket. */
  private readonly routeBucket = new Map<string, string>();
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly token: string,
    private readonly options: { requestsPerSecond?: number; onWarn?: (msg: string) => void } = {},
  ) {
    this.limiter = new RateLimiter(options.requestsPerSecond ?? 25);
  }

  private warn(msg: string): void {
    this.options.onWarn?.(msg);
  }

  /**
   * `route` is the rate-limit scope Discord groups requests under. Buckets are shared across
   * channels, so honouring the returned headers preemptively is what keeps a parallel run from
   * generating a storm of 429s (which count toward Discord's ban threshold).
   */
  private async request<T>(path: string, route: string): Promise<T | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const hash = this.routeBucket.get(route);
      const bucket = hash ? this.buckets.get(hash) : undefined;
      if (bucket) {
        // Wait out an exhausted bucket instead of spending a 429 to discover it is exhausted.
        const wait = bucket.remaining <= 0 ? bucket.resetAt - Date.now() : 0;
        if (wait > 0) await sleep(wait + 50);
      }

      await this.limiter.take();
      let response: Response;
      try {
        // Without a timeout a silently dropped socket leaves the promise pending forever, which
        // stalls a worker and, with enough workers, the whole run - observed as 0% CPU and no sockets.
        response = await fetch(`${API}${path}`, {
          headers: { authorization: `Bot ${this.token}`, "user-agent": "discord-index (+https://github.com/discord-index)" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name : String(error);
        this.warn(`${path} failed (${reason}), retry ${attempt + 1}/6`);
        await sleep(2 ** attempt * 500);
        continue;
      }

      const bucketHash = response.headers.get("x-ratelimit-bucket");
      const remainingHeader = response.headers.get("x-ratelimit-remaining");
      const resetHeader = response.headers.get("x-ratelimit-reset-after");
      if (bucketHash && remainingHeader !== null && resetHeader !== null) {
        this.routeBucket.set(route, bucketHash);
        this.buckets.set(bucketHash, {
          remaining: Number(remainingHeader),
          resetAt: Date.now() + Number(resetHeader) * 1000,
        });
      }

      if (response.ok) {
        this.consecutive429 = 0;
        return (await response.json()) as T;
      }

      // Missing access is a permission fact about this channel, not a failure of the run.
      if (response.status === 403 || response.status === 404) {
        await response.text().catch(() => "");
        return null;
      }

      if (response.status === 429) {
        this.consecutive429++;
        const retryAfter = Number(response.headers.get("retry-after") ?? "1");
        if (this.consecutive429 > 20) {
          throw new Error("Too many consecutive 429s; lower DISCORD_REQUESTS_PER_SECOND and retry");
        }
        this.warn(`429 on ${path}, waiting ${retryAfter}s`);
        await sleep((retryAfter + 0.5) * 1000);
        continue;
      }

      if (response.status >= 500) {
        await sleep(2 ** attempt * 500);
        continue;
      }

      throw new Error(`Discord ${response.status} on ${path}: ${(await response.text()).slice(0, 200)}`);
    }
    throw new Error(`Gave up on ${path} after repeated failures`);
  }

  async guildName(guildId: string): Promise<string> {
    const guild = await this.request<{ name: string }>(`/guilds/${guildId}`, `guild:${guildId}`);
    if (!guild) throw new Error(`Guild ${guildId} is not reachable by this bot`);
    return guild.name;
  }

  /** Readable channels plus active threads, each resolved to its category. */
  async listChannels(guildId: string, threads: "None" | "Active" | "All"): Promise<FetchedChannel[]> {
    const raw = await this.request<
      { id: string; name: string; type: number; topic?: string | null; parent_id?: string | null }[]
    >(`/guilds/${guildId}/channels`, `guild:${guildId}`);
    if (!raw) throw new Error(`Cannot list channels in guild ${guildId}`);

    const categories = new Map(raw.filter((c) => c.type === CATEGORY_TYPE).map((c) => [c.id, c.name]));
    const byId = new Map(raw.map((c) => [c.id, c]));

    const channels: FetchedChannel[] = raw
      .filter((c) => TEXTUAL_TYPES.has(c.type))
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: String(c.type),
        topic: c.topic ?? null,
        categoryId: c.parent_id ?? null,
        categoryName: c.parent_id ? (categories.get(c.parent_id) ?? null) : null,
      }));

    if (threads === "None") return channels;

    const active = await this.request<{ threads: RawThread[] }>(`/guilds/${guildId}/threads/active`, `guild:${guildId}`);
    const found: RawThread[] = [...(active?.threads ?? [])];

    if (threads === "All") {
      // Archived threads live behind a per-channel endpoint, so "All" costs one request per parent
      // channel on top of the active list.
      for (const parent of channels) {
        const archived = await this.request<{ threads: RawThread[] }>(
          `/channels/${parent.id}/threads/archived/public?limit=100`,
          `threads:${parent.id}`,
        );
        found.push(...(archived?.threads ?? []));
      }
    }

    for (const thread of found) {
      // A thread's category is its parent channel's category.
      const parent = byId.get(thread.parent_id);
      const categoryId = parent?.parent_id ?? null;
      channels.push({
        id: thread.id,
        name: thread.name,
        type: String(thread.type),
        topic: null,
        categoryId,
        categoryName: categoryId ? (categories.get(categoryId) ?? null) : null,
      });
    }
    return channels;
  }

  /**
   * Every message in a channel, oldest first. With `after`, only messages newer than that id, which
   * is what makes an incremental sync cost one request for a quiet channel.
   * Returns null when the channel is not readable by this bot.
   */
  async fetchMessages(channelId: string, after?: string): Promise<{ messages: FetchedMessage[]; truncated: boolean } | null> {
    const collected: FetchedMessage[] = [];
    let reachable = true;

    // Two directions, because the cursor means opposite things:
    //   incremental (`after` given) walks FORWARD from the watermark, newest id each page;
    //   full backfill walks BACKWARD with `before`, oldest id each page, until history runs out.
    // Paging forward without a watermark stops after one page, since the cursor is already the newest.
    let cursor: string | undefined;
    for (;;) {
      const query = after
        ? `&after=${cursor ?? after}`
        : cursor
          ? `&before=${cursor}`
          : "";
      const page = await this.request<RawMessage[]>(`/channels/${channelId}/messages?limit=100${query}`, `messages:${channelId}`);
      if (page === null) {
        reachable = false;
        break;
      }
      if (page.length === 0) break;

      // Discord returns newest first.
      const ordered = [...page].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      for (const m of ordered) {
        if (!CONTENT_TYPES.has(m.type)) continue;
        const content = (m.content ?? "").trim();
        const attachments = (m.attachments ?? []).map((a) => ({ name: a.filename, url: a.url }));
        if (!content && attachments.length === 0) continue;
        collected.push({
          id: m.id,
          replyTo: m.message_reference?.message_id ?? null,
          timestamp: Date.parse(m.timestamp),
          editedTimestamp: m.edited_timestamp ? Date.parse(m.edited_timestamp) : null,
          content,
          authorId: m.author.id,
          authorName: m.author.global_name || m.author.username,
          attachments,
        });
      }

      cursor = after ? ordered[ordered.length - 1].id : ordered[0].id;
      if (page.length < 100) break;
    }

    collected.sort((a, b) => a.timestamp - b.timestamp);
    // A permission change partway through pagination leaves a partial channel. Saying so is the
    // difference between "synced" and "synced what it could reach".
    if (!reachable) return collected.length === 0 ? null : { messages: collected, truncated: true };
    return { messages: collected, truncated: false };
  }
}

interface RawThread {
  id: string;
  name: string;
  type: number;
  parent_id: string;
}

interface RawMessage {
  id: string;
  type: number;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  author: { id: string; username: string; global_name: string | null };
  attachments: { filename: string; url: string }[];
  message_reference?: { message_id?: string } | null;
}

/** Runs `worker` over `items` with bounded concurrency: throughput comes from channel-level fan-out. */
export async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}
