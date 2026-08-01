// ABOUTME: Review dialog for proposed finding artifacts before external action.
// ABOUTME: Approval and rejection use the durable finding-status command path.

import { type Component, For, Show } from "solid-js";
import type { Finding } from "@/services/run";
import { runStore } from "@/stores/run.store";

export interface RunArtifactReviewProps {
  finding: Finding;
  onClose: () => void;
}

export const RunArtifactReview: Component<RunArtifactReviewProps> = (props) => {
  const artifact = () => props.finding.proposed_artifact;
  const isOpen = () => props.finding.status === "open";

  return (
    <div class="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/75 p-5 backdrop-blur-sm">
      <div class="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-cyan-300/25 bg-slate-950 shadow-[0_28px_100px_rgba(2,8,23,0.7)]">
        <div class="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4">
          <div>
            <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/80">
              Artifact review
            </div>
            <h2 class="mt-1 text-base font-medium text-foreground">
              {artifact()?.title ?? "Proposed response"}
            </h2>
          </div>
          <button
            type="button"
            class="text-xs text-muted-foreground hover:text-foreground"
            onClick={props.onClose}
            aria-label="Close artifact review"
          >
            Close
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div class="rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-4">
            <div class="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200">
              Claim
            </div>
            <p class="m-0 mt-2 text-sm leading-6 text-foreground">
              {props.finding.claim}
            </p>
          </div>
          <Show when={props.finding.evidence.length > 0}>
            <div class="mt-4">
              <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Evidence used
              </div>
              <div class="space-y-2">
                <For each={props.finding.evidence}>
                  {(evidence) => (
                    <div class="rounded-lg border border-border/60 bg-slate-900/60 px-3 py-2 text-xs">
                      <code class="font-mono text-cyan-100/80">
                        {evidence.reference}
                      </code>
                      <Show when={evidence.excerpt}>
                        <div class="mt-1 leading-5 text-muted-foreground">
                          {evidence.excerpt}
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <div class="mt-4 rounded-xl border border-border/60 bg-slate-900/60 p-4">
            <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Proposed {artifact()?.kind ?? "artifact"}
            </div>
            <pre class="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-6 text-foreground/90">
              {artifact()?.content ?? "No content was proposed."}
            </pre>
          </div>
        </div>

        <div class="flex items-center justify-between gap-3 border-t border-border/70 px-5 py-4">
          <span class="text-[11px] text-muted-foreground">
            Nothing sends without your approval.
          </span>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded-lg border border-red-300/25 px-3 py-2 text-xs font-medium text-red-200 hover:bg-red-300/10 disabled:opacity-40"
              disabled={!isOpen()}
              onClick={() => {
                void runStore.rejectFinding(props.finding.id);
                props.onClose();
              }}
            >
              Reject
            </button>
            <button
              type="button"
              class="rounded-lg bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-200 disabled:opacity-40"
              disabled={!isOpen()}
              onClick={() => {
                void runStore.approveFinding(props.finding.id);
                props.onClose();
              }}
            >
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
