# opencode-custom-provider

Add, edit and delete custom OpenAI-compatible providers in OpenCode, from the command palette. No forks, no manual JSON.

## Install

```sh
opencode plugin add github:muradcift/opencode-custom-provider
```

Or reference a local checkout in `opencode.jsonc`:

```jsonc
{
  "plugins": ["file:///path/to/opencode-custom-provider"],
}
```

## Use

`Ctrl+P` → **Custom provider add/remove**, or `/custom-provider`:

- **Add** – asks for ID, base URL and API key, fetches `/models` from the endpoint, lets you pick one, many or all, then writes them to `providers` in `opencode.jsonc`.
- **Edit models** – rescans the endpoint, `+` adds and `✓` removes, Finish saves.
- **Delete** – removes the provider and its stored key (a backup is taken first).

Keys are kept in `.custom-provider-keys.json` (`0600`) and injected per request. Raw keys never land in the config, no ENV vars or restarts needed.

Notes:

- OpenCode v2 treats `providers.<id>.models` as an **overlay** on its built-in models.dev catalog, not as a whitelist. If your provider ID also exists in that catalog (e.g. `nvidia`), OpenCode imports every catalog model first and only then applies your entries. The plugin fetches the catalog (`models.dev/api.json`) and writes `disabled: true` stubs for all unselected catalog models, because `disabled` is the only way to subtract a built-in model. Removing such a model keeps its stub (otherwise it reappears); re-adding it clears `disabled`. Prefer a unique provider ID (e.g. `nvidia-local`) when you want a config with no disabled stubs. If the catalog cannot be fetched, the provider is still written but unselected built-in models may temporarily remain visible.
- Every save rewrites `opencode.jsonc` as plain JSON, so your comments there are lost. A timestamped backup (`opencode.jsonc.bak-*`) is written next to it first.
- Every save also refuses to write when the config changed on disk since it was read (another session, `opencode plugin add`, a hand edit). Without that check a read-modify-write silently dropped whatever the other writer had added — including the whole `providers` block. Re-run the command and it applies on top of the current file.
- The TUI Add flow only takes a raw key (or empty); for `{env:VAR}`-based auth use the `custom_provider_add` tool with `apiKeyEnv`.
- After upstream fixes, refresh a git-installed copy with `opencode plugin update github:muradcift/opencode-custom-provider`.
- Each model is stored with explicit `limit` (context/output, input when known) and `capabilities` (tools, input/output modalities). Values are scraped from `/models` extras when the server provides them (e.g. `max_model_len`, `context_length`); anything missing is asked in the TUI or falls back to OpenCode defaults (200000 context, 32000 output), written out explicitly.

## Local setup backup

`local/opencode.global.json` is a copy of the global `~/.config/opencode/opencode.json` this repo was last used
with: the plugin entry plus the `providers.opencode.models` block that hides OpenCode Zen's paid models and re-enables
`mimo-v2.5-free` (models.dev marks it deprecated while Zen still serves it free). It holds no secrets — keys live in
`.custom-provider-keys.json`. Copy it over the global config to get back to a known-good state in one step.

## Local development

The plugin must be discoverable under `<config>/plugins/`. Point a junction at the checkout (code stays in the repo):

```powershell
cmd /c mklink /J "%USERPROFILE%\.config\opencode\plugins\custom-provider" "D:\path\to\opencode-custom-provider"
```

Then restart the service once: `opencode service restart`.

Dev tooling (`tsc`, types) is intentionally not a dependency so installs stay lean; add it locally when needed:

```sh
npm install -D typescript @types/node @opencode-ai/plugin@beta
```
