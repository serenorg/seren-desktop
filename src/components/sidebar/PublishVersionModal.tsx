// ABOUTME: Modal for pushing a new version of an already-published skill.
// ABOUTME: Auto-suggests the next semver patch and accepts an optional changelog.

import {
  type Component,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { InstalledSkill } from "@/lib/skills";
import { skills as skillsService } from "@/services/skills";

interface PublishVersionModalProps {
  skill: InstalledSkill;
  /**
   * Current published version, used to suggest the next bump. When unknown
   * the modal falls back to "0.1.1" so the user has a starting point.
   */
  currentVersion?: string;
  onClose: () => void;
  onPublished: () => void;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

/**
 * Bump the patch component of a semver string ("1.2.3" -> "1.2.4"). Falls
 * back to a sensible default when the input is missing or unparseable so
 * the user always sees a valid suggestion.
 */
function suggestNextVersion(current: string | undefined): string {
  if (!current) return "0.1.1";
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return "0.1.1";
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
}

export const PublishVersionModal: Component<PublishVersionModalProps> = (
  props,
) => {
  const [version, setVersion] = createSignal(
    suggestNextVersion(props.currentVersion),
  );
  const [changelog, setChangelog] = createSignal("");
  const [publishing, setPublishing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const versionInvalid = () => !SEMVER_PATTERN.test(version().trim());

  const handlePublish = async () => {
    if (publishing()) return;
    const trimmedVersion = version().trim();
    if (!SEMVER_PATTERN.test(trimmedVersion)) {
      setError(`Version must be semver (e.g. 0.1.2). Got "${trimmedVersion}".`);
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      await skillsService.publishNewVersion(props.skill, {
        version: trimmedVersion,
        changelog: changelog().trim() || undefined,
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
      aria-labelledby="publish-version-title"
    >
      <div class="bg-popover border border-border rounded-lg w-[520px] max-w-[92vw] shadow-xl animate-[slideUp_0.2s_ease-out]">
        <div class="flex justify-between items-center py-4 px-5 border-b border-border">
          <div class="flex flex-col gap-0.5 min-w-0">
            <h2
              id="publish-version-title"
              class="m-0 text-base font-semibold text-foreground truncate"
            >
              Publish update to Seren Skills
            </h2>
            <span class="text-[12px] text-muted-foreground truncate">
              {props.skill.displayName ?? props.skill.name}{" "}
              <span class="text-muted-foreground/60">({props.skill.slug})</span>
              <Show when={props.currentVersion}>
                {(current) => (
                  <span class="text-muted-foreground/60">
                    {" "}
                    · current v{current()}
                  </span>
                )}
              </Show>
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

        <div class="px-5 py-4 flex flex-col gap-4">
          <Show when={error()}>
            <div class="py-2 px-3 bg-destructive/15 border border-destructive/30 text-destructive rounded text-[13px]">
              {error()}
            </div>
          </Show>

          <p class="m-0 text-[12px] text-muted-foreground">
            Pushes the current contents of your local SKILL.md and payload files
            as a new version. Visibility and discoverability stay where they are
            - tweak those from Manage instead.
          </p>

          <section class="flex flex-col gap-1.5">
            <label
              for="publish-version-input"
              class="text-[12px] font-medium text-foreground"
            >
              New version
            </label>
            <input
              id="publish-version-input"
              type="text"
              class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[14px] transition-colors duration-150 focus:outline-none focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed placeholder:text-muted-foreground"
              value={version()}
              onInput={(e) => setVersion(e.currentTarget.value)}
              placeholder="0.1.1"
              disabled={publishing()}
              aria-invalid={versionInvalid()}
            />
            <p class="m-0 text-[11px] text-muted-foreground">
              Semver. Suggested as a patch bump from the current version.
            </p>
          </section>

          <section class="flex flex-col gap-1.5">
            <label
              for="publish-changelog-input"
              class="text-[12px] font-medium text-foreground"
            >
              Changelog{" "}
              <span class="text-muted-foreground font-normal">(optional)</span>
            </label>
            <textarea
              id="publish-changelog-input"
              class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[13px] leading-relaxed transition-colors duration-150 focus:outline-none focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed placeholder:text-muted-foreground resize-y min-h-[88px]"
              value={changelog()}
              onInput={(e) => setChangelog(e.currentTarget.value)}
              placeholder="What changed in this version?"
              rows={3}
              disabled={publishing()}
            />
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
            {publishing() ? "Publishing..." : "Publish update"}
          </button>
        </div>
      </div>
    </div>
  );
};
