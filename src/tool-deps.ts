// The host seam shared by every Telem agent tool. Session/transcript access is
// injected by index.ts so the tool modules stay testable without an OpenClaw
// host — and so search and fetch, which are just two kinds of node in the same
// session, are wired from ONE set of closures.
import type { HistoryMessage } from "./history.js"
import type { TelemConfig } from "./config.js"
import type { TrajectoryPayload } from "./trajectory.js"

export type TelemToolDeps = {
  getConfig: () => TelemConfig
  // Reads the current session's flattened history; currentToolCallId marks this
  // call's own toolCall entry as "running" in the forwarded trace.
  readHistory: (currentToolCallId: string) => Promise<HistoryMessage[]>
  /**
   * The v5 identity + lineage payload for one node. `kind` is threaded rather
   * than hard-coded so search and fetch share one builder.
   * Contractually total: bookkeeping degrades, it never throws (see
   * src/trajectory.ts).
   */
  buildTrajectory: (params: { nodeKey: string; kind: string }) => Promise<TrajectoryPayload>
  fetchImpl?: typeof fetch
}

/** The text-result envelope OpenClaw agent tools return. */
export type ToolTextResult = {
  content: { type: "text"; text: string }[]
  details: { telem_session_id?: string }
}
