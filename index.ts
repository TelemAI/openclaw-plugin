// Telem plugin entrypoint: registers the telem_search and telem_fetch agent tools. The factory
// captures the per-session tool context; transcript access, session-store access
// and config resolution are wired here so src/ stays host-independent and
// unit-testable.
import { randomUUID } from "node:crypto"
import {
  definePluginEntry,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry"
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime"
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime"
import { resolveTelemConfig } from "./src/config.js"
import { flattenTranscriptEntries } from "./src/history.js"
import { createTelemFetchTool } from "./src/telem-fetch.js"
import { createTelemSearchTool } from "./src/telem-search.js"
import { createTrajectoryTracker, type TrajectoryHost } from "./src/trajectory.js"
import { selectVisibleTranscriptMessages } from "./src/transcript-compat.js"

// The host seam. Both members are total: a session-store read on a host without
// the API, or a transcript read of a file that is gone, must degrade rather than
// throw — bookkeeping may never fail a search.
const host: TrajectoryHost = {
  getEntry: (params) => {
    if (typeof sessionStore.getSessionEntry !== "function") return undefined
    try {
      return sessionStore.getSessionEntry(params)
    } catch {
      return undefined
    }
  },
  readEvents: async (params) => {
    try {
      return await readSessionTranscriptEvents(params)
    } catch {
      // A missing transcript is already silent upstream ([], no throw); this
      // covers the rest. An empty read is treated as TRANSIENT by the caller.
      return []
    }
  },
}

// One tracker per plugin process: OpenClaw loads plugin modules once per gateway
// process and runs parent + subagent turns in that same process, so this state is
// shared across every conversation's tool calls. A cold tracker is not a
// degradation under v5 — identity is derived from the host's own session state,
// so a one-shot CLI run still emits a correct self identity; only the in-memory
// spawn feed is lost, and the durable spawnedBy lookup recovers that.
const trajectories = createTrajectoryTracker(host)

// Host-prompt text, injected as system context on `before_prompt_build`. It is NOT
// pinned by `contract/tool-text.v1.json` (see `profiles.plugin_v5.notes`), so it has to
// be kept in step with the preference paragraph by hand: this text and the tool
// description reach the model in the same context window, and a system prompt arguing
// the retired "multi-provider search router" framing while the tool description argues
// the fan-out one is the plugin contradicting itself where the model can see both.
const TELEM_AGENT_GUIDANCE =
  "When the Telem plugin is enabled, prefer `telem_search` for public-web search. A " +
  "single-index search tool — including a built-in web search — returns one provider's " +
  "view of the web; one `telem_search` call fans out across up to nine providers and " +
  "returns their results provider-attributed in one normalized envelope, so use another " +
  "available search tool only when the user requests it or Telem does not expose the " +
  "required capability. Use `telem_fetch` to read full pages. Do not use OpenClaw's " +
  "built-in `web_search` or `web_fetch`."

const BUILTIN_WEB_TOOL_REPLACEMENTS: Record<string, string> = {
  web_search: "telem_search",
  web_fetch: "telem_fetch",
}

export default definePluginEntry({
  id: "telem",
  name: "Telem",
  description:
    "Telem web search and page fetch tools for OpenClaw.",
  register(api) {
    // Hooks are feature-detected so older hosts still expose the tools. On a
    // supported host, static system guidance steers the model toward Telem before
    // tool selection, and the call guard prevents fallback to OpenClaw's exact
    // built-in web tools. Other third-party tools remain available. Both hooks
    // disappear with the plugin runtime, so no persistent tools.deny mutation
    // needs to be reverted.
    if (typeof api.on === "function") {
      api.on("before_prompt_build", async () => ({
        prependSystemContext: TELEM_AGENT_GUIDANCE,
      }))
      api.on(
        "before_tool_call",
        (event) => {
          const replacement = BUILTIN_WEB_TOOL_REPLACEMENTS[event?.toolName ?? ""]
          if (typeof replacement !== "string") return
          return {
            block: true,
            blockReason: `Telem is enabled; use ${replacement} instead of ${event.toolName}.`,
          }
        },
        { priority: 100 },
      )

      // Lineage feed. Without these lifecycle hooks the durable spawnedBy
      // lookup still recovers parentage at call time; only automatic cleanup
      // and the eager spawn-boundary capture are lost.
      // subagent_spawned carries no message or entry id, so the spawn boundary
      // needs a transcript read. It runs inside recordSpawn under a timeout with
      // no retry, AFTER the chain has already been bound — a slow or failed read
      // leaves a partial descriptor, never a missing one.
      api.on(
        "subagent_spawned",
        (event, ctx) => {
          const child = ctx?.childSessionKey ?? event?.childSessionKey
          const parent = ctx?.requesterSessionKey
          if (typeof child !== "string" || typeof parent !== "string") return
          return trajectories.recordSpawn(child, parent, {
            ...(event?.agentId ? { agentId: event.agentId } : {}),
          })
        },
        { timeoutMs: 5000 },
      )
      // session_end fires per physical generation; every reason EXCEPT compaction
      // ends the logical conversation under that key. Compaction continues it —
      // and on a stock 2026.7.1 host does not even rotate the sessionId — so
      // lineage and the fingerprint must survive it. Ending also blocks the
      // durable store from re-deriving lineage against whatever conversation the
      // reused key hosts next.
      api.on("session_end", (event, ctx) => {
        if (event?.reason === "compaction") return
        const key = ctx?.sessionKey ?? event?.sessionKey
        if (typeof key === "string") trajectories.endConversation(key)
      })
      // subagent_ended is deliberately NOT a cleanup trigger: it fires per
      // completed child RUN, not per deletion, so clearing there would strand a
      // finished orchestrator's still-running children and re-root a revived
      // mode:"session" child mid-conversation. One-shot child keys are reclaimed
      // by session_end (reason "deleted") or the tracker's LRU cap.
    }

    api.registerTool(
      (ctx: OpenClawPluginToolContext) => {
        // Identity-less runs (sandboxed one-shots) get a per-factory id so every
        // call still derives a valid, self-consistent v5 identity.
        const synthetic = randomUUID()
        const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? synthetic
        const sessionId = ctx.sessionId ?? ctx.sessionKey ?? synthetic
        // One deps object for both tools: a fetch and a search are two kinds of
        // node in the SAME session, so they must read the same transcript and
        // derive the same identity.
        const deps = {
          getConfig: () =>
            resolveTelemConfig(
              ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config ?? api.config,
            ),
          readHistory: async (currentToolCallId: string) => {
            // OpenClaw persists the in-flight assistant message before dispatching
            // tools, so this read already includes the current turn — including
            // the toolCall that triggered this very call. Without a session
            // identity (one-shot sandboxed runs) history is skipped rather than
            // failing the call.
            if (!ctx.sessionKey || !ctx.sessionId) return []
            const events = await host.readEvents({
              sessionKey: ctx.sessionKey,
              sessionId: ctx.sessionId,
              ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
            })
            // An empty SELF read yields an empty message_history and the search
            // proceeds (unlike an ancestor read, where empty means "retry later").
            return flattenTranscriptEntries(selectVisibleTranscriptMessages(events), {
              currentToolCallId,
            })
          },
          buildTrajectory: ({ nodeKey, kind }: { nodeKey: string; kind: string }) =>
            trajectories.buildTrajectory({
              sessionKey,
              sessionId,
              ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
              nodeKey,
              kind,
            }),
        }
        return [createTelemSearchTool(deps), createTelemFetchTool(deps)]
      },
      { names: ["telem_search", "telem_fetch"] },
    )
  },
})
