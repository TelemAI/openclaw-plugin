# @telemai/openclaw-plugin

Web search and page fetch for [OpenClaw](https://openclaw.ai), backed by
[Telem](https://telem.ai) — one query fans out across multiple search providers and
comes back as one normalized, provider-attributed result set.

Requires **OpenClaw >= 2026.7.1**.

## Install

The guided installer is the quickest path — it configures the plugin and captures
your API key from [app.telem.ai](https://app.telem.ai) in one pass:

```bash
npm create @telemai
```

Pick **OpenClaw** when it asks, or skip the interview entirely:

```bash
npm create @telemai -- --client openclaw
```

### By hand

Set the endpoint and your key explicitly — `npm create @telemai` writes both for you:

```bash
openclaw plugins install npm:@telemai/openclaw-plugin
echo "TELEM_BASE_URL=https://router.telem.ai" >> ~/.openclaw/.env
echo "TELEM_API_KEY=tlm_..." >> ~/.openclaw/.env   # from https://app.telem.ai
openclaw gateway restart
```

`openclaw plugins install` enables the plugin, adds `telem` to an existing
`plugins.allow`, and removes it from `plugins.deny`.

Get an API key from [app.telem.ai](https://app.telem.ai). It is optional — skip the
`echo` line if your account doesn't need one — and it can live in the Gateway
environment as above or in the plugin's own config; see
[Configuration](#configuration).

Check the install without changing anything:

```bash
npx --yes --package=@telemai/openclaw-plugin telem-openclaw-setup --check
```

## Tools

| Tool | Arguments |
| --- | --- |
| `telem_search` | `queries[]` (at least one), optional `goal` label |
| `telem_fetch` | `urls[]` — 1 to 5 http(s) URLs |

`telem_search` returns snippets. To read a whole page, use `telem_fetch`.

While the plugin is enabled it also asks the agent to prefer these tools and blocks
OpenClaw's built-in `web_search` and `web_fetch`, telling the agent which Telem tool to
use instead. Other third-party tools are untouched. Disable the plugin and the built-ins
resume immediately; operators can keep the plugin but suppress the prompt with
`plugins.entries.telem.hooks.allowPromptInjection=false`.

## Configuration

The plugin defaults to the hosted Telem service at `https://router.telem.ai`.
Operators can override that default with `plugins.entries.telem.config.baseUrl`
or with `TELEM_BASE_URL`, in that order. Resolution happens per tool call, and
trailing slashes are removed before endpoint paths are appended.

| Config key | Env fallback | Meaning |
| --- | --- | --- |
| `baseUrl` | `TELEM_BASE_URL` | Service endpoint override |
| `apiKey` | `TELEM_API_KEY` | Optional bearer credential |
| `tier` | `TELEM_TIER` | Named result-field tier: `minimalist`, `default`, `extended`, or `max` |
| `fields` | `TELEM_FIELDS` (comma-separated) | Explicit normalized fields; mutually exclusive with `tier` |
| `providersInclude` | `TELEM_PROVIDERS_INCLUDE` (comma-separated) | Replace the deployment provider set |
| `providersExclude` | `TELEM_PROVIDERS_EXCLUDE` (comma-separated) | Subtract providers from the selected set |
| `fullContent` | `TELEM_FULL_CONTENT` (`1` only) | Retrieve full content for the interaction; never render it inline |

```json5
{
  plugins: {
    entries: {
      telem: {
        enabled: true,
        config: {
          apiKey: "tlm_...",
          tier: "extended",
          providersInclude: ["exa", "tavily"],
          providersExclude: ["tavily"],
          fullContent: false,
        },
      },
    },
  },
}
```

Prefer `TELEM_API_KEY` in the Gateway environment over plaintext config. The setup
helper reports whether the environment variable exists but never prints or stores
its value.

Resolution is per key and per tool call: plugin config overrides the environment.
If both `tier` and `fields` resolve, the more-specific source wins; on a tie `fields`
wins, and the plugin logs a warning. Provider include/exclude lists are forwarded
unchanged for the server to compose and validate.

The old `providers` config key and `TELEM_PROVIDERS` environment variable have been
**removed**; use `providersInclude` / `TELEM_PROVIDERS_INCLUDE`. The setup helper
strips a leftover `providers` config value.

`fullContent: true` asks providers to retrieve full-page content for storage in the
interaction, but search output intentionally omits it. Use `telem_fetch` when the model
needs to read a page.

## Troubleshooting

### A Telem tool is missing

Run:

```bash
openclaw config validate
openclaw plugins inspect telem --runtime --json
npx --yes --package=@telemai/openclaw-plugin telem-openclaw-setup --check
```

Look for a warning about `tools.deny` or an agent-specific tool policy. The helper
does not override those policies.

### The plugin is installed but the active Gateway is stale

Run:

```bash
openclaw gateway status --deep --require-rpc
openclaw gateway restart --safe
```

Make sure the restart targets the Gateway that actually serves the user's channels.

### Authentication is missing

Get a key from [app.telem.ai](https://app.telem.ai) first, then check that the plugin
can actually see it. Either location works — plugin config takes precedence, and the
environment keeps the key out of a config file:

```bash
# Gateway environment
echo "TELEM_API_KEY=tlm_..." >> ~/.openclaw/.env
openclaw gateway restart
```

```json5
// or plugin config
{ plugins: { entries: { telem: { config: { apiKey: "tlm_..." } } } } }
```

If you used the environment, confirm the key is in the **Gateway's** environment and
not only in the interactive shell you ran setup from — those are different, and it is
the usual cause. The setup helper reports presence without revealing the value:

```bash
npx --yes --package=@telemai/openclaw-plugin telem-openclaw-setup --check
```

### Remove the plugin

```bash
openclaw plugins uninstall telem
```

If the setup helper added `telem_search` or `telem_fetch` to a global tool list,
remove only those two entries with OpenClaw's config commands while preserving
every unrelated entry.

## License

Copyright (c) 2026 Telem AI. Licensed under the [Apache License, Version 2.0](LICENSE).
