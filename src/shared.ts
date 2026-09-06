import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface ModelCapabilities {
  tools: boolean
  input: string[]
  output: string[]
}

export interface ModelLimit {
  context: number
  input?: number
  output: number
}

export interface ModelEntry {
  name: string
  modelID?: string
  capabilities?: ModelCapabilities
  limit?: ModelLimit
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
  contextLimit?: number
  outputLimit?: number
  inputLimit?: number
  tools?: boolean
  inputModalities?: string[]
  outputModalities?: string[]
}

export interface ModelMetaInput {
  contextLimit?: number
  outputLimit?: number
  inputLimit?: number
  tools?: boolean
  inputModalities?: string[]
  outputModalities?: string[]
}

// OpenCode fallback metadata for models outside its catalog (see docs/models):
// 200k context, 32k output, unspecified input, tools + text/image in, text out.
// We write these explicitly instead of relying on the implicit fallback.
export const FALLBACK_LIMIT = { context: 200000, output: 32000 } as const
export const FALLBACK_CAPABILITIES: ModelCapabilities = { tools: true, input: ["text", "image"], output: ["text"] }

// Partially discovered per-model metadata scraped from /models item extras.
// Standard OpenAI items carry only `id`; some servers volunteer more.
export interface DiscoveredMeta {
  context?: number
  input?: number
  output?: number
  tools?: boolean
  inputModalities?: string[]
  outputModalities?: string[]
}

const CONTEXT_KEYS = [
  "max_model_len",
  "max_context_length",
  "context_length",
  "context_window",
  "contextLength",
  "max_context",
  "n_ctx",
]
const OUTPUT_KEYS = ["max_output_tokens", "max_completion_tokens", "max_tokens", "max_new_tokens"]
const INPUT_KEYS = ["max_input_tokens", "max_prompt_tokens"]
const TOOLS_BOOL_KEYS = ["supports_tools", "function_calling"]
const INPUT_MOD_KEYS = ["input_modalities", "inputModalities"]
const OUTPUT_MOD_KEYS = ["output_modalities", "outputModalities"]

function validLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.trunc(value)
}

function validModalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = [...new Set(value.map((v) => (typeof v === "string" ? v.trim().toLowerCase() : "")).filter(Boolean))]
  return out.length ? out : undefined
}

function scrapeMetaBag(bag: Record<string, any>): DiscoveredMeta {
  const meta: DiscoveredMeta = {}
  const pickNum = (keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = validLimit(bag[k])
      if (v !== undefined) return v
    }
    return undefined
  }
  const context = pickNum(CONTEXT_KEYS)
  if (context !== undefined) meta.context = context
  const output = pickNum(OUTPUT_KEYS)
  if (output !== undefined) meta.output = output
  const input = pickNum(INPUT_KEYS)
  if (input !== undefined) meta.input = input
  for (const k of TOOLS_BOOL_KEYS) {
    if (typeof bag[k] === "boolean") {
      meta.tools = bag[k]
      break
    }
  }
  if (Array.isArray(bag.supported_parameters)) {
    const params = bag.supported_parameters.map((p: unknown) => String(p).toLowerCase())
    if (params.includes("tools") || params.includes("tool_choice")) meta.tools = true
  }
  for (const k of INPUT_MOD_KEYS) {
    const mods = validModalities(bag[k])
    if (mods) {
      meta.inputModalities = mods
      break
    }
  }
  for (const k of OUTPUT_MOD_KEYS) {
    const mods = validModalities(bag[k])
    if (mods) {
      meta.outputModalities = mods
      break
    }
  }
  if (!meta.inputModalities) {
    const flat = validModalities(bag.modalities)
    if (flat) meta.inputModalities = flat
  }
  if ((!meta.inputModalities || !meta.outputModalities) && typeof bag.modality === "string") {
    // OpenRouter-style "text+image->text"
    const sides = bag.modality.split("->").map((s: string) =>
      [...new Set(s.split("+").map((m) => m.trim().toLowerCase()).filter(Boolean))],
    )
    if (sides[0]?.length && !meta.inputModalities) meta.inputModalities = sides[0]
    if (sides[1]?.length && !meta.outputModalities) meta.outputModalities = sides[1]
  }
  if (bag.vision === true && meta.inputModalities && !meta.inputModalities.includes("image")) {
    meta.inputModalities = [...meta.inputModalities, "image"]
  } else if (bag.vision === true && !meta.inputModalities) {
    meta.inputModalities = ["text", "image"]
  }
  return meta
}

export function extractModelMeta(raw: unknown): DiscoveredMeta {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const bag = raw as Record<string, any>
  const meta = scrapeMetaBag(bag)
  for (const nestKey of ["meta", "architecture"]) {
    const nested = bag[nestKey]
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const inner = scrapeMetaBag(nested as Record<string, any>)
      for (const [k, v] of Object.entries(inner)) {
        if ((meta as Record<string, unknown>)[k] === undefined) (meta as Record<string, unknown>)[k] = v
      }
    }
  }
  return meta
}

// Precedence: explicit overrides > existing entry blocks > discovered > explicit OpenCode fallbacks.
export type MetaSource = "explicit" | "discovered" | "base" | "fallback"
export interface MetaSources {
  context: MetaSource
  input: MetaSource
  output: MetaSource
  tools: MetaSource
  in: MetaSource
  out: MetaSource
}

export const BASE_SOURCES: MetaSources = {
  context: "base",
  input: "base",
  output: "base",
  tools: "base",
  in: "base",
  out: "base",
}

export function resolveModelMeta(
  raw?: unknown,
  overrides?: ModelMetaInput,
  base?: Pick<ModelEntry, "capabilities" | "limit">,
): { capabilities: ModelCapabilities; limit: ModelLimit; sources: MetaSources } {
  const found = raw === undefined ? {} : extractModelMeta(raw)
  const o = overrides ?? {}
  const num = (v: unknown): number | undefined => validLimit(v)
  const cleanArr = (v: unknown): string[] | undefined => {
    if (v === undefined) return undefined
    return validModalities(v)
  }
  const hasExplicit = (v: unknown): boolean => v !== undefined
  const pickSource = (explicit: boolean, baseV: unknown, foundV: unknown): MetaSource =>
    explicit ? "explicit" : baseV !== undefined ? "base" : foundV !== undefined ? "discovered" : "fallback"
  const contextExplicit = num(o.contextLimit)
  const outputExplicit = num(o.outputLimit)
  const inputExplicit = num(o.inputLimit)
  const toolsExplicit = typeof o.tools === "boolean" ? o.tools : undefined
  const inExplicit = cleanArr(o.inputModalities)
  const outExplicit = cleanArr(o.outputModalities)
  const context = contextExplicit ?? base?.limit?.context ?? found.context ?? FALLBACK_LIMIT.context
  const output = outputExplicit ?? base?.limit?.output ?? found.output ?? FALLBACK_LIMIT.output
  const input = inputExplicit ?? base?.limit?.input ?? found.input
  const tools = toolsExplicit ?? base?.capabilities?.tools ?? found.tools ?? FALLBACK_CAPABILITIES.tools
  const inMods = inExplicit ?? base?.capabilities?.input ?? found.inputModalities ?? [...FALLBACK_CAPABILITIES.input]
  const outMods = outExplicit ?? base?.capabilities?.output ?? found.outputModalities ?? [...FALLBACK_CAPABILITIES.output]
  const limit: ModelLimit =
    input === undefined ? { context, output } : { context, input, output }
  return {
    capabilities: { tools, input: inMods, output: outMods },
    limit,
    sources: {
      context: pickSource(hasExplicit(contextExplicit), base?.limit?.context, found.context),
      input: pickSource(hasExplicit(inputExplicit), base?.limit?.input, found.input),
      output: pickSource(hasExplicit(outputExplicit), base?.limit?.output, found.output),
      tools: pickSource(hasExplicit(toolsExplicit), base?.capabilities?.tools, found.tools),
      in: pickSource(hasExplicit(inExplicit), base?.capabilities?.input, found.inputModalities),
      out: pickSource(hasExplicit(outExplicit), base?.capabilities?.output, found.outputModalities),
    },
  }
}

// True when at least one limit field came from the provider (discovered) or
// was given explicitly — i.e. the entry is not pure OpenCode fallback.
export function hasDiscoveredLimits(sources?: MetaSources): boolean {
  if (!sources) return true
  return (
    sources.context === "discovered" ||
    sources.context === "explicit" ||
    sources.input === "discovered" ||
    sources.input === "explicit" ||
    sources.output === "discovered" ||
    sources.output === "explicit"
  )
}

// One-line per-model report, e.g.
// `- acme/coder: context 128000, output 16384`
// `- acme/chat: context 200000 (default), output 32000 (default)`
export function formatMetaReport(id: string, entry: ModelEntry, sources?: MetaSources): string {
  const limit = entry.limit ?? { context: FALLBACK_LIMIT.context, output: FALLBACK_LIMIT.output }
  const mark = (s: MetaSource | undefined) => (s === "fallback" ? " (default)" : "")
  const parts = [`context ${limit.context}${mark(sources?.context)}`]
  if (limit.input !== undefined) parts.push(`input ${limit.input}${mark(sources?.input)}`)
  parts.push(`output ${limit.output}${mark(sources?.output)}`)
  return `- ${id}: ${parts.join(", ")}`
}

// Fill missing capabilities/limit blocks without touching present ones.
export function ensureModelMeta(
  entry: ModelEntry,
  raw?: unknown,
  overrides?: ModelMetaInput,
): ModelEntry {
  if (!entry.capabilities || !entry.limit) {
    const resolved = resolveModelMeta(raw, overrides, entry)
    if (!entry.capabilities) entry.capabilities = resolved.capabilities
    if (!entry.limit) entry.limit = resolved.limit
  }
  return entry
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
  raw?: Record<string, unknown>
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
      const items = ((data && (data as any).data) || []).filter((m: any) => m && m.id)
      const raw: Record<string, unknown> = {}
      for (const m of items as any[]) {
        if (raw[m.id] === undefined) raw[m.id] = m
      }
      const ids = Object.keys(raw)
      return ids.length ? { ids, raw } : { error: "empty" }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { error: "network" }
  }
}

function normalizeInput(raw: ProviderInput): ProviderInput {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : undefined
  const strArr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined
    const out = [...new Set(v.map((m) => trimString(m)).filter(Boolean))]
    return out.length ? out : undefined
  }
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
    contextLimit: num(raw.contextLimit),
    outputLimit: num(raw.outputLimit),
    inputLimit: num(raw.inputLimit),
    tools: typeof raw.tools === "boolean" ? raw.tools : undefined,
    inputModalities: strArr(raw.inputModalities),
    outputModalities: strArr(raw.outputModalities),
  }
}

export function providerInputMeta(args: ProviderInput): ModelMetaInput {
  return {
    contextLimit: args.contextLimit,
    outputLimit: args.outputLimit,
    inputLimit: args.inputLimit,
    tools: args.tools,
    inputModalities: args.inputModalities,
    outputModalities: args.outputModalities,
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

  const previous = exists ? (config.providers[id] as ProviderEntry) : undefined
  const modelUpstream = args.modelUpstream ?? args.model
  const prevModel = previous && previous.models ? previous.models[args.model] : undefined
  const primaryResolved = resolveModelMeta(undefined, providerInputMeta(args), prevModel)
  const modelEntry: ModelEntry = {
    name: args.modelName ?? prevModel?.name ?? args.model,
    capabilities: primaryResolved.capabilities,
    limit: primaryResolved.limit,
  }
  const reportSources: Record<string, MetaSources> = { [args.model]: primaryResolved.sources }
  if (modelUpstream !== args.model) modelEntry.modelID = modelUpstream
  else if (prevModel?.modelID) modelEntry.modelID = prevModel.modelID

  const wanted = [args.model]
  if (Array.isArray(args.extraModels)) {
    for (const m of args.extraModels) {
      const t = trimString(m)
      if (t && !wanted.includes(t)) wanted.push(t)
    }
  }

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
    const cur = mergedModels[m]
    if (!cur) {
      const r = resolveModelMeta()
      mergedModels[m] = { name: m, capabilities: r.capabilities, limit: r.limit }
      reportSources[m] = r.sources
    } else {
      ensureModelMeta(cur)
      if (!reportSources[m]) reportSources[m] = BASE_SOURCES
    }
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
    "Limits:",
    ...wanted.map((m) => formatMetaReport(`${id}/${m}`, mergedModels[m], reportSources[m])),
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

export function editProviderModels(
  rawID: string,
  add?: string[],
  remove?: string[],
  meta?: ModelMetaInput,
): string {
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
  const hasMeta = meta !== undefined && Object.values(meta).some((v) => v !== undefined)
  const added = (Array.isArray(add) ? add : []).map(norm).filter(Boolean)
  const reportSources: Record<string, MetaSources> = {}
  for (const m of added) {
    const cur = models[m]
    if (!cur) {
      const r = resolveModelMeta(undefined, meta)
      models[m] = { name: m, capabilities: r.capabilities, limit: r.limit }
      reportSources[m] = r.sources
    } else if (hasMeta) {
      const r = resolveModelMeta(undefined, meta, cur)
      models[m] = { ...cur, capabilities: r.capabilities, limit: r.limit }
      reportSources[m] = r.sources
    } else {
      ensureModelMeta(cur)
      reportSources[m] = BASE_SOURCES
    }
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
  const out = [`Updated: ${id} -> ${Object.keys(models).length} model(s) (${Object.keys(models).join(", ").slice(0, 300)})`]
  if (added.length) {
    out.push("Limits:")
    for (const m of added) out.push(formatMetaReport(`${id}/${m}`, models[m], reportSources[m]))
  }
  return out.join("\n")
}

export interface ScanResult {
  ids?: string[]
  current?: string[]
  baseURL?: string
  meta?: Record<string, DiscoveredMeta>
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
  return { ids: found.ids ?? [], current: Object.keys(entry.models || {}), baseURL, meta: discoveredMeta(found.raw) }
}

export function discoveredMeta(raw?: Record<string, unknown>): Record<string, DiscoveredMeta> {
  const out: Record<string, DiscoveredMeta> = {}
  if (!raw) return out
  for (const [id, item] of Object.entries(raw)) {
    const meta = extractModelMeta(item)
    if (Object.keys(meta).length) out[id] = meta
  }
  return out
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
