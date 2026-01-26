// ABOUTME: Database panel for browsing SerenDB projects, branches, and databases.
// ABOUTME: Provides a tree view of the user's database resources.

import {
  type Component,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { type Database, databases } from "@/services/databases";
import { CreateProjectModal } from "./CreateProjectModal";
import "./DatabasePanel.css";

interface DatabasePanelProps {
  onSelectDatabase?: (
    databaseId: string,
    projectId: string,
    branchId: string,
  ) => void;
}

interface ExpandedState {
  projects: Set<string>;
  branches: Set<string>;
}

export const DatabasePanel: Component<DatabasePanelProps> = (props) => {
  const [expanded, setExpanded] = createSignal<ExpandedState>({
    projects: new Set(),
    branches: new Set(),
  });

  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(
    null,
  );
  const [selectedBranchId, setSelectedBranchId] = createSignal<string | null>(
    null,
  );
  const [showCreateModal, setShowCreateModal] = createSignal(false);
  const [copyStatus, setCopyStatus] = createSignal<string | null>(null);

  // Fetch projects
  const [projects, { refetch: refetchProjects }] = createResource(async () => {
    try {
      return await databases.listProjects();
    } catch (error) {
      console.error("[DatabasePanel] Failed to fetch projects:", error);
      return [];
    }
  });

  // Fetch branches for selected project
  const [branches] = createResource(selectedProjectId, async (projectId) => {
    if (!projectId) return [];
    try {
      return await databases.listBranches(projectId);
    } catch (error) {
      console.error("[DatabasePanel] Failed to fetch branches:", error);
      return [];
    }
  });

  // Fetch databases for selected branch
  const [databaseList] = createResource(
    () => ({ projectId: selectedProjectId(), branchId: selectedBranchId() }),
    async ({ projectId, branchId }) => {
      if (!projectId || !branchId) return [];
      try {
        return await databases.listDatabases(projectId, branchId);
      } catch (error) {
        console.error("[DatabasePanel] Failed to fetch databases:", error);
        return [];
      }
    },
  );

  const toggleProject = (projectId: string) => {
    setExpanded((prev) => {
      const newProjects = new Set(prev.projects);
      if (newProjects.has(projectId)) {
        newProjects.delete(projectId);
        // Clear branch selection when collapsing
        if (selectedProjectId() === projectId) {
          setSelectedProjectId(null);
          setSelectedBranchId(null);
        }
      } else {
        newProjects.add(projectId);
        setSelectedProjectId(projectId);
      }
      return { ...prev, projects: newProjects };
    });
  };

  const toggleBranch = (branchId: string, projectId: string) => {
    setExpanded((prev) => {
      const newBranches = new Set(prev.branches);
      if (newBranches.has(branchId)) {
        newBranches.delete(branchId);
        if (selectedBranchId() === branchId) {
          setSelectedBranchId(null);
        }
      } else {
        newBranches.add(branchId);
        setSelectedProjectId(projectId);
        setSelectedBranchId(branchId);
      }
      return { ...prev, branches: newBranches };
    });
  };

  const handleSelectDatabase = (db: Database) => {
    if (props.onSelectDatabase) {
      // Use context from signals since DatabaseWithOwner doesn't have project_id
      const projectId = selectedProjectId();
      const branchId = selectedBranchId() || db.branch_id;
      if (projectId) {
        props.onSelectDatabase(db.id, projectId, branchId);
      }
    }
  };

  const handleDeleteProject = async (
    e: MouseEvent,
    projectId: string,
    projectName: string,
  ) => {
    e.stopPropagation();
    const confirmed = window.confirm(
      `Delete project "${projectName}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      await databases.deleteProject(projectId);
      refetchProjects();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      alert(`Failed to delete project: ${message}`);
    }
  };

  const handleCopyConnectionString = async (
    e: MouseEvent,
    projectId: string,
    branchId: string,
  ) => {
    e.stopPropagation();
    try {
      const connectionString = await databases.getConnectionString(
        projectId,
        branchId,
      );
      await navigator.clipboard.writeText(connectionString);
      setCopyStatus("Copied!");
      setTimeout(() => setCopyStatus(null), 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      alert(`Failed to copy connection string: ${message}`);
    }
  };

  const isProjectExpanded = (projectId: string) =>
    expanded().projects.has(projectId);
  const isBranchExpanded = (branchId: string) =>
    expanded().branches.has(branchId);

  return (
    <div class="database-panel">
      <div class="database-header">
        <h2>Databases</h2>
        <div class="database-header-actions">
          <button
            type="button"
            class="database-action-btn"
            onClick={() => setShowCreateModal(true)}
            title="Create project"
          >
            +
          </button>
          <button
            type="button"
            class="database-action-btn"
            onClick={() => refetchProjects()}
            title="Refresh projects"
          >
            ↻
          </button>
        </div>
      </div>

      <Show when={copyStatus()}>
        <div class="database-copy-status">{copyStatus()}</div>
      </Show>

      <Show when={projects.loading}>
        <div class="database-loading">Loading projects...</div>
      </Show>

      <Show when={projects.error}>
        <div class="database-error">Failed to load projects</div>
      </Show>

      <div class="database-tree">
        <For each={projects()}>
          {(project) => (
            <div class="tree-node project-node">
              <div
                class={`tree-item project-item ${isProjectExpanded(project.id) ? "expanded" : ""}`}
                onClick={() => toggleProject(project.id)}
              >
                <span class="tree-icon">
                  {isProjectExpanded(project.id) ? "📂" : "📁"}
                </span>
                <span class="tree-label">{project.name}</span>
                <button
                  type="button"
                  class="tree-action-btn delete-btn"
                  onClick={(e) =>
                    handleDeleteProject(e, project.id, project.name)
                  }
                  title="Delete project"
                >
                  🗑️
                </button>
                <span class="tree-chevron">
                  {isProjectExpanded(project.id) ? "▼" : "▶"}
                </span>
              </div>

              <Show when={isProjectExpanded(project.id)}>
                <div class="tree-children">
                  <Show
                    when={
                      branches.loading && selectedProjectId() === project.id
                    }
                  >
                    <div class="tree-loading">Loading branches...</div>
                  </Show>

                  <Show
                    when={
                      !branches.loading && selectedProjectId() === project.id
                    }
                  >
                    <For each={branches()}>
                      {(branch) => (
                        <div class="tree-node branch-node">
                          <div
                            class={`tree-item branch-item ${isBranchExpanded(branch.id) ? "expanded" : ""} ${branch.is_default ? "default-branch" : ""}`}
                            onClick={() => toggleBranch(branch.id, project.id)}
                          >
                            <span class="tree-icon">
                              {isBranchExpanded(branch.id) ? "🔓" : "🔒"}
                            </span>
                            <span class="tree-label">
                              {branch.name}
                              <Show when={branch.is_default}>
                                <span class="default-badge">default</span>
                              </Show>
                            </span>
                            <button
                              type="button"
                              class="tree-action-btn copy-btn"
                              onClick={(e) =>
                                handleCopyConnectionString(
                                  e,
                                  project.id,
                                  branch.id,
                                )
                              }
                              title="Copy connection string"
                            >
                              📋
                            </button>
                            <span class="tree-chevron">
                              {isBranchExpanded(branch.id) ? "▼" : "▶"}
                            </span>
                          </div>

                          <Show when={isBranchExpanded(branch.id)}>
                            <div class="tree-children">
                              <Show
                                when={
                                  databaseList.loading &&
                                  selectedBranchId() === branch.id
                                }
                              >
                                <div class="tree-loading">
                                  Loading databases...
                                </div>
                              </Show>

                              <Show
                                when={
                                  !databaseList.loading &&
                                  selectedBranchId() === branch.id
                                }
                              >
                                <Show
                                  when={
                                    databaseList() &&
                                    (databaseList()?.length ?? 0) > 0
                                  }
                                  fallback={
                                    <div class="tree-empty">No databases</div>
                                  }
                                >
                                  <For each={databaseList()}>
                                    {(db) => (
                                      <div
                                        class="tree-item database-item"
                                        onClick={() => handleSelectDatabase(db)}
                                      >
                                        <span class="tree-icon">🗄️</span>
                                        <span class="tree-label">
                                          {db.name}
                                        </span>
                                      </div>
                                    )}
                                  </For>
                                </Show>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>

                    <Show when={branches() && branches()?.length === 0}>
                      <div class="tree-empty">No branches</div>
                    </Show>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>

      <Show when={!projects.loading && projects() && projects()?.length === 0}>
        <div class="database-empty">
          <div class="empty-icon">🗄️</div>
          <p>No projects found</p>
          <p class="empty-hint">Click + to create your first project.</p>
        </div>
      </Show>

      <Show when={showCreateModal()}>
        <CreateProjectModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => refetchProjects()}
        />
      </Show>
    </div>
  );
};
