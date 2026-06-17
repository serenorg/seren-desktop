// ABOUTME: #2497 NEW P1-b — seren-db management helpers must carry the HTTP
// ABOUTME: status so a new-user 403 on createProject/listProjects is classifiable.

import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  serenDbListProjects: vi.fn(),
  serenDbCreateProject: vi.fn(),
  serenDbGetProject: vi.fn(),
  serenDbListBranches: vi.fn(),
  serenDbListDatabases: vi.fn(),
  serenDbCreateDatabase: vi.fn(),
  serenDbCreateBranch: vi.fn(),
  serenDbDeleteProject: vi.fn(),
  serenDbGetBranch: vi.fn(),
  serenDbConnectionUri: vi.fn(),
  serenDbGetDatabase: vi.fn(),
  listOrganizations: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@/api/seren-db", () => ({
  serenDbListProjects: sdk.serenDbListProjects,
  serenDbCreateProject: sdk.serenDbCreateProject,
  serenDbGetProject: sdk.serenDbGetProject,
  serenDbListBranches: sdk.serenDbListBranches,
  serenDbListDatabases: sdk.serenDbListDatabases,
  serenDbCreateDatabase: sdk.serenDbCreateDatabase,
  serenDbCreateBranch: sdk.serenDbCreateBranch,
  serenDbDeleteProject: sdk.serenDbDeleteProject,
  serenDbGetBranch: sdk.serenDbGetBranch,
  serenDbConnectionUri: sdk.serenDbConnectionUri,
  serenDbGetDatabase: sdk.serenDbGetDatabase,
}));

vi.mock("@/api", () => ({
  listOrganizations: sdk.listOrganizations,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: sdk.invoke,
}));

import { databases } from "@/services/databases";

const forbidden = {
  data: undefined,
  error: { error: "Database management requires a user-scoped API key or JWT." },
  response: { status: 403 },
};

describe("seren-db management error status (#2497 NEW P1-b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listProjects surfaces a 403 with the `returned HTTP 403` marker", async () => {
    sdk.serenDbListProjects.mockResolvedValueOnce(forbidden);
    await expect(databases.listProjects()).rejects.toThrow(/returned HTTP 403/);
  });

  it("createProject surfaces a 403 with the `returned HTTP 403` marker", async () => {
    sdk.serenDbCreateProject.mockResolvedValueOnce(forbidden);
    await expect(databases.createProject("claude-agent-prefs")).rejects.toThrow(
      /returned HTTP 403/,
    );
    // Must fail before attempting to fetch full details.
    expect(sdk.serenDbGetProject).not.toHaveBeenCalled();
  });

  it("createDatabase surfaces a 403 with the `returned HTTP 403` marker", async () => {
    sdk.serenDbCreateDatabase.mockResolvedValueOnce(forbidden);
    await expect(
      databases.createDatabase("p1", "b1", "claude_agent_prefs"),
    ).rejects.toThrow(/returned HTTP 403/);
  });

  it("falls back to a status-less message when the server gave no response", async () => {
    sdk.serenDbListProjects.mockResolvedValue({
      data: undefined,
      error: { message: "network down" },
      response: undefined,
    });
    const err = await databases.listProjects().then(
      () => {
        throw new Error("expected listProjects to reject");
      },
      (e) => e as Error,
    );
    expect(err.message).toMatch(/Failed to list projects/);
    expect(err.message).not.toMatch(/returned HTTP/);
  });
});
