# opencode-custom-provider

Add, edit and delete custom OpenAI-compatible providers in OpenCode, from the command palette. No forks, no manual JSON.

## Install

```sh
opencode2 plugin add github:muradcift/opencode-custom-provider
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

## Local development

The plugin must be discoverable under `<config>/plugins/`. Point a junction at the checkout (code stays in the repo):

```powershell
cmd /c mklink /J "%USERPROFILE%\.config\opencode\plugins\custom-provider" "D:\path\to\opencode-custom-provider"
```

Then restart the service once: `opencode2 service restart`.

Dev tooling (`tsc`, types) is intentionally not a dependency so installs stay lean; add it locally when needed:

```sh
npm install -D typescript @types/node solid-js @opencode-ai/plugin@beta
```
