import { appendFileSync } from "node:fs";

/**
 * Append-only record of every tool call.
 *
 * With a shared team token the server cannot attribute a call to a person, only to a role - so this
 * is a forensic trail ("what was pulled, by which role, from where"), not accountability. Per-user
 * tokens would be needed for the latter.
 */
export interface AuditEntry {
  tool: string;
  role: string;
  ip: string;
  args: Record<string, unknown>;
  resultCount?: number;
  error?: string;
}

const AUDIT_PATH = process.env.AUDIT_LOG_PATH ?? "";

export function audit(entry: AuditEntry): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  // stdout is reserved for the stdio JSON-RPC framing, so audit goes to stderr, which journald and
  // `docker logs` collect.
  process.stderr.write(`[audit] ${line}\n`);
  if (!AUDIT_PATH) return;
  try {
    appendFileSync(AUDIT_PATH, `${line}\n`);
  } catch (error) {
    // A failed audit write must be visible but must not take the server down.
    process.stderr.write(`[audit] WRITE FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** Trims argument values so a long query cannot bloat the log, while staying useful for forensics. */
export function auditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    out[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  return out;
}
