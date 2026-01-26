// ABOUTME: Database service for fetching SerenDB database data from Seren API.
// ABOUTME: Uses generated hey-api SDK for type-safe API calls.

import {
  createProject as apiCreateProject,
  deleteProject as apiDeleteProject,
  getBranch as apiGetBranch,
  getConnectionString as apiGetConnectionString,
  getDatabase as apiGetDatabase,
  getProject as apiGetProject,
  listBranches as apiListBranches,
  listDatabases as apiListDatabases,
  listOrganizations as apiListOrganizations,
  listProjects as apiListProjects,
  type Branch,
  type DatabaseWithOwner,
  type Organization,
  type Project,
} from "@/api";

// Use DatabaseWithOwner as the Database type (list endpoint returns this)
export type Database = DatabaseWithOwner;

// Re-export types for backwards compatibility
export type { Organization, Project, Branch };

/**
 * Database service for Seren API operations.
 * Uses generated SDK with full type safety.
 */
export const databases = {
  /**
   * List all organizations for the authenticated user.
   */
  async listOrganizations(): Promise<Organization[]> {
    console.log("[Databases] Fetching organizations");
    const { data, error } = await apiListOrganizations({ throwOnError: false });
    if (error) {
      console.error("[Databases] Error fetching organizations:", error);
      throw new Error("Failed to list organizations");
    }
    const orgs = data?.data || [];
    console.log("[Databases] Found", orgs.length, "organizations");
    return orgs;
  },

  /**
   * List all projects for the authenticated user.
   */
  async listProjects(): Promise<Project[]> {
    console.log("[Databases] Fetching projects");
    const { data, error } = await apiListProjects({ throwOnError: false });
    if (error) {
      console.error("[Databases] Error fetching projects:", error);
      throw new Error("Failed to list projects");
    }
    const projects = data?.data || [];
    console.log("[Databases] Found", projects.length, "projects");
    return projects;
  },

  /**
   * Create a new project.
   * Note: organization_id is derived from the authenticated user's JWT token.
   */
  async createProject(
    name: string,
    _organizationId?: string,
  ): Promise<Project> {
    console.log("[Databases] Creating project:", name);
    const { data, error } = await apiCreateProject({
      body: { name, region: "aws-us-east-2" },
      throwOnError: false,
    });
    if (error || !data?.data) {
      console.error("[Databases] Error creating project:", error);
      throw new Error("Failed to create project");
    }
    // Fetch full project details (create returns ProjectCreated, not full Project)
    return this.getProject(data.data.id);
  },

  /**
   * Delete a project by ID.
   */
  async deleteProject(projectId: string): Promise<void> {
    console.log("[Databases] Deleting project:", projectId);
    const { error } = await apiDeleteProject({
      path: { project_id: projectId },
      throwOnError: false,
    });
    if (error) {
      console.error("[Databases] Error deleting project:", error);
      throw new Error("Failed to delete project");
    }
  },

  /**
   * List all branches for a project.
   */
  async listBranches(projectId: string): Promise<Branch[]> {
    console.log("[Databases] Fetching branches for project:", projectId);
    const { data, error } = await apiListBranches({
      path: { project_id: projectId },
      throwOnError: false,
    });
    if (error) {
      console.error("[Databases] Error fetching branches:", error);
      throw new Error("Failed to list branches");
    }
    const branches = data?.data || [];
    console.log("[Databases] Found", branches.length, "branches");
    return branches;
  },

  /**
   * Get connection string for a branch.
   */
  async getConnectionString(
    projectId: string,
    branchId: string,
  ): Promise<string> {
    console.log("[Databases] Fetching connection string");
    const { data, error } = await apiGetConnectionString({
      path: { project_id: projectId, branch_id: branchId },
      throwOnError: false,
    });
    if (error || !data?.data) {
      console.error("[Databases] Error fetching connection string:", error);
      throw new Error("Failed to get connection string");
    }
    return data.data.connection_string;
  },

  /**
   * List all databases for a branch.
   */
  async listDatabases(
    projectId: string,
    branchId: string,
  ): Promise<Database[]> {
    console.log("[Databases] Fetching databases for branch:", branchId);
    const { data, error } = await apiListDatabases({
      path: { project_id: projectId, branch_id: branchId },
      throwOnError: false,
    });
    if (error) {
      console.error("[Databases] Error fetching databases:", error);
      throw new Error("Failed to list databases");
    }
    const dbs = data?.data || [];
    console.log("[Databases] Found", dbs.length, "databases");
    return dbs;
  },

  /**
   * Get a single project by ID.
   */
  async getProject(projectId: string): Promise<Project> {
    const { data, error } = await apiGetProject({
      path: { project_id: projectId },
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error("Failed to get project");
    }
    return data.data;
  },

  /**
   * Get a single branch by ID.
   */
  async getBranch(projectId: string, branchId: string): Promise<Branch> {
    const { data, error } = await apiGetBranch({
      path: { project_id: projectId, branch_id: branchId },
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error("Failed to get branch");
    }
    return data.data;
  },

  /**
   * Get a single database by ID.
   */
  async getDatabase(
    projectId: string,
    branchId: string,
    databaseId: string,
  ): Promise<Database> {
    const { data, error } = await apiGetDatabase({
      path: {
        project_id: projectId,
        branch_id: branchId,
        database_id: databaseId,
      },
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error("Failed to get database");
    }
    return data.data;
  },
};
