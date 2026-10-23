// @bun
// src/shared.ts
import fs from "fs";
import os from "os";
import path from "path";
var FALLBACK_LIMIT = { context: 200000, output: 32000 };
var FALLBACK_CAPABILITIES = { tools: true, input: ["text", "image"], output: ["text"] };
var CONTEXT_KEYS = [
  "max_model_len",
  "max_context_length",
  "context_length",
  "context_window",
  "contextLength",
  "max_context",
  "n_ctx"
];
var OUTPUT_KEYS = ["max_output_tokens", "max_completion_tokens", "max_tokens", "max_new_tokens"];
var INPUT_KEYS = ["max_input_tokens", "max_prompt_tokens"];
var TOOLS_BOOL_KEYS = ["supports_tools", "function_calling"];
var INPUT_MOD_KEYS = ["input_modalities", "inputModalities"];
var OUTPUT_MOD_KEYS = ["output_modalities", "outputModalities"];
function validLimit(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return;
  return Math.trunc(value);
}
function validModalities(value) {
  if (!Array.isArray(value))
    return;
  const out = [...new Set(value.map((v) => typeof v === "string" ? v.trim().toLowerCase() : "").filter(Boolean))];
  return out.length ? out : undefined;
}
function scrapeMetaBag(bag) {
  const meta = {};
  const pickNum = (keys) => {
    for (const k of keys) {
      const v = validLimit(bag[k]);
      if (v !== undefined)
        return v;
    }
    return;
  };
  const context = pickNum(CONTEXT_KEYS);
  if (context !== undefined)
    meta.context = context;
  const output = pickNum(OUTPUT_KEYS);
  if (output !== undefined)
    meta.output = output;
  const input = pickNum(INPUT_KEYS);
  if (input !== undefined)
    meta.input = input;
  for (const k of TOOLS_BOOL_KEYS) {
    if (typeof bag[k] === "boolean") {
      meta.tools = bag[k];
      break;
    }
  }
  if (Array.isArray(bag.supported_parameters)) {
    const params = bag.supported_parameters.map((p) => String(p).toLowerCase());
    if (params.includes("tools") || params.includes("tool_choice"))
      meta.tools = true;
  }
  for (const k of INPUT_MOD_KEYS) {
    const mods = validModalities(bag[k]);
    if (mods) {
      meta.inputModalities = mods;
      break;
    }
  }
  for (const k of OUTPUT_MOD_KEYS) {
    const mods = validModalities(bag[k]);
    if (mods) {
      meta.outputModalities = mods;
      break;
    }
  }
  if (!meta.inputModalities) {
    const flat = validModalities(bag.modalities);
    if (flat)
      meta.inputModalities = flat;
  }
  if ((!meta.inputModalities || !meta.outputModalities) && typeof bag.modality === "string") {
    const sides = bag.modality.split("->").map((s) => [...new Set(s.split("+").map((m) => m.trim().toLowerCase()).filter(Boolean))]);
    if (sides[0]?.length && !meta.inputModalities)
      meta.inputModalities = sides[0];
    if (sides[1]?.length && !meta.outputModalities)
      meta.outputModalities = sides[1];
  }
  if (bag.vision === true && meta.inputModalities && !meta.inputModalities.includes("image")) {
    meta.inputModalities = [...meta.inputModalities, "image"];
  } else if (bag.vision === true && !meta.inputModalities) {
    meta.inputModalities = ["text", "image"];
  }
  return meta;
}
function extractModelMeta(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return {};
  const bag = raw;
  const meta = scrapeMetaBag(bag);
  for (const nestKey of ["meta", "architecture"]) {
    const nested = bag[nestKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const inner = scrapeMetaBag(nested);
      for (const [k, v] of Object.entries(inner)) {
        if (meta[k] === undefined)
          meta[k] = v;
      }
    }
  }
  return meta;
}
var BASE_SOURCES = {
  context: "base",
  input: "base",
  output: "base",
  tools: "base",
  in: "base",
  out: "base"
};
function resolveModelMeta(raw, overrides, base) {
  const found = raw === undefined ? {} : extractModelMeta(raw);
  const o = overrides ?? {};
  const num = (v) => validLimit(v);
  const cleanArr = (v) => {
    if (v === undefined)
      return;
    return validModalities(v);
  };
  const hasExplicit = (v) => v !== undefined;
  const pickSource = (explicit, baseV, foundV) => explicit ? "explicit" : baseV !== undefined ? "base" : foundV !== undefined ? "discovered" : "fallback";
  const contextExplicit = num(o.contextLimit);
  const outputExplicit = num(o.outputLimit);
  const inputExplicit = num(o.inputLimit);
  const toolsExplicit = typeof o.tools === "boolean" ? o.tools : undefined;
  const inExplicit = cleanArr(o.inputModalities);
  const outExplicit = cleanArr(o.outputModalities);
  const context = contextExplicit ?? base?.limit?.context ?? found.context ?? FALLBACK_LIMIT.context;
  const output = outputExplicit ?? base?.limit?.output ?? found.output ?? FALLBACK_LIMIT.output;
  const input = inputExplicit ?? base?.limit?.input ?? found.input;
  const tools = toolsExplicit ?? base?.capabilities?.tools ?? found.tools ?? FALLBACK_CAPABILITIES.tools;
  const inMods = inExplicit ?? base?.capabilities?.input ?? found.inputModalities ?? [...FALLBACK_CAPABILITIES.input];
  const outMods = outExplicit ?? base?.capabilities?.output ?? found.outputModalities ?? [...FALLBACK_CAPABILITIES.output];
  const limit = input === undefined ? { context, output } : { context, input, output };
  return {
    capabilities: { tools, input: inMods, output: outMods },
    limit,
    sources: {
      context: pickSource(hasExplicit(contextExplicit), base?.limit?.context, found.context),
      input: pickSource(hasExplicit(inputExplicit), base?.limit?.input, found.input),
      output: pickSource(hasExplicit(outputExplicit), base?.limit?.output, found.output),
      tools: pickSource(hasExplicit(toolsExplicit), base?.capabilities?.tools, found.tools),
      in: pickSource(hasExplicit(inExplicit), base?.capabilities?.input, found.inputModalities),
      out: pickSource(hasExplicit(outExplicit), base?.capabilities?.output, found.outputModalities)
    }
  };
}
function formatMetaReport(id, entry, sources) {
  const limit = entry.limit ?? { context: FALLBACK_LIMIT.context, output: FALLBACK_LIMIT.output };
  const mark = (s) => s === "fallback" ? " (default)" : "";
  const parts = [`context ${limit.context}${mark(sources?.context)}`];
  if (limit.input !== undefined)
    parts.push(`input ${limit.input}${mark(sources?.input)}`);
  parts.push(`output ${limit.output}${mark(sources?.output)}`);
  return `- ${id}: ${parts.join(", ")}`;
}
function ensureModelMeta(entry, raw, overrides) {
  if (!entry.capabilities || !entry.limit) {
    const resolved = resolveModelMeta(raw, overrides, entry);
    if (!entry.capabilities)
      entry.capabilities = resolved.capabilities;
    if (!entry.limit)
      entry.limit = resolved.limit;
  }
  return entry;
}
var OPENAI_COMPATIBLE = "@opencode-ai/ai/providers/openai-compatible";
function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function globalConfigPath() {
  const override = process.env.OPENCODE_CONFIG_TEST;
  if (override)
    return override;
  const dir = path.join(os.homedir(), ".config", "opencode");
  const jsonc = path.join(dir, "opencode.jsonc");
  if (fs.existsSync(jsonc))
    return jsonc;
  return path.join(dir, "opencode.json");
}
function keysFile() {
  const override = process.env.OPENCODE_KEYS_TEST;
  if (override)
    return override;
  return path.join(os.homedir(), ".config", "opencode", ".custom-provider-keys.json");
}
function readKeys() {
  try {
    const parsed = JSON.parse(fs.readFileSync(keysFile(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return {};
}
function writeKeyFile(providerID, apiKey) {
  const file = keysFile();
  const keys = readKeys();
  keys[providerID] = apiKey;
  fs.writeFileSync(file, JSON.stringify(keys, null, 2) + `
`, { encoding: "utf8", mode: 384 });
  try {
    fs.chmodSync(file, 384);
  } catch {}
  return file;
}
function deleteKeyFileEntry(providerID) {
  try {
    const keys = readKeys();
    if (keys[providerID] !== undefined) {
      delete keys[providerID];
      fs.writeFileSync(keysFile(), JSON.stringify(keys, null, 2) + `
`, { encoding: "utf8", mode: 384 });
    }
  } catch {}
}
function stripJsonComments(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  let quote = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote)
        inStr = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== `
`)
        i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
function stripTrailingCommas(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  let quote = "";
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote)
        inStr = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]))
        j++;
      const next = text[j];
      if (next === "}" || next === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}
function loadConfig(file) {
  if (!fs.existsSync(file))
    return {};
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
  }
}
function readConfigText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
function saveConfig(file, config, expectedText) {
  if (expectedText !== undefined) {
    const current = readConfigText(file);
    if (current !== expectedText) {
      throw new Error(`${file} changed on disk while this command was running. Nothing was written \u2014 run it again so your change lands on top of the current file.`);
    }
  }
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
  }
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + `
`, "utf8");
}
function validId(id) {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id);
}
function validBaseURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
async function discoverModels(baseURL, apiKey) {
  const url = baseURL.replace(/\/+$/, "") + "/models";
  try {
    const headers = {};
    if (apiKey)
      headers.Authorization = `Bearer ${apiKey}`;
    const ctrl = new AbortController;
    const timer = setTimeout(() => ctrl.abort(), 1e4);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (res.status === 401 || res.status === 403)
        return { error: "auth" };
      if (!res.ok)
        return { error: `http-${res.status}` };
      let data;
      try {
        data = await res.json();
      } catch {
        return { error: "bad-body" };
      }
      const items = (data && data.data || []).filter((m) => m && m.id);
      const raw = {};
      for (const m of items) {
        if (raw[m.id] === undefined)
          raw[m.id] = m;
      }
      const ids = Object.keys(raw);
      return ids.length ? { ids, raw } : { error: "empty" };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { error: "network" };
  }
}
function normalizeInput(raw) {
  const num = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : undefined;
  const strArr = (v) => {
    if (!Array.isArray(v))
      return;
    const out = [...new Set(v.map((m) => trimString(m)).filter(Boolean))];
    return out.length ? out : undefined;
  };
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
    outputModalities: strArr(raw.outputModalities)
  };
}
function providerInputMeta(args) {
  return {
    contextLimit: args.contextLimit,
    outputLimit: args.outputLimit,
    inputLimit: args.inputLimit,
    tools: args.tools,
    inputModalities: args.inputModalities,
    outputModalities: args.outputModalities
  };
}
var CATALOG_URLS = ["https://models.dev/api.json", "https://models.opencode.ai/api.json"];
var CATALOG_USER_AGENT = "opencode-custom-provider/0.1.3";
var CATALOG_TIMEOUT_MS = 15000;
var CATALOG_TTL_MS = 10 * 60 * 1000;
var catalogCache;
function isCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  return Object.values(value).some((provider) => {
    if (!provider || typeof provider !== "object" || Array.isArray(provider))
      return false;
    const models = provider.models;
    return Boolean(models && typeof models === "object" && !Array.isArray(models));
  });
}
async function loadCatalog() {
  const testPath = process.env.OPENCODE_CATALOG_TEST;
  if (testPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(testPath, "utf8"));
      if (!isCatalog(parsed))
        return { error: "empty or invalid catalog" };
      return { catalog: parsed };
    } catch (e) {
      return { error: `cannot read catalog (${testPath}): ${e.message}` };
    }
  }
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return { catalog: catalogCache.catalog };
  }
  let lastError = "no catalog endpoint reachable";
  for (const url of CATALOG_URLS) {
    const ctrl = new AbortController;
    const timer = setTimeout(() => ctrl.abort(), CATALOG_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": CATALOG_USER_AGENT },
        signal: ctrl.signal
      });
      if (!res.ok) {
        lastError = `http-${res.status} from ${url}`;
        continue;
      }
      const parsed = await res.json();
      if (!isCatalog(parsed)) {
        lastError = "empty or invalid catalog";
        continue;
      }
      catalogCache = { at: Date.now(), catalog: parsed };
      return { catalog: parsed };
    } catch (e) {
      const err = e;
      lastError = `${url}: ${err.name === "AbortError" ? "timed out" : err.message}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: lastError };
}
function hasTextModality(value) {
  if (!Array.isArray(value) || value.length === 0)
    return true;
  return value.some((m) => typeof m === "string" && m.startsWith("text"));
}
function catalogModeIDs(experimental) {
  if (!experimental || typeof experimental !== "object" || Array.isArray(experimental))
    return [];
  const modes = experimental.modes;
  if (Array.isArray(modes)) {
    return modes.map((m) => {
      if (typeof m === "string")
        return m;
      if (m && typeof m === "object" && typeof m.id === "string") {
        return m.id;
      }
      return "";
    }).filter(Boolean);
  }
  if (modes && typeof modes === "object")
    return Object.keys(modes);
  return [];
}
function catalogModelIDs(catalog, providerID) {
  const provider = catalog && catalog[providerID];
  const models = provider && provider.models;
  if (!models || typeof models !== "object" || Array.isArray(models))
    return [];
  const ids = [];
  for (const [modelID, raw] of Object.entries(models)) {
    const model = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    if (model.status === "deprecated")
      continue;
    const modalities = model.modalities && typeof model.modalities === "object" && !Array.isArray(model.modalities) ? model.modalities : {};
    if (!hasTextModality(modalities.input) || !hasTextModality(modalities.output))
      continue;
    ids.push(modelID);
    for (const mode of catalogModeIDs(model.experimental))
      ids.push(`${modelID}-${mode}`);
  }
  return ids;
}
function applyModelWhitelist(models, selected, catalogIDs) {
  const selectedSet = new Set(selected);
  const catalogSet = new Set(catalogIDs);
  let hidden = 0;
  let pruned = 0;
  for (const m of selectedSet) {
    const entry = models[m];
    if (entry && entry.disabled !== undefined)
      delete entry.disabled;
  }
  for (const m of catalogSet) {
    if (selectedSet.has(m))
      continue;
    const entry = models[m];
    if (!entry) {
      models[m] = { disabled: true };
      hidden++;
    } else if (entry.disabled !== true) {
      entry.disabled = true;
      hidden++;
    }
  }
  for (const [m, entry] of Object.entries(models)) {
    if (entry.disabled === true && !catalogSet.has(m) && !selectedSet.has(m)) {
      delete models[m];
      pruned++;
    }
  }
  return { hidden, pruned };
}
async function upsertCustomProvider(rawArgs) {
  const args = normalizeInput(rawArgs);
  const { id, baseURL } = args;
  if (!validId(id))
    return `Error: invalid provider ID "${id}". Use letters, digits, dot, dash, underscore.`;
  if (!validBaseURL(baseURL))
    return `Error: invalid baseURL "${baseURL}". Expected https://example.com/v1.`;
  const file = globalConfigPath();
  const before = readConfigText(file);
  let config;
  try {
    config = loadConfig(file);
  } catch (e) {
    return `Error: cannot read config (${file}): ${e.message}`;
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return `Error: config root is corrupt (${file}). Fix it manually first.`;
  }
  if (!config.providers || typeof config.providers !== "object")
    config.providers = {};
  const exists = Boolean(config.providers[id]);
  if (exists && !args.overwrite) {
    return `"${id}" already exists. Repeat with overwrite:true to update.
` + `Current: ${JSON.stringify(config.providers[id]).slice(0, 300)}`;
  }
  const previous = exists ? config.providers[id] : undefined;
  const modelUpstream = args.modelUpstream ?? args.model;
  const prevModel = previous && previous.models ? previous.models[args.model] : undefined;
  const primaryResolved = resolveModelMeta(undefined, providerInputMeta(args), prevModel);
  const modelEntry = {
    name: args.modelName ?? prevModel?.name ?? args.model,
    capabilities: primaryResolved.capabilities,
    limit: primaryResolved.limit
  };
  const reportSources = { [args.model]: primaryResolved.sources };
  if (modelUpstream !== args.model)
    modelEntry.modelID = modelUpstream;
  else if (prevModel?.modelID)
    modelEntry.modelID = prevModel.modelID;
  const wanted = [args.model];
  if (Array.isArray(args.extraModels)) {
    for (const m of args.extraModels) {
      const t = trimString(m);
      if (t && !wanted.includes(t))
        wanted.push(t);
    }
  }
  const prevSettings = previous && previous.settings && typeof previous.settings === "object" ? previous.settings : {};
  const settings = { ...prevSettings, baseURL };
  let staleKeyRemoved = false;
  if (args.apiKey) {
    writeKeyFile(id, args.apiKey);
    delete settings.apiKey;
  } else if (args.apiKeyEnv) {
    settings.apiKey = `{env:${args.apiKeyEnv}}`;
    if (readKeys()[id] !== undefined) {
      deleteKeyFileEntry(id);
      staleKeyRemoved = true;
    }
  }
  const previousModels = previous && previous.models || {};
  const prevEnabled = Object.keys(previousModels).filter((m) => previousModels[m]?.disabled !== true);
  const mergedModels = { ...previousModels };
  mergedModels[args.model] = modelEntry;
  for (const m of wanted) {
    const cur = mergedModels[m];
    if (!cur) {
      const r = resolveModelMeta();
      mergedModels[m] = { name: m, capabilities: r.capabilities, limit: r.limit };
      reportSources[m] = r.sources;
    } else {
      if (cur.disabled !== true)
        ensureModelMeta(cur);
      if (!reportSources[m])
        reportSources[m] = BASE_SOURCES;
    }
  }
  const selected = [...new Set([...prevEnabled, ...wanted])];
  for (const m of selected) {
    if (mergedModels[m])
      delete mergedModels[m].disabled;
  }
  const catalogResult = await loadCatalog();
  let hidden = 0;
  let catalogWarning;
  if (catalogResult.catalog) {
    hidden = applyModelWhitelist(mergedModels, selected, catalogModelIDs(catalogResult.catalog, id)).hidden;
  } else {
    catalogWarning = `Warning: could not load OpenCode's model catalog (${catalogResult.error}); ` + `unselected built-in models may still appear for "${id}".`;
  }
  config.providers[id] = {
    name: args.name ?? previous?.name ?? id,
    package: OPENAI_COMPATIBLE,
    settings,
    models: mergedModels
  };
  if (!config.$schema)
    config.$schema = "https://opencode.ai/config.json";
  try {
    saveConfig(file, config, before);
  } catch (e) {
    return `Error: cannot write config (${file}): ${e.message}`;
  }
  const lines = [
    `${exists ? "Updated" : "Added"}: providers.${id} -> ${file}`,
    `Models: ${wanted.map((m) => `${id}/${m}`).join(", ")}` + (modelUpstream !== args.model ? ` (upstream: ${modelUpstream})` : ""),
    "Limits:",
    ...wanted.map((m) => formatMetaReport(`${id}/${m}`, mergedModels[m], reportSources[m]))
  ];
  if (args.apiKey) {
    lines.push("Note: key stored separately (not in config), no restart needed.");
  } else if (args.apiKeyEnv) {
    lines.push(`Note: define the ${args.apiKeyEnv} environment variable; no raw key was written.`);
    if (staleKeyRemoved)
      lines.push(`Note: removed the previously stored raw key for ${id}.`);
  }
  if (hidden > 0) {
    lines.push(`Note: ${hidden} unselected built-in catalog model(s) were disabled because provider ID "${id}" ` + `collides with OpenCode's models.dev catalog. Only selected models will appear.`);
  }
  if (catalogWarning)
    lines.push(catalogWarning);
  lines.push(`Pick ${id}/${args.model} from /models to test.`);
  return lines.join(`
`);
}
function removeProvider(rawID) {
  const id = trimString(rawID);
  if (!id)
    return "Error: empty ID.";
  const file = globalConfigPath();
  const before = readConfigText(file);
  let config;
  try {
    config = loadConfig(file);
  } catch (e) {
    return `Error: cannot read config (${file}): ${e.message}`;
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || !config.providers || !config.providers[id]) {
    return `Error: "${id}" not found.`;
  }
  delete config.providers[id];
  if (Object.keys(config.providers).length === 0)
    delete config.providers;
  try {
    saveConfig(file, config, before);
  } catch (e) {
    return `Error: cannot write config (${file}): ${e.message}`;
  }
  deleteKeyFileEntry(id);
  return `Deleted: ${id} (config + stored key).`;
}
async function editProviderModels(rawID, add, remove, meta) {
  const id = trimString(rawID);
  if (!id)
    return "Error: empty ID.";
  const file = globalConfigPath();
  const before = readConfigText(file);
  let config;
  try {
    config = loadConfig(file);
  } catch (e) {
    return `Error: cannot read config (${file}): ${e.message}`;
  }
  const entry = config && config.providers && config.providers[id];
  if (!entry)
    return `Error: "${id}" not found.`;
  const models = { ...entry.models || {} };
  const norm = (v) => trimString(v);
  const hasMeta = meta !== undefined && Object.values(meta).some((v) => v !== undefined);
  const added = (Array.isArray(add) ? add : []).map(norm).filter(Boolean);
  const removed = (Array.isArray(remove) ? remove : []).map(norm).filter(Boolean);
  const reportSources = {};
  for (const m of added) {
    const cur = models[m];
    if (!cur) {
      const r = resolveModelMeta(undefined, meta);
      models[m] = { name: m, capabilities: r.capabilities, limit: r.limit };
      reportSources[m] = r.sources;
    } else if (hasMeta) {
      const r = resolveModelMeta(undefined, meta, cur);
      models[m] = { ...cur, capabilities: r.capabilities, limit: r.limit };
      reportSources[m] = r.sources;
    } else {
      if (cur.disabled !== true)
        ensureModelMeta(cur);
      reportSources[m] = BASE_SOURCES;
    }
  }
  const selectedSet = new Set(Object.keys(models).filter((m) => models[m]?.disabled !== true));
  for (const m of removed)
    selectedSet.delete(m);
  for (const m of added)
    selectedSet.add(m);
  if (!selectedSet.size) {
    return "Error: at least 1 model must remain. Use custom_provider_remove to delete the provider.";
  }
  const selected = [...selectedSet];
  for (const m of selected) {
    if (models[m])
      delete models[m].disabled;
  }
  const catalogResult = await loadCatalog();
  let hidden = 0;
  let catalogWarning;
  if (catalogResult.catalog) {
    const catalogIDs = catalogModelIDs(catalogResult.catalog, id);
    const catalogSet = new Set(catalogIDs);
    for (const m of removed) {
      if (!selectedSet.has(m) && !catalogSet.has(m))
        delete models[m];
    }
    hidden = applyModelWhitelist(models, selected, catalogIDs).hidden;
  } else {
    for (const m of removed) {
      if (selectedSet.has(m))
        continue;
      const entry = models[m];
      if (entry)
        entry.disabled = true;
    }
    catalogWarning = `Warning: could not load OpenCode's model catalog (${catalogResult.error}); ` + `unselected built-in models may still appear for "${id}".`;
  }
  entry.models = models;
  try {
    saveConfig(file, config, before);
  } catch (e) {
    return `Error: cannot write config (${file}): ${e.message}`;
  }
  const out = [`Updated: ${id} -> ${selected.length} model(s) (${selected.join(", ").slice(0, 300)})`];
  if (added.length) {
    out.push("Limits:");
    for (const m of added)
      out.push(formatMetaReport(`${id}/${m}`, models[m], reportSources[m]));
  }
  if (hidden > 0) {
    out.push(`Note: ${hidden} unselected built-in catalog model(s) were disabled because provider ID "${id}" ` + `collides with OpenCode's models.dev catalog. Only selected models will appear.`);
  }
  if (catalogWarning)
    out.push(catalogWarning);
  return out.join(`
`);
}
function scanNewModels(ids, current, hiddenIDs) {
  const known = new Set([...current, ...hiddenIDs]);
  return ids.filter((m) => !known.has(m));
}
function storedKeyFor(providerID, settingsApiKey) {
  const stored = readKeys()[providerID];
  if (typeof stored === "string" && stored)
    return stored;
  if (typeof settingsApiKey === "string") {
    const m = settingsApiKey.match(/^\{env:(.+)\}$/);
    if (m)
      return process.env[m[1]];
  }
  return;
}
async function scanProviderModels(rawID) {
  const id = trimString(rawID);
  if (!id)
    return { error: "Empty ID." };
  let config;
  try {
    config = loadConfig(globalConfigPath());
  } catch (e) {
    return { error: `Cannot read config: ${e.message}` };
  }
  const entry = config && config.providers && config.providers[id];
  const baseURL = entry && entry.settings && entry.settings.baseURL;
  if (!baseURL)
    return { error: `"${id}" not found or has no baseURL.` };
  const found = await discoverModels(baseURL, storedKeyFor(id, entry.settings.apiKey));
  if (found.error) {
    const reason = found.error === "auth" ? "Endpoint requires a key (401)." : found.error === "empty" ? "Endpoint returned an empty list." : found.error === "bad-body" ? "Endpoint answered 200 but not with OpenAI-style JSON." : found.error === "network" ? "Endpoint unreachable." : `Endpoint error (${found.error}).`;
    return { error: reason, baseURL };
  }
  const configured = entry.models || {};
  const current = Object.keys(configured).filter((m) => configured[m]?.disabled !== true);
  const hiddenIDs = Object.keys(configured).filter((m) => configured[m]?.disabled === true);
  return {
    ids: found.ids ?? [],
    current,
    hidden: hiddenIDs.length,
    hiddenIDs,
    baseURL,
    meta: discoveredMeta(found.raw)
  };
}
function discoveredMeta(raw) {
  const out = {};
  if (!raw)
    return out;
  for (const [id, item] of Object.entries(raw)) {
    const meta = extractModelMeta(item);
    if (Object.keys(meta).length)
      out[id] = meta;
  }
  return out;
}
async function injectAuth(event) {
  const providerID = event && event.model && event.model.providerID;
  if (!providerID || !event.headers)
    return;
  if (event.headers["authorization"] || event.headers["Authorization"])
    return;
  const key = readKeys()[providerID];
  if (typeof key === "string" && key)
    event.headers["authorization"] = `Bearer ${key}`;
}

// index.ts
var opencode_custom_provider_default = {
  id: "custom-provider",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "custom_provider_add",
        description: "Add or update a custom OpenAI-compatible provider in the global opencode.jsonc. " + "Ask the user for id, baseURL and model when missing. Never invent URLs or keys. " + "Prefer apiKey (raw key, stored separately) over apiKeyEnv; never write raw secrets into config. " + "Each model is written with explicit limit/capabilities. Run custom_provider_scan first and pass " + "discovered values (contextLimit/outputLimit/inputLimit/tools/modalities); anything omitted falls " + "back to OpenCode defaults (200000 context, 32000 output, tools with text+image in, text out). " + "OpenCode treats providers.<id>.models as an overlay on its built-in models.dev catalog, not as a " + "whitelist: when the ID matches a catalog provider, unselected catalog models are written as " + "disabled: true so only the selected models appear. Prefer a unique provider ID when you want a " + "clean config without disabled stubs.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Provider ID, e.g. acme" },
            baseURL: { type: "string", description: "OpenAI-compatible base URL, e.g. https://llm.acme.example/v1" },
            model: { type: "string", description: "Catalog model ID, e.g. coder" },
            name: { type: "string", description: "Display name. Defaults to id." },
            modelName: { type: "string", description: "Model display name." },
            modelUpstream: { type: "string", description: "Real model ID sent to the provider." },
            extraModels: { type: "array", items: { type: "string" }, description: "Extra model IDs for the same provider." },
            apiKeyEnv: { type: "string", description: "ENV var holding the key. Ignored when apiKey is given." },
            apiKey: { type: "string", description: "Raw API key. Stored separately, injected per request. Ask the user, never invent." },
            overwrite: { type: "boolean", description: "Overwrite an existing ID." },
            contextLimit: { type: "number", description: "Context window tokens for `model`." },
            outputLimit: { type: "number", description: "Max output tokens for `model`." },
            inputLimit: { type: "number", description: "Max input tokens for `model`. Omit when unknown." },
            tools: { type: "boolean", description: "Whether `model` supports tool calling." },
            inputModalities: { type: "array", items: { type: "string" }, description: 'Input modalities for `model`, e.g. ["text","image"].' },
            outputModalities: { type: "array", items: { type: "string" }, description: 'Output modalities for `model`, e.g. ["text"].' }
          },
          required: ["id", "baseURL", "model"],
          additionalProperties: false
        },
        execute: async (input) => {
          return { content: await upsertCustomProvider(input) };
        }
      });
      editor.add({
        name: "custom_provider_remove",
        description: "Delete a custom provider from the global opencode.jsonc and its stored key. " + "Ask the user which provider ID to delete and confirm before calling.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Provider ID to delete, e.g. acme" }
          },
          required: ["id"],
          additionalProperties: false
        },
        execute: async (input) => {
          const id = typeof input.id === "string" ? input.id.trim() : "";
          return { content: removeProvider(id) };
        }
      });
      editor.add({
        name: "custom_provider_scan",
        description: "Rescan an existing custom provider's endpoint (/models) and list discovered vs configured models, " + "including any discovered per-model limits/capabilities. " + "Use before adding new models. Never invent results, report errors as-is.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Provider ID, e.g. acme" }
          },
          required: ["id"],
          additionalProperties: false
        },
        execute: async (input) => {
          const id = typeof input.id === "string" ? input.id.trim() : "";
          const r = await scanProviderModels(id);
          if (r.error)
            return { content: `Scan failed (${id}): ${r.error}` };
          const fresh = scanNewModels(r.ids ?? [], r.current ?? [], r.hiddenIDs ?? []);
          const gone = (r.current ?? []).filter((m) => !(r.ids ?? []).includes(m));
          const metaLines = Object.entries(r.meta ?? {}).map(([m, mt]) => {
            const bits = [
              mt.context !== undefined ? `context=${mt.context}` : "",
              mt.output !== undefined ? `output=${mt.output}` : "",
              mt.input !== undefined ? `input=${mt.input}` : "",
              mt.tools !== undefined ? `tools=${mt.tools}` : "",
              mt.inputModalities ? `in=[${mt.inputModalities.join(",")}]` : "",
              mt.outputModalities ? `out=[${mt.outputModalities.join(",")}]` : ""
            ].filter(Boolean).join(" ");
            return `${m} (${bits})`;
          });
          const lines = [
            `Endpoint: ${r.baseURL}`,
            `Discovered: ${(r.ids ?? []).length} model(s)`,
            fresh.length ? `New (addable): ${fresh.join(", ").slice(0, 500)}` : "No new models.",
            gone.length ? `Missing upstream (removable): ${gone.join(", ").slice(0, 300)}` : "",
            r.hidden ? `Hidden (disabled): ${r.hidden} built-in catalog model(s), not shown in /models.` : "",
            metaLines.length ? `Discovered limits: ${metaLines.join("; ").slice(0, 500)}` : ""
          ].filter(Boolean);
          return { content: lines.join(`
`) };
        }
      });
      editor.add({
        name: "custom_provider_edit_models",
        description: "Add and/or remove models of an existing custom provider. At least 1 model must remain enabled. " + "Added models are written with explicit limit/capabilities: pass discovered values from " + "custom_provider_scan (or ask the user); anything omitted falls back to OpenCode defaults " + "(200000 context, 32000 output, tools with text+image in, text out). " + "OpenCode treats providers.<id>.models as an overlay on its built-in models.dev catalog, not as a " + "whitelist: for a colliding provider ID, unselected catalog models are kept as disabled: true " + "stubs (removing one does not delete it) and newly colliding IDs get added as disabled stubs. " + "Prefer a unique provider ID when you want a clean config. " + "Confirm the model list with the user before calling.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Provider ID, e.g. acme" },
            add: { type: "array", items: { type: "string" }, description: "Model IDs to add." },
            remove: { type: "array", items: { type: "string" }, description: "Model IDs to remove." },
            contextLimit: { type: "number", description: "Context window tokens, applied to added models." },
            outputLimit: { type: "number", description: "Max output tokens, applied to added models." },
            inputLimit: { type: "number", description: "Max input tokens, applied to added models. Omit when unknown." },
            tools: { type: "boolean", description: "Tool-calling support, applied to added models." },
            inputModalities: { type: "array", items: { type: "string" }, description: "Input modalities, applied to added models." },
            outputModalities: { type: "array", items: { type: "string" }, description: "Output modalities, applied to added models." }
          },
          required: ["id"],
          additionalProperties: false
        },
        execute: async (input) => {
          const id = typeof input.id === "string" ? input.id.trim() : "";
          return { content: await editProviderModels(id, input.add, input.remove, providerInputMeta(input)) };
        }
      });
    });
    await ctx.session.hook("model.request", injectAuth);
  }
};
export {
  opencode_custom_provider_default as default
};
