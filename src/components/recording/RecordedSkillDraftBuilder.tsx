// ABOUTME: Turns a pasted assistant draft response into a reviewable skill bundle.
// ABOUTME: Reuses the shared review panel to save/download a recorded skill locally.

import {
  createRecordingSkillDraftReview,
  type RecordingSession,
  type RecordingSkillDraftReview,
} from "@seren/recording-core";
import {
  downloadRecordingSkillBundle,
  RecordingSkillDraftReviewPanel,
} from "@seren/recording-ui";
import { createSignal, Show } from "solid-js";
import { CheckIcon, SparkIcon } from "@/components/recording/icons";
import { saveRecordingSkillDraftAsLocalSkill } from "@/features/recording/recordingSkillBundle";

export function RecordedSkillDraftBuilder(props: {
  session: RecordingSession;
}) {
  const [text, setText] = createSignal("");
  const [review, setReview] = createSignal<RecordingSkillDraftReview | null>(
    null,
  );
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [savedPath, setSavedPath] = createSignal<string | null>(null);

  const buildReview = () => {
    setError(null);
    setSavedPath(null);
    const result = createRecordingSkillDraftReview({
      text: text(),
      session: props.session,
      redactions: [],
    });
    if (!result.review) {
      setReview(null);
      setError(
        result.error ?? "Could not parse a skill draft from that response.",
      );
      return;
    }
    setReview(result.review);
  };

  const save = async (current: RecordingSkillDraftReview) => {
    if (saving()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveRecordingSkillDraftAsLocalSkill(current.draft);
      setSavedPath(saved.path);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the skill.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="flex flex-col gap-2.5 pt-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Paste the assistant's reply
        </span>
        <textarea
          class="min-h-[72px] w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[12px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          value={text()}
          placeholder={
            '{ "title": "...", "steps": [ ... ], "verification": [ ... ] }'
          }
          onInput={(event) => setText(event.currentTarget.value)}
        />
      </label>

      <div class="flex items-center gap-2">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
          disabled={!text().trim()}
          onClick={buildReview}
        >
          <SparkIcon />
          Review draft
        </button>
        <Show when={review()}>
          <span class="text-[10.5px] text-muted-foreground">
            Review below, then save or download the bundle.
          </span>
        </Show>
      </div>

      <Show when={error()}>
        {(message) => (
          <p class="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-600 dark:text-red-400">
            {message()}
          </p>
        )}
      </Show>

      <Show when={review()}>
        {(current) => (
          <RecordingSkillDraftReviewPanel
            review={current()}
            onDownloadBundle={downloadRecordingSkillBundle}
            extraActions={(reviewForActions) => (
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-600 transition-colors hover:bg-emerald-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-50 dark:text-emerald-400"
                disabled={saving() || !reviewForActions.readiness.canPublish}
                title={
                  reviewForActions.readiness.canPublish
                    ? "Save as a local skill"
                    : "Resolve blocking findings before saving"
                }
                onClick={() => void save(reviewForActions)}
              >
                {saving() ? "saving..." : "save skill"}
              </button>
            )}
          />
        )}
      </Show>

      <Show when={savedPath()}>
        {(path) => (
          <p class="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
            <CheckIcon />
            <span class="truncate font-mono">Saved to {path()}</span>
          </p>
        )}
      </Show>
    </div>
  );
}
