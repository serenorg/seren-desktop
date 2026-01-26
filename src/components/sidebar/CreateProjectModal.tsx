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
import "./CreateProjectModal.css";

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
    <div class="create-project-modal-backdrop" onClick={handleBackdropClick}>
      <div class="create-project-modal">
        <div class="modal-header">
          <h2>Create Project</h2>
          <button
            type="button"
            class="modal-close-btn"
            onClick={props.onClose}
            title="Close"
          >
            ×
          </button>
        </div>

        <div class="modal-body">
          <Show when={error()}>
            <div class="modal-error">{error()}</div>
          </Show>

          <div class="form-group">
            <label for="organization">Organization</label>
            <Show
              when={!organizations.loading}
              fallback={
                <div class="form-loading">Loading organizations...</div>
              }
            >
              <select
                id="organization"
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

          <div class="form-group">
            <label for="project-name">Project Name</label>
            <input
              id="project-name"
              type="text"
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

        <div class="modal-footer">
          <button
            type="button"
            class="modal-btn modal-btn-secondary"
            onClick={props.onClose}
            disabled={isCreating()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="modal-btn modal-btn-primary"
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
