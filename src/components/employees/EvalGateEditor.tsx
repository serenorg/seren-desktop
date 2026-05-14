// ABOUTME: Inline editor for an employee's eval gate (set, freshness, blocking, schedule).
// ABOUTME: Operators can attach, edit, or clear the gate; schedule is optional and additive.

import { type Component, createSignal, Match, Show, Switch } from "solid-js";
import type { EvalGateWithSchedule } from "@/lib/employees/types";
import {
  clearEvalGate,
  type EvalGateInput,
  updateEvalGate,
  validateCronExpression,
} from "@/services/eval-gate";

interface EvalGateEditorProps {
  deploymentId: string;
  initial: EvalGateWithSchedule | null;
  onSaved: () => void;
  onCancel?: () => void;
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "error"; message: string };

export const EvalGateEditor: Component<EvalGateEditorProps> = (props) => {
  const [setId, setSetId] = createSignal(props.initial?.set_id ?? "");
  const [maxAge, setMaxAge] = createSignal<number>(
    props.initial?.max_age_seconds ?? 86400,
  );
  const [blockOnFailure, setBlockOnFailure] = createSignal<boolean>(
    props.initial?.block_on_failure === true,
  );
  const [scheduleEnabled, setScheduleEnabled] = createSignal<boolean>(
    Boolean(props.initial?.schedule),
  );
  const [cron, setCron] = createSignal(props.initial?.schedule?.cron ?? "");
  const [timezone, setTimezone] = createSignal(
    props.initial?.schedule?.timezone ?? "",
  );
  const [saveState, setSaveState] = createSignal<SaveState>({ kind: "idle" });

  const cronError = (): string | null => {
    if (!scheduleEnabled()) return null;
    return validateCronExpression(cron());
  };

  const isPending = () => saveState().kind === "saving";

  const handleSave = async () => {
    const trimmedSet = setId().trim();
    if (trimmedSet.length === 0) {
      setSaveState({ kind: "error", message: "Eval set id is required." });
      return;
    }
    if (!Number.isFinite(maxAge()) || maxAge() <= 0) {
      setSaveState({
        kind: "error",
        message: "Max age must be a positive number of seconds.",
      });
      return;
    }
    if (scheduleEnabled()) {
      const err = validateCronExpression(cron());
      if (err) {
        setSaveState({ kind: "error", message: err });
        return;
      }
    }
    const body: EvalGateInput = {
      set_id: trimmedSet,
      max_age_seconds: Math.floor(maxAge()),
      block_on_failure: blockOnFailure(),
    };
    if (scheduleEnabled()) {
      const tz = timezone().trim();
      body.schedule = {
        cron: cron().trim(),
        ...(tz.length > 0 ? { timezone: tz } : {}),
      };
    } else if (props.initial?.schedule) {
      // Operator deliberately removed an existing schedule; send null so the
      // backend drops it rather than treating "absent" as "keep current".
      body.schedule = null;
    }
    setSaveState({ kind: "saving" });
    try {
      await updateEvalGate(props.deploymentId, body);
      setSaveState({ kind: "idle" });
      props.onSaved();
    } catch (err) {
      setSaveState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleClear = async () => {
    setSaveState({ kind: "saving" });
    try {
      await clearEvalGate(props.deploymentId);
      setSaveState({ kind: "idle" });
      props.onSaved();
    } catch (err) {
      setSaveState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div class="border border-border rounded-md px-4 py-3 bg-card">
      <div class="text-[12px] font-semibold text-foreground mb-3">
        Eval gate
      </div>
      <div class="grid gap-3">
        <label class="grid gap-1">
          <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
            Eval set id
          </span>
          <input
            class="px-2 py-1 rounded border border-border bg-background text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            type="text"
            value={setId()}
            onInput={(e) => setSetId(e.currentTarget.value)}
            disabled={isPending()}
            placeholder="eval-set-slug"
            data-testid="eval-set-id"
          />
        </label>
        <label class="grid gap-1">
          <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
            Freshness window (seconds)
          </span>
          <input
            class="px-2 py-1 rounded border border-border bg-background text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            type="number"
            min="1"
            step="1"
            value={maxAge()}
            onInput={(e) => setMaxAge(Number(e.currentTarget.value))}
            disabled={isPending()}
            data-testid="eval-max-age"
          />
        </label>
        <label class="flex items-start gap-2 text-[12.5px] text-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            class="mt-[2px] cursor-pointer"
            checked={blockOnFailure()}
            onChange={(e) => setBlockOnFailure(e.currentTarget.checked)}
            disabled={isPending()}
            data-testid="eval-block-on-failure"
          />
          <span>
            Block apply when the eval run fails
            <span class="block text-[11px] text-muted-foreground/80 mt-0.5">
              Unchecked, failures only warn; checked, they reject apply.
            </span>
          </span>
        </label>
        <label class="flex items-start gap-2 text-[12.5px] text-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            class="mt-[2px] cursor-pointer"
            checked={scheduleEnabled()}
            onChange={(e) => setScheduleEnabled(e.currentTarget.checked)}
            disabled={isPending()}
            data-testid="eval-schedule-enabled"
          />
          <span>
            Run eval on a schedule
            <span class="block text-[11px] text-muted-foreground/80 mt-0.5">
              Adds a cron-driven background run alongside on-apply gating.
            </span>
          </span>
        </label>
        <Show when={scheduleEnabled()}>
          <div class="grid gap-2 pl-6 border-l border-border">
            <label class="grid gap-1">
              <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                Cron expression
              </span>
              <input
                class="px-2 py-1 rounded border border-border bg-background text-[13px] text-foreground font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                type="text"
                value={cron()}
                onInput={(e) => setCron(e.currentTarget.value)}
                disabled={isPending()}
                placeholder="0 * * * *"
                data-testid="eval-cron"
              />
              <Show when={cronError()}>
                {(msg) => (
                  <span class="text-[11px] text-destructive">{msg()}</span>
                )}
              </Show>
            </label>
            <label class="grid gap-1">
              <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                Timezone (optional)
              </span>
              <input
                class="px-2 py-1 rounded border border-border bg-background text-[13px] text-foreground font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                type="text"
                value={timezone()}
                onInput={(e) => setTimezone(e.currentTarget.value)}
                disabled={isPending()}
                placeholder="UTC"
                data-testid="eval-timezone"
              />
            </label>
          </div>
        </Show>
      </div>
      <Switch>
        <Match when={saveState().kind === "error"}>
          <div
            class="mt-3 rounded border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive"
            role="alert"
          >
            {(saveState() as { message: string }).message}
          </div>
        </Match>
      </Switch>
      <div class="mt-4 flex items-center justify-between gap-2">
        <Show when={props.initial}>
          <button
            type="button"
            class="py-1.5 px-3 rounded text-[12px] font-medium border border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-50"
            onClick={() => void handleClear()}
            disabled={isPending()}
            data-testid="eval-clear"
          >
            Remove gate
          </button>
        </Show>
        <div class="ml-auto flex items-center gap-2">
          <Show when={props.onCancel}>
            <button
              type="button"
              class="py-1.5 px-3 rounded text-[12px] font-medium bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50"
              onClick={() => props.onCancel?.()}
              disabled={isPending()}
            >
              Cancel
            </button>
          </Show>
          <button
            type="button"
            class="py-1.5 px-3 rounded text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => void handleSave()}
            disabled={
              isPending() || (scheduleEnabled() && cronError() !== null)
            }
            data-testid="eval-save"
          >
            {isPending() ? "Saving..." : "Save eval gate"}
          </button>
        </div>
      </div>
    </div>
  );
};
