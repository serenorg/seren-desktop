// ABOUTME: Shared five-action footer for approval surfaces: approve once, approve for
// ABOUTME: this task with editable limits, deny, skip action, and stop task.

import { type Component, createSignal, Show } from "solid-js";

/** Requested lease lifetimes the editor offers, in hours. */
const DURATION_CHOICES_HOURS = [1, 4, 8, 24];

const DEFAULT_DURATION_HOURS = 4;
const DEFAULT_MAX_CALLS = 100;

interface ApprovalActionsProps {
  isProcessing: boolean;
  /** Label for the one-shot approve button (may name the sending account). */
  approveOnceLabel: string;
  approveDisabled?: boolean;
  /** Human summary of what an approve-for-this-task lease will cover. */
  leaseSummary: string;
  onApproveOnce: () => void;
  onApproveForTask: (durationSecs: number, maxCalls: number) => void;
  onDeny: () => void;
  onSkip: () => void;
  onStopTask: () => void;
}

/**
 * The five decisions every approval surface offers (#3193 §7). "Approve for
 * this task" expands an inline editor for the lease's requested duration and
 * call budget before granting, so the user reviews the limits they hand out.
 */
export const ApprovalActions: Component<ApprovalActionsProps> = (props) => {
  const [showLeaseEditor, setShowLeaseEditor] = createSignal(false);
  const [durationHours, setDurationHours] = createSignal(
    DEFAULT_DURATION_HOURS,
  );
  const [maxCalls, setMaxCalls] = createSignal(DEFAULT_MAX_CALLS);

  const secondaryButton =
    "px-4 py-2.5 text-[0.9rem] font-medium rounded-md cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-surface-1 hover:border-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed";

  const grantLease = () => {
    const calls = Math.max(1, Math.floor(maxCalls()));
    props.onApproveForTask(durationHours() * 3600, calls);
  };

  return (
    <div class="border-t border-border">
      <Show when={showLeaseEditor()}>
        <div class="px-6 py-4 border-b border-border bg-surface-1/50 flex flex-col gap-3">
          <span class="text-[0.9rem] text-foreground">
            Allow <strong>{props.leaseSummary}</strong> to run without further
            prompts for this task, within these limits:
          </span>
          <div class="flex items-center gap-4 flex-wrap">
            <label class="flex items-center gap-2 text-[0.85rem] text-muted-foreground">
              Duration
              <select
                class="bg-surface-1 border border-border rounded-md px-2 py-1.5 text-foreground"
                value={durationHours()}
                onChange={(event) =>
                  setDurationHours(Number(event.currentTarget.value))
                }
                disabled={props.isProcessing}
              >
                {DURATION_CHOICES_HOURS.map((hours) => (
                  <option value={hours}>{hours}h</option>
                ))}
              </select>
            </label>
            <label class="flex items-center gap-2 text-[0.85rem] text-muted-foreground">
              Max calls
              <input
                type="number"
                min="1"
                class="bg-surface-1 border border-border rounded-md px-2 py-1.5 text-foreground w-24"
                value={maxCalls()}
                onInput={(event) =>
                  setMaxCalls(Number(event.currentTarget.value))
                }
                disabled={props.isProcessing}
              />
            </label>
            <button
              type="button"
              class="px-4 py-2 text-[0.9rem] font-medium rounded-md cursor-pointer transition-all duration-150 bg-accent text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
              onClick={grantLease}
              disabled={props.isProcessing || props.approveDisabled}
            >
              Grant &amp; approve
            </button>
          </div>
          <span class="text-[0.8rem] text-muted-foreground">
            You can inspect or revoke this lease at any time from the thread's
            capability panel.
          </span>
        </div>
      </Show>

      <div class="px-6 py-4 flex gap-2 items-center flex-wrap">
        <button
          type="button"
          class="px-4 py-2.5 text-[0.9rem] font-medium rounded-md cursor-pointer transition-all duration-150 bg-transparent text-destructive border border-destructive/40 hover:bg-destructive/10 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => props.onStopTask()}
          disabled={props.isProcessing}
          title="Deny this action and stop the whole task"
        >
          Stop task
        </button>
        <div class="flex gap-2 ml-auto flex-wrap justify-end">
          <button
            type="button"
            class={secondaryButton}
            onClick={() => props.onSkip()}
            disabled={props.isProcessing}
            title="Continue the task without this action"
          >
            Skip action
          </button>
          <button
            type="button"
            class={secondaryButton}
            onClick={() => props.onDeny()}
            disabled={props.isProcessing}
            title="Deny this action; the agent adapts and continues"
          >
            Deny
          </button>
          <button
            type="button"
            class={secondaryButton}
            onClick={() => setShowLeaseEditor((open) => !open)}
            disabled={props.isProcessing || props.approveDisabled}
            title="Pre-approve matching actions for this task, with limits you set"
          >
            Approve for this task…
          </button>
          <button
            type="button"
            class="px-5 py-2.5 text-[0.9rem] font-medium border-none rounded-md cursor-pointer transition-all duration-150 bg-accent text-primary-foreground hover:bg-primary/85 hover:shadow-[var(--glow-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => props.onApproveOnce()}
            disabled={props.isProcessing || props.approveDisabled}
          >
            {props.approveOnceLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ApprovalActions;
