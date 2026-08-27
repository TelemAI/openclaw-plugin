// The PRIMARY history path. OpenClaw 2026.7.1 exposes only the raw session JSONL
// rows (readSessionTranscriptEvents); the branch-aware message projection
// (readVisibleSessionTranscriptMessageEntries) does not exist there, so the
// visible branch is selected plugin-side.
//
// This is a faithful port of the host's own tree semantics, not an
// approximation: scanSessionTranscriptTree + selectSessionTranscriptTreePathNodes
// from src/config/sessions/transcript-tree.ts at 2d2ddc43d0d. Porting rather
// than paraphrasing is deliberate — two earlier paraphrase divergences silently
// truncated or mis-branched history:
//   1. Invalid leaf controls (a `leaf` row addressing an unknown target) are
//      TRANSPARENT structural markers upstream: they change no navigation state
//      but stay in `byId` so descendants parented on them repair through their
//      raw parent. Dropping them truncated every entry appended after one.
//   2. Stale-parent normalization: after a side-branch append the raw append
//      cursor points into the side branch, so a canonical row whose parentId
//      equals that cursor must be reparented onto the active leaf.
//
// The plan's alternative — calling the host's SessionManager.getBranch through
// openclaw/plugin-sdk/agent-sessions — was not taken: getBranch is an instance
// method over a file the transcript SDK deliberately does not hand out
// (readSessionTranscriptEvents "resolves identity without returning its file
// path"), and routing through it would make the walk untestable in this
// package's hermetic suite. Porting gives the same semantics under unit test.
export type VisibleTranscriptMessage = { role: string; message: unknown }

/** One node on the selected path, in root-first order. */
export type TranscriptPathEntry = {
  id: string
  /** Duck-typed role of the persisted message row; absent for non-message rows. */
  role?: string
  /** The persisted AgentMessage, for message rows. */
  message?: unknown
  /** Row timestamp in epoch ms, when the row carries a parseable one. */
  timestampMs?: number
}

type TranscriptRecord = Record<string, unknown>

type TreeEntry = {
  id: string
  parentId: string | null
  leafId: string | null | undefined
  appendParentId: string | null
  appendMode?: "side"
}

type TreeNode = TreeEntry & { event: TranscriptRecord; index: number }

type Tree = {
  byId: Map<string, TreeNode>
  leafId: string | null
  hasLeafControl: boolean
}

function isRecord(value: unknown): value is TranscriptRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function isCanonicalEntryType(value: unknown): boolean {
  switch (value) {
    case "message":
    case "thinking_level_change":
    case "model_change":
    case "compaction":
    case "branch_summary":
    case "custom":
    case "custom_message":
    case "label":
    case "session_info":
      return true
    default:
      return false
  }
}

function isCanonicalEntry(record: unknown): record is TranscriptRecord & { type: string } {
  return isRecord(record) && isCanonicalEntryType(record.type)
}

function isLeafControl(record: unknown): record is TranscriptRecord & { type: "leaf" } {
  return isRecord(record) && record.type === "leaf" && parseTreeEntry(record) !== undefined
}

/**
 * Parse one parent-linked transcript row. `leaf` rows are navigation controls:
 * they select targetId as the active leaf, and descendants that reference the
 * marker continue through that same target.
 */
function parseTreeEntry(record: unknown): TreeEntry | undefined {
  if (!isRecord(record) || record.type === "session" || !Object.hasOwn(record, "parentId")) {
    return undefined
  }
  const id = readNonEmptyString(record.id)
  const parentId =
    record.parentId === null ? null : (readNonEmptyString(record.parentId) ?? undefined)
  if (!id || parentId === undefined) return undefined

  if (record.type === "leaf") {
    const targetId =
      record.targetId === null ? null : (readNonEmptyString(record.targetId) ?? undefined)
    const appendParentId =
      record.appendParentId === undefined
        ? targetId
        : record.appendParentId === null
          ? null
          : (readNonEmptyString(record.appendParentId) ?? undefined)
    // `null` here means "present but not a recognised value" -> the whole row is
    // unparseable, distinct from `undefined` ("absent", i.e. a normal control).
    const appendMode =
      record.appendMode === undefined ? undefined : record.appendMode === "side" ? "side" : null
    return targetId === undefined || appendParentId === undefined || appendMode === null
      ? undefined
      : {
          id,
          parentId: targetId,
          leafId: targetId,
          appendParentId,
          ...(appendMode ? { appendMode } : {}),
        }
  }

  return {
    id,
    parentId,
    leafId: isCanonicalEntry(record) && record.appendMode !== "side" ? id : undefined,
    appendParentId: id,
    ...(record.appendMode === "side" ? { appendMode: "side" as const } : {}),
  }
}

/** Rows written by older appenders carry no parentId; they continue the cursor. */
function parseParentlessCanonicalEntry(
  record: unknown,
  parentId: string | null,
): TreeEntry | undefined {
  if (!isCanonicalEntry(record) || Object.hasOwn(record, "parentId")) return undefined
  const id = readNonEmptyString(record.id)
  if (!id) return undefined
  return {
    id,
    parentId,
    leafId: record.appendMode === "side" ? undefined : id,
    appendParentId: id,
    ...(record.appendMode === "side" ? { appendMode: "side" as const } : {}),
  }
}

/**
 * Leaf controls are omitted from selected paths, so a descendant pointing at one
 * must be re-pointed through the marker to its normalized visible parent.
 */
function resolveCanonicalParentId(
  parentId: string | null,
  byId: ReadonlyMap<string, TreeNode>,
): string | null {
  const seen = new Set<string>()
  let currentId = parentId
  while (currentId !== null) {
    if (seen.has(currentId)) return currentId
    seen.add(currentId)
    const parent = byId.get(currentId)
    if (!parent || !isLeafControl(parent.event)) return currentId
    currentId = parent.parentId
  }
  return null
}

/** Resolve transcript navigation state in file order (port of the host's scan). */
function scanTranscriptTree(events: readonly unknown[]): Tree {
  const byId = new Map<string, TreeNode>()
  let leafId: string | null = null
  let appendParentId: string | null = null
  let hasLeafControl = false
  const invalidLeafControlIds = new Set<string>()

  let index = -1
  for (const event of events ?? []) {
    index += 1
    if (!isRecord(event)) continue
    const explicitTreeEntry = parseTreeEntry(event)
    const isKnownLeafReference = (id: string | null): boolean =>
      id === null || (byId.has(id) && !invalidLeafControlIds.has(id))
    const invalidLeafControl =
      explicitTreeEntry?.leafId !== undefined &&
      isLeafControl(event) &&
      (!isKnownLeafReference(explicitTreeEntry.leafId) ||
        !isKnownLeafReference(explicitTreeEntry.appendParentId))
    if (invalidLeafControl && explicitTreeEntry) {
      invalidLeafControlIds.add(explicitTreeEntry.id)
      const rawParentId = (event.parentId ?? null) as string | null
      // Invalid controls are transparent structural markers. Descendants can
      // repair through their raw parent, but navigation state does not change.
      byId.set(explicitTreeEntry.id, {
        ...explicitTreeEntry,
        parentId: rawParentId,
        leafId: undefined,
        appendParentId,
        event,
        index,
      })
      continue
    }

    let treeEntry: TreeEntry | undefined =
      explicitTreeEntry ?? parseParentlessCanonicalEntry(event, leafId)
    if (treeEntry && isCanonicalEntry(event)) {
      // The raw cursor can belong to plugin metadata, an inactive branch, or an
      // omitted leaf marker. Keep physical append state separate from the
      // visible ancestry consumed by context builders.
      const logicalParentId =
        explicitTreeEntry &&
        treeEntry.appendMode !== "side" &&
        treeEntry.parentId === appendParentId &&
        leafId !== appendParentId
          ? leafId
          : treeEntry.parentId
      const normalizedParentId = resolveCanonicalParentId(logicalParentId, byId)
      if (normalizedParentId !== treeEntry.parentId) {
        treeEntry = { ...treeEntry, parentId: normalizedParentId }
      }
    }
    if (!treeEntry) continue

    byId.set(treeEntry.id, { ...treeEntry, event, index })
    appendParentId = treeEntry.appendParentId
    if (treeEntry.leafId !== undefined) leafId = treeEntry.leafId
    if (isLeafControl(event)) hasLeafControl = true
  }

  return { byId, leafId, hasLeafControl }
}

function toPathEntry(node: TreeNode): TranscriptPathEntry {
  const message = node.event.message
  const role = isRecord(message) ? readNonEmptyString(message.role) : undefined
  const rawTimestamp = node.event.timestamp ?? node.event.createdAt
  const parsed = typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : rawTimestamp
  const timestampMs = typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined
  return {
    id: node.id,
    ...(role ? { role, message } : {}),
    ...(timestampMs !== undefined ? { timestampMs } : {}),
  }
}

/**
 * Select the path from the root down to `targetEntryId` (default: the active
 * leaf), root-first, with leaf-control markers omitted.
 *
 * Two host behaviours are reproduced verbatim: a cycle yields an EMPTY path (not
 * a truncated one), and a missing ancestor retains the reachable suffix rather
 * than discarding it — real transcripts routinely reference a parent that lives
 * in a previous generation's file.
 */
export function selectTranscriptPathTo(
  events: readonly unknown[],
  targetEntryId?: string,
): TranscriptPathEntry[] {
  const tree = scanTranscriptTree(events)
  const startId = targetEntryId ?? tree.leafId

  if (!startId) {
    // No navigable entries at all. A tree-managed transcript (one that carried a
    // leaf control) genuinely has nothing selected; otherwise fall back to file
    // order so a legacy/degenerate transcript still yields its messages.
    if (tree.hasLeafControl) return []
    const flat: TranscriptPathEntry[] = []
    for (const event of events ?? []) {
      if (!isRecord(event) || event.type !== "message") continue
      const id = readNonEmptyString(event.id)
      const message = event.message
      const role = isRecord(message) ? readNonEmptyString(message.role) : undefined
      if (!id || !role) continue
      flat.push(toPathEntry({ id, parentId: null, leafId: id, appendParentId: id, event, index: 0 }))
    }
    return flat
  }

  const path: TranscriptPathEntry[] = []
  const seen = new Set<string>()
  let currentId: string | null = startId
  while (currentId) {
    if (seen.has(currentId)) return []
    seen.add(currentId)
    const current = tree.byId.get(currentId)
    if (!current) break
    if (!isLeafControl(current.event)) path.unshift(toPathEntry(current))
    currentId = current.parentId
  }
  return path
}

/** The visible message rows of the active branch, in the host's own order. */
export function selectVisibleTranscriptMessages(
  events: readonly unknown[],
): VisibleTranscriptMessage[] {
  const out: VisibleTranscriptMessage[] = []
  for (const entry of selectTranscriptPathTo(events)) {
    if (entry.role) out.push({ role: entry.role, message: entry.message })
  }
  return out
}

/**
 * The last ASSISTANT entry on a selected path — the spawn boundary (plan Task 5).
 * MUST be assistant, not last-of-any-role: a queued or steering user message
 * appended to a blocked ancestor must not move the boundary.
 *
 * `atOrBeforeMs` bounds the search for descriptors whose boundary was not
 * captured at spawn time; entries with no parseable timestamp are only accepted
 * when no bound is given.
 */
export function findSpawnBoundaryEntry(
  path: readonly TranscriptPathEntry[],
  atOrBeforeMs?: number,
): TranscriptPathEntry | undefined {
  let found: TranscriptPathEntry | undefined
  for (const entry of path) {
    if (entry.role !== "assistant") continue
    if (atOrBeforeMs !== undefined) {
      if (entry.timestampMs === undefined || entry.timestampMs > atOrBeforeMs) continue
    }
    found = entry
  }
  return found
}
