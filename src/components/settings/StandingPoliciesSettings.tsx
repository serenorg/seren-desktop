// ABOUTME: Owner settings surface to author standing policies that pre-authorize bounded leases for unattended agents (#3193-E).
// ABOUTME: This is the ONLY authoring path for standing policies — the model can never reach these commands.

import {
  type Component,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import {
  createStandingPolicy,
  deleteStandingPolicy,
  listStandingPolicies,
  type PublisherRule,
  type StandingPolicy,
  type StandingPolicyInput,
  updateStandingPolicy,
} from "@/services/tool-authorization";

/** A publisher-op row in the editor, before it becomes a `PublisherRule`. */
interface PublisherOpDraft {
  publisherSlug: string;
  allowHighRisk: boolean;
  target: string;
}

interface PolicyDraft {
  label: string;
  enabled: boolean;
  durationHours: number;
  commandPrograms: string;
  networkHosts: string;
  excludedPrograms: string;
  maxCalls: number;
  maxSpend: number;
  asset: string;
  publisherOps: PublisherOpDraft[];
}

const EMPTY_DRAFT: PolicyDraft = {
  label: "",
  enabled: true,
  durationHours: 4,
  commandPrograms: "",
  networkHosts: "",
  excludedPrograms: "",
  maxCalls: 500,
  maxSpend: 0,
  asset: "",
  publisherOps: [],
};

/** Split a comma/whitespace list into trimmed, non-empty, lowercased tokens. */
function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function draftToInput(draft: PolicyDraft): StandingPolicyInput {
  const publisherOps: PublisherRule[] = draft.publisherOps
    .filter((op) => op.publisherSlug.trim().length > 0)
    .map((op) => ({
      publisherSlug: op.publisherSlug.trim(),
      allowHighRisk: op.allowHighRisk,
      target: op.target.trim() ? op.target.trim() : null,
    }));

  const maxSpendMicros =
    draft.maxSpend > 0 ? Math.round(draft.maxSpend * 1_000_000) : null;

  return {
    label: draft.label.trim(),
    enabled: draft.enabled,
    maxDurationSecs: Math.max(1, Math.round(draft.durationHours * 3600)),
    predicates: {
      commandRules: parseList(draft.commandPrograms).map((program) => ({
        program,
      })),
      networkHosts: parseList(draft.networkHosts),
      publisherOps,
      exclusions: parseList(draft.excludedPrograms).map((program) => ({
        program,
      })),
    },
    budgets: {
      maxCalls: draft.maxCalls > 0 ? draft.maxCalls : null,
      maxSpendMicros,
      asset:
        maxSpendMicros != null && draft.asset.trim()
          ? draft.asset.trim()
          : null,
    },
  };
}

function describePolicy(policy: StandingPolicy): string {
  const parts: string[] = [];
  const commands = policy.predicates.commandRules ?? [];
  if (commands.length > 0) {
    parts.push(`commands: ${commands.map((rule) => rule.program).join(", ")}`);
  }
  const hosts = policy.predicates.networkHosts ?? [];
  if (hosts.length > 0) parts.push(`hosts: ${hosts.join(", ")}`);
  const ops = policy.predicates.publisherOps ?? [];
  if (ops.length > 0) {
    parts.push(
      `publishers: ${ops
        .map(
          (op) =>
            op.publisherSlug +
            (op.target ? ` (${op.target})` : "") +
            (op.allowHighRisk ? " incl. high-risk" : ""),
        )
        .join(", ")}`,
    );
  }
  const exclusions = policy.predicates.exclusions ?? [];
  if (exclusions.length > 0) parts.push(`${exclusions.length} exclusion(s)`);
  return parts.join(" · ") || "no predicates";
}

function describeBudget(policy: StandingPolicy): string {
  const hours = Math.round((policy.maxDurationSecs / 3600) * 10) / 10;
  const calls =
    policy.budgets.maxCalls != null
      ? `${policy.budgets.maxCalls} calls`
      : "unmetered calls";
  const spend =
    policy.budgets.maxSpendMicros != null
      ? ` · ${policy.budgets.maxSpendMicros / 1_000_000} ${policy.budgets.asset ?? ""} max spend`
      : "";
  return `${calls}${spend} · ${hours}h lease`;
}

/**
 * Owner-only authoring surface for standing policies (#3193-E): persistent,
 * non-conversation-scoped pre-authorizations that auto-materialize a bounded
 * capability lease for a matching unattended/long-running agent at task start —
 * zero prompts, no human present. In-policy work then runs silently through the
 * gate; out-of-policy work still escalates. The model can request scope but can
 * never create, widen, or self-approve a policy: this settings surface is the
 * only path that writes one.
 */
export const StandingPoliciesSettings: Component = () => {
  const [revision, setRevision] = createSignal(0);
  const [policies] = createResource(revision, () => listStandingPolicies());
  const [draft, setDraft] = createStore<PolicyDraft>({ ...EMPTY_DRAFT });
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const resetForm = () => {
    setDraft({ ...EMPTY_DRAFT, publisherOps: [] });
    setEditingId(null);
    setError(null);
  };

  const beginEdit = (policy: StandingPolicy) => {
    setEditingId(policy.id);
    setError(null);
    setDraft({
      label: policy.label,
      enabled: policy.enabled,
      durationHours: Math.round((policy.maxDurationSecs / 3600) * 10) / 10,
      commandPrograms: (policy.predicates.commandRules ?? [])
        .map((rule) => rule.program)
        .join(", "),
      networkHosts: (policy.predicates.networkHosts ?? []).join(", "),
      excludedPrograms: (policy.predicates.exclusions ?? [])
        .map((exclusion) => exclusion.program ?? "")
        .filter((program) => program.length > 0)
        .join(", "),
      maxCalls: policy.budgets.maxCalls ?? 0,
      maxSpend:
        policy.budgets.maxSpendMicros != null
          ? policy.budgets.maxSpendMicros / 1_000_000
          : 0,
      asset: policy.budgets.asset ?? "",
      publisherOps: (policy.predicates.publisherOps ?? []).map((op) => ({
        publisherSlug: op.publisherSlug,
        allowHighRisk: op.allowHighRisk ?? false,
        target: op.target ?? "",
      })),
    });
  };

  const addPublisherOp = () => {
    setDraft("publisherOps", (ops) => [
      ...ops,
      { publisherSlug: "", allowHighRisk: false, target: "" },
    ]);
  };

  const removePublisherOp = (index: number) => {
    setDraft("publisherOps", (ops) => ops.filter((_, i) => i !== index));
  };

  const save = async () => {
    if (busy()) return;
    const input = draftToInput(draft);
    if (!input.label) {
      setError("A policy needs a label.");
      return;
    }
    const hasPredicate =
      (input.predicates.commandRules?.length ?? 0) > 0 ||
      (input.predicates.networkHosts?.length ?? 0) > 0 ||
      (input.predicates.publisherOps?.length ?? 0) > 0;
    if (!hasPredicate) {
      setError(
        "Add at least one command, host, or publisher to pre-authorize.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = editingId();
      if (id) {
        await updateStandingPolicy(id, input);
      } else {
        await createStandingPolicy(input);
      }
      resetForm();
      setRevision((n) => n + 1);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (policy: StandingPolicy) => {
    setBusy(true);
    try {
      await updateStandingPolicy(policy.id, {
        label: policy.label,
        enabled: !policy.enabled,
        maxDurationSecs: policy.maxDurationSecs,
        predicates: policy.predicates,
        budgets: policy.budgets,
      });
      setRevision((n) => n + 1);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (policy: StandingPolicy) => {
    setBusy(true);
    try {
      await deleteStandingPolicy(policy.id);
      if (editingId() === policy.id) resetForm();
      setRevision((n) => n + 1);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "w-full px-2.5 py-1.5 text-[0.85rem] rounded-md bg-surface-3/60 border border-border text-foreground";

  return (
    <div class="mt-8 pt-6 border-t border-border">
      <h4 class="m-0 mb-1 text-[1.05rem] font-semibold text-foreground">
        Standing pre-authorization policies
      </h4>
      <p class="m-0 mb-4 text-[0.85rem] text-muted-foreground leading-normal">
        Pre-authorize bounded work so unattended and long-running agents run
        in-policy tasks without a prompt. At task start a matching enabled
        policy auto-materializes a capability lease with these exact predicates
        and budgets — nothing wider. Out-of-policy work still asks for approval.
        Only you can author a policy here; the model can never create or widen
        one.
      </p>

      <div class="flex flex-col gap-2 mb-6">
        <Show
          when={(policies() ?? []).length > 0}
          fallback={
            <span class="text-[0.85rem] text-muted-foreground">
              No standing policies yet. Unattended agents will prompt (and
              pause) on the first out-of-lease action until you add one.
            </span>
          }
        >
          <For each={policies()}>
            {(policy) => (
              <div class="border border-border rounded-lg px-3 py-2.5 flex flex-col gap-1.5">
                <div class="flex items-center gap-2">
                  <span class="text-[0.9rem] text-foreground font-medium">
                    {policy.label}
                  </span>
                  <span
                    class={`text-[0.72rem] font-medium rounded px-1.5 py-0.5 border ${
                      policy.enabled
                        ? "text-success border-success/40"
                        : "text-muted-foreground border-border"
                    }`}
                  >
                    {policy.enabled ? "enabled" : "disabled"}
                  </span>
                  <div class="ml-auto flex gap-2">
                    <button
                      type="button"
                      class="px-2.5 py-1 text-[0.78rem] rounded-md cursor-pointer bg-transparent text-foreground border border-border hover:bg-surface-3/60 disabled:opacity-50"
                      onClick={() => void toggleEnabled(policy)}
                      disabled={busy()}
                    >
                      {policy.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      class="px-2.5 py-1 text-[0.78rem] rounded-md cursor-pointer bg-transparent text-foreground border border-border hover:bg-surface-3/60 disabled:opacity-50"
                      onClick={() => beginEdit(policy)}
                      disabled={busy()}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      class="px-2.5 py-1 text-[0.78rem] rounded-md cursor-pointer bg-transparent text-destructive border border-destructive/40 hover:bg-destructive/10 disabled:opacity-50"
                      onClick={() => void remove(policy)}
                      disabled={busy()}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <span class="text-[0.78rem] text-muted-foreground">
                  {describePolicy(policy)}
                </span>
                <span class="text-[0.78rem] text-muted-foreground">
                  {describeBudget(policy)}
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="border border-border rounded-lg p-4 flex flex-col gap-3">
        <span class="text-[0.9rem] font-semibold text-foreground">
          {editingId() ? "Edit policy" : "New policy"}
        </span>

        <label class="flex flex-col gap-1">
          <span class="text-[0.8rem] text-muted-foreground">Label</span>
          <input
            class={inputClass}
            type="text"
            placeholder="e.g. Unattended coding tasks"
            value={draft.label}
            onInput={(e) => setDraft("label", e.currentTarget.value)}
          />
        </label>

        <div class="grid grid-cols-2 gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-[0.8rem] text-muted-foreground">
              Lease duration (hours)
            </span>
            <input
              class={inputClass}
              type="number"
              min="0.1"
              step="0.5"
              value={draft.durationHours}
              onInput={(e) =>
                setDraft("durationHours", Number(e.currentTarget.value))
              }
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.8rem] text-muted-foreground">
              Max calls (0 = unmetered)
            </span>
            <input
              class={inputClass}
              type="number"
              min="0"
              step="1"
              value={draft.maxCalls}
              onInput={(e) =>
                setDraft("maxCalls", Number(e.currentTarget.value))
              }
            />
          </label>
        </div>

        <label class="flex flex-col gap-1">
          <span class="text-[0.8rem] text-muted-foreground">
            Command programs (comma-separated, e.g. cargo, pnpm, git)
          </span>
          <input
            class={inputClass}
            type="text"
            placeholder="cargo, pnpm, npm, node, git"
            value={draft.commandPrograms}
            onInput={(e) => setDraft("commandPrograms", e.currentTarget.value)}
          />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-[0.8rem] text-muted-foreground">
            Network hosts for web fetch (comma-separated)
          </span>
          <input
            class={inputClass}
            type="text"
            placeholder="registry.npmjs.org, docs.rs"
            value={draft.networkHosts}
            onInput={(e) => setDraft("networkHosts", e.currentTarget.value)}
          />
        </label>

        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <span class="text-[0.8rem] text-muted-foreground">
              Publisher operations
            </span>
            <button
              type="button"
              class="px-2 py-0.5 text-[0.75rem] rounded cursor-pointer bg-transparent text-foreground border border-border hover:bg-surface-3/60"
              onClick={addPublisherOp}
            >
              + Add publisher
            </button>
          </div>
          <For each={draft.publisherOps}>
            {(op, index) => (
              <div class="flex items-center gap-2">
                <input
                  class={inputClass}
                  type="text"
                  placeholder="publisher slug (e.g. github)"
                  value={op.publisherSlug}
                  onInput={(e) =>
                    setDraft(
                      "publisherOps",
                      index(),
                      "publisherSlug",
                      e.currentTarget.value,
                    )
                  }
                />
                <input
                  class={inputClass}
                  type="text"
                  placeholder="target (optional, e.g. org/repo)"
                  value={op.target}
                  onInput={(e) =>
                    setDraft(
                      "publisherOps",
                      index(),
                      "target",
                      e.currentTarget.value,
                    )
                  }
                />
                <label class="flex items-center gap-1 text-[0.75rem] text-muted-foreground whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={op.allowHighRisk}
                    onChange={(e) =>
                      setDraft(
                        "publisherOps",
                        index(),
                        "allowHighRisk",
                        e.currentTarget.checked,
                      )
                    }
                    class="w-3.5 h-3.5 accent-[var(--color-primary,#6366f1)]"
                  />
                  high-risk
                </label>
                <button
                  type="button"
                  class="px-2 py-1 text-[0.75rem] rounded cursor-pointer bg-transparent text-destructive border border-destructive/40 hover:bg-destructive/10"
                  onClick={() => removePublisherOp(index())}
                >
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>

        <label class="flex flex-col gap-1">
          <span class="text-[0.8rem] text-muted-foreground">
            Excluded programs (deny — beats every allow above)
          </span>
          <input
            class={inputClass}
            type="text"
            placeholder="rm, curl"
            value={draft.excludedPrograms}
            onInput={(e) => setDraft("excludedPrograms", e.currentTarget.value)}
          />
        </label>

        <div class="grid grid-cols-2 gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-[0.8rem] text-muted-foreground">
              Max spend (major units, 0 = none)
            </span>
            <input
              class={inputClass}
              type="number"
              min="0"
              step="0.01"
              value={draft.maxSpend}
              onInput={(e) =>
                setDraft("maxSpend", Number(e.currentTarget.value))
              }
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.8rem] text-muted-foreground">
              Spend asset (e.g. USDC)
            </span>
            <input
              class={inputClass}
              type="text"
              placeholder="USDC"
              value={draft.asset}
              onInput={(e) => setDraft("asset", e.currentTarget.value)}
            />
          </label>
        </div>

        <label class="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft("enabled", e.currentTarget.checked)}
            class="w-4 h-4 accent-[var(--color-primary,#6366f1)]"
          />
          <span class="text-[0.85rem] text-foreground">
            Enabled (auto-materialize leases for matching tasks)
          </span>
        </label>

        <Show when={error()}>
          <span class="text-[0.8rem] text-destructive">{error()}</span>
        </Show>

        <div class="flex gap-2">
          <button
            type="button"
            class="px-3.5 py-1.5 text-[0.85rem] font-medium rounded-md cursor-pointer bg-primary text-white border-none hover:opacity-90 disabled:opacity-50"
            onClick={() => void save()}
            disabled={busy()}
          >
            {editingId() ? "Save changes" : "Create policy"}
          </button>
          <Show when={editingId()}>
            <button
              type="button"
              class="px-3.5 py-1.5 text-[0.85rem] rounded-md cursor-pointer bg-transparent text-foreground border border-border hover:bg-surface-3/60"
              onClick={resetForm}
              disabled={busy()}
            >
              Cancel
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default StandingPoliciesSettings;
