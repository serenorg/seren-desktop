// ABOUTME: Guards that every generated publisher client resolves against the configured API base.
// ABOUTME: An absolute base URL in a sub-spec sends that publisher's traffic to production regardless of VITE_SEREN_API_URL.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  apiBase: "https://api.serendb.com",
  API_BASE: "https://api.serendb.com",
}));

vi.mock("@/lib/fetch", () => ({
  appFetch: vi.fn(),
}));

import { createClientConfig } from "@/api/client-config";
import { appFetch } from "@/lib/fetch";

const GENERATED_ROOT = "src/api/generated";

/**
 * The gateway root client is generated from the top-level spec and correctly
 * declares `/`. Every other generated client is a publisher sub-spec.
 */
const GATEWAY_ROOT_CLIENT = "seren-core";

/** Discovered rather than listed so a newly generated client cannot slip past. */
function publisherClients(): string[] {
  return readdirSync(resolve(GENERATED_ROOT), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== GATEWAY_ROOT_CLIENT)
    .map((entry) => entry.name)
    .sort();
}

function clientSource(name: string): string {
  return readFileSync(
    resolve(`${GENERATED_ROOT}/${name}/client.gen.ts`),
    "utf-8",
  );
}

function baseUrlOf(name: string): string {
  const match = clientSource(name).match(/baseUrl: '([^']*)'/);
  expect(match, `${name} should declare a baseUrl`).toBeTruthy();
  return match?.[1] ?? "";
}

describe("generated publisher clients", () => {
  const clients = publisherClients();

  it("discovers the generated publisher clients", () => {
    expect(clients.length).toBeGreaterThan(0);
    expect(clients).toContain("seren-memory");
    expect(clients).not.toContain(GATEWAY_ROOT_CLIENT);
  });

  it.each(clients)("%s targets a gateway-relative publisher path", (name) => {
    // Relative so createClientConfig resolves it against apiBase. An absolute
    // URL here silently pins that publisher to whichever host the spec names.
    expect(baseUrlOf(name)).toBe(`/publishers/${name}`);
  });

  it.each(clients)("%s routes through createClientConfig", (name) => {
    expect(clientSource(name)).toContain(
      "createClientConfig(createConfig<ClientOptions2>(",
    );
  });

  it("resolves the gateway root client against the API base too", () => {
    expect(baseUrlOf(GATEWAY_ROOT_CLIENT)).toBe("/");
    expect(clientSource(GATEWAY_ROOT_CLIENT)).toContain(
      "createClientConfig(createConfig<ClientOptions2>(",
    );
  });

  it("resolves a relative publisher path against the configured API base", () => {
    // The reason the specs must stay relative: with VITE_SEREN_API_URL pointed
    // at a configured host, every publisher client must follow it.
    const config = createClientConfig({
      baseUrl: "/publishers/seren-memory",
    });

    expect(config.baseUrl).toBe(
      "https://api.serendb.com/publishers/seren-memory",
    );
    // Shared fetch path, so generated clients inherit token refresh, the
    // organization OTP challenge, and Tauri gateway routing.
    expect(config.fetch).toBe(appFetch);
  });

  it("keeps an absolute baseUrl override intact", () => {
    // Documents why an absolute URL in a spec is dangerous: it wins over the
    // configured base instead of being resolved against it.
    expect(
      createClientConfig({
        baseUrl: "https://publisher.example.com/publishers/x",
      }).baseUrl,
    ).toBe("https://publisher.example.com/publishers/x");
  });

  it("attaches the shared auth interceptor to the memory client", () => {
    const source = readFileSync(resolve("src/api/seren-memory.ts"), "utf-8");

    expect(source).toContain(
      'import { client } from "./generated/seren-memory/client.gen"',
    );
    expect(source).toContain("attachAuthInterceptor(client)");
  });
});
