// ABOUTME: Skills management panel with unified installed-and-catalog list.
// ABOUTME: Renders inside SlidePanel with chip filters (All / Installed / Needs sync) and an inline detail accordion.

import { createInfiniteQuery } from "@tanstack/solid-query";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  type Component,
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { CreateSkillModal } from "@/components/sidebar/CreateSkillModal";
import { ManageSkillModal } from "@/components/sidebar/ManageSkillModal";
import { openExternalLink } from "@/lib/external-link";
import { appFetch } from "@/lib/fetch";
import { openFileInTab } from "@/lib/files/service";
import {
  encodeSkillDragPayload,
  encodeSkillDragText,
  SKILL_DRAG_MIME,
  setCurrentSkillDragPayload,
  skillPromptTextForSkill,
} from "@/lib/skill-drag";
import type {
  InstalledSkill,
  Skill,
  SkillScope,
  SkillSyncStatus,
} from "@/lib/skills";
import {
  normalizeSkillSlug,
  parseSkillMd,
  resolveSkillDisplayName,
  resolveSkillListDisplayName,
} from "@/lib/skills";
import { RUN_SKILL_EVENT } from "@/lib/skills/invoke";
import {
  isUpstreamManagedSkill,
  skills as skillsService,
} from "@/services/skills";
import { skillsCatalogOptions } from "@/services/skills-query";
import { authStore } from "@/stores/auth.store";
import { fileTreeState } from "@/stores/fileTree";
import { skillPublishStore } from "@/stores/skill-publish.store";
import { type RefreshSummary, skillsStore } from "@/stores/skills.store";
import { threadStore } from "@/stores/thread.store";

interface SkillsExplorerProps {
  collapsed?: boolean;
  panelMode?: boolean;
}

type Filter = "all" | "installed" | "needs-sync";

const SKILL_CREATOR_SLUG = "skill-creator";
const SKILL_CREATOR_SOURCE_URL = `seren-skills:${SKILL_CREATOR_SLUG}`;

const PlayIcon: Component = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="currentColor"
    role="img"
    aria-label="Run"
  >
    <path d="M4 2.5v11l10-5.5z" />
  </svg>
);

const CloudUpIcon: Component = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.3"
    stroke-linecap="round"
    stroke-linejoin="round"
    role="img"
    aria-label="Publish"
  >
    <path d="M4 12.5a3 3 0 0 1-.6-5.94 4 4 0 0 1 7.85-1.06A3 3 0 0 1 12 12.5h-1.5" />
    <path d="M8 8v6" />
    <path d="M5.5 10L8 7.5 10.5 10" />
  </svg>
);

const SettingsIcon: Component = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.3"
    stroke-linecap="round"
    stroke-linejoin="round"
    role="img"
    aria-label="Manage"
  >
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" />
  </svg>
);

export const SkillsExplorer: Component<SkillsExplorerProps> = (props) => {
  const [activeFilter, setActiveFilter] = createSignal<Filter>("all");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [expandedSkillId, setExpandedSkillId] = createSignal<string | null>(
    null,
  );
  const [detailContent, setDetailContent] = createSignal<string | null>(null);
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [manageSkillSlug, setManageSkillSlug] = createSignal<string | null>(
    null,
  );
  const [showUrlDialog, setShowUrlDialog] = createSignal(false);
  const [installUrl, setInstallUrl] = createSignal("");
  const [urlInstalling, setUrlInstalling] = createSignal(false);
  const [actionInProgress, setActionInProgress] = createSignal<string | null>(
    null,
  );
  const [refreshStatus, setRefreshStatus] = createSignal<string | null>(null);
  const [installWarning, setInstallWarning] = createSignal<{
    slug: string;
    missingFiles: string[];
  } | null>(null);
  const [installError, setInstallError] = createSignal<{
    slug: string;
    message: string;
  } | null>(null);
  const [syncStatuses, setSyncStatuses] = createSignal<
    Record<string, SkillSyncStatus | null | undefined>
  >({});
  const [syncLoading, setSyncLoading] = createSignal<Record<string, boolean>>(
    {},
  );
  let contentRef: HTMLDivElement | undefined;
  let refreshStatusTimer: ReturnType<typeof setTimeout> | null = null;
  const availableSkillsQuery = createInfiniteQuery(() =>
    skillsCatalogOptions(searchQuery()),
  );

  // ── Derived values ──────────────────────────────

  const syncStatusFor = (skill: InstalledSkill) => syncStatuses()[skill.path];

  const skillNeedsSync = (skill: InstalledSkill): boolean => {
    const status = syncStatusFor(skill);
    if (!status) return false;
    return (
      status.updateAvailable ||
      status.hasLocalChanges ||
      status.state === "bootstrap-required"
    );
  };

  // Ownership is decided by the publisher record, which only exists on
  // catalog-side Skills. For installed rows we cross-reference by slug. The
  // identity check uses authStore.user.id; a user signed out cannot own
  // anything.
  const findCatalogBySlug = (slug: string): Skill | undefined =>
    skillsStore.available.find((s) => s.slug === slug);

  const displayNameFor = (skill: Skill | InstalledSkill): string =>
    resolveSkillListDisplayName(skill, skillsStore.available);

  const ownsSkill = (skill: Skill | InstalledSkill): boolean => {
    const userId = authStore.user?.id;
    if (!userId) return false;
    const publisher =
      skill.publisher ?? findCatalogBySlug(skill.slug)?.publisher;
    return publisher?.createdByUserId === userId;
  };

  const handleManageChanged = async () => {
    await skillsStore.refreshAvailable(true);
    await skillsStore.refreshOwnedSkills();
  };

  // A skill is "publishable from desktop" when it's installed locally and has
  // no matching record on Seren Skills yet. Skills imported from the catalog
  // already have a record (and are owned by someone else, usually).
  const isPublishable = (skill: InstalledSkill): boolean => {
    if (!authStore.user?.id) return false;
    if (findCatalogBySlug(skill.slug)) return false;
    return true;
  };

  // The user is allowed to push a new version when they own the catalog
  // record. We don't auto-detect "are there local changes" - the user
  // decides whether the current SKILL.md is worth shipping as a new version.
  const canPublishUpdate = (skill: InstalledSkill): boolean => ownsSkill(skill);

  const handlePublishClick = (skill: InstalledSkill) => {
    const path = editablePathFor(skill);
    if (isPublishable(skill)) {
      skillPublishStore.requestFirstPublish(path);
    } else if (canPublishUpdate(skill)) {
      skillPublishStore.requestVersionPublish(path);
    }
  };

  const matchesQuery = (skill: Skill | InstalledSkill, q: string): boolean => {
    if (!q) return true;
    const displayName = displayNameFor(skill).toLowerCase();
    return (
      displayName.includes(q) ||
      skill.name.toLowerCase().includes(q) ||
      skill.slug.toLowerCase().includes(q) ||
      (skill.description ?? "").toLowerCase().includes(q) ||
      skill.tags.some((t) => t.toLowerCase().includes(q)) ||
      (skill.author?.toLowerCase().includes(q) ?? false)
    );
  };

  const installedRows = (): InstalledSkill[] => {
    const q = searchQuery().toLowerCase().trim();
    const filter = activeFilter();
    return skillsStore.installed
      .filter((skill) => {
        if (!matchesQuery(skill, q)) return false;
        if (filter === "needs-sync") return skillNeedsSync(skill);
        return true;
      })
      .slice()
      .sort((a, b) => displayNameFor(a).localeCompare(displayNameFor(b)));
  };

  const availableRows = (): Skill[] => {
    if (activeFilter() !== "all") return [];
    const q = searchQuery().toLowerCase().trim();
    const installedSlugs = new Set(skillsStore.installed.map((s) => s.slug));
    return skillsStore.available.filter(
      (skill) => !installedSlugs.has(skill.slug) && matchesQuery(skill, q),
    );
  };

  const totalRowsToShow = () => installedRows().length + availableRows().length;
  const needsSyncCount = () =>
    skillsStore.installed.filter(skillNeedsSync).length;

  const isLoading = () =>
    skillsStore.isLoading ||
    (activeFilter() === "all" &&
      availableSkillsQuery.isLoading &&
      skillsStore.available.length === 0);
  const catalogError = () => {
    const error = availableSkillsQuery.error;
    if (error instanceof Error) return error.message;
    if (error) return "Failed to load skills";
    return skillsStore.error;
  };
  const browseTotal = () =>
    availableSkillsQuery.data?.pages.at(-1)?.total ?? null;
  const browseLoaded = () =>
    availableSkillsQuery.data?.pages.reduce(
      (count, page) => count + page.skills.length,
      0,
    ) ?? 0;

  const activeThreadContext = (): {
    kind: "chat" | "agent" | "terminal";
    projectRoot: string;
    threadId: string;
  } | null => {
    const thread = threadStore.activeThread;
    if (
      !thread ||
      (thread.kind !== "chat" &&
        thread.kind !== "agent" &&
        thread.kind !== "terminal")
    ) {
      return null;
    }
    const projectRoot = thread.projectRoot ?? fileTreeState.rootPath;
    if (!projectRoot) return null;
    return { kind: thread.kind, projectRoot, threadId: thread.id };
  };

  // Existing thread-skill attachments still load via `skillsStore` and the
  // agent-side context injection still respects them. We removed the UI for
  // creating new attachments because skills are tools-on-demand, not personas
  // that should sit in the system prompt on every turn. The slash palette, the
  // chip in the chat scrollback, and the composer Skills button are the new
  // invocation surfaces; thread-attach is a separate concept that may or may
  // not come back as an explicit "persona" affordance later.

  const setSyncLoadingFor = (path: string, isLoading: boolean) => {
    setSyncLoading((current) => ({ ...current, [path]: isLoading }));
  };

  const setSyncStatusFor = (
    path: string,
    status: SkillSyncStatus | null | undefined,
  ) => {
    setSyncStatuses((current) => ({ ...current, [path]: status }));
  };

  const loadSyncStatus = async (skill: InstalledSkill) => {
    if (!isUpstreamManagedSkill(skill)) {
      setSyncStatusFor(skill.path, null);
      return;
    }

    setSyncLoadingFor(skill.path, true);
    try {
      const status = await skillsService.inspectSyncStatus(skill);
      setSyncStatusFor(skill.path, status);
    } finally {
      setSyncLoadingFor(skill.path, false);
    }
  };

  const refreshAllSyncStatuses = async () => {
    await Promise.all(
      skillsStore.installed.map((skill) => loadSyncStatus(skill)),
    );
  };

  const updateCount = () =>
    skillsStore.installed.filter((skill) => {
      const status = syncStatusFor(skill);
      return status?.updateAvailable || status?.state === "bootstrap-required";
    }).length;

  const localChangesCount = () =>
    skillsStore.installed.filter(
      (skill) => syncStatusFor(skill)?.hasLocalChanges,
    ).length;

  const syncStatusLabel = (status: SkillSyncStatus | null | undefined) => {
    if (!status) return null;
    switch (status.state) {
      case "current":
        // Current is the default state; surfacing it adds visual noise
        // without telling the user anything actionable.
        return null;
      case "bootstrap-required":
        return "Sync required";
      case "update-available":
        return "Update available";
      case "local-changes":
        return "Local edits";
      case "error":
        return "Check failed";
      default:
        return null;
    }
  };

  const syncStatusClasses = (status: SkillSyncStatus | null | undefined) => {
    if (!status) {
      return "bg-surface-3 text-muted-foreground";
    }

    switch (status.state) {
      case "current":
        return "bg-success/10 text-success";
      case "bootstrap-required":
      case "update-available":
        return "bg-warning/10 text-warning";
      case "local-changes":
        return "bg-destructive/10 text-destructive";
      case "error":
        return "bg-surface-3 text-muted-foreground";
      default:
        return "bg-surface-3 text-muted-foreground";
    }
  };

  createEffect(() => {
    const pages = availableSkillsQuery.data?.pages;
    if (pages) {
      skillsStore.setAvailableCatalog(pages.flatMap((page) => page.skills));
    }
  });

  createEffect(() => {
    const error = availableSkillsQuery.error;
    if (error) {
      skillsStore.setAvailableError(error);
    }
  });

  createEffect(() => {
    if (activeFilter() !== "all") return;
    const element = contentRef;
    if (!element) return;
    if (
      availableSkillsQuery.hasNextPage &&
      !availableSkillsQuery.isFetchingNextPage &&
      element.scrollHeight <= element.clientHeight + 80
    ) {
      void availableSkillsQuery.fetchNextPage();
    }
  });

  const maybeLoadNextBrowsePage = (element: HTMLElement) => {
    if (activeFilter() !== "all") return;
    if (!availableSkillsQuery.hasNextPage) return;
    if (availableSkillsQuery.isFetchingNextPage) return;
    if (
      element.scrollTop + element.clientHeight >=
      element.scrollHeight - 240
    ) {
      void availableSkillsQuery.fetchNextPage();
    }
  };

  // ── Lifecycle ───────────────────────────────────

  onMount(async () => {
    await skillsStore.refreshInstalled();
    await ensureSkillCreatorInstalled();
    await refreshAllSyncStatuses();
  });

  const ensureSkillCreatorInstalled = async () => {
    const alreadyInstalled = skillsStore.installed.some(
      (s) => s.slug === SKILL_CREATOR_SLUG,
    );
    if (alreadyInstalled) return;

    try {
      const skill: Skill = {
        id: `seren:${SKILL_CREATOR_SLUG}`,
        slug: SKILL_CREATOR_SLUG,
        name: "Skill Creator",
        description:
          "Guide for creating effective skills. Use when users want to create or update a skill that extends capabilities with specialized knowledge, workflows, or tool integrations.",
        source: "seren",
        sourceUrl: SKILL_CREATOR_SOURCE_URL,
        tags: ["meta", "creation"],
        author: "SerenAI",
      };
      const content = await skillsService.fetchContent(skill);
      if (!content) return;
      const installed = await skillsStore.install(skill, content, "seren");
      await loadSyncStatus(installed);
    } catch (err) {
      console.error("[SkillsExplorer] Failed to install skill-creator:", err);
    }
  };

  const handleSkillDragStart = (
    event: DragEvent,
    skill: Skill | InstalledSkill,
  ) => {
    const payload = {
      id: skill.id,
      displayName: displayNameFor(skill),
      name: skill.name,
      slug: skill.slug,
      sourceUrl: skill.sourceUrl,
    };
    setCurrentSkillDragPayload(payload);
    event.dataTransfer?.setData(
      SKILL_DRAG_MIME,
      encodeSkillDragPayload(payload),
    );
    event.dataTransfer?.setData("text/plain", encodeSkillDragText(payload));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copy";
    }
  };

  const handleSkillDragEnd = () => {
    setCurrentSkillDragPayload(null);
  };

  onMount(() => {
    window.addEventListener("dragend", handleSkillDragEnd);
    window.addEventListener("drop", handleSkillDragEnd);
  });

  onCleanup(() => {
    window.removeEventListener("dragend", handleSkillDragEnd);
    window.removeEventListener("drop", handleSkillDragEnd);
    handleSkillDragEnd();
  });

  // ── Detail accordion ────────────────────────────

  const toggleDetail = async (skillId: string) => {
    if (expandedSkillId() === skillId) {
      setExpandedSkillId(null);
      setDetailContent(null);
      return;
    }

    setExpandedSkillId(skillId);
    setDetailContent(null);
    setDetailLoading(true);

    try {
      const installed = skillsStore.installed.find((s) => s.id === skillId);
      if (installed) {
        const content = await skillsService.readContent(installed);
        setDetailContent(content);
      } else {
        const available = skillsStore.available.find((s) => s.id === skillId);
        if (available) {
          const content = await skillsService.fetchContent(available);
          setDetailContent(content);
        }
      }
    } catch (err) {
      console.error("[SkillsExplorer] Failed to load skill content:", err);
      setDetailContent("Failed to load content.");
    } finally {
      setDetailLoading(false);
    }
  };

  // ── Install / Uninstall ─────────────────────────

  const pasteSkillIntoTerminal = async (
    bufferId: string,
    skill: Skill | InstalledSkill,
  ): Promise<void> => {
    const text = await skillPromptTextForSkill(skill);
    if (!text) {
      throw new Error(`Could not load SKILL.md for ${skill.slug}`);
    }
    let writeResult: Promise<boolean> | null = null;
    window.dispatchEvent(
      new CustomEvent("seren:terminal-paste-text", {
        detail: {
          bufferId,
          text,
          respond: (result: Promise<boolean>) => {
            writeResult = result;
          },
        },
      }),
    );
    if (!writeResult) {
      throw new Error("No active terminal pane accepted the paste request");
    }
    if (!(await writeResult)) {
      throw new Error("Terminal is not running");
    }
  };

  const runActionTitle = (): string => {
    const context = activeThreadContext();
    if (!context) return "Select a chat, agent, or terminal thread first";
    if (context.kind === "terminal") {
      return "Paste the SKILL.md prompt into the active terminal";
    }
    // Run in a chat/agent context fills the composer with `/slug `; the user
    // hits Enter to send. Consistent with the chip, recall, and palette
    // gestures — every skill surface drafts, none auto-submit.
    return "Insert /slug into the active chat composer";
  };

  const handleRunSkill = async (skill: InstalledSkill) => {
    const context = activeThreadContext();
    if (!context) return;

    setActionInProgress(skill.id);
    setInstallError(null);
    try {
      if (context.kind === "terminal") {
        await pasteSkillIntoTerminal(context.threadId, skill);
        return;
      }
      window.dispatchEvent(
        new CustomEvent(RUN_SKILL_EVENT, {
          detail: {
            kind: context.kind,
            threadId: context.threadId,
            skill,
          },
        }),
      );
    } catch (err) {
      console.error("[SkillsExplorer] Failed to run skill:", err);
      setInstallError({
        slug: skill.slug,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setActionInProgress(null);
    }
  };

  const handleAddCatalogSkill = async (
    skill: Skill,
    scope: SkillScope = "seren",
  ) => {
    setActionInProgress(skill.id);
    setInstallWarning(null);
    setInstallError(null);
    try {
      const content = await skillsService.fetchContent(skill);
      if (!content) {
        throw new Error(`No SKILL.md content available for ${skill.slug}`);
      }
      const installed = await skillsStore.install(skill, content, scope);
      await loadSyncStatus(installed);
      // Catalog install used to auto-attach the skill to the active thread
      // here. We removed that side effect: skills are tools-on-demand, not
      // personas. The user invokes via the Run button, the slash palette, or
      // the composer Skills button.

      // Validate payload after install
      const missingFiles = await skillsService.validatePayload(
        installed.skillsDir,
        installed.slug,
      );
      if (missingFiles.length > 0) {
        setInstallWarning({ slug: installed.slug, missingFiles });
      }
    } catch (err) {
      console.error("[SkillsExplorer] Failed to install:", err);
      setInstallError({
        slug: skill.slug,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUninstall = async (skill: InstalledSkill) => {
    setActionInProgress(skill.id);
    try {
      await skillsStore.remove(skill);
      setSyncStatusFor(skill.path, undefined);
      if (expandedSkillId() === skill.id) {
        setExpandedSkillId(null);
        setDetailContent(null);
      }
    } catch (err) {
      console.error("[SkillsExplorer] Failed to uninstall:", err);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRefreshAll = async () => {
    const [summary, catalogResult] = await Promise.all([
      skillsStore.refresh(true),
      availableSkillsQuery.refetch(),
    ]);
    if (catalogResult.data?.pages) {
      skillsStore.setAvailableCatalog(
        catalogResult.data.pages.flatMap((page) => page.skills),
      );
    }
    if (catalogResult.error) {
      skillsStore.setAvailableError(catalogResult.error);
    }
    await refreshAllSyncStatuses();
    showRefreshStatus(summary);
  };

  function showRefreshStatus(summary: RefreshSummary) {
    let message: string;
    if (summary.updated > 0) {
      message = `${summary.updated} skill${summary.updated === 1 ? "" : "s"} updated`;
    } else if (summary.failed > 0) {
      message = `Refresh failed for ${summary.failed} skill${summary.failed === 1 ? "" : "s"}`;
    } else {
      message = "All skills up to date";
    }
    setRefreshStatus(message);
    if (refreshStatusTimer !== null) {
      clearTimeout(refreshStatusTimer);
    }
    refreshStatusTimer = setTimeout(() => {
      refreshStatusTimer = null;
      setRefreshStatus(null);
    }, 4000);
  }

  onCleanup(() => {
    if (refreshStatusTimer !== null) {
      clearTimeout(refreshStatusTimer);
      refreshStatusTimer = null;
    }
  });

  const handleRefreshInstalledSkill = async (skill: InstalledSkill) => {
    const cachedStatus = syncStatusFor(skill);
    const existingStatus =
      cachedStatus && cachedStatus.state !== "error"
        ? cachedStatus
        : await skillsService.inspectSyncStatus(skill);
    setSyncStatusFor(skill.path, existingStatus);

    if (!existingStatus) {
      window.alert(
        `${skill.name} is not tracked against an upstream Seren skill revision, so Seren will not refresh it automatically.`,
      );
      return;
    }

    if (existingStatus.state === "error") {
      window.alert(
        existingStatus.error
          ? `Seren could not verify the current sync state for ${skill.name}.\n\n${existingStatus.error}\n\nRefresh has been blocked to avoid overwriting local files without a verified baseline.`
          : `Seren could not verify the current sync state for ${skill.name}. Refresh has been blocked to avoid overwriting local files without a verified baseline.`,
      );
      return;
    }

    if (existingStatus?.hasLocalChanges) {
      const changed = [
        ...existingStatus.changedLocalFiles,
        ...existingStatus.missingManagedFiles,
      ];
      const confirmOverwrite = await confirm(
        `Local changes were detected in ${skill.name}.\n\n${changed
          .slice(0, 8)
          .join(
            "\n",
          )}${changed.length > 8 ? `\n...and ${changed.length - 8} more` : ""}\n\nOverwrite local skill files with upstream?`,
        {
          title: "Overwrite local skill changes?",
          kind: "warning",
        },
      );
      if (!confirmOverwrite) return;
    }

    setActionInProgress(skill.id);
    try {
      const refreshed = await skillsService.refreshInstalledSkill(skill, {
        expectedLocalManagedState: existingStatus.localManagedState,
      });
      skillsStore.replaceInstalled(refreshed.installed);
      setSyncStatusFor(refreshed.installed.path, refreshed.syncStatus);
    } catch (err) {
      console.error("[SkillsExplorer] Failed to refresh installed skill:", err);
      await loadSyncStatus(skill);
    } finally {
      setActionInProgress(null);
    }
  };

  // ── Create skill ────────────────────────────────

  const handleSkillCreated = async (skillPath: string) => {
    await skillsStore.refreshInstalled();
    setActiveFilter("installed");
    await handleEditInEditor(skillPath);
  };

  // ── Install from URL ────────────────────────────

  const handleInstallFromUrl = async () => {
    const url = installUrl().trim();
    if (!url) return;

    try {
      new URL(url);
    } catch {
      return;
    }

    setUrlInstalling(true);
    try {
      const response = await appFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const content = await response.text();

      const urlPath = new URL(url).pathname;
      const segments = urlPath.split("/").filter(Boolean);
      const fileName = segments.pop() || "skill";
      const rawSlug = fileName
        .replace(/\.md$/i, "")
        .toLowerCase()
        .replace(/\s+/g, "-");

      const parsed = parseSkillMd(content);
      const parsedSlug = parsed.metadata.name?.trim();
      const slug = normalizeSkillSlug(parsedSlug || rawSlug);

      const skill: Skill = {
        id: `url:${slug}`,
        slug,
        name: resolveSkillDisplayName(parsed, slug),
        description:
          (parsed.metadata.description as string) || "Installed from URL",
        source: "local",
        sourceUrl: url,
        tags: [],
      };

      const installed = await skillsStore.install(skill, content, "seren");
      await loadSyncStatus(installed);
      setInstallUrl("");
      setShowUrlDialog(false);
      setActiveFilter("installed");
    } catch (err) {
      console.error("[SkillsExplorer] Failed to install from URL:", err);
    } finally {
      setUrlInstalling(false);
    }
  };

  // ── Edit in editor ──────────────────────────────

  const editablePathFor = (skill: InstalledSkill): string =>
    skill.authoringPath ?? skill.path;

  const skillCwdFor = (path: string): string => {
    // The session root is the skill folder containing SKILL.md so each
    // authored skill becomes its own sidebar entry, grouped under the
    // skill's name in the project list.
    const idx = path.lastIndexOf("/");
    return idx > 0 ? path.slice(0, idx) : path;
  };

  const handleEditInEditor = async (path: string) => {
    const cwd = skillCwdFor(path);
    await openFileInTab(path, { cwd });
    // Route through selectThread so the skill becomes the active thread and
    // its project group floats to the top of the sidebar (current-project
    // priority + lastActiveAt timestamp). selectThread also triggers the
    // workspace effect that surfaces the editor pane via bindEditorToWorkspace.
    threadStore.selectThread(`editor:${cwd}`, "editor");
  };

  // ── Scope badge label ───────────────────────────

  const scopeLabel = (scope: SkillScope) => {
    switch (scope) {
      case "seren":
        return "S";
      case "claude":
        return "C";
      case "project":
        return "P";
      default:
        return "?";
    }
  };

  const scopeTitle = (scope: SkillScope) => {
    switch (scope) {
      case "seren":
        return "Seren scope";
      case "claude":
        return "Claude scope";
      case "project":
        return "Project scope";
      default:
        return scope;
    }
  };

  // ── Render ──────────────────────────────────────

  return (
    <aside
      class="flex flex-col bg-surface-1 transition-all duration-200 overflow-hidden h-full"
      classList={{
        "w-[var(--sidebar-width)] min-w-[var(--sidebar-width)] border-r border-border":
          !props.panelMode,
        "w-full min-w-0": !!props.panelMode,
        "w-0 min-w-0 opacity-0 border-r-0":
          !props.panelMode && !!props.collapsed,
      }}
    >
      {/* Header */}
      <div
        class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0"
        classList={{ "pr-12": !!props.panelMode }}
      >
        <div class="flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            role="img"
            aria-label="Skills"
          >
            <path
              d="M8 2L9.5 6H14L10.5 8.5L12 13L8 10L4 13L5.5 8.5L2 6H6.5L8 2Z"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linejoin="round"
            />
          </svg>
          <span class="text-sm font-semibold text-foreground">Skills</span>
        </div>
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-1 bg-transparent border border-border rounded-md text-[12px] text-muted-foreground cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground"
            onClick={() => setShowCreateDialog((v) => !v)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              role="img"
              aria-label="Create"
            >
              <path
                d="M8 3v10M3 8h10"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
            Create
          </button>
          <button
            type="button"
            class="flex items-center justify-center w-7 h-7 bg-transparent border-none rounded-md text-muted-foreground cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground"
            onClick={() => void handleRefreshAll()}
            title="Refresh skills (bypass cache)"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
              role="img"
              aria-label="Refresh"
            >
              <path d="M14 8a6 6 0 1 1-2-4.47L14 5.33" />
              <polyline points="14 2 14 6 10 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Refresh status feedback */}
      <Show when={refreshStatus()}>
        <div class="px-3 py-1.5 text-xs text-muted-foreground bg-surface-2/50 border-b border-border animate-[fadeIn_0.15s_ease-out]">
          {refreshStatus()}
        </div>
      </Show>

      <Show when={showCreateDialog()}>
        <CreateSkillModal
          onClose={() => setShowCreateDialog(false)}
          onCreated={(skillPath) => void handleSkillCreated(skillPath)}
        />
      </Show>
      <Show when={manageSkillSlug()}>
        {(slug) => (
          <Show when={findCatalogBySlug(slug())}>
            {(skill) => (
              <ManageSkillModal
                skill={skill()}
                onClose={() => setManageSkillSlug(null)}
                onChanged={() => void handleManageChanged()}
              />
            )}
          </Show>
        )}
      </Show>
      {/* Search */}
      <div class="px-4 py-2 border-b border-border shrink-0">
        <div class="relative">
          <svg
            class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            role="img"
            aria-label="Search"
          >
            <circle
              cx="7"
              cy="7"
              r="4.5"
              stroke="currentColor"
              stroke-width="1.3"
            />
            <path
              d="M10.5 10.5L14 14"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
          </svg>
          <input
            type="text"
            class="w-full pl-8 pr-3 py-1.5 bg-surface-2 border border-transparent rounded-md text-[13px] text-foreground placeholder-muted-foreground outline-none focus:border-primary/50 transition-colors"
            placeholder="Search skills..."
            value={searchQuery()}
            onInput={(e) => {
              setSearchQuery(e.currentTarget.value);
              setExpandedSkillId(null);
              setDetailContent(null);
            }}
          />
        </div>
      </div>

      {/* Filter chips */}
      <div class="flex px-4 py-2 gap-1.5 shrink-0 flex-wrap">
        <button
          type="button"
          class="px-2.5 py-1 text-[11px] font-medium rounded-full border transition-colors cursor-pointer"
          classList={{
            "bg-primary/[0.12] text-foreground border-primary/30":
              activeFilter() === "all",
            "bg-transparent text-muted-foreground border-border hover:bg-surface-2":
              activeFilter() !== "all",
          }}
          onClick={() => setActiveFilter("all")}
        >
          All
        </button>
        <button
          type="button"
          class="px-2.5 py-1 text-[11px] font-medium rounded-full border transition-colors cursor-pointer"
          classList={{
            "bg-primary/[0.12] text-foreground border-primary/30":
              activeFilter() === "installed",
            "bg-transparent text-muted-foreground border-border hover:bg-surface-2":
              activeFilter() !== "installed",
          }}
          onClick={() => setActiveFilter("installed")}
        >
          Installed ({skillsStore.installed.length})
        </button>
        <Show when={needsSyncCount() > 0}>
          <button
            type="button"
            class="px-2.5 py-1 text-[11px] font-medium rounded-full border transition-colors cursor-pointer"
            classList={{
              "bg-warning/15 text-warning border-warning/40":
                activeFilter() === "needs-sync",
              "bg-transparent text-warning/80 border-warning/30 hover:bg-warning/10":
                activeFilter() !== "needs-sync",
            }}
            onClick={() => setActiveFilter("needs-sync")}
          >
            Needs sync ({needsSyncCount()})
          </button>
        </Show>
      </div>

      <Show when={updateCount() > 0 || localChangesCount() > 0}>
        <div class="mx-4 mt-2 px-3 py-2 bg-surface-2/70 border border-border rounded-md text-[12px] text-muted-foreground">
          <div class="font-medium text-foreground">
            Skill sync attention needed
          </div>
          <div class="mt-1">
            <Show when={updateCount() > 0}>
              <span>
                {updateCount()} upstream update{updateCount() === 1 ? "" : "s"}{" "}
                available.
              </span>
            </Show>
            <Show when={updateCount() > 0 && localChangesCount() > 0}>
              <span> </span>
            </Show>
            <Show when={localChangesCount() > 0}>
              <span>
                {localChangesCount()} installed skill
                {localChangesCount() === 1 ? "" : "s"} ha
                {localChangesCount() === 1 ? "s" : "ve"} local edits.
              </span>
            </Show>
          </div>
        </div>
      </Show>

      {/* Install failure banner */}
      <Show when={installError()}>
        {(failure) => (
          <div class="mx-4 my-2 px-3 py-2 bg-destructive/10 border border-destructive/30 rounded-md text-[12px]">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <span class="font-medium text-destructive">
                  Install failed: {failure().slug}
                </span>
                <p class="m-0 mt-1 text-muted-foreground break-words">
                  {failure().message}
                </p>
              </div>
              <button
                type="button"
                class="shrink-0 text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer text-[14px] leading-none"
                onClick={() => setInstallError(null)}
                aria-label="Dismiss error"
              >
                x
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Install warning banner */}
      <Show when={installWarning()}>
        {(warning) => (
          <div class="mx-4 my-2 px-3 py-2 bg-warning/10 border border-warning/30 rounded-md text-[12px]">
            <div class="flex items-start justify-between gap-2">
              <div>
                <span class="font-medium text-warning">
                  Incomplete install: {warning().slug}
                </span>
                <p class="m-0 mt-1 text-muted-foreground">
                  Missing files referenced in SKILL.md:
                </p>
                <ul class="m-0 mt-1 pl-4 text-muted-foreground">
                  <For each={warning().missingFiles.slice(0, 5)}>
                    {(file) => <li>{file}</li>}
                  </For>
                  <Show when={warning().missingFiles.length > 5}>
                    <li>...and {warning().missingFiles.length - 5} more</li>
                  </Show>
                </ul>
              </div>
              <button
                type="button"
                class="shrink-0 text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer text-[14px] leading-none"
                onClick={() => setInstallWarning(null)}
                aria-label="Dismiss warning"
              >
                x
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Content area */}
      <div
        ref={contentRef}
        class="flex-1 overflow-y-auto"
        onScroll={(event) => maybeLoadNextBrowsePage(event.currentTarget)}
      >
        <Show when={activeFilter() === "all" && catalogError()}>
          {(message) => (
            <div class="mx-4 mt-2 px-3 py-2 bg-destructive/10 border border-destructive/30 rounded-md text-[12px] text-destructive">
              {message()}
            </div>
          )}
        </Show>

        {/* Loading */}
        <Show when={isLoading()}>
          <div class="flex items-center justify-center py-8 text-muted-foreground text-[13px]">
            Loading skills...
          </div>
        </Show>

        {/* Empty state for the unified list */}
        <Show when={!isLoading() && totalRowsToShow() === 0}>
          <div class="px-4 py-8 text-center text-[13px] text-muted-foreground">
            <Show
              when={searchQuery()}
              fallback={
                activeFilter() === "needs-sync"
                  ? "All installed skills are up to date"
                  : activeFilter() === "installed"
                    ? "No skills installed"
                    : "No skills available"
              }
            >
              No matching skills
            </Show>
          </div>
        </Show>

        {/* Installed rows (always render when present, regardless of filter) */}
        <Show when={!isLoading() && installedRows().length > 0}>
          <Show when={activeFilter() === "all"}>
            <div class="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">
              Installed
            </div>
          </Show>
          <div class="py-1">
            <For each={installedRows()}>
              {(skill) => (
                <div class="border-b border-border/50 last:border-b-0">
                  {/* Card */}
                  <div
                    draggable={true}
                    class="flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-surface-2/50 select-none active:cursor-grabbing"
                    classList={{
                      "bg-surface-2/30": expandedSkillId() === skill.id,
                    }}
                    onClick={() => toggleDetail(skill.id)}
                    onDragStart={(event) => handleSkillDragStart(event, skill)}
                    onDragEnd={handleSkillDragEnd}
                  >
                    {/* Info */}
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-[13px] font-medium text-foreground truncate">
                          {displayNameFor(skill)}
                        </span>
                        <span
                          class="shrink-0 px-1 py-0 text-[10px] font-semibold rounded bg-surface-3 text-muted-foreground"
                          title={scopeTitle(skill.scope)}
                        >
                          {scopeLabel(skill.scope)}
                        </span>
                        <Show when={syncStatusLabel(syncStatusFor(skill))}>
                          {(label) => (
                            <span
                              class={`shrink-0 px-1.5 py-0 text-[10px] font-semibold rounded ${syncStatusClasses(
                                syncStatusFor(skill),
                              )}`}
                            >
                              {label()}
                            </span>
                          )}
                        </Show>
                        <Show when={ownsSkill(skill)}>
                          <span
                            class="shrink-0 px-1.5 py-0 text-[10px] font-semibold rounded bg-primary/15 text-primary"
                            title="You own this skill on Seren Skills"
                          >
                            Yours
                          </span>
                        </Show>
                        <Show when={syncLoading()[skill.path]}>
                          <span class="text-[10px] text-muted-foreground">
                            Checking...
                          </span>
                        </Show>
                      </div>
                      <Show when={skill.description}>
                        <p class="m-0 mt-0.5 text-[12px] text-muted-foreground truncate">
                          {skill.description}
                        </p>
                      </Show>
                      <Show when={skill.version || skill.author}>
                        <p class="m-0 mt-0.5 text-[11px] text-muted-foreground/60">
                          {skill.author}
                          {skill.author && skill.version ? " · " : ""}
                          {skill.version ? `v${skill.version}` : ""}
                        </p>
                      </Show>
                    </div>

                    <div class="shrink-0 mt-0.5 flex items-center gap-0.5">
                      <button
                        type="button"
                        class="flex items-center justify-center gap-1 px-2 h-7 bg-success text-white rounded-md text-[11px] font-medium cursor-pointer transition-colors hover:bg-success/80 disabled:opacity-40 disabled:cursor-default"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRunSkill(skill);
                        }}
                        disabled={
                          actionInProgress() === skill.id ||
                          !activeThreadContext()
                        }
                        title={runActionTitle()}
                        aria-label="Run skill"
                      >
                        <PlayIcon />
                        Run
                      </button>
                      <Show
                        when={isPublishable(skill) || canPublishUpdate(skill)}
                      >
                        <button
                          type="button"
                          class="flex items-center justify-center w-7 h-7 bg-transparent border-none rounded-md text-muted-foreground cursor-pointer transition-colors hover:bg-surface-2 hover:text-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePublishClick(skill);
                          }}
                          title={
                            isPublishable(skill)
                              ? "Publish to Seren Skills"
                              : "Publish a new version"
                          }
                          aria-label={
                            isPublishable(skill)
                              ? "Publish to Seren Skills"
                              : "Publish a new version"
                          }
                        >
                          <CloudUpIcon />
                        </button>
                      </Show>
                      <Show when={ownsSkill(skill)}>
                        <button
                          type="button"
                          class="flex items-center justify-center w-7 h-7 bg-transparent border-none rounded-md text-muted-foreground cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground"
                          onClick={(e) => {
                            e.stopPropagation();
                            setManageSkillSlug(skill.slug);
                          }}
                          title="Manage on Seren Skills"
                          aria-label="Manage on Seren Skills"
                        >
                          <SettingsIcon />
                        </button>
                      </Show>
                    </div>
                  </div>

                  {/* Detail accordion */}
                  <Show when={expandedSkillId() === skill.id}>
                    <div class="px-4 pb-3 bg-surface-2/20 border-t border-border/30">
                      <div class="pt-2.5">
                        {/* Tags */}
                        <Show when={skill.tags.length > 0}>
                          <div class="flex flex-wrap gap-1 mb-2">
                            <For each={skill.tags}>
                              {(tag) => (
                                <span class="px-1.5 py-0.5 bg-surface-3 rounded text-[10px] text-muted-foreground">
                                  {tag}
                                </span>
                              )}
                            </For>
                          </div>
                        </Show>

                        <Show when={isUpstreamManagedSkill(skill)}>
                          <div class="mb-2 p-2.5 bg-surface-1 border border-border rounded-md text-[11px] text-muted-foreground">
                            <div class="flex items-center justify-between gap-2">
                              <span class="font-medium text-foreground">
                                Upstream sync
                              </span>
                              <button
                                type="button"
                                class="px-2 py-1 bg-transparent border border-border text-muted-foreground rounded-md text-[11px] cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-40"
                                onClick={() =>
                                  void handleRefreshInstalledSkill(skill)
                                }
                                disabled={
                                  actionInProgress() === skill.id ||
                                  syncLoading()[skill.path]
                                }
                              >
                                {actionInProgress() === skill.id
                                  ? "Refreshing..."
                                  : "Refresh from upstream"}
                              </button>
                            </div>
                            <div class="mt-2">
                              Local revision:{" "}
                              <span class="text-foreground">
                                {syncStatusFor(skill)?.syncedRevision?.slice(
                                  0,
                                  7,
                                ) || "unknown"}
                              </span>
                            </div>
                            <div class="mt-1">
                              Remote revision:{" "}
                              <span class="text-foreground">
                                {syncStatusFor(skill)?.remoteRevision
                                  ?.shortSha || "unavailable"}
                              </span>
                            </div>
                            <Show
                              when={
                                syncStatusFor(skill)?.remoteRevision?.message
                              }
                            >
                              <div class="mt-1">
                                {syncStatusFor(skill)?.remoteRevision?.message}
                              </div>
                            </Show>
                            <Show
                              when={syncStatusFor(skill)?.remoteRevision?.url}
                            >
                              <div class="mt-2">
                                <button
                                  type="button"
                                  class="p-0 bg-transparent border-none text-[11px] text-primary cursor-pointer hover:underline"
                                  onClick={() =>
                                    void openExternalLink(
                                      syncStatusFor(skill)?.remoteRevision
                                        ?.url || "",
                                    )
                                  }
                                >
                                  Open upstream commit
                                </button>
                              </div>
                            </Show>
                            <Show
                              when={
                                syncStatusFor(skill)?.remoteRevision
                                  ?.changedFiles.length
                              }
                            >
                              <div class="mt-2">
                                <div class="font-medium text-foreground">
                                  Upstream changed files
                                </div>
                                <ul class="m-0 mt-1 pl-4">
                                  <For
                                    each={syncStatusFor(
                                      skill,
                                    )?.remoteRevision?.changedFiles.slice(0, 6)}
                                  >
                                    {(file) => <li>{file}</li>}
                                  </For>
                                </ul>
                              </div>
                            </Show>
                            <Show
                              when={
                                syncStatusFor(skill)?.changedLocalFiles.length
                              }
                            >
                              <div class="mt-2">
                                <div class="font-medium text-destructive">
                                  Local file changes
                                </div>
                                <ul class="m-0 mt-1 pl-4 text-destructive">
                                  <For
                                    each={syncStatusFor(
                                      skill,
                                    )?.changedLocalFiles.slice(0, 6)}
                                  >
                                    {(file) => <li>{file}</li>}
                                  </For>
                                </ul>
                              </div>
                            </Show>
                            <Show
                              when={
                                syncStatusFor(skill)?.missingManagedFiles.length
                              }
                            >
                              <div class="mt-2">
                                <div class="font-medium text-destructive">
                                  Missing managed files
                                </div>
                                <ul class="m-0 mt-1 pl-4 text-destructive">
                                  <For
                                    each={syncStatusFor(
                                      skill,
                                    )?.missingManagedFiles.slice(0, 6)}
                                  >
                                    {(file) => <li>{file}</li>}
                                  </For>
                                </ul>
                              </div>
                            </Show>
                            <Show when={syncStatusFor(skill)?.error}>
                              <div class="mt-2 text-destructive">
                                {syncStatusFor(skill)?.error}
                              </div>
                            </Show>
                          </div>
                        </Show>

                        {/* Content preview */}
                        <Show when={detailLoading()}>
                          <div class="py-3 text-[12px] text-muted-foreground">
                            Loading content...
                          </div>
                        </Show>
                        <Show when={!detailLoading() && detailContent()}>
                          <pre class="m-0 max-h-[200px] overflow-y-auto p-2.5 bg-surface-1 border border-border rounded-md text-[11px] text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
                            {detailContent()}
                          </pre>
                        </Show>

                        {/* Actions */}
                        <div class="flex items-center gap-2 mt-2.5 flex-wrap">
                          <button
                            type="button"
                            class="px-3 py-1 bg-transparent border border-destructive/40 text-destructive rounded-md text-[12px] cursor-pointer transition-colors hover:bg-destructive/10 disabled:opacity-40"
                            onClick={() => handleUninstall(skill)}
                            disabled={actionInProgress() === skill.id}
                            title="Remove the local SKILL.md folder. Does not affect the published record on Seren Skills."
                          >
                            {actionInProgress() === skill.id
                              ? "Uninstalling..."
                              : "Uninstall"}
                          </button>
                          <Show when={ownsSkill(skill)}>
                            <button
                              type="button"
                              class="px-3 py-1 bg-transparent border border-primary/40 text-primary rounded-md text-[12px] cursor-pointer transition-colors hover:bg-primary/10"
                              onClick={() => setManageSkillSlug(skill.slug)}
                            >
                              Manage on Seren Skills
                            </button>
                          </Show>
                          <Show
                            when={
                              isPublishable(skill) || canPublishUpdate(skill)
                            }
                          >
                            <button
                              type="button"
                              class="px-3 py-1 bg-transparent border border-primary/40 text-primary rounded-md text-[12px] cursor-pointer transition-colors hover:bg-primary/10"
                              onClick={() => handlePublishClick(skill)}
                              title={
                                isPublishable(skill)
                                  ? "Push this local SKILL.md to Seren Skills as a new publisher record"
                                  : "Publish a new version to Seren Skills"
                              }
                            >
                              {isPublishable(skill)
                                ? "Publish to Seren Skills"
                                : "Publish update"}
                            </button>
                          </Show>
                        </div>
                      </div>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Available rows (catalog skills not yet installed) */}
        <Show when={!isLoading() && availableRows().length > 0}>
          <Show when={installedRows().length > 0}>
            <div class="mx-4 my-1 border-t border-border/40" />
            <div class="px-4 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">
              Catalog
            </div>
          </Show>
          <div class="py-1">
            <For each={availableRows()}>
              {(skill) => {
                const installing = () => actionInProgress() === skill.id;

                return (
                  <div class="border-b border-border/50 last:border-b-0">
                    {/* Card */}
                    <div
                      draggable={true}
                      class="flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-surface-2/50 select-none active:cursor-grabbing"
                      classList={{
                        "bg-surface-2/30": expandedSkillId() === skill.id,
                      }}
                      onClick={() => toggleDetail(skill.id)}
                      onDragStart={(event) =>
                        handleSkillDragStart(event, skill)
                      }
                      onDragEnd={handleSkillDragEnd}
                    >
                      {/* Info */}
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                          <span class="text-[13px] font-medium text-foreground truncate">
                            {displayNameFor(skill)}
                          </span>
                          <Show when={ownsSkill(skill)}>
                            <span
                              class="shrink-0 px-1.5 py-0 text-[10px] font-semibold rounded bg-primary/15 text-primary"
                              title="You own this skill on Seren Skills"
                            >
                              Yours
                            </span>
                          </Show>
                        </div>
                        <Show when={skill.description}>
                          <p class="m-0 mt-0.5 text-[12px] text-muted-foreground truncate">
                            {skill.description}
                          </p>
                        </Show>
                        <div class="flex items-center gap-1.5 mt-0.5">
                          <Show when={skill.author || skill.source}>
                            <span class="text-[11px] text-muted-foreground/60">
                              {skill.author || skill.source}
                            </span>
                          </Show>
                          <Show when={skill.tags.length > 0}>
                            <span class="text-[11px] text-muted-foreground/40">
                              {skill.tags.slice(0, 3).join(", ")}
                            </span>
                          </Show>
                        </div>
                      </div>

                      {/* Install button */}
                      <div class="shrink-0 mt-0.5">
                        <button
                          type="button"
                          class="px-2.5 py-1 bg-primary text-primary-foreground rounded-md text-[11px] font-medium cursor-pointer transition-colors hover:bg-primary/80 disabled:opacity-40 disabled:cursor-default"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAddCatalogSkill(skill);
                          }}
                          disabled={installing()}
                          title="Install this skill locally"
                        >
                          {installing() ? "Installing..." : "Install"}
                        </button>
                      </div>
                    </div>

                    {/* Detail accordion */}
                    <Show when={expandedSkillId() === skill.id}>
                      <div class="px-4 pb-3 bg-surface-2/20 border-t border-border/30">
                        <div class="pt-2.5">
                          {/* Tags */}
                          <Show when={skill.tags.length > 0}>
                            <div class="flex flex-wrap gap-1 mb-2">
                              <For each={skill.tags}>
                                {(tag) => (
                                  <span class="px-1.5 py-0.5 bg-surface-3 rounded text-[10px] text-muted-foreground">
                                    {tag}
                                  </span>
                                )}
                              </For>
                            </div>
                          </Show>

                          {/* Metadata */}
                          <div class="flex items-center gap-3 mb-2 text-[11px] text-muted-foreground/60">
                            <Show when={skill.author}>
                              <span>Author: {skill.author}</span>
                            </Show>
                            <Show when={skill.version}>
                              <span>v{skill.version}</span>
                            </Show>
                            <Show when={skill.source}>
                              <span>Source: {skill.source}</span>
                            </Show>
                          </div>

                          {/* Content preview */}
                          <Show when={detailLoading()}>
                            <div class="py-3 text-[12px] text-muted-foreground">
                              Loading content...
                            </div>
                          </Show>
                          <Show when={!detailLoading() && detailContent()}>
                            <pre class="m-0 max-h-[200px] overflow-y-auto p-2.5 bg-surface-1 border border-border rounded-md text-[11px] text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
                              {detailContent()}
                            </pre>
                          </Show>

                          <div class="mt-2.5 flex items-center gap-2 flex-wrap">
                            <button
                              type="button"
                              class="px-3 py-1 bg-primary text-primary-foreground rounded-md text-[12px] font-medium cursor-pointer transition-colors hover:bg-primary/80 disabled:opacity-40 disabled:cursor-default"
                              onClick={() => handleAddCatalogSkill(skill)}
                              disabled={installing()}
                              title="Install this skill locally"
                            >
                              {installing() ? "Installing..." : "Install"}
                            </button>
                            <Show when={ownsSkill(skill)}>
                              <button
                                type="button"
                                class="px-3 py-1 bg-transparent border border-primary/40 text-primary rounded-md text-[12px] cursor-pointer transition-colors hover:bg-primary/10"
                                onClick={() => setManageSkillSlug(skill.slug)}
                              >
                                Manage on Seren Skills
                              </button>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={availableSkillsQuery.isFetchingNextPage}>
              <div class="px-4 py-3 text-center text-[12px] text-muted-foreground">
                Loading more skills...
              </div>
            </Show>
            <Show
              when={
                availableSkillsQuery.hasNextPage &&
                !availableSkillsQuery.isFetchingNextPage
              }
            >
              <div class="px-4 py-3">
                <button
                  type="button"
                  class="w-full px-3 py-1.5 bg-transparent border border-border text-muted-foreground rounded-md text-[12px] cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground"
                  onClick={() => void availableSkillsQuery.fetchNextPage()}
                >
                  Load more
                </button>
              </div>
            </Show>
            <Show
              when={
                !availableSkillsQuery.hasNextPage &&
                browseTotal() !== null &&
                browseLoaded() > 0
              }
            >
              <div class="px-4 py-3 text-center text-[11px] text-muted-foreground/60">
                {browseLoaded()} of {browseTotal()} skills loaded
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Footer: Install from URL */}
      <div class="px-4 py-2.5 border-t border-border shrink-0">
        <Show
          when={showUrlDialog()}
          fallback={
            <button
              type="button"
              class="w-full text-left text-[12px] text-muted-foreground bg-transparent border-none cursor-pointer transition-colors hover:text-foreground"
              onClick={() => setShowUrlDialog(true)}
            >
              Install from URL...
            </button>
          }
        >
          <div class="flex items-center gap-2">
            <input
              type="text"
              class="flex-1 px-2.5 py-1.5 bg-surface-2 border border-border rounded-md text-[12px] text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
              placeholder="https://raw.githubusercontent.com/..."
              value={installUrl()}
              onInput={(e) => setInstallUrl(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleInstallFromUrl();
                if (e.key === "Escape") {
                  setShowUrlDialog(false);
                  setInstallUrl("");
                }
              }}
              autofocus
            />
            <button
              type="button"
              class="px-2.5 py-1.5 bg-primary text-primary-foreground rounded-md text-[11px] font-medium cursor-pointer transition-colors hover:bg-primary/80 disabled:opacity-40 shrink-0"
              onClick={handleInstallFromUrl}
              disabled={!installUrl().trim() || urlInstalling()}
            >
              {urlInstalling() ? "..." : "Install"}
            </button>
            <button
              type="button"
              class="px-2 py-1.5 bg-transparent border-none text-muted-foreground text-[11px] cursor-pointer hover:text-foreground shrink-0"
              onClick={() => {
                setShowUrlDialog(false);
                setInstallUrl("");
              }}
            >
              Cancel
            </button>
          </div>
        </Show>
      </div>
    </aside>
  );
};
