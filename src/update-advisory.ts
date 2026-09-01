// Client update advisory (spec the design notes
// On a 2xx search/fetch whose body parsed, the server MAY name the version
// it recommends for THIS surface. If our injected PLUGIN_VERSION is strictly
// behind it, we emit a ONE-TIME, OFF-MODEL notice on `console.warn` (openclaw's
// live config-warning channel) naming openclaw's update command — never
// the tool result the model reads. Notify-only: this compares versions and
// prints a line; it NEVER updates anything.
//
// The seam mirrors the opencode plugin's `maybeNotifyClientUpdate`, but openclaw
// does NOT depend on config-core (see src/config.ts `readCredentials`, "this
// package does not depend on config-core"). So the three shared pure pieces —
// the version comparator `isBehind`, the cross-run dedup gate
// `noticeAlreadyShown`, and this surface's update-command string — are HAND-
// PORTED inline here, matching that existing pattern. The anti-drift gate is a
// differential test (its own suite style) that runs
// config-core's real functions and the shared corpus against these ports.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveTelemDir } from "./config.js"
import { PLUGIN_VERSION } from "./version.js"

// ---------------------------------------------------------------------------
// Hand-ported from the shared config contractversion.ts — kept byte-for-behavior by the
// differential test. Two rules the whole feature leans on: numeric-segment
// compare ("0.2.10" is NEWER than "0.2.9"), and malformed input on either side
// ⇒ `false` (silent), never a throw.
// ---------------------------------------------------------------------------

type ParsedVersion = {
  /** Numeric release segments, e.g. `0.2.10` → [0, 2, 10]. */
  release: number[]
  /** Prerelease identifiers (the `-next.1` tail); empty for a stable release. */
  pre: string[]
}

const NUMERIC = /^\d+$/

// Parse `x.y.z` / `x.y.z-pre.tags`. Build metadata (`+…`) is stripped per semver.
// Returns `null` for anything that is not a run of numeric release segments — the
// signal every caller turns into silence.
function parseVersion(input: unknown): ParsedVersion | null {
  if (typeof input !== "string") return null
  let text = input.trim()
  if (text === "") return null
  const plus = text.indexOf("+")
  if (plus !== -1) text = text.slice(0, plus)
  const dash = text.indexOf("-")
  const core = dash === -1 ? text : text.slice(0, dash)
  const preText = dash === -1 ? "" : text.slice(dash + 1)
  const release: number[] = []
  for (const part of core.split(".")) {
    if (!NUMERIC.test(part)) return null
    release.push(Number(part))
  }
  // A dash with nothing after it is malformed, not a stable release.
  if (dash !== -1 && preText === "") return null
  const pre = preText === "" ? [] : preText.split(".")
  for (const id of pre) {
    if (id === "") return null
  }
  return { release, pre }
}

// -1 / 0 / 1 for a<b / a==b / a>b over prerelease identifier lists.
function comparePre(a: string[], b: string[]): number {
  // A stable release (no prerelease) outranks any prerelease of the same core.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    const x = a[i]
    const y = b[i]
    const xn = NUMERIC.test(x)
    const yn = NUMERIC.test(y)
    if (xn && yn) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (xn !== yn) {
      // A numeric identifier has lower precedence than an alphanumeric one.
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

// -1 / 0 / 1 for a<b / a==b / a>b over two already-parsed versions.
function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  const width = Math.max(a.release.length, b.release.length)
  for (let i = 0; i < width; i++) {
    const x = a.release[i] ?? 0
    const y = b.release[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return comparePre(a.pre, b.pre)
}

// Is `local` strictly older than `recommended` — i.e. should this client notify?
// Malformed input on either side ⇒ `false` (silent), never a throw.
export function isBehind(local: string, recommended: string): boolean {
  const a = parseVersion(local)
  const b = parseVersion(recommended)
  if (a === null || b === null) return false
  return compareParsed(a, b) < 0
}

// Has this surface ALREADY shown the update advisory for `recommendedVersion`
// today? PURE — no fs/clock/env: the caller passes the already-read stamp entry,
// the recommended version, and today's `YYYY-MM-DD`. A missing/null/malformed
// entry is "not shown" (`false`), so a lost stamp degrades to show-once.
export function noticeAlreadyShown(
  stampEntry: unknown,
  recommendedVersion: string,
  today: string,
): boolean {
  if (stampEntry === null || typeof stampEntry !== "object") return false
  const entry = stampEntry as { version?: unknown; lastShownDate?: unknown }
  return entry.version === recommendedVersion && entry.lastShownDate === today
}

// The exact openclaw update instruction — hand-inlined equal to the shared
// corpus's `"openclaw"` row (the shared config contract). openclaw
// cannot import the JSON (it does not depend on config-core and ships dist/ only),
// so the differential test pins this constant `===` that row.
export const OPENCLAW_UPDATE_COMMAND =
  "The Telem OpenClaw plugin can be updated with: openclaw plugins update telem"

// ---------------------------------------------------------------------------
// The per-surface SHELL — env opt-out, TTY/CI detection, the stamp file, the
// clock, the console.warn. Mirrors opencode's shell; openclaw's channel is the
// global console.warn, so nothing is injected.
// ---------------------------------------------------------------------------

// This surface always reads `recommended.openclaw` — a FIXED LITERAL, decoupled
// from any trajectory id.
const ADVISORY_KEY = "openclaw"
const UPDATE_STAMP_FILE = "update-notice.json"

// In-process dedup, keyed by the recommended version string: a
// long-lived gateway re-notifies ONCE per server-bumped version, never per call,
// and a same-version re-run stays silent. Module scope so it outlives calls.
const advisoryNotified = new Set<string>()

// The `body.client_advisory?.recommended?.openclaw` path — silent (undefined) on
// a null/absent/malformed field, never a throw (spec read step).
function readAdvisoryVersion(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const advisory = (body as Record<string, unknown>).client_advisory
  if (!advisory || typeof advisory !== "object") return undefined
  const recommended = (advisory as Record<string, unknown>).recommended
  if (!recommended || typeof recommended !== "object") return undefined
  const value = (recommended as Record<string, unknown>)[ADVISORY_KEY]
  return typeof value === "string" ? value : undefined
}

// Env-only opt-out: `TELEM_NO_UPDATE_NOTICE=1` suppresses entirely.
// Matches the shipped env-flag rule (only "1" turns a flag on); trimmed so a stray
// space does not defeat the lever.
function updateNoticeOptedOut(): boolean {
  return (process.env.TELEM_NO_UPDATE_NOTICE ?? "").trim() === "1"
}

// Non-interactive one-shots (piped stdin, CI) would notify on EVERY run and a
// warning only makes sense to an interactive operator anyway. Suppress there
// re-implemented per surface (create-telemai's copy is not importable).
function updateNoticeSuppressedByContext(): boolean {
  return !process.stdin.isTTY || Boolean(process.env.CI)
}

// Today as a local `YYYY-MM-DD`. The stamp gates "once per day"; a coarse local
// calendar day is the right granularity and needs no tz dependency.
function todayStamp(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

type UpdateStamp = Record<string, { version?: string; lastShownDate?: string }>

// `~/.telem/update-notice.json`, next to credentials.json and honoring
// TELEM_CONFIG_DIR through the SAME resolver the credentials read uses. No
// projectRoot: "told once per release" is a user-level fact, not a per-repo one.
function updateStampPath(): string {
  return join(resolveTelemDir(process.env), UPDATE_STAMP_FILE)
}

// SILENT by design: a missing / unreadable / malformed stamp is "nothing shown
// yet", so a lost stamp degrades to show-once — it must never throw
// into the turn.
function readUpdateStamp(): UpdateStamp {
  try {
    const parsed = JSON.parse(readFileSync(updateStampPath(), "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as UpdateStamp) : {}
  } catch {
    return {}
  }
}

// Record that this surface showed the notice for `version` on `today`. `mkdir -p`
// first — an env-only user who never ran create-telemai has no `~/.telem` yet
// A write failure degrades to "notify again next run", never a throw.
function writeUpdateStamp(version: string, today: string): void {
  try {
    const dir = resolveTelemDir(process.env)
    mkdirSync(dir, { recursive: true })
    const stamp = readUpdateStamp()
    stamp[ADVISORY_KEY] = { version, lastShownDate: today }
    writeFileSync(join(dir, UPDATE_STAMP_FILE), JSON.stringify(stamp))
  } catch {
    /* notify-only: a stamp write must never break a search. */
  }
}

// Emit the off-model notice. `console.warn` is openclaw's config-warning channel
// (src/config.ts) — invisible to the model, visible to the operator. Never throws
// into the turn. Returns whether a line was actually emitted, so the caller only
// stamps a notice that reached the channel.
function showUpdateWarning(recommended: string): boolean {
  const message = `A newer Telem OpenClaw plugin (${recommended}) is available. ${OPENCLAW_UPDATE_COMMAND}`
  try {
    console.warn(message)
    return true
  } catch {
    /* never throw into the turn */
  }
  return false
}

// The per-surface SHELL of the update advisory, called right
// after `recordDelivery` at both post-parse sites. Gates, IN THIS ORDER — each
// reads from where the comment says — then warns once. Everything is wrapped: a
// malformed field, an unreadable stamp, a non-TTY context all silently no-op.
// It NEVER touches the tool result the model reads.
export function maybeNotifyClientUpdate(body: unknown): void {
  try {
    // 1. opt-out          ← env (TELEM_NO_UPDATE_NOTICE)
    if (updateNoticeOptedOut()) return
    // 2. non-interactive  ← tty/env (process.stdin.isTTY, process.env.CI)
    if (updateNoticeSuppressedByContext()) return
    // 3. read the advisory ← the parsed response body (fixed literal key)
    const recommended = readAdvisoryVersion(body)
    if (recommended === undefined) return
    // 4. in-process once  ← module-scope Set, keyed by the version string
    if (advisoryNotified.has(recommended)) return
    // 5. behind?          ← hand-ported comparator over the injected PLUGIN_VERSION
    if (!isBehind(PLUGIN_VERSION, recommended)) return
    // 6. cross-run stamp  ← fs (~/.telem/update-notice.json) + the local clock
    const today = todayStamp()
    const stamp = readUpdateStamp()
    if (noticeAlreadyShown(stamp[ADVISORY_KEY], recommended, today)) {
      // Already told on this machine today for this version. Mark the process so
      // a long-lived gateway does not re-stat the file every call.
      advisoryNotified.add(recommended)
      return
    }
    // 7. emit + stamp     ← console.warn, then persist version + today
    if (!showUpdateWarning(recommended)) return
    advisoryNotified.add(recommended)
    writeUpdateStamp(recommended, today)
  } catch {
    /* malformed/missing everything ⇒ silent, never throw into the turn */
  }
}
