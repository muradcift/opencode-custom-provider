// Exercises the catalog-collision whitelist against throwaway config files.
// OPENCODE_CATALOG_TEST points at a fixture so no network access is used.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "cp-whitelist-"))
const configFile = join(dir, "opencode.json")
const keysFile = join(dir, "keys.json")
const catalogFile = join(dir, "catalog.json")

const fixtureCatalog = {
  nvidia: {
    id: "nvidia",
    name: "NVIDIA",
    models: {
      a: { name: "A", modalities: { input: ["text"], output: ["text"] } },
      b: { name: "B", modalities: { input: ["text", "image"], output: ["text"] } },
      c: { name: "C", modalities: { input: ["text"], output: ["text"] } },
    },
  },
  filters: {
    id: "filters",
    name: "Filter fixture",
    models: {
      old: { name: "Old", status: "deprecated", modalities: { input: ["text"], output: ["text"] } },
      imageonly: { name: "Image only", modalities: { input: ["image"], output: ["text"] } },
      audioout: { name: "Audio out", modalities: { input: ["text"], output: ["audio"] } },
      modes: {
        name: "Modes",
        modalities: { input: ["text"], output: ["text"] },
        experimental: { modes: ["fast", "slow"] },
      },
    },
  },
}

writeFileSync(catalogFile, JSON.stringify(fixtureCatalog, null, 2) + "\n", "utf8")
process.env.OPENCODE_CONFIG_TEST = configFile
process.env.OPENCODE_KEYS_TEST = keysFile
process.env.OPENCODE_CATALOG_TEST = catalogFile

const {
  applyModelWhitelist,
  catalogModelIDs,
  editProviderModels,
  loadCatalog,
  scanNewModels,
  scanProviderModels,
  upsertCustomProvider,
} = await import("../src/shared.js")

let pass = 0
let fail = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log("  PASS  " + name)
    pass++
  } catch (e) {
    console.log("  FAIL  " + name + " -- " + (e as Error).message)
    fail++
  }
}

function resetConfig(config: Record<string, unknown>) {
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", "utf8")
}

function readConfig(): Record<string, any> {
  return JSON.parse(readFileSync(configFile, "utf8"))
}

function providerModels(): Record<string, any> {
  return readConfig().providers.nvidia.models
}

const baseURL = "https://example.test/v1"

// 1. A new provider whose ID collides with the catalog gets disabled stubs
//    for every unselected catalog model.
resetConfig({ $schema: "https://opencode.ai/config.json" })
const out1 = await upsertCustomProvider({ id: "nvidia", baseURL, model: "a" })
const m1 = providerModels()
check("new colliding provider: selected model stays enabled", () => {
  assert.equal(m1.a.disabled, undefined)
})
check("new colliding provider: unselected catalog models are disabled stubs", () => {
  assert.deepEqual(m1.b, { disabled: true })
  assert.deepEqual(m1.c, { disabled: true })
})
check("new colliding provider: output reports the hidden count", () => {
  assert.match(out1, /2 unselected built-in catalog model\(s\) were disabled/)
})

// 2. Adding a disabled model re-enables it and keeps its metadata.
resetConfig({
  $schema: "https://opencode.ai/config.json",
  providers: {
    nvidia: {
      name: "nvidia",
      package: "@opencode-ai/ai/providers/openai-compatible",
      settings: { baseURL },
      models: {
        a: {
          name: "A",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 1000, output: 100 },
        },
        b: {
          name: "Bee",
          modelID: "b-upstream",
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          limit: { context: 2048, input: 1024, output: 256 },
          disabled: true,
        },
      },
    },
  },
})
await editProviderModels("nvidia", ["b"])
const m2 = providerModels()
check("edit add: disabled stub is enabled", () => {
  assert.equal(m2.b.disabled, undefined)
})
check("edit add: metadata of the stub is preserved", () => {
  assert.equal(m2.b.name, "Bee")
  assert.equal(m2.b.modelID, "b-upstream")
  assert.deepEqual(m2.b.capabilities, { tools: false, input: ["text"], output: ["text"] })
  assert.deepEqual(m2.b.limit, { context: 2048, input: 1024, output: 256 })
})
check("edit add: previously selected model stays enabled", () => {
  assert.equal(m2.a.disabled, undefined)
})
check("edit add: remaining catalog model stays hidden", () => {
  assert.deepEqual(m2.c, { disabled: true })
})

// 3. Removing a catalog model leaves a disabled stub; removing a non-catalog
//    model deletes it.
resetConfig({
  $schema: "https://opencode.ai/config.json",
  providers: {
    nvidia: {
      name: "nvidia",
      package: "@opencode-ai/ai/providers/openai-compatible",
      settings: { baseURL },
      models: {
        a: { name: "A", limit: { context: 1000, output: 100 } },
        b: { name: "B", limit: { context: 2000, output: 200 } },
        custom: { name: "Custom", limit: { context: 3000, output: 300 } },
      },
    },
  },
})
await editProviderModels("nvidia", undefined, ["a", "custom"])
const m3 = providerModels()
check("edit remove: catalog model stays as a disabled stub with metadata", () => {
  assert.equal(m3.a.disabled, true)
  assert.equal(m3.a.name, "A")
  assert.deepEqual(m3.a.limit, { context: 1000, output: 100 })
})
check("edit remove: non-catalog model is deleted", () => {
  assert.equal(m3.custom, undefined)
})
check("edit remove: kept model stays enabled", () => {
  assert.equal(m3.b.disabled, undefined)
})
check("edit remove: unselected catalog model is stubbed", () => {
  assert.equal(m3.c.disabled, true)
})

// 4. At least one *enabled* model must remain, even when disabled stubs exist.
resetConfig({
  $schema: "https://opencode.ai/config.json",
  providers: {
    nvidia: {
      name: "nvidia",
      package: "@opencode-ai/ai/providers/openai-compatible",
      settings: { baseURL },
      models: {
        a: { name: "A", limit: { context: 1000, output: 100 } },
        b: { disabled: true },
      },
    },
  },
})
const before4 = readFileSync(configFile, "utf8")
const out4 = await editProviderModels("nvidia", undefined, ["a"])
const m4 = providerModels()
check("removing every enabled model returns an error", () => {
  assert.match(out4, /^Error:/)
})
check("refused edit leaves the config untouched", () => {
  assert.equal(readFileSync(configFile, "utf8"), before4)
  assert.equal(m4.a.disabled, undefined)
  assert.equal(m4.b.disabled, true)
})

// 5. Non-colliding provider IDs do not gain catalog stubs.
resetConfig({ $schema: "https://opencode.ai/config.json" })
const out5 = await upsertCustomProvider({ id: "local", baseURL: "https://local.test/v1", model: "x" })
await editProviderModels("local", ["y"])
const localModels = readConfig().providers.local.models
check("non-colliding provider: only the selected models exist", () => {
  assert.deepEqual(Object.keys(localModels).sort(), ["x", "y"])
  assert.equal(localModels.x.disabled, undefined)
  assert.equal(localModels.y.disabled, undefined)
})
check("non-colliding provider: no collision note", () => {
  assert.doesNotMatch(out5, /collides with OpenCode/)
})

// 6. Catalog failure still writes, preserves existing stubs, and warns.
resetConfig({
  $schema: "https://opencode.ai/config.json",
  providers: {
    nvidia: {
      name: "nvidia",
      package: "@opencode-ai/ai/providers/openai-compatible",
      settings: { baseURL },
      models: {
        a: {
          name: "A",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 1000, output: 100 },
        },
        b: { name: "Bee", limit: { context: 2048, output: 256 }, disabled: true },
      },
    },
  },
})
const goodCatalog = process.env.OPENCODE_CATALOG_TEST
process.env.OPENCODE_CATALOG_TEST = join(dir, "missing-catalog.json")
const out6 = await upsertCustomProvider({ id: "nvidia", baseURL, model: "a", overwrite: true })
process.env.OPENCODE_CATALOG_TEST = goodCatalog
const m6 = providerModels()
check("catalog failure: provider is still written", () => {
  assert.equal(m6.a.disabled, undefined)
})
check("catalog failure: existing stubs are preserved", () => {
  assert.equal(m6.b.disabled, true)
  assert.equal(m6.b.name, "Bee")
})
check("catalog failure: no new stubs are invented", () => {
  assert.equal(m6.c, undefined)
})
check("catalog failure: output warns about missing catalog", () => {
  assert.match(out6, /warning/i)
  assert.match(out6, /catalog/i)
})

// 7. Pure helpers: runtime catalog filtering and stale-stub pruning.
const loaded = await loadCatalog()
assert.ok(loaded.catalog)
check("catalogModelIDs drops deprecated and non-text models", () => {
  assert.deepEqual(catalogModelIDs(loaded.catalog, "filters"), ["modes", "modes-fast", "modes-slow"])
})
check("catalogModelIDs returns nothing for an unknown provider", () => {
  assert.deepEqual(catalogModelIDs(loaded.catalog, "not-in-catalog"), [])
})
const prunedModels: Record<string, any> = {
  a: { name: "A" },
  stale: { disabled: true },
  kept: { name: "K" },
}
const result = applyModelWhitelist(prunedModels, ["a"], ["a", "b"])
check("applyModelWhitelist hides catalog extras and prunes stale stubs", () => {
  assert.deepEqual(prunedModels.b, { disabled: true })
  assert.equal(prunedModels.stale, undefined)
  assert.equal(prunedModels.a.disabled, undefined)
  assert.equal(result.hidden, 1)
  assert.equal(result.pruned, 1)
})

// 8. Scan: disabled stubs are known models, not newly discovered ones.
const scanServer = Bun.serve({
  port: 0,
  fetch() {
    return Response.json({
      object: "list",
      data: [{ id: "m-enabled" }, { id: "m-hidden-1" }, { id: "m-hidden-2" }, { id: "m-new" }],
    })
  },
})
resetConfig({
  $schema: "https://opencode.ai/config.json",
  providers: {
    scanme: {
      name: "scanme",
      package: "@opencode-ai/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${scanServer.port}/v1` },
      models: {
        "m-enabled": { name: "Enabled", limit: { context: 1000, output: 100 } },
        "m-hidden-1": { disabled: true },
        "m-hidden-2": { disabled: true },
      },
    },
  },
})
const scan = await scanProviderModels("scanme")
await scanServer.stop(true)
check("scan: current lists only enabled models", () => {
  assert.deepEqual(scan.current, ["m-enabled"])
})
check("scan: disabled stub IDs are reported separately", () => {
  assert.deepEqual(scan.hiddenIDs, ["m-hidden-1", "m-hidden-2"])
  assert.equal(scan.hidden, 2)
})
check("scan: fresh logic excludes hidden stubs and keeps the genuinely new ID", () => {
  assert.deepEqual(scanNewModels(scan.ids ?? [], scan.current ?? [], scan.hiddenIDs ?? []), ["m-new"])
})

// 9. Empty/truncated catalogs are rejected instead of pruning stubs.
const emptyCatalogFile = join(dir, "empty-catalog.json")
const truncatedCatalogFile = join(dir, "truncated-catalog.json")
writeFileSync(emptyCatalogFile, "{}\n", "utf8")
writeFileSync(truncatedCatalogFile, '{"foo":{}}\n', "utf8")
process.env.OPENCODE_CATALOG_TEST = emptyCatalogFile
const emptyLoaded = await loadCatalog()
check("loadCatalog rejects an empty catalog object", () => {
  assert.equal(emptyLoaded.catalog, undefined)
  assert.equal(emptyLoaded.error, "empty or invalid catalog")
})
process.env.OPENCODE_CATALOG_TEST = truncatedCatalogFile
const truncatedLoaded = await loadCatalog()
check("loadCatalog rejects providers without a models map", () => {
  assert.equal(truncatedLoaded.catalog, undefined)
  assert.equal(truncatedLoaded.error, "empty or invalid catalog")
})

resetConfig({
  $schema: "https://opencode.ai/config.json",
  providers: {
    nvidia: {
      name: "nvidia",
      package: "@opencode-ai/ai/providers/openai-compatible",
      settings: { baseURL },
      models: {
        a: { name: "A", limit: { context: 1000, output: 100 } },
        b: { name: "Bee", limit: { context: 2048, output: 256 }, disabled: true },
      },
    },
  },
})
process.env.OPENCODE_CATALOG_TEST = emptyCatalogFile
const outEmpty = await upsertCustomProvider({ id: "nvidia", baseURL, model: "a", overwrite: true })
const mEmpty = providerModels()
check("empty catalog: provider is still written", () => {
  assert.equal(mEmpty.a.disabled, undefined)
})
check("empty catalog: existing stubs are preserved", () => {
  assert.equal(mEmpty.b.disabled, true)
  assert.equal(mEmpty.b.name, "Bee")
})
check("empty catalog: no new stubs are invented", () => {
  assert.equal(mEmpty.c, undefined)
})
check("empty catalog: output warns about the unusable catalog", () => {
  assert.match(outEmpty, /warning/i)
  assert.match(outEmpty, /catalog/i)
})

resetConfig({
  $schema: "https://opencode.ai/config.json",
  providers: {
    nvidia: {
      name: "nvidia",
      package: "@opencode-ai/ai/providers/openai-compatible",
      settings: { baseURL },
      models: {
        a: { name: "A", limit: { context: 1000, output: 100 } },
        b: { name: "B", limit: { context: 2000, output: 200 } },
        c: { disabled: true },
      },
    },
  },
})
const outEmptyEdit = await editProviderModels("nvidia", undefined, ["a"])
const mEmptyEdit = providerModels()
check("empty catalog: removed catalog model stays a disabled stub", () => {
  assert.equal(mEmptyEdit.a.disabled, true)
  assert.equal(mEmptyEdit.a.name, "A")
})
check("empty catalog: other enabled/stub models are untouched", () => {
  assert.equal(mEmptyEdit.b.disabled, undefined)
  assert.equal(mEmptyEdit.c.disabled, true)
})
check("empty catalog: edit warns about the unusable catalog", () => {
  assert.match(outEmptyEdit, /warning/i)
})

// 10. The fixture path always re-reads the file (no TTL cache there).
const reReadCatalogFile = join(dir, "reread-catalog.json")
writeFileSync(reReadCatalogFile, JSON.stringify({ nvidia: fixtureCatalog.nvidia }) + "\n", "utf8")
process.env.OPENCODE_CATALOG_TEST = reReadCatalogFile
const firstRead = await loadCatalog()
writeFileSync(reReadCatalogFile, JSON.stringify(fixtureCatalog) + "\n", "utf8")
const secondRead = await loadCatalog()
process.env.OPENCODE_CATALOG_TEST = catalogFile
check("catalog test path re-reads the file instead of caching it", () => {
  assert.equal(firstRead.catalog?.filters, undefined)
  assert.ok(secondRead.catalog?.filters)
})

console.log("")
console.log(`  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
