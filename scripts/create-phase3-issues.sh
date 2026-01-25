#!/bin/bash
# Create Phase 3 GitHub issues for seren-desktop repository
# Phase 3: Code Intelligence - Monaco editor, inline completion

set -e

REPO="serenorg/seren-desktop"

echo "Creating Phase 3 issues (Code Intelligence) for $REPO..."

# Issue #23
gh issue create --repo $REPO \
  --title "Install and configure Monaco Editor" \
  --label "phase: 3-editor,type: feature,priority: critical,area: editor,agent: codex" \
  --body "## Overview
Install Monaco Editor and configure it for SolidJS/Vite.

## Dependencies
\`\`\`bash
pnpm add monaco-editor
pnpm add solid-monaco  # SolidJS wrapper
\`\`\`

## Files to Create

### src/lib/monaco-setup.ts
\`\`\`typescript
import * as monaco from \"monaco-editor\";

// Configure Monaco workers
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === \"typescript\" || label === \"javascript\") {
      return new Worker(
        new URL(\"monaco-editor/esm/vs/language/typescript/ts.worker\", import.meta.url)
      );
    }
    return new Worker(
      new URL(\"monaco-editor/esm/vs/editor/editor.worker\", import.meta.url)
    );
  },
};

// Default editor options
export const defaultOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: \"vs-dark\",
  fontSize: 14,
  lineHeight: 22,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  tabSize: 2,
  insertSpaces: true,
  renderIndentGuides: true,
  wordWrap: \"on\",
};

export { monaco };
\`\`\`

### Update vite.config.ts for Monaco
\`\`\`typescript
import { defineConfig } from \"vite\";
import solid from \"vite-plugin-solid\";

export default defineConfig({
  plugins: [solid()],
  optimizeDeps: {
    include: [\"monaco-editor\"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: [\"monaco-editor\"],
        },
      },
    },
  },
});
\`\`\`

## Definition of Done
- [ ] Monaco installed and configured
- [ ] Workers load correctly
- [ ] Editor renders in dark theme
- [ ] TypeScript/JavaScript support working
- [ ] No console errors

## Commit: \`feat: install and configure Monaco Editor\`"

# Issue #24
gh issue create --repo $REPO \
  --title "Create MonacoEditor wrapper component" \
  --label "phase: 3-editor,type: feature,priority: critical,area: editor,area: ui,agent: codex" \
  --body "## Overview
Create a SolidJS wrapper component for Monaco Editor.

## Files to Create

### src/components/editor/MonacoEditor.tsx
\`\`\`typescript
import { Component, onMount, onCleanup, createEffect } from \"solid-js\";
import { monaco, defaultOptions } from \"@/lib/monaco-setup\";
import \"./MonacoEditor.css\";

interface MonacoEditorProps {
  value: string;
  language: string;
  onChange?: (value: string) => void;
  onSelectionChange?: (selection: string, range: monaco.Range) => void;
  readOnly?: boolean;
}

export const MonacoEditor: Component<MonacoEditorProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;

  onMount(() => {
    if (!containerRef) return;

    editor = monaco.editor.create(containerRef, {
      ...defaultOptions,
      value: props.value,
      language: props.language,
      readOnly: props.readOnly,
    });

    // Handle content changes
    editor.onDidChangeModelContent(() => {
      props.onChange?.(editor!.getValue());
    });

    // Handle selection changes
    editor.onDidChangeCursorSelection((e) => {
      const selection = editor!.getModel()?.getValueInRange(e.selection) || \"\";
      if (selection) {
        props.onSelectionChange?.(selection, e.selection);
      }
    });
  });

  // Update value when prop changes
  createEffect(() => {
    if (editor && editor.getValue() !== props.value) {
      editor.setValue(props.value);
    }
  });

  onCleanup(() => {
    editor?.dispose();
  });

  return <div ref={containerRef} class=\"monaco-editor-container\" />;
};
\`\`\`

### src/components/editor/MonacoEditor.css
\`\`\`css
.monaco-editor-container {
  width: 100%;
  height: 100%;
  min-height: 400px;
}
\`\`\`

## Definition of Done
- [ ] Component renders Monaco editor
- [ ] Value prop updates editor content
- [ ] onChange fires on edits
- [ ] Selection changes tracked
- [ ] Properly disposed on unmount

## Commit: \`feat: create MonacoEditor wrapper component\`"

# Issue #25
gh issue create --repo $REPO \
  --title "Implement file tree sidebar" \
  --label "phase: 3-editor,type: feature,priority: high,area: editor,area: ui,agent: codex" \
  --body "## Overview
Create a file tree component for browsing project files.

## Files to Create

### src-tauri/src/commands/files.rs
\`\`\`rust
use std::fs;
use std::path::PathBuf;
use serde::Serialize;

#[derive(Serialize)]
pub struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<FileNode>>,
}

#[tauri::command]
pub async fn read_directory(path: String) -> Result<Vec<FileNode>, String> {
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut nodes = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files
        if name.starts_with('.') {
            continue;
        }

        nodes.push(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: path.is_dir(),
            children: None,
        });
    }

    // Sort: directories first, then by name
    nodes.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        }
    });

    Ok(nodes)
}
\`\`\`

### src/components/editor/FileTree.tsx
\`\`\`typescript
import { Component, For, createSignal } from \"solid-js\";
import { invoke } from \"@tauri-apps/api/core\";
import \"./FileTree.css\";

interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
}

interface FileTreeProps {
  rootPath: string;
  onFileSelect: (path: string) => void;
}

export const FileTree: Component<FileTreeProps> = (props) => {
  const [nodes, setNodes] = createSignal<FileNode[]>([]);

  // Load root directory
  const loadDirectory = async (path: string) => {
    const entries = await invoke<FileNode[]>(\"read_directory\", { path });
    setNodes(entries);
  };

  // Initial load
  loadDirectory(props.rootPath);

  return (
    <div class=\"file-tree\">
      <For each={nodes()}>
        {(node) => (
          <FileTreeNode
            node={node}
            onSelect={props.onFileSelect}
            onExpand={loadDirectory}
          />
        )}
      </For>
    </div>
  );
};
\`\`\`

## Definition of Done
- [ ] Shows directory contents
- [ ] Directories expandable/collapsible
- [ ] Files clickable to open
- [ ] Icons for file types
- [ ] Hidden files excluded

## Commit: \`feat: implement file tree sidebar\`"

# Issue #26
gh issue create --repo $REPO \
  --title "Add file tabs component" \
  --label "phase: 3-editor,type: feature,priority: high,area: editor,area: ui,agent: codex" \
  --body "## Overview
Create a tabbed interface for managing multiple open files.

## Files to Create

### src/stores/editor.store.ts (extend)
\`\`\`typescript
interface OpenFile {
  path: string;
  name: string;
  content: string;
  isDirty: boolean;
  language: string;
}

// Add to editor store
openFiles: OpenFile[];
activeFile: string | null;

openFile(path: string, content: string) { ... }
closeFile(path: string) { ... }
setActiveFile(path: string) { ... }
markDirty(path: string) { ... }
markClean(path: string) { ... }
\`\`\`

### src/components/editor/FileTabs.tsx
\`\`\`typescript
import { Component, For } from \"solid-js\";
import { editorStore } from \"@/stores/editor.store\";
import \"./FileTabs.css\";

export const FileTabs: Component = () => {
  return (
    <div class=\"file-tabs\">
      <For each={editorStore.openFiles}>
        {(file) => (
          <div
            class={\"file-tab \" + (file.path === editorStore.activeFile ? \"active\" : \"\")}
            onClick={() => editorStore.setActiveFile(file.path)}
          >
            <span class=\"tab-name\">
              {file.isDirty && <span class=\"dirty-dot\">●</span>}
              {file.name}
            </span>
            <button
              class=\"tab-close\"
              onClick={(e) => {
                e.stopPropagation();
                editorStore.closeFile(file.path);
              }}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
};
\`\`\`

## Definition of Done
- [ ] Tabs show open files
- [ ] Active tab highlighted
- [ ] Click switches active file
- [ ] Close button works
- [ ] Dirty indicator (dot) shown

## Commit: \`feat: add file tabs component\`"

# Issue #27
gh issue create --repo $REPO \
  --title "Create file service (open/save via Tauri)" \
  --label "phase: 3-editor,type: feature,priority: high,area: editor,area: rust,agent: codex" \
  --body "## Overview
Implement file open/save operations through Tauri.

## Files to Create/Modify

### src-tauri/src/commands/files.rs (extend)
\`\`\`rust
#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}
\`\`\`

### src/services/files.ts
\`\`\`typescript
import { invoke } from \"@tauri-apps/api/core\";
import { open, save } from \"@tauri-apps/plugin-dialog\";

export const files = {
  async read(path: string): Promise<string> {
    return invoke(\"read_file\", { path });
  },

  async write(path: string, content: string): Promise<void> {
    return invoke(\"write_file\", { path, content });
  },

  async openDialog(): Promise<string | null> {
    const selected = await open({
      multiple: false,
      filters: [
        { name: \"All Files\", extensions: [\"*\"] },
        { name: \"Code\", extensions: [\"ts\", \"js\", \"tsx\", \"jsx\", \"py\", \"rs\"] },
      ],
    });
    return selected as string | null;
  },

  async saveDialog(defaultPath?: string): Promise<string | null> {
    return save({ defaultPath });
  },

  getLanguage(path: string): string {
    const ext = path.split(\".\").pop()?.toLowerCase();
    const map: Record<string, string> = {
      ts: \"typescript\", tsx: \"typescript\",
      js: \"javascript\", jsx: \"javascript\",
      py: \"python\", rs: \"rust\",
      json: \"json\", md: \"markdown\",
      css: \"css\", html: \"html\",
    };
    return map[ext || \"\"] || \"plaintext\";
  },
};
\`\`\`

## Definition of Done
- [ ] Read file from disk
- [ ] Write file to disk
- [ ] Open file dialog works
- [ ] Save file dialog works
- [ ] Language detection by extension

## Commit: \`feat: create file service for open/save operations\`"

# Issue #28
gh issue create --repo $REPO \
  --title "Implement inline completion provider" \
  --label "phase: 3-editor,type: feature,priority: critical,area: editor,agent: codex" \
  --body "## Overview
Implement Monaco InlineCompletionItemProvider for AI-powered code suggestions.

## Configuration (from VS Code implementation)
- Prefix context: 4000 characters
- Suffix context: 1000 characters
- Temperature: 0.2
- Trigger delay: 300ms (configurable)
- Max suggestion lines: 10 (configurable)

## Files to Create

### src/components/editor/InlineCompletion.ts
\`\`\`typescript
import { monaco } from \"@/lib/monaco-setup\";
import { auth } from \"@/services/auth\";
import { config } from \"@/lib/config\";

const CONTEXT_PREFIX = 4000;
const CONTEXT_SUFFIX = 1000;

export function registerInlineCompletionProvider() {
  return monaco.languages.registerInlineCompletionsProvider(
    { pattern: \"**\" },
    {
      async provideInlineCompletions(model, position, context, token) {
        // Get context around cursor
        const textBefore = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        const textAfter = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: model.getLineCount(),
          endColumn: model.getLineMaxColumn(model.getLineCount()),
        });

        const prefix = textBefore.slice(-CONTEXT_PREFIX);
        const suffix = textAfter.slice(0, CONTEXT_SUFFIX);

        // Call Seren API
        const authToken = await auth.getToken();
        const response = await fetch(\`\${config.apiBase}/completions\`, {
          method: \"POST\",
          headers: {
            \"Content-Type\": \"application/json\",
            \"Authorization\": \`Bearer \${authToken}\`,
          },
          body: JSON.stringify({
            prefix,
            suffix,
            language: model.getLanguageId(),
            temperature: 0.2,
            max_tokens: 200,
          }),
        });

        if (!response.ok) return { items: [] };

        const data = await response.json();

        return {
          items: [{
            insertText: data.completion,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            ),
          }],
        };
      },

      freeInlineCompletions() {},
    }
  );
}
\`\`\`

## Definition of Done
- [ ] Ghost text appears after typing pause
- [ ] Tab accepts suggestion
- [ ] Escape dismisses suggestion
- [ ] Context sent to API (4000 prefix, 1000 suffix)
- [ ] Works for TypeScript, JavaScript, Python, Rust

## Commit: \`feat: implement inline completion provider\`"

# Issue #29
gh issue create --repo $REPO \
  --title "Add completion debouncing (300ms default)" \
  --label "phase: 3-editor,type: feature,priority: high,area: editor,agent: codex" \
  --body "## Overview
Add debouncing to inline completion to avoid excessive API calls.

## Configuration
- Default delay: 300ms
- Configurable via settings
- Cancel pending requests on new input

## Files to Modify

### src/lib/debounce.ts
\`\`\`typescript
export function debounce<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;

  return async (...args: Parameters<T>) => {
    // Cancel previous
    if (timeoutId) clearTimeout(timeoutId);
    if (abortController) abortController.abort();

    abortController = new AbortController();

    return new Promise((resolve, reject) => {
      timeoutId = setTimeout(async () => {
        try {
          const result = await fn(...args);
          resolve(result);
        } catch (error) {
          if (error.name !== \"AbortError\") {
            reject(error);
          }
        }
      }, delay);
    });
  };
}
\`\`\`

### Update InlineCompletion.ts
- Wrap API call in debounce
- Read delay from settings store
- Cancel on cursor move

## Definition of Done
- [ ] 300ms delay before API call
- [ ] Delay configurable in settings
- [ ] Previous requests cancelled
- [ ] No API calls while typing

## Commit: \`feat: add completion debouncing with 300ms default\`"

# Issue #30
gh issue create --repo $REPO \
  --title "Create completion caching layer" \
  --label "phase: 3-editor,type: feature,priority: medium,area: editor,agent: codex" \
  --body "## Overview
Cache completions to avoid redundant API calls for identical contexts.

## Requirements
- Cache by context hash (prefix + suffix + language)
- Max 100 cached completions
- Expire after 5 minutes
- LRU eviction

## Files to Create

### src/lib/completion-cache.ts
\`\`\`typescript
interface CacheEntry {
  completion: string;
  timestamp: number;
}

const CACHE_SIZE = 100;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

class CompletionCache {
  private cache = new Map<string, CacheEntry>();

  private hash(prefix: string, suffix: string, language: string): string {
    // Simple hash - could use crypto.subtle for better distribution
    const input = \`\${prefix}|\${suffix}|\${language}\`;
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString(36);
  }

  get(prefix: string, suffix: string, language: string): string | null {
    const key = this.hash(prefix, suffix, language);
    const entry = this.cache.get(key);

    if (!entry) return null;

    // Check expiry
    if (Date.now() - entry.timestamp > CACHE_TTL) {
      this.cache.delete(key);
      return null;
    }

    return entry.completion;
  }

  set(prefix: string, suffix: string, language: string, completion: string): void {
    const key = this.hash(prefix, suffix, language);

    // LRU eviction
    if (this.cache.size >= CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }

    this.cache.set(key, { completion, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }
}

export const completionCache = new CompletionCache();
\`\`\`

## Definition of Done
- [ ] Cache hit returns immediately
- [ ] 100 entry limit with LRU
- [ ] 5 minute TTL
- [ ] Clear cache function
- [ ] Cache used by InlineCompletion

## Commit: \`feat: create completion caching layer\`"

# Issue #31
gh issue create --repo $REPO \
  --title "Add language-specific completion filtering" \
  --label "phase: 3-editor,type: feature,priority: medium,area: editor,agent: codex" \
  --body "## Overview
Disable inline completion for certain file types (markdown, plaintext).

## Disabled Languages (from VS Code implementation)
- markdown
- plaintext
- diff
- log

## Files to Create

### src/stores/settings.store.ts (extend)
\`\`\`typescript
// Add to settings
completionDisabledLanguages: string[];

// Default
const DEFAULT_DISABLED = [\"markdown\", \"plaintext\", \"diff\", \"log\"];
\`\`\`

### Update InlineCompletion.ts
\`\`\`typescript
// Check if language is disabled
const language = model.getLanguageId();
const disabledLanguages = settingsStore.completionDisabledLanguages;

if (disabledLanguages.includes(language)) {
  return { items: [] };
}
\`\`\`

## Definition of Done
- [ ] No completions in markdown files
- [ ] No completions in plaintext files
- [ ] Configurable list in settings
- [ ] Can re-enable languages

## Commit: \`feat: add language-specific completion filtering\`"

# Issue #32
gh issue create --repo $REPO \
  --title "Implement 'Explain code' context action" \
  --label "phase: 3-editor,type: feature,priority: medium,area: editor,area: chat,agent: codex" \
  --body "## Overview
Add a context menu action to explain selected code in chat.

## UX Flow
1. User selects code in editor
2. Right-click → \"Explain Code\"
3. Selected code sent to chat as context
4. Chat panel opens with pre-filled prompt

## Files to Modify

### src/components/editor/MonacoEditor.tsx (extend)
\`\`\`typescript
// Add context menu action
editor.addAction({
  id: \"seren.explainCode\",
  label: \"Explain Code\",
  keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE],
  contextMenuGroupId: \"seren\",
  contextMenuOrder: 1,
  run: (ed) => {
    const selection = ed.getSelection();
    const text = ed.getModel()?.getValueInRange(selection) || \"\";
    if (text) {
      // Set context and switch to chat
      editorStore.setSelection(text, currentFile, selection);
      chatStore.setPrefilledPrompt(\"Explain this code:\");
      // Switch to chat panel
      appStore.setActivePanel(\"chat\");
    }
  },
});
\`\`\`

### Add more actions
- \"Fix Code\" - find and fix issues
- \"Add Comments\" - generate documentation
- \"Refactor\" - suggest improvements

## Definition of Done
- [ ] Right-click shows \"Explain Code\"
- [ ] Keyboard shortcut Cmd/Ctrl+E works
- [ ] Selected code sent to chat
- [ ] Chat panel opens automatically
- [ ] Pre-filled prompt shown

## Commit: \`feat: implement 'Explain code' context action\`"

echo ""
echo "Phase 3 issues created! (10 issues: #23-#32)"
echo "View at: https://github.com/$REPO/issues"
