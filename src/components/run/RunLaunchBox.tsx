// ABOUTME: First-run Mission Control launch surface for a plain-language objective.
// ABOUTME: Keeps the safety boundary visible before a durable run is created.

import { type Component, createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { ProviderIcon } from "@/components/chat/ProviderIcon";
import {
  createEmptyMissionModelCatalogs,
  loadMissionModelCatalog,
  MISSION_AGENT_DEFINITIONS,
  MISSION_AGENT_TYPES,
  MISSION_MODEL_TARGETS,
  MISSION_PERMISSION_OPTIONS,
  type MissionAgentType,
  type MissionModelCatalog,
  type MissionModelTarget,
  missionAgentAllowed,
  missionAgentRequiresSignIn,
} from "@/services/mission-agent-catalog";
import { authStore } from "@/stores/auth.store";
import { fileTreeState } from "@/stores/fileTree";
import { launchMission, runStore } from "@/stores/run.store";

export interface RunLaunchBoxProps {
  onStarted?: () => void;
}

const TASK_SLOTS = [0, 1, 2] as const;

function recordFromValues<T extends string, V>(
  values: readonly T[],
  makeValue: (value: T) => V,
): Record<T, V> {
  return Object.fromEntries(
    values.map((value) => [value, makeValue(value)]),
  ) as Record<T, V>;
}

interface LaunchTaskDraft {
  title: string;
  brief: string;
}

export const RunLaunchBox: Component<RunLaunchBoxProps> = (props) => {
  const [objective, setObjective] = createSignal("");
  const [tasks, setTasks] = createStore<LaunchTaskDraft[]>(
    TASK_SLOTS.map(() => ({ title: "", brief: "" })),
  );
  const [agents, setAgents] = createStore<Record<MissionAgentType, boolean>>(
    recordFromValues(MISSION_AGENT_TYPES, (agentType) => {
      const definition = MISSION_AGENT_DEFINITIONS.find(
        (candidate) => candidate.id === agentType,
      );
      return Boolean(
        definition?.defaultSelected &&
          (!missionAgentRequiresSignIn(agentType) || authStore.isAuthenticated),
      );
    }),
  );
  const [models, setModels] = createStore<Record<MissionModelTarget, string>>(
    recordFromValues(MISSION_MODEL_TARGETS, () => ""),
  );
  const [modelCatalogs, setModelCatalogs] = createStore<
    Record<MissionModelTarget, MissionModelCatalog>
  >(createEmptyMissionModelCatalogs());
  const [catalogsLoading, setCatalogsLoading] = createSignal(false);
  const [permissions, setPermissions] = createStore<
    Record<MissionAgentType, string>
  >(recordFromValues(MISSION_AGENT_TYPES, () => ""));
  const [workspaceMode, setWorkspaceMode] = createSignal<
    "current" | "worktree" | "scratch"
  >("current");
  const [maxAttempts, setMaxAttempts] = createSignal(2);

  let loadedCatalogAuthState: boolean | null = null;

  const agentDefinition = (agentType: MissionAgentType) => {
    const definition = MISSION_AGENT_DEFINITIONS.find(
      (definition) => definition.id === agentType,
    );
    if (!definition) throw new Error(`Unknown mission agent: ${agentType}`);
    return definition;
  };
  const agentAllowed = (agentType: MissionAgentType) =>
    missionAgentAllowed(agentType, authStore.privateChatPolicy);
  const agentSelectable = (agentType: MissionAgentType) =>
    agentAllowed(agentType) &&
    (!missionAgentRequiresSignIn(agentType) || authStore.isAuthenticated);
  const selectedAgentTypes = () =>
    MISSION_AGENT_TYPES.filter(
      (agentType) => agents[agentType] && agentSelectable(agentType),
    );

  const loadModelCatalogs = async () => {
    if (
      loadedCatalogAuthState === authStore.isAuthenticated &&
      MISSION_MODEL_TARGETS.some(
        (target) => modelCatalogs[target].models.length > 0,
      )
    ) {
      return;
    }
    setCatalogsLoading(true);
    loadedCatalogAuthState = authStore.isAuthenticated;
    try {
      await Promise.all(
        MISSION_MODEL_TARGETS.map(async (target) => {
          setModelCatalogs(target, await loadMissionModelCatalog(target));
        }),
      );
    } finally {
      setCatalogsLoading(false);
    }
  };

  const selectedModelDescription = (target: MissionModelTarget) => {
    const selected = models[target];
    if (!selected) return modelCatalogs[target].note;
    return (
      modelCatalogs[target].models.find((model) => model.id === selected)
        ?.description ?? selected
    );
  };

  const start = async () => {
    const value = objective().trim();
    if (!value) return;
    await launchMission({
      objective: value,
      rootPath: fileTreeState.rootPath,
      tasks: tasks
        .filter((task) => task.title.trim())
        .map((task) => ({
          title: task.title.trim(),
          brief: task.brief.trim(),
        })),
      agents: selectedAgentTypes().map((agentType) => ({
        agentType,
        modelId:
          agentType === "claude-codex"
            ? models["claude-codex:planner"] || null
            : models[agentType] || null,
        secondaryModelId:
          agentType === "claude-codex"
            ? models["claude-codex:executor"] || null
            : null,
        permissionMode: permissions[agentType] || null,
      })),
      workspaceMode: workspaceMode(),
      maxAttempts: maxAttempts(),
    });
    props.onStarted?.();
  };

  const ModelPicker: Component<{
    target: MissionModelTarget;
    label: string;
    testId: string;
  }> = (pickerProps) => (
    <label class="grid min-w-0 gap-1.5">
      <span class="text-[10px] font-medium text-muted-foreground">
        {pickerProps.label}
      </span>
      <select
        data-testid={pickerProps.testId}
        value={models[pickerProps.target]}
        onChange={(event) =>
          setModels(pickerProps.target, event.currentTarget.value)
        }
        class="min-w-0 rounded-lg border border-border/70 bg-slate-950/60 px-3 py-2 text-xs text-foreground outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10"
      >
        <option value="">System default</option>
        <For each={modelCatalogs[pickerProps.target].models}>
          {(model) => <option value={model.id}>{model.name}</option>}
        </For>
      </select>
      <Show when={selectedModelDescription(pickerProps.target)}>
        {(description) => (
          <span class="text-[10px] leading-4 text-muted-foreground/65">
            {description()}
          </span>
        )}
      </Show>
    </label>
  );

  return (
    <div class="mx-auto flex w-full max-w-2xl flex-col justify-center px-8 py-12">
      <div class="mb-8">
        <div class="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-300/75">
          <span class="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,0.85)]" />
          Mission control
        </div>
        <h1 class="m-0 text-3xl font-semibold tracking-[-0.04em] text-foreground">
          What should Seren investigate?
        </h1>
        <p class="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
          Give the team a question with a useful finish line. Seren will keep
          work, evidence, and anything needing your approval in one place.
        </p>
      </div>

      <div class="rounded-2xl border border-cyan-300/20 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.13),transparent_42%),rgba(15,23,42,0.7)] p-5 shadow-[0_24px_80px_rgba(2,8,23,0.35)]">
        <label
          for="mission-objective"
          class="mb-2 block text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
        >
          Objective
        </label>
        <textarea
          id="mission-objective"
          data-testid="run-objective"
          rows="4"
          value={objective()}
          onInput={(event) => setObjective(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              void start();
            }
          }}
          placeholder="Example: Find the source of the billing mismatch and prepare a reviewable reply."
          class="w-full resize-none rounded-xl border border-border/80 bg-slate-950/45 px-4 py-3 text-sm leading-6 text-foreground outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10"
        />

        <div class="mt-5 grid gap-4 border-t border-border/50 pt-4 sm:grid-cols-2">
          <div>
            <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-300/80">
              Seren will
            </div>
            <ul class="m-0 space-y-2 p-0 text-xs leading-5 text-muted-foreground">
              <li>Break the objective into observable work.</li>
              <li>Show evidence and coverage gaps as they appear.</li>
              <li>Pause before anything external is sent or changed.</li>
            </ul>
          </div>
          <div>
            <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-300/80">
              It will not
            </div>
            <ul class="m-0 space-y-2 p-0 text-xs leading-5 text-muted-foreground">
              <li>Invent evidence for a blocked source.</li>
              <li>Hide a failed check behind a green status.</li>
              <li>Send a draft without your approval.</li>
            </ul>
          </div>
        </div>

        <details
          class="mt-5 border-t border-border/50 pt-4"
          onToggle={(event) => {
            if (event.currentTarget.open) void loadModelCatalogs();
          }}
        >
          <summary class="cursor-pointer text-xs font-medium text-muted-foreground transition hover:text-foreground">
            Advanced controls
          </summary>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <label class="grid gap-2 rounded-xl border border-border/50 bg-slate-950/20 p-3">
              <span class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Isolation
              </span>
              <select
                data-testid="run-isolation-mode"
                value={workspaceMode()}
                onChange={(event) =>
                  setWorkspaceMode(
                    event.currentTarget.value as
                      | "current"
                      | "worktree"
                      | "scratch",
                  )
                }
                class="rounded-lg border border-border/70 bg-slate-950/60 px-3 py-2 text-xs text-foreground outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10"
              >
                <option value="current">Current project</option>
                <option value="worktree">Worktree per task</option>
                <option value="scratch">Scratch directory per task</option>
              </select>
              <span class="text-[11px] leading-4 text-muted-foreground/75">
                {workspaceMode() === "worktree"
                  ? "Each task gets an isolated Git branch and worktree."
                  : workspaceMode() === "scratch"
                    ? "Each task starts in a separate empty workspace."
                    : "Agents share the currently open project."}
              </span>
            </label>

            <label class="grid gap-2 rounded-xl border border-border/50 bg-slate-950/20 p-3">
              <span class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Attempt budget
              </span>
              <select
                data-testid="run-max-attempts"
                value={maxAttempts()}
                onChange={(event) =>
                  setMaxAttempts(Number(event.currentTarget.value))
                }
                class="rounded-lg border border-border/70 bg-slate-950/60 px-3 py-2 text-xs text-foreground outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10"
              >
                <option value="1">1 attempt per task</option>
                <option value="2">2 attempts per task</option>
                <option value="3">3 attempts per task</option>
              </select>
              <span class="text-[11px] leading-4 text-muted-foreground/75">
                Failed tasks rotate across selected agents until this cap.
              </span>
            </label>
          </div>

          <fieldset class="mt-4 min-w-0 rounded-xl border border-border/50 bg-slate-950/20 p-3">
            <legend class="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Agent types
            </legend>
            <p class="mt-1 text-[11px] leading-4 text-muted-foreground/75">
              Choose the runtimes that may take a turn. Claude, Codex, and Seren
              are selected by default when available; additional agents are
              opt-in.
            </p>
            <div class="mt-3 grid gap-2 sm:grid-cols-2">
              <For each={MISSION_AGENT_DEFINITIONS}>
                {(definition) => {
                  const disabled = () => !agentSelectable(definition.id);
                  const disabledReason = () =>
                    !agentAllowed(definition.id)
                      ? "Blocked by organization policy"
                      : missionAgentRequiresSignIn(definition.id) &&
                          !authStore.isAuthenticated
                        ? "Sign in to use this agent"
                        : definition.description;
                  return (
                    <label
                      class="flex min-w-0 items-center gap-3 rounded-lg border border-border/40 bg-slate-950/25 px-3 py-2.5 text-muted-foreground transition hover:border-cyan-300/40 hover:text-foreground"
                      classList={{
                        "border-cyan-300/35 bg-cyan-300/[0.06]":
                          agents[definition.id] && !disabled(),
                        "cursor-not-allowed opacity-45": disabled(),
                        "cursor-pointer": !disabled(),
                      }}
                    >
                      <input
                        data-testid={`run-agent-${definition.id}`}
                        type="checkbox"
                        checked={agents[definition.id] && !disabled()}
                        disabled={disabled()}
                        onChange={(event) =>
                          setAgents(definition.id, event.currentTarget.checked)
                        }
                        class="accent-cyan-300"
                      />
                      <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/55 text-foreground">
                        <ProviderIcon
                          provider={definition.id}
                          size={definition.id === "claude-codex" ? 22 : 18}
                          label={`${definition.label} logo`}
                        />
                      </span>
                      <span class="min-w-0">
                        <span class="block truncate text-xs font-medium text-foreground">
                          {definition.label}
                        </span>
                        <span class="block truncate text-[10px] leading-4 text-muted-foreground/70">
                          {disabledReason()}
                        </span>
                      </span>
                    </label>
                  );
                }}
              </For>
            </div>
          </fieldset>

          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <fieldset class="min-w-0 rounded-xl border border-border/50 bg-slate-950/20 p-3">
              <legend class="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Models
              </legend>
              <div class="flex items-start justify-between gap-3">
                <p class="mt-1 text-[11px] leading-4 text-muted-foreground/75">
                  Pick a named model or let each runtime use its system default.
                </p>
                <Show when={catalogsLoading()}>
                  <span class="mt-1 shrink-0 text-[10px] text-cyan-200/65">
                    Loading…
                  </span>
                </Show>
              </div>
              <div class="mt-3 grid gap-3">
                <For each={selectedAgentTypes()}>
                  {(agentType) => (
                    <Show
                      when={agentType === "claude-codex"}
                      fallback={
                        <ModelPicker
                          target={
                            agentType as Exclude<
                              MissionAgentType,
                              "claude-codex"
                            >
                          }
                          label={agentDefinition(agentType).label}
                          testId={`run-model-${agentType}`}
                        />
                      }
                    >
                      <div class="grid gap-2 rounded-lg border border-border/35 bg-background/20 p-2.5">
                        <div class="flex items-center gap-2 text-[10px] font-medium text-muted-foreground">
                          <ProviderIcon provider="claude-codex" size={16} />
                          Claude + Codex
                        </div>
                        <ModelPicker
                          target="claude-codex:planner"
                          label="Planner · Claude"
                          testId="run-model-claude-codex-planner"
                        />
                        <ModelPicker
                          target="claude-codex:executor"
                          label="Executor · Codex"
                          testId="run-model-claude-codex-executor"
                        />
                      </div>
                    </Show>
                  )}
                </For>
              </div>
            </fieldset>

            <fieldset class="min-w-0 rounded-xl border border-border/50 bg-slate-950/20 p-3">
              <legend class="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Permissions
              </legend>
              <p class="mt-1 text-[11px] leading-4 text-muted-foreground/75">
                Choose how each runtime handles workspace actions.
              </p>
              <div class="mt-3 grid gap-3">
                <For each={selectedAgentTypes()}>
                  {(agentType) => {
                    const fixed = () =>
                      agentType === "seren" || agentType === "seren-private";
                    return (
                      <label class="grid gap-1.5">
                        <span class="flex items-center gap-2 text-[10px] font-medium text-muted-foreground">
                          <ProviderIcon provider={agentType} size={13} />
                          {agentDefinition(agentType).label}
                        </span>
                        <select
                          data-testid={`run-permission-${agentType}`}
                          value={permissions[agentType]}
                          disabled={fixed()}
                          onChange={(event) =>
                            setPermissions(agentType, event.currentTarget.value)
                          }
                          class="min-w-0 rounded-lg border border-border/70 bg-slate-950/60 px-3 py-2 text-xs text-foreground outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-55"
                        >
                          <For each={MISSION_PERMISSION_OPTIONS[agentType]}>
                            {(option) => (
                              <option value={option.value}>
                                {option.label}
                              </option>
                            )}
                          </For>
                        </select>
                      </label>
                    );
                  }}
                </For>
              </div>
            </fieldset>
          </div>

          <div class="mt-4 rounded-xl border border-border/50 bg-slate-950/20 p-3">
            <div class="mb-3 flex items-baseline justify-between gap-3">
              <div>
                <div class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Tasks
                </div>
                <p class="mt-1 text-[11px] leading-5 text-muted-foreground/80">
                  Add up to three concrete work items. Empty rows are ignored.
                </p>
              </div>
              <span class="font-mono text-[10px] text-cyan-200/60">0–3</span>
            </div>
            <div class="grid gap-3">
              <For each={TASK_SLOTS}>
                {(slot) => (
                  <div class="grid gap-2 rounded-lg border border-border/40 bg-slate-950/25 p-3">
                    <label
                      for={`run-task-title-${slot}`}
                      class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                    >
                      Task {slot + 1}
                    </label>
                    <input
                      id={`run-task-title-${slot}`}
                      data-testid={`run-task-title-${slot}`}
                      type="text"
                      value={tasks[slot].title}
                      onInput={(event) =>
                        setTasks(slot, "title", event.currentTarget.value)
                      }
                      placeholder="Short task title"
                      class="rounded-lg border border-border/70 bg-slate-950/45 px-3 py-2 text-xs text-foreground outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10"
                    />
                    <textarea
                      id={`run-task-brief-${slot}`}
                      data-testid={`run-task-brief-${slot}`}
                      rows="2"
                      value={tasks[slot].brief}
                      onInput={(event) =>
                        setTasks(slot, "brief", event.currentTarget.value)
                      }
                      placeholder="What should this task establish?"
                      class="resize-none rounded-lg border border-border/70 bg-slate-950/45 px-3 py-2 text-xs leading-5 text-foreground outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10"
                    />
                  </div>
                )}
              </For>
            </div>
          </div>
        </details>

        <div class="mt-5 flex items-center justify-between gap-3">
          <span class="text-[11px] text-muted-foreground/70">
            ⌘/Ctrl + Enter to start
          </span>
          <button
            type="button"
            data-testid="run-launch-start"
            onClick={() => void start()}
            disabled={
              !objective().trim() ||
              selectedAgentTypes().length === 0 ||
              runStore.launchPending
            }
            class="rounded-lg bg-cyan-300 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {runStore.launchPending ? "Starting…" : "Start mission"}
          </button>
        </div>
        <Show when={runStore.error}>
          <div class="mt-3 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs text-red-200">
            {runStore.error}
          </div>
        </Show>
      </div>
    </div>
  );
};
