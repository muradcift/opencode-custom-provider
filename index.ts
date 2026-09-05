import type { Plugin } from "@opencode-ai/plugin"
import { editProviderModels, injectAuth, providerInputMeta, removeProvider, scanProviderModels, upsertCustomProvider } from "./src/shared.js"

export default {
  id: "custom-provider",
  async setup(ctx: Plugin.Context) {
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "custom_provider_add",
        description:
          "Add or update a custom OpenAI-compatible provider in the global opencode.jsonc. " +
          "Ask the user for id, baseURL and model when missing. Never invent URLs or keys. " +
          "Prefer apiKey (raw key, stored separately) over apiKeyEnv; never write raw secrets into config. " +
          "Each model is written with explicit limit/capabilities. Run custom_provider_scan first and pass " +
          "discovered values (contextLimit/outputLimit/inputLimit/tools/modalities); anything omitted falls " +
          "back to OpenCode defaults (200000 context, 32000 output, tools with text+image in, text out).",
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
            outputModalities: { type: "array", items: { type: "string" }, description: 'Output modalities for `model`, e.g. ["text"].' },
          },
          required: ["id", "baseURL", "model"],
          additionalProperties: false,
        },
        execute: async (input: unknown) => {
          return { content: upsertCustomProvider(input as any) }
        },
      })
      editor.add({
        name: "custom_provider_remove",
        description:
          "Delete a custom provider from the global opencode.jsonc and its stored key. " +
          "Ask the user which provider ID to delete and confirm before calling.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Provider ID to delete, e.g. acme" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const id = typeof input.id === "string" ? input.id.trim() : ""
          return { content: removeProvider(id) }
        },
      })
      editor.add({
        name: "custom_provider_scan",
        description:
          "Rescan an existing custom provider's endpoint (/models) and list discovered vs configured models, " +
          "including any discovered per-model limits/capabilities. " +
          "Use before adding new models. Never invent results, report errors as-is.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Provider ID, e.g. acme" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const id = typeof input.id === "string" ? input.id.trim() : ""
          const r = await scanProviderModels(id)
          if (r.error) return { content: `Scan failed (${id}): ${r.error}` }
          const fresh = (r.ids ?? []).filter((m) => !(r.current ?? []).includes(m))
          const gone = (r.current ?? []).filter((m) => !(r.ids ?? []).includes(m))
          const metaLines = Object.entries(r.meta ?? {}).map(([m, mt]) => {
            const bits = [
              mt.context !== undefined ? `context=${mt.context}` : "",
              mt.output !== undefined ? `output=${mt.output}` : "",
              mt.input !== undefined ? `input=${mt.input}` : "",
              mt.tools !== undefined ? `tools=${mt.tools}` : "",
              mt.inputModalities ? `in=[${mt.inputModalities.join(",")}]` : "",
              mt.outputModalities ? `out=[${mt.outputModalities.join(",")}]` : "",
            ]
              .filter(Boolean)
              .join(" ")
            return `${m} (${bits})`
          })
          const lines = [
            `Endpoint: ${r.baseURL}`,
            `Discovered: ${(r.ids ?? []).length} model(s)`,
            fresh.length ? `New (addable): ${fresh.join(", ").slice(0, 500)}` : "No new models.",
            gone.length ? `Missing upstream (removable): ${gone.join(", ").slice(0, 300)}` : "",
            metaLines.length ? `Discovered limits: ${metaLines.join("; ").slice(0, 500)}` : "",
          ].filter(Boolean)
          return { content: lines.join("\n") }
        },
      })
      editor.add({
        name: "custom_provider_edit_models",
        description:
          "Add and/or remove models of an existing custom provider. At least 1 model must remain. " +
          "Added models are written with explicit limit/capabilities: pass discovered values from " +
          "custom_provider_scan (or ask the user); anything omitted falls back to OpenCode defaults " +
          "(200000 context, 32000 output, tools with text+image in, text out). " +
          "Confirm the model list with the user before calling.",
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
            outputModalities: { type: "array", items: { type: "string" }, description: "Output modalities, applied to added models." },
          },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const id = typeof input.id === "string" ? input.id.trim() : ""
          return { content: editProviderModels(id, input.add, input.remove, providerInputMeta(input)) }
        },
      })
    })
    await ctx.session.hook("model.request", injectAuth)
  },
}
