// ABOUTME: Project picker component for selecting and managing projects.
// ABOUTME: Allows creating, deleting, and switching between projects.

import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { getDefaultRegion, REGIONS } from "@/lib/regions";
import { projectStore } from "@/stores/project.store";

export const ProjectPicker: Component = () => {
  const [isCreating, setIsCreating] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [selectedRegion, setSelectedRegion] = createSignal(getDefaultRegion());
  const [isSubmitting, setIsSubmitting] = createSignal(false);

  onMount(() => {
    projectStore.refresh();
  });

  const handleCreate = async () => {
    const name = newName().trim();
    if (!name) return;

    setIsSubmitting(true);
    try {
      const project = await projectStore.create(name, selectedRegion());
      projectStore.setActive(project.id);
      setNewName("");
      setIsCreating(false);
    } catch {
      // Error is handled by store
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete project "${name}"? This cannot be undone.`)) {
      return;
    }

    try {
      await projectStore.delete(id);
    } catch {
      // Error is handled by store
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !isSubmitting()) {
      handleCreate();
    } else if (e.key === "Escape") {
      setIsCreating(false);
      setNewName("");
    }
  };

  return (
    <div class="flex flex-col h-full p-3 bg-card text-foreground">
      <div class="flex justify-between items-center mb-3 pb-2 border-b border-border">
        <h2 class="m-0 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Projects
        </h2>
        <button
          class="px-2 py-1 bg-primary text-primary-foreground border-none rounded text-xs cursor-pointer transition-colors hover:not-disabled:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => setIsCreating(true)}
          disabled={isCreating()}
        >
          + New
        </button>
      </div>

      <Show when={projectStore.error}>
        <div class="p-2 mb-3 bg-destructive/20 text-destructive rounded text-xs">
          {projectStore.error}
        </div>
      </Show>

      <Show when={isCreating()}>
        <div class="flex flex-col gap-2 p-3 mb-3 bg-muted rounded-md">
          <input
            type="text"
            placeholder="Project name"
            value={newName()}
            onInput={(e) => setNewName(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            disabled={isSubmitting()}
            autofocus
            class="px-2.5 py-2 bg-background border border-border rounded text-foreground text-[13px] focus:outline-none focus:border-ring placeholder:text-muted-foreground"
          />
          <select
            value={selectedRegion()}
            onChange={(e) => setSelectedRegion(e.currentTarget.value)}
            disabled={isSubmitting()}
            class="px-2.5 py-2 bg-background border border-border rounded text-foreground text-[13px] focus:outline-none focus:border-ring"
          >
            <For each={REGIONS}>
              {(region) => (
                <option value={region.id}>
                  {region.name} ({region.location})
                </option>
              )}
            </For>
          </select>
          <div class="flex gap-2 mt-1">
            <button
              class="flex-1 py-2 bg-primary text-primary-foreground border-none rounded text-[13px] cursor-pointer transition-colors hover:not-disabled:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleCreate}
              disabled={isSubmitting() || !newName().trim()}
            >
              {isSubmitting() ? "Creating..." : "Create"}
            </button>
            <button
              class="px-3 py-2 bg-transparent text-foreground border border-border rounded text-[13px] cursor-pointer transition-colors hover:not-disabled:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => {
                setIsCreating(false);
                setNewName("");
              }}
              disabled={isSubmitting()}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>

      <Show when={projectStore.loading && projectStore.projects.length === 0}>
        <div class="p-4 text-center text-muted-foreground text-[13px]">
          Loading projects...
        </div>
      </Show>

      <div class="flex-1 overflow-y-auto flex flex-col gap-0.5">
        <For each={projectStore.projects}>
          {(project) => (
            <div
              class={`flex justify-between items-center px-2.5 py-2 rounded cursor-pointer transition-colors group ${
                project.id === projectStore.activeProject?.id
                  ? "bg-primary/20"
                  : "hover:bg-muted"
              }`}
              onClick={() => projectStore.setActive(project.id)}
            >
              <div class="flex flex-col gap-0.5 overflow-hidden">
                <span class="text-[13px] font-medium whitespace-nowrap overflow-hidden text-ellipsis">
                  {project.name}
                </span>
                <span class="text-[11px] text-muted-foreground">
                  {project.region}
                </span>
              </div>
              <button
                class="px-1.5 py-0.5 bg-transparent text-muted-foreground border-none rounded text-base leading-none cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/20 hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(project.id, project.name);
                }}
                title="Delete project"
              >
                &times;
              </button>
            </div>
          )}
        </For>
      </div>

      <Show when={!projectStore.loading && projectStore.projects.length === 0}>
        <div class="p-4 text-center text-muted-foreground text-[13px]">
          No projects yet. Create one to get started.
        </div>
      </Show>
    </div>
  );
};
