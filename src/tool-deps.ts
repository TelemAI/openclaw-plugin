// The host seam shared by every Telem agent tool. Session/transcript access is
// injected by index.ts so the tool modules stay testable without an OpenClaw
// host — and so search and fetch, which are just two kinds of node in the same
// session, are wired from ONE set of closures.
import type { HistoryMessage } from "./history.js"
import type { TelemConfig } from "./config.js"
import type { DeliveryPlan } from "./incremental.js"
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
   *
   * `delivery` is the phase-1 incremental ledger the builder fills in: which
   * ancestor snapshots this request carries FULL context for, and which it
   * withheld (spec 2026-08-24).
   */
  buildTrajectory: (params: {
    nodeKey: string
    kind: string
    delivery: DeliveryPlan
  }) => Promise<TrajectoryPayload>
  /**
   * Proof of delivery, recorded ONLY on a response that came back ok and whose
   * body parsed — never at send time. Also the server-capability probe:
   * `missing_snapshots` present in a 2xx body is what licenses omitting later
   * ONE watermark for both tools, so this is wired from the
   * same tracker for search and fetch.
   */
  recordDelivery: (delivery: DeliveryPlan, body: unknown) => void
  /**
   * The guard's 409 answer: un-mark every key this request omitted and
   * put their full contexts back into the body that is about to be re-sent.
   */
  restoreOmittedContexts: (delivery: DeliveryPlan) => void
  fetchImpl?: typeof fetch
}

/** The text-result envelope OpenClaw agent tools return. */
export type ToolTextResult = {
  content: { type: "text"; text: string }[]
  details: { telem_session_id?: string }
}
