// ABOUTME: Guards the routing-preference → provider.sort wire mapping (#3747).
// ABOUTME: Fastest must omit the field; cheapest must send the exact value seren-router accepts.

import { describe, expect, it } from "vitest";
import { buildChatRequest } from "../../src/lib/providers";
import {
  normalizeRoutingPreference,
  providerSortForPreference,
} from "../../src/lib/providers/routing-preference";

describe("providerSortForPreference", () => {
  it("omits provider.sort for fastest so the server default stays in charge", () => {
    expect(providerSortForPreference("fastest")).toBeUndefined();
  });

  it("maps cheapest to the price wire value", () => {
    expect(providerSortForPreference("cheapest")).toBe("price");
  });

  it("treats legacy/unknown values as the default", () => {
    expect(providerSortForPreference(null)).toBeUndefined();
    expect(providerSortForPreference(undefined)).toBeUndefined();
    // seren-router 400s on unknown sort values; they must never map to a wire value.
    expect(providerSortForPreference("balanced")).toBeUndefined();
    expect(providerSortForPreference("price")).toBeUndefined();
  });
});

describe("normalizeRoutingPreference", () => {
  it("accepts only known preferences", () => {
    expect(normalizeRoutingPreference("fastest")).toBe("fastest");
    expect(normalizeRoutingPreference("cheapest")).toBe("cheapest");
    expect(normalizeRoutingPreference("balanced")).toBeNull();
    expect(normalizeRoutingPreference(null)).toBeNull();
  });
});

describe("buildChatRequest provider.sort passthrough", () => {
  it("attaches provider.sort when a wire value is given", () => {
    const request = buildChatRequest("hi", "anthropic/claude-sonnet-4", undefined, [], "price");
    expect(request.provider).toEqual({ sort: "price" });
  });

  it("leaves provider absent when no wire value is given", () => {
    const request = buildChatRequest("hi", "anthropic/claude-sonnet-4");
    expect(request.provider).toBeUndefined();
    // JSON serialization must not carry the key either — the server treats
    // presence as an explicit preference.
    expect(JSON.parse(JSON.stringify(request))).not.toHaveProperty("provider");
  });
});
