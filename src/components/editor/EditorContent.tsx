// ABOUTME: Editor content panel without file tree for resizable layout.
// ABOUTME: Shows file tabs, Monaco editor, and file viewers.

import type * as Monaco from "monaco-editor";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onMount,
  Show,
} from "solid-js";
import {
  setAddToChatHandler,
  setExplainCodeHandler,
  setImproveCodeHandler,
  setInlineEditHandler,
} from "@/lib/editor";
import { saveTab } from "@/lib/files/service";
import { authStore } from "@/stores/auth.store";
import { editorStore } from "@/stores/editor.store";
import { setSelectedPath } from "@/stores/fileTree";
import { skillPublishStore } from "@/stores/skill-publish.store";
import { skillsStore } from "@/stores/skills.store";
import {
  getActiveTab,
  setTabDirty,
  tabsState,
  updateTabContent,
} from "@/stores/tabs";
import { FileTabs } from "./FileTabs";
import { ImageViewer } from "./ImageViewer";
import { InlineEditWidget } from "./InlineEditWidget";
import { MarkdownPreview } from "./MarkdownPreview";
import { MonacoEditor, type SavedFileSnapshot } from "./MonacoEditor";
import { PdfViewer } from "./PdfViewer";

// State for inline edit widget
interface InlineEditState {
  editor: Monaco.editor.IStandaloneCodeEditor;
  selection: Monaco.Selection;
  originalCode: string;
  language: string;
  filePath: string;
}

interface EditorContentProps {
  active?: boolean;
  onClose?: () => void;
}

export const EditorContent: Component<EditorContentProps> = (props) => {
  const [editorContent, setEditorContent] = createSignal("");
  const [activeFilePath, setActiveFilePath] = createSignal<string | null>(null);
  const [showPreview, setShowPreview] = createSignal(false);
  const [inlineEditState, setInlineEditState] =
    createSignal<InlineEditState | null>(null);
  const [savingTabId, setSavingTabId] = createSignal<string | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [savedSnapshot, setSavedSnapshot] =
    createSignal<SavedFileSnapshot | null>(null);

  const activeTab = createMemo(() =>
    tabsState.tabs.find((tab) => tab.id === tabsState.activeTabId),
  );

  // The publish button only surfaces when the active tab is a skill the
  // user can publish - either an unpublished authored skill (first-time
  // publish) or one they already own (new-version publish). Skills they
  // don't own and skills with no matching SKILL.md path stay hidden.
  const publishableSkill = createMemo(() => {
    const tab = activeTab();
    if (!tab) return null;
    const skill = skillsStore.installed.find(
      (s) => s.path === tab.filePath || s.authoringPath === tab.filePath,
    );
    if (!skill) return null;
    const userId = authStore.user?.id;
    if (!userId) return null;
    const catalog = skillsStore.available.find((s) => s.slug === skill.slug);
    if (!catalog) {
      return { skill, mode: "first" as const };
    }
    if (catalog.publisher?.createdByUserId === userId) {
      return { skill, mode: "version" as const, catalog };
    }
    return null;
  });

  const handlePublish = () => {
    const target = publishableSkill();
    if (!target) return;
    if (target.mode === "first") {
      skillPublishStore.requestFirstPublish(target.skill.path);
    } else {
      skillPublishStore.requestVersionPublish(target.skill.path);
    }
  };

  const saveStatus = createMemo(() => {
    if (saveError()) return "Save failed";
    const tab = activeTab();
    if (!tab) return null;
    if (savingTabId() === tab.id) return "Saving...";
    return tab.isDirty ? "Unsaved changes" : "Saved";
  });

  const saveStatusClass = createMemo(() => {
    if (saveError()) return "text-destructive";
    const tab = activeTab();
    if (tab?.isDirty) return "text-warning";
    return "text-muted-foreground";
  });

  // Register all context menu handlers
  onMount(() => {
    // Cmd+K: Inline edit with AI
    setInlineEditHandler((code, language, filePath, selection, editor) => {
      setInlineEditState({
        editor,
        selection,
        originalCode: code,
        language,
        filePath,
      });
    });

    // Add to Chat: Set selection as context (no auto-send)
    setAddToChatHandler((code, language, filePath) => {
      const lines = code.split("\n");
      editorStore.setSelectionWithAction(
        code,
        filePath,
        { startLine: 1, endLine: lines.length },
        language,
        "add-to-chat",
      );
    });

    // Explain Code: Set selection and trigger explain prompt
    setExplainCodeHandler((code, language, filePath) => {
      const lines = code.split("\n");
      editorStore.setSelectionWithAction(
        code,
        filePath,
        { startLine: 1, endLine: lines.length },
        language,
        "explain",
      );
    });

    // Improve Code: Set selection and trigger improve prompt
    setImproveCodeHandler((code, language, filePath) => {
      const lines = code.split("\n");
      editorStore.setSelectionWithAction(
        code,
        filePath,
        { startLine: 1, endLine: lines.length },
        language,
        "improve",
      );
    });
  });

  // Check if current file is markdown
  const isMarkdownFile = createMemo(() => {
    const path = activeFilePath();
    if (!path) return false;
    return (
      path.toLowerCase().endsWith(".md") ||
      path.toLowerCase().endsWith(".markdown")
    );
  });

  // Check if current file is an image
  const isImageFile = createMemo(() => {
    const path = activeFilePath();
    if (!path) return false;
    const ext = path.toLowerCase().split(".").pop();
    return ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"].includes(
      ext || "",
    );
  });

  // Check if current file is a PDF
  const isPdfFile = createMemo(() => {
    const path = activeFilePath();
    if (!path) return false;
    return path.toLowerCase().endsWith(".pdf");
  });

  // Sync editor content with active tab
  createEffect(() => {
    const activeId = tabsState.activeTabId;
    const activeTab = tabsState.tabs.find((tab) => tab.id === activeId);
    if (activeTab) {
      setActiveFilePath(activeTab.filePath);
      setEditorContent(activeTab.content);
      setSelectedPath(activeTab.filePath);
    } else {
      setActiveFilePath(null);
      setEditorContent("");
    }
  });

  createEffect(() => {
    tabsState.activeTabId;
    setSaveError(null);
  });

  function handleEditorChange(value: string) {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    setSaveError(null);
    updateTabContent(activeTab.id, value);
    setEditorContent(value);
  }

  async function handleEditorDirtyChange(isDirty: boolean) {
    const activeTab = getActiveTab();
    if (activeTab) {
      setTabDirty(activeTab.id, isDirty);
    }
  }

  async function handleSave() {
    const tab = getActiveTab();
    if (!tab || savingTabId() !== null) return;
    const tabId = tab.id;
    const filePath = tab.filePath;
    const content = tab.content;
    setSavingTabId(tabId);
    setSaveError(null);
    try {
      const savedCurrentContent = await saveTab(tabId, filePath, content);
      if (savedCurrentContent) {
        setSavedSnapshot((snapshot) => ({
          revision: (snapshot?.revision ?? 0) + 1,
          filePath,
          content,
        }));
      }
    } catch (error) {
      console.error("Failed to save file:", error);
      setSaveError(error instanceof Error ? error.message : "Unable to save");
    } finally {
      setSavingTabId((current) => (current === tabId ? null : current));
    }
  }

  // Handle Cmd/Ctrl+S to save
  function handleKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      handleSave();
    }
  }

  // Handle inline edit accept - apply the new code
  function handleInlineEditAccept(newCode: string) {
    const state = inlineEditState();
    if (!state) return;

    // Apply the edit via Monaco's executeEdits
    state.editor.executeEdits("seren.inlineEdit", [
      {
        range: state.selection,
        text: newCode,
      },
    ]);

    // Close the widget
    setInlineEditState(null);

    // Focus back on editor
    state.editor.focus();
  }

  // Handle inline edit reject - just close the widget
  function handleInlineEditReject() {
    const state = inlineEditState();
    setInlineEditState(null);

    // Focus back on editor if we have a reference
    state?.editor.focus();
  }

  return (
    <div
      class="flex flex-col h-full bg-card text-foreground"
      onKeyDown={handleKeyDown}
    >
      <Show when={props.onClose}>
        <div class="shrink-0 flex justify-between items-center px-3 py-2 border-b border-border-medium bg-surface-0">
          <span class="text-xs font-medium text-muted-foreground">Editor</span>
          <div class="flex items-center gap-2">
            <Show when={saveStatus()}>
              {(status) => (
                <span class={`text-[11px] ${saveStatusClass()}`}>
                  {status()}
                </span>
              )}
            </Show>
            <button
              type="button"
              class="rounded-sm border border-border bg-surface-1 px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleSave}
              disabled={!activeTab()?.isDirty || savingTabId() !== null}
              title="Save file (Cmd/Ctrl+S)"
            >
              {savingTabId() === activeTab()?.id ? "Saving..." : "Save"}
            </button>
            <Show when={publishableSkill()}>
              {(target) => (
                <button
                  type="button"
                  class="rounded-sm border border-primary/40 bg-primary/[0.08] px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/[0.18]"
                  onClick={handlePublish}
                  title={
                    target().mode === "first"
                      ? "Publish this skill to Seren Skills"
                      : "Publish a new version to Seren Skills"
                  }
                >
                  {target().mode === "first" ? "Publish" : "Publish update"}
                </button>
              )}
            </Show>
            <button
              type="button"
              class="bg-transparent border-none text-muted-foreground cursor-pointer px-1.5 py-0.5 text-sm leading-none hover:text-foreground"
              onClick={props.onClose}
              title="Close Editor"
            >
              ×
            </button>
          </div>
        </div>
      </Show>
      <div class="shrink-0 border-b border-border-medium">
        <FileTabs
          isMarkdown={isMarkdownFile()}
          showPreview={showPreview()}
          onTogglePreview={() => setShowPreview((prev) => !prev)}
        />
      </div>
      <div
        class={`flex-1 min-h-0 relative flex ${showPreview() && isMarkdownFile() ? "flex-row" : ""}`}
      >
        <Show
          when={activeFilePath()}
          fallback={
            <div class="h-full flex items-center justify-center p-6">
              <div class="text-center max-w-[320px]">
                <span class="text-5xl block mb-4 opacity-60">📝</span>
                <h2 class="m-0 mb-2 text-xl font-medium text-foreground">
                  No file open
                </h2>
                <p class="m-0 mb-5 text-muted-foreground leading-normal">
                  Select a file from the explorer, or use{" "}
                  <kbd class="bg-border-hover px-1.5 py-0.5 rounded font-inherit text-[0.9em]">
                    {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+O
                  </kbd>{" "}
                  to open a file.
                </p>
              </div>
            </div>
          }
        >
          {(filePath) => (
            <Show
              when={isImageFile()}
              fallback={
                <Show
                  when={isPdfFile()}
                  fallback={
                    <>
                      <div class="flex-1 min-w-0 h-full">
                        <MonacoEditor
                          filePath={filePath()}
                          value={editorContent()}
                          active={props.active}
                          onChange={handleEditorChange}
                          onDirtyChange={handleEditorDirtyChange}
                          savedSnapshot={savedSnapshot()}
                        />
                      </div>
                      <Show when={showPreview() && isMarkdownFile()}>
                        <MarkdownPreview content={editorContent()} />
                      </Show>
                    </>
                  }
                >
                  <PdfViewer filePath={filePath()} />
                </Show>
              }
            >
              <ImageViewer filePath={filePath()} />
            </Show>
          )}
        </Show>
      </div>

      {/* Inline Edit Widget (Cmd+K) */}
      <Show when={inlineEditState()}>
        {(state) => (
          <InlineEditWidget
            editor={state().editor}
            selection={state().selection}
            originalCode={state().originalCode}
            language={state().language}
            filePath={state().filePath}
            onAccept={handleInlineEditAccept}
            onReject={handleInlineEditReject}
          />
        )}
      </Show>
    </div>
  );
};
