// ABOUTME: Regression tests for public Seren Skills publish preflight.
// ABOUTME: Ensures public/paid publish paths fail fast when org folders are missing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledSkill } from "@/lib/skills";

const mockCreateSkill = vi.hoisted(() => vi.fn());
const mockCreateOrgFolder = vi.hoisted(() => vi.fn());
const mockCreateVersion = vi.hoisted(() => vi.fn());
const mockGetAuthorIdentity = vi.hoisted(() => vi.fn());
const mockGetCurrentUser = vi.hoisted(() => vi.fn());
const mockGetOrgFolder = vi.hoisted(() => vi.fn());
const mockListOrganizations = vi.hoisted(() => vi.fn());
const mockUpdateSkill = vi.hoisted(() => vi.fn());
const mockUpsertAuthorIdentity = vi.hoisted(() => vi.fn());
const mockInvoke = vi.hoisted(() => vi.fn());
const mockGetDefaultOrganizationId = vi.hoisted(() => vi.fn());

vi.mock("@/api", () => ({
  getCurrentUser: mockGetCurrentUser,
  listOrganizations: mockListOrganizations,
}));

vi.mock("@/api/seren-skills", () => ({
  createOrgFolder: mockCreateOrgFolder,
  createSkill: mockCreateSkill,
  createVersion: mockCreateVersion,
  deleteSkill: vi.fn(),
  downloadSkill: vi.fn(),
  downloadSkillFile: vi.fn(),
  downloadSkillManifest: vi.fn(),
  getAuthorIdentity: mockGetAuthorIdentity,
  getOrgFolder: mockGetOrgFolder,
  listSkills: vi.fn(),
  updateSkill: mockUpdateSkill,
  upsertAuthorIdentity: mockUpsertAuthorIdentity,
}));

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/runtime-console", () => ({
  verboseRuntimeConsole: { debug: vi.fn() },
}));

vi.mock("@/lib/tauri-bridge", () => ({
  getDefaultOrganizationId: mockGetDefaultOrganizationId,
  isTauriRuntime: () => true,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const installedSkill: InstalledSkill = {
  id: "local:recorded-payroll",
  slug: "recorded-payroll",
  name: "recorded-payroll",
  displayName: "Recorded Payroll",
  description: "Submit payroll.",
  source: "local",
  tags: ["recorded", "unverified"],
  scope: "seren",
  skillsDir: "/Users/test/Seren/skills",
  dirName: "recorded-payroll",
  path: "/Users/test/Seren/skills/recorded-payroll/SKILL.md",
  installedAt: 1,
  enabled: true,
  contentHash: "hash",
};

function publishResponse() {
  return {
    data: {
      data: {
        access: {
          can_download: true,
          can_edit: true,
          can_manage: true,
          can_view: true,
          reason: "owner",
        },
        slug: "recorded-payroll",
        name: "Recorded Payroll",
        description: "Submit payroll.",
        visibility: "private",
        discoverability: "listed",
        status: "published",
        created_at: "2026-06-22T00:00:00Z",
        created_by_user_id: "user-1",
        github_mirror_health: "pending",
        id: "skill-1",
        install_count: 0,
        owner_kind: "organization",
        owner_organization_id: "org-1",
        price_cents: 0,
        skill_folder_name: "recorded-payroll",
        updated_at: "2026-06-22T00:00:00Z",
      },
    },
    error: null,
    response: { status: 200 },
  };
}

describe("skills publish org folder preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultOrganizationId.mockResolvedValue("org-1");
    mockGetOrgFolder.mockResolvedValue({
      data: { folder_slug: "acme" },
      error: null,
      response: { status: 200 },
    });
    mockCreateOrgFolder.mockResolvedValue({
      data: { folder_slug: "acme" },
      error: null,
      response: { status: 200 },
    });
    mockGetAuthorIdentity.mockResolvedValue({
      data: {
        display_name: "Existing User",
        git_email: "existing@example.com",
        updated_at: "2026-06-22T00:00:00Z",
        user_id: "user-1",
      },
      error: null,
      response: { status: 200 },
    });
    mockGetCurrentUser.mockResolvedValue({
      data: {
        data: {
          avatar_url: null,
          created_at: "2026-06-22T00:00:00Z",
          default_organization_id: "org-1",
          email: "christian@example.com",
          id: "user-1",
          name: "Christian",
          status: "active",
        },
      },
      error: null,
      response: { status: 200 },
    });
    mockListOrganizations.mockResolvedValue({
      data: {
        data: [
          {
            created_at: "2026-06-22T00:00:00Z",
            created_by: "user-1",
            id: "org-1",
            is_personal: false,
            name: "Acme Team",
            slug: "acme-team",
            updated_at: "2026-06-22T00:00:00Z",
          },
        ],
      },
      error: null,
      response: { status: 200 },
    });
    mockUpsertAuthorIdentity.mockResolvedValue({
      data: {
        display_name: "Christian",
        git_email: "christian@example.com",
        updated_at: "2026-06-22T00:00:00Z",
        user_id: "user-1",
      },
      error: null,
      response: { status: 200 },
    });
    mockCreateSkill.mockResolvedValue(publishResponse());
    mockCreateVersion.mockResolvedValue({
      data: undefined,
      error: null,
      response: { status: 200 },
    });
    mockUpdateSkill.mockResolvedValue({
      data: undefined,
      error: null,
      response: { status: 200 },
    });
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "read_skill_content") {
        return "---\nname: recorded-payroll\ndescription: Submit payroll.\n---\n";
      }
      if (command === "list_skill_payload_files") return [];
      return null;
    });
  });

  it("does not preflight private skill publishing", async () => {
    const { skills } = await import("@/services/skills");

    const published = await skills.publishLocalSkill(installedSkill, {
      visibility: "private",
      version: "0.1.0",
    });

    expect(mockGetOrgFolder).not.toHaveBeenCalled();
    expect(mockCreateOrgFolder).not.toHaveBeenCalled();
    expect(mockGetAuthorIdentity).not.toHaveBeenCalled();
    expect(mockUpsertAuthorIdentity).not.toHaveBeenCalled();
    expect(mockCreateSkill).toHaveBeenCalledOnce();
    expect(published).toMatchObject({
      id: "skill-1",
      slug: "recorded-payroll",
    });
  });

  it("preflights public skill publishing against the default organization", async () => {
    const { skills } = await import("@/services/skills");

    await skills.publishLocalSkill(installedSkill, {
      visibility: "public",
      version: "0.1.0",
    });

    expect(mockGetOrgFolder).toHaveBeenCalledWith({
      path: { org_id: "org-1" },
      throwOnError: false,
    });
    expect(mockCreateOrgFolder).not.toHaveBeenCalled();
    expect(mockGetAuthorIdentity).toHaveBeenCalledWith({
      throwOnError: false,
    });
    expect(mockUpsertAuthorIdentity).not.toHaveBeenCalled();
    expect(mockCreateSkill).toHaveBeenCalledOnce();
  });

  it("configures Git author identity when public publishing has none", async () => {
    mockGetAuthorIdentity.mockResolvedValue({
      data: undefined,
      error: {},
      response: { status: 404 },
    });
    const { skills } = await import("@/services/skills");

    await skills.publishLocalSkill(installedSkill, {
      visibility: "public",
      version: "0.1.0",
    });

    expect(mockGetCurrentUser).toHaveBeenCalledWith({
      throwOnError: false,
    });
    expect(mockUpsertAuthorIdentity).toHaveBeenCalledWith({
      body: {
        display_name: "Christian",
        git_email: "christian@example.com",
      },
      throwOnError: false,
    });
    expect(mockCreateSkill).toHaveBeenCalledOnce();
  });

  it("falls back to email for Git author display name", async () => {
    mockGetAuthorIdentity.mockResolvedValue({
      data: undefined,
      error: {},
      response: { status: 404 },
    });
    mockGetCurrentUser.mockResolvedValue({
      data: {
        data: {
          avatar_url: null,
          created_at: "2026-06-22T00:00:00Z",
          default_organization_id: "org-1",
          email: " christian@example.com ",
          id: "user-1",
          name: null,
          status: "active",
        },
      },
      error: null,
      response: { status: 200 },
    });
    const { skills } = await import("@/services/skills");

    await skills.publishLocalSkill(installedSkill, {
      visibility: "public",
      version: "0.1.0",
    });

    expect(mockUpsertAuthorIdentity).toHaveBeenCalledWith({
      body: {
        display_name: "christian@example.com",
        git_email: "christian@example.com",
      },
      throwOnError: false,
    });
    expect(mockCreateSkill).toHaveBeenCalledOnce();
  });

  it("fails fast when Git author email is missing", async () => {
    mockGetAuthorIdentity.mockResolvedValue({
      data: undefined,
      error: {},
      response: { status: 404 },
    });
    mockGetCurrentUser.mockResolvedValue({
      data: {
        data: {
          avatar_url: null,
          created_at: "2026-06-22T00:00:00Z",
          default_organization_id: "org-1",
          email: "   ",
          id: "user-1",
          name: "Christian",
          status: "active",
        },
      },
      error: null,
      response: { status: 200 },
    });
    const { skills } = await import("@/services/skills");

    await expect(
      skills.publishLocalSkill(installedSkill, {
        visibility: "public",
        version: "0.1.0",
      }),
    ).rejects.toThrow("account name and email");

    expect(mockUpsertAuthorIdentity).not.toHaveBeenCalled();
    expect(mockCreateSkill).not.toHaveBeenCalled();
  });

  it("preflights public visibility changes", async () => {
    const { skills } = await import("@/services/skills");

    await skills.updatePublishedMetadata("recorded-payroll", {
      visibility: "public",
    });

    expect(mockGetOrgFolder).toHaveBeenCalledWith({
      path: { org_id: "org-1" },
      throwOnError: false,
    });
    expect(mockGetAuthorIdentity).toHaveBeenCalledWith({
      throwOnError: false,
    });
    expect(mockUpdateSkill).toHaveBeenCalledWith({
      path: { slug: "recorded-payroll" },
      body: { visibility: "public" },
      throwOnError: false,
    });
  });

  it("preflights public version publishing", async () => {
    const { skills } = await import("@/services/skills");
    const publicSkill: InstalledSkill = {
      ...installedSkill,
      publisher: {
        createdByUserId: "user-1",
        ownerUserId: null,
        visibility: "public",
        discoverability: "listed",
        publishStatus: "published",
      },
    };

    await skills.publishNewVersion(publicSkill, {
      version: "0.1.1",
      changelog: "Review updates.",
    });

    expect(mockGetOrgFolder).toHaveBeenCalledWith({
      path: { org_id: "org-1" },
      throwOnError: false,
    });
    expect(mockGetAuthorIdentity).toHaveBeenCalledWith({
      throwOnError: false,
    });
    expect(mockCreateVersion).toHaveBeenCalledWith({
      path: { slug: "recorded-payroll" },
      body: {
        version: "0.1.1",
        skill_md:
          "---\nname: recorded-payroll\ndescription: Submit payroll.\n---\n",
        files: null,
        changelog: "Review updates.",
      },
      throwOnError: false,
    });
  });

  it("creates the default org folder when public publishing has no configured folder", async () => {
    mockGetOrgFolder.mockResolvedValue({
      data: undefined,
      error: {},
      response: { status: 404 },
    });
    const { skills } = await import("@/services/skills");

    await skills.publishLocalSkill(installedSkill, {
      visibility: "public",
      version: "0.1.0",
    });

    expect(mockCreateOrgFolder).toHaveBeenCalledWith({
      path: { org_id: "org-1" },
      body: { folder_slug: "acme-team" },
      throwOnError: false,
    });
    expect(mockCreateSkill).toHaveBeenCalledOnce();
  });

  it("fails fast when org folder creation requires admin permission", async () => {
    mockGetOrgFolder.mockResolvedValue({
      data: undefined,
      error: {},
      response: { status: 404 },
    });
    mockCreateOrgFolder.mockResolvedValue({
      data: undefined,
      error: {},
      response: { status: 403 },
    });
    const { skills } = await import("@/services/skills");

    await expect(
      skills.publishLocalSkill(installedSkill, {
        visibility: "public",
        version: "0.1.0",
      }),
    ).rejects.toThrow("permission to create");

    expect(mockCreateSkill).not.toHaveBeenCalled();
  });

  it("fails fast when the derived org folder slug is already used", async () => {
    mockGetOrgFolder.mockResolvedValue({
      data: undefined,
      error: {},
      response: { status: 404 },
    });
    mockCreateOrgFolder.mockResolvedValue({
      data: undefined,
      error: {},
      response: { status: 409 },
    });
    const { skills } = await import("@/services/skills");

    await expect(
      skills.publishLocalSkill(installedSkill, {
        visibility: "public",
        version: "0.1.0",
      }),
    ).rejects.toThrow("already used");

    expect(mockCreateSkill).not.toHaveBeenCalled();
  });
});
