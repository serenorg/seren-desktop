// ABOUTME: Project picker component for selecting and managing projects.
// ABOUTME: Allows creating, deleting, and switching between projects.

import { Component, For, createSignal, Show, onMount } from "solid-js";
import { projectStore } from "@/stores/project.store";
import { REGIONS, getDefaultRegion } from "@/lib/regions";
import "./ProjectPicker.css";

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
    <div class="project-picker">
      <div class="project-picker-header">
        <h2>Projects</h2>
        <button
          class="project-picker-new-btn"
          onClick={() => setIsCreating(true)}
          disabled={isCreating()}
        >
          + New
        </button>
      </div>

      <Show when={projectStore.error}>
        <div class="project-picker-error">{projectStore.error}</div>
      </Show>

      <Show when={isCreating()}>
        <div class="project-create-form">
          <input
            type="text"
            placeholder="Project name"
            value={newName()}
            onInput={(e) => setNewName(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            disabled={isSubmitting()}
            autofocus
          />
          <select
            value={selectedRegion()}
            onChange={(e) => setSelectedRegion(e.currentTarget.value)}
            disabled={isSubmitting()}
          >
            <For each={REGIONS}>
              {(region) => (
                <option value={region.id}>
                  {region.name} ({region.location})
                </option>
              )}
            </For>
          </select>
          <div class="project-create-actions">
            <button
              class="project-create-btn"
              onClick={handleCreate}
              disabled={isSubmitting() || !newName().trim()}
            >
              {isSubmitting() ? "Creating..." : "Create"}
            </button>
            <button
              class="project-cancel-btn"
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
        <div class="project-picker-loading">Loading projects...</div>
      </Show>

      <div class="project-list">
        <For each={projectStore.projects}>
          {(project) => (
            <div
              class={`project-item ${project.id === projectStore.activeProject?.id ? "active" : ""}`}
              onClick={() => projectStore.setActive(project.id)}
            >
              <div class="project-item-info">
                <span class="project-name">{project.name}</span>
                <span class="project-region">{project.region}</span>
              </div>
              <button
                class="project-delete-btn"
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
        <div class="project-picker-empty">
          No projects yet. Create one to get started.
        </div>
      </Show>
    </div>
  );
};
