// ABOUTME: Skills Explorer sidebar with installed skill folder trees and search.
// ABOUTME: Replaces the thread sidebar, embedding a collapsible File Explorer at the bottom.

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { type Component, createSignal, For, onMount, Show } from "solid-js";
import {
  ContextMenu,
  type ContextMenuItem,
} from "@/components/common/ContextMenu";
import { openFileInTab } from "@/lib/files/service";
import type { InstalledSkill, Skill, SkillScope } from "@/lib/skills";
import { skills as skillsService } from "@/services/skills";
import { fileTreeState } from "@/stores/fileTree";
import { skillsStore } from "@/stores/skills.store";
import { FileExplorer } from "./FileExplorer";

interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

interface SkillsExplorerProps {
  collapsed: boolean;
}

type SearchTab = "installed" | "available";

const SKILL_CREATOR_SLUG = "skill-creator";
const SKILL_CREATOR_SOURCE_URL =
  "https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md";

export const SkillsExplorer: Component<SkillsExplorerProps> = (props) => {
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchTab, setSearchTab] = createSignal<SearchTab>("installed");
  const [showFiles, setShowFiles] = createSignal(false);
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [newSkillName, setNewSkillName] = createSignal("");
  const [expandedSkills, setExpandedSkills] = createSignal<Set<string>>(
    new Set(),
  );
  const [skillChildren, setSkillChildren] = createSignal<
    Record<string, FileEntry[]>
  >({});

  onMount(async () => {
    await skillsStore.refresh();
    await ensureSkillCreatorInstalled();
  });

  // ── Default skill-creator install ─────────────

  const ensureSkillCreatorInstalled = async () => {
    const alreadyInstalled = skillsStore.installed.some(
      (s) => s.slug === SKILL_CREATOR_SLUG,
    );
    if (alreadyInstalled) return;

    try {
      const skill: Skill = {
        id: `anthropic:${SKILL_CREATOR_SLUG}`,
        slug: SKILL_CREATOR_SLUG,
        name: "Skill Creator",
        description:
          "Guide for creating effective skills. Use when users want to create or update a skill that extends capabilities with specialized knowledge, workflows, or tool integrations.",
        source: "anthropic",
        sourceUrl: SKILL_CREATOR_SOURCE_URL,
        tags: ["meta", "creation"],
        author: "Anthropic",
      };
      const content = await skillsService.fetchContent(skill);
      if (!content) return;
      await skillsStore.install(skill, content, "seren");
    } catch (err) {
      console.error("[SkillsExplorer] Failed to install skill-creator:", err);
    }
  };

  // ── Skill tree expansion ────────────────────────

  const toggleSkill = async (skill: InstalledSkill) => {
    const expanded = new Set(expandedSkills());
    const skillDir = skill.path.replace(/\/SKILL\.md$/, "");

    if (expanded.has(skill.id)) {
      expanded.delete(skill.id);
    } else {
      expanded.add(skill.id);
      // Lazy-load children if not cached
      if (!skillChildren()[skill.id]) {
        try {
          const entries = await invoke<FileEntry[]>("list_directory", {
            path: skillDir,
          });
          setSkillChildren((prev) => ({ ...prev, [skill.id]: entries }));
        } catch {
          // Directory may not exist or be empty
          setSkillChildren((prev) => ({ ...prev, [skill.id]: [] }));
        }
      }
    }
    setExpandedSkills(expanded);
  };

  const handleFileClick = (path: string) => {
    openFileInTab(path);
    window.dispatchEvent(
      new CustomEvent("seren:open-panel", { detail: "editor" }),
    );
  };

  const handleSkillSelect = (skill: InstalledSkill) => {
    skillsStore.setSelected(skill.id);
  };

  // ── Create Skill ──────────────────────────────

  const handleCreateSkill = async () => {
    const name = newSkillName().trim();
    if (!name) return;

    const slug = name.toLowerCase().replace(/\s+/g, "-");

    try {
      const skillsDir = await invoke<string>("get_seren_skills_dir");
      await invoke<string>("create_skill_folder", {
        skillsDir,
        slug,
        name,
      });
      await skillsStore.refreshInstalled();
      setNewSkillName("");
      setShowCreateDialog(false);
    } catch (err) {
      console.error("Failed to create skill folder:", err);
    }
  };

  // ── Upload / Download ───────────────────────────

  const handleUpload = async () => {
    const selected = await open({
      filters: [{ name: "Skill files", extensions: ["md"] }],
      multiple: false,
    });
    if (selected && typeof selected === "string") {
      try {
        const content = await invoke<string>("read_file", { path: selected });
        // Derive slug from filename
        const fileName = selected.split("/").pop() || "skill";
        const slug = fileName
          .replace(/\.md$/i, "")
          .toLowerCase()
          .replace(/\s+/g, "-");
        const skill: Skill = {
          id: `local:${slug}`,
          slug,
          name: slug,
          description: "Imported skill",
          source: "local",
          tags: [],
        };
        await skillsStore.install(skill, content, "seren");
      } catch (err) {
        console.error("Failed to upload skill:", err);
      }
    }
  };

  const handleDownload = async () => {
    const selected = skillsStore.selected;
    if (!selected || !("scope" in selected)) return;

    const content = await skillsService.readContent(selected as InstalledSkill);
    if (!content) return;

    const savePath = await save({
      defaultPath: `${selected.slug}-SKILL.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (savePath) {
      try {
        await invoke("write_file", { path: savePath, content });
      } catch (err) {
        console.error("Failed to save skill:", err);
      }
    }
  };

  // ── Search ──────────────────────────────────────

  const searchResults = () => {
    const q = searchQuery();
    if (!q) return [];
    if (searchTab() === "installed") {
      return skillsStore.installed.filter(
        (s) =>
          s.name.toLowerCase().includes(q.toLowerCase()) ||
          s.description.toLowerCase().includes(q.toLowerCase()),
      );
    }
    return skillsService.search(skillsStore.available, q);
  };

  const handleSearchInstall = async (skill: Skill) => {
    const content = await skillsService.fetchContent(skill);
    if (content) {
      await skillsStore.install(skill, content, "seren");
    }
  };

  // ── Context menu ─────────────────────────────────

  interface ContextMenuTarget {
    x: number;
    y: number;
    path: string;
    name: string;
    isDirectory: boolean;
    skillId?: string;
  }

  const [ctxMenu, setCtxMenu] = createSignal<ContextMenuTarget | null>(null);

  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

  const handleContextMenu = (
    e: MouseEvent,
    path: string,
    name: string,
    isDirectory: boolean,
    skillId?: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      path,
      name,
      isDirectory,
      skillId,
    });
  };

  const handleRevealInFinder = async (path: string) => {
    try {
      await invoke("reveal_in_file_manager", { path });
    } catch (err) {
      console.error("Failed to reveal in finder:", err);
    }
  };

  const handleCopyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
    } catch (err) {
      console.error("Failed to copy path:", err);
    }
  };

  const handleCopyRelativePath = async (path: string) => {
    try {
      const rootPath = fileTreeState.rootPath;
      let relativePath = path;
      if (rootPath && path.startsWith(rootPath)) {
        relativePath = path.slice(rootPath.length);
        if (relativePath.startsWith("/")) {
          relativePath = relativePath.slice(1);
        }
      }
      await navigator.clipboard.writeText(relativePath);
    } catch (err) {
      console.error("Failed to copy relative path:", err);
    }
  };

  const handleRenameCtx = async (path: string, oldName: string) => {
    const newName = window.prompt("Rename to:", oldName);
    if (!newName || newName === oldName) return;
    const dir = path.substring(0, path.lastIndexOf("/"));
    const newPath = `${dir}/${newName}`;
    try {
      await invoke("rename_path", { oldPath: path, newPath });
      await skillsStore.refreshInstalled();
    } catch (err) {
      console.error("Failed to rename:", err);
    }
  };

  const handleDeleteCtx = async (
    path: string,
    name: string,
    isDirectory: boolean,
    skillId?: string,
  ) => {
    const confirmDelete = window.confirm(
      `Delete "${name}"?${isDirectory ? " This will delete all contents." : ""}`,
    );
    if (!confirmDelete) return;
    try {
      await invoke("delete_path", { path });
      if (skillId) {
        // Removing an entire skill folder — refresh skill list
        await skillsStore.refreshInstalled();
      } else {
        await skillsStore.refreshInstalled();
      }
    } catch (err) {
      console.error("Failed to delete:", err);
      alert(`Failed to delete: ${err}`);
    }
  };

  const getCtxMenuItems = (target: ContextMenuTarget): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];

    items.push({
      label: isMac ? "Reveal in Finder" : "Reveal in Explorer",
      icon: "📂",
      shortcut: isMac ? "⌥⌘R" : "Shift+Alt+R",
      onClick: () => handleRevealInFinder(target.path),
    });

    items.push({ label: "", separator: true, onClick: () => {} });

    items.push({
      label: "Copy Path",
      icon: "📎",
      shortcut: isMac ? "⌥⌘C" : "Shift+Alt+C",
      onClick: () => handleCopyPath(target.path),
    });

    items.push({
      label: "Copy Relative Path",
      icon: "📎",
      shortcut: isMac ? "⇧⌥⌘C" : "Ctrl+Shift+Alt+C",
      onClick: () => handleCopyRelativePath(target.path),
    });

    items.push({ label: "", separator: true, onClick: () => {} });

    items.push({
      label: "Rename",
      icon: "✏️",
      shortcut: "Enter",
      onClick: () => handleRenameCtx(target.path, target.name),
    });

    items.push({
      label: "Delete",
      icon: "🗑️",
      shortcut: isMac ? "⌘⌫" : "Delete",
      onClick: () =>
        handleDeleteCtx(
          target.path,
          target.name,
          target.isDirectory,
          target.skillId,
        ),
    });

    return items;
  };

  // ── Scope label ─────────────────────────────────

  const scopeLabel = (scope: SkillScope) => {
    switch (scope) {
      case "seren":
        return "S";
      case "claude":
        return "C";
      case "project":
        return "P";
    }
  };

  // ── Render ──────────────────────────────────────

  return (
    <aside
      class="w-[var(--sidebar-width)] min-w-[var(--sidebar-width)] flex flex-col bg-surface-1 border-r border-border transition-all duration-200 overflow-hidden"
      classList={{ "w-0 min-w-0 opacity-0 border-r-0": props.collapsed }}
    >
      {/* Header */}
      <div class="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
        <span class="text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          Skills
        </span>
        <div class="flex items-center gap-0.5">
          <button
            type="button"
            class="flex items-center justify-center w-6 h-6 bg-transparent border-none rounded text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-[rgba(148,163,184,0.1)] hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => setShowCreateDialog(true)}
            title="Create skill"
          >
            <svg
              width="14"
              height="14"
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
          </button>
          <button
            type="button"
            class="flex items-center justify-center w-6 h-6 bg-transparent border-none rounded text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-[rgba(148,163,184,0.1)] hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleUpload}
            title="Upload skill"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              role="img"
              aria-label="Upload"
            >
              <path
                d="M8 2v8M4 6l4-4 4 4M3 12h10"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            class="flex items-center justify-center w-6 h-6 bg-transparent border-none rounded text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-[rgba(148,163,184,0.1)] hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleDownload}
            disabled={
              !skillsStore.selected ||
              !("scope" in (skillsStore.selected || {}))
            }
            title="Download skill"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              role="img"
              aria-label="Download"
            >
              <path
                d="M8 2v8M4 6l4 4 4-4M3 12h10"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            class="flex items-center justify-center w-6 h-6 bg-transparent border-none rounded text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-[rgba(148,163,184,0.1)] hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => skillsStore.refresh()}
            disabled={skillsStore.isLoading}
            title="Refresh skills"
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
                d="M2.5 8a5.5 5.5 0 019.3-4M13.5 8a5.5 5.5 0 01-9.3 4"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
              <path
                d="M12 1v3h-3M4 12v3h3"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Create Skill dialog */}
      <Show when={showCreateDialog()}>
        <div class="px-2.5 py-2 border-b border-border flex flex-col gap-1.5">
          <input
            class="w-full px-2 py-1.5 text-[13px] bg-surface-2 border border-[rgba(148,163,184,0.2)] rounded-[5px] text-foreground outline-none transition-colors duration-150 placeholder:text-muted-foreground focus:border-primary"
            type="text"
            placeholder="Skill name (e.g. lead-finder)"
            value={newSkillName()}
            onInput={(e) => setNewSkillName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateSkill();
              if (e.key === "Escape") setShowCreateDialog(false);
            }}
            autofocus
          />
          <div class="flex gap-1">
            <button
              type="button"
              class="flex-1 px-2 py-1 text-xs font-medium border border-[rgba(148,163,184,0.2)] rounded-[5px] bg-transparent text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-[rgba(148,163,184,0.08)] hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed bg-[rgba(56,189,248,0.12)] text-primary border-primary hover:bg-[rgba(56,189,248,0.2)]"
              onClick={handleCreateSkill}
              disabled={!newSkillName().trim()}
            >
              Create
            </button>
            <button
              type="button"
              class="flex-1 px-2 py-1 text-xs font-medium border border-[rgba(148,163,184,0.2)] rounded-[5px] bg-transparent text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-[rgba(148,163,184,0.08)] hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
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

      {/* Installed skills with folder trees */}
      <div class="flex-1 overflow-y-auto py-1 min-h-0">
        <Show when={skillsStore.isLoading}>
          <div class="p-4 text-center text-xs text-muted-foreground opacity-50">
            Loading skills...
          </div>
        </Show>

        <Show
          when={!skillsStore.isLoading && skillsStore.installed.length === 0}
        >
          <div class="px-4 py-6 text-center text-[13px] text-muted-foreground opacity-60 leading-relaxed">
            No skills installed yet. Upload a SKILL.md or search for available
            skills below.
          </div>
        </Show>

        <Show when={!skillsStore.isLoading && skillsStore.installed.length > 0}>
          <For each={skillsStore.installed}>
            {(skill) => (
              <div class="mb-px">
                <button
                  type="button"
                  class="flex items-center gap-1 w-full px-2 py-1.5 pl-2.5 bg-transparent border-none text-foreground text-[13px] cursor-pointer text-left transition-colors duration-100 hover:bg-[rgba(148,163,184,0.06)]"
                  classList={{
                    "bg-[rgba(56,189,248,0.08)]":
                      skillsStore.selectedId === skill.id,
                  }}
                  onClick={() => {
                    handleSkillSelect(skill);
                    toggleSkill(skill);
                  }}
                  onContextMenu={(e) => {
                    const skillDir = skill.path.replace(/\/SKILL\.md$/, "");
                    handleContextMenu(e, skillDir, skill.name, true, skill.id);
                  }}
                >
                  {/* Chevron */}
                  <svg
                    class="w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform duration-150"
                    classList={{
                      "rotate-90": expandedSkills().has(skill.id),
                    }}
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    role="img"
                    aria-label="Expand"
                  >
                    <path
                      d="M6 4l4 4-4 4"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  {/* Folder icon */}
                  <svg
                    class="shrink-0 text-primary opacity-70"
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    role="img"
                    aria-label="Skill folder"
                  >
                    <path
                      d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2h5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                      stroke="currentColor"
                      stroke-width="1.2"
                    />
                  </svg>
                  <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                    {skill.name}
                  </span>
                  <span class="text-[10px] px-1 py-px rounded-[3px] bg-[rgba(148,163,184,0.1)] text-muted-foreground shrink-0">
                    {scopeLabel(skill.scope)}
                  </span>
                  <span
                    class="w-1.5 h-1.5 rounded-full shrink-0"
                    classList={{
                      "bg-success": skillsStore.isEnabled(skill.id),
                      "bg-muted-foreground opacity-30": !skillsStore.isEnabled(
                        skill.id,
                      ),
                    }}
                  />
                </button>

                {/* Expanded folder tree */}
                <Show when={expandedSkills().has(skill.id)}>
                  <div class="pl-[18px]">
                    <Show
                      when={skillChildren()[skill.id]?.length}
                      fallback={
                        <div class="p-4 text-center text-xs text-muted-foreground opacity-50">
                          Loading...
                        </div>
                      }
                    >
                      <For each={skillChildren()[skill.id]}>
                        {(entry) => (
                          <button
                            type="button"
                            class="flex items-center gap-1 w-full px-2 py-[3px] pl-1.5 bg-transparent border-none text-muted-foreground text-xs cursor-pointer text-left transition-all duration-100 hover:bg-[rgba(148,163,184,0.06)] hover:text-foreground"
                            classList={{
                              "text-foreground font-medium": entry.is_directory,
                            }}
                            onClick={() => {
                              if (!entry.is_directory) {
                                handleFileClick(entry.path);
                              }
                            }}
                            onContextMenu={(e) =>
                              handleContextMenu(
                                e,
                                entry.path,
                                entry.name,
                                entry.is_directory,
                              )
                            }
                          >
                            <Show
                              when={entry.is_directory}
                              fallback={
                                <svg
                                  class="w-3.5 h-3.5 shrink-0 opacity-60"
                                  width="14"
                                  height="14"
                                  viewBox="0 0 16 16"
                                  fill="none"
                                  role="img"
                                  aria-label="File"
                                >
                                  <path
                                    d="M4 2h5l3 3v9H4V2z"
                                    stroke="currentColor"
                                    stroke-width="1.2"
                                  />
                                  <path
                                    d="M9 2v3h3"
                                    stroke="currentColor"
                                    stroke-width="1.2"
                                  />
                                </svg>
                              }
                            >
                              <svg
                                class="w-3.5 h-3.5 shrink-0 opacity-60"
                                width="14"
                                height="14"
                                viewBox="0 0 16 16"
                                fill="none"
                                role="img"
                                aria-label="Directory"
                              >
                                <path
                                  d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2h5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                                  stroke="currentColor"
                                  stroke-width="1.2"
                                />
                              </svg>
                            </Show>
                            <span class="overflow-hidden text-ellipsis whitespace-nowrap">
                              {entry.name}
                            </span>
                          </button>
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>

      {/* Search section */}
      <div class="shrink-0 border-t border-border px-2.5 py-2">
        <input
          class="w-full px-2 py-1.5 text-[13px] bg-surface-2 border border-[rgba(148,163,184,0.2)] rounded-[5px] text-foreground outline-none transition-colors duration-150 placeholder:text-muted-foreground focus:border-primary"
          type="text"
          placeholder="Search skills..."
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />

        <div class="flex gap-0 mt-1.5 rounded-[5px] overflow-hidden border border-[rgba(148,163,184,0.2)]">
          <button
            type="button"
            class="flex-1 py-1 text-xs font-medium text-center border-none cursor-pointer bg-transparent text-muted-foreground transition-all duration-100 hover:bg-[rgba(148,163,184,0.08)]"
            classList={{
              "bg-[rgba(56,189,248,0.12)] text-foreground":
                searchTab() === "installed",
            }}
            onClick={() => setSearchTab("installed")}
          >
            Installed
          </button>
          <button
            type="button"
            class="flex-1 py-1 text-xs font-medium text-center border-none cursor-pointer bg-transparent text-muted-foreground transition-all duration-100 hover:bg-[rgba(148,163,184,0.08)]"
            classList={{
              "bg-[rgba(56,189,248,0.12)] text-foreground":
                searchTab() === "available",
            }}
            onClick={() => setSearchTab("available")}
          >
            Available
          </button>
        </div>

        <Show when={searchQuery() && searchResults().length > 0}>
          <div class="max-h-[160px] overflow-y-auto mt-1.5">
            <For each={searchResults()}>
              {(skill) => (
                <button
                  type="button"
                  class="flex flex-col gap-px w-full px-2 py-1.5 bg-transparent border-none rounded text-foreground text-[13px] cursor-pointer text-left transition-colors duration-100 hover:bg-[rgba(148,163,184,0.08)]"
                  onClick={() => {
                    if (searchTab() === "available") {
                      handleSearchInstall(skill);
                    } else {
                      skillsStore.setSelected(skill.id);
                    }
                  }}
                >
                  <span class="font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                    {skill.name}
                  </span>
                  <span class="text-[11px] text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
                    {skill.description}
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      {/* Collapsible File Explorer */}
      <div class="shrink-0 border-t border-border">
        <button
          type="button"
          class="flex items-center gap-1.5 w-full px-3 py-2 bg-transparent border-none text-muted-foreground text-xs font-semibold uppercase tracking-[0.04em] cursor-pointer transition-colors duration-100 hover:bg-[rgba(148,163,184,0.06)]"
          onClick={() => setShowFiles((v) => !v)}
        >
          <svg
            class="w-3 h-3 transition-transform duration-150"
            classList={{ "rotate-90": showFiles() }}
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            role="img"
            aria-label="Toggle files"
          >
            <path
              d="M6 4l4 4-4 4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          Files
        </button>
        <Show when={showFiles()}>
          <div class="max-h-[300px] overflow-y-auto">
            <FileExplorer />
          </div>
        </Show>
      </div>

      {/* Context menu */}
      <Show when={ctxMenu()}>
        {(menu) => (
          <ContextMenu
            items={getCtxMenuItems(menu())}
            x={menu().x}
            y={menu().y}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </Show>
    </aside>
  );
};
