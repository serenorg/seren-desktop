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
    <div class="flex flex-col h-full p-3 bg-card text-foreground">
      <div class="flex justify-between items-center mb-3 pb-2 border-b border-border">
        <h2 class="m-0 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Databases
        </h2>
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="px-2 py-1 bg-transparent text-muted-foreground border border-border rounded text-sm cursor-pointer transition-all hover:bg-muted hover:text-foreground"
            onClick={() => setShowCreateModal(true)}
            title="Create project"
          >
            +
          </button>
          <button
            type="button"
            class="px-2 py-1 bg-transparent text-muted-foreground border border-border rounded text-sm cursor-pointer transition-all hover:bg-muted hover:text-foreground"
            onClick={() => refetchProjects()}
            title="Refresh projects"
          >
            ↻
          </button>
        </div>
      </div>

      <Show when={copyStatus()}>
        <div class="px-3 py-1.5 mb-2 bg-green-500/20 text-green-500 rounded text-xs text-center animate-[fadeIn_0.2s_ease-out]">
          {copyStatus()}
        </div>
      </Show>

      <Show when={projects.loading}>
        <div class="px-4 py-6 text-center text-muted-foreground text-[13px]">
          Loading projects...
        </div>
      </Show>

      <Show when={projects.error}>
        <div class="px-4 py-6 text-center text-destructive text-[13px]">
          Failed to load projects
        </div>
      </Show>

      <div class="flex-1 overflow-y-auto">
        <For each={projects()}>
          {(project) => (
            <div class="flex flex-col">
              <div
                class={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors select-none group ${
                  isProjectExpanded(project.id) ? "bg-muted" : "hover:bg-muted"
                }`}
                onClick={() => toggleProject(project.id)}
              >
                <span class="text-sm flex-shrink-0">
                  {isProjectExpanded(project.id) ? "📂" : "📁"}
                </span>
                <span class="flex-1 text-[13px] font-medium whitespace-nowrap overflow-hidden text-ellipsis">
                  {project.name}
                </span>
                <button
                  type="button"
                  class="px-1.5 py-0.5 bg-transparent border-none rounded text-xs cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/20"
                  onClick={(e) =>
                    handleDeleteProject(e, project.id, project.name)
                  }
                  title="Delete project"
                >
                  🗑️
                </button>
                <span class="text-[8px] text-muted-foreground flex-shrink-0">
                  {isProjectExpanded(project.id) ? "▼" : "▶"}
                </span>
              </div>

              <Show when={isProjectExpanded(project.id)}>
                <div class="pl-5">
                  <Show
                    when={
                      branches.loading && selectedProjectId() === project.id
                    }
                  >
                    <div class="px-2 py-1.5 text-xs text-muted-foreground italic">
                      Loading branches...
                    </div>
                  </Show>

                  <Show
                    when={
                      !branches.loading && selectedProjectId() === project.id
                    }
                  >
                    <For each={branches()}>
                      {(branch) => (
                        <div class="flex flex-col">
                          <div
                            class={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors select-none group text-xs ${
                              isBranchExpanded(branch.id)
                                ? "bg-muted"
                                : "hover:bg-muted"
                            } ${branch.is_default ? "text-green-500" : ""}`}
                            onClick={() => toggleBranch(branch.id, project.id)}
                          >
                            <span class="text-sm flex-shrink-0">
                              {isBranchExpanded(branch.id) ? "🔓" : "🔒"}
                            </span>
                            <span class="flex-1 flex items-center gap-1.5 whitespace-nowrap overflow-hidden text-ellipsis">
                              {branch.name}
                              <Show when={branch.is_default}>
                                <span class="px-1 py-px bg-green-500 text-background rounded text-[9px] font-semibold uppercase">
                                  default
                                </span>
                              </Show>
                            </span>
                            <button
                              type="button"
                              class="px-1.5 py-0.5 bg-transparent border-none rounded text-xs cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity hover:bg-green-500/20"
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
                            <span class="text-[8px] text-muted-foreground flex-shrink-0">
                              {isBranchExpanded(branch.id) ? "▼" : "▶"}
                            </span>
                          </div>

                          <Show when={isBranchExpanded(branch.id)}>
                            <div class="pl-5">
                              <Show
                                when={
                                  databaseList.loading &&
                                  selectedBranchId() === branch.id
                                }
                              >
                                <div class="px-2 py-1.5 text-xs text-muted-foreground italic">
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
                                    <div class="px-2 py-1.5 text-xs text-muted-foreground italic">
                                      No databases
                                    </div>
                                  }
                                >
                                  <For each={databaseList()}>
                                    {(db) => (
                                      <div
                                        class="flex items-center gap-2 px-2 py-1.5 pl-3 rounded cursor-pointer transition-colors text-xs hover:bg-accent hover:border-l-2 hover:border-l-ring hover:pl-2.5"
                                        onClick={() => handleSelectDatabase(db)}
                                      >
                                        <span class="text-sm">🗄️</span>
                                        <span class="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">
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
                      <div class="px-2 py-1.5 text-xs text-muted-foreground italic">
                        No branches
                      </div>
                    </Show>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>

      <Show when={!projects.loading && projects() && projects()?.length === 0}>
        <div class="flex flex-col items-center gap-2 px-4 py-6 text-center text-muted-foreground text-[13px]">
          <div class="text-[32px] opacity-50">🗄️</div>
          <p class="m-0">No projects found</p>
          <p class="text-[11px] text-muted-foreground">
            Click + to create your first project.
          </p>
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
