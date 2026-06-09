// ABOUTME: Regression tests for mapping gateway publisher slugs to OAuth providers.
// ABOUTME: Ensures Google publisher failures can mark the Google login as expired.

import { describe, expect, it } from "vitest";

import {
  getExpiredOAuthProviderSlugs,
  getKnownOAuthProviderForPublisher,
  humanizeOAuthProviderSlug,
  isOAuthProviderExpired,
} from "@/lib/oauth-provider-resolution";

describe("OAuth publisher/provider resolution", () => {
  const providers = [
    { id: "provider-google", slug: "google", name: "Google" },
    { id: "provider-github", slug: "github", name: "GitHub" },
  ];
  const byProvider = {
    "provider-google": [
      { slug: "gmail", name: "Gmail" },
      { slug: "google-calendar", name: "Google Calendar" },
    ],
    "provider-github": [{ slug: "github-api", name: "GitHub" }],
  };

  it("resolves linked publisher slugs to their OAuth provider slug", () => {
    expect(
      getExpiredOAuthProviderSlugs("gmail", providers, byProvider),
    ).toEqual(["google"]);
    expect(
      getExpiredOAuthProviderSlugs("github-api", providers, byProvider),
    ).toEqual(["github"]);
  });

  it("falls back to the raw slug when publisher metadata has not loaded", () => {
    expect(getExpiredOAuthProviderSlugs("gmail", [], {})).toEqual(["google"]);
    expect(getExpiredOAuthProviderSlugs("custom-pub", [], {})).toEqual([
      "custom-pub",
    ]);
  });

  it("marks a provider expired when either its slug or a linked publisher slug expires", () => {
    expect(
      isOAuthProviderExpired("google", "provider-google", byProvider, [
        "gmail",
      ]),
    ).toBe(true);
    expect(
      isOAuthProviderExpired("google", "provider-google", byProvider, [
        "google",
      ]),
    ).toBe(true);
    expect(
      isOAuthProviderExpired("github", "provider-github", byProvider, [
        "gmail",
      ]),
    ).toBe(false);
  });

  it("knows Google BYOC publisher aliases for first-connect prompts", () => {
    expect(getKnownOAuthProviderForPublisher("google-meet")).toEqual({
      providerSlug: "google",
      providerName: "Google",
    });
    expect(getKnownOAuthProviderForPublisher("github-api")).toEqual({
      providerSlug: "github",
      providerName: "GitHub",
    });
    expect(humanizeOAuthProviderSlug("github-api")).toBe("GitHub API");
  });
});
