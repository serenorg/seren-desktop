// ABOUTME: Settings surface for skill-scoped Keys and host-mediated secret access.
// ABOUTME: Implements issue #1823 v4 mocks: per-skill bindings, sessions, activity, and migration.

import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Show,
} from "solid-js";
import {
  DEFAULT_KEY_APPROVAL_POLICY,
  getKeyService,
  groupBindingsByService,
  KEY_SERVICES,
  type KeyServiceDefinition,
  type SecretAccessSession,
  type SecretAuditEvent,
  type SkillEnvMigrationProposal,
  type SkillSecretBinding,
} from "@/lib/keys/secret-broker";
import {
  endSkillSecretSession,
  listSecretAccessAudit,
  listSkillSecretBindings,
  scanSkillEnvMigrations,
  upsertSkillSecretBinding,
} from "@/services/keys";

type KeysTab = "stored" | "activity" | "migration";

const SKILL_CHOICES = [
  "polymarket-bot",
  "paired-basis-maker",
  "high-throughput-basis-maker",
  "grid-trader",
  "5x-btc-usdc-withdraw",
  "smart-dca-bot",
];

const DEFAULT_SERVICE_ID = "polymarket";
const DEFAULT_SKILL_ID = "polymarket-bot";
const DECISION_LABELS: Record<SecretAuditEvent["decision"], string> = {
  approved_by_user: "Approved by you",
  auto_approved: "Auto-approved",
  session_approved: "Session-approved",
  denied_by_user: "Denied by you",
  session_start: "Approved by you",
  session_end: "Session ended",
  import_proposed: "Import proposed",
  approval_required: "Approval required",
  key_edited: "Key edited",
};

function formatUsd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "";
  return `$${amount.toFixed(amount % 1 === 0 ? 0 : 2)}`;
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

export const KeysSettings: Component = () => {
  const [tab, setTab] = createSignal<KeysTab>("stored");
  const [showAddForm, setShowAddForm] = createSignal(false);
  const [selectedServiceId, setSelectedServiceId] =
    createSignal(DEFAULT_SERVICE_ID);
  const [selectedSkillId, setSelectedSkillId] = createSignal(DEFAULT_SKILL_ID);
  const [formValues, setFormValues] = createSignal<Record<string, string>>({});
  const [saveMessage, setSaveMessage] = createSignal<string | null>(null);

  const [bindings, { refetch: refetchBindings }] = createResource(
    listSkillSecretBindings,
  );
  const [audit, { refetch: refetchAudit }] = createResource(
    listSecretAccessAudit,
  );
  const [migrationProposals, { refetch: refetchMigrationProposals }] =
    createResource(scanSkillEnvMigrations);

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
  const selectedVariables = () =>
    selectedServiceDefaultVariables(selectedService());
  const duplicateBinding = () =>
    bindingList().find(
      (binding) =>
        binding.serviceId === selectedServiceId() &&
        binding.skillId === selectedSkillId(),
    );

  const handleFieldInput = (name: string, value: string) => {
    setFormValues((current) => ({ ...current, [name]: value }));
  };

  const handleSaveKey = async () => {
    const service = selectedService();
    if (!service) return;

    setSaveMessage(null);
    try {
      await upsertSkillSecretBinding({
        serviceId: service.id,
        serviceName: service.name,
        skillId: selectedSkillId(),
        skillName: selectedSkillId(),
        secretValues: formValues(),
        approvalPolicy: DEFAULT_KEY_APPROVAL_POLICY,
      });
      setSaveMessage("Saved to Keys. Raw values stay in the host store.");
      setFormValues({});
      setShowAddForm(false);
      await refetchBindings();
      await refetchAudit();
    } catch (error) {
      setSaveMessage(
        `Key storage is available in the desktop runtime. ${String(error)}`,
      );
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

  return (
    <section class="max-w-[1180px]">
      <div class="flex items-start justify-between gap-6 mb-8">
        <div>
          <h3 class="m-0 mb-3 text-[1.8rem] font-semibold text-foreground">
            Keys
          </h3>
          <p class="m-0 max-w-[860px] text-[0.95rem] text-muted-foreground leading-relaxed">
            Keys are credentials skills use to act on your behalf — broker APIs,
            exchange secrets, wallet keys. Stored locally and encrypted with
            your OS keychain. Skills request them at runtime through the host;
            the host enforces per-transaction approval and spend caps.
          </p>
        </div>
        <button
          type="button"
          class="px-4 py-2 bg-accent text-primary-foreground rounded-md border border-accent font-medium hover:bg-primary/85"
          onClick={() => setShowAddForm(true)}
        >
          + Add key
        </button>
      </div>

      <Show when={saveMessage()}>
        {(message) => (
          <div class="mb-4 px-4 py-3 rounded-md border border-border-strong bg-surface-2 text-[0.85rem] text-muted-foreground">
            {message()}
          </div>
        )}
      </Show>

      <Show when={tab() === "stored"}>
        <MigrationBanner
          proposals={migrationList()}
          onReview={handleReviewMigrate}
        />
      </Show>

      <div class="flex gap-8 border-b border-border-medium mb-5">
        <KeysTabButton
          active={tab() === "stored"}
          onClick={() => setTab("stored")}
        >
          Stored credentials {bindingList().length}
        </KeysTabButton>
        <KeysTabButton
          active={tab() === "activity"}
          onClick={() => setTab("activity")}
        >
          Activity {auditList().length} last 7d
        </KeysTabButton>
        <KeysTabButton
          active={tab() === "migration"}
          onClick={() => setTab("migration")}
        >
          Migration {migrationList().length}
        </KeysTabButton>
      </div>

      <Show when={tab() === "stored"}>
        <div class="flex items-center justify-between gap-4 mb-4">
          <h4 class="m-0 text-[1rem] font-semibold text-muted-foreground">
            Stored credentials · {bindingList().length} keys across{" "}
            {serviceGroups().length} services · 1 per skill
          </h4>
          <button
            type="button"
            class="px-3 py-2 bg-accent text-primary-foreground rounded-md border-none font-medium"
            onClick={() => setShowAddForm(true)}
          >
            + Add key
          </button>
        </div>

        <Show when={showAddForm()}>
          <AddKeyForm
            selectedServiceId={selectedServiceId()}
            selectedSkillId={selectedSkillId()}
            duplicateBinding={duplicateBinding()}
            selectedVariables={selectedVariables()}
            onServiceChange={(value) => {
              setSelectedServiceId(value);
              setFormValues({});
            }}
            onSkillChange={setSelectedSkillId}
            onFieldInput={handleFieldInput}
            onCancel={() => setShowAddForm(false)}
            onSave={handleSaveKey}
          />
        </Show>

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
                      {group.bindings.length} keys · 1 per skill
                    </span>
                  </div>
                  <button
                    type="button"
                    class="bg-transparent border-none text-accent text-[0.85rem] cursor-pointer"
                    onClick={() => {
                      setSelectedServiceId(group.service.id);
                      setShowAddForm(true);
                    }}
                  >
                    + Add for another skill
                  </button>
                </div>
                <div class="flex flex-col gap-3">
                  <For each={group.bindings}>
                    {(binding) => (
                      <CredentialCard
                        binding={binding}
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

      <ApprovalPreview />
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
  onReview: () => void;
}> = (props) => (
  <Show when={props.proposals.length > 0}>
    <div class="mb-8 p-5 rounded-lg border border-accent/45 bg-accent/10 flex items-center justify-between gap-5">
      <div class="flex items-start gap-4">
        <span class="text-2xl">📦</span>
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
            the python-dotenv shim will read from Keys at runtime, so the skill
            source doesn't change.
          </p>
        </div>
      </div>
      <div class="flex gap-3">
        <button
          type="button"
          class="px-3 py-2 rounded-md border border-border-strong bg-transparent text-muted-foreground"
        >
          Dismiss
        </button>
        <button
          type="button"
          class="px-4 py-2 rounded-md border-none bg-accent text-primary-foreground font-medium"
          onClick={props.onReview}
        >
          Review & migrate →
        </button>
      </div>
    </div>
  </Show>
);

const AddKeyForm: Component<{
  selectedServiceId: string;
  selectedSkillId: string;
  duplicateBinding: SkillSecretBinding | undefined;
  selectedVariables: string[];
  onServiceChange: (value: string) => void;
  onSkillChange: (value: string) => void;
  onFieldInput: (name: string, value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}> = (props) => {
  const selectedService = () => getKeyService(props.selectedServiceId);
  return (
    <div class="mb-7 p-5 rounded-lg border border-border-strong bg-surface-2/80">
      <div class="mb-4">
        <h4 class="m-0 mb-1 text-[1.1rem] font-semibold text-foreground">
          Add a key
        </h4>
        <p class="m-0 text-[0.85rem] text-muted-foreground">
          Keys are bound to a single skill. To share a service across skills,
          add one key per skill.
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
            onChange={(event) =>
              props.onServiceChange(event.currentTarget.value)
            }
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
          <select
            class="px-3 py-2.5 bg-surface-3/80 border border-border-strong rounded-md text-foreground"
            value={props.selectedSkillId}
            onChange={(event) => props.onSkillChange(event.currentTarget.value)}
          >
            <For each={SKILL_CHOICES}>
              {(skill) => <option value={skill}>{skill}</option>}
            </For>
          </select>
        </label>
      </div>

      <p class="m-0 mb-4 text-[0.8rem] text-muted-foreground leading-relaxed">
        This key will only be requestable by{" "}
        <code class="font-mono text-foreground">{props.selectedSkillId}</code>.
        Other {selectedService()?.name ?? "service"} skills need their own key —
        revoking this one won't break them.
      </p>

      <Show when={props.duplicateBinding}>
        <div class="mb-4 px-3 py-2 rounded-md border border-warning/35 bg-warning/10 text-warning text-[0.85rem]">
          {props.selectedSkillId} already has a{" "}
          {selectedService()?.name ?? "service"} key — saving will replace it;
          we don't silently overwrite.
        </div>
      </Show>

      <div class="grid grid-cols-2 gap-4">
        <For each={props.selectedVariables}>
          {(name, index) => (
            <label class="flex flex-col gap-2">
              <span class="text-[0.78rem] uppercase tracking-[0.08em] text-muted-foreground flex justify-between">
                {name}
                <span>{index() === 0 ? "required" : "masked"}</span>
              </span>
              <input
                class="px-3 py-2.5 bg-surface-3/80 border border-border-strong rounded-md text-foreground font-mono"
                type={
                  name.includes("KEY") && index() === 0 ? "text" : "password"
                }
                placeholder={
                  name.includes("PRIVATE") ? "0x••••••••••••" : "••••••••••••"
                }
                onInput={(event) =>
                  props.onFieldInput(name, event.currentTarget.value)
                }
              />
            </label>
          )}
        </For>
      </div>

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
            Default: $0 (always ask). Opt in to a higher cap only if you've
            watched this skill's traffic in Activity and trust the size.
          </p>
        </div>
        <div>
          <h5 class="m-0 mb-3 text-[0.78rem] uppercase tracking-[0.12em] text-muted-foreground">
            Session approval defaults
          </h5>
          <p class="m-0 mb-3 text-[0.82rem] text-muted-foreground leading-relaxed">
            Approval prompts show a Start session option — these defaults
            pre-fill it.
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
          Save to keychain
        </button>
      </div>
    </div>
  );
};

const CredentialCard: Component<{
  binding: SkillSecretBinding;
  onEndSession: (session: SecretAccessSession) => void;
}> = (props) => {
  const session = () => props.binding.activeSession;
  return (
    <div class="p-4 rounded-lg border border-border-strong bg-surface-2 flex items-center justify-between gap-4">
      <div class="flex items-center gap-4 min-w-0">
        <div class="w-12 h-12 rounded-lg bg-primary/10 grid place-items-center text-xl">
          {getKeyService(props.binding.serviceId)?.icon ?? "🔑"}
        </div>
        <div class="min-w-0">
          <div class="text-[0.72rem] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
            {props.binding.serviceName} key for
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-mono text-[1.05rem] font-semibold text-foreground">
              {props.binding.skillName}
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
          <p class="m-0 mt-1 text-[0.82rem] text-muted-foreground">
            {props.binding.secretCount} secrets ·{" "}
            {props.binding.variableNames.slice(0, 4).join(", ")} · Last used{" "}
            {formatRelativeTime(props.binding.lastUsedAt)}
          </p>
        </div>
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          class="px-3 py-2 rounded-md border border-border-strong bg-transparent text-foreground"
        >
          View activity
        </button>
        <Show
          when={session()}
          fallback={
            <button
              type="button"
              class="px-3 py-2 rounded-md border border-border-strong bg-transparent text-foreground"
            >
              Edit
            </button>
          }
        >
          {(activeSession) => (
            <button
              type="button"
              class="px-3 py-2 rounded-md border border-border-strong bg-transparent text-foreground"
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
      <div class="flex gap-3 flex-wrap">
        <button
          type="button"
          class="px-3 py-2 rounded-full border border-border-strong bg-surface-2 text-foreground"
        >
          All services⌄
        </button>
        <button
          type="button"
          class="px-3 py-2 rounded-full border border-border-strong bg-surface-2 text-foreground"
        >
          All skills⌄
        </button>
        <button
          type="button"
          class="px-3 py-2 rounded-full border border-border-strong bg-surface-2 text-foreground"
        >
          All decisions⌄
        </button>
        <button
          type="button"
          class="px-3 py-2 rounded-full border border-border-strong bg-surface-2 text-foreground"
        >
          Last 7 days⌄
        </button>
      </div>
      <button
        type="button"
        class="px-3 py-2 rounded-md border border-border-strong bg-surface-2 text-foreground"
      >
        ⇩ Export CSV
      </button>
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
            class="bg-transparent border-none text-muted-foreground hover:text-foreground"
            onClick={() => props.onEndSession(session)}
          >
            End now
          </button>
        </div>
      )}
    </For>

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
      The host scans skill .env files and proposes one key per discovered
      service and skill. Nothing imports silently. Confirmed files are renamed
      to .env.migrated rather than deleted.
    </p>
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
                {proposal.sourcePath} → {proposal.migratedPath}
              </div>
            </div>
            <div class="flex gap-2">
              <button
                type="button"
                class="px-3 py-2 rounded-md border border-border-strong bg-transparent text-muted-foreground"
              >
                Decline
              </button>
              <button
                type="button"
                class="px-3 py-2 rounded-md border-none bg-accent text-primary-foreground"
              >
                Confirm import
              </button>
            </div>
          </div>
        )}
      </For>
    </div>
  </div>
);

const ApprovalPreview: Component = () => (
  <div class="mt-8 p-5 rounded-lg border border-purple-500/25 bg-purple-500/10">
    <div class="flex items-start gap-4">
      <div class="w-10 h-10 rounded-lg bg-warning/15 grid place-items-center text-xl">
        ⚠️
      </div>
      <div class="flex-1">
        <h4 class="m-0 text-[1rem] font-semibold text-foreground">
          Approve Polymarket transaction
        </h4>
        <p class="m-0 mt-1 text-[0.85rem] text-muted-foreground">
          This key is set to <strong class="text-foreground">always ask</strong>{" "}
          · waiting for your decision
        </p>
        <div class="mt-4 p-4 rounded-lg border border-border-strong bg-surface-2 grid gap-2">
          <div class="flex justify-between border-b border-border pb-2">
            <span class="text-muted-foreground">Skill</span>
            <code class="font-mono">polymarket-bot</code>
          </div>
          <div class="flex justify-between border-b border-border pb-2">
            <span class="text-muted-foreground">Action</span>
            <span>Buy YES @ 0.62</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted-foreground">Amount</span>
            <strong>$42.50 USDC</strong>
          </div>
        </div>
        <div class="mt-4 p-4 rounded-lg border border-purple-500/35 bg-purple-500/10">
          <div class="text-[0.78rem] uppercase tracking-[0.12em] text-purple-200 font-semibold">
            Auto-approve this skill for a session
          </div>
          <div class="grid grid-cols-2 gap-3 mt-3">
            <input
              class="px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground"
              value="30 minutes"
              readOnly
            />
            <input
              class="px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground"
              value="$200.00"
              readOnly
            />
          </div>
        </div>
        <div class="flex justify-end gap-3 mt-4">
          <button
            type="button"
            class="px-3 py-2 rounded-md border border-destructive/50 bg-transparent text-destructive"
          >
            Deny
          </button>
          <button
            type="button"
            class="px-3 py-2 rounded-md border border-border-strong bg-transparent text-foreground"
          >
            Approve once
          </button>
          <button
            type="button"
            class="px-4 py-2 rounded-md border-none bg-purple-500 text-white font-medium"
          >
            Approve & start 30 min session
          </button>
        </div>
      </div>
    </div>
  </div>
);
