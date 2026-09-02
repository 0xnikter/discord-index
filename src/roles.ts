import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { load as parseYaml } from "js-yaml";

/**
 * Role-scoped access.
 *
 * A single shared token cannot express "cofounders only" - the server sees one identity for every
 * caller. Each role therefore carries its own token, and the role decides which channels its holder
 * can reach. Scoping is applied inside the SQL of every tool, never as a post-filter, so a denied
 * channel cannot leak through a code path that forgot to filter.
 */
/** A tier is a set of Discord categories stored in its own database file. */
export interface Tier {
  name: string;
  categories: string[];
}

export interface Role {
  name: string;
  token: string;
  /** Tier names this role may read. Each maps to one database; unreadable tiers are never opened. */
  tiers: string[];
  /** Category names this role may NOT read. Matched case-insensitively against Discord categories. */
  denyCategories: string[];
  /** Channel names this role may NOT read. */
  denyChannels: string[];
  /** When set, the role may read ONLY these categories (deny lists still apply on top). */
  allowCategories?: string[];
}

export interface Scope {
  role: string;
  /** SQL fragment over an aliased `channels` row, and its bound parameters. */
  sql: string;
  params: string[];
}

export const DEFAULT_TIER = "common";

const FULL_ACCESS: Omit<Role, "token"> = { name: "full", tiers: [DEFAULT_TIER], denyCategories: [], denyChannels: [] };

interface RawRole {
  name?: string;
  tiers?: string[];
  /** Name of the environment variable holding this role's token. Preferred: keeps the file committable. */
  tokenEnv?: string;
  /** Literal token. Discouraged - it makes the policy file a secret. */
  token?: string;
  denyCategories?: string[];
  denyChannels?: string[];
  allowCategories?: string[];
}

interface PolicyDoc {
  roles?: unknown;
  tiers?: unknown;
  exclude?: { categories?: string[]; channels?: string[] };
}

/** Tiers declared in the policy. Anything not claimed by a tier lands in `common`. */
export function loadTiers(env: NodeJS.ProcessEnv = process.env): Tier[] {
  const file = env.POLICY_FILE;
  if (!file) return [];
  const doc = readDoc(file);
  if (doc.tiers === undefined) return [];
  if (!Array.isArray(doc.tiers)) throw new Error(`${file}: "tiers:" must be a list`);
  return doc.tiers.map((entry, i) => {
    const t = entry as Partial<Tier>;
    if (!t.name) throw new Error(`${file}: tiers[${i}] is missing "name"`);
    if (t.name === DEFAULT_TIER) throw new Error(`${file}: "${DEFAULT_TIER}" is reserved for unclaimed channels`);
    if (!Array.isArray(t.categories) || t.categories.length === 0) {
      throw new Error(`${file}: tier "${t.name}" needs at least one category`);
    }
    return { name: t.name, categories: t.categories.map(String) };
  });
}

/** The tier a channel belongs to: the first tier claiming its category, else `common`. */
export function tierForChannel(tiers: Tier[], categoryId: string | null, categoryName: string | null): string {
  const id = categoryId ?? "";
  const name = (categoryName ?? "").toLowerCase();
  for (const tier of tiers) {
    if (tier.categories.some((c) => c === id || c.toLowerCase() === name)) return tier.name;
  }
  return DEFAULT_TIER;
}

function readDoc(path: string): PolicyDoc {
  const raw = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  return (ext === ".yaml" || ext === ".yml" ? parseYaml(raw) : JSON.parse(raw)) as PolicyDoc;
}

function parseRoles(doc: PolicyDoc, path: string, env: NodeJS.ProcessEnv): Role[] {
  if (!Array.isArray(doc.roles)) throw new Error(`${path}: expected a top-level "roles:" list`);

  return doc.roles.map((entry, i) => {
    const r = entry as RawRole;
    if (!r.name) throw new Error(`${path}: roles[${i}] is missing "name"`);
    if (r.tokenEnv && r.token) throw new Error(`${path}: role "${r.name}" sets both token and tokenEnv; pick one`);

    // A role whose token is missing must abort startup. Skipping it would silently deny everyone in
    // that role, and skipping it *permissively* would be far worse.
    const token = r.tokenEnv ? env[r.tokenEnv] : r.token;
    if (r.tokenEnv && token === undefined) {
      throw new Error(`${path}: role "${r.name}" needs ${r.tokenEnv} to be set in the environment`);
    }
    if (!token || token.length < 16) {
      throw new Error(`${path}: role "${r.name}" needs a token of at least 16 characters`);
    }
    // Reading nothing is a configuration mistake, not a valid role; say so rather than serving
    // a role that silently returns no results forever.
    const tiers = r.tiers ?? [DEFAULT_TIER];
    if (tiers.length === 0) throw new Error(`${path}: role "${r.name}" lists no tiers`);
    return {
      name: r.name,
      token,
      tiers,
      denyCategories: r.denyCategories ?? [],
      denyChannels: r.denyChannels ?? [],
      allowCategories: r.allowCategories,
    };
  });
}

/**
 * Policy comes from a file that carries no secrets (tokens are named, not embedded), so it can be
 * committed and reviewed. Falls back to a single full-access token for simple deployments.
 */
/**
 * Index-time exclusions only. Deliberately does NOT resolve role tokens: the sync process needs the
 * exclude rules but must never be handed every role's credentials just to read them.
 */
export function loadExclusions(env: NodeJS.ProcessEnv = process.env): { categories: string[]; channels: string[] } {
  const file = env.POLICY_FILE;
  if (!file) return { categories: [], channels: [] };
  const doc = readDoc(file);
  return { categories: doc.exclude?.categories ?? [], channels: doc.exclude?.channels ?? [] };
}

/** Roles and their tokens. Only the server that answers requests needs these. */
export function loadRoles(env: NodeJS.ProcessEnv = process.env): Role[] {
  const file = env.POLICY_FILE;
  // A policy file with no `roles:` block is valid: it may exist only to carry exclude rules, and
  // the deployment then falls back to the single full-access token.
  if (file) {
    const doc = readDoc(file);
    if (doc.roles !== undefined) return parseRoles(doc, file, env);
  }
  const token = env.MCP_AUTH_TOKEN ?? "";
  return token ? [{ ...FULL_ACCESS, token }] : [];
}

function matches(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/** Resolves a presented bearer token to its role, or null. Constant-time across every candidate. */
export function resolveRole(roles: Role[], presented: string): Role | null {
  let found: Role | null = null;
  for (const role of roles) {
    // No early exit: every role is compared so timing does not reveal which token matched.
    if (matches(role.token, presented)) found = role;
  }
  return found;
}

/**
 * Builds the SQL predicate for a role. `alias` is the aliased channels table.
 * Returns a condition that is always safe to AND into a WHERE clause.
 */
export function scopeFor(role: Role, alias = "c"): Scope {
  const clauses: string[] = [];
  const params: string[] = [];

  // Every rule is matched against the category/channel ID *and* the lowercased name, so an ID rule
  // survives a rename in Discord while a name rule still works before the IDs are looked up.
  const categoryMatch = `(COALESCE(${alias}.category_id, '') = ? OR LOWER(COALESCE(${alias}.category, '')) = ?)`;
  const channelMatch = `(${alias}.id = ? OR LOWER(${alias}.name) = ?)`;

  if (role.allowCategories && role.allowCategories.length > 0) {
    clauses.push(`(${role.allowCategories.map(() => categoryMatch).join(" OR ")})`);
    for (const c of role.allowCategories) params.push(c, c.toLowerCase());
  }
  for (const category of role.denyCategories) {
    clauses.push(`NOT ${categoryMatch}`);
    params.push(category, category.toLowerCase());
  }
  for (const channel of role.denyChannels) {
    clauses.push(`NOT ${channelMatch}`);
    params.push(channel, channel.toLowerCase());
  }

  return { role: role.name, sql: clauses.length > 0 ? clauses.join(" AND ") : "1=1", params };
}

/** The scope used by the stdio transport, which is local and already trusted. */
export const FULL_SCOPE: Scope = { role: "full", sql: "1=1", params: [] };
