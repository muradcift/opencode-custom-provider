import type { Context } from "@opencode-ai/plugin/tui/context"
import {
  deleteKeyFileEntry,
  discoverModels,
  globalConfigPath,
  listCustomProviders,
  loadConfig,
  readKeys,
  saveConfig,
  validBaseURL,
  validId,
  writeKeyFile,
} from "./src/shared.js"

async function runWizard(ctx: Context) {
  const action = await ctx.ui.dialog.select({
    title: "Custom provider",
    options: [
      { title: "Add...", value: "add" },
      { title: "Edit models...", value: "edit" },
      { title: "Delete...", value: "remove" },
    ],
  })
  if (action === "edit") {
    await editModelsFlow(ctx)
    return
  }
  if (action === "remove") {
    await deleteFlow(ctx)
    return
  }
  if (action !== "add") return
  await addFlow(ctx)
}

async function syncCatalog(ctx: Context) {
  try {
    await ctx.data.location.provider.sync()
    await ctx.data.location.model.sync()
  } catch {
    // optional; the config watcher reloads anyway
  }
}

function toast(ctx: Context, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  ctx.ui.toast.show({ title: "Custom provider", message, variant })
}

async function addFlow(ctx: Context) {
  const dialog = ctx.ui.dialog

  const rawId = await dialog.prompt({
    title: "Provider ID",
    description: "Lowercase, digits, dot, dash. E.g. acme",
    placeholder: "acme",
  })
  if (!rawId) return
  const id = rawId.trim()
  if (!id || !validId(id)) {
    await dialog.alert({ title: "Invalid ID", message: `"${id}" is not accepted. Use letters, digits, dot, dash, underscore.` })
    return
  }

  const rawBaseURL = await dialog.prompt({
    title: "Base URL",
    description: "OpenAI-compatible endpoint. E.g. https://llm.acme.example/v1",
    placeholder: "https://llm.acme.example/v1",
  })
  if (!rawBaseURL) return
  const baseURL = rawBaseURL.trim()
  if (!baseURL || !validBaseURL(baseURL)) {
    await dialog.alert({ title: "Invalid URL", message: `"${baseURL}" is not an http(s) URL.` })
    return
  }

  const rawKey = await dialog.prompt({
    title: "API key (optional)",
    description: "Paste it when the endpoint needs a key. Never written to config, stored separately. May be empty.",
    placeholder: "sk-...",
  })
  if (rawKey === undefined) return
  const apiKey = rawKey.trim()

  const models = await pickModels(ctx, baseURL, apiKey)
  if (!models || !models.length) return

  if (apiKey) writeKeyFile(id, apiKey)
  await writeProvider(ctx, { id, baseURL, models })
}

async function pickModels(ctx: Context, baseURL: string, apiKey: string): Promise<string[] | undefined> {
  const dialog = ctx.ui.dialog
  const found = await discoverModels(baseURL, apiKey || undefined)
  if (!found.ids) {
    const why =
      found.error === "auth"
        ? "The endpoint requires a key (401). Make sure the key is correct."
        : found.error === "empty"
          ? "The endpoint returned an empty list."
          : found.error === "network"
            ? "The endpoint is unreachable."
            : `The endpoint errored (${found.error}).`
    toast(ctx, `Could not fetch the model list: ${why} Enter manually.`)
    const manual = await dialog.prompt({
      title: "Model ID",
      description: "Model ID as shown in the catalog. E.g. coder",
      placeholder: "coder",
    })
    const m = (manual || "").trim()
    return m ? [m] : undefined
  }
  const ids = found.ids
  const selected: string[] = []
  let remaining = [...ids]
  for (;;) {
    const picked = await dialog.select({
      title: selected.length ? `Select model (${selected.length} selected, Finish on top)` : "Select model",
      placeholder: `${remaining.length} models found`,
      options: [
        ...(selected.length ? [{ title: `Finish (${selected.length} model(s))`, value: "__done" }] : []),
        ...remaining.map((m) => ({ title: m, value: m })),
        ...(selected.length === 0 ? [{ title: `All (${ids.length})`, value: "__all" }] : []),
        { title: "Enter manually...", value: "__manual" },
      ],
    })
    if (!picked || picked === "__done") return selected.length ? selected : undefined
    if (picked === "__all") {
      const okAll = await dialog.confirm({
        title: `Add all ${ids.length} models?`,
        message: "All of them will be written to the config.",
        label: { confirm: "Add all", cancel: "Cancel" },
      })
      if (okAll) return ids
      continue
    }
    if (picked === "__manual") {
      const manual = await dialog.prompt({
        title: "Model ID",
        description: "Model ID as shown in the catalog. E.g. coder",
        placeholder: "coder",
      })
      const m = (manual || "").trim()
      if (m && !selected.includes(m)) selected.push(m)
      if (!selected.length) continue
      return selected
    }
    if (!selected.includes(picked)) selected.push(picked)
    remaining = remaining.filter((m) => m !== picked)
    if (!remaining.length) return selected
  }
}

async function writeProvider(ctx: Context, { id, baseURL, models }: { id: string; baseURL: string; models: string[] }) {
  const dialog = ctx.ui.dialog
  const file = globalConfigPath()
  let config: Record<string, any>
  try {
    config = loadConfig(file)
  } catch (e) {
    await dialog.alert({ title: "Cannot read config", message: `${file}: ${(e as Error).message}` })
    return
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    await dialog.alert({ title: "Config corrupt", message: "Root is not an object, fix it manually." })
    return
  }
  if (!config.providers || typeof config.providers !== "object") config.providers = {}

  if (config.providers[id]) {
    const overwrite = await dialog.confirm({
      title: `"${id}" already exists`,
      message: "Overwrite? Existing models are kept, same IDs merge.",
      label: { confirm: "Overwrite", cancel: "Cancel" },
    })
    if (!overwrite) return
  }

  const previous = config.providers[id]
  const mergedModels: Record<string, { name: string }> = { ...((previous && previous.models) || {}) }
  for (const m of models) {
    if (!mergedModels[m]) mergedModels[m] = { name: m }
  }
  config.providers[id] = {
    name: id,
    package: "@opencode-ai/ai/providers/openai-compatible",
    settings: { baseURL },
    models: mergedModels,
  }
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json"

  try {
    saveConfig(file, config)
  } catch (e) {
    await dialog.alert({ title: "Cannot write", message: `${file}: ${(e as Error).message}` })
    return
  }
  await syncCatalog(ctx)
  toast(ctx, `Added: ${id} (${models.length} model(s)) -> pick one from /models to test.`, "success")
}

async function editModelsFlow(ctx: Context) {
  const dialog = ctx.ui.dialog
  const ids = listCustomProviders()
  if (!ids.length) {
    await dialog.alert({ title: "Nothing registered", message: "No custom provider in config." })
    return
  }
  const pid = await dialog.select({
    title: "Provider to edit",
    options: ids.map((id) => ({ title: id, value: id })),
  })
  if (!pid) return

  let entry: any
  try {
    const config = loadConfig(globalConfigPath())
    entry = config && config.providers && config.providers[pid]
  } catch (e) {
    await dialog.alert({ title: "Cannot read config", message: (e as Error).message })
    return
  }
  if (!entry) {
    await dialog.alert({ title: "Not found", message: `"${pid}" is not in config.` })
    return
  }
  const baseURL = entry.settings && entry.settings.baseURL
  const stored = readKeys()[pid]
  const key = typeof stored === "string" && stored ? stored : undefined
  let discovered: string[] = []
  if (baseURL) {
    const r = await discoverModels(baseURL, key)
    if (r.ids) {
      discovered = r.ids
    } else {
      toast(ctx, r.error === "auth" ? "Endpoint requires a key, continuing with the current list." : "List unavailable, continuing with the current list.")
    }
  }

  const current = new Set<string>(Object.keys(entry.models || {}))
  if (!current.size && !discovered.length) {
    const manual = await dialog.prompt({ title: "Model ID", placeholder: "coder" })
    const m = (manual || "").trim()
    if (m) current.add(m)
    else return
  }
  for (;;) {
    const fresh = discovered.filter((m) => !current.has(m))
    const kept = [...current]
    const picked = await dialog.select({
      title: `${pid} (${current.size} model(s))`,
      placeholder: "+ adds, ✓ removes, Finish saves",
      options: [
        { title: `Finish (${current.size} model(s))`, value: "__done" },
        ...fresh.map((m) => ({ title: `+ ${m}`, value: `+${m}` })),
        ...kept.map((m) => ({ title: `✓ ${m} (remove)`, value: `-${m}` })),
        { title: "Add manually...", value: "__manual" },
      ],
    })
    if (!picked || picked === "__done") break
    if (picked === "__manual") {
      const manual = await dialog.prompt({ title: "Model ID", placeholder: "coder" })
      const m = (manual || "").trim()
      if (m) current.add(m)
      continue
    }
    if (picked.startsWith("+")) {
      current.add(picked.slice(1))
      continue
    }
    if (picked.startsWith("-")) {
      current.delete(picked.slice(1))
      continue
    }
  }
  if (!current.size) {
    await dialog.alert({ title: "Cannot be empty", message: "At least 1 model must remain. Use Delete to remove the provider." })
    return
  }
  try {
    const file = globalConfigPath()
    const config = loadConfig(file)
    const target = config.providers[pid]
    const models: Record<string, { name: string }> = {}
    for (const m of current) {
      models[m] = (target.models && target.models[m]) || { name: m }
    }
    target.models = models
    saveConfig(file, config)
  } catch (e) {
    await dialog.alert({ title: "Cannot write", message: (e as Error).message })
    return
  }
  await syncCatalog(ctx)
  toast(ctx, `Saved: ${pid} (${current.size} model(s)).`, "success")
}

async function deleteFlow(ctx: Context) {
  const dialog = ctx.ui.dialog
  const ids = listCustomProviders()
  if (!ids.length) {
    await dialog.alert({ title: "Nothing registered", message: "No custom provider in config." })
    return
  }
  const picked = await dialog.select({
    title: "Provider to delete",
    options: ids.map((id) => ({ title: id, value: id })),
  })
  if (!picked) return
  const okGo = await dialog.confirm({
    title: `Delete "${picked}"?`,
    message: "Config entry and stored key are removed. A backup is taken.",
    label: { confirm: "Delete", cancel: "Cancel" },
  })
  if (!okGo) return
  try {
    const file = globalConfigPath()
    const config = loadConfig(file)
    delete config.providers[picked]
    if (Object.keys(config.providers).length === 0) delete config.providers
    saveConfig(file, config)
    deleteKeyFileEntry(picked)
  } catch (e) {
    await dialog.alert({ title: "Cannot delete", message: (e as Error).message })
    return
  }
  await syncCatalog(ctx)
  toast(ctx, `Deleted: ${picked}.`, "success")
}

export default {
  id: "custom-provider-palette",
  setup(ctx: Context) {
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "custom-provider.add",
          title: "Custom provider add/remove",
          group: "Provider",
          description: "Add, edit or delete custom OpenAI-compatible providers in opencode.jsonc",
          palette: true,
          slash: { name: "custom-provider" },
          run: () => runWizard(ctx),
        },
      ],
      bindings: ["custom-provider.add"],
    }))
  },
}
