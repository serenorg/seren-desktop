// ABOUTME: Project service for CRUD operations via Seren API.
// ABOUTME: Uses generated hey-api SDK for type-safe API calls.

import {
  type CreateProjectRequest,
  serenDbCreateProject,
  serenDbDeleteProject,
  serenDbGetProject,
  serenDbListProjects,
  type Project,
  type UpdateProjectRequest,
  serenDbUpdateProject,
} from "@/api/seren-db";

// Re-export types for backwards compatibility
export type { Project };
export type CreateProjectParams = CreateProjectRequest;
export type UpdateProjectParams = UpdateProjectRequest;

/**
 * Project service for Seren API operations.
 * Uses generated SDK with full type safety.
 */
export const projects = {
  /**
   * List all projects for the authenticated user.
   */
  async list(): Promise<Project[]> {
    const { data, error } = await serenDbListProjects({ throwOnError: false });
    if (error) {
      throw new Error("Failed to list projects");
    }
    return data?.data || [];
  },

  /**
   * Create a new project.
   */
  async create(params: CreateProjectParams): Promise<Project> {
    const { data, error } = await serenDbCreateProject({
      body: params,
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error("Failed to create project");
    }
    // createProject returns ProjectCreated (subset of fields); fetch full Project
    return this.get(data.data.id);
  },

  /**
   * Get a single project by ID.
   */
  async get(id: string): Promise<Project> {
    const { data, error } = await serenDbGetProject({
      path: { id },
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error("Failed to get project");
    }
    return data.data;
  },

  /**
   * Update a project.
   */
  async update(id: string, params: UpdateProjectParams): Promise<Project> {
    const { data, error } = await serenDbUpdateProject({
      path: { id },
      body: params,
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error("Failed to update project");
    }
    return data.data;
  },

  /**
   * Delete a project.
   */
  async delete(id: string): Promise<void> {
    const { error } = await serenDbDeleteProject({
      path: { id },
      throwOnError: false,
    });
    if (error) {
      throw new Error("Failed to delete project");
    }
  },
};
