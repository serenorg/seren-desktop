import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { FileTabs } from "@/components/editor/FileTabs";
import { MonacoEditor } from "@/components/editor/MonacoEditor";
import { FileTree } from "@/components/sidebar/FileTree";
import type { CompletionContext, CompletionResult } from "@/lib/completions";
import {
  initCompletionService,
  registerInlineCompletionProvider,
  setApiHandler,
} from "@/lib/completions";
import { initMonaco } from "@/lib/editor";
import {
  type FileNode,
  setNodes,
  setRootPath,
  setSelectedPath,
} from "@/stores/fileTree";
import {
  closeAllTabs,
  getActiveTab,
  openTab,
  setTabDirty,
  tabsState,
  updateTabContent,
} from "@/stores/tabs";

const SAMPLE_FILES: Record<string, string> = {
  "/workspace/src/App.tsx": `import type { Component } from "solid-js";

export const PlaygroundApp: Component = () => {
  const greeting = "Hello from Seren";
  console.log(greeting);
  return <div class="playground-app">{greeting}</div>;
};
`,
  "/workspace/src/components/Hello.tsx": `export function Hello() {
  return <p>Phase 3 playground</p>;
}
`,
  "/workspace/src/utils/math.ts": `export function add(a: number, b: number) {
  return a + b;
}
`,
  "/workspace/README.md": `# Seren Playground\n\nThis is a fake project used for Playwright e2e tests.`,
};

const SAMPLE_TREE: FileNode[] = [
  {
    name: "src",
    path: "/workspace/src",
    isDirectory: true,
    children: [
      {
        name: "App.tsx",
        path: "/workspace/src/App.tsx",
        isDirectory: false,
      },
      {
        name: "components",
        path: "/workspace/src/components",
        isDirectory: true,
        children: [
          {
            name: "Hello.tsx",
            path: "/workspace/src/components/Hello.tsx",
            isDirectory: false,
          },
        ],
      },
      {
        name: "utils",
        path: "/workspace/src/utils",
        isDirectory: true,
        children: [
          {
            name: "math.ts",
            path: "/workspace/src/utils/math.ts",
            isDirectory: false,
          },
        ],
      },
    ],
  },
  {
    name: "README.md",
    path: "/workspace/README.md",
    isDirectory: false,
  },
];

let completionsRegistered = false;

async function ensureCompletionProvider(): Promise<void> {
  if (completionsRegistered) return;
  await initMonaco();
  initCompletionService();
  registerInlineCompletionProvider();
  setApiHandler(async (context) => mockCompletions(context));
  completionsRegistered = true;
}

function mockCompletions(context: CompletionContext): CompletionResult[] {
  const { lineNumber, column, prefix } = context;
  if (prefix.endsWith("console.")) {
    return [
      {
        text: "log('Seren inline completion')",
        range: {
          startLineNumber: lineNumber,
          startColumn: column,
          endLineNumber: lineNumber,
          endColumn: column,
        },
      },
    ];
  }

  if (prefix.trim().endsWith("return")) {
    return [
      {
        text: " add(a, b);",
        range: {
          startLineNumber: lineNumber,
          startColumn: column,
          endLineNumber: lineNumber,
          endColumn: column,
        },
      },
    ];
  }

  return [];
}

export const Phase3Playground = () => {
  const [editorContent, setEditorContent] = createSignal("");
  const [activeFilePath, setActiveFilePath] = createSignal<string | null>(null);

  onMount(() => {
    setRootPath("/workspace");
    setNodes(cloneTree(SAMPLE_TREE));
    setSelectedPath(null);
    closeAllTabs();
    ensureCompletionProvider();
    openInitialFile();

    // expose minimal test API for Playwright helpers
    if (typeof window !== "undefined") {
      (
        window as typeof window & { __phase3TestAPI?: unknown }
      ).__phase3TestAPI = {
        openFile: handleFileSelect,
        getActiveFile: () => getActiveTab()?.filePath ?? null,
        getDirtyTabs: () =>
          tabsState.tabs
            .filter((tab) => tab.isDirty)
            .map((tab) => tab.filePath),
      };
    }
  });

  onCleanup(() => {
    if (
      typeof window !== "undefined" &&
      (window as typeof window & { __phase3TestAPI?: unknown }).__phase3TestAPI
    ) {
      delete (window as typeof window & { __phase3TestAPI?: unknown })
        .__phase3TestAPI;
    }
  });

  createEffect(() => {
    const activeId = tabsState.activeTabId;
    const activeTab = tabsState.tabs.find((tab) => tab.id === activeId);
    if (activeTab) {
      setActiveFilePath(activeTab.filePath);
      setEditorContent(activeTab.content);
      setSelectedPath(activeTab.filePath);
    } else {
      setActiveFilePath(null);
      setEditorContent("Select a file to begin editing");
    }
  });

  function openInitialFile(): void {
    handleFileSelect("/workspace/src/App.tsx");
  }

  function handleFileSelect(path: string): void {
    const content = SAMPLE_FILES[path] ?? "// Sample file";
    setSelectedPath(path);
    openTab(path, content);
  }

  function handleEditorChange(value: string): void {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    updateTabContent(activeTab.id, value);
    const baseline = SAMPLE_FILES[activeTab.filePath] ?? "";
    setTabDirty(activeTab.id, value !== baseline);
    setEditorContent(value);
  }

  return (
    <div class="flex h-screen bg-[radial-gradient(circle_at_top,#111827,#020617_70%)] text-white" data-testid="phase3-playground">
      <aside class="w-[280px] p-4 border-r border-[rgba(255,255,255,0.1)] bg-[rgba(2,6,23,0.85)]">
        <h2 class="mt-0 text-base uppercase tracking-[0.08em] text-[#94a3b8]">File Tree</h2>
        <FileTree onFileSelect={handleFileSelect} />
      </aside>
      <section class="flex-1 flex flex-col bg-[rgba(15,23,42,0.8)]">
        <div class="p-3 border-b border-[rgba(255,255,255,0.08)]">
          <FileTabs />
        </div>
        <div class="flex-1 flex flex-col px-3 pb-3" data-testid="phase3-editor-pane">
          <Show
            when={activeFilePath()}
            fallback={
              <div class="flex-1 flex items-center justify-center text-[#94a3b8]">Select a file from the tree</div>
            }
          >
            <div class="text-[0.9rem] text-[#94a3b8] my-3">
              <span data-testid="active-file-path">{activeFilePath()}</span>
            </div>
            <div data-testid="monaco-editor" class="flex-1 border border-[rgba(255,255,255,0.12)] rounded-lg overflow-hidden bg-[#0f172a]">
              <MonacoEditor
                filePath={activeFilePath() ?? undefined}
                value={editorContent()}
                onChange={handleEditorChange}
                language={
                  activeFilePath()?.endsWith(".md") ? "markdown" : undefined
                }
              />
            </div>
          </Show>
        </div>
      </section>
    </div>
  );
};

export default Phase3Playground;

function cloneTree(nodes: FileNode[]): FileNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? cloneTree(node.children) : undefined,
  }));
}
