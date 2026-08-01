// ABOUTME: Evidence-first findings view with a pinned coverage summary.
// ABOUTME: The single scroll region keeps coverage visible while claims are reviewed.

import { type Component, createSignal, For, Show } from "solid-js";
import type { Finding } from "@/services/run";
import { runStore } from "@/stores/run.store";

export interface RunFindingsProps {
  onReview: (finding: Finding) => void;
}

function confidenceLabel(confidence: Finding["confidence"]): string {
  return confidence.charAt(0).toUpperCase() + confidence.slice(1);
}

export const RunFindings: Component<RunFindingsProps> = (props) => {
  const [coverageExpanded, setCoverageExpanded] = createSignal(false);
  const gaps = () => runStore.coverageGaps();
  const findings = () => runStore.snapshot?.findings ?? [];

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div
        data-testid="coverage-strip"
        class="shrink-0 border-b border-amber-300/20 bg-amber-300/[0.06] px-5 py-3 lg:px-6"
      >
        <button
          type="button"
          class="flex w-full items-center justify-between gap-4 text-left"
          onClick={() => setCoverageExpanded((value) => !value)}
          aria-expanded={coverageExpanded()}
        >
          <span class="min-w-0">
            <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-200">
              Coverage
            </span>
            <span class="ml-3 text-xs text-muted-foreground">
              {gaps().length === 0
                ? "No known gaps"
                : `${gaps().length} gap${gaps().length === 1 ? "" : "s"} · ${gaps()[0].subject}`}
            </span>
          </span>
          <span class="shrink-0 text-[11px] text-amber-200/80">
            {coverageExpanded() ? "Hide" : "Details"}
          </span>
        </button>
        <Show when={coverageExpanded() && gaps().length > 0}>
          <div class="mt-3 space-y-2 border-t border-amber-300/15 pt-3">
            <For each={gaps()}>
              {(gap) => (
                <div class="flex gap-3 text-xs leading-5 text-muted-foreground">
                  <span class="font-mono text-[10px] uppercase text-amber-200/80">
                    {gap.kind}
                  </span>
                  <span class="min-w-0">
                    <span class="text-foreground/85">{gap.subject}</span>
                    {gap.detail ? ` — ${gap.detail}` : ""}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div
        data-testid="findings-scroll"
        class="min-h-0 flex-1 overflow-y-auto px-5 py-5 lg:px-6"
      >
        <Show
          when={findings().length > 0}
          fallback={
            <div class="flex h-full min-h-48 items-center justify-center rounded-xl border border-dashed border-border/70 text-sm text-muted-foreground">
              Findings will appear here as the team verifies its work.
            </div>
          }
        >
          <div class="space-y-4">
            <For each={findings()}>
              {(finding) => (
                <article class="rounded-xl border border-border/75 bg-slate-900/55 p-4 shadow-[0_12px_40px_rgba(2,8,23,0.16)]">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="rounded-full border border-cyan-300/25 bg-cyan-300/[0.08] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-cyan-100">
                        {confidenceLabel(finding.confidence)}
                      </span>
                      <Show
                        when={
                          finding.needs_approval && finding.status === "open"
                        }
                      >
                        <span class="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-amber-100">
                          Needs you
                        </span>
                      </Show>
                    </div>
                    <span class="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                      {finding.status}
                    </span>
                  </div>
                  <h2 class="mt-3 text-base font-medium leading-6 text-foreground">
                    {finding.claim}
                  </h2>

                  <Show when={finding.evidence.length > 0}>
                    <div class="mt-4 space-y-2 border-t border-border/50 pt-3">
                      <div class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        Evidence
                      </div>
                      <For each={finding.evidence}>
                        {(evidence) => (
                          <div class="rounded-lg border border-border/50 bg-slate-950/35 px-3 py-2">
                            <div class="flex items-center gap-2">
                              <span class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-cyan-100/80">
                                {evidence.kind}
                              </span>
                              <code class="min-w-0 truncate font-mono text-[11px] text-cyan-100/75">
                                {evidence.reference}
                              </code>
                            </div>
                            <Show when={evidence.excerpt}>
                              <div class="mt-1 text-xs leading-5 text-muted-foreground">
                                {evidence.excerpt}
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <div class="mt-4 flex items-center justify-between gap-3 border-t border-border/50 pt-3">
                    <span class="text-[11px] text-muted-foreground">
                      Agent evidence · reviewable before action
                    </span>
                    <Show when={finding.proposed_artifact}>
                      <button
                        type="button"
                        class="rounded-lg border border-cyan-300/30 px-3 py-1.5 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-300/10"
                        onClick={() => props.onReview(finding)}
                      >
                        Review artifact
                      </button>
                    </Show>
                  </div>
                </article>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};
