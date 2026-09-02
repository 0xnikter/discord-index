/**
 * Per-IP sliding-window limiter.
 *
 * A 256-bit bearer token is not brute-forceable, so this is not credential defence. It bounds two
 * things that are real: an unthrottled client (or attacker) burning CPU and disk on every request,
 * and abuse of a token that has leaked into a shell history, a screenshot, or a committed config.
 */

const AUTH_FAILURES_PER_WINDOW = 10;
const AUTH_FAILURE_WINDOW_MS = 5 * 60_000;
const REQUESTS_PER_WINDOW = 300;
const REQUEST_WINDOW_MS = 60_000;
/** Bound the map so a spray of forged X-Forwarded-For values cannot grow it without limit. */
const MAX_TRACKED_IPS = 10_000;

type Window = { hits: number[]; };
const requests = new Map<string, Window>();
const failures = new Map<string, Window>();

function record(store: Map<string, Window>, key: string, windowMs: number): number {
  const now = Date.now();
  // Evict a single oldest entry. Clearing the whole map let one caller flood it with forged
  // X-Forwarded-For values to wipe everyone else's counters, including their own lockout.
  if (store.size > MAX_TRACKED_IPS) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  const entry = store.get(key) ?? { hits: [] };
  entry.hits = entry.hits.filter((t) => now - t < windowMs);
  entry.hits.push(now);
  store.set(key, entry);
  return entry.hits.length;
}

function retryAfter(store: Map<string, Window>, key: string, windowMs: number): number {
  const oldest = store.get(key)?.hits[0];
  return oldest === undefined ? Math.ceil(windowMs / 1000) : Math.max(1, Math.ceil((oldest + windowMs - Date.now()) / 1000));
}

/**
 * Client address. Behind the bundled Caddy the socket peer is the proxy, so X-Forwarded-For is the
 * only way to tell clients apart — but it is client-controlled, so it is trusted only when the
 * deployment says a proxy is in front.
 */
export function clientIp(headers: Record<string, string | string[] | undefined>, socketAddr: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    // The LAST hop is the one the trusted proxy appended. Earlier entries are client-supplied and
    // forgeable, so keying on the first would let one caller mint unlimited identities.
    const hops = raw?.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops && hops.length > 0) return hops[hops.length - 1];
  }
  return socketAddr ?? "unknown";
}

export function checkRequest(ip: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  if (record(requests, ip, REQUEST_WINDOW_MS) > REQUESTS_PER_WINDOW) {
    return { allowed: false, retryAfterSeconds: retryAfter(requests, ip, REQUEST_WINDOW_MS) };
  }
  return { allowed: true };
}

/** Called on a rejected token. Repeated failures lock the IP out for the rest of the window. */
export function recordAuthFailure(ip: string): void {
  record(failures, ip, AUTH_FAILURE_WINDOW_MS);
}

export function isLockedOut(ip: string): { locked: false } | { locked: true; retryAfterSeconds: number } {
  const entry = failures.get(ip);
  if (!entry) return { locked: false };
  const now = Date.now();
  const recent = entry.hits.filter((t) => now - t < AUTH_FAILURE_WINDOW_MS);
  if (recent.length < AUTH_FAILURES_PER_WINDOW) return { locked: false };
  return { locked: true, retryAfterSeconds: retryAfter(failures, ip, AUTH_FAILURE_WINDOW_MS) };
}
