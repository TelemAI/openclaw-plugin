// Incremental history transmission, phase 1: an ancestor's context travels ONCE
// per snapshot. Today the same flattened ancestor history is re-sent
// byte-identically on every single call — 82% of this plugin's wire — and the backend is
// first-writer-wins on node content, so every re-send after the first is already
// a no-op.
//
// What makes dropping it safe is PROOF, not byte counting. An ancestor node whose
// FIRST arrival carries no context is stored with a null context frozen forever —
// unrepairable in the Telem backend and in obs, and it empties the conversation title of a
// purely-delegating root. So context is omitted only for a snapshot this process
// has PROVEN delivered and only to a backend that has PROVEN it
// implements the guard. Both proofs are per (baseUrl, key) scope,
// because node ids are derived from the account key server-side: flip either and
// every belief about that world is void.
//
// This module holds the stateless half — the scope, the mode, the refusal
// discriminator and the ONE post-with-retry helper both tools share. The belief
// itself lives beside the other module trackers, in src/trajectory.ts.
import { createHash } from "node:crypto"
import type { HistoryMessage } from "./history.js"

// Snapshot keys are one-way hashes that can never be mapped back to a
// conversation, so idle-eviction is impossible and the cache is bounded by count
// alone (the tracker's MAX_TRACKED_CONVERSATIONS precedent). An eviction
// costs one redundant full re-send — the safe direction.
export const DELIVERED_CAP = 4096
// A process sees one or two scopes in its life. Bounded anyway; forgetting a
// capability just re-learns it from the next response, and until then nothing is
// omitted — again the safe direction.
export const CAPABILITY_CAP = 64

/**
 * Insertion-ordered LRU set: re-adding refreshes recency, and the oldest key is
 * the first one the Map yields. Same idiom as the tracker's `recency` map, minus
 * the end-conversation discipline that one needs.
 */
export function createLruSet(cap: number) {
  const entries = new Map<string, true>()
  return {
    get size(): number {
      return entries.size
    },
    has: (key: string): boolean => entries.has(key),
    add(key: string): void {
      entries.delete(key)
      entries.set(key, true)
      while (entries.size > cap) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
    remove(key: string): void {
      entries.delete(key)
    },
  }
}

/**
 * The cache scope: base url plus the IDENTITY of the api key. The key is HASHED
 * here and nowhere held or logged raw — this string ends up as a Map key, never
 * on the wire and never in a warning.
 */
export function cacheScope(baseUrl: string, apiKey?: string): string {
  return baseUrl + " " + createHash("sha256").update(apiKey ?? "").digest("hex")
}

/**
 * One flat cache keyed by scope AND snapshot, so the LRU bound is a true total
 * and a scope flip simply misses instead of needing its own eviction policy. NUL
 * is not producible by either component (a uuid5 and a hashed url+key).
 */
export function deliveredKey(scope: string, snapshotKey: string): string {
  return scope + "\u0000" + snapshotKey
}

/**
 * Phase 1 is ON by default (owner decision, 2026-08-26 — spec addendum).
 * Read per CALL, like the rest of this plugin's config: flipping it takes effect
 * on the next search, with no gateway restart.
 *
 *   ancestors | (unset)  phase 1: an ancestor's context once per snapshot
 *   off                  the pre-phase-1 wire — the kill switch
 *
 * On by default is safe because the mode is only HALF the gate. Omitting an
 * ancestor context ALSO requires the server-capability probe: this exact
 * (baseUrl, key) scope must already have answered with a `missing_snapshots`
 * key, which only a backend carrying the guard emits. Against an old or
 * third-party backend the probe never fires, so the plugin keeps sending full
 * contexts — byte-identical to the pre-wave plugin — and the default can never
 * strand a node whose context nobody stored. `off` short-circuits the mode half
 * and remains the instant, no-deploy rollback lever the Telem backend's one-way-door checklist
 * depends on.
 *
 * An unrecognized value resolves to the DEFAULT, not to `off`: the rollback
 * lever is the exact word `off` (after trim + lowercase) and nothing else, so an
 * operator reaching for it should verify the value that landed, not the intent.
 * `history` (phase 2, the message_history delta) is NOT implemented on this
 * surface, so it resolves to the default too rather than silently promising a
 * delta this plugin does not compute.
 */
export function incrementalMode(env: NodeJS.ProcessEnv = process.env): "ancestors" | "off" {
  return (env.TELEM_INCREMENTAL ?? "").trim().toLowerCase() === "off" ? "off" : "ancestors"
}

/**
 * NOT a second mode — the differential harness's test-only bypass of the
 * capability probe, never production. Its cache is correct by
 * construction because it drives a backend it built.
 */
export function incrementalForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELEM_INCREMENTAL_FORCE === "1"
}

/**
 * One ancestor entry this call chose not to send the context for. `entry` is the
 * very object inside `metadata.ancestors`, so restoring is a swap on the body
 * that is about to be re-serialized — same node_key, same everything else.
 */
export type OmittedContext = {
  key: string
  entry: Record<string, unknown>
  context: HistoryMessage[]
}

/**
 * Filled in by buildTrajectory: the scope this POST will use, plus — only once
 * the ancestor list is final — the two halves of the ledger. `sentWithContext`
 * is exactly the set a 2xx proves delivered; `omitted` is what this request
 * WITHHELD, kept whole because the guard's 409 asks for exactly it back
 * Bookkeeping that throws leaves both empty, so a degraded call can
 * neither mark a delivery that never went out nor take the retry path.
 */
export type DeliveryPlan = {
  scope: string
  sentWithContext: string[]
  omitted: OmittedContext[]
}

export function newDeliveryPlan(scope: string): DeliveryPlan {
  return { scope, sentWithContext: [], omitted: [] }
}

// ---------------------------------------------------------------------------
// The guard's refusal, in its reject-before-search form. When an omitted snapshot's
// row is missing, the backend refuses the whole request with HTTP 409 BEFORE any
// provider runs, before billing, before an interaction row exists — the Phase B
// transaction rolls back whole, so nothing of the request persisted. The client
// answers by restoring the withheld contexts and re-sending once.
// ---------------------------------------------------------------------------

export const MISSING_SNAPSHOTS = "missing_snapshots"

export type PostResult = { response: Response; detail: string }

/**
 * One POST, with the error body read HERE: the 409 discriminator and the text
 * the tool error carries are the same bytes, and a Response body can only be
 * consumed once.
 */
export async function postOnce(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<PostResult> {
  const response = await doFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  })
  const detail = response.ok ? "" : await response.text().catch(() => "")
  return { response, detail }
}

/**
 * The typed code, from either envelope the two doors use: FastAPI's `detail` on
 * /v1/interactions, the `{"error": {...}}` envelope on /v1/fetch. The
 * bare top-level read is pure defense — a proxy that unwraps, a future door that
 * does not wrap. Undefined means "this body names no code we can read", which
 * includes a body that is not JSON at all.
 */
export function refusalCode(detail: string): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(detail)
  } catch {
    return undefined
  }
  const record = body as { detail?: unknown; error?: unknown } | null
  for (const shape of [record?.detail, record?.error, body]) {
    const code = shape && typeof shape === "object" ? (shape as { code?: unknown }).code : undefined
    if (typeof code === "string" && code) return code
  }
  return undefined
}

/**
 * Is this 409 the guard asking for the contexts back?
 *
 * Two judgement calls, both deliberate, because a defensive parse has to decide
 * what an ambiguous body means:
 *
 *   - NO code readable (unparseable body, a proxy's plain-text 409, an envelope
 *     shape we do not know) => TREAT IT AS THE REFUSAL. The retry is a standard
 *     full request re-sending the same node_keys, so a wrong guess costs one
 *     round trip; guessing the other way costs the user a failed tool call on
 *     the one condition this whole path exists to heal.
 *   - A code that is present and is NOT `missing_snapshots` => NOT the refusal.
 *     The server named a different reason; restoring contexts cannot address it,
 *     and re-POSTing a request it just refused for a stated reason is a blind
 *     retry of a non-idempotent call. Surface it.
 *
 * And the gate above both: the request must have omitted something. A 409 on a
 * request that withheld nothing is somebody else's error.
 */
export function isMissingSnapshotsRefusal(
  status: number,
  detail: string,
  plan: DeliveryPlan,
): boolean {
  if (status !== 409 || !plan.omitted.length) return false
  const code = refusalCode(detail)
  return code === undefined || code === MISSING_SNAPSHOTS
}

/**
 * The POST, plus the single in-call retry the guard's 409 asks for.
 * ONE helper for both tools — a fetch delivers its ancestors through the very
 * same backend handler and can be refused by the very same guard, only through
 * the other error envelope.
 *
 * The retried body is the SAME body object — same node_keys, same
 * message_history, same search block — with `context_omitted` swapped back for
 * `context`. `signal` is threaded through both attempts: an abort between them
 * aborts the retry, exactly as it would have aborted the first send.
 *
 * The plugin's "never retry a search" stance is untouched in substance: a
 * `missing_snapshots` 409 is a PRE-EXECUTION refusal — nothing ran, nothing
 * billed, nothing persisted — so the retry is this call's only execution.
 */
export async function postWithOmissionRetry(params: {
  doFetch: typeof fetch
  url: string
  headers: Record<string, string>
  body: unknown
  delivery: DeliveryPlan
  restore: (delivery: DeliveryPlan) => void
  signal?: AbortSignal
}): Promise<PostResult> {
  const { doFetch, url, headers, body, delivery, restore, signal } = params
  const first = await postOnce(doFetch, url, headers, body, signal)
  if (!isMissingSnapshotsRefusal(first.response.status, first.detail, delivery)) return first
  restore(delivery)
  // Exactly once. `omitted` is now empty, so a second 409 cannot re-enter this
  // branch even in principle — it is surfaced as the tool error like any
  // non-ok, which is the behaviour the guard asks for.
  return await postOnce(doFetch, url, headers, body, signal)
}
