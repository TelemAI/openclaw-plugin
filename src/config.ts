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
}

export type TelemConfig = TelemSearchOptions & {
  baseUrl: string
  apiKey?: string
}

type PluginEntryConfig = {
  baseUrl?: unknown
  apiKey?: unknown
  tier?: unknown
  fields?: unknown
  providersInclude?: unknown
  providersExclude?: unknown
  fullContent?: unknown
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

// Read ~/.telem/credentials.json — the file create-telemai writes. Inlined (this
// package does not depend on config-core) but semantically the SDK's read_credentials:
// never throws, silent, apiKey/baseUrl only. It is the LAST credential source, below the
// OpenClaw config entry and the environment, so the installer's key reaches OpenClaw too.
function readCredentials(env: NodeJS.ProcessEnv): { apiKey?: string; baseUrl?: string } {
  try {
    const home = join(homedir(), ".telem")
    const requested = readString(env.TELEM_CONFIG_DIR)
    // Refuse a credentials dir that lexically points inside the working tree — a committed
    // <repo>/.telem/credentials.json must not steer traffic. Project-unaware OpenClaw's
    // equivalent of the config-core guard (which uses a passed projectRoot); process.cwd
    // stands in for the project the plugin runs against.
    let dir = home
    if (requested) {
      const resolved = resolve(requested)
      const cwd = resolve(process.cwd())
      dir = resolved === cwd || resolved.startsWith(cwd + sep) ? home : resolved
    }
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

  const providersInclude = readStringList(entry.providersInclude) ?? splitCsv(env.TELEM_PROVIDERS_INCLUDE)
  if (providersInclude) config.providersInclude = providersInclude

  const providersExclude = readStringList(entry.providersExclude) ?? splitCsv(env.TELEM_PROVIDERS_EXCLUDE)
  if (providersExclude) config.providersExclude = providersExclude

  const fullContent = resolveOption(
    entry.fullContent,
    env.TELEM_FULL_CONTENT === "1" ? true : undefined,
    readFlag,
  )
  if (fullContent) config.fullContent = fullContent.value

  return config
}

// The V2 search block, omitted entirely when no option is resolved so the
// deployment's defaults apply. Include/exclude are forwarded unchanged; the
// server owns their set composition and validation.
export function buildSearchBlock(options: TelemSearchOptions): Record<string, unknown> | null {
  const block: Record<string, unknown> = {}
  if (options.tier !== undefined) block.tier = options.tier
  if (options.fields !== undefined) block.fields = options.fields

  const providers: Record<string, unknown> = {}
  if (options.providersInclude !== undefined) providers.include = options.providersInclude
  if (options.providersExclude !== undefined) providers.exclude = options.providersExclude
  if (Object.keys(providers).length) block.providers = providers

  if (options.fullContent !== undefined) block.include_full_content = options.fullContent
  return Object.keys(block).length ? block : null
}
