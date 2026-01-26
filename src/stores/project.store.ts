// ABOUTME: Project store for managing project state.
// ABOUTME: Handles active project selection and project list caching.

import { createStore } from "solid-js/store";
import { type Project, projects } from "@/services/projects";

/**
 * Project store state.
 */
interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;
}

const [state, setState] = createStore<ProjectState>({
  projects: [],
  activeProjectId: null,
  loading: false,
  error: null,
});

/**
 * Project store with reactive state and actions.
 */
export const projectStore = {
  /**
   * Get all projects.
   */
  get projects(): Project[] {
    return state.projects;
  },

  /**
   * Get the active project.
   */
  get activeProject(): Project | null {
    if (!state.activeProjectId) return null;
    return state.projects.find((p) => p.id === state.activeProjectId) || null;
  },

  /**
   * Get loading state.
   */
  get loading(): boolean {
    return state.loading;
  },

  /**
   * Get error message.
   */
  get error(): string | null {
    return state.error;
  },

  /**
   * Set the active project by ID.
   */
  setActive(id: string | null): void {
    setState("activeProjectId", id);
    // Persist to local storage
    if (id) {
      localStorage.setItem("seren:activeProjectId", id);
    } else {
      localStorage.removeItem("seren:activeProjectId");
    }
  },

  /**
   * Refresh the project list from the API.
   */
  async refresh(): Promise<void> {
    setState("loading", true);
    setState("error", null);

    try {
      const projectList = await projects.list();
      setState("projects", projectList);

      // Restore active project from local storage
      const savedActiveId = localStorage.getItem("seren:activeProjectId");
      if (savedActiveId && projectList.some((p) => p.id === savedActiveId)) {
        setState("activeProjectId", savedActiveId);
      } else if (projectList.length > 0 && !state.activeProjectId) {
        // Auto-select first project if none selected
        setState("activeProjectId", projectList[0].id);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load projects";
      setState("error", message);
    } finally {
      setState("loading", false);
    }
  },

  /**
   * Create a new project.
   */
  async create(name: string, region: string): Promise<Project> {
    setState("loading", true);
    setState("error", null);

    try {
      const project = await projects.create({ name, region });
      setState("projects", [...state.projects, project]);
      return project;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create project";
      setState("error", message);
      throw err;
    } finally {
      setState("loading", false);
    }
  },

  /**
   * Delete a project.
   */
  async delete(id: string): Promise<void> {
    setState("loading", true);
    setState("error", null);

    try {
      await projects.delete(id);
      setState(
        "projects",
        state.projects.filter((p) => p.id !== id),
      );

      // Clear active project if it was deleted
      if (state.activeProjectId === id) {
        const remaining = state.projects.filter((p) => p.id !== id);
        setState(
          "activeProjectId",
          remaining.length > 0 ? remaining[0].id : null,
        );
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to delete project";
      setState("error", message);
      throw err;
    } finally {
      setState("loading", false);
    }
  },

  /**
   * Clear all state (e.g., on logout).
   */
  clear(): void {
    setState({
      projects: [],
      activeProjectId: null,
      loading: false,
      error: null,
    });
    localStorage.removeItem("seren:activeProjectId");
  },
};
