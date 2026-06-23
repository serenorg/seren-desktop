// ABOUTME: Modal for managing an owned skill's publisher record on Seren Skills.
// ABOUTME: Currently exposes visibility toggling and a destructive "Delete from Seren Skills" action.

import {
  type Component,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  isPublicSkillVisibility,
  isRecordedSkill,
  RecordedSkillPublishAcknowledgement,
} from "@/components/sidebar/RecordedSkillPublishAcknowledgement";
import type { Skill, SkillVisibility } from "@/lib/skills";
import { skills as skillsService } from "@/services/skills";

interface ManageSkillModalProps {
  skill: Skill;
  onClose: () => void;
  onChanged: () => void;
}

const VISIBILITY_OPTIONS: SkillVisibility[] = ["public", "private", "paid"];

export const ManageSkillModal: Component<ManageSkillModalProps> = (props) => {
  const [pendingVisibility, setPendingVisibility] =
    createSignal<SkillVisibility | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [publicPermanentAcknowledged, setPublicPermanentAcknowledged] =
    createSignal(false);
  const [recordingReviewAcknowledged, setRecordingReviewAcknowledged] =
    createSignal(false);

  const currentVisibility = (): SkillVisibility =>
    props.skill.publisher?.visibility ?? "private";
  const requiresRecordingAcknowledgements = () =>
    isRecordedSkill(props.skill) &&
    !isPublicSkillVisibility(currentVisibility());
  const acknowledgementsMissing = () =>
    requiresRecordingAcknowledgements() &&
    (!publicPermanentAcknowledged() || !recordingReviewAcknowledged());
  const needsAcknowledgementForVisibility = (next: SkillVisibility) =>
    requiresRecordingAcknowledgements() &&
    isPublicSkillVisibility(next) &&
    acknowledgementsMissing();

  const handleVisibility = async (next: SkillVisibility) => {
    if (next === currentVisibility() || pendingVisibility() !== null) return;
    if (needsAcknowledgementForVisibility(next)) {
      setError(
        "Acknowledge the recording review and public permanence before changing visibility.",
      );
      return;
    }
    setPendingVisibility(next);
    setError(null);
    try {
      await skillsService.updatePublishedMetadata(props.skill.slug, {
        visibility: next,
      });
      props.onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingVisibility(null);
    }
  };

  const handleDelete = async () => {
    if (deleting()) return;
    setDeleting(true);
    setError(null);
    try {
      await skillsService.deletePublishedSkill(props.skill.slug);
      props.onChanged();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  const isBusy = () => deleting() || pendingVisibility() !== null;

  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget && !isBusy()) {
      props.onClose();
    }
  };

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !isBusy()) {
      event.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    document.addEventListener("keydown", handleDocumentKeydown);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleDocumentKeydown);
  });

  return (
    <div
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_0.15s_ease-out]"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="manage-skill-title"
    >
      <div class="bg-popover border border-border rounded-lg w-[520px] max-w-[92vw] shadow-xl animate-[slideUp_0.2s_ease-out]">
        <div class="flex justify-between items-center py-4 px-5 border-b border-border">
          <div class="flex flex-col gap-0.5 min-w-0">
            <h2
              id="manage-skill-title"
              class="m-0 text-base font-semibold text-foreground truncate"
            >
              Manage on Seren Skills
            </h2>
            <span class="text-[12px] text-muted-foreground truncate">
              {props.skill.displayName ?? props.skill.name}
            </span>
          </div>
          <button
            type="button"
            class="bg-transparent border-none text-muted-foreground text-2xl leading-none cursor-pointer py-1 px-2 rounded transition-all duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50"
            onClick={props.onClose}
            disabled={deleting()}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div class="px-5 py-4 flex flex-col gap-5">
          <Show when={error()}>
            <div class="py-2 px-3 bg-destructive/15 border border-destructive/30 text-destructive rounded text-[13px]">
              {error()}
            </div>
          </Show>

          <section class="flex flex-col gap-2">
            <header class="flex flex-col gap-0.5">
              <span class="text-[12px] font-medium text-foreground">
                Visibility
              </span>
              <span class="text-[11px] text-muted-foreground">
                Controls who can find and install this skill from Seren Skills.
              </span>
            </header>
            <div class="flex gap-1.5 flex-wrap">
              {VISIBILITY_OPTIONS.map((option) => {
                const active = () => currentVisibility() === option;
                const busy = () => pendingVisibility() === option;
                const disabled = () =>
                  pendingVisibility() !== null ||
                  deleting() ||
                  needsAcknowledgementForVisibility(option);
                return (
                  <button
                    type="button"
                    class="px-3 py-1.5 text-[12px] font-medium rounded-md border transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
                    classList={{
                      "bg-primary/[0.12] text-foreground border-primary/30":
                        active(),
                      "bg-transparent text-muted-foreground border-border hover:bg-surface-2":
                        !active(),
                    }}
                    onClick={() => void handleVisibility(option)}
                    disabled={disabled()}
                    title={
                      needsAcknowledgementForVisibility(option)
                        ? "Acknowledge recorded skill review before making this public."
                        : undefined
                    }
                  >
                    {busy() ? `${option}...` : option}
                  </button>
                );
              })}
            </div>
            <Show when={requiresRecordingAcknowledgements()}>
              <RecordedSkillPublishAcknowledgement
                description="This recorded skill is currently private. Review it before making it public or paid."
                reviewAcknowledged={recordingReviewAcknowledged()}
                permanenceAcknowledged={publicPermanentAcknowledged()}
                onReviewAcknowledgedChange={setRecordingReviewAcknowledged}
                onPermanenceAcknowledgedChange={setPublicPermanentAcknowledged}
                disabled={isBusy()}
              />
            </Show>
          </section>

          <section class="flex flex-col gap-2 pt-2 border-t border-border/40">
            <header class="flex flex-col gap-0.5">
              <span class="text-[12px] font-medium text-destructive">
                Delete from Seren Skills
              </span>
              <span class="text-[11px] text-muted-foreground">
                Removes the publisher record and all of its versions. Anyone who
                installed it locally keeps their copy. This is separate from
                uninstalling your local files.
              </span>
            </header>
            <Show
              when={confirmDelete()}
              fallback={
                <button
                  type="button"
                  class="self-start px-3 py-1.5 bg-transparent border border-destructive/40 text-destructive rounded-md text-[12px] cursor-pointer transition-colors hover:bg-destructive/10 disabled:opacity-50"
                  onClick={() => setConfirmDelete(true)}
                  disabled={deleting() || pendingVisibility() !== null}
                >
                  Delete from Seren Skills
                </button>
              }
            >
              <div class="flex flex-col gap-2 px-3 py-2.5 bg-destructive/10 border border-destructive/30 rounded-md">
                <span class="text-[12px] text-destructive">
                  This permanently removes the skill from Seren Skills. Are you
                  sure?
                </span>
                <div class="flex gap-2">
                  <button
                    type="button"
                    class="px-3 py-1.5 bg-destructive text-white rounded-md text-[12px] font-medium cursor-pointer transition-colors hover:bg-red-500 disabled:opacity-50"
                    onClick={() => void handleDelete()}
                    disabled={deleting()}
                  >
                    {deleting() ? "Deleting..." : "Yes, delete"}
                  </button>
                  <button
                    type="button"
                    class="px-3 py-1.5 bg-transparent border border-border text-muted-foreground rounded-md text-[12px] cursor-pointer transition-colors hover:bg-surface-2"
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting()}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </Show>
          </section>
        </div>

        <div class="flex justify-end gap-2 py-4 px-5 border-t border-border">
          <button
            type="button"
            class="py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={props.onClose}
            disabled={deleting()}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
