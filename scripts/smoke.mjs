// The public check for a bundle that cannot be imported outside its host.
//
// `dist/index.js` imports `openclaw`, which only exists inside a real OpenClaw install,
// so `await import` can never work in CI the way it does for the other packages. What
// is checkable without a host is the shape of the bundle: it parses, it is not a stub,
// and the only bare imports it left unresolved are the two the build declares external.
// That is the failure worth catching — an external dropped from the build line turns
// into a runtime crash in someone's editor, not a build error here.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"

const ENTRY = "dist/index.js"
const ALLOWED = new Set(["openclaw", "typebox"])

execFileSync(process.execPath, ["--check", ENTRY], { stdio: "pipe" })

const size = statSync(ENTRY).size
assert.ok(size > 10_000, `${ENTRY} is ${size} bytes — the bundle looks empty`)

const source = readFileSync(ENTRY, "utf8")
const bare = new Set()
for (const match of source.matchAll(/(?:^|[\s;}])(?:import|export)\s*(?:[\w*{},\s]*?\s*from\s*)?["']([^"']+)["']/g)) {
  const specifier = match[1]
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue
  bare.add(specifier)
}
/** `openclaw/plugin-sdk/plugin-entry` is the `openclaw` package; compare package roots. */
const packageOf = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")
for (const specifier of bare) {
  const pkg = packageOf(specifier)
  assert.ok(ALLOWED.has(pkg), `${ENTRY} imports "${specifier}", which is neither bundled nor a declared external`)
}

console.log(`ok: @telemai/openclaw-plugin bundles to ${size} bytes, externals ${[...bare].sort().join(", ") || "(none)"}`)
