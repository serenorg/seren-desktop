// ABOUTME: Project service for CRUD operations via Seren API.
// ABOUTME: Handles listing, creating, updating, and deleting projects.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/lib/tauri-bridge";

/**
 * Project data structure from Seren API.
 */
export interface Project {
  id: string;
  name: string;
  region: string;
  created_at: string;
  updated_at: string;
}

/**
 * Parameters for creating a new project.
 */
export interface CreateProjectParams {
  name: string;
  region: string;
}

/**
 * Parameters for updating a project.
 */
export interface UpdateProjectParams {
  name?: string;
}

/**
 * API response wrapper for project list.
 */
interface ProjectListResponse {
  projects: Project[];
}

/**
 * Get authorization headers for API requests.
 */
async function getAuthHeaders(): Promise<HeadersInit> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Project service for Seren API operations.
 */
export const projects = {
  /**
   * List all projects for the authenticated user.
   */
  async list(): Promise<Project[]> {
    const headers = await getAuthHeaders();
    const response = await appFetch(`${apiBase}/projects`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to list projects");
    }

    const data: ProjectListResponse = await response.json();
    return data.projects || [];
  },

  /**
   * Create a new project.
   */
  async create(params: CreateProjectParams): Promise<Project> {
    const headers = await getAuthHeaders();
    const response = await appFetch(`${apiBase}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to create project");
    }

    return response.json();
  },

  /**
   * Get a single project by ID.
   */
  async get(id: string): Promise<Project> {
    const headers = await getAuthHeaders();
    const response = await appFetch(`${apiBase}/projects/${id}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to get project");
    }

    return response.json();
  },

  /**
   * Update a project.
   */
  async update(id: string, params: UpdateProjectParams): Promise<Project> {
    const headers = await getAuthHeaders();
    const response = await appFetch(`${apiBase}/projects/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to update project");
    }

    return response.json();
  },

  /**
   * Delete a project.
   */
  async delete(id: string): Promise<void> {
    const headers = await getAuthHeaders();
    const response = await appFetch(`${apiBase}/projects/${id}`, {
      method: "DELETE",
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to delete project");
    }
  },
};
