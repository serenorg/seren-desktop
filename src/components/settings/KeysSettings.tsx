// ABOUTME: Settings surface for skill-scoped Seren Passwords references.
// ABOUTME: Binds agent env vars to seren-secrets:// refs without storing plaintext in Desktop.

import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  buildBindingReferences,
  DEFAULT_KEY_APPROVAL_POLICY,
  getKeyService,
  groupBindingsByService,
  inferServiceFromFieldNames,
  isEnvVarName,
  isSerenSecretsReference,
  KEY_SERVICES,
  type KeyServiceDefinition,
  type SecretAccessSession,
  type SecretAuditEvent,
  type SkillEnvMigrationProposal,
  type SkillSecretBinding,
} from "@/lib/keys/secret-broker";
import { employees } from "@/services/employees";
import {
  createPasswordsVault,
  endSkillSecretSession,
  getPasswordsItem,
  listPasswordsItems,
  listSecretAccessAudit,
  listSkillSecretBindings,
  lockPasswordsVault,
  type PasswordsItemDetail,
  type PasswordsItemSummary,
  type PasswordsVaultSummary,
  savePasswordsApiCredential,
  scanSkillEnvMigrations,
  setupPasswordsVault,
  unlockPasswordsVault,
  upsertSkillSecretBinding,
} from "@/services/keys";
import { skillsStore } from "@/stores/skills.store";

type KeysTab = "stored" | "activity" | "migration";
type GrantTargetChoice = {
  id: string;
  bindingId: string;
  label: string;
  kind: "agent" | "skill";
};

const SKILL_CHOICES = [
  "my-agent",
  "research-assistant",
  "data-pipeline",
  "market-monitor",
  "trading-bot",
  "ops-automation",
];

const DEFAULT_SERVICE_ID = "polymarket";
const DEFAULT_SKILL_ID = "my-agent";
const MIN_MASTER_PASSWORD_LENGTH = 8;
const MIN_MASTER_PASSWORD_BITS = 60;
const PASSWORDS_IDLE_LOCK_HOURS = 4;
const PASSWORDS_IDLE_LOCK_MS = PASSWORDS_IDLE_LOCK_HOURS * 60 * 60 * 1000;
const DECISION_LABELS: Record<SecretAuditEvent["decision"], string> = {
  approved_by_user: "Approved by you",
  auto_approved: "Auto-approved",
  session_approved: "Session-approved",
  denied_by_user: "Denied by you",
  session_start: "Approved by you",
  session_end: "Session ended",
  import_proposed: "Import proposed",
  approval_required: "Approval required",
  key_edited: "References edited",
};

function formatUsd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "";
  return `$${amount.toFixed(amount % 1 === 0 ? 0 : 2)}`;
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatRelativeTime(value: string | null): string {
  if (!value) return "Never";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "Recently";
  const minutes = Math.max(1, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function sessionMinutesLeft(session: SecretAccessSession): number {
  return Math.max(
    0,
    Math.round((new Date(session.expiresAt).getTime() - Date.now()) / 60_000),
  );
}

function bindingPill(binding: SkillSecretBinding): string {
  const session = binding.activeSession;
  if (session && !session.endedAt) {
    return `session · ${sessionMinutesLeft(session)} min left · ${formatUsd(
      session.spentUsd,
    )} / ${formatUsd(session.capUsd)}`;
  }

  if (binding.approvalPolicy.mode === "always_ask") return "always ask";

  return `cap ${formatUsd(binding.approvalPolicy.perTransactionCapUsd)}/tx`;
}

function bindingSourceLabel(binding: SkillSecretBinding): string {
  return binding.source === "local_store" ? "Local store" : "Seren Passwords";
}

function decisionClass(decision: SecretAuditEvent["decision"]): string {
  if (decision === "session_approved" || decision === "session_start") {
    return "text-purple-300";
  }
  if (decision === "auto_approved") return "text-emerald-300";
  if (decision === "denied_by_user") return "text-red-300";
  return "text-amber-300";
}

function selectedServiceDefaultVariables(
  service: KeyServiceDefinition | null,
): string[] {
  return service?.defaultVariables.length
    ? service.defaultVariables
    : ["API_KEY"];
}

function estimateMasterPasswordBits(password: string): number {
  if (password.length === 0) return 0;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^A-Za-z0-9]/.test(password)) pool += 33;

  let maxRun = 1;
  let run = 1;
  for (let index = 1; index < password.length; index += 1) {
    if (password[index] === password[index - 1]) {
      run += 1;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 1;
    }
  }
  const repeatedRunPenalty = maxRun > 2 ? (maxRun - 2) * 4 : 0;
  const unique = new Set(password).size;
  const lowVarietyPenalty = unique <= 2 ? 32 : unique <= 4 ? 16 : 0;
  return Math.max(
    0,
    Math.round(
      password.length * Math.log2(Math.max(pool, 1)) -
        repeatedRunPenalty -
        lowVarietyPenalty,
    ),
  );
}

export const KeysSettings: Component = () => {
  const [tab, setTab] = createSignal<KeysTab>("stored");
  const [showAddForm, setShowAddForm] = createSignal(false);
  const [prefillCredential, setPrefillCredential] = createSignal<{
    vaultId: string;
    itemId: string;
  } | null>(null);
  const [selectedServiceId, setSelectedServiceId] =
    createSignal(DEFAULT_SERVICE_ID);
  const [selectedSkillId, setSelectedSkillId] = createSignal(DEFAULT_SKILL_ID);
  const [referenceLines, setReferenceLines] = createSignal("");
  const [saveMessage, setSaveMessage] = createSignal<string | null>(null);
  const [vaults, setVaults] = createSignal<PasswordsVaultSummary[]>([]);
  const [selectedVaultId, setSelectedVaultId] = createSignal("");
  const [vaultItems, setVaultItems] = createSignal<PasswordsItemSummary[]>([]);
  const [selectedVaultItem, setSelectedVaultItem] =
    createSignal<PasswordsItemDetail | null>(null);
  const [vaultMessage, setVaultMessage] = createSignal<string | null>(null);
  const [recoveryKeyDisplay, setRecoveryKeyDisplay] = createSignal<
    string | null
  >(null);
  const [vaultBusy, setVaultBusy] = createSignal(false);
  const [migrationBannerDismissed, setMigrationBannerDismissed] =
    createSignal(false);
  let vaultItemsRequestId = 0;
  let vaultItemDetailRequestId = 0;

  const [bindings, { refetch: refetchBindings }] = createResource(
    listSkillSecretBindings,
  );
  const [audit, { refetch: refetchAudit }] = createResource(
    listSecretAccessAudit,
  );
  const [migrationProposals, { refetch: refetchMigrationProposals }] =
    createResource(scanSkillEnvMigrations);
  // Agents the user has created. Cloud-backed, so failures fall back to empty
  // (installed skills still populate the picker).
  const [employeeList] = createResource(async () => {
    try {
      return await employees.list();
    } catch {
      return [];
    }
  });

  const bindingList = () => bindings() ?? [];
  const auditList = () => audit() ?? [];
  const migrationList = () => migrationProposals() ?? [];
  const serviceGroups = createMemo(() => groupBindingsByService(bindingList()));
  const activeSessions = createMemo(() =>
    bindingList()
      .map((binding) => binding.activeSession)
      .filter(
        (session): session is SecretAccessSession =>
          Boolean(session) && !session?.endedAt,
      ),
  );
  const selectedService = () => getKeyService(selectedServiceId());
  const selectedVault = () =>
    vaults().find((vault) => vault.vaultId === selectedVaultId()) ?? null;
  const duplicateBinding = () =>
    bindingList().find(
      (binding) =>
        binding.serviceId === selectedServiceId() &&
        binding.skillId === selectedSkillId(),
    );

  const selectedVariables = () =>
    selectedServiceDefaultVariables(selectedService());

  const refreshVaultItems = async (vaultId = selectedVaultId()) => {
    const requestId = ++vaultItemsRequestId;
    if (!vaultId) {
      setVaultItems([]);
      return;
    }
    let items: PasswordsItemSummary[];
    try {
      items = await listPasswordsItems(vaultId);
    } catch (error) {
      if (requestId !== vaultItemsRequestId || selectedVaultId() !== vaultId) {
        return;
      }
      throw error;
    }
    if (requestId !== vaultItemsRequestId || selectedVaultId() !== vaultId) {
      return;
    }
    setVaultItems(items);
  };

  const parseReferenceLines = () => {
    const values: Record<string, string> = {};
    const errors: string[] = [];
    for (const [index, rawLine] of referenceLines().split(/\r?\n/).entries()) {
      const line = rawLine.trim();
      if (!line) continue;
      const [rawName, ...rest] = line.split("=");
      const name = rawName?.trim().toUpperCase();
      const uri = rest.join("=").trim();
      if (!name || !uri) {
        errors.push(`Line ${index + 1} must use ENV_NAME=seren-secrets://...`);
        continue;
      }
      if (!/^[_A-Z][_A-Z0-9]*$/.test(name)) {
        errors.push(`Line ${index + 1} has an invalid environment variable`);
        continue;
      }
      if (!isSerenSecretsReference(uri)) {
        errors.push(
          `Line ${index + 1} must be a valid seren-secrets:// reference`,
        );
        continue;
      }
      values[name] = uri;
    }
    return { values, errors };
  };

  const handleUnlockVault = async (masterPassword: string) => {
    setVaultBusy(true);
    setVaultMessage(null);
    vaultItemDetailRequestId += 1;
    try {
      const unlocked = await unlockPasswordsVault(masterPassword);
      setVaults(unlocked.vaults);
      const firstWritable =
        unlocked.vaults.find((vault) => vault.writable) ?? unlocked.vaults[0];
      setSelectedVaultId(firstWritable?.vaultId ?? "");
      setSelectedVaultItem(null);
      if (firstWritable) {
        await refreshVaultItems(firstWritable.vaultId);
      } else {
        setVaultItems([]);
      }
      setVaultMessage(
        unlocked.vaults.length === 0
          ? "No vaults are available for this account."
          : "Vault unlocked for this desktop session.",
      );
      setRecoveryKeyDisplay(null);
    } catch (error) {
      setVaultMessage(`Could not unlock vault: ${String(error)}`);
    } finally {
      setVaultBusy(false);
    }
  };

  const handleLockVault = async () => {
    vaultItemsRequestId += 1;
    vaultItemDetailRequestId += 1;
    setVaultBusy(true);
    try {
      await lockPasswordsVault();
      setVaults([]);
      setSelectedVaultId("");
      setVaultItems([]);
      setSelectedVaultItem(null);
      setVaultMessage(null);
      setRecoveryKeyDisplay(null);
      // Granting needs an unlocked vault, so close any open create flow.
      setShowAddForm(false);
      setPrefillCredential(null);
    } finally {
      setVaultBusy(false);
    }
  };

  let vaultIdleTimer: number | null = null;
  let lastVaultActivityAt = Date.now();
  let vaultHiddenAt: number | null = null;
  const vaultUnlocked = () => vaults().length > 0;

  const clearVaultIdleTimer = () => {
    if (vaultIdleTimer === null) return;
    window.clearTimeout(vaultIdleTimer);
    vaultIdleTimer = null;
  };

  const lockVaultForIdle = async () => {
    if (!vaultUnlocked()) return;
    clearVaultIdleTimer();
    try {
      await handleLockVault();
      setVaultMessage("Vault locked after inactivity.");
    } catch (error) {
      setVaultMessage(`Could not lock vault: ${String(error)}`);
    }
  };

  const armVaultIdleTimer = () => {
    clearVaultIdleTimer();
    if (!vaultUnlocked()) return;
    const elapsed = Date.now() - lastVaultActivityAt;
    const remaining = Math.max(PASSWORDS_IDLE_LOCK_MS - elapsed, 0);
    vaultIdleTimer = window.setTimeout(() => {
      void lockVaultForIdle();
    }, remaining);
  };

  const recordVaultActivity = () => {
    if (!vaultUnlocked()) return;
    lastVaultActivityAt = Date.now();
    armVaultIdleTimer();
  };

  const handleVaultVisibilityChange = () => {
    if (!vaultUnlocked()) return;
    if (document.visibilityState === "hidden") {
      vaultHiddenAt = Date.now();
      return;
    }
    if (vaultHiddenAt && Date.now() - vaultHiddenAt >= PASSWORDS_IDLE_LOCK_MS) {
      vaultHiddenAt = null;
      void lockVaultForIdle();
      return;
    }
    vaultHiddenAt = null;
    armVaultIdleTimer();
  };

  onMount(() => {
    const activityEvents = [
      "pointerdown",
      "keydown",
      "wheel",
      "touchstart",
    ] as const;
    for (const eventName of activityEvents) {
      window.addEventListener(eventName, recordVaultActivity, {
        passive: true,
      });
    }
    document.addEventListener("visibilitychange", handleVaultVisibilityChange);
    onCleanup(() => {
      clearVaultIdleTimer();
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, recordVaultActivity);
      }
      document.removeEventListener(
        "visibilitychange",
        handleVaultVisibilityChange,
      );
    });
  });

  createEffect(() => {
    if (vaultUnlocked()) {
      lastVaultActivityAt = Date.now();
      armVaultIdleTimer();
    } else {
      clearVaultIdleTimer();
      vaultHiddenAt = null;
    }
  });

  const handleSetupVault = async (input: {
    masterPassword: string;
    displayName: string;
    vaultName: string;
  }) => {
    setVaultBusy(true);
    setVaultMessage(null);
    setRecoveryKeyDisplay(null);
    try {
      const setup = await setupPasswordsVault(input);
      setVaults(setup.vaults);
      const personalVault =
        setup.vaults.find((vault) => vault.vaultId === setup.personalVaultId) ??
        setup.vaults.find((vault) => vault.writable) ??
        setup.vaults[0];
      setSelectedVaultId(personalVault?.vaultId ?? "");
      vaultItemDetailRequestId += 1;
      setSelectedVaultItem(null);
      if (personalVault) {
        await refreshVaultItems(personalVault.vaultId);
      } else {
        setVaultItems([]);
      }
      setRecoveryKeyDisplay(setup.recoveryKeyDisplay);
      setVaultMessage("Vault created and unlocked for this desktop session.");
    } catch (error) {
      setVaultMessage(`Could not create vault: ${String(error)}`);
    } finally {
      setVaultBusy(false);
    }
  };

  const handleCreateVault = async (input: {
    name: string;
    description?: string;
  }) => {
    setVaultBusy(true);
    setVaultMessage(null);
    try {
      const previousIds = new Set(vaults().map((vault) => vault.vaultId));
      const result = await createPasswordsVault(input);
      setVaults(result.vaults);
      const created =
        result.vaults.find((vault) => !previousIds.has(vault.vaultId)) ??
        result.vaults.find((vault) => vault.writable) ??
        null;
      if (created) {
        setSelectedVaultId(created.vaultId);
        vaultItemsRequestId += 1;
        vaultItemDetailRequestId += 1;
        setVaultItems([]);
        setSelectedVaultItem(null);
      }
      setVaultMessage(`Created vault "${input.name}".`);
    } catch (error) {
      setVaultMessage(`Could not create vault: ${String(error)}`);
    } finally {
      setVaultBusy(false);
    }
  };

  const handleSelectVault = async (vaultId: string) => {
    setSelectedVaultId(vaultId);
    vaultItemDetailRequestId += 1;
    setSelectedVaultItem(null);
    setVaultMessage(null);
    setVaultBusy(true);
    try {
      await refreshVaultItems(vaultId);
    } catch (error) {
      setVaultMessage(`Could not load vault items: ${String(error)}`);
    } finally {
      setVaultBusy(false);
    }
  };

  const handleSelectVaultItem = async (item: PasswordsItemSummary) => {
    const requestId = ++vaultItemDetailRequestId;
    setVaultBusy(true);
    setVaultMessage(null);
    setSelectedVaultItem(null);
    try {
      const detail = await getPasswordsItem(item.vaultId, item.itemId);
      if (
        requestId !== vaultItemDetailRequestId ||
        selectedVaultId() !== item.vaultId
      ) {
        return;
      }
      setSelectedVaultItem(detail);
    } catch (error) {
      if (
        requestId !== vaultItemDetailRequestId ||
        selectedVaultId() !== item.vaultId
      ) {
        return;
      }
      setVaultMessage(`Could not open item: ${String(error)}`);
    } finally {
      if (requestId === vaultItemDetailRequestId) {
        setVaultBusy(false);
      }
    }
  };

  const handleSaveVaultItem = async (input: {
    itemId?: string | null;
    title: string;
    fields: { name: string; value: string }[];
  }) => {
    const vaultId = selectedVaultId();
    if (!vaultId) return;
    // Label the entry by the service its field names imply; the grant form's
    // service selection is unrelated to vault entry metadata.
    const service = inferServiceFromFieldNames(
      input.fields.map((field) => field.name),
    );

    setVaultBusy(true);
    setVaultMessage(null);
    try {
      const saved = await savePasswordsApiCredential({
        vaultId,
        itemId: input.itemId,
        title: input.title,
        serviceName: service?.name ?? "",
        fields: input.fields,
      });
      await refreshVaultItems(vaultId);
      const detail = await getPasswordsItem(saved.vaultId, saved.itemId);
      setSelectedVaultItem(detail);
      setReferenceLines(
        Object.entries(saved.references)
          .map(([name, ref]) => `${name}=${ref}`)
          .join("\n"),
      );
      setVaultMessage("Saved vault entry and filled the binding references.");
    } catch (error) {
      setVaultMessage(`Could not save vault entry: ${String(error)}`);
    } finally {
      setVaultBusy(false);
    }
  };

  const agents = createMemo(() => {
    const seen = new Set<string>();
    const list: GrantTargetChoice[] = [];
    for (const employee of employeeList() ?? []) {
      const id = employee.slug || employee.id;
      const bindingId = `agent:${id}`;
      if (!id || seen.has(bindingId)) continue;
      seen.add(bindingId);
      list.push({ id, bindingId, label: employee.name || id, kind: "agent" });
    }
    for (const skill of skillsStore.installed) {
      const bindingId = `skill:${skill.slug}`;
      if (!skill.slug || seen.has(bindingId)) continue;
      seen.add(bindingId);
      list.push({
        id: skill.slug,
        bindingId,
        label: skill.name || skill.slug,
        kind: "skill",
      });
    }
    return list;
  });

  const credentialEntries = createMemo(() =>
    vaultItems().map((item) => ({
      vaultId: item.vaultId,
      itemId: item.itemId,
      title: item.title,
    })),
  );

  const loadEntryFields = async (
    vaultId: string,
    itemId: string,
  ): Promise<string[]> => {
    const detail = await getPasswordsItem(vaultId, itemId);
    return detail.fields.map((field) => field.name);
  };

  const findBindingFor = (serviceId: string, skillId: string) =>
    bindingList().find(
      (binding) =>
        binding.serviceId === serviceId && binding.skillId === skillId,
    );

  const handleGrantAccess = async (input: {
    agentId: string;
    agentLabel: string;
    serviceId: string;
    serviceName: string;
    vaultId: string;
    itemId: string;
    fieldNames: string[];
  }) => {
    setSaveMessage(null);
    const references = buildBindingReferences(
      input.vaultId,
      input.itemId,
      input.fieldNames,
    );
    if (Object.keys(references).length === 0) {
      setSaveMessage("Pick at least one field to share with the agent.");
      return;
    }
    try {
      await upsertSkillSecretBinding({
        source: "seren_passwords",
        serviceId: input.serviceId,
        serviceName: input.serviceName,
        skillId: input.agentId,
        skillName: input.agentLabel || input.agentId,
        secretValues: references,
        approvalPolicy: DEFAULT_KEY_APPROVAL_POLICY,
      });
      setSaveMessage(
        `Granted ${input.agentLabel || input.agentId} access to ${input.serviceName}.`,
      );
      setShowAddForm(false);
      setPrefillCredential(null);
      await refetchBindings();
      await refetchAudit();
    } catch (error) {
      setSaveMessage(`Could not grant access: ${String(error)}`);
    }
  };

  const handleUseSelectedVaultItem = () => {
    const detail = selectedVaultItem();
    if (!detail) return;
    setPrefillCredential({ vaultId: detail.vaultId, itemId: detail.itemId });
    setShowAddForm(true);
    setSaveMessage("Choose an agent to grant access to this credential.");
  };

  const openGrantAccessForm = (serviceId = selectedServiceId()) => {
    setSelectedServiceId(serviceId);
    setReferenceLines(
      selectedServiceDefaultVariables(getKeyService(serviceId))
        .map((name) => `${name}=`)
        .join("\n"),
    );
    setPrefillCredential(null);
    setShowAddForm(true);
  };

  const handleSaveKey = async () => {
    const service = selectedService();
    if (!service) return;

    setSaveMessage(null);
    const { values, errors } = parseReferenceLines();
    if (errors.length > 0) {
      setSaveMessage(errors[0] ?? "Could not parse references.");
      return;
    }
    if (Object.keys(values).length === 0) {
      setSaveMessage("Add at least one environment variable reference.");
      return;
    }
    try {
      await upsertSkillSecretBinding({
        source: "seren_passwords",
        serviceId: service.id,
        serviceName: service.name,
        skillId: selectedSkillId(),
        skillName: selectedSkillId(),
        secretValues: values,
        approvalPolicy: DEFAULT_KEY_APPROVAL_POLICY,
      });
      setSaveMessage(
        "Saved Seren Passwords references. Plaintext remains in your vault.",
      );
      setReferenceLines("");
      setShowAddForm(false);
      await refetchBindings();
      await refetchAudit();
    } catch (error) {
      setSaveMessage(`Could not save references: ${String(error)}`);
    }
  };

  const handleEndSession = async (session: SecretAccessSession) => {
    try {
      await endSkillSecretSession(session.id);
      await refetchBindings();
      await refetchAudit();
    } catch (error) {
      setSaveMessage(`Could not end session: ${String(error)}`);
    }
  };

  const handleReviewMigrate = async () => {
    setTab("migration");
    await refetchMigrationProposals();
  };

  const handleReplaceBinding = (binding: SkillSecretBinding) => {
    setSelectedServiceId(binding.serviceId);
    setSelectedSkillId(binding.skillId);
    setReferenceLines(
      binding.variableNames.map((name) => `${name}=`).join("\n"),
    );
    setPrefillCredential(null);
    setShowAddForm(true);
    setSaveMessage(
      `Re-select a credential to update ${binding.skillName}'s access, or use Advanced to edit the raw references.`,
    );
  };

  return (
    <section class="max-w-[1180px]">
      <div class="mb-8">
        <h3 class="m-0 mb-3 text-[1.8rem] font-semibold text-foreground">
          Seren Passwords
        </h3>
        <p class="m-0 max-w-[860px] text-[0.95rem] leading-relaxed text-muted-foreground">
          Your API keys, wallet keys, and passwords stay in your encrypted
          vault. Unlock it to manage entries, then bind selected fields to an
          agent's environment variables. Desktop only ever stores
          seren-secrets:// references.
        </p>
      </div>

      <Show when={saveMessage()}>
        {(message) => (
          <div class="mb-4 px-4 py-3 rounded-md border border-border-strong bg-surface-2 text-[0.85rem] text-muted-foreground">
            {message()}
          </div>
        )}
      </Show>

      <div class="mb-2 flex items-center gap-2 text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        <span class="grid h-5 w-5 place-items-center rounded-full bg-accent/15 text-[0.7rem] text-accent">
          1
        </span>
        Your vault
      </div>

      <PasswordsVaultEditor
        vaults={vaults()}
        selectedVaultId={selectedVaultId()}
        selectedVault={selectedVault()}
        items={vaultItems()}
        selectedItem={selectedVaultItem()}
        busy={vaultBusy()}
        message={vaultMessage()}
        recoveryKeyDisplay={recoveryKeyDisplay()}
        onUnlock={handleUnlockVault}
        onRecoveryAcknowledged={() => setRecoveryKeyDisplay(null)}
        onSetup={(input) => void handleSetupVault(input)}
        onCreateVault={(input) => void handleCreateVault(input)}
        onLock={() => void handleLockVault()}
        onSelectVault={(vaultId) => void handleSelectVault(vaultId)}
        onSelectItem={(item) => void handleSelectVaultItem(item)}
        onSaveItem={(input) => void handleSaveVaultItem(input)}
        onUseForBinding={handleUseSelectedVaultItem}
      />

      <Show when={tab() === "stored"}>
        <MigrationBanner
          proposals={migrationList()}
          dismissed={migrationBannerDismissed()}
          onDismiss={() => setMigrationBannerDismissed(true)}
          onReview={handleReviewMigrate}
        />
      </Show>

      <div class="mb-2 flex items-center gap-2 text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        <span class="grid h-5 w-5 place-items-center rounded-full bg-accent/15 text-[0.7rem] text-accent">
          2
        </span>
        Agent bindings
      </div>

      <div class="flex gap-8 border-b border-border-medium mb-5">
        <KeysTabButton
          active={tab() === "stored"}
          onClick={() => setTab("stored")}
        >
          References {bindingList().length}
        </KeysTabButton>
        <KeysTabButton
          active={tab() === "activity"}
          onClick={() => setTab("activity")}
        >
          Access log {auditList().length} last 7d
        </KeysTabButton>
        <KeysTabButton
          active={tab() === "migration"}
          onClick={() => setTab("migration")}
        >
          .env migration {migrationList().length}
        </KeysTabButton>
      </div>

      <Show when={tab() === "stored"}>
        <div class="mb-4 flex items-start justify-between gap-4">
          <div>
            <h4 class="m-0 text-[1rem] font-semibold text-foreground">
              Agent access
            </h4>
            <p class="m-0 mt-1 text-[0.85rem] text-muted-foreground">
              {countLabel(bindingList().length, "binding")} across{" "}
              {countLabel(serviceGroups().length, "service")}
            </p>
          </div>
          <Show
            when={vaults().length > 0 && serviceGroups().length === 0}
            fallback={
              <Show when={vaults().length === 0}>
                <span class="text-[0.82rem] text-muted-foreground">
                  Unlock your vault to grant access
                </span>
              </Show>
            }
          >
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-md border border-accent/35 bg-accent/10 px-3 py-1.5 text-[0.85rem] font-medium text-accent transition hover:border-accent/60 hover:bg-accent/15"
              onClick={() => openGrantAccessForm()}
            >
              <IconPlus size={13} />
              Grant access
            </button>
          </Show>
        </div>

        <Show when={showAddForm() && vaults().length > 0}>
          <GrantAccessForm
            agents={agents()}
            entries={credentialEntries()}
            vaultUnlocked={vaults().length > 0}
            prefill={prefillCredential()}
            loadEntryFields={loadEntryFields}
            findBinding={findBindingFor}
            onGrant={(input) => void handleGrantAccess(input)}
            onCancel={() => {
              setShowAddForm(false);
              setPrefillCredential(null);
            }}
          >
            <AddKeyForm
              selectedServiceId={selectedServiceId()}
              selectedSkillId={selectedSkillId()}
              duplicateBinding={duplicateBinding()}
              selectedVariables={selectedVariables()}
              onServiceChange={(value) => {
                setSelectedServiceId(value);
                setReferenceLines(
                  selectedServiceDefaultVariables(getKeyService(value))
                    .map((name) => `${name}=`)
                    .join("\n"),
                );
              }}
              onSkillChange={setSelectedSkillId}
              referenceLines={referenceLines()}
              onReferenceLinesChange={(value) => {
                setReferenceLines(value);
              }}
              onCancel={() => {
                setShowAddForm(false);
                setPrefillCredential(null);
              }}
              onSave={handleSaveKey}
            />
          </GrantAccessForm>
        </Show>

        <Show
          when={serviceGroups().length > 0}
          fallback={
            <div class="rounded-lg border border-dashed border-border-medium bg-surface-2/40 px-6 py-10 text-center">
              <span class="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg bg-accent/12 text-accent">
                <IconShield size={18} />
              </span>
              <p class="m-0 text-[0.9rem] text-foreground">
                No agents have access yet
              </p>
              <p class="m-0 mx-auto mt-1 max-w-sm text-[0.82rem] leading-relaxed text-muted-foreground">
                {vaults().length > 0
                  ? "Grant an agent access to selected credential fields. Desktop stores references now; runtime resolution turns them into environment values when wired."
                  : "Unlock your vault to grant an agent access to a saved credential."}
              </p>
            </div>
          }
        >
          <div class="flex flex-col gap-6">
            <For each={serviceGroups()}>
              {(group) => (
                <div>
                  <div class="flex items-center justify-between gap-3 mb-3 pb-2 border-b border-dashed border-border-medium">
                    <div class="flex items-center gap-2">
                      <span
                        class={`w-3 h-3 rounded-sm ${group.service.accent}`}
                      />
                      <span class="font-semibold text-foreground">
                        {group.service.name}
                      </span>
                      <span class="text-muted-foreground text-sm">
                        {countLabel(group.bindings.length, "binding")}
                      </span>
                    </div>
                    <Show when={vaults().length > 0}>
                      <button
                        type="button"
                        class="inline-flex items-center gap-1.5 rounded-md border border-accent/35 bg-accent/10 px-3 py-1.5 text-[0.85rem] font-medium text-accent transition hover:border-accent/60 hover:bg-accent/15"
                        onClick={() => openGrantAccessForm(group.service.id)}
                      >
                        <IconPlus size={13} />
                        Grant access
                      </button>
                    </Show>
                  </div>
                  <div class="flex flex-col gap-3">
                    <For each={group.bindings}>
                      {(binding) => (
                        <CredentialCard
                          binding={binding}
                          onViewActivity={() => setTab("activity")}
                          onReplace={handleReplaceBinding}
                          onEndSession={handleEndSession}
                        />
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={tab() === "activity"}>
        <ActivityTab
          audit={auditList()}
          activeSessions={activeSessions()}
          onEndSession={handleEndSession}
        />
      </Show>

      <Show when={tab() === "migration"}>
        <MigrationTab proposals={migrationList()} />
      </Show>
    </section>
  );
};

const KeysTabButton: Component<{
  active: boolean;
  onClick: () => void;
  children: JSX.Element;
}> = (props) => (
  <button
    type="button"
    class={`bg-transparent border-none px-1 py-3 text-[0.95rem] cursor-pointer border-b-2 ${
      props.active
        ? "text-foreground border-accent"
        : "text-muted-foreground border-transparent hover:text-foreground"
    }`}
    onClick={props.onClick}
  >
    {props.children}
  </button>
);

const MigrationBanner: Component<{
  proposals: SkillEnvMigrationProposal[];
  dismissed: boolean;
  onDismiss: () => void;
  onReview: () => void;
}> = (props) => (
  <Show when={props.proposals.length > 0 && !props.dismissed}>
    <div class="mb-8 p-5 rounded-lg border border-accent/45 bg-accent/10 flex items-center justify-between gap-5">
      <div class="flex items-start gap-4">
        <span class="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
          <IconShield size={18} />
        </span>
        <div>
          <h4 class="m-0 mb-2 text-[1rem] font-semibold text-foreground">
            {props.proposals.length} skill .env files still hold secrets in
            plaintext
          </h4>
          <p class="m-0 text-[0.85rem] text-muted-foreground leading-relaxed">
            {props.proposals
              .slice(0, 4)
              .map((proposal) => proposal.skillId)
              .join(", ")}
            {" — "}
            move those values into Seren Passwords, then replace the .env values
            with seren-secrets:// references.
          </p>
        </div>
      </div>
      <div class="flex gap-3">
        <button
          type="button"
          class="px-3 py-2 rounded-md border border-border-strong bg-transparent text-muted-foreground cursor-pointer"
          onClick={props.onDismiss}
        >
          Dismiss
        </button>
        <button
          type="button"
          class="px-4 py-2 rounded-md border-none bg-accent text-primary-foreground font-medium cursor-pointer"
          onClick={props.onReview}
        >
          Review migration
        </button>
      </div>
    </div>
  </Show>
);

type IconProps = { size?: number; class?: string };

const Svg = (props: IconProps & { children: JSX.Element }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={props.class}
    aria-hidden="true"
  >
    {props.children}
  </svg>
);

const IconLock = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </Svg>
);

const IconKey = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.5 12.5 8-8" />
    <path d="m16 7 2 2" />
    <path d="m19 4 2 2" />
  </Svg>
);

const IconShield = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);

const IconPlus = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

const IconX = (props: IconProps) => (
  <Svg {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

const IconCopy = (props: IconProps) => (
  <Svg {...props}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
);

const IconCheck = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

const IconEye = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

const IconEyeOff = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 7 10 7a13.4 13.4 0 0 1-2.4 3.2M6.6 6.6A13.3 13.3 0 0 0 2 11s3.5 7 10 7a10.9 10.9 0 0 0 4.1-.8" />
    <path d="m2 2 20 20" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Svg>
);

const IconArrowRight = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

const PasswordsVaultEditor: Component<{
  vaults: PasswordsVaultSummary[];
  selectedVaultId: string;
  selectedVault: PasswordsVaultSummary | null;
  items: PasswordsItemSummary[];
  selectedItem: PasswordsItemDetail | null;
  busy: boolean;
  message: string | null;
  recoveryKeyDisplay: string | null;
  onUnlock: (masterPassword: string) => Promise<void>;
  onRecoveryAcknowledged: () => void;
  onSetup: (input: {
    masterPassword: string;
    displayName: string;
    vaultName: string;
  }) => void;
  onCreateVault: (input: { name: string; description?: string }) => void;
  onLock: () => void;
  onSelectVault: (vaultId: string) => void;
  onSelectItem: (item: PasswordsItemSummary) => void;
  onSaveItem: (input: {
    itemId?: string | null;
    title: string;
    fields: { name: string; value: string }[];
  }) => void;
  onUseForBinding: () => void;
}> = (props) => {
  const [masterPassword, setMasterPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [vaultName, setVaultName] = createSignal("Personal");
  const [mode, setMode] = createSignal<"unlock" | "create">("unlock");
  const [showPassword, setShowPassword] = createSignal(false);
  const [showValues, setShowValues] = createSignal(false);
  const [recoveryAcknowledged, setRecoveryAcknowledged] = createSignal(false);
  const [recoveryCopied, setRecoveryCopied] = createSignal(false);
  const [entryTitle, setEntryTitle] = createSignal("");
  const [fieldRows, setFieldRows] = createSignal<
    { name: string; value: string }[]
  >([]);
  const [editingItemId, setEditingItemId] = createSignal<string | null>(null);
  // The right pane only shows the editor while composing (new entry or editing
  // an existing one); otherwise it stays a neutral prompt.
  const [composing, setComposing] = createSignal(false);
  const [showNewVault, setShowNewVault] = createSignal(false);
  const [newVaultName, setNewVaultName] = createSignal("");
  const [newVaultDescription, setNewVaultDescription] = createSignal("");
  const unlocked = () => props.vaults.length > 0;
  const writable = () => props.selectedVault?.writable === true;
  const namedRows = () => fieldRows().filter((row) => row.name.trim());
  const masterPasswordBits = () => estimateMasterPasswordBits(masterPassword());
  const saveDisabledReason = createMemo(() => {
    if (!unlocked()) return "Unlock your vault first";
    if (!writable()) return "Select a writable vault";
    if (props.busy) return "Vault is busy";
    if (!entryTitle().trim()) return "Add a title";
    const named = namedRows();
    if (named.length === 0) return "Add at least one field";
    if (named.some((row) => !isEnvVarName(row.name)))
      return "Field names must be valid env vars";
    const names = named.map((row) => row.name.trim().toUpperCase());
    if (new Set(names).size !== names.length)
      return "Field names must be unique";
    if (named.some((row) => !row.value.trim()))
      return "Fill in every field value";
    return "";
  });
  const setupDisabledReason = createMemo(() => {
    if (props.busy) return "Setup is running";
    if (masterPassword().length < MIN_MASTER_PASSWORD_LENGTH)
      return `Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters`;
    if (masterPasswordBits() < MIN_MASTER_PASSWORD_BITS)
      return `Use a stronger password (${MIN_MASTER_PASSWORD_BITS}+ estimated bits)`;
    if (masterPassword() !== confirmPassword()) return "Passwords must match";
    return "";
  });

  createEffect(() => {
    const item = props.selectedItem;
    if (!item) return;
    setEditingItemId(item.itemId);
    setEntryTitle(item.title);
    setFieldRows(
      item.fields.map((field) => ({ name: field.name, value: field.value })),
    );
    setComposing(true);
  });

  createEffect(() => {
    if (props.selectedItem || !editingItemId()) return;
    setEditingItemId(null);
    setEntryTitle("");
    setFieldRows([]);
    setComposing(false);
  });

  // Switching vaults (and the initial unlock) returns the editor to its neutral
  // state instead of stranding a stale or auto-opened form.
  createEffect(() => {
    props.selectedVaultId;
    setComposing(false);
  });

  createEffect(() => {
    const message = props.message?.toLowerCase() ?? "";
    if (
      message.includes("account not initialized") ||
      message.includes("setup required") ||
      message.includes("404")
    ) {
      setMode("create");
    }
  });

  // A freshly minted recovery key must be acknowledged before it disappears.
  createEffect(() => {
    if (props.recoveryKeyDisplay) {
      setRecoveryAcknowledged(false);
      setRecoveryCopied(false);
    }
  });

  // Returning to the locked screen (e.g. after Lock) should default back to
  // the unlock tab rather than stranding the user on the create-vault form.
  // Decrypted entry state must not outlive the unlocked session.
  createEffect(() => {
    if (!unlocked()) {
      setMode("unlock");
      setComposing(false);
      setEditingItemId(null);
      setEntryTitle("");
      setFieldRows([]);
      setShowValues(false);
    }
  });

  const messageIsError = () =>
    (props.message ?? "").toLowerCase().includes("could not") ||
    (props.message ?? "").toLowerCase().includes("incorrect");

  const copyRecoveryKey = async () => {
    const key = props.recoveryKeyDisplay;
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setRecoveryCopied(true);
    } catch {
      setRecoveryCopied(false);
    }
  };

  const [template, setTemplate] = createSignal("");

  // Picking a service template seeds the rows with its expected env-var names
  // (and a title) so the user just fills values; "Custom" gives a blank row.
  const applyTemplate = (serviceId: string) => {
    setTemplate(serviceId);
    const service = serviceId ? getKeyService(serviceId) : null;
    if (service && service.defaultVariables.length > 0) {
      setFieldRows(
        service.defaultVariables.map((name) => ({ name, value: "" })),
      );
      if (!entryTitle().trim()) setEntryTitle(`${service.name} credential`);
    } else {
      setFieldRows([{ name: "", value: "" }]);
    }
  };

  const startNewEntry = () => {
    setEditingItemId(null);
    setEntryTitle("");
    setTemplate("");
    setFieldRows([{ name: "", value: "" }]);
    setComposing(true);
  };

  const addFieldRow = () =>
    setFieldRows((rows) => [...rows, { name: "", value: "" }]);
  const updateFieldRow = (
    index: number,
    patch: { name?: string; value?: string },
  ) =>
    setFieldRows((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  const removeFieldRow = (index: number) =>
    setFieldRows((rows) =>
      rows.length > 1 ? rows.filter((_, i) => i !== index) : rows,
    );

  const handleUnlock = async () => {
    const password = masterPassword();
    if (!password) return;
    await props.onUnlock(password);
    setMasterPassword("");
    setComposing(false);
  };

  const handleSetup = () => {
    if (setupDisabledReason()) return;
    props.onSetup({
      masterPassword: masterPassword(),
      displayName: displayName(),
      vaultName: vaultName(),
    });
    setMasterPassword("");
    setConfirmPassword("");
  };

  const handleSave = () => {
    if (saveDisabledReason()) return;
    props.onSaveItem({
      itemId: editingItemId(),
      title: entryTitle().trim() || "Credential",
      fields: namedRows().map((row) => ({
        name: row.name.trim().toUpperCase(),
        value: row.value,
      })),
    });
  };

  const closeNewVault = () => {
    setShowNewVault(false);
    setNewVaultName("");
    setNewVaultDescription("");
  };

  const handleNewVault = () => {
    if (props.busy || !newVaultName().trim()) return;
    props.onCreateVault({
      name: newVaultName().trim(),
      description: newVaultDescription().trim() || undefined,
    });
    closeNewVault();
  };

  return (
    <div class="mb-7 rounded-lg border border-border-strong bg-surface-2 overflow-hidden">
      <Show
        when={unlocked()}
        fallback={
          <div class="px-6 py-9 sm:px-10">
            <div class="mx-auto max-w-md">
              <div class="mb-5 flex flex-col items-center text-center">
                <span class="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-accent/15 text-accent">
                  <Show
                    when={mode() === "create"}
                    fallback={<IconLock size={22} />}
                  >
                    <IconShield size={22} />
                  </Show>
                </span>
                <p class="mb-1 text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-accent">
                  {mode() === "create" ? "New vault" : "Vault sealed"}
                </p>
                <h4 class="m-0 mb-2 text-[1.35rem] font-semibold text-foreground">
                  {mode() === "create"
                    ? "Create your vault"
                    : "Unlock Seren Passwords"}
                </h4>
                <p class="m-0 max-w-sm text-[0.88rem] leading-relaxed text-muted-foreground">
                  {mode() === "create"
                    ? "We could not find a vault for your account. Set a vault password to create your first encrypted vault; you will get a one-time recovery key."
                    : "Enter your vault password to manage credential entries for this desktop session."}
                </p>
                <Show when={mode() === "create"}>
                  <button
                    type="button"
                    class="mt-3 text-[0.82rem] text-accent hover:underline"
                    onClick={() => {
                      setMode("unlock");
                      setMasterPassword("");
                      setConfirmPassword("");
                    }}
                  >
                    Already have a vault? Unlock instead
                  </button>
                </Show>
              </div>

              <Show when={props.message}>
                {(message) => (
                  <div
                    class={`mb-4 rounded-md border px-3 py-2 text-[0.83rem] ${
                      messageIsError()
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-border-strong bg-surface-3 text-muted-foreground"
                    }`}
                  >
                    {message()}
                  </div>
                )}
              </Show>

              <Show
                when={mode() === "create"}
                fallback={
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleUnlock();
                    }}
                  >
                    <span class="mb-2 block text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground">
                      Vault password
                    </span>
                    <div class="relative">
                      <input
                        type={showPassword() ? "text" : "password"}
                        autocomplete="current-password"
                        class="w-full rounded-md border border-border-strong bg-surface-3/80 px-3 py-2.5 pr-11 font-mono text-foreground focus:border-accent focus:outline-none"
                        value={masterPassword()}
                        onInput={(event) =>
                          setMasterPassword(event.currentTarget.value)
                        }
                      />
                      <button
                        type="button"
                        class="absolute inset-y-0 right-0 grid w-11 place-items-center text-muted-foreground hover:text-foreground"
                        aria-label={
                          showPassword() ? "Hide password" : "Show password"
                        }
                        onClick={() => setShowPassword(!showPassword())}
                      >
                        {showPassword() ? (
                          <IconEyeOff size={16} />
                        ) : (
                          <IconEye size={16} />
                        )}
                      </button>
                    </div>
                    <button
                      type="submit"
                      class="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 font-medium text-primary-foreground transition hover:bg-primary/85 disabled:opacity-60"
                      disabled={props.busy || masterPassword().length === 0}
                    >
                      <IconKey size={15} />
                      {props.busy ? "Unlocking vault..." : "Unlock vault"}
                    </button>
                  </form>
                }
              >
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleSetup();
                  }}
                  class="flex flex-col gap-4"
                >
                  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <label class="flex flex-col gap-2">
                      <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground">
                        Display name
                      </span>
                      <input
                        class="rounded-md border border-border-strong bg-surface-3/80 px-3 py-2.5 text-foreground focus:border-accent focus:outline-none"
                        value={displayName()}
                        placeholder="Desktop"
                        onInput={(event) =>
                          setDisplayName(event.currentTarget.value)
                        }
                      />
                    </label>
                    <label class="flex flex-col gap-2">
                      <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground">
                        Vault name
                      </span>
                      <input
                        class="rounded-md border border-border-strong bg-surface-3/80 px-3 py-2.5 text-foreground focus:border-accent focus:outline-none"
                        value={vaultName()}
                        onInput={(event) =>
                          setVaultName(event.currentTarget.value)
                        }
                      />
                    </label>
                  </div>
                  <label class="flex flex-col gap-2">
                    <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground">
                      Vault password
                    </span>
                    <div class="relative">
                      <input
                        type={showPassword() ? "text" : "password"}
                        autocomplete="new-password"
                        class="w-full rounded-md border border-border-strong bg-surface-3/80 px-3 py-2.5 pr-11 font-mono text-foreground focus:border-accent focus:outline-none"
                        value={masterPassword()}
                        onInput={(event) =>
                          setMasterPassword(event.currentTarget.value)
                        }
                      />
                      <button
                        type="button"
                        class="absolute inset-y-0 right-0 grid w-11 place-items-center text-muted-foreground hover:text-foreground"
                        aria-label={
                          showPassword() ? "Hide password" : "Show password"
                        }
                        onClick={() => setShowPassword(!showPassword())}
                      >
                        {showPassword() ? (
                          <IconEyeOff size={16} />
                        ) : (
                          <IconEye size={16} />
                        )}
                      </button>
                    </div>
                  </label>
                  <label class="flex flex-col gap-2">
                    <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground">
                      Confirm password
                    </span>
                    <input
                      type={showPassword() ? "text" : "password"}
                      autocomplete="new-password"
                      class="rounded-md border border-border-strong bg-surface-3/80 px-3 py-2.5 font-mono text-foreground focus:border-accent focus:outline-none"
                      value={confirmPassword()}
                      onInput={(event) =>
                        setConfirmPassword(event.currentTarget.value)
                      }
                    />
                  </label>
                  <Show
                    when={
                      masterPassword().length > 0 &&
                      masterPassword().length < MIN_MASTER_PASSWORD_LENGTH
                    }
                  >
                    <p class="m-0 text-[0.8rem] text-destructive">
                      Use at least {MIN_MASTER_PASSWORD_LENGTH} characters.
                    </p>
                  </Show>
                  <Show
                    when={
                      masterPassword().length >= MIN_MASTER_PASSWORD_LENGTH &&
                      masterPasswordBits() < MIN_MASTER_PASSWORD_BITS
                    }
                  >
                    <p class="m-0 text-[0.8rem] text-destructive">
                      Use a stronger password ({masterPasswordBits()} estimated
                      bits).
                    </p>
                  </Show>
                  <Show
                    when={
                      confirmPassword().length > 0 &&
                      masterPassword() !== confirmPassword()
                    }
                  >
                    <p class="m-0 text-[0.8rem] text-destructive">
                      Passwords do not match yet.
                    </p>
                  </Show>
                  <button
                    type="submit"
                    class="inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 font-medium text-primary-foreground transition hover:bg-primary/85 disabled:opacity-60"
                    disabled={setupDisabledReason() !== ""}
                    title={setupDisabledReason() || undefined}
                  >
                    <IconShield size={15} />
                    {props.busy ? "Encrypting..." : "Create vault"}
                  </button>
                </form>
              </Show>

              <p class="mx-auto mt-6 max-w-[20rem] text-center text-[0.76rem] leading-relaxed text-muted-foreground">
                <IconLock size={12} class="mr-1 inline align-[-2px]" />
                End-to-end encrypted. Your password is derived locally; Seren
                never sees it.
              </p>
            </div>
          </div>
        }
      >
        <div>
          <Show when={props.recoveryKeyDisplay && !recoveryAcknowledged()}>
            <div class="border-b border-warning/40 bg-warning/10 px-5 py-4">
              <div class="flex items-start gap-3">
                <span class="mt-0.5 text-warning">
                  <IconShield size={18} />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-[0.9rem] font-semibold text-foreground">
                    Save your recovery key
                  </div>
                  <p class="m-0 mt-0.5 text-[0.82rem] leading-relaxed text-muted-foreground">
                    This is the only way back into your vault if you forget your
                    password. Store it somewhere safe; it will not be shown
                    again.
                  </p>
                  <code class="mt-3 block break-all rounded-md border border-warning/30 bg-surface-1 px-3 py-2 font-mono text-[0.85rem] text-foreground">
                    {props.recoveryKeyDisplay}
                  </code>
                  <div class="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface-2 px-3 py-1.5 text-[0.82rem] text-foreground hover:bg-surface-3"
                      onClick={() => void copyRecoveryKey()}
                    >
                      {recoveryCopied() ? (
                        <IconCheck size={13} />
                      ) : (
                        <IconCopy size={13} />
                      )}
                      {recoveryCopied() ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[0.82rem] font-medium text-primary-foreground hover:bg-primary/85"
                      onClick={() => {
                        // Acknowledging drops the key from component state so
                        // it does not linger after the banner closes.
                        setRecoveryAcknowledged(true);
                        props.onRecoveryAcknowledged();
                      }}
                    >
                      <IconCheck size={13} />I have saved it
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Show>

          <div class="flex items-center justify-between gap-3 border-b border-border-medium px-5 py-3">
            <div class="flex min-w-0 items-center gap-2.5">
              <span class="grid h-8 w-8 place-items-center rounded-md bg-accent/15 text-accent">
                <IconShield size={16} />
              </span>
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate font-semibold text-foreground">
                    {props.selectedVault?.name ?? "Vault"}
                  </span>
                  <Show when={props.selectedVault && !writable()}>
                    <span class="rounded-full bg-surface-3 px-2 py-0.5 text-[0.68rem] uppercase tracking-[0.08em] text-muted-foreground">
                      read only
                    </span>
                  </Show>
                </div>
                <div class="text-[0.74rem] text-muted-foreground">
                  {props.selectedVault?.itemCount ?? 0}{" "}
                  {(props.selectedVault?.itemCount ?? 0) === 1
                    ? "entry"
                    : "entries"}{" "}
                  · unlocked this session
                </div>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <Show when={props.vaults.length > 1}>
                <select
                  class="max-w-[180px] rounded-md border border-border-strong bg-surface-3/80 px-3 py-1.5 text-[0.85rem] text-foreground"
                  value={props.selectedVaultId}
                  onChange={(event) =>
                    props.onSelectVault(event.currentTarget.value)
                  }
                >
                  <For each={props.vaults}>
                    {(vault) => (
                      <option value={vault.vaultId}>
                        {vault.name}
                        {vault.writable ? "" : " (read only)"}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-transparent px-3 py-1.5 text-[0.85rem] text-foreground hover:bg-surface-3"
                onClick={() => {
                  setShowNewVault(!showNewVault());
                  setNewVaultName("");
                  setNewVaultDescription("");
                }}
              >
                <IconPlus size={14} />
                New vault
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-transparent px-3 py-1.5 text-[0.85rem] text-muted-foreground hover:text-foreground"
                onClick={props.onLock}
              >
                <IconLock size={14} />
                Lock
              </button>
            </div>
          </div>

          <Show when={showNewVault()}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleNewVault();
              }}
              class="flex flex-wrap items-end gap-3 border-b border-border-medium bg-surface-1 px-5 py-4"
            >
              <label class="flex min-w-[180px] flex-1 flex-col gap-1.5">
                <span class="text-[0.74rem] uppercase tracking-[0.08em] text-muted-foreground">
                  Vault name
                </span>
                <input
                  class="rounded-md border border-border-strong bg-surface-3/80 px-3 py-2 text-foreground focus:border-accent focus:outline-none"
                  value={newVaultName()}
                  placeholder="Work credentials"
                  onInput={(event) =>
                    setNewVaultName(event.currentTarget.value)
                  }
                />
              </label>
              <label class="flex min-w-[180px] flex-1 flex-col gap-1.5">
                <span class="text-[0.74rem] uppercase tracking-[0.08em] text-muted-foreground">
                  Description (optional)
                </span>
                <input
                  class="rounded-md border border-border-strong bg-surface-3/80 px-3 py-2 text-foreground focus:border-accent focus:outline-none"
                  value={newVaultDescription()}
                  placeholder="What lives in this vault"
                  onInput={(event) =>
                    setNewVaultDescription(event.currentTarget.value)
                  }
                />
              </label>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="rounded-md px-3 py-2 text-[0.85rem] text-muted-foreground hover:text-foreground"
                  onClick={closeNewVault}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 font-medium text-primary-foreground transition hover:bg-primary/85 disabled:opacity-60"
                  disabled={props.busy || newVaultName().trim().length === 0}
                >
                  <IconShield size={14} />
                  {props.busy ? "Creating..." : "Create vault"}
                </button>
              </div>
            </form>
          </Show>

          <div class="grid min-h-[360px] grid-cols-[280px_1fr]">
            <aside class="flex flex-col border-r border-border-medium bg-surface-1">
              <div class="p-3">
                <button
                  type="button"
                  class="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 font-medium text-primary-foreground transition hover:bg-primary/85 disabled:opacity-60"
                  disabled={!writable()}
                  onClick={startNewEntry}
                >
                  <IconPlus size={15} />
                  New entry
                </button>
              </div>
              <div class="flex flex-col gap-1.5 overflow-y-auto px-3 pb-3">
                <Show
                  when={props.items.length > 0}
                  fallback={
                    <p class="px-2 py-8 text-center text-[0.82rem] leading-relaxed text-muted-foreground">
                      No entries yet. Create your first credential to store it
                      in this vault.
                    </p>
                  }
                >
                  <For each={props.items}>
                    {(item) => (
                      <button
                        type="button"
                        class={`w-full rounded-md border p-3 text-left transition ${
                          editingItemId() === item.itemId
                            ? "border-accent bg-accent/10"
                            : "border-border bg-surface-2 hover:bg-surface-3"
                        }`}
                        onClick={() => props.onSelectItem(item)}
                      >
                        <div class="truncate font-semibold text-foreground">
                          {item.title}
                        </div>
                        <div class="mt-1 text-[0.78rem] text-muted-foreground">
                          {item.itemKind.replace(/_/g, " ")}
                          {item.decryptError ? " · needs attention" : ""}
                        </div>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </aside>
            <Show
              when={composing()}
              fallback={
                <div class="grid place-items-center p-8 text-center">
                  <div class="max-w-xs">
                    <p class="m-0 text-[0.9rem] text-foreground">
                      {props.items.length > 0
                        ? "Select an entry to view or edit it."
                        : "This vault has no entries yet."}
                    </p>
                    <p class="m-0 mt-1 text-[0.82rem] leading-relaxed text-muted-foreground">
                      Use <span class="text-foreground">+ New entry</span> to
                      add a credential.
                    </p>
                  </div>
                </div>
              }
            >
              <div class="p-5">
                <div class="mb-5 flex items-start justify-between gap-4">
                  <div>
                    <h4 class="m-0 mb-1 text-[1.1rem] font-semibold text-foreground">
                      {editingItemId() ? "Edit vault entry" : "New vault entry"}
                    </h4>
                    <p class="m-0 text-[0.85rem] text-muted-foreground">
                      Stored encrypted in{" "}
                      {props.selectedVault?.name ?? "your vault"}.
                    </p>
                  </div>
                  <Show when={editingItemId()}>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent/10 px-3 py-2 text-[0.85rem] font-medium text-accent transition hover:bg-accent/15 disabled:opacity-60"
                      disabled={(props.selectedItem?.fields.length ?? 0) === 0}
                      onClick={props.onUseForBinding}
                    >
                      Use for binding
                      <IconArrowRight size={14} />
                    </button>
                  </Show>
                </div>

                <label class="mb-4 flex flex-col gap-2">
                  <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground">
                    Entry title
                  </span>
                  <input
                    class="rounded-md border border-border-strong bg-surface-3/80 px-3 py-2.5 text-foreground focus:border-accent focus:outline-none"
                    value={entryTitle()}
                    placeholder="Credential name"
                    onInput={(event) =>
                      setEntryTitle(event.currentTarget.value)
                    }
                  />
                </label>

                <Show when={editingItemId() === null}>
                  <label class="mb-4 flex flex-col gap-2">
                    <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground">
                      Start from
                    </span>
                    <select
                      class="rounded-md border border-border-strong bg-surface-3/80 px-3 py-2.5 text-foreground focus:border-accent focus:outline-none"
                      value={template()}
                      onChange={(event) =>
                        applyTemplate(event.currentTarget.value)
                      }
                    >
                      <option value="">Custom (blank fields)</option>
                      <For each={KEY_SERVICES}>
                        {(service) => (
                          <option value={service.id}>{service.name}</option>
                        )}
                      </For>
                    </select>
                  </label>
                </Show>

                <div class="mb-2 flex items-center justify-between">
                  <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground">
                    Fields
                  </span>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 text-[0.78rem] text-muted-foreground hover:text-foreground"
                    onClick={() => setShowValues(!showValues())}
                  >
                    {showValues() ? (
                      <IconEyeOff size={13} />
                    ) : (
                      <IconEye size={13} />
                    )}
                    {showValues() ? "Hide values" : "Show values"}
                  </button>
                </div>
                <div class="flex flex-col gap-2">
                  <div class="flex items-center gap-2 px-1 text-[0.68rem] uppercase tracking-[0.08em] text-muted-foreground">
                    <span class="w-2/5">Variable</span>
                    <span class="flex-1">Value</span>
                    <span class="w-8" />
                  </div>
                  <For each={fieldRows()}>
                    {(row, index) => (
                      <div class="flex items-center gap-2">
                        <input
                          class="w-2/5 rounded-md border border-border-strong bg-surface-3/80 px-3 py-2 font-mono text-[0.82rem] uppercase text-foreground focus:border-accent focus:outline-none"
                          placeholder="ENV_NAME"
                          value={row.name}
                          onInput={(event) =>
                            updateFieldRow(index(), {
                              name: event.currentTarget.value,
                            })
                          }
                        />
                        <input
                          type={showValues() ? "text" : "password"}
                          autocomplete="off"
                          class="flex-1 rounded-md border border-border-strong bg-surface-3/80 px-3 py-2 font-mono text-[0.82rem] text-foreground focus:border-accent focus:outline-none"
                          placeholder="value"
                          value={row.value}
                          onInput={(event) =>
                            updateFieldRow(index(), {
                              value: event.currentTarget.value,
                            })
                          }
                        />
                        <button
                          type="button"
                          class="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-destructive disabled:opacity-40"
                          aria-label="Remove field"
                          disabled={fieldRows().length <= 1}
                          onClick={() => removeFieldRow(index())}
                        >
                          <IconX size={14} />
                        </button>
                      </div>
                    )}
                  </For>
                </div>
                <button
                  type="button"
                  class="mt-2 inline-flex items-center gap-1.5 text-[0.82rem] text-accent hover:underline"
                  onClick={addFieldRow}
                >
                  <IconPlus size={13} />
                  Add field
                </button>

                <div class="mt-5 flex items-center justify-between gap-4">
                  <Show when={props.message}>
                    {(message) => (
                      <div
                        class={`text-[0.85rem] ${
                          messageIsError()
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }`}
                      >
                        {message()}
                      </div>
                    )}
                  </Show>
                  <button
                    type="button"
                    class="ml-auto inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 font-medium text-primary-foreground transition hover:bg-primary/85 disabled:opacity-60"
                    disabled={saveDisabledReason() !== ""}
                    title={saveDisabledReason() || undefined}
                    onClick={handleSave}
                  >
                    {props.busy
                      ? "Saving..."
                      : editingItemId()
                        ? "Save changes"
                        : "Save entry"}
                  </button>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

const GrantAccessForm: Component<{
  agents: GrantTargetChoice[];
  entries: { vaultId: string; itemId: string; title: string }[];
  vaultUnlocked: boolean;
  prefill: { vaultId: string; itemId: string } | null;
  loadEntryFields: (vaultId: string, itemId: string) => Promise<string[]>;
  findBinding: (
    serviceId: string,
    skillId: string,
  ) => SkillSecretBinding | undefined;
  onGrant: (input: {
    agentId: string;
    agentLabel: string;
    serviceId: string;
    serviceName: string;
    vaultId: string;
    itemId: string;
    fieldNames: string[];
  }) => void;
  onCancel: () => void;
  children: JSX.Element;
}> = (props) => {
  const CUSTOM_AGENT = "__custom__";
  const [mode, setMode] = createSignal<"simple" | "advanced">("simple");
  const [agentSelect, setAgentSelect] = createSignal("");
  const [customAgentId, setCustomAgentId] = createSignal("");
  const agentId = () =>
    (agentSelect() === CUSTOM_AGENT ? customAgentId() : agentSelect()).trim();
  const agentLabel = () => {
    if (agentSelect() === CUSTOM_AGENT) return customAgentId().trim();
    return (
      props.agents.find((agent) => agent.bindingId === agentSelect())?.label ??
      agentSelect()
    );
  };
  const [credentialKey, setCredentialKey] = createSignal("");
  const [fields, setFields] = createSignal<string[]>([]);
  const [checked, setChecked] = createSignal<Record<string, boolean>>({});
  const [loadingFields, setLoadingFields] = createSignal(false);
  const [serviceOverride, setServiceOverride] = createSignal("");
  const [appliedPrefillKey, setAppliedPrefillKey] = createSignal<string | null>(
    null,
  );

  const entryKey = (entry: { vaultId: string; itemId: string }) =>
    `${entry.vaultId}::${entry.itemId}`;
  const selectedEntry = () =>
    props.entries.find((entry) => entryKey(entry) === credentialKey()) ?? null;
  const checkedFields = () => fields().filter((name) => checked()[name]);
  const inferred = createMemo(() => inferServiceFromFieldNames(fields()));
  const service = createMemo(() => {
    const found = inferred();
    if (found) return found;
    const override = serviceOverride();
    return override ? getKeyService(override) : null;
  });
  const invalidFields = () =>
    checkedFields().filter((name) => !isEnvVarName(name));
  const duplicate = () => {
    const svc = service();
    const agent = agentId().trim();
    return svc && agent ? props.findBinding(svc.id, agent) : undefined;
  };

  const loadFields = async (vaultId: string, itemId: string) => {
    setLoadingFields(true);
    try {
      const names = await props.loadEntryFields(vaultId, itemId);
      setFields(names);
      setChecked(Object.fromEntries(names.map((name) => [name, true])));
    } catch {
      setFields([]);
      setChecked({});
    } finally {
      setLoadingFields(false);
    }
  };

  const selectCredential = (key: string) => {
    setCredentialKey(key);
    setServiceOverride("");
    const entry = props.entries.find((item) => entryKey(item) === key);
    if (entry) void loadFields(entry.vaultId, entry.itemId);
    else {
      setFields([]);
      setChecked({});
    }
  };

  // Apply a "Use for binding" prefill once the entry is in the list. Guarded by
  // the applied key so a later reactive update does not override a manual pick.
  createEffect(() => {
    const pre = props.prefill;
    if (!pre) return;
    const key = entryKey(pre);
    if (
      appliedPrefillKey() !== key &&
      props.entries.some((entry) => entryKey(entry) === key)
    ) {
      setAppliedPrefillKey(key);
      selectCredential(key);
    }
  });

  const disabledReason = () => {
    if (!agentId().trim()) return "Choose an agent";
    if (!selectedEntry()) return "Choose a saved credential";
    if (loadingFields()) return "Loading credential...";
    if (!service()) return "Pick what this credential is for";
    if (checkedFields().length === 0) return "Select at least one field";
    if (invalidFields().length > 0)
      return "Some field names aren't valid env vars - use Advanced";
    return "";
  };

  const handleGrant = () => {
    const entry = selectedEntry();
    const svc = service();
    if (disabledReason() || !entry || !svc) return;
    props.onGrant({
      agentId: agentId(),
      agentLabel: agentLabel(),
      serviceId: svc.id,
      serviceName: svc.name,
      vaultId: entry.vaultId,
      itemId: entry.itemId,
      fieldNames: checkedFields(),
    });
  };

  return (
    <div class="mb-7 rounded-lg border border-border-strong bg-surface-2/80 p-5">
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h4 class="m-0 mb-1 text-[1.1rem] font-semibold text-foreground">
            Give an agent access
          </h4>
          <p class="m-0 text-[0.85rem] text-muted-foreground">
            Pick an agent and a saved credential. Desktop stores references for
            approval; plaintext stays in the vault until runtime resolution uses
            them.
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 text-[0.82rem] text-accent hover:underline"
          onClick={() => setMode(mode() === "simple" ? "advanced" : "simple")}
        >
          {mode() === "simple" ? "Advanced" : "Back to simple"}
        </button>
      </div>

      <Show when={mode() === "simple"} fallback={props.children}>
        <Show
          when={props.vaultUnlocked && props.entries.length > 0}
          fallback={
            <div class="rounded-md border border-border-strong bg-surface-3/60 px-4 py-5 text-[0.85rem] text-muted-foreground leading-relaxed">
              Save a vault entry first, then grant an agent access to selected
              fields. You can also use{" "}
              <button
                type="button"
                class="text-accent hover:underline"
                onClick={() => setMode("advanced")}
              >
                Advanced
              </button>{" "}
              to paste a reference by hand.
            </div>
          }
        >
          <div class="grid gap-4 md:grid-cols-2">
            <label class="flex flex-col gap-2">
              <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground">
                Agent
              </span>
              <select
                class="rounded-md border border-border-strong bg-surface-3/80 px-3 py-2.5 text-foreground focus:border-accent focus:outline-none"
                value={agentSelect()}
                onChange={(event) => setAgentSelect(event.currentTarget.value)}
              >
                <option value="">Select an agent or skill...</option>
                <Show when={props.agents.some((a) => a.kind === "agent")}>
                  <optgroup label="Your agents">
                    <For each={props.agents.filter((a) => a.kind === "agent")}>
                      {(agent) => (
                        <option value={agent.bindingId}>{agent.label}</option>
                      )}
                    </For>
                  </optgroup>
                </Show>
                <Show when={props.agents.some((a) => a.kind === "skill")}>
                  <optgroup label="Skills">
                    <For each={props.agents.filter((a) => a.kind === "skill")}>
                      {(agent) => (
                        <option value={agent.bindingId}>{agent.label}</option>
                      )}
                    </For>
                  </optgroup>
                </Show>
                <option value={CUSTOM_AGENT}>Enter an id manually...</option>
              </select>
              <Show when={agentSelect() === CUSTOM_AGENT}>
                <input
                  class="mt-2 rounded-md border border-border-strong bg-surface-3/80 px-3 py-2.5 text-foreground focus:border-accent focus:outline-none"
                  value={customAgentId()}
                  placeholder="agent:my-agent or skill:my-skill"
                  onInput={(event) =>
                    setCustomAgentId(event.currentTarget.value)
                  }
                />
              </Show>
              <Show when={props.agents.length === 0}>
                <span class="text-[0.75rem] text-muted-foreground">
                  No agents or skills found yet - choose "Enter an id manually"
                  or create an agent first.
                </span>
              </Show>
            </label>
            <label class="flex flex-col gap-2">
              <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground">
                Credential
              </span>
              <select
                class="rounded-md border border-border-strong bg-surface-3/80 px-3 py-2.5 text-foreground focus:border-accent focus:outline-none"
                value={credentialKey()}
                onChange={(event) =>
                  selectCredential(event.currentTarget.value)
                }
              >
                <option value="">Select a vault entry...</option>
                <For each={props.entries}>
                  {(entry) => (
                    <option value={entryKey(entry)}>{entry.title}</option>
                  )}
                </For>
              </select>
            </label>
          </div>

          <Show when={selectedEntry()}>
            <div class="mt-4">
              <Show
                when={!loadingFields()}
                fallback={
                  <p class="text-[0.85rem] text-muted-foreground">
                    Reading the entry's fields...
                  </p>
                }
              >
                <Show
                  when={service()}
                  fallback={
                    <label class="mb-3 flex flex-col gap-2">
                      <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground">
                        What is this credential for?
                      </span>
                      <select
                        class="rounded-md border border-border-strong bg-surface-3/80 px-3 py-2.5 text-foreground focus:border-accent focus:outline-none"
                        value={serviceOverride()}
                        onChange={(event) =>
                          setServiceOverride(event.currentTarget.value)
                        }
                      >
                        <option value="">Select a service...</option>
                        <For each={KEY_SERVICES}>
                          {(svc) => <option value={svc.id}>{svc.name}</option>}
                        </For>
                      </select>
                    </label>
                  }
                >
                  <p class="mb-2 text-[0.82rem] text-muted-foreground">
                    <span class="font-mono text-foreground">
                      {agentLabel() || "the agent"}
                    </span>{" "}
                    will receive these from{" "}
                    <span class="text-foreground">{service()?.name}</span>:
                  </p>
                </Show>

                <div class="flex flex-col gap-1.5 rounded-md border border-border bg-surface-1 p-3">
                  <For each={fields()}>
                    {(name) => (
                      <label class="flex items-center gap-2 text-[0.85rem]">
                        <input
                          type="checkbox"
                          checked={checked()[name] ?? false}
                          onChange={(event) =>
                            setChecked((current) => ({
                              ...current,
                              [name]: event.currentTarget.checked,
                            }))
                          }
                        />
                        <span
                          class={`font-mono ${isEnvVarName(name) ? "text-foreground" : "text-destructive"}`}
                        >
                          {name}
                        </span>
                        <Show when={!isEnvVarName(name)}>
                          <span class="text-[0.75rem] text-destructive">
                            not a valid env var
                          </span>
                        </Show>
                      </label>
                    )}
                  </For>
                </div>
                <Show when={invalidFields().length > 0}>
                  <p class="mt-2 text-[0.8rem] text-destructive">
                    Some selected fields aren't valid environment variables. Use
                    Advanced to map them by hand.
                  </p>
                </Show>
              </Show>
            </div>
          </Show>

          <Show when={duplicate()}>
            <div class="mt-4 rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-[0.85rem] text-warning">
              {agentLabel()} already has {service()?.name} access. Granting
              replaces the existing one and ends any active session.
            </div>
          </Show>

          <div class="mt-5 flex items-center justify-end gap-3">
            <button
              type="button"
              class="rounded-md border border-border-strong bg-transparent px-4 py-2 text-muted-foreground"
              onClick={props.onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              class="rounded-md bg-accent px-4 py-2 font-medium text-primary-foreground transition hover:bg-primary/85 disabled:opacity-60"
              disabled={disabledReason() !== ""}
              title={disabledReason() || undefined}
              onClick={handleGrant}
            >
              Grant access
            </button>
          </div>
        </Show>
      </Show>
    </div>
  );
};

const AddKeyForm: Component<{
  selectedServiceId: string;
  selectedSkillId: string;
  duplicateBinding: SkillSecretBinding | undefined;
  selectedVariables: string[];
  onServiceChange: (value: string) => void;
  onSkillChange: (value: string) => void;
  referenceLines: string;
  onReferenceLinesChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}> = (props) => {
  const selectedService = () => getKeyService(props.selectedServiceId);

  return (
    <div class="mb-7 p-5 rounded-lg border border-border-strong bg-surface-2/80">
      <div class="mb-4">
        <h4 class="m-0 mb-1 text-[1.1rem] font-semibold text-foreground">
          Add Seren Passwords references
        </h4>
        <p class="m-0 text-[0.85rem] text-muted-foreground">
          Create an encrypted vault entry here or paste references copied from
          Seren Passwords. Each line maps an environment variable to a
          seren-secrets:// reference.
        </p>
      </div>

      <div class="grid grid-cols-2 gap-4 mb-2">
        <label class="flex flex-col gap-2">
          <span class="text-[0.85rem] font-medium text-foreground">
            Service
          </span>
          <select
            class="px-3 py-2.5 bg-surface-3/80 border border-border-strong rounded-md text-foreground"
            value={props.selectedServiceId}
            onChange={(event) => {
              props.onServiceChange(event.currentTarget.value);
            }}
          >
            <For each={KEY_SERVICES}>
              {(service) => <option value={service.id}>{service.name}</option>}
            </For>
          </select>
        </label>
        <label class="flex flex-col gap-2">
          <span class="text-[0.85rem] font-medium text-foreground flex justify-between">
            Skill
            <span class="text-muted-foreground font-normal">
              required · 1:1 binding
            </span>
          </span>
          <input
            list="seren-skill-choices"
            class="px-3 py-2.5 bg-surface-3/80 border border-border-strong rounded-md text-foreground"
            value={props.selectedSkillId}
            onInput={(event) => props.onSkillChange(event.currentTarget.value)}
          />
          <datalist id="seren-skill-choices">
            <For each={SKILL_CHOICES}>
              {(skill) => <option value={skill} />}
            </For>
          </datalist>
        </label>
      </div>

      <p class="m-0 mb-4 text-[0.8rem] text-muted-foreground leading-relaxed">
        These references will only be requestable by{" "}
        <code class="font-mono text-foreground">{props.selectedSkillId}</code>.
        Other {selectedService()?.name ?? "service"} skills need their own
        binding, so revoking one skill does not affect another.
      </p>

      <Show when={props.duplicateBinding}>
        <div class="mb-4 px-3 py-2 rounded-md border border-warning/35 bg-warning/10 text-warning text-[0.85rem]">
          {props.selectedSkillId} already has{" "}
          {selectedService()?.name ?? "service"} references. Saving replaces the
          existing binding and ends any active access sessions.
        </div>
      </Show>

      <label class="flex flex-col gap-2">
        <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground flex justify-between">
          Environment mappings
          <span>{props.selectedVariables.length} suggested</span>
        </span>
        <textarea
          class="min-h-[150px] px-3 py-2.5 bg-surface-3/80 border border-border-strong rounded-md text-foreground font-mono text-[0.82rem] leading-relaxed resize-y"
          spellcheck={false}
          value={props.referenceLines}
          onInput={(event) =>
            props.onReferenceLinesChange(event.currentTarget.value)
          }
        />
      </label>
      <p class="m-0 mt-2 text-[0.8rem] text-muted-foreground leading-relaxed">
        Example: POLY_SECRET=seren-secrets://vault-uuid/item-uuid/password.
        Create or copy the reference from Seren Passwords, then paste it here.
      </p>

      <div class="mt-5 pt-5 border-t border-border-medium grid grid-cols-2 gap-5">
        <div>
          <h5 class="m-0 mb-3 text-[0.78rem] uppercase tracking-[0.12em] text-muted-foreground">
            Per-transaction approval
          </h5>
          <label class="flex flex-col gap-2">
            <span class="text-[0.9rem] text-foreground">
              Auto-approve up to
            </span>
            <input
              class="px-3 py-2.5 bg-surface-3/80 border border-border-strong rounded-md text-foreground"
              value="$0.00 · always ask"
              readOnly
            />
          </label>
          <p class="m-0 mt-3 text-[0.82rem] text-muted-foreground leading-relaxed">
            Default: $0 (always ask). The host should only resolve references
            after a user approval or an active session.
          </p>
        </div>
        <div>
          <h5 class="m-0 mb-3 text-[0.78rem] uppercase tracking-[0.12em] text-muted-foreground">
            Session approval defaults
          </h5>
          <p class="m-0 mb-3 text-[0.82rem] text-muted-foreground leading-relaxed">
            Approval prompts can start a short-lived session for repeated access
            by the same skill.
          </p>
          <div class="grid grid-cols-2 gap-3">
            <input
              class="px-3 py-2.5 bg-surface-3/80 border border-border-strong rounded-md text-foreground"
              value="30 minutes"
              readOnly
            />
            <input
              class="px-3 py-2.5 bg-surface-3/80 border border-border-strong rounded-md text-foreground"
              value="$200.00"
              readOnly
            />
          </div>
        </div>
      </div>

      <div class="mt-5 flex justify-end gap-3">
        <button
          type="button"
          class="px-4 py-2 rounded-md border border-border-strong bg-transparent text-muted-foreground"
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          class="px-4 py-2 rounded-md border-none bg-accent text-primary-foreground font-medium"
          onClick={props.onSave}
        >
          Save references
        </button>
      </div>
    </div>
  );
};

const CredentialCard: Component<{
  binding: SkillSecretBinding;
  onViewActivity: () => void;
  onReplace: (binding: SkillSecretBinding) => void;
  onEndSession: (session: SecretAccessSession) => void;
}> = (props) => {
  const session = () => props.binding.activeSession;
  return (
    <div class="flex flex-col gap-4 rounded-lg border border-border-strong bg-surface-2 p-4 md:flex-row md:items-start md:justify-between">
      <div class="flex min-w-0 items-start gap-3">
        <div class="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-lg">
          {getKeyService(props.binding.serviceId)?.icon ?? (
            <IconKey size={18} />
          )}
        </div>
        <div class="min-w-0 pt-0.5">
          <div class="text-[0.72rem] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
            Agent
          </div>
          <div class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span class="min-w-0 truncate font-mono text-[1rem] font-semibold text-foreground">
              {props.binding.skillName}
            </span>
            <span class="text-[0.85rem] text-muted-foreground">
              can request {props.binding.serviceName}
            </span>
            <span
              class={`px-2 py-0.5 rounded-full text-[0.72rem] ${
                session()
                  ? "bg-purple-500/20 text-purple-200"
                  : props.binding.approvalPolicy.mode === "always_ask"
                    ? "bg-accent/20 text-accent"
                    : "bg-surface-3 text-muted-foreground"
              }`}
            >
              {bindingPill(props.binding)}
            </span>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8rem] text-muted-foreground">
            <span>{bindingSourceLabel(props.binding)}</span>
            <span>{countLabel(props.binding.secretCount, "secret")}</span>
            <span class="font-mono">
              {props.binding.variableNames.slice(0, 4).join(", ")}
            </span>
            <span>
              Last used {formatRelativeTime(props.binding.lastUsedAt)}
            </span>
          </div>
        </div>
      </div>
      <div class="flex w-full shrink-0 flex-wrap gap-2 md:w-auto md:flex-nowrap">
        <button
          type="button"
          class="whitespace-nowrap rounded-md border border-border-strong bg-transparent px-3 py-1.5 text-[0.84rem] text-foreground transition hover:bg-surface-3"
          onClick={props.onViewActivity}
        >
          View activity
        </button>
        <Show
          when={session()}
          fallback={
            <button
              type="button"
              class="whitespace-nowrap rounded-md border border-border-strong bg-transparent px-3 py-1.5 text-[0.84rem] text-foreground transition hover:bg-surface-3"
              onClick={() => props.onReplace(props.binding)}
            >
              Update access
            </button>
          }
        >
          {(activeSession) => (
            <button
              type="button"
              class="whitespace-nowrap rounded-md border border-border-strong bg-transparent px-3 py-1.5 text-[0.84rem] text-foreground transition hover:bg-surface-3"
              onClick={() => props.onEndSession(activeSession())}
            >
              End session
            </button>
          )}
        </Show>
      </div>
    </div>
  );
};

const ActivityTab: Component<{
  audit: SecretAuditEvent[];
  activeSessions: SecretAccessSession[];
  onEndSession: (session: SecretAccessSession) => void;
}> = (props) => (
  <div>
    <div class="flex items-center justify-between gap-4 mb-5">
      <div>
        <h4 class="m-0 text-[1rem] font-semibold text-foreground">
          Recent access events
        </h4>
        <p class="m-0 mt-1 text-[0.85rem] text-muted-foreground">
          Desktop records reference release decisions locally. Filtering and
          export will be added with the runtime approval prompt.
        </p>
      </div>
    </div>

    <For each={props.activeSessions}>
      {(session) => (
        <div class="sticky top-0 z-10 mb-0 p-4 rounded-t-lg border border-purple-500/30 bg-purple-500/12 flex items-center justify-between gap-4">
          <div class="flex items-center gap-4">
            <span class="text-xl">⏳</span>
            <span class="text-[0.78rem] uppercase tracking-[0.12em] font-semibold text-purple-200">
              ACTIVE SESSION
            </span>
            <span class="text-muted-foreground">
              <code class="font-mono text-foreground">{session.skillId}</code>{" "}
              on {getKeyService(session.serviceId)?.name ?? session.serviceId} ·{" "}
              {sessionMinutesLeft(session)} min left ·{" "}
              {formatUsd(session.spentUsd)} of {formatUsd(session.capUsd)} used
            </span>
          </div>
          <button
            type="button"
            class="bg-transparent border-none text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => props.onEndSession(session)}
          >
            End now
          </button>
        </div>
      )}
    </For>

    <Show
      when={props.audit.length > 0}
      fallback={
        <div class="rounded-lg border border-dashed border-border-medium bg-surface-2/40 px-6 py-10 text-center text-[0.85rem] leading-relaxed text-muted-foreground">
          No access events recorded yet. Decisions to release credential
          references will appear here.
        </div>
      }
    >
      <div class="rounded-lg border border-border-strong overflow-hidden bg-surface-2">
        <For each={props.audit}>
          {(event) => (
            <div class="grid grid-cols-[120px_1fr_130px_220px] gap-4 items-center p-4 border-b border-border last:border-b-0">
              <div class="font-mono text-muted-foreground">
                {formatRelativeTime(event.createdAt)}
              </div>
              <div class="min-w-0">
                <div class="mb-1 text-[0.86rem] text-muted-foreground">
                  {event.serviceName} ·{" "}
                  <span class="px-2 py-1 rounded-md bg-primary/10 font-mono text-foreground">
                    {event.skillName}
                  </span>
                </div>
                <div class="text-foreground leading-normal">
                  {event.operation}
                </div>
              </div>
              <div class="text-right font-mono font-semibold text-foreground">
                {formatUsd(event.amountUsd)}
              </div>
              <div class={`text-right ${decisionClass(event.decision)}`}>
                {event.detail || DECISION_LABELS[event.decision]}
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  </div>
);

const MigrationTab: Component<{
  proposals: SkillEnvMigrationProposal[];
}> = (props) => (
  <div>
    <h4 class="m-0 mb-2 text-[1.1rem] font-semibold text-foreground">
      Review .env migration proposals
    </h4>
    <p class="m-0 mb-5 text-[0.9rem] text-muted-foreground leading-relaxed">
      The host scans skill .env files and shows which variables should move to
      Seren Passwords. Create vault entries first, then replace each plaintext
      value with a matching seren-secrets:// reference.
    </p>
    <Show
      when={props.proposals.length > 0}
      fallback={
        <div class="rounded-lg border border-dashed border-border-medium bg-surface-2/40 px-6 py-10 text-center text-[0.85rem] leading-relaxed text-muted-foreground">
          No skill .env secrets found. When a skill keeps plaintext secrets in a
          .env file, they show up here to move into Seren Passwords.
        </div>
      }
    >
      <div class="flex flex-col gap-3">
        <For each={props.proposals}>
          {(proposal) => (
            <div class="p-4 rounded-lg border border-border-strong bg-surface-2 flex items-center justify-between gap-4">
              <div>
                <div class="font-semibold text-foreground">
                  {proposal.serviceName} for{" "}
                  <code class="font-mono">{proposal.skillId}</code>
                </div>
                <div class="text-[0.85rem] text-muted-foreground mt-1">
                  {proposal.variableNames.join(", ")}
                </div>
                <div class="text-[0.78rem] text-muted-foreground mt-2 font-mono">
                  {proposal.sourcePath} -&gt; {proposal.migratedPath}
                </div>
              </div>
              <div class="text-right text-[0.82rem] text-muted-foreground max-w-[260px]">
                Move these values into Seren Passwords, update the .env file
                with references, then rename the old file when verified.
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  </div>
);
