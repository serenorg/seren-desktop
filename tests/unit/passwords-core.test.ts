import { describe, expect, test } from "vitest";
import {
  buildSerenSecretsFieldReferences,
  credentialNameForField,
  formatSerenSecretsReference,
  isEnvVarName,
  isSerenSecretsReference,
  parseCredentialReferenceLines,
  parseSerenSecretsReference,
  uniqueSerenSecretCredentialRefs,
  uniqueVaultIdsFromCredentialRefs,
} from "@seren/passwords-core";

const vaultId = "11111111-1111-4111-8111-111111111111";
const itemId = "22222222-2222-4222-8222-222222222222";

describe("Seren Secrets references", () => {
  test("parses canonical references", () => {
    expect(
      parseSerenSecretsReference(
        `seren-secrets://${vaultId}/${itemId}/password`,
      ),
    ).toEqual({ vaultId, itemId, field: "password" });
  });

  test("rejects placeholders and non-canonical shapes", () => {
    expect(isSerenSecretsReference("seren-secrets://vault/item/password")).toBe(
      false,
    );
    expect(
      isSerenSecretsReference(`seren-secrets://${vaultId}/${itemId}/password?x=1`),
    ).toBe(false);
    expect(
      isSerenSecretsReference(
        `seren-secrets://00000000-0000-0000-0000-000000000000/${itemId}/password`,
      ),
    ).toBe(false);
  });

  test("accepts non-v4 UUID versions (e.g. v7)", () => {
    const v7Vault = "0190d3f0-1c2a-7e8b-9abc-1234567890ab";
    const v7Item = "0190d3f0-1c2a-7e8b-8abc-0987654321ba";
    expect(
      parseSerenSecretsReference(
        `seren-secrets://${v7Vault}/${v7Item}/password`,
      ),
    ).toEqual({ vaultId: v7Vault, itemId: v7Item, field: "password" });
  });

  test("normalizes uppercase UUIDs to canonical lowercase", () => {
    expect(
      parseSerenSecretsReference(
        `seren-secrets://${vaultId.toUpperCase()}/${itemId.toUpperCase()}/password`,
      ),
    ).toEqual({ vaultId, itemId, field: "password" });
  });

  test("rejects a nil item id and empty/malformed path segments", () => {
    expect(
      isSerenSecretsReference(
        `seren-secrets://${vaultId}/00000000-0000-0000-0000-000000000000/password`,
      ),
    ).toBe(false);
    expect(
      isSerenSecretsReference(`seren-secrets://${vaultId}/${itemId}/`),
    ).toBe(false);
    expect(
      isSerenSecretsReference(`seren-secrets://${vaultId}/${itemId}`),
    ).toBe(false);
    expect(
      isSerenSecretsReference(
        `seren-secrets://${vaultId}/${itemId}/password/extra`,
      ),
    ).toBe(false);
    expect(
      isSerenSecretsReference(`seren-secrets://${vaultId}//password`),
    ).toBe(false);
  });

  test("formats references", () => {
    expect(formatSerenSecretsReference({ vaultId, itemId, field: "password" }))
      .toBe(`seren-secrets://${vaultId}/${itemId}/password`);
  });
});

describe("credential reference helpers", () => {
  test("parses environment assignment lines", () => {
    const parsed = parseCredentialReferenceLines(
      `api_key=seren-secrets://${vaultId}/${itemId}/password`,
    );
    expect(parsed).toEqual({
      refs: [
        {
          name: "API_KEY",
          ref_uri: `seren-secrets://${vaultId}/${itemId}/password`,
        },
      ],
      error: null,
    });
  });

  test("returns a line-specific error for invalid references", () => {
    expect(parseCredentialReferenceLines("API_KEY=seren-secrets://vault/item/key"))
      .toEqual({
        refs: [],
        error:
          "Line 1 must use a valid seren-secrets://vault/item/field reference.",
      });
  });

  test("extracts unique Seren Secrets references", () => {
    const refs = [
      { ref_uri: `seren-secrets://${vaultId}/${itemId}/password` },
      { ref_uri: `seren-secrets://${vaultId}/${itemId}/password` },
      { ref_uri: "org-secret://api-key" },
    ];

    expect(uniqueVaultIdsFromCredentialRefs(refs)).toEqual([vaultId]);
    expect(uniqueSerenSecretCredentialRefs(refs)).toEqual([
      { vaultId, itemId, field: "password" },
    ]);
  });
});

describe("field helpers", () => {
  test("maps selected fields to env-keyed references", () => {
    expect(
      buildSerenSecretsFieldReferences(vaultId, itemId, [
        " api_key ",
        "1BAD",
        "",
      ]),
    ).toEqual({
      API_KEY: `seren-secrets://${vaultId}/${itemId}/api_key`,
    });
  });

  test("normalizes field names into credential names", () => {
    expect(credentialNameForField("api key")).toBe("API_KEY");
    expect(credentialNameForField("1password")).toBe("SECRET_1PASSWORD");
    expect(credentialNameForField("")).toBe("SECRET");
  });

  test("validates environment variable names", () => {
    expect(isEnvVarName("POLY_API_KEY")).toBe(true);
    expect(isEnvVarName("api_key")).toBe(true);
    expect(isEnvVarName("1BAD")).toBe(false);
    expect(isEnvVarName("HAS SPACE")).toBe(false);
  });
});
