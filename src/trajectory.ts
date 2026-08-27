// Trajectory v5 for OpenClaw: context-window sessions owned by the plugin.
// Ported from the opencode plugin (the sibling plugin) and adapted to
// OpenClaw's split identity — a `sessionKey` that is REUSED across /new, /reset
// and idle rotations, and a `sessionId` that names one physical generation.
// The model never threads a session id; every identity here is derived.
//
// Design: the design notes,
// plan the design notes.
//
// The premise that shapes this module: on a stock 2026.7.1 host compaction does
// NOT rotate the sessionId — rotation is opt-in behind
// agents.defaults.compaction.truncateAfterCompaction
// (compaction-successor-transcript.ts:33-35). Compaction still appends a
// checkpoint either way, so `latestCompactionCheckpointId` is the only component
// that moves `session_key` on a stock host, and the seed walk terminates on hop
// one because every checkpoint is a self-link.
//
// This module is host-independent: all session-store and transcript access goes
// through the injected TrajectoryHost so it unit-tests without an OpenClaw host.
import { createHash } from "node:crypto"
import { flattenTranscriptEntries } from "./history.js"
import { findSpawnBoundaryEntry, selectTranscriptPathTo } from "./transcript-compat.js"

// ---------------------------------------------------------------------------
// Identity primitives (plan Task 2)

export const HARNESS_ID = "openclaw"
/** Fixed UUID namespace for every client-side uuid5, shared across harnesses —
 * HARNESS_ID is what separates them. Never changes. */
export const NS_TRAJECTORY = "443866ab-1b45-5ed8-979e-52fdad07b810"
/** Sentinel for a missing key component (a generation with no compaction yet). */
export const NONE = "none"

export function sha256hex(x: string): string {
  return createHash("sha256").update(x).digest("hex")
}

/**
 * Length-prefix a variable component so concatenation is injective even when a
 * component itself contains ":" — "12:foo:bar" can never collide with "3:foo" +
 * "3:bar". Applied to every component of every uuid5 name and hashed name.
 */
export function lp(s: string): string {
  return String(Buffer.byteLength(s, "utf8")) + ":" + s
}

/**
 * uuid5 (RFC 4122 v5, sha1-based): sha1(namespace_bytes ++ utf8(name)), first 16
 * bytes with the version nibble set to 5 and the variant bits to 0b10.
 */
export function uuid5(namespace: string, name: string): string {
  const nsb = Buffer.from(namespace.replace(/-/g, ""), "hex")
  const hash = createHash("sha1").update(nsb).update(Buffer.from(name, "utf8")).digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // variant 0b10
  const x = b.toString("hex")
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

/**
 * fingerprint = H(lp(harness) + lp(logicalSeed)): the stable per-conversation
 * token. It hashes the RAW seed (only the hash leaves the machine) and includes
 * the harness so ids from different harnesses never collide.
 */
export function fingerprint(logicalSeed: string): string {
  return sha256hex(lp(HARNESS_ID) + lp(logicalSeed))
}

/**
 * session_key: the deterministic identity of ONE context-window generation.
 *
 *   uuid5(NS, lp(harness) + lp(H(seed)) + lp(H(physical)) + lp(checkpoint|none))
 *
 * The checkpoint component is mandatory, not defensive: with rotation off it is
 * the ONLY component that moves the key on compaction (the physical id and the
 * seed both stay put). Session ids are hashed inside the uuid5 name; checkpoint
 * ids are not — the same rule opencode uses for compaction part ids.
 */
export function sessionKeyOf(params: {
  logicalSeed: string
  physicalSessionId: string
  latestCheckpointId: string
}): string {
  return uuid5(
    NS_TRAJECTORY,
    lp(HARNESS_ID) +
      lp(sha256hex(params.logicalSeed)) +
      lp(sha256hex(params.physicalSessionId)) +
      lp(params.latestCheckpointId),
  )
}

/**
 * snapshot_node_key: the id of an ancestor's spawn-point snapshot, keyed on the
 * ancestor's GENERATION and the entry it spawned at. The lp("snap") tag keeps it
 * in a different space from that generation's own session_key, and the shared
 * derivation means parallel children spawned at the same entry agree on it
 * without any coordination.
 */
export function snapshotNodeKey(physicalSessionId: string, boundaryEntryId: string): string {
  return uuid5(
    NS_TRAJECTORY,
    lp(HARNESS_ID) + lp(sha256hex(physicalSessionId)) + lp(boundaryEntryId) + lp("snap"),
  )
}

// ---------------------------------------------------------------------------
// Host seam

/** One compaction checkpoint, as persisted on the session entry. */
export type CompactionCheckpoint = {
  checkpointId?: string
  createdAt?: number
  preCompaction?: { sessionId?: string; sessionFile?: string }
  postCompaction?: { sessionId?: string; sessionFile?: string }
}

/** Structural subset of SessionEntry this module reads. */
export type SessionSnapshot = {
  sessionId?: string
  sessionFile?: string
  spawnedBy?: string
  parentSessionKey?: string
  sessionStartedAt?: number
  startedAt?: number
  compactionCheckpoints?: CompactionCheckpoint[]
}

export type TranscriptReadParams = {
  sessionKey: string
  sessionId: string
  agentId?: string
  sessionFile?: string
}

/**
 * Everything this module needs from the host. Both members MUST NOT throw —
 * index.ts wraps the SDK calls — but every call site still guards, because
 * bookkeeping may never fail a search.
 */
export type TrajectoryHost = {
  getEntry: (params: { sessionKey: string; agentId?: string }) => SessionSnapshot | undefined
  readEvents: (params: TranscriptReadParams) => Promise<unknown[]>
}

// ---------------------------------------------------------------------------
// Logical seed (plan Task 3)

/**
 * The newest checkpoint id on an entry, or NONE. "Newest" is by persisted
 * createdAt, with later array position breaking ties — checkpoints are appended
 * in order, so that is the host's own ordering.
 */
export function latestCheckpointId(checkpoints?: readonly CompactionCheckpoint[]): string {
  let best: CompactionCheckpoint | undefined
  for (const cp of checkpoints ?? []) {
    if (typeof cp?.checkpointId !== "string" || !cp.checkpointId) continue
    if (!best || (cp.createdAt ?? 0) >= (best.createdAt ?? 0)) best = cp
  }
  return best?.checkpointId ?? NONE
}

/**
 * Resolve the logical seed: the id the conversation started life under.
 *
 * ONE algorithm for both host configurations — `truncateAfterCompaction` is
 * never read. The config says what the NEXT compaction will do; the checkpoint
 * chain records what actually happened, and the flag can be toggled
 * mid-conversation. The walk self-configures:
 *   - rotation off -> every checkpoint is a self-link -> no non-self link exists
 *     -> the walk terminates on hop one -> seed = the current id, which is
 *     correct precisely because the id never moved;
 *   - rotation on  -> real links -> the walk follows them back to the origin.
 *
 * Determinism rule: several checkpoints can share a postCompaction.sessionId
 * (e.g. `SID-1 --cp1(on)--> SID-2 --cp2,cp3(off, self-links)-->`). Taking
 * whichever match came first would let two searches in the SAME generation
 * resolve different seeds and the fingerprint would flip back and forth instead
 * of settling. So at each hop: ignore self-links whenever a non-self link exists
 * at that cursor, and follow the newest non-self link. Stop when none remains —
 * the cursor is then the origin.
 *
 * Toggling truncateAfterCompaction mid-conversation is NOT a supported scenario;
 * this rule exists for stability, not to support it. The behaviour it produces
 * is a one-time re-root followed by stability — the same class of degradation as
 * the ~25-checkpoint retention limit.
 *
 * Never take the earliest array entry: /new PRESERVES the old chain, and only
 * link-following stops correctly at the new unlinked id.
 */
export function resolveLogicalSeed(
  physicalSessionId: string,
  checkpoints?: readonly CompactionCheckpoint[],
  memo?: Map<string, string>,
): string {
  const memoized = memo?.get(physicalSessionId)
  if (memoized) return memoized

  const list = checkpoints ?? []
  const walked = [physicalSessionId]
  const visited = new Set<string>([physicalSessionId])
  let cursor = physicalSessionId

  for (;;) {
    let hop: CompactionCheckpoint | undefined
    for (const cp of list) {
      if (cp?.postCompaction?.sessionId !== cursor) continue
      const pre = cp.preCompaction?.sessionId
      if (typeof pre !== "string" || !pre || pre === cursor) continue // self-link
      if (!hop || (cp.createdAt ?? 0) >= (hop.createdAt ?? 0)) hop = cp
    }
    const next = hop?.preCompaction?.sessionId
    if (!next) break
    // A memo hit past a since-trimmed origin: hop back one checkpoint instead of
    // re-walking a chain whose head no longer exists.
    const resolved = memo?.get(next)
    if (resolved) {
      cursor = resolved
      break
    }
    if (visited.has(next)) break // corrupted chain; never loop
    visited.add(next)
    walked.push(next)
    cursor = next
  }

  // Every id on the walked path resolves to the same origin, so memoizing them
  // all keeps a later generation's answer stable after the chain is trimmed.
  for (const id of walked) memo?.set(id, cursor)
  return cursor
}

export type SelfIdentity = {
  physicalSessionId: string
  logicalSeed: string
  fingerprint: string
  sessionKey: string
}

/** Derive one generation's full identity from its session entry. */
export function resolveIdentity(params: {
  entry?: SessionSnapshot
  fallbackSessionId: string
  memo?: Map<string, string>
}): SelfIdentity {
  const physicalSessionId = params.entry?.sessionId || params.fallbackSessionId
  const checkpoints = params.entry?.compactionCheckpoints
  const logicalSeed = resolveLogicalSeed(physicalSessionId, checkpoints, params.memo)
  return {
    physicalSessionId,
    logicalSeed,
    fingerprint: fingerprint(logicalSeed),
    sessionKey: sessionKeyOf({
      logicalSeed,
      physicalSessionId,
      latestCheckpointId: latestCheckpointId(checkpoints),
    }),
  }
}

// ---------------------------------------------------------------------------
// Ancestor descriptors (plan Task 5)

/**
 * The BOUNDARY of an ancestor's spawn, captured once; the CONTENT is materialized
 * at search time. What makes that safe at 2026.7.1 is that transcripts are
 * append-only and entry ids are immutable — NOT that rewrites rotate the id
 * (they do not). (parentPhysicalSessionId, parentSessionFile, spawnAssistantEntryId)
 * therefore pins exactly one immutable prefix.
 *
 * The identity fields are frozen VALUES, never recomputed: recomputing later
 * would read the parent's CURRENT checkpoint and file the ancestor under the
 * wrong generation. The seed is frozen rather than the fingerprint — same
 * guarantee, one fewer derived value, and debuggable.
 *
 * The boundary fields are the one exception to immutability: a partial
 * descriptor (the spawn-time transcript read timed out) fills them in ONCE, at
 * the first search that resolves the boundary, and never overwrites them
 * afterwards — so the boundary cannot drift as the parent keeps talking.
 */
export type AncestorDescriptor = {
  agentId?: string
  parentSessionKey: string
  parentPhysicalSessionId: string
  /** REQUIRED to reach a rotated generation (`<isoTs>_<sessionId>.jsonl`). */
  parentSessionFile?: string
  /** Frozen; the fingerprint derives from it. */
  logicalSeed: string
  /** Frozen; generation-scoped, must not drift. */
  sessionKey: string
  snapshotNodeKey?: string
  spawnAssistantEntryId?: string
  spawnedAt: string | null
  /** Fallback boundary when the spawn-time read failed: ms since epoch. */
  childStartedAt?: number
}

// Spawned children are keyed `agent:<agentId>:subagent:<uuid>` (or acp:); only
// those can have a spawn parent, so other keys skip the store read entirely.
// This gate is also what keeps a `sessions.compaction.branch` target out of the
// recovery path: branch writes parentSessionKey on an operator-chosen key, and
// that key is a SIBLING conversation, not a subagent.
const SPAWNED_KEY_RE = /^agent:[^:]+:(subagent|acp):/

// Safety net for conversations the host never reports as ended: once the tracker
// follows more than this many, the least-recently-touched is forgotten. A
// forgotten conversation degrades exactly like a plugin restart — it re-derives
// lineage from the durable store, bounded by the child's own start timestamp.
const MAX_TRACKED_CONVERSATIONS = 4096
// Ended-key memory bounding the stale-recovery guard; evicting an ancient entry
// only re-opens the guard for children of a rotation that old, which are gone.
const MAX_ENDED_KEYS = 8192
// The spawn hook carries no message id, so the boundary needs a transcript read.
// It runs under this budget with NO retry: a partial descriptor resolved later
// from childStartedAt is strictly better than a slow hook.
const SPAWN_BOUNDARY_TIMEOUT_MS = 2000

function isoOrNull(ms?: number): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export type TrajectoryPayload = {
  session_key: string
  fingerprint: string
  node_key: string
  kind: string
  parent_node_key: string | null
  ancestors: Record<string, unknown>[]
}

export function createTrajectoryTracker(host: TrajectoryHost) {
  // child conversation -> its root-first ancestor descriptor chain. Chains are
  // descriptors, not contexts: the content is materialized per search.
  const chainOf = new Map<string, AncestorDescriptor[]>()
  // Conversations that ended at least once. A durable spawnedBy hit naming one
  // of these describes the key's NEXT conversation, not this child's actual
  // parent, so recovery must refuse it.
  const endedKeys = new Set<string>()
  const recency = new Map<string, true>() // LRU order for MAX_TRACKED_CONVERSATIONS
  // physical sessionId -> resolved logical seed. Keyed by PHYSICAL id so /new
  // stays correct: a fresh id has no entry, walks, finds no link, seeds to itself.
  const seedMemo = new Map<string, string>()

  function safeGetEntry(sessionKey: string, agentId?: string): SessionSnapshot | undefined {
    try {
      return host.getEntry({ sessionKey, ...(agentId ? { agentId } : {}) })
    } catch {
      return undefined
    }
  }

  function touch(conversation: string): void {
    recency.delete(conversation)
    recency.set(conversation, true)
    if (recency.size <= MAX_TRACKED_CONVERSATIONS) return
    const oldest = recency.keys().next().value
    if (oldest === undefined) return
    // Eviction follows endConversation's discipline: dropping only the evicted
    // key's own chain would leave the durable store free to re-derive it against
    // whatever conversation the key hosts next.
    end(oldest)
  }

  function end(conversation: string): void {
    chainOf.delete(conversation)
    recency.delete(conversation)
    endedKeys.add(conversation)
    if (endedKeys.size > MAX_ENDED_KEYS) {
      const oldestEnded = endedKeys.values().next().value
      if (oldestEnded !== undefined) endedKeys.delete(oldestEnded)
    }
  }

  /** Freeze one ancestor descriptor from the parent's live entry. */
  function describeParent(params: {
    parentSessionKey: string
    entry?: SessionSnapshot
    fallbackSessionId?: string
    agentId?: string
    childStartedAt?: number
  }): AncestorDescriptor | undefined {
    const physical = params.entry?.sessionId || params.fallbackSessionId
    if (!physical) return undefined
    const identity = resolveIdentity({
      ...(params.entry ? { entry: params.entry } : {}),
      fallbackSessionId: physical,
      memo: seedMemo,
    })
    return {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      parentSessionKey: params.parentSessionKey,
      parentPhysicalSessionId: identity.physicalSessionId,
      ...(params.entry?.sessionFile ? { parentSessionFile: params.entry.sessionFile } : {}),
      logicalSeed: identity.logicalSeed,
      sessionKey: identity.sessionKey,
      spawnedAt: null,
      ...(params.childStartedAt !== undefined ? { childStartedAt: params.childStartedAt } : {}),
    }
  }

  /**
   * Reload recovery: rebuild a chain from persisted state when the tracker never
   * witnessed the spawn (plugin loaded mid-session, or the gateway restarted).
   * Produces the SAME descriptor shape as the live path, so both routes emit
   * identical ancestor objects.
   */
  function recoverChain(
    conversation: string,
    agentId: string | undefined,
    visited: Set<string>,
  ): AncestorDescriptor[] {
    const cached = chainOf.get(conversation)
    if (cached) return cached
    if (visited.has(conversation)) return [] // cyclic spawnedBy; never loop
    visited.add(conversation)
    if (!SPAWNED_KEY_RE.test(conversation)) return []

    const childEntry = safeGetEntry(conversation, agentId)
    const parentKey = childEntry?.spawnedBy ?? childEntry?.parentSessionKey
    if (typeof parentKey !== "string" || !parentKey) return []
    if (endedKeys.has(parentKey) || visited.has(parentKey)) return []

    const parentEntry = safeGetEntry(parentKey, agentId)
    // Entry failure stops THIS branch: without the parent's generation there is
    // nothing to freeze, and guessing would file the ancestor wrongly.
    if (!parentEntry?.sessionId) return []

    const descriptor = describeParent({
      parentSessionKey: parentKey,
      entry: parentEntry,
      ...(agentId ? { agentId } : {}),
      // sessionStartedAt is the tighter boundary — when the CURRENT sessionId
      // first became active — and falls back to the key's overall start.
      ...(childEntry?.sessionStartedAt !== undefined
        ? { childStartedAt: childEntry.sessionStartedAt }
        : childEntry?.startedAt !== undefined
          ? { childStartedAt: childEntry.startedAt }
          : {}),
    })
    if (!descriptor) return []

    const chain = [...recoverChain(parentKey, agentId, visited), descriptor]
    chainOf.set(conversation, chain) // freeze, so later searches stay identical
    touch(conversation)
    return chain
  }

  function ancestorsOf(conversation: string, agentId?: string): AncestorDescriptor[] {
    const known = chainOf.get(conversation)
    if (known) {
      touch(conversation)
      return known
    }
    try {
      return recoverChain(conversation, agentId, new Set())
    } catch {
      return [] // lineage must never fail a search
    }
  }

  /**
   * Resolve the transcript file for one ancestor generation, in the order the
   * plan fixes: the frozen descriptor -> the parent entry's file when the entry
   * is still on that generation -> the checkpoint chain's postCompaction file
   * for that id -> omit (which derives `<sessionId>.jsonl`, correct for the
   * first generation only). Rotated generations are `<isoTs>_<sessionId>.jsonl`
   * and are unreachable without this.
   */
  function resolveAncestorFile(d: AncestorDescriptor): string | undefined {
    if (d.parentSessionFile) return d.parentSessionFile
    const entry = safeGetEntry(d.parentSessionKey, d.agentId)
    if (entry?.sessionId === d.parentPhysicalSessionId && entry?.sessionFile) return entry.sessionFile
    let best: CompactionCheckpoint | undefined
    for (const cp of entry?.compactionCheckpoints ?? []) {
      if (cp?.postCompaction?.sessionId !== d.parentPhysicalSessionId) continue
      if (!cp.postCompaction.sessionFile) continue
      if (!best || (cp.createdAt ?? 0) >= (best.createdAt ?? 0)) best = cp
    }
    return best?.postCompaction?.sessionFile
  }

  /**
   * The ONE shared materializer — used identically by live and reload-recovered
   * descriptors. Returns undefined for any transient failure; the caller omits
   * the ancestor and nulls across the hole rather than floating to a grandparent.
   */
  async function materialize(
    d: AncestorDescriptor,
  ): Promise<{ key: string; entry: Record<string, unknown> } | undefined> {
    const sessionFile = resolveAncestorFile(d)
    let events: unknown[]
    try {
      events = await host.readEvents({
        sessionKey: d.parentSessionKey,
        sessionId: d.parentPhysicalSessionId,
        ...(d.agentId ? { agentId: d.agentId } : {}),
        ...(sessionFile ? { sessionFile } : {}),
      })
    } catch {
      return undefined
    }
    // An empty result is AMBIGUOUS: a missing file returns [] silently
    // (transcript-stream.ts:36-48). Treat it as a transient materialization
    // failure — omit and retry next search — never as an empty context.
    if (!Array.isArray(events) || events.length === 0) return undefined

    let boundaryId = d.spawnAssistantEntryId
    let boundaryAt = d.spawnedAt
    if (!boundaryId) {
      const active = selectTranscriptPathTo(events)
      const boundary = findSpawnBoundaryEntry(active, d.childStartedAt)
      if (!boundary) return undefined
      boundaryId = boundary.id
      boundaryAt = isoOrNull(boundary.timestampMs)
      // Fill the boundary in ONCE so the parent's later turns cannot move it.
      d.spawnAssistantEntryId = boundaryId
      d.spawnedAt = boundaryAt
      d.snapshotNodeKey = snapshotNodeKey(d.parentPhysicalSessionId, boundaryId)
    }

    const path = selectTranscriptPathTo(events, boundaryId)
    if (path.length === 0) return undefined // boundary not in this generation

    const key = d.snapshotNodeKey ?? snapshotNodeKey(d.parentPhysicalSessionId, boundaryId)
    return {
      key,
      entry: {
        session_key: d.sessionKey,
        fingerprint: fingerprint(d.logicalSeed),
        node_key: key,
        parent_node_key: null,
        context: flattenTranscriptEntries(
          path.filter((e) => e.role !== undefined).map((e) => ({ role: e.role, message: e.message })),
        ),
        // When the delegation actually happened, from the spawn entry's own
        // harness timestamp — not the backend row's created_at, which only says
        // "when the first descendant reported".
        spawned_at: boundaryAt ?? null,
      },
    }
  }

  /**
   * Best-effort boundary capture at spawn time. Runs under a hard timeout with
   * no retry; on failure the descriptor stays partial and a later search
   * resolves the boundary from childStartedAt instead.
   */
  async function resolveSpawnBoundary(d: AncestorDescriptor, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const sessionFile = resolveAncestorFile(d)
      // Swallow a late rejection here rather than in the outer catch: once the
      // timeout wins the race this promise is abandoned, and an abandoned
      // rejection would surface as an unhandled rejection in the gateway.
      const read = host
        .readEvents({
          sessionKey: d.parentSessionKey,
          sessionId: d.parentPhysicalSessionId,
          ...(d.agentId ? { agentId: d.agentId } : {}),
          ...(sessionFile ? { sessionFile } : {}),
        })
        .catch(() => undefined)
      const events = await Promise.race([
        read,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs)
          timer.unref?.()
        }),
      ])
      if (!Array.isArray(events) || events.length === 0) return
      const boundary = findSpawnBoundaryEntry(selectTranscriptPathTo(events))
      if (!boundary) return
      d.spawnAssistantEntryId = boundary.id
      d.spawnedAt = isoOrNull(boundary.timestampMs)
      d.snapshotNodeKey = snapshotNodeKey(d.parentPhysicalSessionId, boundary.id)
    } catch {
      // Partial descriptor: childStartedAt still pins the boundary later.
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    /**
     * Feed from the host's subagent_spawned hook. Binds the chain SYNCHRONOUSLY
     * (so lineage exists even if the boundary read never returns), then resolves
     * the spawn boundary under a timeout with no retry. Real-time truth: it
     * overrides any previously recovered chain, because a spawn observed after a
     * key rotated belongs to the key's CURRENT conversation.
     */
    recordSpawn(
      child: string,
      parent: string,
      opts?: { agentId?: string; timeoutMs?: number; now?: number },
    ): Promise<void> {
      const agentId = opts?.agentId
      const parentEntry = safeGetEntry(parent, agentId)
      const descriptor = describeParent({
        parentSessionKey: parent,
        ...(parentEntry ? { entry: parentEntry } : {}),
        ...(agentId ? { agentId } : {}),
        childStartedAt: opts?.now ?? Date.now(),
      })
      if (!descriptor) return Promise.resolve()

      const parentChain = chainOf.get(parent) ?? recoverChain(parent, agentId, new Set())
      chainOf.set(child, [...parentChain, descriptor])
      touch(child)

      return resolveSpawnBoundary(descriptor, opts?.timeoutMs ?? SPAWN_BOUNDARY_TIMEOUT_MS)
    },

    /**
     * Release a conversation once it is truly over (deletion, /new, /reset, idle
     * or daily rotation — NOT compaction, which continues the conversation, and
     * NOT subagent run completion, which fires per completed run). Frozen chains
     * that already point AT this conversation are kept: they describe the
     * generation that really spawned those children and cannot be grafted. What
     * ending blocks is re-derivation: the reused key's NEXT conversation must
     * never be adopted as a parent. Idempotent.
     */
    endConversation(conversation: string): void {
      end(conversation)
    },

    /** The frozen (or reload-recovered) ancestor chain, root-first. */
    ancestorsOf,

    /**
     * The v5 wire payload for one search/fetch node. Never throws: identity
     * failure degrades to a best-effort self key, lineage failure to
     * `parent_node_key: null` with no ancestors.
     */
    async buildTrajectory(req: {
      sessionKey: string
      sessionId: string
      agentId?: string
      nodeKey: string
      kind: string
    }): Promise<TrajectoryPayload> {
      const fallbackSessionId = req.sessionId || req.sessionKey
      let identity: SelfIdentity
      try {
        const entry = safeGetEntry(req.sessionKey, req.agentId)
        identity = resolveIdentity({
          ...(entry ? { entry } : {}),
          fallbackSessionId,
          memo: seedMemo,
        })
      } catch {
        // Seed = the current sessionId, markers NONE: still a valid self identity.
        identity = {
          physicalSessionId: fallbackSessionId,
          logicalSeed: fallbackSessionId,
          fingerprint: fingerprint(fallbackSessionId),
          sessionKey: sessionKeyOf({
            logicalSeed: fallbackSessionId,
            physicalSessionId: fallbackSessionId,
            latestCheckpointId: NONE,
          }),
        }
      }

      const payload: TrajectoryPayload = {
        session_key: identity.sessionKey,
        fingerprint: identity.fingerprint,
        node_key: req.nodeKey,
        kind: req.kind,
        parent_node_key: null,
        ancestors: [],
      }

      try {
        const chain = ancestorsOf(req.sessionKey, req.agentId)
        if (!chain.length) return payload
        const materialized = await Promise.all(chain.map((d) => materialize(d)))
        const ancestors: Record<string, unknown>[] = []
        for (let i = 0; i < materialized.length; i++) {
          const current = materialized[i]
          if (!current) continue
          // NULL across a hole; never skip up to a surviving grandparent.
          const previous = i > 0 ? materialized[i - 1] : undefined
          current.entry.parent_node_key = i === 0 ? null : (previous?.key ?? null)
          ancestors.push(current.entry)
        }
        // The search node's parent is the DIRECT parent's snapshot specifically.
        const direct = materialized[materialized.length - 1]
        payload.parent_node_key = direct?.key ?? null
        payload.ancestors = ancestors
      } catch {
        // Lineage failure: a valid root search, never a failed one.
        payload.parent_node_key = null
        payload.ancestors = []
      }
      return payload
    },
  }
}

export type TrajectoryTracker = ReturnType<typeof createTrajectoryTracker>
