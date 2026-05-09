// ABOUTME: Modal wizard to deploy a new virtual employee via the seren-agent publisher.
// ABOUTME: Single-page form with mode/identity/skills/model fields plus collapsible advanced.

import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { deriveSlug, gradientFor, initialFor } from "@/lib/employees/avatar";
import {
  buildEmployeeSystemPrompt,
  extractPersonaSections,
} from "@/lib/employees/persona";
import type {
  EmployeeApprovalPolicy,
  EmployeeDetail,
  EmployeeMode,
  EmployeeModelPolicy,
  EmployeePatch,
  EmployeeToolPreset,
  ModelChoice,
  NewEmployeeInput,
} from "@/lib/employees/types";
import { employees as svc } from "@/services/employees";
import { employeeStore } from "@/stores/employees.store";

type ModeOption = { value: EmployeeMode; title: string; sub: string };

const MODES: ModeOption[] = [
  {
    value: "always_on",
    title: "On-call",
    sub: "Always available, you converse",
  },
  { value: "cron", title: "Scheduled", sub: "Runs on a cron schedule" },
  { value: "job", title: "On-demand", sub: "Manual trigger only" },
];

const POLICIES: { value: EmployeeModelPolicy; label: string }[] = [
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "deep", label: "Deep" },
];

const TOOL_PRESETS: { value: EmployeeToolPreset; label: string }[] = [
  { value: "live_data", label: "Live data" },
  { value: "publisher_actions", label: "Publisher actions" },
  { value: "database", label: "Database" },
];

const DEFAULT_LIMITS = {
  maxIterations: 4,
  maxToolCallsPerRun: 4,
  maxTimeoutSeconds: 120,
  maxToolOutputChars: 6000,
  contextBudgetTokens: 24000,
};

interface CreateEmployeeModalProps {
  onClose: () => void;
  onCreated: (employeeId: string) => void;
  /**
   * When provided, the modal opens in edit mode: fields are prefilled and
   * submission calls update() instead of deploy(). Slug and mode are
   * immutable in edit mode (the backend update spec does not expose them).
   */
  employee?: EmployeeDetail;
}

export const CreateEmployeeModal: Component<CreateEmployeeModalProps> = (
  props,
) => {
  const editing = () => props.employee !== undefined;
  const initial = props.employee;

  const [name, setName] = createSignal(initial?.name ?? "");
  const [slug, setSlug] = createSignal(initial?.slug ?? "");
  // In edit mode the slug is immutable; treat it as already-touched so we
  // never auto-derive over it.
  const [slugTouched, setSlugTouched] = createSignal(initial !== undefined);
  const [mode, setMode] = createSignal<EmployeeMode>(
    initial?.mode ?? "always_on",
  );
  const [cronSchedule, setCronSchedule] = createSignal(
    initial?.cronSchedule ?? "0 * * * *",
  );
  const [cronTimezone, setCronTimezone] = createSignal(
    initial?.cronTimezone ?? "UTC",
  );
  const initialSections = extractPersonaSections(initial?.prompt);
  const [role, setRole] = createSignal(initialSections.skill);
  const [identity, setIdentity] = createSignal(initialSections.identity);
  const [soul, setSoul] = createSignal(initialSections.soul);
  const [modelChoice, setModelChoice] = createSignal<ModelChoice>(
    initial?.modelChoice ?? "standard",
  );
  const [modelPolicy, setModelPolicy] = createSignal<EmployeeModelPolicy>(
    initial?.modelPolicy ?? "balanced",
  );
  const [modelId, setModelId] = createSignal(initial?.modelId ?? "");
  const [showAdvanced, setShowAdvanced] = createSignal(false);
  const [approvalPolicy, setApprovalPolicy] =
    createSignal<EmployeeApprovalPolicy>(
      initial?.approvalPolicy ?? "read_only",
    );
  const [toolPresets, setToolPresets] = createSignal<EmployeeToolPreset[]>(
    initial?.toolPresets && initial.toolPresets.length > 0
      ? initial.toolPresets
      : ["live_data"],
  );
  const [maxIterations, setMaxIterations] = createSignal(
    initial?.maxIterations ?? DEFAULT_LIMITS.maxIterations,
  );
  const [maxToolCalls, setMaxToolCalls] = createSignal(
    initial?.maxToolCallsPerRun ?? DEFAULT_LIMITS.maxToolCallsPerRun,
  );
  const [maxTimeout, setMaxTimeout] = createSignal(
    initial?.maxTimeoutSeconds ?? DEFAULT_LIMITS.maxTimeoutSeconds,
  );
  const [maxToolOutput, setMaxToolOutput] = createSignal(
    initial?.maxToolOutputChars ?? DEFAULT_LIMITS.maxToolOutputChars,
  );
  const [contextBudget, setContextBudget] = createSignal(
    initial?.contextBudgetTokens ?? DEFAULT_LIMITS.contextBudgetTokens,
  );

  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  let nameInputRef: HTMLInputElement | undefined;

  const clearError = () => {
    if (error() !== null) setError(null);
  };

  const [privateModels] = createResource(
    () => (modelChoice() === "private" ? "load" : null),
    async () => {
      try {
        return await svc.listPrivateModels();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return [];
      }
    },
  );

  createEffect(() => {
    const list = privateModels();
    if (modelChoice() !== "private") return;
    if (!list || list.length === 0) return;
    if (modelId()) return;
    const recommended = list.find((m) => m.recommended) ?? list[0];
    setModelId(recommended.model_id);
  });

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !submitting()) {
      event.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    requestAnimationFrame(() => nameInputRef?.focus());
    document.addEventListener("keydown", handleDocumentKeydown);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleDocumentKeydown);
  });

  const effectiveSlug = createMemo(() => {
    if (slugTouched()) return slug();
    return deriveSlug(name());
  });

  const canSubmit = createMemo(
    () =>
      !submitting() &&
      name().trim().length > 0 &&
      effectiveSlug().length > 0 &&
      role().trim().length > 0 &&
      (mode() !== "cron" || cronSchedule().trim().length > 0) &&
      (modelChoice() !== "private" || modelId().trim().length > 0),
  );

  const buildSystemPrompt = (): string => {
    return buildEmployeeSystemPrompt({
      name: name(),
      slug: effectiveSlug(),
      skill: role(),
      identity: identity(),
      soul: soul(),
    });
  };

  const toggleToolPreset = (preset: EmployeeToolPreset) => {
    setToolPresets((prev) =>
      prev.includes(preset)
        ? prev.filter((p) => p !== preset)
        : [...prev, preset],
    );
  };

  const handleSubmit = async () => {
    if (!canSubmit()) return;
    setSubmitting(true);
    setError(null);
    try {
      const limits = {
        maxIterations: maxIterations(),
        maxToolCallsPerRun: maxToolCalls(),
        maxTimeoutSeconds: maxTimeout(),
        maxToolOutputChars: maxToolOutput(),
        contextBudgetTokens: contextBudget(),
      };
      let summary: Awaited<ReturnType<typeof svc.deploy>>;
      if (props.employee) {
        const patch: EmployeePatch = {
          name: name().trim(),
          // Mode is immutable on update; cron fields only flow when the
          // existing mode is cron.
          mode: props.employee.mode,
          cronSchedule:
            props.employee.mode === "cron" ? cronSchedule().trim() : undefined,
          cronTimezone:
            props.employee.mode === "cron" ? cronTimezone().trim() : undefined,
          systemPrompt: buildSystemPrompt(),
          modelChoice: modelChoice(),
          modelPolicy: modelChoice() === "standard" ? modelPolicy() : undefined,
          modelId: modelChoice() === "private" ? modelId().trim() : undefined,
          toolPresets: toolPresets(),
          approvalPolicy: approvalPolicy(),
          limits,
        };
        summary = await svc.update(props.employee.id, patch);
      } else {
        const input: NewEmployeeInput = {
          name: name().trim(),
          slug: effectiveSlug(),
          mode: mode(),
          cronSchedule: mode() === "cron" ? cronSchedule().trim() : undefined,
          cronTimezone: mode() === "cron" ? cronTimezone().trim() : undefined,
          systemPrompt: buildSystemPrompt(),
          modelChoice: modelChoice(),
          modelPolicy: modelChoice() === "standard" ? modelPolicy() : undefined,
          modelId: modelChoice() === "private" ? modelId().trim() : undefined,
          toolPresets: toolPresets(),
          approvalPolicy: approvalPolicy(),
          limits,
        };
        summary = await svc.deploy(input);
      }
      employeeStore.upsert(summary);
      void employeeStore.refresh();
      if (props.employee) {
        void employeeStore.loadDetail(summary.id);
      }
      props.onCreated(summary.id);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !submitting()) props.onClose();
  };

  return (
    <div
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_0.15s_ease-out]"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-employee-title"
    >
      <div class="bg-popover border border-border rounded-lg w-[560px] max-w-[92vw] max-h-[88vh] overflow-y-auto shadow-xl animate-[slideUp_0.2s_ease-out]">
        <div class="flex justify-between items-center py-4 px-5 border-b border-border sticky top-0 bg-popover z-10">
          <h2
            id="create-employee-title"
            class="m-0 text-base font-semibold text-foreground"
          >
            {editing()
              ? `Edit ${props.employee?.name ?? "employee"}`
              : "New employee"}
          </h2>
          <button
            type="button"
            class="bg-transparent border-none text-muted-foreground text-2xl leading-none cursor-pointer py-1 px-2 rounded transition-all duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50"
            onClick={props.onClose}
            disabled={submitting()}
            title="Close"
            aria-label="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>

        <div class="p-5">
          <Show when={error()}>
            <div
              class="py-2.5 px-3 mb-4 bg-destructive/20 text-destructive rounded text-[13px]"
              role="alert"
            >
              {error()}
            </div>
          </Show>

          {/* Avatar + Name */}
          <div class="flex items-center gap-3 mb-4">
            <div
              class="w-10 h-10 rounded-md flex items-center justify-center text-white font-bold text-base flex-none"
              style={{ background: gradientFor(effectiveSlug() || "_") }}
              aria-hidden="true"
            >
              {initialFor(name() || "?")}
            </div>
            <div class="flex-1 min-w-0">
              <label
                for="employee-name"
                class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
              >
                Name
              </label>
              <input
                id="employee-name"
                ref={nameInputRef}
                type="text"
                class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm transition-colors duration-150 focus:outline-none focus:border-primary"
                value={name()}
                onInput={(e) => {
                  setName(e.currentTarget.value);
                  clearError();
                }}
                placeholder="e.g. Research Assistant"
                disabled={submitting()}
              />
            </div>
          </div>

          {/* Slug */}
          <div class="mb-4">
            <label
              for="employee-slug"
              class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
            >
              Slug
            </label>
            <input
              id="employee-slug"
              type="text"
              class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm font-mono transition-colors duration-150 focus:outline-none focus:border-primary disabled:opacity-60"
              value={effectiveSlug()}
              onInput={(e) => {
                setSlug(deriveSlug(e.currentTarget.value));
                setSlugTouched(true);
                clearError();
              }}
              placeholder="e.g. research-assistant"
              disabled={submitting() || editing()}
              readOnly={editing()}
              aria-describedby="employee-slug-help"
            />
            <div
              id="employee-slug-help"
              class="mt-1 text-[10.5px] text-muted-foreground/80"
            >
              <Show
                when={!editing()}
                fallback="Slug is fixed for the lifetime of the deployment."
              >
                Lowercase letters, numbers, and hyphens. Auto-derived from name
                until edited.
              </Show>
            </div>
          </div>

          {/* Mode */}
          <div class="mb-4">
            <div
              id="employee-mode-label"
              class="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
            >
              What kind of employee?
            </div>
            <div
              class="grid grid-cols-3 gap-2"
              role="radiogroup"
              aria-labelledby="employee-mode-label"
              aria-describedby={editing() ? "employee-mode-help" : undefined}
            >
              <For each={MODES}>
                {(option) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={mode() === option.value}
                    class="text-left p-2.5 rounded-md border bg-card transition-all duration-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    classList={{
                      "border-primary bg-primary/[0.08]":
                        mode() === option.value,
                      "border-border hover:border-border/90 hover:bg-surface-2":
                        mode() !== option.value && !editing(),
                    }}
                    onClick={() => {
                      if (editing()) return;
                      setMode(option.value);
                    }}
                    disabled={submitting() || editing()}
                  >
                    <div class="text-[12.5px] font-semibold text-foreground">
                      {option.title}
                    </div>
                    <div class="text-[10.5px] text-muted-foreground leading-tight mt-0.5">
                      {option.sub}
                    </div>
                  </button>
                )}
              </For>
            </div>
            <Show when={editing()}>
              <div
                id="employee-mode-help"
                class="mt-1.5 text-[10.5px] text-muted-foreground/80"
              >
                Mode is fixed for the lifetime of the deployment.
              </div>
            </Show>
          </div>

          {/* Cron schedule (only when scheduled) */}
          <Show when={mode() === "cron"}>
            <div class="mb-4 grid grid-cols-2 gap-3">
              <div>
                <label
                  for="employee-cron"
                  class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                >
                  Cron schedule
                </label>
                <input
                  id="employee-cron"
                  type="text"
                  class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm font-mono focus:outline-none focus:border-primary"
                  value={cronSchedule()}
                  onInput={(e) => setCronSchedule(e.currentTarget.value)}
                  placeholder="0 * * * *"
                  disabled={submitting()}
                />
              </div>
              <div>
                <label
                  for="employee-tz"
                  class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                >
                  Timezone
                </label>
                <input
                  id="employee-tz"
                  type="text"
                  class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm font-mono focus:outline-none focus:border-primary"
                  value={cronTimezone()}
                  onInput={(e) => setCronTimezone(e.currentTarget.value)}
                  placeholder="UTC"
                  disabled={submitting()}
                />
              </div>
            </div>
          </Show>

          {/* Role / instructions (becomes the SKILL.md section when
              IDENTITY.md or SOUL.md is filled in via Advanced) */}
          <div class="mb-4">
            <label
              for="employee-role"
              class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
            >
              Role / instructions
              <Show when={identity().trim() || soul().trim()}>
                <span class="font-normal opacity-70 normal-case tracking-normal">
                  {" "}
                  (SKILL.md)
                </span>
              </Show>
            </label>
            <textarea
              id="employee-role"
              class="w-full min-h-[110px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
              value={role()}
              onInput={(e) => {
                setRole(e.currentTarget.value);
                clearError();
              }}
              placeholder="Senior advisor with decades of perspective. Calm authority, plain language, and long-horizon thinking."
              disabled={submitting()}
            />
          </div>

          {/* Model */}
          <div class="mb-4">
            <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
              Model
            </div>
            <div
              class="inline-flex bg-card border border-border rounded-md overflow-hidden mb-2"
              role="radiogroup"
              aria-label="Model source"
            >
              <button
                type="button"
                role="radio"
                aria-checked={modelChoice() === "standard"}
                class="px-3 py-1.5 text-[12px] font-medium transition-colors"
                classList={{
                  "bg-primary/[0.12] text-primary":
                    modelChoice() === "standard",
                  "text-muted-foreground hover:text-foreground":
                    modelChoice() !== "standard",
                }}
                onClick={() => setModelChoice("standard")}
                disabled={submitting()}
              >
                Standard
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={modelChoice() === "private"}
                class="px-3 py-1.5 text-[12px] font-medium transition-colors"
                classList={{
                  "bg-primary/[0.12] text-primary": modelChoice() === "private",
                  "text-muted-foreground hover:text-foreground":
                    modelChoice() !== "private",
                }}
                onClick={() => setModelChoice("private")}
                disabled={submitting()}
              >
                Private
              </button>
            </div>

            <Show when={modelChoice() === "standard"}>
              <div
                class="flex gap-1.5 flex-wrap"
                role="radiogroup"
                aria-label="Model speed/quality"
              >
                <For each={POLICIES}>
                  {(option) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={modelPolicy() === option.value}
                      class="px-3 py-1 rounded-full text-[11.5px] font-medium border transition-colors"
                      classList={{
                        "bg-primary/[0.12] border-primary/40 text-primary":
                          modelPolicy() === option.value,
                        "bg-card border-border text-muted-foreground hover:text-foreground":
                          modelPolicy() !== option.value,
                      }}
                      onClick={() => setModelPolicy(option.value)}
                      disabled={submitting()}
                    >
                      {option.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={modelChoice() === "private"}>
              <Show
                when={!privateModels.loading}
                fallback={
                  <div class="text-[12px] text-muted-foreground italic">
                    Loading private models...
                  </div>
                }
              >
                <select
                  class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm focus:outline-none focus:border-primary"
                  value={modelId()}
                  onChange={(e) => setModelId(e.currentTarget.value)}
                  disabled={submitting()}
                >
                  <Show when={(privateModels() ?? []).length === 0}>
                    <option value="">No private models available</option>
                  </Show>
                  <For each={privateModels() ?? []}>
                    {(m) => (
                      <option value={m.model_id}>
                        {m.label}
                        {m.recommended ? " (recommended)" : ""}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
            </Show>
          </div>

          {/* Advanced */}
          <div class="border-t border-border pt-3">
            <button
              type="button"
              class="flex items-center gap-1.5 bg-transparent border-none text-[11.5px] text-muted-foreground hover:text-foreground cursor-pointer p-0"
              aria-expanded={showAdvanced()}
              aria-controls="employee-advanced-panel"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span
                class="inline-block transition-transform"
                classList={{ "rotate-90": showAdvanced() }}
                aria-hidden="true"
              >
                {">"}
              </span>
              Advanced
            </button>

            <Show when={showAdvanced()}>
              <div
                id="employee-advanced-panel"
                class="mt-3 grid grid-cols-2 gap-3"
              >
                <div class="col-span-2">
                  <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
                    Tool presets
                  </div>
                  <div
                    class="flex gap-1.5 flex-wrap"
                    role="group"
                    aria-label="Tool presets"
                  >
                    <For each={TOOL_PRESETS}>
                      {(option) => {
                        const active = () =>
                          toolPresets().includes(option.value);
                        return (
                          <button
                            type="button"
                            aria-pressed={active()}
                            class="px-3 py-1 rounded-full text-[11.5px] font-medium border transition-colors"
                            classList={{
                              "bg-primary/[0.12] border-primary/40 text-primary":
                                active(),
                              "bg-card border-border text-muted-foreground hover:text-foreground":
                                !active(),
                            }}
                            onClick={() => toggleToolPreset(option.value)}
                            disabled={submitting()}
                          >
                            {option.label}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </div>

                <div class="col-span-2">
                  <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
                    Approval policy
                  </div>
                  <div
                    class="inline-flex bg-card border border-border rounded-md overflow-hidden"
                    role="radiogroup"
                    aria-label="Approval policy"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={approvalPolicy() === "read_only"}
                      class="px-3 py-1.5 text-[12px] font-medium transition-colors"
                      classList={{
                        "bg-primary/[0.12] text-primary":
                          approvalPolicy() === "read_only",
                        "text-muted-foreground hover:text-foreground":
                          approvalPolicy() !== "read_only",
                      }}
                      onClick={() => setApprovalPolicy("read_only")}
                      disabled={submitting()}
                    >
                      Read only
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={approvalPolicy() === "allow_mutations"}
                      class="px-3 py-1.5 text-[12px] font-medium transition-colors"
                      classList={{
                        "bg-primary/[0.12] text-primary":
                          approvalPolicy() === "allow_mutations",
                        "text-muted-foreground hover:text-foreground":
                          approvalPolicy() !== "allow_mutations",
                      }}
                      onClick={() => setApprovalPolicy("allow_mutations")}
                      disabled={submitting()}
                    >
                      Allow mutations
                    </button>
                  </div>
                </div>

                <NumField
                  label="Max iterations"
                  value={maxIterations()}
                  onInput={setMaxIterations}
                  disabled={submitting()}
                />
                <NumField
                  label="Max tool calls/run"
                  value={maxToolCalls()}
                  onInput={setMaxToolCalls}
                  disabled={submitting()}
                />
                <NumField
                  label="Timeout (sec)"
                  value={maxTimeout()}
                  onInput={setMaxTimeout}
                  disabled={submitting()}
                />
                <NumField
                  label="Max tool output chars"
                  value={maxToolOutput()}
                  onInput={setMaxToolOutput}
                  disabled={submitting()}
                />
                <NumField
                  label="Context budget tokens"
                  value={contextBudget()}
                  onInput={setContextBudget}
                  disabled={submitting()}
                />

                {/* IDENTITY.md and SOUL.md sit at the bottom of Advanced
                    so frequent toggles (tool presets, approval policy,
                    limits) stay near the top of the tab order. */}
                <div class="col-span-2">
                  <label
                    for="employee-identity"
                    class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                  >
                    IDENTITY.md{" "}
                    <span class="font-normal opacity-70 normal-case tracking-normal">
                      (optional)
                    </span>
                  </label>
                  <textarea
                    id="employee-identity"
                    class="w-full min-h-[90px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
                    value={identity()}
                    onInput={(e) => {
                      setIdentity(e.currentTarget.value);
                      clearError();
                    }}
                    placeholder="Personality, voice, professional background."
                    disabled={submitting()}
                  />
                </div>

                <div class="col-span-2">
                  <label
                    for="employee-soul"
                    class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                  >
                    SOUL.md{" "}
                    <span class="font-normal opacity-70 normal-case tracking-normal">
                      (optional)
                    </span>
                  </label>
                  <textarea
                    id="employee-soul"
                    class="w-full min-h-[90px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
                    value={soul()}
                    onInput={(e) => {
                      setSoul(e.currentTarget.value);
                      clearError();
                    }}
                    placeholder="Values, decision philosophy, deeper convictions."
                    disabled={submitting()}
                  />
                </div>
              </div>
            </Show>
          </div>
        </div>

        <div class="flex justify-end gap-2 py-4 px-5 border-t border-border sticky bottom-0 bg-popover">
          <button
            type="button"
            class="py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={props.onClose}
            disabled={submitting()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-primary text-primary-foreground border border-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSubmit}
            disabled={!canSubmit()}
          >
            {submitting()
              ? editing()
                ? "Saving..."
                : "Deploying..."
              : editing()
                ? "Save changes"
                : "Deploy employee"}
          </button>
        </div>
      </div>
    </div>
  );
};

const NumField: Component<{
  label: string;
  value: number;
  onInput: (n: number) => void;
  disabled?: boolean;
}> = (props) => (
  <label class="block">
    <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
      {props.label}
    </span>
    <input
      type="number"
      min="0"
      class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm font-mono focus:outline-none focus:border-primary"
      value={props.value}
      onInput={(e) => {
        const raw = e.currentTarget.value;
        if (raw === "") return;
        const v = Number(raw);
        if (Number.isFinite(v) && v >= 0) props.onInput(v);
      }}
      disabled={props.disabled}
    />
  </label>
);
