export const TELEM_TOOLS: string[]
export const TELEM_HOOKS: string[]
export const MIN_OPENCLAW_VERSION: number[]
export const OBSOLETE_CONFIG_PATHS: string[]
export const DEFAULT_TELEM_BASE_URL: string

export function resolveReportBaseUrl(
  pluginConfig?: { baseUrl?: unknown } | null,
  env?: Record<string, string | undefined>,
): { baseUrl: string; source: "plugin config" | "TELEM_BASE_URL override" | "hosted default" }
export function parseOpenClawVersion(text: string): number[] | undefined
export function supportsMinimumVersion(version?: number[], minimum?: number[]): boolean
export function planGlobalToolPolicy(toolsValue: unknown): {
  path?: string
  before: string[]
  after: string[]
  changed: boolean
  deniedTools: string[]
}
export function findAgentPolicyWarnings(
  agentsValue: unknown,
  effectiveGlobalTools?: string[],
): string[]
export function summarizeRuntimeInspect(value: unknown): {
  tools: string[]
  hooks: string[]
  missingTools: string[]
  missingHooks: string[]
}
export function main(argv?: string[]): Promise<void>
