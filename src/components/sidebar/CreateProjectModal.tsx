// ABOUTME: Modal dialog for creating a new SerenDB project.
// ABOUTME: Allows user to select organization and enter project name.

import {
  type Component,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { databases } from "@/services/databases";

interface CreateProjectModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export const CreateProjectModal: Component<CreateProjectModalProps> = (
  props,
) => {
  const [projectName, setProjectName] = createSignal("");
  const [selectedOrgId, setSelectedOrgId] = createSignal<string>("");
  const [isCreating, setIsCreating] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Fetch organizations on mount
  const [organizations] = createResource(async () => {
    try {
      const orgs = await databases.listOrganizations();
      // Auto-select first org if available
      if (orgs.length > 0 && !selectedOrgId()) {
        setSelectedOrgId(orgs[0].id);
      }
      return orgs;
    } catch (err) {
      console.error("[CreateProjectModal] Failed to fetch organizations:", err);
      setError("Failed to load organizations");
      return [];
    }
  });

  const handleCreate = async () => {
    const name = projectName().trim();
    const orgId = selectedOrgId();

    if (!name) {
      setError("Project name is required");
      return;
    }

    if (!orgId) {
      setError("Please select an organization");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      await databases.createProject(name, orgId);
      props.onCreated();
      props.onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(`Failed to create project: ${message}`);
    } finally {
      setIsCreating(false);
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      props.onClose();
    }
  };

  return (
    <div
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_0.15s_ease-out]"
      onClick={handleBackdropClick}
    >
      <div class="bg-popover border border-border rounded-lg w-[400px] max-w-[90vw] shadow-xl animate-[slideUp_0.2s_ease-out]">
        <div class="flex justify-between items-center py-4 px-5 border-b border-border">
          <h2 class="m-0 text-base font-semibold text-foreground">
            Create Project
          </h2>
          <button
            type="button"
            class="bg-transparent border-none text-muted-foreground text-2xl leading-none cursor-pointer py-1 px-2 rounded transition-all duration-150 hover:bg-muted hover:text-foreground"
            onClick={props.onClose}
            title="Close"
          >
            ×
          </button>
        </div>

        <div class="p-5">
          <Show when={error()}>
            <div class="py-2.5 px-3 mb-4 bg-destructive/20 text-destructive rounded text-[13px]">
              {error()}
            </div>
          </Show>

          <div class="mb-4">
            <label
              for="organization"
              class="block mb-1.5 text-[13px] font-medium text-foreground"
            >
              Organization
            </label>
            <Show
              when={!organizations.loading}
              fallback={
                <div class="py-2.5 px-3 text-muted-foreground text-[13px] italic">
                  Loading organizations...
                </div>
              }
            >
              <select
                id="organization"
                class="w-full py-2.5 px-3 bg-card text-foreground border border-border rounded text-sm transition-colors duration-150 focus:outline-none focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed"
                value={selectedOrgId()}
                onChange={(e) => setSelectedOrgId(e.currentTarget.value)}
                disabled={isCreating()}
              >
                <Show when={organizations() && organizations()?.length === 0}>
                  <option value="">No organizations available</option>
                </Show>
                <For each={organizations()}>
                  {(org) => <option value={org.id}>{org.name}</option>}
                </For>
              </select>
            </Show>
          </div>

          <div class="mb-0">
            <label
              for="project-name"
              class="block mb-1.5 text-[13px] font-medium text-foreground"
            >
              Project Name
            </label>
            <input
              id="project-name"
              type="text"
              class="w-full py-2.5 px-3 bg-card text-foreground border border-border rounded text-sm transition-colors duration-150 focus:outline-none focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed placeholder:text-muted-foreground"
              value={projectName()}
              onInput={(e) => setProjectName(e.currentTarget.value)}
              placeholder="Enter project name"
              disabled={isCreating()}
              onKeyPress={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
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
            disabled={isCreating() || !projectName().trim() || !selectedOrgId()}
          >
            {isCreating() ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
};
