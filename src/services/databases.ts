// ABOUTME: Database service for fetching SerenDB database data from Seren API.
// ABOUTME: Handles listing projects, branches, and databases for the Database panel.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/lib/tauri-bridge";

/**
 * SerenDB Project structure.
 */
export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

/**
 * SerenDB Branch structure.
 */
export interface Branch {
  id: string;
  name: string;
  project_id: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * SerenDB Database structure.
 */
export interface Database {
  id: string;
  name: string;
  branch_id: string;
  project_id: string;
  schema?: string;
  tables_count?: number;
  created_at: string;
  updated_at: string;
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
 * Database service for Seren API operations.
 */
export const databases = {
  /**
   * List all projects for the authenticated user.
   */
  async listProjects(): Promise<Project[]> {
    const headers = await getAuthHeaders();
    const url = `${apiBase}/agent/databases/projects`;
    console.log("[Databases] Fetching projects from:", url);

    const response = await appFetch(url, {
      method: "GET",
      headers,
    });

    console.log("[Databases] Projects response status:", response.status);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error("[Databases] Error fetching projects:", error);
      throw new Error(error.message || "Failed to list projects");
    }

    const data = await response.json();
    // Handle { data: [...] } or direct array responses
    const projects: Project[] = Array.isArray(data) ? data : (data.data || data.projects || []);
    console.log("[Databases] Found", projects.length, "projects");

    return projects;
  },

  /**
   * List all branches for a project.
   */
  async listBranches(projectId: string): Promise<Branch[]> {
    const headers = await getAuthHeaders();
    const params = new URLSearchParams({ project_id: projectId });
    const url = `${apiBase}/agent/databases/branches?${params}`;
    console.log("[Databases] Fetching branches from:", url);

    const response = await appFetch(url, {
      method: "GET",
      headers,
    });

    console.log("[Databases] Branches response status:", response.status);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error("[Databases] Error fetching branches:", error);
      throw new Error(error.message || "Failed to list branches");
    }

    const data = await response.json();
    const branches: Branch[] = Array.isArray(data) ? data : (data.data || data.branches || []);
    console.log("[Databases] Found", branches.length, "branches for project", projectId);

    return branches;
  },

  /**
   * List all databases for a branch.
   */
  async listDatabases(projectId: string, branchId: string): Promise<Database[]> {
    const headers = await getAuthHeaders();
    const params = new URLSearchParams({ project_id: projectId, branch_id: branchId });
    const url = `${apiBase}/agent/databases/list?${params}`;
    console.log("[Databases] Fetching databases from:", url);

    const response = await appFetch(url, {
      method: "GET",
      headers,
    });

    console.log("[Databases] Databases response status:", response.status);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error("[Databases] Error fetching databases:", error);
      throw new Error(error.message || "Failed to list databases");
    }

    const data = await response.json();
    const dbs: Database[] = Array.isArray(data) ? data : (data.data || data.databases || []);
    console.log("[Databases] Found", dbs.length, "databases for branch", branchId);

    return dbs;
  },

  /**
   * Get a single project by ID.
   */
  async getProject(projectId: string): Promise<Project> {
    const headers = await getAuthHeaders();
    const url = `${apiBase}/agent/databases/projects/${encodeURIComponent(projectId)}`;

    const response = await appFetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to get project");
    }

    const data = await response.json();
    return data.data || data;
  },

  /**
   * Get a single branch by ID.
   */
  async getBranch(branchId: string): Promise<Branch> {
    const headers = await getAuthHeaders();
    const url = `${apiBase}/agent/databases/branches/${encodeURIComponent(branchId)}`;

    const response = await appFetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to get branch");
    }

    const data = await response.json();
    return data.data || data;
  },

  /**
   * Get a single database by ID.
   */
  async getDatabase(databaseId: string): Promise<Database> {
    const headers = await getAuthHeaders();
    const url = `${apiBase}/agent/databases/${encodeURIComponent(databaseId)}`;

    const response = await appFetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to get database");
    }

    const data = await response.json();
    return data.data || data;
  },
};
