#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const TELEM_TOOLS = ["telem_search", "telem_fetch"]
export const TELEM_HOOKS = [
  "before_prompt_build",
  "before_tool_call",
  "session_end",
  "subagent_spawned",
]
export const DEFAULT_TELEM_BASE_URL = "https://router.telem.ai"
export const MIN_OPENCLAW_VERSION = [2026, 7, 1]
// Keys setup STRIPS from an existing plugin config. `baseUrl` is deliberately
// NOT here: it is a supported override again, and stripping it would silently
// move a staging or self-hosted deployment back to the hosted default the next
// time anyone ran setup.
export const OBSOLETE_CONFIG_PATHS = [
  "plugins.entries.telem.config.allowBuiltinWebFetch",
  "plugins.entries.telem.config.providers",
]

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(scriptDir, "..")

function unique(values) {
  return [...new Set(values)]
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []
}

function denyEntryBlocksTool(entry, toolName) {
  if (entry === "*" || entry === "group:plugins" || entry === "telem" || entry === toolName) {
    return true
  }
  if (!entry.includes("*")) return false
  const pattern = entry
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${pattern}$`, "i").test(toolName)
}

function deniedTelemTools(deny) {
  return TELEM_TOOLS.filter((name) => deny.some((entry) => denyEntryBlocksTool(entry, name)))
}

/** Which endpoint the plugin will actually call, and why.
 *
 * The same precedence `resolveTelemConfig` uses — plugin config, then the
 * environment, then the hosted default. Reporting only env-or-default told an
 * operator who HAD set `baseUrl` that the plugin was talking to the hosted
 * default; a doctor command that describes a configuration other than the
 * running one is worse than no doctor command at all.
 */
export function resolveReportBaseUrl(pluginConfig = {}, env = process.env) {
  const trim = (value) =>
    typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : undefined
  const configured = trim(pluginConfig?.baseUrl)
  if (configured) return { baseUrl: configured, source: "plugin config" }
  const fromEnv = trim(env?.TELEM_BASE_URL)
  if (fromEnv) return { baseUrl: fromEnv, source: "TELEM_BASE_URL override" }
  return { baseUrl: DEFAULT_TELEM_BASE_URL, source: "hosted default" }
}

export function parseOpenClawVersion(text) {
  const match = String(text).match(/(\d{4})\.(\d+)\.(\d+)/)
  if (!match) return undefined
  return match.slice(1, 4).map(Number)
}

export function supportsMinimumVersion(version, minimum = MIN_OPENCLAW_VERSION) {
  if (!version) return false
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] > minimum[index]) return true
    if (version[index] < minimum[index]) return false
  }
  return true
}

export function planGlobalToolPolicy(toolsValue) {
  const tools = toolsValue && typeof toolsValue === "object" ? toolsValue : {}
  const allow = stringArray(tools.allow)
  const alsoAllow = stringArray(tools.alsoAllow)
  const deny = stringArray(tools.deny)
  const deniedTools = deniedTelemTools(deny)

  if (Array.isArray(tools.allow)) {
    const after = unique([...allow, ...TELEM_TOOLS])
    return {
      path: "tools.allow",
      before: allow,
      after,
      changed: after.length !== allow.length,
      deniedTools,
    }
  }

  if (typeof tools.profile === "string" || Array.isArray(tools.alsoAllow)) {
    const after = unique([...alsoAllow, ...TELEM_TOOLS])
    return {
      path: "tools.alsoAllow",
      before: alsoAllow,
      after,
      changed: after.length !== alsoAllow.length,
      deniedTools,
    }
  }

  return {
    path: undefined,
    before: [],
    after: [],
    changed: false,
    deniedTools,
  }
}

export function findAgentPolicyWarnings(agentsValue, effectiveGlobalTools = TELEM_TOOLS) {
  const agents =
    agentsValue && typeof agentsValue === "object" && Array.isArray(agentsValue.list)
      ? agentsValue.list
      : []
  const warnings = []

  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || !agent.tools || typeof agent.tools !== "object") {
      continue
    }
    const id = typeof agent.id === "string" ? agent.id : "(unnamed agent)"
    const tools = agent.tools
    const deny = stringArray(tools.deny)
    const denied = deniedTelemTools(deny)
    if (denied.length) {
      warnings.push(`${id}: explicit tools.deny still blocks ${denied.join(", ")}`)
    }

    if (Array.isArray(tools.allow)) {
      const allow = stringArray(tools.allow)
      const missing = TELEM_TOOLS.filter((name) => !allow.includes(name))
      if (missing.length) {
        warnings.push(`${id}: agent tools.allow does not include ${missing.join(", ")}`)
      }
      continue
    }

    // Agent-level alsoAllow replaces the global additive list. If an agent has
    // one, it must name Telem itself; otherwise the global setup cannot reach it.
    if (Array.isArray(tools.alsoAllow)) {
      const alsoAllow = stringArray(tools.alsoAllow)
      const missing = TELEM_TOOLS.filter((name) => !alsoAllow.includes(name))
      if (missing.length) {
        warnings.push(`${id}: agent tools.alsoAllow does not include ${missing.join(", ")}`)
      }
      continue
    }

    if (
      typeof tools.profile === "string" &&
      TELEM_TOOLS.some((name) => !effectiveGlobalTools.includes(name))
    ) {
      warnings.push(`${id}: restrictive profile may hide Telem tools`)
    }
  }

  return warnings
}

export function summarizeRuntimeInspect(value) {
  const toolNames = new Set()
  const hookNames = new Set()
  for (const name of stringArray(value?.plugin?.toolNames)) toolNames.add(name)
  for (const tool of Array.isArray(value?.tools) ? value.tools : []) {
    const name = tool?.name ?? tool?.id ?? tool?.toolName
    if (typeof name === "string") toolNames.add(name)
  }
  for (const hook of Array.isArray(value?.typedHooks) ? value.typedHooks : []) {
    const name = hook?.name ?? hook?.event ?? hook?.hookName
    if (typeof name === "string") hookNames.add(name)
  }
  for (const name of stringArray(value?.plugin?.hookNames)) hookNames.add(name)
  return {
    tools: [...toolNames],
    hooks: [...hookNames],
    missingTools: TELEM_TOOLS.filter((name) => !toolNames.has(name)),
    missingHooks: TELEM_HOOKS.filter((name) => !hookNames.has(name)),
  }
}

function parseArgs(argv) {
  const options = {
    check: false,
    json: false,
    yes: false,
    restart: true,
    help: false,
  }
  for (const arg of argv) {
    if (arg === "--check") options.check = true
    else if (arg === "--json") options.json = true
    else if (arg === "--yes") options.yes = true
    else if (arg === "--no-restart") options.restart = false
    else if (arg === "--help" || arg === "-h") options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function helpText() {
  return `Telem OpenClaw setup

Usage:
  npm run setup
  npm run setup -- --check
  node scripts/setup.mjs --check --json
  node scripts/setup.mjs --yes --json [--no-restart]

Options:
  --check       Inspect setup without changing anything
  --json        Print the setup report as JSON
  --yes         Apply without an interactive confirmation
  --no-restart  Do not restart the OpenClaw Gateway
`
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  })
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  if (result.error) {
    throw new Error(`${command} could not run: ${result.error.message}`)
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n")
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`)
  }
  return { status: result.status ?? 1, stdout, stderr }
}

function runOpenClaw(args, options) {
  return run("openclaw", args, options)
}

function readConfig(path) {
  const result = runOpenClaw(["config", "get", path, "--json"], { allowFailure: true })
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`
    if (detail.includes("Config path not found")) return undefined
    throw new Error(`Could not read OpenClaw config path ${path}:\n${detail.trim()}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`OpenClaw returned invalid JSON for config path ${path}`)
  }
}

function inspectPlugin(runtime = false) {
  const args = ["plugins", "inspect", "telem", "--json"]
  if (runtime) args.splice(3, 0, "--runtime")
  const result = runOpenClaw(args, { allowFailure: true })
  if (result.status !== 0) return undefined
  try {
    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

function printHumanPlan(report) {
  console.log(`OpenClaw: ${report.openclawVersion}`)
  console.log(`Telem server: ${report.baseUrl} (${report.baseUrlSource})`)
  const credentialText =
    report.credential === "environment"
      ? "found in TELEM_API_KEY"
      : report.credential === "config"
        ? "found in plugin config"
        : "not found; requests will omit authentication"
  console.log(`Telem API key: ${credentialText}`)
  console.log("Plugin: install or update from this checkout")
  if (report.staleLinkedPaths.length) {
    console.log(`Replace old linked checkout: ${report.staleLinkedPaths.join(", ")}`)
  }
  if (report.obsoleteConfigPaths.length) {
    console.log(`Remove old settings: ${report.obsoleteConfigPaths.join(", ")}`)
  }
  if (report.toolPolicy.changed) {
    console.log(`Enable tools through ${report.toolPolicy.path}: ${TELEM_TOOLS.join(", ")}`)
  } else {
    console.log("Tool policy: no global change needed")
  }
  console.log(
    report.mode === "check"
      ? "After setup: built-in web_search and web_fetch will be blocked while Telem is enabled"
      : "Built-in web_search and web_fetch: blocked while Telem is enabled",
  )
  for (const warning of report.warnings) console.log(`Warning: ${warning}`)
}

async function confirmApply() {
  if (!input.isTTY) {
    throw new Error("Interactive confirmation is unavailable; rerun with --yes after reviewing --check")
  }
  const prompt = createInterface({ input, output })
  try {
    const answer = await prompt.question("Apply these changes? [y/N] ")
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    prompt.close()
  }
}

function applyConfigChange(args) {
  runOpenClaw([...args, "--dry-run"])
  runOpenClaw(args)
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(helpText())
    return
  }
  if (options.json && !options.check && !options.yes) {
    throw new Error("--json apply mode requires --yes so prompts cannot corrupt JSON output")
  }

  const versionResult = runOpenClaw(["--version"])
  const version = parseOpenClawVersion(`${versionResult.stdout}\n${versionResult.stderr}`)
  if (!supportsMinimumVersion(version)) {
    throw new Error(
      `OpenClaw ${MIN_OPENCLAW_VERSION.join(".")} or newer is required; found ${version?.join(".") ?? "an unknown version"}`,
    )
  }
  runOpenClaw(["config", "validate"])

  const tools = readConfig("tools") ?? {}
  const agents = readConfig("agents") ?? {}
  const pluginConfig = readConfig("plugins.entries.telem.config") ?? {}
  const pluginLoadPaths = stringArray(readConfig("plugins.load.paths"))
  const toolPolicy = planGlobalToolPolicy(tools)
  const effectiveGlobalTools =
    toolPolicy.path === "tools.alsoAllow" ? toolPolicy.after : stringArray(tools.alsoAllow)
  const obsoleteConfigPaths = OBSOLETE_CONFIG_PATHS.filter((path) => {
    const key = path.split(".").at(-1)
    return key && Object.prototype.hasOwnProperty.call(pluginConfig, key)
  })
  const warnings = [
    ...toolPolicy.deniedTools.map(
      (name) => `global tools.deny explicitly blocks ${name}; setup will not remove it`,
    ),
    ...findAgentPolicyWarnings(agents, effectiveGlobalTools),
  ]
  const existingPlugin = inspectPlugin(false)
  const installedSource =
    typeof existingPlugin?.plugin?.rootDir === "string"
      ? resolve(existingPlugin.plugin.rootDir)
      : undefined
  const staleLinkedPaths =
    installedSource && installedSource !== pluginRoot
      ? pluginLoadPaths.filter((path) => resolve(path) === installedSource)
      : []
  const endpoint = resolveReportBaseUrl(pluginConfig, process.env)
  const report = {
    mode: options.check ? "check" : "apply",
    openclawVersion: version.join("."),
    baseUrl: endpoint.baseUrl,
    baseUrlSource: endpoint.source,
    credential: process.env.TELEM_API_KEY
      ? "environment"
      : typeof pluginConfig.apiKey === "string" && pluginConfig.apiKey.trim()
        ? "config"
        : "missing",
    pluginRoot,
    installedSource,
    staleLinkedPaths,
    obsoleteConfigPaths,
    toolPolicy,
    warnings,
    builtinsChanged: false,
  }

  if (options.check) {
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else printHumanPlan(report)
    return
  }

  if (!options.json) printHumanPlan(report)
  if (!options.yes && !(await confirmApply())) {
    if (!options.json) console.log("No changes made.")
    return
  }

  for (const path of obsoleteConfigPaths) {
    applyConfigChange(["config", "unset", path])
  }
  if (staleLinkedPaths.length) {
    const nextPaths = pluginLoadPaths.filter((path) => !staleLinkedPaths.includes(path))
    applyConfigChange([
      "config",
      "set",
      "plugins.load.paths",
      JSON.stringify(nextPaths),
      "--strict-json",
    ])
  }
  if (toolPolicy.changed && toolPolicy.path) {
    applyConfigChange([
      "config",
      "set",
      toolPolicy.path,
      JSON.stringify(toolPolicy.after),
      "--strict-json",
    ])
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
  run(npmCommand, ["ci"], { cwd: pluginRoot })
  // This checkout intentionally ships a TypeScript entrypoint. OpenClaw only
  // permits TypeScript source fallback for linked local-development installs;
  // copied/package installs require compiled JavaScript.
  runOpenClaw(["plugins", "install", "--link", pluginRoot])
  runOpenClaw(["config", "validate"])

  const applyWarnings = [...warnings]
  if (options.restart) {
    const restart = runOpenClaw(["gateway", "restart", "--safe", "--json"], {
      allowFailure: true,
    })
    if (restart.status !== 0) {
      applyWarnings.push("Gateway restart did not complete; restart the active Gateway manually")
    }
  }
  const gatewayStatus = runOpenClaw(["gateway", "status", "--deep", "--require-rpc"], {
    allowFailure: true,
  })
  if (gatewayStatus.status !== 0) {
    applyWarnings.push("The active Gateway could not be confirmed")
  }

  const runtime = inspectPlugin(true)
  if (!runtime) throw new Error("OpenClaw could not inspect the Telem runtime after installation")
  const runtimeSummary = summarizeRuntimeInspect(runtime)
  if (runtimeSummary.missingTools.length) {
    throw new Error(
      `Telem runtime is missing registered tools: ${runtimeSummary.missingTools.join(", ")}`,
    )
  }
  if (runtimeSummary.missingHooks.length) {
    throw new Error(
      `Telem runtime is missing registered hooks: ${runtimeSummary.missingHooks.join(", ")}`,
    )
  }

  const result = {
    ...report,
    mode: "applied",
    warnings: unique(applyWarnings),
    runtime: runtimeSummary,
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`Installed Telem tools: ${runtimeSummary.tools.join(", ")}`)
    for (const warning of unique(applyWarnings)) console.log(`Warning: ${warning}`)
    console.log("Telem OpenClaw setup complete.")
  }
}

// argv[1] stays the path AS INVOKED — for an npm bin, that's the node_modules/.bin/
// symlink, not its target. import.meta.url, by contrast, is already the entry
// module's real path (Node resolves symlinks when loading it). Comparing argv[1]
// verbatim against that real path — as a plain `resolve` does — never matches
// through a symlink, so `npx @telemai/openclaw-plugin telem-openclaw-setup` and
// `node_modules/.bin/telem-openclaw-setup` both silently no-op: isMain is always
// false and main never runs. Realpath-ing argv[1] before comparing fixes it.
const argv1 = process.argv[1]
let isMain = false
try {
  isMain = argv1 ? realpathSync(argv1) === fileURLToPath(import.meta.url) : false
} catch {
  // argv1 pointing nowhere real (e.g. `node -e`) is not this entry point.
}
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
