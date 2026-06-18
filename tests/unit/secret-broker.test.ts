// ABOUTME: Unit tests for Seren Passwords reference-binding helpers.
// ABOUTME: Covers URI validation and .env migration filtering without Tauri.

import { describe, expect, test } from "vitest";
import {
  buildBindingReferences,
  buildEnvMigrationProposals,
  inferServiceFromFieldNames,
  isEnvVarName,
  isSerenSecretsReference,
  parseEnvVariableNames,
} from "@/lib/keys/secret-broker";

describe("isSerenSecretsReference", () => {
  test("accepts concrete Seren Secrets references", () => {
    expect(
      isSerenSecretsReference(
        "seren-secrets://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/password",
      ),
    ).toBe(true);
    expect(
      isSerenSecretsReference(
        "  seren-secrets://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/password  ",
      ),
    ).toBe(true);
  });

  test("rejects placeholders and malformed references", () => {
    expect(isSerenSecretsReference("seren-secrets://vault")).toBe(false);
    expect(
      isSerenSecretsReference("seren-secrets://vault-id/item-id/password"),
    ).toBe(false);
    expect(isSerenSecretsReference("seren-secret://vault/item/password")).toBe(
      false,
    );
    expect(isSerenSecretsReference("seren-secrets://")).toBe(false);
    expect(isSerenSecretsReference("plain-secret")).toBe(false);
  });

  // The native broker rejects userinfo/port/query/fragment and malformed
  // UUIDs; the UI validator must reject the same shapes so a reference the
  // UI accepts is never refused by the Rust broker on save.
  test("rejects shapes the native validator refuses", () => {
    const v = "11111111-1111-4111-8111-111111111111";
    const i = "22222222-2222-4222-8222-222222222222";
    expect(
      isSerenSecretsReference(`seren-secrets://${v}/${i}/password?f=x`),
    ).toBe(false);
    expect(
      isSerenSecretsReference(`seren-secrets://${v}/${i}/password#frag`),
    ).toBe(false);
    expect(
      isSerenSecretsReference(`seren-secrets://user@${v}/${i}/password`),
    ).toBe(false);
    expect(
      isSerenSecretsReference(`seren-secrets://user:pw@${v}/${i}/password`),
    ).toBe(false);
    expect(
      isSerenSecretsReference(`seren-secrets://${v}:1234/${i}/password`),
    ).toBe(false);
    expect(
      isSerenSecretsReference(`seren-secrets://${v}/${i}/password/extra`),
    ).toBe(false);
    expect(isSerenSecretsReference(`seren-secrets://${v}//${i}/password`)).toBe(
      false,
    );
    expect(isSerenSecretsReference(`seren-secrets://${v}/${i}//password`)).toBe(
      false,
    );
    // Nil UUIDs are not valid references.
    expect(
      isSerenSecretsReference(
        `seren-secrets://00000000-0000-0000-0000-000000000000/${i}/password`,
      ),
    ).toBe(false);
    expect(
      isSerenSecretsReference(
        `seren-secrets://${v}/01890f25-7b08-723d-bd8f-f9c1f9b59a7d/password`,
      ),
    ).toBe(true);
    // The native parser accepts unhyphenated UUIDs but its canonical-form
    // check rejects them; the UI must reject this shape too.
    expect(
      isSerenSecretsReference(
        `seren-secrets://11111111111141118111111111111111/${i}/password`,
      ),
    ).toBe(false);
    // A trailing slash with no field is a two-segment reference missing its
    // field; both validators collapse the empty segment and reject it.
    expect(isSerenSecretsReference(`seren-secrets://${v}/${i}/`)).toBe(false);
  });
});

describe("parseEnvVariableNames", () => {
  test("returns plaintext assignments and skips comments and references", () => {
    const names = parseEnvVariableNames(
      [
        "POLY_API_KEY=abc",
        "export KRAKEN_API_SECRET=def",
        "APCA_API_KEY_ID=seren-secrets://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/key",
        "#APCA_API_KEY_ID=no",
        "",
      ].join("\n"),
    );

    expect(names).toEqual(["POLY_API_KEY", "KRAKEN_API_SECRET"]);
  });
});

describe("buildBindingReferences", () => {
  const v = "11111111-1111-4111-8111-111111111111";
  const i = "22222222-2222-4222-8222-222222222222";

  test("maps each field to a seren-secrets reference keyed by env name", () => {
    const refs = buildBindingReferences(v, i, ["POLY_API_KEY", "POLY_SECRET"]);
    expect(refs).toEqual({
      POLY_API_KEY: `seren-secrets://${v}/${i}/POLY_API_KEY`,
      POLY_SECRET: `seren-secrets://${v}/${i}/POLY_SECRET`,
    });
    // Every produced value is a reference the native validator accepts.
    for (const ref of Object.values(refs)) {
      expect(isSerenSecretsReference(ref)).toBe(true);
    }
  });

  test("uppercases the env key and skips invalid env names", () => {
    const refs = buildBindingReferences(v, i, [" api_key ", "1BAD", ""]);
    expect(refs).toEqual({
      API_KEY: `seren-secrets://${v}/${i}/api_key`,
    });
  });
});

describe("inferServiceFromFieldNames", () => {
  test("infers the service from a recognizable field name", () => {
    expect(inferServiceFromFieldNames(["POLY_API_KEY", "X"])?.id).toBe(
      "polymarket",
    );
    expect(inferServiceFromFieldNames(["KRAKEN_API_SECRET"])?.id).toBe(
      "kraken",
    );
  });

  test("returns null when nothing matches", () => {
    expect(inferServiceFromFieldNames(["TOTALLY_UNKNOWN"])).toBeNull();
  });
});

describe("isEnvVarName", () => {
  test("accepts valid env vars and rejects others", () => {
    expect(isEnvVarName("POLY_API_KEY")).toBe(true);
    expect(isEnvVarName("api_key")).toBe(true);
    expect(isEnvVarName("1BAD")).toBe(false);
    expect(isEnvVarName("HAS SPACE")).toBe(false);
  });
});

describe("buildEnvMigrationProposals", () => {
  test("skips values already replaced with Seren Secrets references", () => {
    const proposals = buildEnvMigrationProposals([
      {
        skillId: "polymarket-bot",
        envPath: "~/.config/seren/skills/polymarket-bot/.env",
        contents: [
          "POLY_API_KEY=seren-secrets://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/api-key",
          "POLY_SECRET=plaintext-secret",
          "KRAKEN_API_KEY=seren-secrets://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/kraken",
        ].join("\n"),
      },
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      serviceId: "polymarket",
      skillId: "polymarket-bot",
      variableNames: ["POLY_SECRET"],
    });
  });
});
