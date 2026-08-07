// ABOUTME: Protects order-independent model search across the picker and settings select.
// ABOUTME: Guards the vendor-in-slug plus family-in-name case that no substring can span.

import { describe, expect, it } from "vitest";
import { filterModelsByQuery, providerLabel } from "@/lib/model-search";

// Shapes taken from the live SerenModels catalog, including OpenRouter's
// inconsistent naming: some entries carry the vendor, some do not.
const CATALOG = [
  { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
  { id: "anthropic/claude-sonnet-5", name: "Anthropic Claude Sonnet 5" },
  { id: "anthropic/claude-haiku-4.5", name: "Anthropic: Claude Haiku 4.5" },
  { id: "google/gemini-3.6-flash", name: "Google Gemini 3.6 Flash" },
  { id: "openai/gpt-5-mini", name: "GPT-5 Mini" },
];

const ids = (query: string) =>
  filterModelsByQuery(CATALOG, query).map((model) => model.id);

describe("filterModelsByQuery", () => {
  it("matches words in any order", () => {
    expect(ids("claude opus")).toEqual(["anthropic/claude-opus-5"]);
    expect(ids("opus claude")).toEqual(["anthropic/claude-opus-5"]);
  });

  it("spans the vendor in the slug and the family in the name", () => {
    // "anthropic opus" appears contiguously in neither field: the vendor is
    // only in the slug, the family only in the name.
    expect(ids("anthropic opus")).toEqual(["anthropic/claude-opus-5"]);
    expect(ids("mini gpt")).toEqual(["openai/gpt-5-mini"]);
  });

  it("keeps every model for an empty or whitespace-only query", () => {
    expect(filterModelsByQuery(CATALOG, "")).toHaveLength(CATALOG.length);
    expect(filterModelsByQuery(CATALOG, "   ")).toHaveLength(CATALOG.length);
  });

  it("still excludes models when any word matches nothing", () => {
    expect(ids("claude gemini")).toEqual([]);
    expect(ids("nonexistent")).toEqual([]);
  });

  it("matches the derived vendor label when it is absent from slug and name", () => {
    // "Z.ai" is the label for the `z-ai` slug prefix; neither field spells it.
    expect(
      filterModelsByQuery([{ id: "z-ai/glm-5.2", name: "GLM 5.2" }], "z.ai glm"),
    ).toHaveLength(1);
  });
});

describe("providerLabel", () => {
  it("maps known vendor slugs and capitalizes unknown ones", () => {
    expect(providerLabel("anthropic/claude-opus-5")).toBe("Anthropic");
    expect(providerLabel("meta-llama/llama-3.3-70b-instruct")).toBe("Meta");
    expect(providerLabel("acme/some-model")).toBe("Acme");
  });
});
