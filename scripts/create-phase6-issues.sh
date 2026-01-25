#!/bin/bash

# Phase 6: Polish & Release Issues (#53-#62)
# Run this script to create all Phase 6 GitHub issues

set -e

REPO="serenorg/seren-desktop"

echo "Creating Phase 6 issues for Polish & Release..."

# Issue #53: Keyboard Shortcuts System
gh issue create --repo "$REPO" \
  --title "Implement global keyboard shortcuts system" \
  --label "phase:6-polish,component:ui,priority:high,agent: codex" \
  --body "## Overview
Implement a comprehensive keyboard shortcuts system matching VS Code conventions.

## Technical Requirements

### Keyboard Shortcuts Manager
Create \`src/lib/shortcuts/manager.ts\`:
\`\`\`typescript
import { createSignal, onCleanup, onMount } from 'solid-js';

export interface KeyboardShortcut {
  id: string;
  keys: string; // e.g., 'Cmd+Shift+P' or 'Ctrl+Shift+P'
  action: () => void;
  description: string;
  when?: () => boolean; // Condition for when shortcut is active
}

const [shortcuts, setShortcuts] = createSignal<Map<string, KeyboardShortcut>>(new Map());

export function registerShortcut(shortcut: KeyboardShortcut) {
  setShortcuts(prev => {
    const next = new Map(prev);
    next.set(shortcut.id, shortcut);
    return next;
  });

  return () => {
    setShortcuts(prev => {
      const next = new Map(prev);
      next.delete(shortcut.id);
      return next;
    });
  };
}

function normalizeKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  const isMac = navigator.platform.includes('Mac');

  if (e.metaKey || (isMac && e.ctrlKey)) parts.push('Cmd');
  if (!isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);

  return parts.join('+');
}

export function useKeyboardShortcuts() {
  onMount(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const pressed = normalizeKey(e);

      for (const shortcut of shortcuts().values()) {
        if (shortcut.keys === pressed) {
          if (!shortcut.when || shortcut.when()) {
            e.preventDefault();
            shortcut.action();
            return;
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
  });
}

// Default shortcuts
export const DEFAULT_SHORTCUTS: Omit<KeyboardShortcut, 'action'>[] = [
  { id: 'command-palette', keys: 'Cmd+Shift+P', description: 'Open Command Palette' },
  { id: 'quick-open', keys: 'Cmd+P', description: 'Quick Open File' },
  { id: 'save', keys: 'Cmd+S', description: 'Save File' },
  { id: 'save-all', keys: 'Cmd+Alt+S', description: 'Save All Files' },
  { id: 'close-tab', keys: 'Cmd+W', description: 'Close Tab' },
  { id: 'new-file', keys: 'Cmd+N', description: 'New File' },
  { id: 'find', keys: 'Cmd+F', description: 'Find in File' },
  { id: 'find-replace', keys: 'Cmd+H', description: 'Find and Replace' },
  { id: 'toggle-sidebar', keys: 'Cmd+B', description: 'Toggle Sidebar' },
  { id: 'toggle-chat', keys: 'Cmd+Shift+I', description: 'Toggle AI Chat' },
  { id: 'focus-editor', keys: 'Cmd+1', description: 'Focus Editor' },
  { id: 'focus-chat', keys: 'Cmd+2', description: 'Focus Chat' },
];
\`\`\`

### Command Palette Component
Create \`src/components/CommandPalette.tsx\`:
\`\`\`typescript
import { For, Show, createSignal, createMemo } from 'solid-js';
import { shortcuts } from '../lib/shortcuts/manager';

export function CommandPalette() {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');

  const filteredCommands = createMemo(() => {
    const q = query().toLowerCase();
    return Array.from(shortcuts().values())
      .filter(s => s.description.toLowerCase().includes(q))
      .slice(0, 10);
  });

  // Register palette shortcut
  registerShortcut({
    id: 'command-palette',
    keys: 'Cmd+Shift+P',
    description: 'Open Command Palette',
    action: () => setOpen(true)
  });

  function executeCommand(shortcut: KeyboardShortcut) {
    shortcut.action();
    setOpen(false);
    setQuery('');
  }

  return (
    <Show when={open()}>
      <div class=\"command-palette-overlay\" onClick={() => setOpen(false)}>
        <div class=\"command-palette\" onClick={e => e.stopPropagation()}>
          <input
            type=\"text\"
            placeholder=\"Type a command...\"
            value={query()}
            onInput={e => setQuery(e.target.value)}
            autofocus
          />
          <div class=\"command-list\">
            <For each={filteredCommands()}>
              {(cmd) => (
                <div class=\"command-item\" onClick={() => executeCommand(cmd)}>
                  <span class=\"command-name\">{cmd.description}</span>
                  <span class=\"command-keys\">{cmd.keys}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}
\`\`\`

## Files to Create
- \`src/lib/shortcuts/manager.ts\`
- \`src/components/CommandPalette.tsx\`
- \`src/components/CommandPalette.css\`

## Definition of Done
- [ ] Global keyboard listener
- [ ] VS Code-style shortcuts work
- [ ] Command palette with fuzzy search
- [ ] Platform-aware (Cmd vs Ctrl)
- [ ] Shortcuts can be customized"

# Issue #54: Theme System
gh issue create --repo "$REPO" \
  --title "Implement dark/light theme system with CSS variables" \
  --label "phase:6-polish,component:ui,priority:high,agent: codex" \
  --body "## Overview
Implement a comprehensive theme system with dark and light modes.

## Technical Requirements

### Theme Store
Create \`src/stores/theme.ts\`:
\`\`\`typescript
import { createSignal, createEffect } from 'solid-js';

export type Theme = 'light' | 'dark' | 'system';

const [theme, setTheme] = createSignal<Theme>(
  (localStorage.getItem('theme') as Theme) || 'system'
);

const [resolvedTheme, setResolvedTheme] = createSignal<'light' | 'dark'>('dark');

// Watch system preference
createEffect(() => {
  const t = theme();

  if (t === 'system') {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    setResolvedTheme(media.matches ? 'dark' : 'light');

    const handler = (e: MediaQueryListEvent) => {
      setResolvedTheme(e.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  } else {
    setResolvedTheme(t);
  }
});

// Apply theme to document
createEffect(() => {
  document.documentElement.setAttribute('data-theme', resolvedTheme());
  localStorage.setItem('theme', theme());
});

export { theme, setTheme, resolvedTheme };
\`\`\`

### CSS Variables
Create \`src/styles/themes.css\`:
\`\`\`css
:root {
  /* Colors - Light Theme */
  --bg-primary: #ffffff;
  --bg-secondary: #f5f5f5;
  --bg-tertiary: #e8e8e8;
  --text-primary: #1a1a1a;
  --text-secondary: #666666;
  --text-muted: #999999;
  --border-color: #e0e0e0;
  --accent-color: #0066cc;
  --accent-hover: #0052a3;
  --success-color: #28a745;
  --warning-color: #ffc107;
  --error-color: #dc3545;

  /* Editor colors */
  --editor-bg: #ffffff;
  --editor-gutter-bg: #f5f5f5;
  --editor-line-number: #999999;
  --editor-selection: rgba(0, 102, 204, 0.2);
  --editor-cursor: #000000;

  /* Chat colors */
  --chat-user-bg: #e3f2fd;
  --chat-assistant-bg: #f5f5f5;

  /* Sidebar */
  --sidebar-bg: #f5f5f5;
  --sidebar-item-hover: #e8e8e8;
  --sidebar-item-active: #e0e0e0;
}

[data-theme=\"dark\"] {
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --bg-tertiary: #2d2d2d;
  --text-primary: #e0e0e0;
  --text-secondary: #a0a0a0;
  --text-muted: #707070;
  --border-color: #3c3c3c;
  --accent-color: #4fc3f7;
  --accent-hover: #29b6f6;
  --success-color: #4caf50;
  --warning-color: #ffb300;
  --error-color: #ef5350;

  --editor-bg: #1e1e1e;
  --editor-gutter-bg: #252526;
  --editor-line-number: #858585;
  --editor-selection: rgba(79, 195, 247, 0.2);
  --editor-cursor: #ffffff;

  --chat-user-bg: #1e3a5f;
  --chat-assistant-bg: #2d2d2d;

  --sidebar-bg: #252526;
  --sidebar-item-hover: #2d2d2d;
  --sidebar-item-active: #37373d;
}
\`\`\`

### Theme Switcher Component
\`\`\`typescript
import { theme, setTheme, resolvedTheme } from '../stores/theme';

export function ThemeSwitcher() {
  return (
    <div class=\"theme-switcher\">
      <button
        classList={{ active: theme() === 'light' }}
        onClick={() => setTheme('light')}
        title=\"Light theme\"
      >
        ☀️
      </button>
      <button
        classList={{ active: theme() === 'dark' }}
        onClick={() => setTheme('dark')}
        title=\"Dark theme\"
      >
        🌙
      </button>
      <button
        classList={{ active: theme() === 'system' }}
        onClick={() => setTheme('system')}
        title=\"System theme\"
      >
        💻
      </button>
    </div>
  );
}
\`\`\`

## Files to Create
- \`src/stores/theme.ts\`
- \`src/styles/themes.css\`
- \`src/components/settings/ThemeSwitcher.tsx\`

## Definition of Done
- [ ] Dark and light themes
- [ ] System preference detection
- [ ] Smooth theme transitions
- [ ] Monaco editor theme sync
- [ ] Theme persists across sessions"

# Issue #55: Loading States
gh issue create --repo "$REPO" \
  --title "Implement consistent loading states and skeleton screens" \
  --label "phase:6-polish,component:ui,priority:medium,agent: codex" \
  --body "## Overview
Add consistent loading states throughout the application.

## Technical Requirements

### Skeleton Component
Create \`src/components/common/Skeleton.tsx\`:
\`\`\`typescript
import { mergeProps } from 'solid-js';

interface SkeletonProps {
  width?: string;
  height?: string;
  variant?: 'text' | 'circular' | 'rectangular';
  animation?: 'pulse' | 'wave' | 'none';
}

export function Skeleton(props: SkeletonProps) {
  const merged = mergeProps({
    width: '100%',
    height: '1em',
    variant: 'text' as const,
    animation: 'pulse' as const
  }, props);

  return (
    <div
      class=\"skeleton\"
      classList={{
        'skeleton-text': merged.variant === 'text',
        'skeleton-circular': merged.variant === 'circular',
        'skeleton-rectangular': merged.variant === 'rectangular',
        'skeleton-pulse': merged.animation === 'pulse',
        'skeleton-wave': merged.animation === 'wave',
      }}
      style={{
        width: merged.width,
        height: merged.height,
      }}
    />
  );
}
\`\`\`

### Loading Spinner
\`\`\`typescript
interface SpinnerProps {
  size?: 'small' | 'medium' | 'large';
}

export function Spinner(props: SpinnerProps) {
  const size = () => {
    switch (props.size) {
      case 'small': return '16px';
      case 'large': return '48px';
      default: return '24px';
    }
  };

  return (
    <div
      class=\"spinner\"
      style={{ width: size(), height: size() }}
    />
  );
}
\`\`\`

### Loading States for Key Components
\`\`\`typescript
// Chat loading
export function ChatSkeleton() {
  return (
    <div class=\"chat-skeleton\">
      <For each={[1, 2, 3]}>
        {() => (
          <div class=\"message-skeleton\">
            <Skeleton variant=\"circular\" width=\"32px\" height=\"32px\" />
            <div class=\"content\">
              <Skeleton width=\"60%\" />
              <Skeleton width=\"80%\" />
              <Skeleton width=\"40%\" />
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

// File tree loading
export function FileTreeSkeleton() {
  return (
    <div class=\"file-tree-skeleton\">
      <For each={[1, 2, 3, 4, 5]}>
        {(_, i) => (
          <div class=\"file-skeleton\" style={{ 'padding-left': \`\${(i() % 3) * 16}px\` }}>
            <Skeleton variant=\"rectangular\" width=\"16px\" height=\"16px\" />
            <Skeleton width=\"120px\" />
          </div>
        )}
      </For>
    </div>
  );
}
\`\`\`

### CSS
\`\`\`css
.skeleton {
  background-color: var(--bg-tertiary);
  border-radius: 4px;
}

.skeleton-circular {
  border-radius: 50%;
}

.skeleton-pulse {
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

@keyframes skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.skeleton-wave {
  position: relative;
  overflow: hidden;
}

.skeleton-wave::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.1),
    transparent
  );
  animation: skeleton-wave 1.5s infinite;
}

@keyframes skeleton-wave {
  100% { transform: translateX(100%); }
}

.spinner {
  border: 2px solid var(--bg-tertiary);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
\`\`\`

## Files to Create
- \`src/components/common/Skeleton.tsx\`
- \`src/components/common/Spinner.tsx\`
- \`src/styles/loading.css\`

## Definition of Done
- [ ] Skeleton components
- [ ] Loading spinners
- [ ] All async operations show loading states
- [ ] Smooth transitions
- [ ] Accessible loading announcements"

# Issue #56: Error Boundaries
gh issue create --repo "$REPO" \
  --title "Implement error boundaries with recovery UI" \
  --label "phase:6-polish,component:ui,priority:high,agent: codex" \
  --body "## Overview
Add error boundaries to gracefully handle component failures.

## Technical Requirements

### Error Boundary Component
Create \`src/components/common/ErrorBoundary.tsx\`:
\`\`\`typescript
import { ErrorBoundary as SolidErrorBoundary, createSignal } from 'solid-js';

interface ErrorBoundaryProps {
  fallback?: (error: Error, reset: () => void) => JSX.Element;
  onError?: (error: Error) => void;
  children: JSX.Element;
}

export function ErrorBoundary(props: ErrorBoundaryProps) {
  return (
    <SolidErrorBoundary
      fallback={(err, reset) => {
        props.onError?.(err);

        if (props.fallback) {
          return props.fallback(err, reset);
        }

        return <DefaultErrorFallback error={err} reset={reset} />;
      }}
    >
      {props.children}
    </SolidErrorBoundary>
  );
}

function DefaultErrorFallback(props: { error: Error; reset: () => void }) {
  const [showDetails, setShowDetails] = createSignal(false);

  return (
    <div class=\"error-fallback\">
      <div class=\"error-icon\">⚠️</div>
      <h3>Something went wrong</h3>
      <p class=\"error-message\">{props.error.message}</p>

      <div class=\"error-actions\">
        <button class=\"retry-btn\" onClick={props.reset}>
          Try Again
        </button>
        <button
          class=\"details-btn\"
          onClick={() => setShowDetails(v => !v)}
        >
          {showDetails() ? 'Hide Details' : 'Show Details'}
        </button>
      </div>

      <Show when={showDetails()}>
        <pre class=\"error-stack\">{props.error.stack}</pre>
      </Show>
    </div>
  );
}
\`\`\`

### Panel-Specific Error Boundaries
\`\`\`typescript
// Wrap major UI sections
function App() {
  return (
    <div class=\"app\">
      <ErrorBoundary
        fallback={(error, reset) => (
          <SidebarError error={error} reset={reset} />
        )}
      >
        <Sidebar />
      </ErrorBoundary>

      <ErrorBoundary
        fallback={(error, reset) => (
          <EditorError error={error} reset={reset} />
        )}
      >
        <EditorPanel />
      </ErrorBoundary>

      <ErrorBoundary
        fallback={(error, reset) => (
          <ChatError error={error} reset={reset} />
        )}
      >
        <ChatPanel />
      </ErrorBoundary>
    </div>
  );
}

function ChatError(props: { error: Error; reset: () => void }) {
  return (
    <div class=\"chat-error\">
      <p>Chat encountered an error</p>
      <button onClick={props.reset}>Reload Chat</button>
    </div>
  );
}
\`\`\`

### Error Logging
\`\`\`typescript
import { invoke } from '@tauri-apps/api/core';

export async function logError(error: Error, context?: Record<string, unknown>) {
  console.error('Application error:', error, context);

  // Log to Rust backend for telemetry
  await invoke('log_error', {
    message: error.message,
    stack: error.stack,
    context: JSON.stringify(context)
  });
}
\`\`\`

## Files to Create
- \`src/components/common/ErrorBoundary.tsx\`
- \`src/lib/logging/errors.ts\`
- \`src/styles/error.css\`

## Definition of Done
- [ ] Error boundaries wrap major sections
- [ ] User-friendly error messages
- [ ] Retry/reset functionality
- [ ] Error details for debugging
- [ ] Errors logged for telemetry"

# Issue #57: Accessibility Audit
gh issue create --repo "$REPO" \
  --title "Conduct accessibility audit and implement ARIA labels" \
  --label "phase:6-polish,component:ui,type:a11y,priority:high,agent: codex" \
  --body "## Overview
Ensure the application is accessible to users with disabilities.

## Technical Requirements

### Focus Management
\`\`\`typescript
// Focus trap for modals
export function useFocusTrap(containerRef: () => HTMLElement | undefined) {
  createEffect(() => {
    const container = containerRef();
    if (!container) return;

    const focusableElements = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])'
    );

    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          lastElement.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === lastElement) {
          firstElement.focus();
          e.preventDefault();
        }
      }
    }

    container.addEventListener('keydown', handleKeyDown);
    firstElement?.focus();

    onCleanup(() => container.removeEventListener('keydown', handleKeyDown));
  });
}
\`\`\`

### ARIA Labels
Add proper ARIA labels to all interactive elements:
\`\`\`typescript
// Chat input
<input
  type=\"text\"
  aria-label=\"Message to AI assistant\"
  aria-describedby=\"chat-instructions\"
  placeholder=\"Type a message...\"
/>
<span id=\"chat-instructions\" class=\"sr-only\">
  Press Enter to send message
</span>

// File tree
<ul role=\"tree\" aria-label=\"File explorer\">
  <li role=\"treeitem\" aria-expanded=\"true\" aria-selected=\"false\">
    <span>src</span>
    <ul role=\"group\">
      <li role=\"treeitem\" aria-selected=\"true\">index.ts</li>
    </ul>
  </li>
</ul>

// Tab panel
<div role=\"tablist\" aria-label=\"Open files\">
  <button role=\"tab\" aria-selected=\"true\" aria-controls=\"panel-1\">
    file1.ts
  </button>
  <button role=\"tab\" aria-selected=\"false\" aria-controls=\"panel-2\">
    file2.ts
  </button>
</div>
\`\`\`

### Screen Reader Only Styles
\`\`\`css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
\`\`\`

### Color Contrast
- Ensure all text meets WCAG AA contrast ratios (4.5:1 for normal text)
- Test with color blindness simulators

### Keyboard Navigation
- All interactive elements reachable via Tab
- Logical tab order
- Visible focus indicators
- Escape closes modals/dropdowns

## Checklist
- [ ] All images have alt text
- [ ] Form inputs have labels
- [ ] ARIA roles on custom widgets
- [ ] Focus management in modals
- [ ] Skip to main content link
- [ ] Keyboard navigation complete
- [ ] Color contrast passes WCAG AA
- [ ] Screen reader tested

## Definition of Done
- [ ] Passes axe DevTools audit
- [ ] Keyboard-only navigation works
- [ ] Screen reader compatible
- [ ] Focus indicators visible"

# Issue #58: Performance Optimization
gh issue create --repo "$REPO" \
  --title "Optimize bundle size and runtime performance" \
  --label "phase:6-polish,type:performance,priority:high,agent: codex" \
  --body "## Overview
Optimize application performance for fast startup and smooth operation.

## Technical Requirements

### Bundle Analysis
\`\`\`bash
# Add to package.json scripts
\"analyze\": \"vite-bundle-visualizer\"
\`\`\`

### Code Splitting
\`\`\`typescript
// Lazy load heavy components
const MonacoEditor = lazy(() => import('./components/editor/MonacoEditor'));
const McpPanel = lazy(() => import('./components/mcp/McpPanel'));
const SettingsPanel = lazy(() => import('./components/settings/SettingsPanel'));

// Use with Suspense
<Suspense fallback={<EditorSkeleton />}>
  <MonacoEditor />
</Suspense>
\`\`\`

### Virtual Lists for Large Data
\`\`\`typescript
// For chat history, file trees with many items
import { VirtualList } from '@tanstack/solid-virtual';

function ChatHistory(props: { messages: Message[] }) {
  return (
    <VirtualList
      items={props.messages}
      estimateSize={() => 100}
      overscan={5}
    >
      {(message) => <ChatMessage message={message} />}
    </VirtualList>
  );
}
\`\`\`

### Memoization
\`\`\`typescript
import { createMemo } from 'solid-js';

// Expensive computations
const filteredFiles = createMemo(() => {
  const query = searchQuery().toLowerCase();
  return allFiles().filter(f => f.name.toLowerCase().includes(query));
});

// Debounce user input
function useDebounce<T>(value: () => T, delay: number): () => T {
  const [debounced, setDebounced] = createSignal(value());

  createEffect(() => {
    const timer = setTimeout(() => setDebounced(() => value()), delay);
    onCleanup(() => clearTimeout(timer));
  });

  return debounced;
}
\`\`\`

### Rust Performance
\`\`\`rust
// Use async for I/O operations
#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())
}

// Use rayon for CPU-bound parallel processing
use rayon::prelude::*;

fn process_files(files: Vec<String>) -> Vec<ProcessedFile> {
    files.par_iter()
        .map(|f| process_file(f))
        .collect()
}
\`\`\`

### Performance Metrics
\`\`\`typescript
// Measure key interactions
function measurePerformance(name: string, fn: () => void) {
  const start = performance.now();
  fn();
  const duration = performance.now() - start;
  console.log(\`\${name}: \${duration.toFixed(2)}ms\`);
}

// Report to analytics
async function reportMetric(name: string, value: number) {
  await invoke('report_metric', { name, value });
}
\`\`\`

## Performance Targets
- Initial load: < 2 seconds
- Time to interactive: < 3 seconds
- Bundle size: < 5MB (excluding Monaco)
- Memory usage: < 200MB idle

## Definition of Done
- [ ] Bundle size reduced
- [ ] Lazy loading implemented
- [ ] Virtual scrolling for large lists
- [ ] No jank during scrolling
- [ ] Startup time optimized"

# Issue #59: Native Menu Integration
gh issue create --repo "$REPO" \
  --title "Implement native application menu (File, Edit, View, Help)" \
  --label "phase:6-polish,component:ui,priority:medium,agent: codex" \
  --body "## Overview
Create native application menus for macOS, Windows, and Linux.

## Technical Requirements

### Tauri Menu Configuration
Update \`src-tauri/src/main.rs\`:
\`\`\`rust
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    Manager,
};

fn create_menu(app: &tauri::App) -> tauri::Result<Menu> {
    let file_menu = Submenu::with_items(
        app,
        \"File\",
        true,
        &[
            &MenuItem::with_id(app, \"new_file\", \"New File\", true, Some(\"CmdOrCtrl+N\"))?,
            &MenuItem::with_id(app, \"open_file\", \"Open File...\", true, Some(\"CmdOrCtrl+O\"))?,
            &MenuItem::with_id(app, \"open_folder\", \"Open Folder...\", true, Some(\"CmdOrCtrl+Shift+O\"))?,
            &MenuItem::separator(app)?,
            &MenuItem::with_id(app, \"save\", \"Save\", true, Some(\"CmdOrCtrl+S\"))?,
            &MenuItem::with_id(app, \"save_as\", \"Save As...\", true, Some(\"CmdOrCtrl+Shift+S\"))?,
            &MenuItem::with_id(app, \"save_all\", \"Save All\", true, Some(\"CmdOrCtrl+Alt+S\"))?,
            &MenuItem::separator(app)?,
            &MenuItem::with_id(app, \"close_tab\", \"Close Tab\", true, Some(\"CmdOrCtrl+W\"))?,
            &MenuItem::with_id(app, \"close_window\", \"Close Window\", true, Some(\"CmdOrCtrl+Shift+W\"))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        \"Edit\",
        true,
        &[
            &MenuItem::with_id(app, \"undo\", \"Undo\", true, Some(\"CmdOrCtrl+Z\"))?,
            &MenuItem::with_id(app, \"redo\", \"Redo\", true, Some(\"CmdOrCtrl+Shift+Z\"))?,
            &MenuItem::separator(app)?,
            &MenuItem::with_id(app, \"cut\", \"Cut\", true, Some(\"CmdOrCtrl+X\"))?,
            &MenuItem::with_id(app, \"copy\", \"Copy\", true, Some(\"CmdOrCtrl+C\"))?,
            &MenuItem::with_id(app, \"paste\", \"Paste\", true, Some(\"CmdOrCtrl+V\"))?,
            &MenuItem::with_id(app, \"select_all\", \"Select All\", true, Some(\"CmdOrCtrl+A\"))?,
            &MenuItem::separator(app)?,
            &MenuItem::with_id(app, \"find\", \"Find\", true, Some(\"CmdOrCtrl+F\"))?,
            &MenuItem::with_id(app, \"replace\", \"Replace\", true, Some(\"CmdOrCtrl+H\"))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        \"View\",
        true,
        &[
            &MenuItem::with_id(app, \"command_palette\", \"Command Palette\", true, Some(\"CmdOrCtrl+Shift+P\"))?,
            &MenuItem::separator(app)?,
            &MenuItem::with_id(app, \"toggle_sidebar\", \"Toggle Sidebar\", true, Some(\"CmdOrCtrl+B\"))?,
            &MenuItem::with_id(app, \"toggle_chat\", \"Toggle AI Chat\", true, Some(\"CmdOrCtrl+Shift+I\"))?,
            &MenuItem::separator(app)?,
            &MenuItem::with_id(app, \"zoom_in\", \"Zoom In\", true, Some(\"CmdOrCtrl+=\"))?,
            &MenuItem::with_id(app, \"zoom_out\", \"Zoom Out\", true, Some(\"CmdOrCtrl+-\"))?,
            &MenuItem::with_id(app, \"reset_zoom\", \"Reset Zoom\", true, Some(\"CmdOrCtrl+0\"))?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        \"Help\",
        true,
        &[
            &MenuItem::with_id(app, \"documentation\", \"Documentation\", true, None)?,
            &MenuItem::with_id(app, \"release_notes\", \"Release Notes\", true, None)?,
            &MenuItem::separator(app)?,
            &MenuItem::with_id(app, \"report_issue\", \"Report Issue\", true, None)?,
            &MenuItem::separator(app)?,
            &MenuItem::with_id(app, \"about\", \"About Seren Desktop\", true, None)?,
        ],
    )?;

    Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu, &help_menu])
}
\`\`\`

### Menu Event Handling
\`\`\`rust
app.on_menu_event(|app, event| {
    match event.id.as_ref() {
        \"new_file\" => app.emit(\"menu:new_file\", ()).unwrap(),
        \"open_file\" => app.emit(\"menu:open_file\", ()).unwrap(),
        \"save\" => app.emit(\"menu:save\", ()).unwrap(),
        \"toggle_sidebar\" => app.emit(\"menu:toggle_sidebar\", ()).unwrap(),
        \"about\" => {
            // Show about dialog
        },
        _ => {}
    }
});
\`\`\`

### Frontend Event Listeners
\`\`\`typescript
import { listen } from '@tauri-apps/api/event';

onMount(async () => {
  await listen('menu:new_file', () => createNewFile());
  await listen('menu:open_file', () => openFileDialog());
  await listen('menu:save', () => saveCurrentFile());
  await listen('menu:toggle_sidebar', () => toggleSidebar());
});
\`\`\`

## Files to Modify
- \`src-tauri/src/main.rs\`
- \`src/App.tsx\` (add event listeners)

## Definition of Done
- [ ] File menu with all operations
- [ ] Edit menu with undo/redo/clipboard
- [ ] View menu with toggles
- [ ] Help menu with links
- [ ] Keyboard shortcuts work
- [ ] Works on all platforms"

# Issue #60: Onboarding Flow
gh issue create --repo "$REPO" \
  --title "Create first-run onboarding experience" \
  --label "phase:6-polish,component:ui,priority:medium,agent: codex" \
  --body "## Overview
Guide new users through initial setup and key features.

## Technical Requirements

### Onboarding Store
\`\`\`typescript
import { createSignal } from 'solid-js';

interface OnboardingState {
  completed: boolean;
  currentStep: number;
  seenFeatures: string[];
}

const [onboarding, setOnboarding] = createSignal<OnboardingState>({
  completed: localStorage.getItem('onboarding_completed') === 'true',
  currentStep: 0,
  seenFeatures: JSON.parse(localStorage.getItem('seen_features') || '[]')
});

export function completeOnboarding() {
  setOnboarding(prev => ({ ...prev, completed: true }));
  localStorage.setItem('onboarding_completed', 'true');
}

export function markFeatureSeen(featureId: string) {
  setOnboarding(prev => ({
    ...prev,
    seenFeatures: [...prev.seenFeatures, featureId]
  }));
  localStorage.setItem('seen_features', JSON.stringify(onboarding().seenFeatures));
}
\`\`\`

### Welcome Screen Component
\`\`\`typescript
export function WelcomeScreen() {
  const steps = [
    {
      title: 'Welcome to Seren Desktop',
      description: 'Your AI-powered development environment',
      image: '/onboarding/welcome.svg'
    },
    {
      title: 'AI Chat Assistant',
      description: 'Get help with coding, debugging, and more. Press Cmd+Shift+I to toggle.',
      image: '/onboarding/chat.svg'
    },
    {
      title: 'Inline Completions',
      description: 'AI-powered code completions as you type. Start typing and press Tab to accept.',
      image: '/onboarding/completions.svg'
    },
    {
      title: 'Connect Your Wallet',
      description: 'Pay for API usage with SerenBucks or crypto. Set up auto top-up for seamless experience.',
      image: '/onboarding/wallet.svg'
    },
    {
      title: 'Ready to Code!',
      description: 'Open a folder or create a new file to get started.',
      image: '/onboarding/ready.svg'
    }
  ];

  const [currentStep, setCurrentStep] = createSignal(0);

  function next() {
    if (currentStep() < steps.length - 1) {
      setCurrentStep(s => s + 1);
    } else {
      completeOnboarding();
    }
  }

  function skip() {
    completeOnboarding();
  }

  const step = () => steps[currentStep()];

  return (
    <div class=\"welcome-screen\">
      <div class=\"welcome-content\">
        <img src={step().image} alt=\"\" class=\"step-image\" />
        <h1>{step().title}</h1>
        <p>{step().description}</p>
      </div>

      <div class=\"welcome-dots\">
        <For each={steps}>
          {(_, i) => (
            <span
              class=\"dot\"
              classList={{ active: i() === currentStep() }}
            />
          )}
        </For>
      </div>

      <div class=\"welcome-actions\">
        <button class=\"skip-btn\" onClick={skip}>Skip</button>
        <button class=\"next-btn\" onClick={next}>
          {currentStep() === steps.length - 1 ? 'Get Started' : 'Next'}
        </button>
      </div>
    </div>
  );
}
\`\`\`

### Feature Tooltips
\`\`\`typescript
export function FeatureTooltip(props: {
  featureId: string;
  target: string;
  title: string;
  description: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}) {
  const seen = () => onboarding().seenFeatures.includes(props.featureId);

  return (
    <Show when={!seen()}>
      <div
        class=\"feature-tooltip\"
        classList={{ [props.position || 'bottom']: true }}
      >
        <div class=\"tooltip-content\">
          <h4>{props.title}</h4>
          <p>{props.description}</p>
          <button onClick={() => markFeatureSeen(props.featureId)}>
            Got it
          </button>
        </div>
        <div class=\"tooltip-arrow\" />
      </div>
    </Show>
  );
}
\`\`\`

## Files to Create
- \`src/stores/onboarding.ts\`
- \`src/components/onboarding/WelcomeScreen.tsx\`
- \`src/components/onboarding/FeatureTooltip.tsx\`
- \`public/onboarding/*.svg\` (illustrations)

## Definition of Done
- [ ] Welcome screen on first launch
- [ ] Multi-step walkthrough
- [ ] Feature tooltips for discovery
- [ ] State persists across sessions
- [ ] Can be skipped"

# Issue #61: Auto-Update System
gh issue create --repo "$REPO" \
  --title "Implement Tauri auto-update functionality" \
  --label "phase:6-polish,component:core,priority:high,agent: codex" \
  --body "## Overview
Enable automatic updates for the desktop application.

## Technical Requirements

### Tauri Updater Configuration
Update \`src-tauri/tauri.conf.json\`:
\`\`\`json
{
  \"plugins\": {
    \"updater\": {
      \"active\": true,
      \"endpoints\": [
        \"https://releases.serendb.com/seren-desktop/{{target}}/{{arch}}/{{current_version}}\"
      ],
      \"dialog\": false,
      \"pubkey\": \"YOUR_PUBLIC_KEY_HERE\"
    }
  }
}
\`\`\`

### Update Checker Service
\`\`\`typescript
import { check, Update } from '@tauri-apps/plugin-updater';
import { createSignal } from 'solid-js';

interface UpdateState {
  checking: boolean;
  available: boolean;
  downloading: boolean;
  progress: number;
  update: Update | null;
  error: string | null;
}

const [updateState, setUpdateState] = createSignal<UpdateState>({
  checking: false,
  available: false,
  downloading: false,
  progress: 0,
  update: null,
  error: null
});

export async function checkForUpdates() {
  setUpdateState(prev => ({ ...prev, checking: true, error: null }));

  try {
    const update = await check();

    if (update) {
      setUpdateState(prev => ({
        ...prev,
        checking: false,
        available: true,
        update
      }));
    } else {
      setUpdateState(prev => ({
        ...prev,
        checking: false,
        available: false
      }));
    }
  } catch (error) {
    setUpdateState(prev => ({
      ...prev,
      checking: false,
      error: String(error)
    }));
  }
}

export async function downloadAndInstall() {
  const update = updateState().update;
  if (!update) return;

  setUpdateState(prev => ({ ...prev, downloading: true }));

  try {
    await update.downloadAndInstall((progress) => {
      if (progress.event === 'Progress') {
        const percent = (progress.data.chunkLength / progress.data.contentLength) * 100;
        setUpdateState(prev => ({ ...prev, progress: percent }));
      }
    });

    // Restart app
    await relaunch();
  } catch (error) {
    setUpdateState(prev => ({
      ...prev,
      downloading: false,
      error: String(error)
    }));
  }
}
\`\`\`

### Update Dialog Component
\`\`\`typescript
export function UpdateDialog() {
  const state = updateState();

  return (
    <Show when={state.available}>
      <div class=\"update-dialog\">
        <h3>Update Available</h3>
        <p>Version {state.update?.version} is available.</p>

        <Show when={state.update?.body}>
          <div class=\"release-notes\">
            <h4>What's New:</h4>
            <div innerHTML={state.update?.body} />
          </div>
        </Show>

        <Show when={state.downloading}>
          <div class=\"progress-bar\">
            <div
              class=\"progress\"
              style={{ width: \`\${state.progress}%\` }}
            />
          </div>
          <p>Downloading... {state.progress.toFixed(0)}%</p>
        </Show>

        <div class=\"update-actions\">
          <button onClick={() => setUpdateState(prev => ({ ...prev, available: false }))}>
            Later
          </button>
          <button
            class=\"primary\"
            onClick={downloadAndInstall}
            disabled={state.downloading}
          >
            {state.downloading ? 'Installing...' : 'Update Now'}
          </button>
        </div>
      </div>
    </Show>
  );
}
\`\`\`

### Background Update Check
\`\`\`typescript
// Check for updates on startup and periodically
onMount(async () => {
  await checkForUpdates();

  // Check every 4 hours
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
});
\`\`\`

## Files to Create/Modify
- \`src-tauri/tauri.conf.json\`
- \`src/lib/updater/service.ts\`
- \`src/components/UpdateDialog.tsx\`
- \`src/App.tsx\` (add update check)

## Definition of Done
- [ ] Updater configured in Tauri
- [ ] Checks for updates on startup
- [ ] Shows update dialog when available
- [ ] Download progress indicator
- [ ] Automatic restart after install
- [ ] Works on all platforms"

# Issue #62: Release Automation
gh issue create --repo "$REPO" \
  --title "Set up GitHub Actions for automated releases" \
  --label "phase:6-polish,type:ci,priority:high,agent: codex" \
  --body "## Overview
Automate building and releasing for all platforms via GitHub Actions.

## Technical Requirements

### Release Workflow
Create \`.github/workflows/release.yml\`:
\`\`\`yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  create-release:
    runs-on: ubuntu-latest
    outputs:
      release_id: \${{ steps.create.outputs.result }}
    steps:
      - uses: actions/checkout@v4
      - name: Create Release
        id: create
        uses: actions/github-script@v7
        with:
          script: |
            const { data } = await github.rest.repos.createRelease({
              owner: context.repo.owner,
              repo: context.repo.repo,
              tag_name: context.ref.replace('refs/tags/', ''),
              name: context.ref.replace('refs/tags/', ''),
              draft: true,
              prerelease: false
            })
            return data.id

  build-tauri:
    needs: create-release
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            args: --target aarch64-apple-darwin
          - platform: macos-latest
            args: --target x86_64-apple-darwin
          - platform: ubuntu-22.04
            args: ''
          - platform: windows-latest
            args: ''

    runs-on: \${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: \${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - name: Install dependencies (Ubuntu)
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf

      - name: Install frontend dependencies
        run: npm ci

      - name: Build Tauri
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: \${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          releaseId: \${{ needs.create-release.outputs.release_id }}
          args: \${{ matrix.args }}

  publish-release:
    needs: [create-release, build-tauri]
    runs-on: ubuntu-latest
    steps:
      - name: Publish Release
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.repos.updateRelease({
              owner: context.repo.owner,
              repo: context.repo.repo,
              release_id: \${{ needs.create-release.outputs.release_id }},
              draft: false
            })
\`\`\`

### Update Server
Create update manifest endpoint that returns:
\`\`\`json
{
  \"version\": \"1.0.1\",
  \"notes\": \"Bug fixes and performance improvements\",
  \"pub_date\": \"2024-01-15T12:00:00Z\",
  \"platforms\": {
    \"darwin-aarch64\": {
      \"signature\": \"...\",
      \"url\": \"https://github.com/.../releases/download/v1.0.1/Seren.Desktop_1.0.1_aarch64.dmg\"
    },
    \"darwin-x86_64\": {
      \"signature\": \"...\",
      \"url\": \"https://github.com/.../releases/download/v1.0.1/Seren.Desktop_1.0.1_x64.dmg\"
    },
    \"linux-x86_64\": {
      \"signature\": \"...\",
      \"url\": \"https://github.com/.../releases/download/v1.0.1/seren-desktop_1.0.1_amd64.AppImage\"
    },
    \"windows-x86_64\": {
      \"signature\": \"...\",
      \"url\": \"https://github.com/.../releases/download/v1.0.1/Seren.Desktop_1.0.1_x64-setup.exe\"
    }
  }
}
\`\`\`

### Code Signing
- macOS: Apple Developer certificate
- Windows: Code signing certificate
- Linux: GPG signature

### Versioning
Use semantic versioning via \`package.json\` and \`src-tauri/Cargo.toml\`.

## Secrets Required
- \`TAURI_SIGNING_PRIVATE_KEY\` - For update signature
- \`TAURI_SIGNING_PRIVATE_KEY_PASSWORD\` - Key password
- \`APPLE_CERTIFICATE\` - macOS signing (optional)
- \`APPLE_CERTIFICATE_PASSWORD\` - (optional)
- \`APPLE_SIGNING_IDENTITY\` - (optional)

## Files to Create
- \`.github/workflows/release.yml\`
- Update endpoint configuration

## Definition of Done
- [ ] Tag triggers release build
- [ ] Builds for macOS (ARM + Intel)
- [ ] Builds for Windows
- [ ] Builds for Linux
- [ ] Artifacts uploaded to release
- [ ] Update signatures generated
- [ ] Release published automatically"

echo "Phase 6 issues created successfully!"
echo "Created issues #53-#62 for Polish & Release"
