// Resolves Telem credentials and V2 search options per tool call.
//
// Requests go to the hosted Telem endpoint below unless overridden. To point the
// plugin at a different deployment, set `baseUrl` in the plugin's OpenClaw
// config entry or the TELEM_BASE_URL environment variable (config wins).
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, sep } from "node:path"

export const DEFAULT_TELEM_BASE_URL = "https://router.telem.ai"

export type TelemSearchOptions = {
  tier?: string
  fields?: string[]
  providersInclude?: string[]
  providersExclude?: string[]
  fullContent?: boolean
  autoRouting?: string
  maxRoutingProviders?: number
  topic?: string
}

/** The fetch keys (hosted-fetch-options spec F3), as resolved; sent only by telem_fetch. */
export type TelemFetchOptions = {
  fetchProviders?: string[]
  fetchTier?: string
  fetchNoCache?: boolean
}

export type TelemConfig = TelemSearchOptions & TelemFetchOptions & {
  baseUrl: string
  apiKey?: string
  /** Set when the config can run no search: providersExclude removes every provider in providersInclude. */
  refusal?: string
}

type PluginEntryConfig = {
  baseUrl?: unknown
  apiKey?: unknown
  tier?: unknown
  fields?: unknown
  providersInclude?: unknown
  providersExclude?: unknown
  fullContent?: unknown
  autoRouting?: unknown
  fetchProviders?: unknown
  fetchTier?: unknown
  fetchNoCache?: unknown
}

type Sourced<T> = { value: T; level: number }

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
  return items.length ? items : undefined
}

// The ~/.telem directory, honoring TELEM_CONFIG_DIR but refusing a dir that
// lexically points inside the working tree — a committed <repo>/.telem must not
// steer traffic. Project-unaware OpenClaw's equivalent of the config-core guard
// (which uses a passed projectRoot); process.cwd stands in for the project the
// plugin runs against. Inlined (this package does not depend on config-core), and
// SHARED so the credentials read and the update-notice stamp (src/update-advisory.ts)
// resolve to the very same directory.
export function resolveTelemDir(env: NodeJS.ProcessEnv): string {
  const home = join(homedir(), ".telem")
  const requested = readString(env.TELEM_CONFIG_DIR)
  if (!requested) return home
  const resolved = resolve(requested)
  const cwd = resolve(process.cwd())
  return resolved === cwd || resolved.startsWith(cwd + sep) ? home : resolved
}

// Read ~/.telem/credentials.json — the file create-telemai writes. Inlined (this
// package does not depend on config-core) but semantically the SDK's read_credentials:
// never throws, silent, apiKey/baseUrl only. It is the LAST credential source, below the
// OpenClaw config entry and the environment, so the installer's key reaches OpenClaw too.
function readCredentials(env: NodeJS.ProcessEnv): { apiKey?: string; baseUrl?: string } {
  try {
    const dir = resolveTelemDir(env)
    const data = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")) as unknown
    if (typeof data !== "object" || data === null) return {}
    const record = data as Record<string, unknown>
    const out: { apiKey?: string; baseUrl?: string } = {}
    if (typeof record.apiKey === "string" && record.apiKey) out.apiKey = record.apiKey
    if (typeof record.baseUrl === "string" && record.baseUrl) out.baseUrl = record.baseUrl
    return out
  } catch {
    return {}
  }
}

function splitCsv(value: string | undefined): string[] | undefined {
  return readStringList(value?.split(","))
}

function readFlag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function resolveOption<T>(
  configured: unknown,
  envValue: unknown,
  coerce: (value: unknown) => T | undefined,
): Sourced<T> | undefined {
  const value = coerce(configured)
  if (value !== undefined) return { value, level: 0 }
  const fallback = coerce(envValue)
  return fallback === undefined ? undefined : { value: fallback, level: 1 }
}

let lastCompositionWarning: string | undefined
let lastProvidersWarning: string | undefined

/** Where each provider list was set, as the end of "set …" in a refusal, by level. */
const PROVIDER_SOURCES = {
  include: ["in the plugin entry (plugins.entries.telem.config)", "by TELEM_PROVIDERS_INCLUDE"],
  exclude: ["in the plugin entry (plugins.entries.telem.config)", "by TELEM_PROVIDERS_EXCLUDE"],
} as const

/** The refusal sentence every surface uses (config-core's `providersRefusal`). */
export function providersRefusal(include: readonly string[], inInclude: string, inExclude: string): string {
  const names = include.join(", ")
  const fix =
    inInclude === inExclude
      ? `Remove ${names} from one of the two lists ${inInclude}.`
      : `Remove ${names} from providersInclude (set ${inInclude}) or from providersExclude (set ${inExclude}).`
  return (
    `[telem] providersExclude removes every provider in providersInclude (${names}), ` +
    `so no provider is left and no search was sent. ${fix}`
  )
}

// cfg is the current OpenClawConfig snapshot. It and the environment are read on
// every tool call, so a host config reload takes effect without re-registering
// the tool. Precedence is per key: plugin config > environment.
export function resolveTelemConfig(cfg?: unknown, env: NodeJS.ProcessEnv = process.env): TelemConfig {
  const entries = (cfg as { plugins?: { entries?: Record<string, { config?: unknown }> } })?.plugins
    ?.entries
  const entry = (entries?.telem?.config ?? {}) as PluginEntryConfig

  // Plugin config first, then the environment, then the hosted default — the
  // same per-key precedence as every other option here. Pinning the endpoint to
  // env-only made the plugin impossible to exercise against anything but the
  // hosted deployment, which is exactly when you most want to point it
  // somewhere else.
  // Credential order: OpenClaw config entry > environment > ~/.telem/credentials.json
  // (the installer's file) — mirrors the SDK's arg→env→file so an installed key is found.
  const creds = readCredentials(env)
  const baseUrl = (
    readString(entry.baseUrl) ??
    readString(env.TELEM_BASE_URL) ??
    creds.baseUrl ??
    DEFAULT_TELEM_BASE_URL
  ).replace(/\/+$/, "")
  const config: TelemConfig = { baseUrl }
  const apiKey = readString(entry.apiKey) ?? readString(env.TELEM_API_KEY) ?? creds.apiKey
  if (apiKey) config.apiKey = apiKey

  // V2 rejects a request containing both tier and fields. The more specific
  // source wins (plugin config over env); on a tie fields wins because it is the
  // explicit field selection. This is the same composition rule as opencode.
  let tier = resolveOption(entry.tier, env.TELEM_TIER, readString)
  let fields = resolveOption(entry.fields, splitCsv(env.TELEM_FIELDS), readStringList)
  if (tier && fields) {
    const keepTier = tier.level < fields.level
    const signature = `${tier.value}@${tier.level}|${fields.value.join(",")}@${fields.level}`
    if (lastCompositionWarning !== signature) {
      lastCompositionWarning = signature
      console.warn(
        `[telem] both tier (${tier.value}) and fields (${fields.value.join(", ")}) are configured, ` +
          "but a request may carry only one — " +
          (keepTier ? `keeping tier, ignoring fields` : `keeping fields, ignoring tier`) +
          " (the more specific source wins; on a tie, fields).",
      )
    }
    if (keepTier) fields = undefined
    else tier = undefined
  }
  if (tier) config.tier = tier.value
  if (fields) config.fields = fields.value

  // Exclude wins (owner design, 2026-10-26): the excluded names leave the include
  // list before anything is sent, as on every other surface. When nothing is
  // left, the search is refused: the default set could hold an excluded provider.
  const include = resolveOption(entry.providersInclude, splitCsv(env.TELEM_PROVIDERS_INCLUDE), readStringList)
  const exclude = resolveOption(entry.providersExclude, splitCsv(env.TELEM_PROVIDERS_EXCLUDE), readStringList)
  if (include && exclude) {
    const excluded = new Set(exclude.value)
    const kept = include.value.filter((name) => !excluded.has(name))
    const dropped = include.value.filter((name) => excluded.has(name))
    if (!kept.length) {
      config.refusal = providersRefusal(
        include.value,
        PROVIDER_SOURCES.include[include.level],
        PROVIDER_SOURCES.exclude[exclude.level],
      )
    } else {
      config.providersInclude = kept
      const signature = `${include.value.join(",")}|${exclude.value.join(",")}`
      if (dropped.length && lastProvidersWarning !== signature) {
        lastProvidersWarning = signature
        console.warn(
          `[telem] providersExclude removes ${dropped.join(", ")} from providersInclude: ` +
            `this search runs ${kept.join(", ")}.`,
        )
      }
    }
  } else {
    if (include) config.providersInclude = include.value
    if (exclude) config.providersExclude = exclude.value
  }

  const fullContent = resolveOption(
    entry.fullContent,
    env.TELEM_FULL_CONTENT === "1" ? true : undefined,
    readFlag,
  )
  if (fullContent) config.fullContent = fullContent.value

  // autoRouting is a published option, so it may come from this plugin's own config.
  // The environment wins over it: the rule for this one key is that the shell
  // overrides the client's configuration, and here the plugin entry IS that
  // configuration. topic and the count below stay env-only.
  // "off" (any case) wins like any value, then means do not route: the router
  // answers 422 for it as a mode.
  const autoRouting = readString(env.TELEM_AUTO_ROUTING) ?? readString(entry.autoRouting)
  if (autoRouting && autoRouting.toLowerCase() !== "off") config.autoRouting = autoRouting
  const count = env.TELEM_MAX_ROUTING_PROVIDERS
  if (count !== undefined && /^\s*[+-]?\d+\s*$/.test(count)) config.maxRoutingProviders = Number(count)
  const topic = readString(env.TELEM_TOPIC)
  if (topic) config.topic = topic

  // The fetch keys, per key: plugin config > environment, like every option here.
  const fetchProviders = resolveOption(entry.fetchProviders, splitCsv(env.TELEM_FETCH_PROVIDERS), readStringList)
  if (fetchProviders) config.fetchProviders = fetchProviders.value
  const fetchTier = resolveOption(entry.fetchTier, env.TELEM_FETCH_TIER, readString)
  if (fetchTier) config.fetchTier = fetchTier.value
  const fetchNoCache = resolveOption(
    entry.fetchNoCache,
    env.TELEM_FETCH_NO_CACHE === "1" ? true : undefined,
    readFlag,
  )
  if (fetchNoCache) config.fetchNoCache = fetchNoCache.value

  return config
}

// The fetch `options` block (hosted-fetch-options spec F3): providers / tier /
// no_cache, in that key order, or null when none resolved. It validates nothing (the
// router judges names); it lowercases `tier`, and sends `no_cache` as resolved, so a
// configured `false` is sent as `false`. The same block every other surface sends.
export function buildFetchOptions(options: TelemFetchOptions): Record<string, unknown> | null {
  const block: Record<string, unknown> = {}
  if (options.fetchProviders !== undefined) block.providers = [...options.fetchProviders]
  if (options.fetchTier !== undefined) block.tier = options.fetchTier.toLowerCase()
  if (options.fetchNoCache !== undefined) block.no_cache = options.fetchNoCache
  return Object.keys(block).length ? block : null
}

// The V2 search block, omitted entirely when no option is resolved so the
// deployment's defaults apply. When both provider lists resolved, the config has
// already taken the excluded names off the include list; an exclude list alone is
// forwarded for the server to apply to the deployment set.
export function buildSearchBlock(options: TelemSearchOptions): Record<string, unknown> | null {
  const block: Record<string, unknown> = {}
  if (options.tier !== undefined) block.tier = options.tier
  if (options.fields !== undefined) block.fields = options.fields

  const providers: Record<string, unknown> = {}
  if (options.providersInclude !== undefined) providers.include = options.providersInclude
  if (options.providersExclude !== undefined) providers.exclude = options.providersExclude
  if (Object.keys(providers).length) block.providers = providers

  if (options.fullContent !== undefined) block.include_full_content = options.fullContent
  if (options.autoRouting !== undefined) block.auto_routing = options.autoRouting
  if (options.maxRoutingProviders !== undefined) block.max_routing_providers = options.maxRoutingProviders
  if (options.topic !== undefined) block.topic = options.topic
  return Object.keys(block).length ? block : null
}
