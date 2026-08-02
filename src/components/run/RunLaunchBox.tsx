// ABOUTME: First-run Mission Control launch surface for a plain-language objective.
// ABOUTME: Keeps the safety boundary visible before a durable run is created.

import { type Component, createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { fileTreeState } from "@/stores/fileTree";
import { launchMission, runStore } from "@/stores/run.store";

export interface RunLaunchBoxProps {
  onStarted?: () => void;
}

const TASK_SLOTS = [0, 1, 2] as const;
const AGENT_TYPES = ["claude-code", "codex", "seren"] as const;
type AgentType = (typeof AGENT_TYPES)[number];

const AGENT_LABELS: Record<AgentType, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  seren: "Seren",
};

const PERMISSION_OPTIONS: Record<
  AgentType,
  ReadonlyArray<{ value: string; label: string }>
> = {
  "claude-code": [
    { value: "", label: "Runtime default" },
    { value: "plan", label: "Plan only" },
    { value: "acceptEdits", label: "Allow workspace edits" },
  ],
  codex: [
    { value: "", label: "Runtime default" },
    { value: "ask", label: "Ask before actions" },
    { value: "auto", label: "Allow workspace edits" },
  ],
  seren: [{ value: "", label: "Review first (fixed)" }],
};

interface LaunchTaskDraft {
  title: string;
  brief: string;
}

export const RunLaunchBox: Component<RunLaunchBoxProps> = (props) => {
  const [objective, setObjective] = createSignal("");
  const [tasks, setTasks] = createStore<LaunchTaskDraft[]>(
    TASK_SLOTS.map(() => ({ title: "", brief: "" })),
  );
  const [agents, setAgents] = createStore<Record<AgentType, boolean>>({
    "claude-code": true,
    codex: true,
    seren: true,
  });
  const [models, setModels] = createStore<Record<AgentType, string>>({
    "claude-code": "",
    codex: "",
    seren: "",
  });
  const [permissions, setPermissions] = createStore<Record<AgentType, string>>({
    "claude-code": "",
    codex: "",
    seren: "",
  });
  const [workspaceMode, setWorkspaceMode] = createSignal<
    "current" | "worktree" | "scratch"
  >("current");
  const [maxAttempts, setMaxAttempts] = createSignal(2);

  const selectedAgentTypes = () =>
    AGENT_TYPES.filter((agentType) => agents[agentType]);

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
        modelId: models[agentType].trim() || null,
        permissionMode: permissions[agentType] || null,
      })),
      workspaceMode: workspaceMode(),
      maxAttempts: maxAttempts(),
    });
    props.onStarted?.();
  };

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

        <details class="mt-5 border-t border-border/50 pt-4">
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

          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <fieldset class="min-w-0 rounded-xl border border-border/50 bg-slate-950/20 p-3">
              <legend class="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Models
              </legend>
              <p class="mt-1 text-[11px] leading-4 text-muted-foreground/75">
                Pin an exact runtime model ID or leave blank for its default.
              </p>
              <div class="mt-3 grid gap-2">
                <For each={selectedAgentTypes()}>
                  {(agentType) => (
                    <label class="grid gap-1.5">
                      <span class="text-[10px] font-medium text-muted-foreground">
                        {AGENT_LABELS[agentType]}
                      </span>
                      <input
                        data-testid={`run-model-${agentType}`}
                        type="text"
                        value={models[agentType]}
                        onInput={(event) =>
                          setModels(agentType, event.currentTarget.value)
                        }
                        placeholder="Runtime default"
                        spellcheck={false}
                        class="min-w-0 rounded-lg border border-border/70 bg-slate-950/60 px-3 py-2 font-mono text-[11px] text-foreground outline-none transition placeholder:font-sans focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10"
                      />
                    </label>
                  )}
                </For>
              </div>
            </fieldset>

            <fieldset class="min-w-0 rounded-xl border border-border/50 bg-slate-950/20 p-3">
              <legend class="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Permissions
              </legend>
              <p class="mt-1 text-[11px] leading-4 text-muted-foreground/75">
                Choose how each local runtime handles workspace actions.
              </p>
              <div class="mt-3 grid gap-2">
                <For each={selectedAgentTypes()}>
                  {(agentType) => (
                    <label class="grid gap-1.5">
                      <span class="text-[10px] font-medium text-muted-foreground">
                        {AGENT_LABELS[agentType]}
                      </span>
                      <select
                        data-testid={`run-permission-${agentType}`}
                        value={permissions[agentType]}
                        disabled={agentType === "seren"}
                        onChange={(event) =>
                          setPermissions(agentType, event.currentTarget.value)
                        }
                        class="min-w-0 rounded-lg border border-border/70 bg-slate-950/60 px-3 py-2 text-xs text-foreground outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        <For each={PERMISSION_OPTIONS[agentType]}>
                          {(option) => (
                            <option value={option.value}>{option.label}</option>
                          )}
                        </For>
                      </select>
                    </label>
                  )}
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

          <div class="mt-4 rounded-xl border border-border/50 bg-slate-950/20 p-3">
            <div class="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Agent types
            </div>
            <div class="grid gap-2 sm:grid-cols-3">
              <For each={AGENT_TYPES}>
                {(agentType) => (
                  <label class="flex items-center gap-2 rounded-lg border border-border/40 bg-slate-950/25 px-3 py-2 text-xs text-muted-foreground transition hover:border-cyan-300/40 hover:text-foreground">
                    <input
                      data-testid={`run-agent-${agentType}`}
                      type="checkbox"
                      checked={agents[agentType]}
                      onChange={(event) =>
                        setAgents(agentType, event.currentTarget.checked)
                      }
                      class="accent-cyan-300"
                    />
                    <span>{agentType}</span>
                  </label>
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
