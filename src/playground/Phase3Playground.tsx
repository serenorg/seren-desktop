import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { FileTree } from "@/components/sidebar/FileTree";
import { FileTabs } from "@/components/editor/FileTabs";
import { MonacoEditor } from "@/components/editor/MonacoEditor";
import {
  setRootPath,
  setNodes,
  setSelectedPath,
  type FileNode,
} from "@/stores/fileTree";
import {
  openTab,
  tabsState,
  updateTabContent,
  setTabDirty,
  getActiveTab,
  closeAllTabs,
} from "@/stores/tabs";
import {
  initCompletionService,
  setApiHandler,
  registerInlineCompletionProvider,
} from "@/lib/completions";
import { initMonaco } from "@/lib/editor";
import type { CompletionContext, CompletionResult } from "@/lib/completions";
import "./Phase3Playground.css";

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
      (window as typeof window & { __phase3TestAPI?: unknown }).__phase3TestAPI = {
        openFile: handleFileSelect,
        getActiveFile: () => getActiveTab()?.filePath ?? null,
        getDirtyTabs: () => tabsState.tabs.filter((tab) => tab.isDirty).map((tab) => tab.filePath),
      };
    }
  });

  onCleanup(() => {
    if (typeof window !== "undefined" && (window as typeof window & { __phase3TestAPI?: unknown }).__phase3TestAPI) {
      delete (window as typeof window & { __phase3TestAPI?: unknown }).__phase3TestAPI;
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
    <div class="phase3-playground" data-testid="phase3-playground">
      <aside class="phase3-sidebar">
        <h2>File Tree</h2>
        <FileTree onFileSelect={handleFileSelect} />
      </aside>
      <section class="phase3-editor">
        <div class="phase3-tabs">
          <FileTabs />
        </div>
        <div class="phase3-editor-surface" data-testid="phase3-editor-pane">
          <Show
            when={activeFilePath()}
            fallback={<div class="phase3-editor-empty">Select a file from the tree</div>}
          >
            <div class="phase3-editor-header">
              <span data-testid="active-file-path">{activeFilePath()}</span>
            </div>
            <div data-testid="monaco-editor" class="phase3-editor-container">
              <MonacoEditor
                filePath={activeFilePath() ?? undefined}
                value={editorContent()}
                onChange={handleEditorChange}
                language={activeFilePath()?.endsWith(".md") ? "markdown" : undefined}
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
