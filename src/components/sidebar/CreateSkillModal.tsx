// ABOUTME: Modal dialog for creating a new skill.
// ABOUTME: Scaffolds a SKILL.md folder via the Tauri create_skill_folder command and returns the new path.

import { invoke } from "@tauri-apps/api/core";
import {
  type Component,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { normalizeSkillSlug } from "@/lib/skills";

interface CreateSkillModalProps {
  onClose: () => void;
  onCreated: (skillPath: string) => void;
}

export const CreateSkillModal: Component<CreateSkillModalProps> = (props) => {
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [isCreating, setIsCreating] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let nameInputRef: HTMLInputElement | undefined;

  onMount(() => {
    // Defer focus until after the slideUp animation has started so the
    // browser does not scroll the modal mid-flight.
    requestAnimationFrame(() => nameInputRef?.focus());
  });

  const handleCreate = async () => {
    const trimmedName = name().trim();
    if (!trimmedName) {
      setError("Name is required");
      return;
    }

    const slug = normalizeSkillSlug(trimmedName);
    const trimmedDescription = description().trim();

    setIsCreating(true);
    setError(null);
    try {
      const skillsDir = await invoke<string>("get_seren_skills_dir");
      const skillPath = await invoke<string>("create_skill_folder", {
        skillsDir,
        slug,
        name: trimmedName,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
      });
      props.onCreated(skillPath);
      props.onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsCreating(false);
    }
  };

  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget && !isCreating()) {
      props.onClose();
    }
  };

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !isCreating()) {
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
      aria-labelledby="create-skill-title"
    >
      <div class="bg-popover border border-border rounded-lg w-[560px] max-w-[92vw] shadow-xl animate-[slideUp_0.2s_ease-out]">
        <div class="flex justify-between items-center py-4 px-5 border-b border-border">
          <h2
            id="create-skill-title"
            class="m-0 text-base font-semibold text-foreground"
          >
            Create skill
          </h2>
          <button
            type="button"
            class="bg-transparent border-none text-muted-foreground text-2xl leading-none cursor-pointer py-1 px-2 rounded transition-all duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50"
            onClick={props.onClose}
            disabled={isCreating()}
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

          <div class="flex flex-col gap-1.5">
            <label
              for="create-skill-name"
              class="text-[12px] font-medium text-foreground"
            >
              Name
            </label>
            <input
              id="create-skill-name"
              ref={nameInputRef}
              type="text"
              class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[14px] transition-colors duration-150 focus:outline-none focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed placeholder:text-muted-foreground"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. lead-finder"
              disabled={isCreating()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
            />
            <p class="m-0 text-[11px] text-muted-foreground">
              Used as both the display title and the directory slug.
            </p>
          </div>

          <div class="flex flex-col gap-1.5">
            <label
              for="create-skill-description"
              class="text-[12px] font-medium text-foreground"
            >
              Description
            </label>
            <textarea
              id="create-skill-description"
              class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[14px] leading-relaxed transition-colors duration-150 focus:outline-none focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed placeholder:text-muted-foreground resize-y min-h-[120px]"
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
              placeholder="Find new leads from a list of websites and report back. Use when the user wants to research prospects."
              rows={5}
              disabled={isCreating()}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
            />
            <p class="m-0 text-[11px] text-muted-foreground">
              The agent reads this to decide when to invoke the skill. Be
              specific about what it does and when to use it.
            </p>
          </div>
        </div>

        <div class="flex justify-end gap-2 py-4 px-5 border-t border-border">
          <button
            type="button"
            class="py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={props.onClose}
            disabled={isCreating()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-primary text-primary-foreground border border-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleCreate}
            disabled={isCreating() || !name().trim()}
          >
            {isCreating() ? "Creating..." : "Create and edit"}
          </button>
        </div>
      </div>
    </div>
  );
};
