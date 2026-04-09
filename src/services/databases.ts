// ABOUTME: Database service for fetching SerenDB database data from Seren API.
// ABOUTME: Uses generated hey-api SDK for type-safe API calls.

// listOrganizations is a core platform endpoint, not a seren-db endpoint,
// so it comes from the core client.
import {
  listOrganizations as apiListOrganizations,
  type Organization,
} from "@/api";
import {
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
import {
  callSerenTool,
  isGatewayInitialized,
  waitForGatewayReady,
} from "@/services/mcp-gateway";

/**
 * Maximum time to wait for the Seren MCP gateway to become ready before
 * a SQL call gives up. The gateway typically initializes in <2s after
 * login, but cold starts and slow networks can push it longer.
 */
const MCP_GATEWAY_READY_TIMEOUT_MS = 30_000;

// Use DatabaseWithOwner as the Database type (list endpoint returns this)
export type Database = DatabaseWithOwner;

// Re-export types for backwards compatibility
export type { Branch, Organization, Project };

// ---------------------------------------------------------------------------
// MCP response parsers for `run_sql` tool calls
// ---------------------------------------------------------------------------

interface McpTextContent {
  type: string;
  text?: string;
}

/**
 * Extract the first text payload from an MCP tool result. Used for both the
 * success case (JSON-encoded QueryResult) and the error case (plain error
 * string).
 */
export function extractMcpText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  for (const item of content as McpTextContent[]) {
    if (
      item &&
      typeof item === "object" &&
      item.type === "text" &&
      typeof item.text === "string"
    ) {
      return item.text;
    }
  }
  return "";
}

/**
 * Parse a `QueryResult` out of the MCP `run_sql` tool response. The tool
 * returns a JSON-encoded object in a text content item. We accept both the
 * bare shape `{ columns, row_count, rows }` and a wrapped envelope
 * `{ data: { columns, row_count, rows } }` because callers in the wild
 * have seen both.
 */
export function parseQueryResultFromMcp(content: unknown): QueryResult {
  const text = extractMcpText(content);
  if (!text) {
    throw new Error(
      "SerenDB run_sql returned no text content; cannot parse result",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `SerenDB run_sql returned non-JSON text: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const body =
    parsed &&
    typeof parsed === "object" &&
    "data" in parsed &&
    typeof (parsed as { data: unknown }).data === "object" &&
    (parsed as { data: unknown }).data !== null
      ? (parsed as { data: unknown }).data
      : parsed;

  if (!body || typeof body !== "object") {
    throw new Error(
      `SerenDB run_sql returned an unexpected shape: ${text.slice(0, 200)}`,
    );
  }
  const b = body as {
    columns?: unknown;
    row_count?: unknown;
    rows?: unknown;
  };
  const columns = Array.isArray(b.columns) ? (b.columns as string[]) : [];
  const rowCount = typeof b.row_count === "number" ? b.row_count : 0;
  const rows = Array.isArray(b.rows) ? (b.rows as unknown[][]) : [];
  return { columns, row_count: rowCount, rows };
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
    const { data, error } = await apiListBranches({
      path: { id: projectId },
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
    const { data, error } = await apiListDatabases({
      path: { id: projectId, bid: branchId },
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
    const { data, error } = await apiCreateDatabase({
      path: { id: projectId, bid: branchId },
      body: { name, owner_name: ownerName ?? null },
      throwOnError: false,
    });
    if (error || !data?.data) {
      console.error("[Databases] Error creating database:", error);
      throw new Error("Failed to create database");
    }
    return {
      id: data.data.id,
      name: data.data.name,
      branch_id: data.data.branch_id,
    };
  },

  /**
   * Execute a SQL statement against a SerenDB database via the **Seren MCP
   * gateway** (`mcp.serendb.com`).
   *
   * Earlier attempts used the `/publishers/seren-db/query` REST endpoint
   * directly, first via the hey-api SDK (wrong credential — gateway bridge
   * injects OAuth bearer, not the API key) and then via a direct `fetch()`
   * (blocked by webview CORS with `TypeError: Load failed`). The MCP
   * gateway is the canonical path the rest of the app already uses for
   * SerenDB tool calls: auth is handled by the established MCP connection,
   * there is no CORS (the HTTP MCP client lives in Rust via `rmcp`), and
   * the `run_sql` tool is a first-class gateway tool exposed through
   * `callSerenTool(...)`.
   *
   * The query is executed read-write unless `readOnly` is true.
   */
  async runSql(
    projectId: string,
    branchId: string | null,
    databaseName: string | null,
    query: string,
    readOnly: boolean = false,
  ): Promise<QueryResult> {
    // The Seren MCP gateway initializes asynchronously after login. If a
    // caller (e.g. the Claude memory interceptor's reactive boot hook)
    // races the gateway init, `callSerenTool` would throw
    // "MCP Gateway not connected". Wait for the gateway to be ready first
    // — this is a no-op fast path when it's already initialized.
    if (!isGatewayInitialized()) {
      const ready = await waitForGatewayReady(MCP_GATEWAY_READY_TIMEOUT_MS);
      if (!ready) {
        throw new Error(
          `Seren MCP gateway did not become ready within ${
            MCP_GATEWAY_READY_TIMEOUT_MS / 1000
          }s — cannot run SQL`,
        );
      }
    }

    const args: Record<string, unknown> = {
      project_id: projectId,
      query,
      read_only: readOnly,
    };
    if (branchId) {
      args.branch_id = branchId;
    }
    if (databaseName) {
      args.database = databaseName;
    }

    const response = await callSerenTool("run_sql", args);

    if (response.is_error) {
      const errText = extractMcpText(response.result);
      throw new Error(`SerenDB run_sql failed: ${errText || "unknown error"}`);
    }

    return parseQueryResultFromMcp(response.result);
  },

  /**
   * Get a single project by ID.
   */
  async getProject(projectId: string): Promise<Project> {
    const { data, error } = await apiGetProject({
      path: { id: projectId },
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
