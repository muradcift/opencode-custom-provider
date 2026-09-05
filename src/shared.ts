import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface ModelEntry {
  name: string
  modelID?: string
}

export interface ProviderEntry {
  name: string
  package: string
  settings: {
    baseURL: string
    apiKey?: string
  }
  models: Record<string, ModelEntry>
}

export interface ProviderInput {
  id: string
  baseURL: string
  model: string
  name?: string
  modelName?: string
  modelUpstream?: string
  extraModels?: string[]
  apiKeyEnv?: string
  apiKey?: string
  overwrite?: boolean
}

const OPENAI_COMPATIBLE = "@opencode-ai/ai/providers/openai-compatible"

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function globalConfigPath(): string {
  const override = process.env.OPENCODE_CONFIG_TEST
  if (override) return override
  const dir = path.join(os.homedir(), ".config", "opencode")
  const jsonc = path.join(dir, "opencode.jsonc")
  if (fs.existsSync(jsonc)) return jsonc
  return path.join(dir, "opencode.json")
}

export function keysFile(): string {
  const override = process.env.OPENCODE_KEYS_TEST
  if (override) return override
  return path.join(os.homedir(), ".config", "opencode", ".custom-provider-keys.json")
}

export function readKeys(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(keysFile(), "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
  } catch {
    // missing or corrupt -> no keys
  }
  return {}
}

export function writeKeyFile(providerID: string, apiKey: string): string {
  const file = keysFile()
  const keys = readKeys()
  keys[providerID] = apiKey
  fs.writeFileSync(file, JSON.stringify(keys, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // no-op on platforms without POSIX permissions
  }
  return file
}

export function deleteKeyFileEntry(providerID: string): void {
  try {
    const keys = readKeys()
    if (keys[providerID] !== undefined) {
      delete keys[providerID]
      fs.writeFileSync(keysFile(), JSON.stringify(keys, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
    }
  } catch {
    // key storage is optional
  }
}

function stripJsonComments(text: string): string {
  let out = ""
  let i = 0
  let inStr = false
  let quote = ""
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (inStr) {
      out += ch
      if (ch === "\\") {
        out += next ?? ""
        i += 2
        continue
      }
      if (ch === quote) inStr = false
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = true
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

function stripTrailingCommas(text: string): string {
  let out = ""
  let i = 0
  let inStr = false
  let quote = ""
  while (i < text.length) {
    const ch = text[i]
    if (inStr) {
      out += ch
      if (ch === "\\") {
        out += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (ch === quote) inStr = false
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = true
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      const next = text[j]
      if (next === "}" || next === "]") {
        i++
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

export function loadConfig(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {}
  const raw = fs.readFileSync(file, "utf8")
  try {
    return JSON.parse(raw)
  } catch {
    return JSON.parse(stripTrailingCommas(stripJsonComments(raw)))
  }
}

export function saveConfig(file: string, config: Record<string, any>): void {
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    fs.copyFileSync(file, `${file}.bak-${stamp}`)
  }
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8")
}

export function listCustomProviders(): string[] {
  try {
    const config = loadConfig(globalConfigPath())
    if (config && typeof config === "object" && config.providers && typeof config.providers === "object") {
      return Object.keys(config.providers)
    }
  } catch {
    // unreadable -> empty list
  }
  return []
}

export function validId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id)
}

export function validBaseURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

export interface Discovery {
  ids?: string[]
  error?: string
}

export async function discoverModels(baseURL: string, apiKey?: string): Promise<Discovery> {
  const url = baseURL.replace(/\/+$/, "") + "/models"
  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal })
      if (res.status === 401 || res.status === 403) return { error: "auth" }
      if (!res.ok) return { error: `http-${res.status}` }
      let data: unknown
      try {
        data = await res.json()
      } catch {
        return { error: "bad-body" }
      }
      const ids = ((data && (data as any).data) || [])
        .map((m: any) => m && m.id)
        .filter(Boolean)
      const unique = [...new Set(ids as string[])]
      return unique.length ? { ids: unique } : { error: "empty" }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { error: "network" }
  }
}

function normalizeInput(raw: ProviderInput): ProviderInput {
  return {
    ...raw,
    id: trimString(raw.id),
    baseURL: trimString(raw.baseURL),
    model: trimString(raw.model),
    name: raw.name ? trimString(raw.name) : undefined,
    modelName: raw.modelName ? trimString(raw.modelName) : undefined,
    modelUpstream: raw.modelUpstream ? trimString(raw.modelUpstream) : undefined,
    apiKeyEnv: raw.apiKeyEnv ? trimString(raw.apiKeyEnv) : undefined,
    apiKey: raw.apiKey ? trimString(raw.apiKey) : undefined,
  }
}

export function upsertCustomProvider(rawArgs: ProviderInput): string {
  const args = normalizeInput(rawArgs)
  const { id, baseURL } = args
  if (!validId(id)) return `Error: invalid provider ID "${id}". Use letters, digits, dot, dash, underscore.`
  if (!validBaseURL(baseURL)) return `Error: invalid baseURL "${baseURL}". Expected https://example.com/v1.`

  const file = globalConfigPath()
  let config: Record<string, any>
  try {
    config = loadConfig(file)
  } catch (e) {
    return `Error: cannot read config (${file}): ${(e as Error).message}`
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return `Error: config root is corrupt (${file}). Fix it manually first.`
  }
  if (!config.providers || typeof config.providers !== "object") config.providers = {}

  const exists = Boolean(config.providers[id])
  if (exists && !args.overwrite) {
    return (
      `"${id}" already exists. Repeat with overwrite:true to update.\n` +
      `Current: ${JSON.stringify(config.providers[id]).slice(0, 300)}`
    )
  }

  const modelUpstream = args.modelUpstream ?? args.model
  const modelEntry: ModelEntry = { name: args.modelName ?? args.model }
  if (modelUpstream !== args.model) modelEntry.modelID = modelUpstream

  const wanted = [args.model]
  if (Array.isArray(args.extraModels)) {
    for (const m of args.extraModels) {
      const t = trimString(m)
      if (t && !wanted.includes(t)) wanted.push(t)
    }
  }

  const previous = exists ? (config.providers[id] as ProviderEntry) : undefined
  const prevSettings =
    previous && previous.settings && typeof previous.settings === "object" ? previous.settings : {}
  const settings: ProviderEntry["settings"] = { ...prevSettings, baseURL }
  let staleKeyRemoved = false
  if (args.apiKey) {
    // Raw keys never touch the config; the request hook injects them.
    writeKeyFile(id, args.apiKey)
    delete settings.apiKey
  } else if (args.apiKeyEnv) {
    settings.apiKey = `{env:${args.apiKeyEnv}}`
    // Explicit switch to env: a previously stored raw key must not linger.
    if (readKeys()[id] !== undefined) {
      deleteKeyFileEntry(id)
      staleKeyRemoved = true
    }
  }

  const mergedModels: Record<string, ModelEntry> = { ...((previous && previous.models) || {}) }
  mergedModels[args.model] = modelEntry
  for (const m of wanted) {
    if (!mergedModels[m]) mergedModels[m] = { name: m }
  }
  config.providers[id] = {
    name: args.name ?? previous?.name ?? id,
    package: OPENAI_COMPATIBLE,
    settings,
    models: mergedModels,
  }
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json"

  try {
    saveConfig(file, config)
  } catch (e) {
    return `Error: cannot write config (${file}): ${(e as Error).message}`
  }

  const lines = [
    `${exists ? "Updated" : "Added"}: providers.${id} -> ${file}`,
    `Models: ${wanted.map((m) => `${id}/${m}`).join(", ")}` +
      (modelUpstream !== args.model ? ` (upstream: ${modelUpstream})` : ""),
  ]
  if (args.apiKey) {
    lines.push("Note: key stored separately (not in config), no restart needed.")
  } else if (args.apiKeyEnv) {
    lines.push(`Note: define the ${args.apiKeyEnv} environment variable; no raw key was written.`)
    if (staleKeyRemoved) lines.push(`Note: removed the previously stored raw key for ${id}.`)
  }
  lines.push(`Pick ${id}/${args.model} from /models to test.`)
  return lines.join("\n")
}

export function removeProvider(rawID: string): string {
  const id = trimString(rawID)
  if (!id) return "Error: empty ID."
  const file = globalConfigPath()
  let config: Record<string, any>
  try {
    config = loadConfig(file)
  } catch (e) {
    return `Error: cannot read config (${file}): ${(e as Error).message}`
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || !config.providers || !config.providers[id]) {
    return `Error: "${id}" not found.`
  }
  delete config.providers[id]
  if (Object.keys(config.providers).length === 0) delete config.providers
  try {
    saveConfig(file, config)
  } catch (e) {
    return `Error: cannot write config (${file}): ${(e as Error).message}`
  }
  deleteKeyFileEntry(id)
  return `Deleted: ${id} (config + stored key).`
}

export function editProviderModels(rawID: string, add?: string[], remove?: string[]): string {
  const id = trimString(rawID)
  if (!id) return "Error: empty ID."
  const file = globalConfigPath()
  let config: Record<string, any>
  try {
    config = loadConfig(file)
  } catch (e) {
    return `Error: cannot read config (${file}): ${(e as Error).message}`
  }
  const entry = config && config.providers && (config.providers[id] as ProviderEntry | undefined)
  if (!entry) return `Error: "${id}" not found.`
  const models: Record<string, ModelEntry> = { ...(entry.models || {}) }
  const norm = (v: unknown) => trimString(v)
  for (const m of (Array.isArray(add) ? add : []).map(norm).filter(Boolean)) {
    if (!models[m]) models[m] = { name: m }
  }
  for (const m of (Array.isArray(remove) ? remove : []).map(norm).filter(Boolean)) {
    delete models[m]
  }
  if (!Object.keys(models).length) {
    return "Error: at least 1 model must remain. Use custom_provider_remove to delete the provider."
  }
  entry.models = models
  try {
    saveConfig(file, config)
  } catch (e) {
    return `Error: cannot write config (${file}): ${(e as Error).message}`
  }
  return `Updated: ${id} -> ${Object.keys(models).length} model(s) (${Object.keys(models).join(", ").slice(0, 300)})`
}

export interface ScanResult {
  ids?: string[]
  current?: string[]
  baseURL?: string
  error?: string
}

function storedKeyFor(providerID: string, settingsApiKey?: string): string | undefined {
  const stored = readKeys()[providerID]
  if (typeof stored === "string" && stored) return stored
  if (typeof settingsApiKey === "string") {
    const m = settingsApiKey.match(/^\{env:(.+)\}$/)
    if (m) return process.env[m[1]]
  }
  return undefined
}

export async function scanProviderModels(rawID: string): Promise<ScanResult> {
  const id = trimString(rawID)
  if (!id) return { error: "Empty ID." }
  let config: Record<string, any>
  try {
    config = loadConfig(globalConfigPath())
  } catch (e) {
    return { error: `Cannot read config: ${(e as Error).message}` }
  }
  const entry = config && config.providers && (config.providers[id] as ProviderEntry | undefined)
  const baseURL = entry && entry.settings && entry.settings.baseURL
  if (!baseURL) return { error: `"${id}" not found or has no baseURL.` }
  const found = await discoverModels(baseURL, storedKeyFor(id, entry.settings.apiKey))
  if (found.error) {
    const reason =
      found.error === "auth"
        ? "Endpoint requires a key (401)."
        : found.error === "empty"
          ? "Endpoint returned an empty list."
          : found.error === "bad-body"
            ? "Endpoint answered 200 but not with OpenAI-style JSON."
            : found.error === "network"
              ? "Endpoint unreachable."
              : `Endpoint error (${found.error}).`
    return { error: reason, baseURL }
  }
  return { ids: found.ids ?? [], current: Object.keys(entry.models || {}), baseURL }
}

// model.request hook: injects the stored key as an Authorization header.
// Raw keys never live in the config, no ENV vars or restarts needed.
export async function injectAuth(event: { model?: { providerID?: string }; headers?: Record<string, string> }): Promise<void> {
  const providerID = event && event.model && event.model.providerID
  if (!providerID || !event.headers) return
  if (event.headers["authorization"] || event.headers["Authorization"]) return
  const key = readKeys()[providerID]
  if (typeof key === "string" && key) event.headers["authorization"] = `Bearer ${key}`
}
