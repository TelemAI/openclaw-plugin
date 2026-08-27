// telem-render:begin
// ---------------------------------------------------------------------------
// Search rendering — the V2 normalized envelope (search I/O normalization
//-) turned into the text the model reads. PORTABLE BY CONTRACT: this
// whole region is copied verbatim into the openclaw plugin, so it may not touch
// anything host-specific (no opencode client, no tool context, no env) — it is
// a pure function of one interaction body.
//
// Render budget ( the contract, final):
//   - `summary` renders WHOLE (the server already caps it at 1000 chars);
//   - `excerpt` renders at most 4 entries of at most 1000 chars each, with an
//     elision note when entries were dropped (real entries measure 1-14 KB);
//   - `full_content` is NEVER rendered inline — depth is telem_fetch's job;
//   - per-result `[<provider>]` tag: the schema keeps every provider's list
//     separate ( — no merged list, no global rank), so every row says who
//     found it;
//   - the query-level `answer`/`related` block leads each query section;
//   - a failed or degraded run contributes ONE line instead of rows;
//   - only a BATCH carries a total cap; a single-query render has none.
// A field that a tier did not request, or that a provider could not supply, is
// simply absent from the output — the envelope's own presence rule.
//
// Values are single-line by construction — provider markdown cannot outrank the
// renderer's structure.
// ---------------------------------------------------------------------------

const RENDER_EXCERPT_MAX_ENTRIES = 4
const RENDER_EXCERPT_MAX_CHARS = 1000
const RENDER_RELATED_MAX_ITEMS = 6
const RENDER_TOTAL_CAP = 128000

// EVERY provider value goes through here before it is rendered. Real summaries
// and excerpts are markdown with newlines (a parallel summary opens with `#`
// and `##` headings), and a value allowed to start a line would forge the
// renderer's own structure — a heading outranking `### Query N`, or a bare line
// that reads as content nobody attributed. Folding interior whitespace keeps
// every byte of the value on the line its label owns.
function line(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s*\n\s*/g, " ") : ""
}

// One result row. URL is the only required field, so it anchors the row;
// everything else is a labelled line that appears only when it carries content.
function renderRow(provider: string, row: any): string {
  const lines = [`[${provider}] URL: ${line(row?.url)}`]
  const title = line(row?.title)
  if (title) lines.push(`Title: ${title}`)
  const summary = line(row?.summary)
  if (summary) lines.push(`Summary: ${summary}`)

  const entries = (Array.isArray(row?.excerpt) ? row.excerpt : [])
    .map((entry: unknown) => line(entry))
    .filter(Boolean)
  if (entries.length) {
    lines.push("Excerpt:")
    for (const entry of entries.slice(0, RENDER_EXCERPT_MAX_ENTRIES)) {
      // The ellipsis marks the cut and sits OUTSIDE the budget, exactly as the
      // server's own the contract does for summaries.
      const cut = entry.length > RENDER_EXCERPT_MAX_CHARS
      lines.push(`- ${cut ? entry.slice(0, RENDER_EXCERPT_MAX_CHARS) + "…" : entry}`)
    }
    const dropped = entries.length - RENDER_EXCERPT_MAX_ENTRIES
    if (dropped > 0) lines.push(`…(${dropped} more excerpt entries)`)
  }

  const published = line(row?.publish_date)
  if (published) lines.push(`Published: ${published}`)
  const source = row?.source
  if (source && typeof source === "object") {
    // The domain is already in the URL, so it only earns a line when the
    // provider named a publication or an author to go with it.
    const name = line(source.name) || line(source.domain)
    const author = line(source.author)
    if (author) lines.push(`Source: ${name ? `${name} by ${author}` : `by ${author}`}`)
    else if (line(source.name)) lines.push(`Source: ${name}`)
  }
  // `full_content` is deliberately not rendered here — see the budget above.
  return lines.join("\n")
}

// The query-level block. These keys are per RUN, but they answer the
// QUERY, so the section carries one block: the first answer any provider
// returned, and the related items pooled across providers (questions first,
// then searches), deduped and capped.
function renderQueryBlock(runs: any[]): string[] {
  const lines: string[] = []
  let answer = ""
  const questions: string[] = []
  const searches: string[] = []
  for (const run of runs) {
    const payload = run?.output_payload
    if (!payload || typeof payload !== "object") continue
    if (!answer) answer = line(payload.answer)
    const related = payload.related
    if (!related || typeof related !== "object") continue
    for (const item of Array.isArray(related.questions) ? related.questions : []) {
      const text = line(item)
      if (text) questions.push(text)
    }
    for (const item of Array.isArray(related.searches) ? related.searches : []) {
      const text = line(item)
      if (text) searches.push(text)
    }
  }
  if (answer) lines.push(`Answer: ${answer}`)
  const related = [...new Set([...questions, ...searches])].slice(0, RENDER_RELATED_MAX_ITEMS)
  if (related.length) lines.push(`Related: ${related.join(", ")}`)
  return lines
}

// Everything one query produced: its block, then each run's contribution in run
// order (rows, or a single line for a run that failed or degraded).
function renderQuerySection(runs: any[]): string {
  const blocks: string[] = []
  const rowBlocks: string[] = []
  for (const run of runs) {
    const provider = line(run?.preprocessor_name) || "unknown"
    const payload = run?.output_payload
    const rows = Array.isArray(payload?.results) ? payload.results : null
    const error = run?.error
    if (run?.status === "failed" || (!rows && error)) {
      // ONE line, like every other value: provider errors are often multi-line
      // (`…\nFor more information check: …`) and an untagged continuation line
      // reads like content.
      const message = line(error?.message) || line(error?.type) || "unknown error"
      rowBlocks.push(`[${provider}] failed: ${message}`)
      continue
    }
    if (!rows?.length) {
      // A SUCCEEDED run whose normalize raised ships the minimal envelope —
      // no rows plus one `normalize_failed` warning. Say so, or the run is
      // invisible next to its healthy siblings and reads as "nothing found".
      // A genuinely empty result set carries no such warning and stays silent.
      const warnings = Array.isArray(payload?.warnings) ? payload.warnings : []
      const degraded = warnings.find((warning: any) => warning?.code === "normalize_failed")
      if (degraded) {
        const message = line(degraded.message) || "normalize_failed"
        rowBlocks.push(`[${provider}] no rows (${message})`)
      }
      continue
    }
    for (const row of rows) rowBlocks.push(renderRow(provider, row))
  }
  const head = renderQueryBlock(runs)
  if (head.length) blocks.push(head.join("\n"))
  blocks.push(...(rowBlocks.length ? rowBlocks : ["No results found."]))
  return blocks.join("\n\n")
}

function formatSearchResults(interaction: any): string {
  // Group the runs by the query that produced them. A batch request runs N
  // queries as ONE interaction and the backend tags every run with a 0-based
  // batch_index and its query text; a single-query interaction has every run at
  // batch_index 0 and renders as one unlabelled section.
  const groups = new Map<number, { query: string; runs: any[] }>()
  for (const run of interaction?.preprocessor_runs ?? []) {
    const index = typeof run?.batch_index === "number" ? run.batch_index : 0
    let group = groups.get(index)
    if (!group) groups.set(index, (group = { query: "", runs: [] }))
    // The query is a value too — the MODEL supplies it (page text copied into a
    // search is a real path), so it goes through the same fold and can never
    // forge a section header or a provider row from inside its own label.
    if (!group.query) group.query = line(run?.query)
    group.runs.push(run)
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group)

  // One query (or a response carrying no runs): field-level caps only.
  if (ordered.length <= 1) return renderQuerySection(ordered[0]?.runs ?? [])

  // A batch: one labelled section per query so the model can attribute every
  // row to the query that produced it, plus the one total cap in the renderer —
  // a 32-query batch is the only realistic way to blow up a tool result.
  const text = ordered
    .map((group, i) => {
      const label = group.query ? `Query ${i + 1}: ${group.query}` : `Query ${i + 1}`
      return `### ${label}\n${renderQuerySection(group.runs)}`
    })
    .join("\n\n")
  if (text.length <= RENDER_TOTAL_CAP) return text
  return (
    text.slice(0, RENDER_TOTAL_CAP) +
    `\n\n…(batch output truncated at ${RENDER_TOTAL_CAP} characters — re-run the remaining queries in a smaller batch)`
  )
}
// telem-render:end

export { formatSearchResults as formatResults }

// Per-URL inline-content cap for a fetch — the backend's own inline cap.
export const FETCH_CONTENT_CAP = 20000

// One section per fetched URL. Succeeded rows carry the page's inline content,
// capped at FETCH_CONTENT_CAP per URL; the note covers both the client-side cut
// and a row the backend already truncated. Failed rows render their status and
// error briefly instead.
function formatFetchedRow(row: any): string {
  const url = typeof row?.url === "string" ? row.url : ""
  const title = typeof row?.title === "string" ? row.title : ""
  const status = typeof row?.status === "string" ? row.status : "unknown"
  const header = `### ${url}` + (title ? `\nTitle: ${title}` : "") + `\nStatus: ${status}`
  if (status !== "succeeded") {
    const error = row?.error
    const brief =
      error && (error.type || error.message)
        ? `\nError: ${[error.type, error.message].filter(Boolean).join(": ")}`
        : ""
    return header + brief
  }
  const content = typeof row?.content === "string" ? row.content : ""
  const truncated = content.length > FETCH_CONTENT_CAP || row?.content_truncated === true
  const note = truncated ? `\n\n[Content truncated at ${FETCH_CONTENT_CAP} characters]` : ""
  return `${header}\n\n${content.slice(0, FETCH_CONTENT_CAP)}${note}`
}

// Renders a fetch interaction. The current backend runs fetch as a FIRST-stage
// unit: one `web_fetch` preprocessor run per URL (batch_index order), each
// carrying its fetched_results row. Older backends ran it as the
// `web_fetch_cache` postprocessor — kept as a fallback so the tool works against
// either deployment. A missing run or an empty batch degrades to a clear
// message, never a throw.
export function formatFetchResults(interaction: any): string {
  const preRuns = (interaction?.preprocessor_runs ?? []).filter(
    (r: any) => r?.preprocessor_name === "web_fetch",
  )
  const rows: any[] = []
  if (preRuns.length > 0) {
    preRuns.sort((a: any, b: any) => (a?.batch_index ?? 0) - (b?.batch_index ?? 0))
    for (const run of preRuns) {
      const fetched = run?.output_payload?.fetched_results
      if (Array.isArray(fetched)) rows.push(...fetched)
    }
  } else {
    // Older backend: fetch ran as the web_fetch_cache postprocessor.
    const run = (interaction?.postprocessor_runs ?? []).find(
      (r: any) => r?.postprocessor_name === "web_fetch_cache",
    )
    const fetched = run?.output_payload?.fetched_results
    if (Array.isArray(fetched)) rows.push(...fetched)
  }
  if (rows.length === 0) {
    return "The fetch produced no results (the backend returned no web fetch output)."
  }
  return rows.map(formatFetchedRow).join("\n\n")
}
