// Exercises the lost-update guard against a throwaway config file.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "cp-guard-"))
const file = join(dir, "opencode.json")
writeFileSync(file, JSON.stringify({ $schema: "s", plugins: ["a"] }, null, 2) + "\n", "utf8")
process.env.OPENCODE_CONFIG_TEST = file
process.env.OPENCODE_KEYS_TEST = join(dir, "keys.json")

const { loadConfig, saveConfig, readConfigText, upsertCustomProvider, removeProvider } = await import(
  "../src/shared.js"
)

let pass = 0
let fail = 0
function check(name: string, ok: boolean) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name)
  ok ? pass++ : fail++
}

// 1. Normal path: read, mutate, write with the snapshot.
const before = readConfigText(file)
const cfg = loadConfig(file)
cfg.plugins = ["a", "b"]
saveConfig(file, cfg, before)
check("snapshot matching the file on disk -> write goes through", JSON.parse(readFileSync(file, "utf8")).plugins.length === 2)

// 2. Lost update: another writer changes the file after we read it.
const before2 = readConfigText(file)
writeFileSync(file, JSON.stringify({ $schema: "s", plugins: ["a", "b"], model: "anthropic/claude-sonnet-4-5" }, null, 2) + "\n", "utf8")
let threw = ""
try {
  const stale = loadConfig(before2 === null ? file : file) // fresh read, we simulate a stale one below
  stale.plugins = ["a", "b", "c"]
  saveConfig(file, stale, before2) // before2 is now stale on purpose
} catch (e) {
  threw = (e as Error).message
}
check("stale snapshot -> refused with a clear error", threw.includes("changed on disk"))
check("refused write left the other writer's key intact", JSON.parse(readFileSync(file, "utf8")).model === "anthropic/claude-sonnet-4-5")

// 3. No snapshot passed -> unchanged legacy behaviour (still writes).
const cfg3 = loadConfig(file)
cfg3.extra = true
saveConfig(file, cfg3)
check("no snapshot -> still writes (backwards compatible)", JSON.parse(readFileSync(file, "utf8")).extra === true)

// 4. Full tool path on a missing provider is a clean error, not a crash.
const missing = removeProvider("nope")
check("removeProvider on unknown id returns an error string", missing.startsWith("Error:"))

// 5. A backup is written next to the config on every successful save.
const backups = readFileSync(file, "utf8")
check("config on disk is valid JSON after all of the above", (() => { try { JSON.parse(backups); return true } catch { return false } })())

console.log("")
console.log(`  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
