// ABOUTME: Modal for publishing a locally-installed skill to Seren Skills.
// ABOUTME: Lets the user choose visibility and an initial version label before pushing.

import {
  type Component,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { InstalledSkill, SkillVisibility } from "@/lib/skills";
import { skills as skillsService } from "@/services/skills";

interface PublishSkillModalProps {
  skill: InstalledSkill;
  onClose: () => void;
  onPublished: () => void;
}

const VISIBILITY_OPTIONS: SkillVisibility[] = ["public", "private", "paid"];
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

export const PublishSkillModal: Component<PublishSkillModalProps> = (props) => {
  const [visibility, setVisibility] = createSignal<SkillVisibility>("private");
  const [version, setVersion] = createSignal("0.1.0");
  const [publishing, setPublishing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const versionInvalid = () => !SEMVER_PATTERN.test(version().trim());

  const handlePublish = async () => {
    if (publishing()) return;
    const trimmedVersion = version().trim();
    if (!SEMVER_PATTERN.test(trimmedVersion)) {
      setError(`Version must be semver (e.g. 0.1.0). Got "${trimmedVersion}".`);
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      await skillsService.publishLocalSkill(props.skill, {
        visibility: visibility(),
        version: trimmedVersion,
      });
      props.onPublished();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPublishing(false);
    }
  };

  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget && !publishing()) {
      props.onClose();
    }
  };

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !publishing()) {
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
      aria-labelledby="publish-skill-title"
    >
      <div class="bg-popover border border-border rounded-lg w-[520px] max-w-[92vw] shadow-xl animate-[slideUp_0.2s_ease-out]">
        <div class="flex justify-between items-center py-4 px-5 border-b border-border">
          <div class="flex flex-col gap-0.5 min-w-0">
            <h2
              id="publish-skill-title"
              class="m-0 text-base font-semibold text-foreground truncate"
            >
              Publish to Seren Skills
            </h2>
            <span class="text-[12px] text-muted-foreground truncate">
              {props.skill.displayName ?? props.skill.name}{" "}
              <span class="text-muted-foreground/60">({props.skill.slug})</span>
            </span>
          </div>
          <button
            type="button"
            class="bg-transparent border-none text-muted-foreground text-2xl leading-none cursor-pointer py-1 px-2 rounded transition-all duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50"
            onClick={props.onClose}
            disabled={publishing()}
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

          <p class="m-0 text-[12px] text-muted-foreground">
            This pushes your local SKILL.md and payload files to Seren Skills as
            a new publisher record. Once published, you can manage visibility or
            delete it from the panel.
          </p>

          <section class="flex flex-col gap-2">
            <header class="flex flex-col gap-0.5">
              <span class="text-[12px] font-medium text-foreground">
                Visibility
              </span>
              <span class="text-[11px] text-muted-foreground">
                You can change this later from the manage screen.
              </span>
            </header>
            <div class="flex gap-1.5 flex-wrap">
              {VISIBILITY_OPTIONS.map((option) => {
                const active = () => visibility() === option;
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
                    onClick={() => setVisibility(option)}
                    disabled={publishing()}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          </section>

          <section class="flex flex-col gap-1.5">
            <label
              for="publish-skill-version"
              class="text-[12px] font-medium text-foreground"
            >
              Initial version
            </label>
            <input
              id="publish-skill-version"
              type="text"
              class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[14px] transition-colors duration-150 focus:outline-none focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed placeholder:text-muted-foreground"
              value={version()}
              onInput={(e) => setVersion(e.currentTarget.value)}
              placeholder="0.1.0"
              disabled={publishing()}
              aria-invalid={versionInvalid()}
            />
            <p class="m-0 text-[11px] text-muted-foreground">
              Semver, e.g. 0.1.0 or 1.0.0-rc.1.
            </p>
          </section>
        </div>

        <div class="flex justify-end gap-2 py-4 px-5 border-t border-border">
          <button
            type="button"
            class="py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={props.onClose}
            disabled={publishing()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-primary text-primary-foreground border border-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handlePublish}
            disabled={publishing() || versionInvalid()}
          >
            {publishing() ? "Publishing..." : "Publish"}
          </button>
        </div>
      </div>
    </div>
  );
};
