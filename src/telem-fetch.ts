// telem_fetch agent tool, trajectory v5: one POST /v1/fetch per call,
// reading up to FETCH_MAX_URLS pages as ONE interaction. A fetch is just another
// event node in the same conversation as a search — same session identity, same
// lineage, only the declared `kind` differs. The PLUGIN owns the session; the
// model never sees or threads a Telem session id.
import { randomUUID } from "node:crypto"
import { Type } from "typebox"
import { formatFetchResults } from "./format.js"
import { cacheScope, newDeliveryPlan, postWithOmissionRetry } from "./incremental.js"
import type { TelemToolDeps, ToolTextResult } from "./tool-deps.js"
import { maybeNotifyClientUpdate } from "./update-advisory.js"

// Client-side mirror of the server's web_fetch_max_urls default. The server's
// 400s stay the authority; validating here only saves the round trip.
export const FETCH_MAX_URLS = 5

const TelemFetchSchema = Type.Object(
  {
    urls: Type.Array(Type.String({ description: "An absolute http(s) URL to read." }), {
      minItems: 1,
      description:
        "The http(s) URLs of the pages to read, at most 5 per call. Duplicates are removed.",
    }),
  },
  { additionalProperties: false },
)

const TELEM_FETCH_DESCRIPTION =
  "Read the full text of web pages by URL. telem_search returns snippets and " +
  "never reads pages; this tool is how pages are read here. Up to 5 http(s) " +
  "URLs per call, fetched together as one batch; for more pages make several " +
  "calls."

/**
 * Friendly pre-validation, BEFORE any I/O or bookkeeping. Returns the trimmed,
 * deduped URL list.
 */
export function validateFetchUrls(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("telem_fetch requires at least one URL in `urls`.")
  }
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error("telem_fetch: every item in `urls` must be a URL string.")
    }
  }
  const trimmed = (raw as string[]).map((url) => url.trim())
  for (const url of trimmed) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(
        `telem_fetch only reads http(s) URLs, got ${JSON.stringify(url)}. ` +
          "Pass absolute URLs starting with http:// or https://.",
      )
    }
  }
  const urls = [...new Set(trimmed)]
  if (urls.length > FETCH_MAX_URLS) {
    throw new Error(
      `telem_fetch reads at most ${FETCH_MAX_URLS} URLs per call (got ${urls.length}). ` +
        "Split the read into multiple calls.",
    )
  }
  return urls
}

export function createTelemFetchTool(deps: TelemToolDeps) {
  return {
    name: "telem_fetch",
    label: "Telem Fetch",
    description: TELEM_FETCH_DESCRIPTION,
    parameters: TelemFetchSchema,
    execute: async (
      toolCallId: string,
      rawParams: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<ToolTextResult> => {
      const urls = validateFetchUrls(rawParams.urls)

      // Config first, for the same reason as telem_search: the omission scope
      // must be the scope this POST uses (spec 2026-08-24). The search
      // block is never attached here, but the base url and key are shared — and
      // they are exactly what the scope is made of.
      const config = deps.getConfig()
      const delivery = newDeliveryPlan(cacheScope(config.baseUrl, config.apiKey))

      const history = await deps.readHistory(toolCallId)

      // Minted ONCE per execute call, before the payload is built, so any
      // retry added at a safe layer stays an idempotent re-send of the same node.
      const nodeKey = randomUUID()
      const metadata: Record<string, unknown> = { message_history: history }
      try {
        // Flat under metadata — v5 has no nested `trajectory` block. `fetch` is
        // the declared intent; the backend derives authoritatively from the
        // request shape and 400s on contradiction.
        Object.assign(metadata, await deps.buildTrajectory({ nodeKey, kind: "fetch", delivery }))
      } catch {
        // Unreachable by contract; bookkeeping may never fail a fetch.
        metadata.node_key = nodeKey
        metadata.kind = "fetch"
        metadata.parent_node_key = null
        metadata.ancestors = []
      }
      // No `goal` here: for a fetch the URLs are the identity.

      // /v1/fetch (endpoint-split spec): the body carries the top-level
      // `urls` list and the backend assembles the fetch pipeline itself. The
      // endpoint is extra="forbid", so no legacy user_input key. Configured
      // providers are never attached: that setting pins SEARCH providers, and
      // the endpoint rejects a `search` block outright. `metadata.kind` stays —
      // the endpoint refuses a kind that CONTRADICTS it, and "fetch" agrees.
      const body: Record<string, unknown> = { urls, metadata }

      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

      // A single POST — a fetch bills providers and creates an interaction, so a
      // transient failure is surfaced rather than silently re-run. Same single
      // omission retry as telem_search (ONE helper, both tools) — a fetch
      // delivers its ancestors through the very same backend handler and can be
      // refused by the very same guard, only through the `{"error": {...}}`
      // envelope.
      const { response, detail } = await postWithOmissionRetry({
        doFetch: deps.fetchImpl ?? fetch,
        url: `${config.baseUrl}/v1/fetch`,
        headers,
        body,
        delivery,
        restore: deps.restoreOmittedContexts,
        signal,
      })
      if (!response.ok) {
        throw new Error(`Telem fetch failed: HTTP ${response.status} ${detail.slice(0, 200)}`)
      }
      const interaction = await response.json()
      // ONE watermark for both tools: a fetch delivers ancestors through
      // the same handler, so a fetch 2xx is delivery proof for a later search
      // exactly as a search's is for a later fetch. Marked on ok + parsed only.
      deps.recordDelivery(delivery, interaction)
      // Off-model client update advisory (spec 2026-09-01), same seam as
      // telem_search: right after recordDelivery, on console.warn, never into the
      // model-facing fetch render. Never throws into the turn.
      maybeNotifyClientUpdate(interaction)
      const telemSessionId = interaction.session_id ? String(interaction.session_id) : undefined

      // The backend session id is bookkeeping, not instruction: structured tool
      // details for logs and the UI, never the model-facing text.
      return {
        content: [{ type: "text", text: formatFetchResults(interaction) }],
        details: telemSessionId ? { telem_session_id: telemSessionId } : {},
      }
    },
  }
}
