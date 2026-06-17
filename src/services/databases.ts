// ABOUTME: Database service for fetching SerenDB database data from Seren API.
// ABOUTME: Uses generated hey-api SDK for type-safe API calls.

import { invoke } from "@tauri-apps/api/core";
// listOrganizations is a core platform endpoint, not a seren-db endpoint,
// so it comes from the core client.
import {
  listOrganizations as apiListOrganizations,
  type Organization,
} from "@/api";
import {
  serenDbCreateBranch as apiCreateBranch,
  serenDbCreateDatabase as apiCreateDatabase,
  serenDbCreateProject as apiCreateProject,
  serenDbDeleteProject as apiDeleteProject,
  serenDbGetBranch as apiGetBranch,
  serenDbConnectionUri as apiGetConnectionUri,
  serenDbGetDatabase as apiGetDatabase,
  serenDbGetProject as apiGetProject,
  serenDbListBranches as apiListBranches,
  serenDbListDatabases as apiListDatabases,
  serenDbListProjects as apiListProjects,
  type Branch,
  type DatabaseWithOwner,
  type Project,
  type QueryResult,
} from "@/api/seren-db";

// Use DatabaseWithOwner as the Database type (list endpoint returns this)
export type Database = DatabaseWithOwner;

// Re-export types for backwards compatibility
export type { Branch, Organization, Project };

/**
 * Format a seren-db management-call failure so it carries the HTTP status (and
 * any short server detail) using the same `returned HTTP <status>` marker the
 * Rust SQL client emits. Without this, a 403 on the seren-db management path
 * (most likely on `createProject` for a brand-new user) reaches the Claude
 * memory interceptor as an opaque "Failed to X" — defeating the App.tsx dialog
 * classifier and the support telemetry that seren-core#187 needs to correlate
 * the 403. The status drives downstream classification; raw bodies are never
 * shown to the user. #2497 (NEW P1-b).
 */
function describeSerenDbError(
  action: string,
  error: unknown,
  response: { status?: number } | undefined,
): string {
  const status = response?.status;
  let detail = "";
  if (error && typeof error === "object") {
    const candidate =
      "message" in error
        ? (error as { message?: unknown }).message
        : "error" in error
          ? (error as { error?: unknown }).error
          : undefined;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      detail = `: ${candidate.trim().slice(0, 200)}`;
    }
  }
  return typeof status === "number"
    ? `Failed to ${action}: returned HTTP ${status}${detail}`
    : `Failed to ${action}${detail}`;
}

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
    const { data, error, response } = await apiListProjects({
      throwOnError: false,
    });
    if (error) {
      console.error("[Databases] Error fetching projects:", error);
      throw new Error(describeSerenDbError("list projects", error, response));
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
    const { data, error, response } = await apiCreateProject({
      body: { name, region: "aws-us-east-2" },
      throwOnError: false,
    });
    if (error || !data?.data) {
      console.error("[Databases] Error creating project:", error);
      throw new Error(describeSerenDbError("create project", error, response));
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
      path: { id: projectId },
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
    const { data, error, response } = await apiListBranches({
      path: { id: projectId },
      throwOnError: false,
    });
    if (error) {
      console.error("[Databases] Error fetching branches:", error);
      throw new Error(describeSerenDbError("list branches", error, response));
    }
    const branches = data?.data || [];
    console.log("[Databases] Found", branches.length, "branches");
    return branches;
  },

  /**
   * Create a new branch in a project.
   */
  async createBranch(projectId: string, name: string): Promise<Branch> {
    console.log("[Databases] Creating branch:", name, "in project:", projectId);
    const { data, error } = await apiCreateBranch({
      path: { id: projectId },
      body: { name, add_endpoint: true },
      throwOnError: false,
    });
    if (error || !data?.data?.branch) {
      console.error("[Databases] Error creating branch:", error);
      throw new Error("Failed to create branch");
    }
    return this.getBranch(projectId, data.data.branch.id);
  },

  /**
   * Get connection string for a branch.
   */
  async getConnectionString(
    projectId: string,
    branchId: string,
  ): Promise<string> {
    console.log("[Databases] Fetching connection string");
    const { data, error } = await apiGetConnectionUri({
      path: { id: projectId },
      query: { branch_id: branchId },
      throwOnError: false,
    });
    if (error || !data?.data) {
      console.error("[Databases] Error fetching connection string:", error);
      throw new Error("Failed to get connection string");
    }
    return data.data.uri;
  },

  /**
   * List all databases for a branch.
   */
  async listDatabases(
    projectId: string,
    branchId: string,
  ): Promise<Database[]> {
    console.log("[Databases] Fetching databases for branch:", branchId);
    const { data, error, response } = await apiListDatabases({
      path: { id: projectId, bid: branchId },
      throwOnError: false,
    });
    if (error) {
      console.error("[Databases] Error fetching databases:", error);
      throw new Error(describeSerenDbError("list databases", error, response));
    }
    const dbs = data?.data || [];
    console.log("[Databases] Found", dbs.length, "databases");
    return dbs;
  },

  /**
   * Create a new database on a branch.
   * Wraps `serenDbCreateDatabase`.
   */
  async createDatabase(
    projectId: string,
    branchId: string,
    name: string,
    ownerName?: string,
  ): Promise<{ id: string; name: string; branch_id: string }> {
    console.log(
      "[Databases] Creating database:",
      name,
      "in project:",
      projectId,
      "branch:",
      branchId,
    );
    const { data, error, response } = await apiCreateDatabase({
      path: { id: projectId, bid: branchId },
      body: { name, owner_name: ownerName ?? null },
      throwOnError: false,
    });
    if (error || !data?.data) {
      console.error("[Databases] Error creating database:", error);
      throw new Error(describeSerenDbError("create database", error, response));
    }
    return {
      id: data.data.id,
      name: data.data.name,
      branch_id: data.data.branch_id,
    };
  },

  /**
   * Execute a SQL statement against a SerenDB database through the Rust
   * Tauri command `claude_memory_run_sql`, which wraps the same
   * `SerenDbSqlClient` (reqwest + SerenDB API key) that the filesystem
   * watcher uses for every intercepted write.
   *
   * Three earlier attempts all failed for different reasons:
   *
   *   1. The hey-api SDK client routed through the gateway bridge, which
   *      injects the OAuth bearer token — but `/publishers/seren-db/query`
   *      authenticates with the SerenDB API key (HTTP 500, #1511).
   *   2. A direct cross-origin `fetch()` from the webview was blocked by
   *      CORS (`TypeError: Load failed`, #1512).
   *   3. Routing through `callSerenTool("run_sql")` via the Seren MCP
   *      gateway works architecturally but fails in environments where
   *      `mcp.serendb.com` is unreachable — the readiness guard just
   *      surfaces the timeout instead of hanging indefinitely (#1513).
   *
   * Going through Rust bypasses both webview CORS and the MCP gateway,
   * and uses the credential (SerenDB API key) the endpoint actually
   * expects. The query is executed read-write unless `readOnly` is true.
   */
  async runSql(
    projectId: string,
    branchId: string | null,
    databaseName: string | null,
    query: string,
    readOnly: boolean = false,
  ): Promise<QueryResult> {
    return await invoke<QueryResult>("claude_memory_run_sql", {
      projectId,
      branchId: branchId ?? null,
      databaseName: databaseName ?? null,
      query,
      readOnly,
    });
  },

  /**
   * Get a single project by ID.
   */
  async getProject(projectId: string): Promise<Project> {
    const { data, error, response } = await apiGetProject({
      path: { id: projectId },
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error(describeSerenDbError("get project", error, response));
    }
    return data.data;
  },

  /**
   * Get a single branch by ID.
   */
  async getBranch(projectId: string, branchId: string): Promise<Branch> {
    const { data, error } = await apiGetBranch({
      path: { id: projectId, bid: branchId },
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
        id: projectId,
        bid: branchId,
        did: databaseId,
      },
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error("Failed to get database");
    }
    return data.data;
  },
};
