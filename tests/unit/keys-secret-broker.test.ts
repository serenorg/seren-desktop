// ABOUTME: Regression guards for issue #1823 key-broker policy invariants.
// ABOUTME: Verifies per-skill binding, always-ask defaults, and .env migration planning.

import { describe, expect, it } from "vitest";
import {
  buildEnvMigrationProposals,
  buildSkillSecretBindingId,
  DEFAULT_KEY_APPROVAL_POLICY,
  findKeyServiceForEnvVar,
} from "@/lib/keys/secret-broker";

describe("Keys secret broker policy (#1823)", () => {
  it("binds credentials to service + skill, never service alone", () => {
    expect(
      buildSkillSecretBindingId({
        serviceId: "polymarket",
        skillId: "polymarket-bot",
      }),
    ).toBe("polymarket::polymarket-bot");
    expect(
      buildSkillSecretBindingId({
        serviceId: "polymarket",
        skillId: "paired-basis-maker",
      }),
    ).toBe("polymarket::paired-basis-maker");
  });

  it("defaults every new key to $0 always ask and session approval defaults", () => {
    expect(DEFAULT_KEY_APPROVAL_POLICY.perTransactionCapUsd).toBe(0);
    expect(DEFAULT_KEY_APPROVAL_POLICY.mode).toBe("always_ask");
    expect(DEFAULT_KEY_APPROVAL_POLICY.sessionDurationMinutes).toBe(30);
    expect(DEFAULT_KEY_APPROVAL_POLICY.sessionCapUsd).toBe(200);
    expect(DEFAULT_KEY_APPROVAL_POLICY.logEveryUse).toBe(true);
  });

  it("recognizes known exchange, wallet, payment, and Seren environment variables", () => {
    expect(findKeyServiceForEnvVar("POLY_API_KEY")?.id).toBe("polymarket");
    expect(findKeyServiceForEnvVar("POLYMARKET_PRIVATE_KEY")?.id).toBe(
      "polymarket",
    );
    expect(findKeyServiceForEnvVar("KRAKEN_API_SECRET")?.id).toBe("kraken");
    expect(findKeyServiceForEnvVar("APCA_API_SECRET_KEY")?.id).toBe("alpaca");
    expect(findKeyServiceForEnvVar("HYPERLIQUID_PRIVATE_KEY")?.id).toBe(
      "hyperliquid",
    );
    expect(findKeyServiceForEnvVar("WISE_API_TOKEN")?.id).toBe("payments");
    expect(findKeyServiceForEnvVar("SEREN_API_KEY")?.id).toBe("seren-api");
    expect(findKeyServiceForEnvVar("UNRELATED_VALUE")).toBeNull();
  });

  it("plans .env imports as per-skill proposals and keeps original files rename-only", () => {
    const proposals = buildEnvMigrationProposals([
      {
        skillId: "polymarket-bot",
        envPath: "/Users/test/.config/seren/skills/polymarket-bot/.env",
        contents:
          "POLY_API_KEY=abc\nPOLY_SECRET=def\nSEREN_API_KEY=seren\nNOT_SECRET=ok\n",
      },
      {
        skillId: "paired-basis-maker",
        envPath: "/Users/test/.config/seren/skills/paired-basis-maker/.env",
        contents: "POLY_API_KEY=ghi\n",
      },
    ]);

    expect(proposals).toHaveLength(3);
    expect(
      proposals.map((proposal) => [
        proposal.serviceId,
        proposal.skillId,
        proposal.variableNames,
      ]),
    ).toEqual([
      ["polymarket", "polymarket-bot", ["POLY_API_KEY", "POLY_SECRET"]],
      ["seren-api", "polymarket-bot", ["SEREN_API_KEY"]],
      ["polymarket", "paired-basis-maker", ["POLY_API_KEY"]],
    ]);
    expect(proposals.every((proposal) => proposal.requiresConfirmation)).toBe(
      true,
    );
    expect(
      proposals.every(
        (proposal) =>
          proposal.postImportAction === "rename_env_to_env_migrated",
      ),
    ).toBe(true);
    expect(proposals[0].migratedPath).toBe(
      "/Users/test/.config/seren/skills/polymarket-bot/.env.migrated",
    );
  });
});
