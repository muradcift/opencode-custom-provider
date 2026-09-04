// @bun
// src/shared.ts
import fs from "fs";
import os from "os";
import path from "path";
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
function loadConfig(file) {
  if (!fs.existsSync(file))
    return {};
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripJsonComments(raw));
  }
}
function saveConfig(file, config) {
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
      const data = await res.json();
      const ids = (data && data.data || []).map((m) => m && m.id).filter(Boolean);
      const unique = [...new Set(ids)];
      return unique.length ? { ids: unique } : { error: "empty" };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { error: "network" };
  }
}
function normalizeInput(raw) {
  return {
    ...raw,
    id: trimString(raw.id),
    baseURL: trimString(raw.baseURL),
    model: trimString(raw.model),
    name: raw.name ? trimString(raw.name) : undefined,
    modelName: raw.modelName ? trimString(raw.modelName) : undefined,
    modelUpstream: raw.modelUpstream ? trimString(raw.modelUpstream) : undefined,
    apiKeyEnv: raw.apiKeyEnv ? trimString(raw.apiKeyEnv) : undefined,
    apiKey: raw.apiKey ? trimString(raw.apiKey) : undefined
  };
}
function upsertCustomProvider(rawArgs) {
  const args = normalizeInput(rawArgs);
  const { id, baseURL } = args;
  if (!validId(id))
    return `Error: invalid provider ID "${id}". Use letters, digits, dot, dash, underscore.`;
  if (!validBaseURL(baseURL))
    return `Error: invalid baseURL "${baseURL}". Expected https://example.com/v1.`;
  const file = globalConfigPath();
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
  const modelUpstream = args.modelUpstream ?? args.model;
  const modelEntry = { name: args.modelName ?? args.model };
  if (modelUpstream !== args.model)
    modelEntry.modelID = modelUpstream;
  const wanted = [args.model];
  if (Array.isArray(args.extraModels)) {
    for (const m of args.extraModels) {
      const t = trimString(m);
      if (t && !wanted.includes(t))
        wanted.push(t);
    }
  }
  const previous = exists ? config.providers[id] : undefined;
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
  const mergedModels = { ...previous && previous.models || {} };
  mergedModels[args.model] = modelEntry;
  for (const m of wanted) {
    if (!mergedModels[m])
      mergedModels[m] = { name: m };
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
    saveConfig(file, config);
  } catch (e) {
    return `Error: cannot write config (${file}): ${e.message}`;
  }
  const lines = [
    `${exists ? "Updated" : "Added"}: providers.${id} -> ${file}`,
    `Models: ${wanted.map((m) => `${id}/${m}`).join(", ")}` + (modelUpstream !== args.model ? ` (upstream: ${modelUpstream})` : "")
  ];
  if (args.apiKey) {
    lines.push("Note: key stored separately (not in config), no restart needed.");
  } else if (args.apiKeyEnv) {
    lines.push(`Note: define the ${args.apiKeyEnv} environment variable; no raw key was written.`);
    if (staleKeyRemoved)
      lines.push(`Note: removed the previously stored raw key for ${id}.`);
  }
  lines.push(`Pick ${id}/${args.model} from /models to test.`);
  return lines.join(`
`);
}
function removeProvider(rawID) {
  const id = trimString(rawID);
  if (!id)
    return "Error: empty ID.";
  const file = globalConfigPath();
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
    saveConfig(file, config);
  } catch (e) {
    return `Error: cannot write config (${file}): ${e.message}`;
  }
  deleteKeyFileEntry(id);
  return `Deleted: ${id} (config + stored key).`;
}
function editProviderModels(rawID, add, remove) {
  const id = trimString(rawID);
  if (!id)
    return "Error: empty ID.";
  const file = globalConfigPath();
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
  for (const m of (Array.isArray(add) ? add : []).map(norm).filter(Boolean)) {
    if (!models[m])
      models[m] = { name: m };
  }
  for (const m of (Array.isArray(remove) ? remove : []).map(norm).filter(Boolean)) {
    delete models[m];
  }
  if (!Object.keys(models).length) {
    return "Error: at least 1 model must remain. Use custom_provider_remove to delete the provider.";
  }
  entry.models = models;
  try {
    saveConfig(file, config);
  } catch (e) {
    return `Error: cannot write config (${file}): ${e.message}`;
  }
  return `Updated: ${id} -> ${Object.keys(models).length} model(s) (${Object.keys(models).join(", ").slice(0, 300)})`;
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
    const reason = found.error === "auth" ? "Endpoint requires a key (401)." : found.error === "empty" ? "Endpoint returned an empty list." : found.error === "network" ? "Endpoint unreachable." : `Endpoint error (${found.error}).`;
    return { error: reason, baseURL };
  }
  return { ids: found.ids ?? [], current: Object.keys(entry.models || {}), baseURL };
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
        description: "Add or update a custom OpenAI-compatible provider in the global opencode.jsonc. " + "Ask the user for id, baseURL and model when missing. Never invent URLs or keys. " + "Prefer apiKey (raw key, stored separately) over apiKeyEnv; never write raw secrets into config.",
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
            overwrite: { type: "boolean", description: "Overwrite an existing ID." }
          },
          required: ["id", "baseURL", "model"],
          additionalProperties: false
        },
        execute: async (input) => {
          return { content: upsertCustomProvider(input) };
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
        description: "Rescan an existing custom provider's endpoint (/models) and list discovered vs configured models. " + "Use before adding new models. Never invent results, report errors as-is.",
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
          const fresh = (r.ids ?? []).filter((m) => !(r.current ?? []).includes(m));
          const gone = (r.current ?? []).filter((m) => !(r.ids ?? []).includes(m));
          const lines = [
            `Endpoint: ${r.baseURL}`,
            `Discovered: ${(r.ids ?? []).length} model(s)`,
            fresh.length ? `New (addable): ${fresh.join(", ").slice(0, 500)}` : "No new models.",
            gone.length ? `Missing upstream (removable): ${gone.join(", ").slice(0, 300)}` : ""
          ].filter(Boolean);
          return { content: lines.join(`
`) };
        }
      });
      editor.add({
        name: "custom_provider_edit_models",
        description: "Add and/or remove models of an existing custom provider. At least 1 model must remain. " + "Confirm the model list with the user before calling.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Provider ID, e.g. acme" },
            add: { type: "array", items: { type: "string" }, description: "Model IDs to add." },
            remove: { type: "array", items: { type: "string" }, description: "Model IDs to remove." }
          },
          required: ["id"],
          additionalProperties: false
        },
        execute: async (input) => {
          const id = typeof input.id === "string" ? input.id.trim() : "";
          return { content: editProviderModels(id, input.add, input.remove) };
        }
      });
    });
    await ctx.session.hook("model.request", injectAuth);
  }
};
export {
  opencode_custom_provider_default as default
};
