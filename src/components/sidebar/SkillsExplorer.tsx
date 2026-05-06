// ABOUTME: Skills management panel with unified installed-and-catalog list.
// ABOUTME: Renders inside SlidePanel with chip filters (All / Installed / Needs sync) and an inline detail accordion.

import { createInfiniteQuery } from "@tanstack/solid-query";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  type Component,
  createEffect,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js";
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
import { parseSkillMd, resolveSkillDisplayName } from "@/lib/skills";
import {
  isUpstreamManagedSkill,
  skills as skillsService,
} from "@/services/skills";
import { skillsCatalogOptions } from "@/services/skills-query";
import { agentStore } from "@/stores/agent.store";
import { fileTreeState } from "@/stores/fileTree";
import { type RefreshSummary, skillsStore } from "@/stores/skills.store";
import { threadStore } from "@/stores/thread.store";

interface SkillsExplorerProps {
  collapsed?: boolean;
  panelMode?: boolean;
}

type Filter = "all" | "installed" | "needs-sync";

const SKILL_CREATOR_SLUG = "skill-creator";
const SKILL_CREATOR_SOURCE_URL = `seren-skills:${SKILL_CREATOR_SLUG}`;

function normalizeSkillSlug(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "skill";
}

export const SkillsExplorer: Component<SkillsExplorerProps> = (props) => {
  const [activeFilter, setActiveFilter] = createSignal<Filter>("all");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [expandedSkillId, setExpandedSkillId] = createSignal<string | null>(
    null,
  );
  const [detailContent, setDetailContent] = createSignal<string | null>(null);
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [newSkillName, setNewSkillName] = createSignal("");
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

  const matchesQuery = (skill: Skill | InstalledSkill, q: string): boolean => {
    if (!q) return true;
    return (
      (skill.displayName ?? skill.name).toLowerCase().includes(q) ||
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
      .sort((a, b) =>
        (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name),
      );
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

  const activeThreadHasSkill = (skill: InstalledSkill): boolean => {
    const context = activeThreadContext();
    // Terminal pastes are one-shot, so we never mark a skill as already added.
    if (!context || context.kind === "terminal") return false;
    const activeSkills = skillsStore.getThreadSkills(
      context.projectRoot,
      context.threadId,
    );
    return activeSkills.some((activeSkill) => activeSkill.path === skill.path);
  };

  const addActionTitle = (installed: boolean): string => {
    const context = activeThreadContext();
    if (!context) return "Select a chat, agent, or terminal thread first";
    if (context.kind === "terminal") {
      return installed
        ? "Paste into active terminal"
        : "Install and paste into active terminal";
    }
    return installed
      ? "Add to active thread"
      : "Install and add to active thread";
  };

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

  const getAffectedLiveThreadIds = (skill: InstalledSkill) => {
    return threadStore.threads.flatMap((thread) => {
      if (thread.kind !== "agent" || !thread.isLive) return [];
      const effectiveSkills = skillsStore.getThreadSkills(
        thread.projectRoot,
        thread.id,
      );
      return effectiveSkills.some(
        (activeSkill) => activeSkill.path === skill.path,
      )
        ? [thread.id]
        : [];
    });
  };

  const restartAffectedLiveThreads = async (threadIds: string[]) => {
    for (const threadId of threadIds) {
      const thread = threadStore.threads.find((entry) => entry.id === threadId);
      if (!thread || thread.kind !== "agent") continue;
      await agentStore.resumeAgentConversation(
        thread.id,
        thread.projectRoot ?? undefined,
      );
    }
  };

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
      displayName: skill.displayName,
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
    console.info("[SkillsExplorer] paste-into-terminal", {
      bufferId,
      slug: skill.slug,
      textLength: text?.length ?? 0,
    });
    if (!text) {
      throw new Error(`Could not load SKILL.md for ${skill.slug}`);
    }
    window.dispatchEvent(
      new CustomEvent("seren:terminal-paste-text", {
        detail: { bufferId, text },
      }),
    );
  };

  const attachInstalledToActiveThread = async (
    skill: InstalledSkill,
  ): Promise<void> => {
    const context = activeThreadContext();
    if (!context) return;
    if (context.kind === "terminal") {
      await pasteSkillIntoTerminal(context.threadId, skill);
      return;
    }
    await skillsStore.attachSkillToThread(
      context.projectRoot,
      context.threadId,
      skill.path,
    );
  };

  const handleAddInstalledSkill = async (skill: InstalledSkill) => {
    const context = activeThreadContext();
    if (!context) return;
    if (context.kind !== "terminal" && activeThreadHasSkill(skill)) return;

    setActionInProgress(skill.id);
    setInstallError(null);
    try {
      if (context.kind === "terminal") {
        await pasteSkillIntoTerminal(context.threadId, skill);
      } else {
        await skillsStore.attachSkillToThread(
          context.projectRoot,
          context.threadId,
          skill.path,
        );
      }
    } catch (err) {
      console.error("[SkillsExplorer] Failed to add skill:", err);
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
      await attachInstalledToActiveThread(installed);

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
    setTimeout(() => setRefreshStatus(null), 4000);
  }

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

    const affectedThreadIds = getAffectedLiveThreadIds(skill);
    if (affectedThreadIds.length > 0) {
      const confirmRestart = await confirm(
        `${skill.name} is active in ${affectedThreadIds.length} live agent thread${affectedThreadIds.length === 1 ? "" : "s"}.\n\nSeren can stop those sessions, refresh the skill, and resume them so the next prompt runs against the updated files.\n\nContinue?`,
        {
          title: "Restart live agent sessions?",
          kind: "warning",
        },
      );
      if (!confirmRestart) return;
    }

    setActionInProgress(skill.id);
    let stoppedLiveThreads = false;
    const terminatedThreadIds: string[] = [];
    try {
      if (affectedThreadIds.length > 0) {
        for (const threadId of affectedThreadIds) {
          const liveSession = Object.values(agentStore.sessions).find(
            (session) => session.conversationId === threadId,
          );
          if (!liveSession) continue;
          await agentStore.terminateSession(liveSession.info.id);
          terminatedThreadIds.push(threadId);
        }
        stoppedLiveThreads = terminatedThreadIds.length > 0;
      }

      const refreshed = await skillsService.refreshInstalledSkill(skill, {
        expectedLocalManagedState: existingStatus.localManagedState,
      });
      skillsStore.replaceInstalled(refreshed.installed);
      setSyncStatusFor(refreshed.installed.path, refreshed.syncStatus);

      if (terminatedThreadIds.length > 0) {
        await restartAffectedLiveThreads(terminatedThreadIds);
        stoppedLiveThreads = false;
      }
    } catch (err) {
      console.error("[SkillsExplorer] Failed to refresh installed skill:", err);
      if (stoppedLiveThreads) {
        await restartAffectedLiveThreads(terminatedThreadIds);
      }
      await loadSyncStatus(skill);
    } finally {
      setActionInProgress(null);
    }
  };

  // ── Create skill ────────────────────────────────

  const handleCreateSkill = async () => {
    const name = newSkillName().trim();
    if (!name) return;

    const slug = name.toLowerCase().replace(/\s+/g, "-");
    try {
      const skillsDir = await invoke<string>("get_seren_skills_dir");
      await invoke<string>("create_skill_folder", { skillsDir, slug, name });
      await skillsStore.refreshInstalled();
      setNewSkillName("");
      setShowCreateDialog(false);
      setActiveFilter("installed");
    } catch (err) {
      console.error("[SkillsExplorer] Failed to create skill:", err);
    }
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

  const handleEditInEditor = (path: string) => {
    openFileInTab(path);
    window.dispatchEvent(
      new CustomEvent("seren:open-panel", { detail: "editor" }),
    );
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
              role="img"
              aria-label="Refresh"
            >
              <path
                d="M2 8a6 6 0 1011.5 2.5"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
              <path
                d="M2 3v5h5"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
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

      {/* Create dialog */}
      <Show when={showCreateDialog()}>
        <div class="px-4 py-3 border-b border-border bg-surface-2/50">
          <input
            type="text"
            class="w-full px-3 py-1.5 bg-surface-1 border border-border rounded-md text-[13px] text-foreground placeholder-muted-foreground outline-none focus:border-primary"
            placeholder="Skill name (e.g. lead-finder)"
            value={newSkillName()}
            onInput={(e) => setNewSkillName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateSkill();
              if (e.key === "Escape") setShowCreateDialog(false);
            }}
            autofocus
          />
          <div class="flex items-center gap-2 mt-2">
            <button
              type="button"
              class="px-3 py-1 bg-primary text-primary-foreground rounded-md text-[12px] font-medium cursor-pointer transition-colors hover:bg-primary/80 disabled:opacity-40"
              onClick={handleCreateSkill}
              disabled={!newSkillName().trim()}
            >
              Create
            </button>
            <button
              type="button"
              class="px-3 py-1 bg-transparent border border-border text-muted-foreground rounded-md text-[12px] cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground"
              onClick={() => {
                setShowCreateDialog(false);
                setNewSkillName("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
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
                          {skill.displayName ?? skill.name}
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

                    <div class="shrink-0 mt-0.5">
                      <Show
                        when={!activeThreadHasSkill(skill)}
                        fallback={
                          <span class="px-2 py-1 text-[11px] text-success bg-success/10 rounded">
                            Added
                          </span>
                        }
                      >
                        <button
                          type="button"
                          class="px-2.5 py-1 bg-primary text-primary-foreground rounded-md text-[11px] font-medium cursor-pointer transition-colors hover:bg-primary/80 disabled:opacity-40 disabled:cursor-default"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleAddInstalledSkill(skill);
                          }}
                          disabled={
                            actionInProgress() === skill.id ||
                            !activeThreadContext()
                          }
                          title={
                            activeThreadContext()
                              ? addActionTitle(true)
                              : "Select a chat, agent, or terminal thread first"
                          }
                        >
                          {actionInProgress() === skill.id
                            ? activeThreadContext()?.kind === "terminal"
                              ? "Pasting..."
                              : "Adding..."
                            : activeThreadContext()?.kind === "terminal"
                              ? "Paste"
                              : "Add"}
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
                            <Show
                              when={getAffectedLiveThreadIds(skill).length > 0}
                            >
                              <div class="mt-2 text-warning">
                                {getAffectedLiveThreadIds(skill).length} live
                                agent thread
                                {getAffectedLiveThreadIds(skill).length === 1
                                  ? ""
                                  : "s"}{" "}
                                currently reference this skill.
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
                        <div class="flex items-center gap-2 mt-2.5">
                          <button
                            type="button"
                            class="px-3 py-1 bg-transparent border border-destructive/40 text-destructive rounded-md text-[12px] cursor-pointer transition-colors hover:bg-destructive/10 disabled:opacity-40"
                            onClick={() => handleUninstall(skill)}
                            disabled={actionInProgress() === skill.id}
                          >
                            {actionInProgress() === skill.id
                              ? "Removing..."
                              : "Delete"}
                          </button>
                          <button
                            type="button"
                            class="px-3 py-1 bg-transparent border border-border text-muted-foreground rounded-md text-[12px] cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground"
                            onClick={() => handleEditInEditor(skill.path)}
                          >
                            Edit in Editor
                          </button>
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
                        <span class="text-[13px] font-medium text-foreground truncate block">
                          {skill.displayName ?? skill.name}
                        </span>
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
                          title={
                            activeThreadContext()
                              ? addActionTitle(false)
                              : "Install this skill locally"
                          }
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

                          <div class="mt-2.5">
                            <button
                              type="button"
                              class="px-3 py-1 bg-primary text-primary-foreground rounded-md text-[12px] font-medium cursor-pointer transition-colors hover:bg-primary/80 disabled:opacity-40 disabled:cursor-default"
                              onClick={() => handleAddCatalogSkill(skill)}
                              disabled={installing()}
                              title={
                                activeThreadContext()
                                  ? addActionTitle(false)
                                  : "Install this skill locally"
                              }
                            >
                              {installing()
                                ? "Installing..."
                                : activeThreadContext()?.kind === "terminal"
                                  ? "Install and Paste"
                                  : activeThreadContext()
                                    ? "Install and Add"
                                    : "Install"}
                            </button>
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
