// ABOUTME: Skills management panel with browse/install catalog and installed skills management.
// ABOUTME: Renders inside SlidePanel with tabs for Installed and Browse, inline detail accordion.

import { invoke } from "@tauri-apps/api/core";
import {
  type Component,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { appFetch } from "@/lib/fetch";
import { openFileInTab } from "@/lib/files/service";
import type { InstalledSkill, Skill, SkillScope } from "@/lib/skills";
import { parseSkillMd, resolveSkillDisplayName } from "@/lib/skills";
import { skills as skillsService } from "@/services/skills";
import { skillsStore } from "@/stores/skills.store";

interface SkillsExplorerProps {
  collapsed?: boolean;
  panelMode?: boolean;
}

type Tab = "installed" | "browse";

const SKILL_CREATOR_SLUG = "seren-skill-creator";
const SKILL_CREATOR_SOURCE_URL =
  "https://raw.githubusercontent.com/serenorg/seren-skills/main/seren/skill-creator/SKILL.md";

function normalizeSkillSlug(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "skill";
}

export const SkillsExplorer: Component<SkillsExplorerProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<Tab>("installed");
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
  const [overflowMenuId, setOverflowMenuId] = createSignal<string | null>(null);
  const [installWarning, setInstallWarning] = createSignal<{
    slug: string;
    missingFiles: string[];
  } | null>(null);

  // ── Derived values ──────────────────────────────

  const filteredInstalled = () => {
    const q = searchQuery().toLowerCase().trim();
    if (!q) return skillsStore.installed;
    return skillsStore.installed.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  };

  const filteredBrowse = () => {
    const q = searchQuery().trim();
    if (!q) return skillsStore.available;
    return skillsService.search(skillsStore.available, q);
  };

  // ── Lifecycle ───────────────────────────────────

  onMount(async () => {
    await skillsStore.refresh();
    await ensureSkillCreatorInstalled();
  });

  const ensureSkillCreatorInstalled = async () => {
    const alreadyInstalled = skillsStore.installed.some(
      (s) => s.slug === SKILL_CREATOR_SLUG,
    );
    if (alreadyInstalled) return;

    try {
      const skill: Skill = {
        id: `serenorg:${SKILL_CREATOR_SLUG}`,
        slug: SKILL_CREATOR_SLUG,
        name: "Skill Creator",
        description:
          "Guide for creating effective skills. Use when users want to create or update a skill that extends capabilities with specialized knowledge, workflows, or tool integrations.",
        source: "serenorg",
        sourceUrl: SKILL_CREATOR_SOURCE_URL,
        tags: ["meta", "creation"],
        author: "SerenAI",
      };
      const content = await skillsService.fetchContent(skill);
      if (!content) return;
      await skillsStore.install(skill, content, "seren");
    } catch (err) {
      console.error("[SkillsExplorer] Failed to install skill-creator:", err);
    }
  };

  // ── Click outside to close overflow menu ────────

  const handleDocumentClick = () => {
    if (overflowMenuId()) {
      setOverflowMenuId(null);
    }
  };

  onMount(() => {
    document.addEventListener("click", handleDocumentClick);
  });

  onCleanup(() => {
    document.removeEventListener("click", handleDocumentClick);
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

  const handleInstall = async (skill: Skill, scope: SkillScope = "seren") => {
    setActionInProgress(skill.id);
    setInstallWarning(null);
    try {
      const content = await skillsService.fetchContent(skill);
      if (content) {
        const installed = await skillsStore.install(skill, content, scope);

        // Validate payload after install
        const missingFiles = await skillsService.validatePayload(
          installed.skillsDir,
          installed.slug,
        );
        if (missingFiles.length > 0) {
          setInstallWarning({ slug: installed.slug, missingFiles });
        }
      }
    } catch (err) {
      console.error("[SkillsExplorer] Failed to install:", err);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUninstall = async (skill: InstalledSkill) => {
    setActionInProgress(skill.id);
    try {
      await skillsStore.remove(skill);
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
      setActiveTab("installed");
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

      await skillsStore.install(skill, content, "seren");
      setInstallUrl("");
      setShowUrlDialog(false);
      setActiveTab("installed");
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
      <div class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
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
            onClick={() => skillsStore.refresh(true)}
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

      {/* Tab switcher */}
      <div class="flex px-4 py-2 gap-0 shrink-0">
        <button
          type="button"
          class="flex-1 py-1.5 text-[12px] font-medium rounded-l-md border border-border transition-colors cursor-pointer"
          classList={{
            "bg-primary/[0.12] text-foreground border-primary/30":
              activeTab() === "installed",
            "bg-transparent text-muted-foreground hover:bg-surface-2":
              activeTab() !== "installed",
          }}
          onClick={() => setActiveTab("installed")}
        >
          Installed ({skillsStore.installed.length})
        </button>
        <button
          type="button"
          class="flex-1 py-1.5 text-[12px] font-medium rounded-r-md border border-l-0 border-border transition-colors cursor-pointer"
          classList={{
            "bg-primary/[0.12] text-foreground border-primary/30":
              activeTab() === "browse",
            "bg-transparent text-muted-foreground hover:bg-surface-2":
              activeTab() !== "browse",
          }}
          onClick={() => setActiveTab("browse")}
        >
          Browse ({skillsStore.available.length})
        </button>
      </div>

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
      <div class="flex-1 overflow-y-auto">
        {/* Loading */}
        <Show when={skillsStore.isLoading}>
          <div class="flex items-center justify-center py-8 text-muted-foreground text-[13px]">
            Loading skills...
          </div>
        </Show>

        {/* Installed tab */}
        <Show when={!skillsStore.isLoading && activeTab() === "installed"}>
          <Show
            when={filteredInstalled().length > 0}
            fallback={
              <div class="px-4 py-8 text-center text-[13px] text-muted-foreground">
                {searchQuery() ? "No matching skills" : "No skills installed"}
              </div>
            }
          >
            <div class="py-1">
              <For each={filteredInstalled()}>
                {(skill) => (
                  <div class="border-b border-border/50 last:border-b-0">
                    {/* Card */}
                    <div
                      class="flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-surface-2/50"
                      classList={{
                        "bg-surface-2/30": expandedSkillId() === skill.id,
                      }}
                      onClick={() => toggleDetail(skill.id)}
                    >
                      {/* Toggle */}
                      <button
                        type="button"
                        class="relative w-8 h-[18px] rounded-full transition-colors duration-200 shrink-0 mt-0.5"
                        classList={{
                          "bg-success": skillsStore.isEnabled(skill.id),
                          "bg-muted-foreground/30": !skillsStore.isEnabled(
                            skill.id,
                          ),
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          skillsStore.toggleEnabled(skill.id);
                        }}
                        role="switch"
                        aria-checked={skillsStore.isEnabled(skill.id)}
                        aria-label={
                          skillsStore.isEnabled(skill.id)
                            ? "Disable skill"
                            : "Enable skill"
                        }
                      >
                        <span
                          class="absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform duration-200"
                          classList={{
                            "left-[16px]": skillsStore.isEnabled(skill.id),
                            "left-[2px]": !skillsStore.isEnabled(skill.id),
                          }}
                        />
                      </button>

                      {/* Info */}
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                          <span class="text-[13px] font-medium text-foreground truncate">
                            {skill.name}
                          </span>
                          <span
                            class="shrink-0 px-1 py-0 text-[10px] font-semibold rounded bg-surface-3 text-muted-foreground"
                            title={scopeTitle(skill.scope)}
                          >
                            {scopeLabel(skill.scope)}
                          </span>
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

                      {/* Overflow menu */}
                      <div class="relative shrink-0">
                        <button
                          type="button"
                          class="flex items-center justify-center w-6 h-6 bg-transparent border-none rounded text-muted-foreground cursor-pointer transition-colors hover:bg-surface-3 hover:text-foreground"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOverflowMenuId(
                              overflowMenuId() === skill.id ? null : skill.id,
                            );
                          }}
                          aria-label="Skill actions"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            role="img"
                            aria-label="More"
                          >
                            <circle cx="8" cy="4" r="1" fill="currentColor" />
                            <circle cx="8" cy="8" r="1" fill="currentColor" />
                            <circle cx="8" cy="12" r="1" fill="currentColor" />
                          </svg>
                        </button>
                        <Show when={overflowMenuId() === skill.id}>
                          <div class="absolute right-0 top-7 min-w-[160px] bg-surface-2 border border-border rounded-lg shadow-[var(--shadow-lg)] z-50 py-1 animate-[fadeIn_100ms_ease]">
                            <button
                              type="button"
                              class="w-full flex items-center gap-2 px-3 py-1.5 bg-transparent border-none text-[12px] text-foreground cursor-pointer transition-colors hover:bg-surface-3 text-left"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOverflowMenuId(null);
                                toggleDetail(skill.id);
                              }}
                            >
                              View Details
                            </button>
                            <button
                              type="button"
                              class="w-full flex items-center gap-2 px-3 py-1.5 bg-transparent border-none text-[12px] text-foreground cursor-pointer transition-colors hover:bg-surface-3 text-left"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOverflowMenuId(null);
                                handleEditInEditor(skill.path);
                              }}
                            >
                              Edit in Editor
                            </button>
                            <button
                              type="button"
                              class="w-full flex items-center gap-2 px-3 py-1.5 bg-transparent border-none text-[12px] text-destructive cursor-pointer transition-colors hover:bg-surface-3 text-left"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOverflowMenuId(null);
                                handleUninstall(skill);
                              }}
                            >
                              Uninstall
                            </button>
                          </div>
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
                                : "Uninstall"}
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
        </Show>

        {/* Browse tab */}
        <Show when={!skillsStore.isLoading && activeTab() === "browse"}>
          <Show
            when={filteredBrowse().length > 0}
            fallback={
              <div class="px-4 py-8 text-center text-[13px] text-muted-foreground">
                {searchQuery() ? "No matching skills" : "No skills available"}
              </div>
            }
          >
            <div class="py-1">
              <For each={filteredBrowse()}>
                {(skill) => {
                  const installed = () => skillsStore.isInstalled(skill.id);
                  const installing = () => actionInProgress() === skill.id;

                  return (
                    <div class="border-b border-border/50 last:border-b-0">
                      {/* Card */}
                      <div
                        class="flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-surface-2/50"
                        classList={{
                          "bg-surface-2/30": expandedSkillId() === skill.id,
                        }}
                        onClick={() => toggleDetail(skill.id)}
                      >
                        {/* Info */}
                        <div class="flex-1 min-w-0">
                          <span class="text-[13px] font-medium text-foreground truncate block">
                            {skill.name}
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
                          <Show
                            when={!installed()}
                            fallback={
                              <span class="px-2 py-1 text-[11px] text-muted-foreground bg-surface-3 rounded">
                                Installed
                              </span>
                            }
                          >
                            <button
                              type="button"
                              class="px-2.5 py-1 bg-primary text-primary-foreground rounded-md text-[11px] font-medium cursor-pointer transition-colors hover:bg-primary/80 disabled:opacity-40"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleInstall(skill);
                              }}
                              disabled={installing()}
                            >
                              {installing() ? "Installing..." : "Install"}
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

                            {/* Install action */}
                            <Show when={!installed()}>
                              <div class="mt-2.5">
                                <button
                                  type="button"
                                  class="px-3 py-1 bg-primary text-primary-foreground rounded-md text-[12px] font-medium cursor-pointer transition-colors hover:bg-primary/80 disabled:opacity-40"
                                  onClick={() => handleInstall(skill)}
                                  disabled={installing()}
                                >
                                  {installing()
                                    ? "Installing..."
                                    : "Install to Seren"}
                                </button>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
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
