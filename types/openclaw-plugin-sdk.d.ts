// Minimal structural declarations for the OpenClaw plugin SDK subpaths this
// plugin imports. The real modules are resolved by the OpenClaw host (jiti
// aliases them to its dist at load time); these shims only exist so the plugin
// typechecks and unit-tests without an `openclaw` install. Field shapes mirror
// src/plugins/tool-types.ts, src/plugins/hook-types.ts,
// src/config/sessions/types.ts and src/plugin-sdk/session-transcript-runtime.ts
// in the openclaw repo at 2026.7.1 (2d2ddc43d0d) — extend them here if the
// plugin starts using more.
declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawPluginToolContext = {
    config?: unknown
    runtimeConfig?: unknown
    getRuntimeConfig?: () => unknown
    agentId?: string
    /** Routing identity: reused across /new, /reset and idle rotations. */
    sessionKey?: string
    /** Physical generation UUID — regenerated on /new and /reset. */
    sessionId?: string
    sandboxed?: boolean
  }

  /**
   * Structural subset of the lifecycle-hook payloads this plugin consumes
   * (src/plugins/hook-types.ts): session_end events carry {sessionId,
   * sessionKey?, reason?, ...}; subagent_* events carry {childSessionKey?,
   * targetSessionKey?, ...} with the parent linkage in the hook ctx
   * ({requesterSessionKey?}). Neither subagent event carries a message or entry
   * id, which is why the spawn boundary needs a transcript read (plan Task 5).
   */
  export type OpenClawPluginHookEvent = {
    reason?: string
    sessionId?: string
    sessionKey?: string
    childSessionKey?: string
    targetSessionKey?: string
    agentId?: string
    toolName?: string
  }

  export type OpenClawPluginHookResult =
    | void
    | {
        prependSystemContext?: string
        block?: boolean
        blockReason?: string
      }

  export type OpenClawPluginHookContext = {
    sessionKey?: string
    childSessionKey?: string
    requesterSessionKey?: string
  }

  export type OpenClawPluginApi = {
    config: unknown
    pluginConfig?: Record<string, unknown>
    registerTool: (
      tool: unknown | ((ctx: OpenClawPluginToolContext) => unknown),
      opts?: { name?: string; names?: string[]; optional?: boolean },
    ) => void
    /**
     * Typed hook subscription (src/plugins/plugin-api.types.ts) — absent on
     * hosts predating the hook system, so feature-detect before use.
     */
    on?: (
      hookName:
        | "before_prompt_build"
        | "before_tool_call"
        | "session_end"
        | "subagent_spawned"
        | "subagent_ended",
      handler: (
        event: OpenClawPluginHookEvent,
        ctx: OpenClawPluginHookContext,
      ) => OpenClawPluginHookResult | Promise<OpenClawPluginHookResult>,
      opts?: { priority?: number; timeoutMs?: number },
    ) => void
  }

  export function definePluginEntry<
    T extends { id: string; name: string; description?: string; register: (api: OpenClawPluginApi) => void },
  >(definition: T): T
}

declare module "openclaw/plugin-sdk/session-store-runtime" {
  /**
   * One compaction checkpoint (src/config/sessions/types.ts:83). Compaction
   * always appends one; `preCompaction.sessionId === postCompaction.sessionId`
   * (a SELF-LINK) unless the host opted into
   * agents.defaults.compaction.truncateAfterCompaction, in which case the
   * generation really rotated and the link is real.
   */
  export type SessionCompactionTranscriptReference = {
    sessionId?: string
    sessionFile?: string
    leafId?: string
    entryId?: string
  }

  export type SessionCompactionCheckpoint = {
    checkpointId: string
    sessionKey?: string
    sessionId?: string
    createdAt?: number
    reason?: string
    preCompaction?: SessionCompactionTranscriptReference
    postCompaction?: SessionCompactionTranscriptReference
  }

  /**
   * Session-store entry, returned to plugins with NO projection or stripping at
   * 2026.7.1 (session-store-runtime.ts:116 -> session-accessor.ts:938-948).
   * `spawnedBy` is the canonical spawn-parent session key, written before the
   * child's first turn runs; `parentSessionKey` is also set by
   * sessions.compaction.branch, which is a SIBLING conversation rather than a
   * subagent — see the spawned-key gate in index.ts.
   */
  export type SessionStoreEntry = {
    sessionId?: string
    sessionFile?: string
    spawnedBy?: string
    parentSessionKey?: string
    /** ms; when the CURRENT sessionId first became active (types.ts:310). */
    sessionStartedAt?: number
    /** ms; when the session key was first started (types.ts:318). */
    startedAt?: number
    compactionCount?: number
    compactionCheckpoints?: SessionCompactionCheckpoint[]
  }

  /**
   * Absent on hosts predating the storage-neutral session-store API —
   * feature-detect before calling.
   */
  export const getSessionEntry:
    | ((params: { agentId?: string; sessionKey: string }) => SessionStoreEntry | undefined)
    | undefined
}

declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  /**
   * Raw parsed session JSONL rows (unfiltered; includes the session header).
   *
   * `sessionId` alone only ever derives `<sessionId>[-topic-<t>].jsonl`
   * (paths.ts:244-261). Rotated/forked generations are written as
   * `<isoTs>_<sessionId>.jsonl` and are UNREACHABLE without passing the explicit
   * `sessionFile`. A missing file is silent: the read returns [], it does not
   * throw (transcript-stream.ts:36-48).
   */
  export function readSessionTranscriptEvents(params: {
    sessionKey: string
    sessionId: string
    agentId?: string
    sessionFile?: string
  }): Promise<unknown[]>
}
