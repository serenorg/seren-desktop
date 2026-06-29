// ABOUTME: Client-side policy helpers for Seren Passwords reference bindings.
// ABOUTME: Keeps service/skill binding and migration behavior testable without Tauri.

import {
  buildSerenSecretsFieldReferences,
  isEnvVarName,
  isSerenSecretsReference,
} from "@seren/passwords-core";

export { isEnvVarName, isSerenSecretsReference };

export type KeyApprovalMode = "always_ask" | "auto_approve_cap";
export type SecretBindingSource = "local_store" | "seren_passwords";

export interface KeyApprovalPolicy {
  mode: KeyApprovalMode;
  perTransactionCapUsd: number;
  sessionDurationMinutes: number;
  sessionCapUsd: number;
  logEveryUse: boolean;
}

export interface KeyServiceDefinition {
  id: string;
  name: string;
  accent: string;
  icon: string;
  envPrefixes: string[];
  envNames: string[];
  defaultVariables: string[];
  systemShared?: boolean;
}

export interface SkillSecretBindingIdentity {
  serviceId: string;
  skillId: string;
}

export interface SkillSecretBinding {
  id: string;
  source: SecretBindingSource;
  serviceId: string;
  serviceName: string;
  skillId: string;
  skillName: string;
  variableNames: string[];
  secretCount: number;
  approvalPolicy: KeyApprovalPolicy;
  lastUsedAt: string | null;
  activeSession: SecretAccessSession | null;
}

export interface SkillSecretEnvRequest {
  bindingId: string;
  operation: string;
  amountUsd?: number;
}

export interface SkillSecretEnvResponse {
  bindingId: string;
  variableNames: string[];
  secretValues: Record<string, string>;
  referenceValues: Record<string, string>;
  decision: "session_approved" | "auto_approved";
  activeSessionId: string | null;
}

export interface SecretAccessSession {
  id: string;
  bindingId: string;
  serviceId: string;
  skillId: string;
  grantedAt: string;
  expiresAt: string;
  capUsd: number;
  spentUsd: number;
  endedAt: string | null;
  endedReason: "time" | "cap" | "user_ended" | "key_edited" | null;
}

export interface SecretAuditEvent {
  id: string;
  bindingId: string;
  serviceId: string;
  serviceName: string;
  skillId: string;
  skillName: string;
  operation: string;
  amountUsd: number | null;
  decision:
    | "approved_by_user"
    | "auto_approved"
    | "session_approved"
    | "denied_by_user"
    | "session_start"
    | "session_end"
    | "import_proposed"
    | "approval_required"
    | "key_edited";
  createdAt: string;
  detail: string;
}

export interface EnvFileForMigration {
  skillId: string;
  envPath: string;
  contents: string;
}

export interface SkillEnvMigrationProposal {
  id: string;
  serviceId: string;
  serviceName: string;
  skillId: string;
  sourcePath: string;
  migratedPath: string;
  variableNames: string[];
  requiresConfirmation: true;
  postImportAction: "rename_env_to_env_migrated";
}

export const DEFAULT_KEY_APPROVAL_POLICY: KeyApprovalPolicy = {
  mode: "always_ask",
  perTransactionCapUsd: 0,
  sessionDurationMinutes: 30,
  sessionCapUsd: 200,
  logEveryUse: true,
};

export const KEY_SERVICES: KeyServiceDefinition[] = [
  {
    id: "polymarket",
    name: "Polymarket",
    accent: "bg-fuchsia-500",
    icon: "🤖",
    envPrefixes: ["POLY_", "POLYMARKET_"],
    envNames: [
      "POLY_API_KEY",
      "POLY_PASSPHRASE",
      "POLY_SECRET",
      "POLY_PRIVATE_KEY",
      "POLYMARKET_PRIVATE_KEY",
      "POLYMARKET_WALLET_ADDRESS",
    ],
    defaultVariables: [
      "POLY_API_KEY",
      "POLY_PASSPHRASE",
      "POLY_SECRET",
      "POLY_PRIVATE_KEY",
    ],
  },
  {
    id: "kraken",
    name: "Kraken",
    accent: "bg-sky-400",
    icon: "⚓",
    envPrefixes: ["KRAKEN_"],
    envNames: ["KRAKEN_API_KEY", "KRAKEN_API_SECRET", "KRAKEN_API_SECRET_KEY"],
    defaultVariables: ["KRAKEN_API_KEY", "KRAKEN_API_SECRET"],
  },
  {
    id: "alpaca",
    name: "Alpaca",
    accent: "bg-emerald-400",
    icon: "▰",
    envPrefixes: ["APCA_"],
    envNames: ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY", "APCA_API_BASE_URL"],
    defaultVariables: ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY"],
  },
  {
    id: "hyperliquid",
    name: "Hyperliquid",
    accent: "bg-purple-400",
    icon: "₿",
    envPrefixes: ["HYPERLIQUID_"],
    envNames: ["HYPERLIQUID_PRIVATE_KEY"],
    defaultVariables: ["HYPERLIQUID_PRIVATE_KEY"],
  },
  {
    id: "payments",
    name: "Payments",
    accent: "bg-amber-400",
    icon: "💳",
    envPrefixes: ["WISE_", "VENMO_", "PAYPAL_"],
    envNames: [
      "WISE_API_TOKEN",
      "VENMO_COOKIES",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
    ],
    defaultVariables: ["WISE_API_TOKEN", "PAYPAL_CLIENT_ID"],
  },
  {
    id: "seren-api",
    name: "Seren API",
    accent: "bg-green-400",
    icon: "⚡",
    envPrefixes: [],
    envNames: ["SEREN_API_KEY", "API_KEY"],
    defaultVariables: ["SEREN_API_KEY"],
    systemShared: true,
  },
];

const SERVICE_BY_ID = new Map(
  KEY_SERVICES.map((service) => [service.id, service]),
);

export function getKeyService(serviceId: string): KeyServiceDefinition | null {
  return SERVICE_BY_ID.get(serviceId) ?? null;
}

export function findKeyServiceForEnvVar(
  variableName: string,
): KeyServiceDefinition | null {
  const normalized = variableName.trim().toUpperCase();
  if (!normalized) return null;

  const exact = KEY_SERVICES.find((service) =>
    service.envNames.includes(normalized),
  );
  if (exact) return exact;

  return (
    KEY_SERVICES.find((service) =>
      service.envPrefixes.some((prefix) => normalized.startsWith(prefix)),
    ) ?? null
  );
}

export function buildSkillSecretBindingId(
  identity: SkillSecretBindingIdentity,
): string {
  return `${identity.serviceId}::${identity.skillId}`;
}

/**
 * Build the ENV -> seren-secrets:// reference map a binding stores, from a vault
 * entry's chosen field names. A vault entry's fields are already named as env
 * vars, so each field becomes an env var of the same (uppercased) name pointing
 * at its field in the entry. Field names that are not valid env vars are skipped
 * (the caller surfaces them and steers to the advanced editor).
 */
export function buildBindingReferences(
  vaultId: string,
  itemId: string,
  fieldNames: string[],
): Record<string, string> {
  return buildSerenSecretsFieldReferences(vaultId, itemId, fieldNames);
}

/**
 * Infer which service a vault entry belongs to from its field names, so the
 * friendly flow does not need an explicit Service pick in the common case.
 */
export function inferServiceFromFieldNames(
  fieldNames: string[],
): KeyServiceDefinition | null {
  for (const name of fieldNames) {
    const service = findKeyServiceForEnvVar(name);
    if (service) return service;
  }
  return null;
}

interface EnvAssignment {
  name: string;
  value: string;
}

export function buildEnvMigrationProposals(
  envFiles: EnvFileForMigration[],
): SkillEnvMigrationProposal[] {
  const proposals: SkillEnvMigrationProposal[] = [];

  for (const envFile of envFiles) {
    const variablesByService = new Map<string, Set<string>>();
    for (const { name: variableName, value } of parseEnvAssignments(
      envFile.contents,
    )) {
      if (!value || isSerenSecretsReference(value)) continue;
      const service = findKeyServiceForEnvVar(variableName);
      if (!service) continue;

      const names = variablesByService.get(service.id) ?? new Set<string>();
      names.add(variableName);
      variablesByService.set(service.id, names);
    }

    for (const [serviceId, names] of variablesByService.entries()) {
      const service = getKeyService(serviceId);
      if (!service) continue;

      proposals.push({
        id: buildSkillSecretBindingId({
          serviceId,
          skillId: envFile.skillId,
        }),
        serviceId,
        serviceName: service.name,
        skillId: envFile.skillId,
        sourcePath: envFile.envPath,
        migratedPath: envFile.envPath.replace(/\.env$/, ".env.migrated"),
        variableNames: Array.from(names),
        requiresConfirmation: true,
        postImportAction: "rename_env_to_env_migrated",
      });
    }
  }

  return proposals;
}

function parseEnvAssignments(contents: string): EnvAssignment[] {
  const assignments: EnvAssignment[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const normalized = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(normalized);
    if (!match) continue;
    const value = match[2]?.trim().replace(/^(['"])(.*)\1$/, "$2") ?? "";

    assignments.push({
      name: match[1].toUpperCase(),
      value,
    });
  }
  return assignments;
}

export function parseEnvVariableNames(contents: string): string[] {
  return parseEnvAssignments(contents)
    .filter(({ value }) => value && !isSerenSecretsReference(value))
    .map(({ name }) => name);
}

export function groupBindingsByService(bindings: SkillSecretBinding[]): Array<{
  service: KeyServiceDefinition;
  bindings: SkillSecretBinding[];
}> {
  const groups = new Map<string, SkillSecretBinding[]>();
  for (const binding of bindings) {
    const current = groups.get(binding.serviceId) ?? [];
    current.push(binding);
    groups.set(binding.serviceId, current);
  }

  return Array.from(groups.entries()).map(([serviceId, groupedBindings]) => ({
    service:
      getKeyService(serviceId) ??
      ({
        id: serviceId,
        name: groupedBindings[0]?.serviceName ?? serviceId,
        accent: "bg-muted-foreground",
        icon: "🔑",
        envPrefixes: [],
        envNames: [],
        defaultVariables: [],
      } satisfies KeyServiceDefinition),
    bindings: groupedBindings,
  }));
}

export function createDemoKeyBindings(now = new Date()): SkillSecretBinding[] {
  const activeSession: SecretAccessSession = {
    id: "session_high-throughput-basis-maker",
    bindingId: "polymarket::high-throughput-basis-maker",
    serviceId: "polymarket",
    skillId: "high-throughput-basis-maker",
    grantedAt: new Date(now.getTime() - 12 * 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 28 * 60_000).toISOString(),
    capUsd: 200,
    spentUsd: 42,
    endedAt: null,
    endedReason: null,
  };

  return [
    {
      id: "polymarket::polymarket-bot",
      source: "seren_passwords",
      serviceId: "polymarket",
      serviceName: "Polymarket",
      skillId: "polymarket-bot",
      skillName: "polymarket-bot",
      variableNames: [
        "POLY_API_KEY",
        "POLY_PASSPHRASE",
        "POLY_SECRET",
        "POLY_PRIVATE_KEY",
      ],
      secretCount: 4,
      approvalPolicy: { ...DEFAULT_KEY_APPROVAL_POLICY },
      lastUsedAt: new Date(now.getTime() - 12 * 60_000).toISOString(),
      activeSession: null,
    },
    {
      id: "polymarket::paired-basis-maker",
      source: "seren_passwords",
      serviceId: "polymarket",
      serviceName: "Polymarket",
      skillId: "paired-basis-maker",
      skillName: "paired-basis-maker",
      variableNames: [
        "POLY_API_KEY",
        "POLY_PASSPHRASE",
        "POLY_SECRET",
        "POLY_PRIVATE_KEY",
      ],
      secretCount: 4,
      approvalPolicy: {
        ...DEFAULT_KEY_APPROVAL_POLICY,
        mode: "auto_approve_cap",
        perTransactionCapUsd: 5,
      },
      lastUsedAt: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
      activeSession: null,
    },
    {
      id: "polymarket::high-throughput-basis-maker",
      source: "seren_passwords",
      serviceId: "polymarket",
      serviceName: "Polymarket",
      skillId: "high-throughput-basis-maker",
      skillName: "high-throughput-basis-maker",
      variableNames: [
        "POLY_API_KEY",
        "POLY_PASSPHRASE",
        "POLY_SECRET",
        "POLY_PRIVATE_KEY",
      ],
      secretCount: 4,
      approvalPolicy: { ...DEFAULT_KEY_APPROVAL_POLICY },
      lastUsedAt: new Date(now.getTime() - 4 * 60_000).toISOString(),
      activeSession,
    },
    {
      id: "kraken::grid-trader",
      source: "seren_passwords",
      serviceId: "kraken",
      serviceName: "Kraken",
      skillId: "grid-trader",
      skillName: "grid-trader",
      variableNames: ["KRAKEN_API_KEY", "KRAKEN_API_SECRET"],
      secretCount: 2,
      approvalPolicy: {
        ...DEFAULT_KEY_APPROVAL_POLICY,
        mode: "auto_approve_cap",
        perTransactionCapUsd: 25,
      },
      lastUsedAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
      activeSession: null,
    },
    {
      id: "seren-api::system",
      source: "seren_passwords",
      serviceId: "seren-api",
      serviceName: "Seren API",
      skillId: "system",
      skillName: "system",
      variableNames: ["SEREN_API_KEY"],
      secretCount: 1,
      approvalPolicy: {
        ...DEFAULT_KEY_APPROVAL_POLICY,
        mode: "auto_approve_cap",
        perTransactionCapUsd: 100,
      },
      lastUsedAt: new Date(now.getTime() - 7 * 60_000).toISOString(),
      activeSession: null,
    },
  ];
}

export function createDemoAuditEvents(now = new Date()): SecretAuditEvent[] {
  return [
    {
      id: "evt-1",
      bindingId: "polymarket::high-throughput-basis-maker",
      serviceId: "polymarket",
      serviceName: "Polymarket",
      skillId: "high-throughput-basis-maker",
      skillName: "high-throughput-basis-maker",
      operation: "Buy YES @ 0.41 · paired leg (NFL — Bills/Chiefs)",
      amountUsd: 8.4,
      decision: "session_approved",
      createdAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
      detail: "Session-approved",
    },
    {
      id: "evt-2",
      bindingId: "polymarket::high-throughput-basis-maker",
      serviceId: "polymarket",
      serviceName: "Polymarket",
      skillId: "high-throughput-basis-maker",
      skillName: "high-throughput-basis-maker",
      operation: "Sell NO @ 0.59 · paired leg (NFL — Bills/Chiefs)",
      amountUsd: 11.1,
      decision: "session_approved",
      createdAt: new Date(now.getTime() - 4 * 60_000).toISOString(),
      detail: "Session-approved",
    },
    {
      id: "evt-3",
      bindingId: "polymarket::high-throughput-basis-maker",
      serviceId: "polymarket",
      serviceName: "Polymarket",
      skillId: "high-throughput-basis-maker",
      skillName: "high-throughput-basis-maker",
      operation: "Session granted · 30 min · $200 cap",
      amountUsd: null,
      decision: "session_start",
      createdAt: new Date(now.getTime() - 12 * 60_000).toISOString(),
      detail: "Approved by you",
    },
    {
      id: "evt-4",
      bindingId: "kraken::grid-trader",
      serviceId: "kraken",
      serviceName: "Kraken",
      skillId: "grid-trader",
      skillName: "grid-trader",
      operation: "Place limit · XBT/USD @ 67,420",
      amountUsd: 15,
      decision: "auto_approved",
      createdAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
      detail: "Auto-approved (cap $25)",
    },
    {
      id: "evt-5",
      bindingId: "polymarket::polymarket-bot",
      serviceId: "polymarket",
      serviceName: "Polymarket",
      skillId: "polymarket-bot",
      skillName: "polymarket-bot",
      operation: 'Buy YES @ 0.55 · "CPI > 3.2% this month"',
      amountUsd: 150,
      decision: "denied_by_user",
      createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000).toISOString(),
      detail: "Denied by you",
    },
  ];
}

export function createDemoMigrationProposals(): SkillEnvMigrationProposal[] {
  return buildEnvMigrationProposals([
    {
      skillId: "polymarket-bot",
      envPath: "~/.config/seren/skills/polymarket-bot/.env",
      contents: "POLY_API_KEY=x\nPOLY_SECRET=x\nPOLY_PRIVATE_KEY=x\n",
    },
    {
      skillId: "grid-trader",
      envPath: "~/.config/seren/skills/grid-trader/.env",
      contents: "KRAKEN_API_KEY=x\nKRAKEN_API_SECRET=x\n",
    },
    {
      skillId: "5x-btc-usdc-withdraw",
      envPath: "~/.config/seren/skills/5x-btc-usdc-withdraw/.env",
      contents: "HYPERLIQUID_PRIVATE_KEY=x\nSEREN_API_KEY=x\n",
    },
  ]);
}
