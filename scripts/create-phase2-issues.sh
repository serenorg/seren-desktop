#!/bin/bash
# Create Phase 2 GitHub issues for seren-desktop repository
# Phase 2: Chat Excellence - Streaming, history, model selection

set -e

REPO="serenorg/seren-desktop"

echo "Creating Phase 2 issues (Chat Excellence) for $REPO..."

# Issue #13
gh issue create --repo $REPO \
  --title "Implement SSE streaming for chat responses" \
  --label "phase: 2-chat,type: feature,priority: critical,area: chat,agent: codex" \
  --body "## Overview
Implement Server-Sent Events (SSE) streaming for real-time token display during chat.

## Current State
Issue #12 implemented basic non-streaming chat. Now add streaming.

## API Details
\`\`\`
POST https://api.serendb.com/v1/chat/completions
Content-Type: application/json
Authorization: Bearer {token}

{
  \"model\": \"anthropic/claude-sonnet-4-20250514\",
  \"messages\": [{\"role\": \"user\", \"content\": \"Hello\"}],
  \"stream\": true
}

Response: text/event-stream
data: {\"id\":\"123\",\"delta\":{\"content\":\"Hello\"}}
data: {\"id\":\"123\",\"delta\":{\"content\":\" there\"}}
data: [DONE]
\`\`\`

## Files to Modify

### src/services/chat.ts
\`\`\`typescript
export async function* streamMessage(
  content: string,
  model: string
): AsyncGenerator<string> {
  const token = await auth.getToken();
  const response = await fetch(\`\${config.apiBase}/chat/completions\`, {
    method: \"POST\",
    headers: {
      \"Content-Type\": \"application/json\",
      \"Authorization\": \`Bearer \${token}\`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: \"user\", content }],
      stream: true,
    }),
  });

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split(\"\\n\");

    for (const line of lines) {
      if (line.startsWith(\"data: \")) {
        const data = line.slice(6);
        if (data === \"[DONE]\") return;
        const parsed = JSON.parse(data);
        if (parsed.delta?.content) {
          yield parsed.delta.content;
        }
      }
    }
  }
}
\`\`\`

## Definition of Done
- [ ] SSE connection established
- [ ] Tokens appear one by one in real-time
- [ ] Connection properly closed on completion
- [ ] Error handling for connection drops
- [ ] Works with all supported models

## Commit: \`feat: implement SSE streaming for chat responses\`"

# Issue #14
gh issue create --repo $REPO \
  --title "Create StreamingMessage component" \
  --label "phase: 2-chat,type: feature,priority: high,area: chat,area: ui,agent: codex" \
  --body "## Overview
Create a component that displays streaming tokens with a typing effect.

## Dependencies
- Issue #13 (SSE streaming)

## Files to Create

### src/components/chat/StreamingMessage.tsx
\`\`\`typescript
import { Component, createSignal, onCleanup } from \"solid-js\";

interface StreamingMessageProps {
  stream: AsyncGenerator<string>;
  onComplete: (fullContent: string) => void;
}

export const StreamingMessage: Component<StreamingMessageProps> = (props) => {
  const [content, setContent] = createSignal(\"\");
  const [isStreaming, setIsStreaming] = createSignal(true);

  const consume = async () => {
    let fullContent = \"\";
    try {
      for await (const token of props.stream) {
        fullContent += token;
        setContent(fullContent);
      }
    } finally {
      setIsStreaming(false);
      props.onComplete(fullContent);
    }
  };

  consume();

  return (
    <div class=\"chat-message assistant\">
      <div class=\"message-content\">
        {content()}
        {isStreaming() && <span class=\"cursor\">|</span>}
      </div>
    </div>
  );
};
\`\`\`

### Add to src/components/chat/StreamingMessage.css
\`\`\`css
.cursor {
  animation: blink 1s infinite;
}

@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}
\`\`\`

## Definition of Done
- [ ] Tokens display as they arrive
- [ ] Blinking cursor shows during streaming
- [ ] Cursor disappears when complete
- [ ] onComplete called with full content
- [ ] Integrates with ChatPanel

## Commit: \`feat: create StreamingMessage component with typing effect\`"

# Issue #15
gh issue create --repo $REPO \
  --title "Add chat history persistence with SQLite" \
  --label "phase: 2-chat,type: feature,priority: high,area: chat,area: rust,agent: codex" \
  --body "## Overview
Persist chat history using SQLite via Rust backend. Messages survive app restart.

## Constraints
- Maximum 50 messages per conversation (from VS Code implementation)
- Store: id, role, content, timestamp, model

## Files to Create/Modify

### src-tauri/Cargo.toml
\`\`\`toml
[dependencies]
rusqlite = { version = \"0.32\", features = [\"bundled\"] }
\`\`\`

### src-tauri/src/services/database.rs
\`\`\`rust
use rusqlite::{Connection, Result};
use std::path::PathBuf;
use tauri::AppHandle;

pub fn get_db_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join(\"chat.db\")
}

pub fn init_db(app: &AppHandle) -> Result<Connection> {
    let path = get_db_path(app);
    let conn = Connection::open(path)?;

    conn.execute(
        \"CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            model TEXT,
            timestamp INTEGER NOT NULL
        )\",
        [],
    )?;

    Ok(conn)
}
\`\`\`

### src-tauri/src/commands/chat.rs
\`\`\`rust
#[tauri::command]
pub async fn save_message(
    app: AppHandle,
    id: String,
    role: String,
    content: String,
    model: Option<String>,
    timestamp: i64,
) -> Result<(), String> {
    // Implementation
}

#[tauri::command]
pub async fn get_messages(app: AppHandle, limit: i32) -> Result<Vec<Message>, String> {
    // Return last N messages, enforce 50 max
}

#[tauri::command]
pub async fn clear_history(app: AppHandle) -> Result<(), String> {
    // Clear all messages
}
\`\`\`

## Definition of Done
- [ ] SQLite database created on first run
- [ ] Messages saved after each exchange
- [ ] Messages loaded on app start
- [ ] 50 message limit enforced (delete oldest)
- [ ] Clear history function works

## Commit: \`feat: add chat history persistence with SQLite\`"

# Issue #16
gh issue create --repo $REPO \
  --title "Create ModelSelector component" \
  --label "phase: 2-chat,type: feature,priority: high,area: chat,area: ui,agent: codex" \
  --body "## Overview
Create a dropdown component for selecting AI models.

## Available Models (from Seren API)
- anthropic/claude-sonnet-4-20250514 (default)
- anthropic/claude-3-opus-20240229
- openai/gpt-4o
- openai/gpt-4o-mini

## Files to Create

### src/components/chat/ModelSelector.tsx
\`\`\`typescript
import { Component, createSignal, For } from \"solid-js\";
import { chatStore } from \"@/stores/chat.store\";
import \"./ModelSelector.css\";

const MODELS = [
  { id: \"anthropic/claude-sonnet-4-20250514\", name: \"Claude Sonnet 4\", provider: \"Anthropic\" },
  { id: \"anthropic/claude-3-opus-20240229\", name: \"Claude 3 Opus\", provider: \"Anthropic\" },
  { id: \"openai/gpt-4o\", name: \"GPT-4o\", provider: \"OpenAI\" },
  { id: \"openai/gpt-4o-mini\", name: \"GPT-4o Mini\", provider: \"OpenAI\" },
];

export const ModelSelector: Component = () => {
  const [isOpen, setIsOpen] = createSignal(false);

  const currentModel = () =>
    MODELS.find((m) => m.id === chatStore.selectedModel) || MODELS[0];

  const selectModel = (modelId: string) => {
    chatStore.setModel(modelId);
    setIsOpen(false);
  };

  return (
    <div class=\"model-selector\">
      <button class=\"model-selector-trigger\" onClick={() => setIsOpen(!isOpen())}>
        {currentModel().name}
        <span class=\"chevron\">{isOpen() ? \"▲\" : \"▼\"}</span>
      </button>

      {isOpen() && (
        <div class=\"model-selector-dropdown\">
          <For each={MODELS}>
            {(model) => (
              <button
                class={\"model-option \" + (model.id === chatStore.selectedModel ? \"selected\" : \"\")}
                onClick={() => selectModel(model.id)}
              >
                <span class=\"model-name\">{model.name}</span>
                <span class=\"model-provider\">{model.provider}</span>
              </button>
            )}
          </For>
        </div>
      )}
    </div>
  );
};
\`\`\`

## Definition of Done
- [ ] Dropdown shows all available models
- [ ] Current model displayed in trigger
- [ ] Selection updates chat store
- [ ] Dropdown closes on selection
- [ ] Click outside closes dropdown

## Commit: \`feat: create ModelSelector component\`"

# Issue #17
gh issue create --repo $REPO \
  --title "Add model selection service with caching" \
  --label "phase: 2-chat,type: feature,priority: medium,area: chat,agent: codex" \
  --body "## Overview
Fetch available models from Seren API with 5-minute cache (matching VS Code implementation).

## API Endpoint
\`\`\`
GET https://api.serendb.com/v1/models
Authorization: Bearer {token}

Response:
{
  \"models\": [
    {\"id\": \"anthropic/claude-sonnet-4-20250514\", \"name\": \"Claude Sonnet 4\", ...},
    ...
  ]
}
\`\`\`

## Files to Create

### src/services/models.ts
\`\`\`typescript
import { config } from \"@/lib/config\";
import { auth } from \"./auth\";

interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
}

let cachedModels: Model[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const models = {
  async getAvailable(): Promise<Model[]> {
    const now = Date.now();

    if (cachedModels && now - cacheTimestamp < CACHE_TTL) {
      return cachedModels;
    }

    const token = await auth.getToken();
    const response = await fetch(\`\${config.apiBase}/models\`, {
      headers: { Authorization: \`Bearer \${token}\` },
    });

    if (!response.ok) {
      // Return default models on error
      return getDefaultModels();
    }

    const data = await response.json();
    cachedModels = data.models;
    cacheTimestamp = now;

    return cachedModels;
  },

  clearCache() {
    cachedModels = null;
    cacheTimestamp = 0;
  },
};

function getDefaultModels(): Model[] {
  return [
    { id: \"anthropic/claude-sonnet-4-20250514\", name: \"Claude Sonnet 4\", provider: \"Anthropic\", contextWindow: 200000 },
    { id: \"openai/gpt-4o\", name: \"GPT-4o\", provider: \"OpenAI\", contextWindow: 128000 },
  ];
}
\`\`\`

## Definition of Done
- [ ] Fetches models from API
- [ ] 5-minute cache implemented
- [ ] Falls back to defaults on error
- [ ] Cache can be cleared manually

## Commit: \`feat: add model selection service with 5-min cache\`"

# Issue #18
gh issue create --repo $REPO \
  --title "Implement chat context from file selection" \
  --label "phase: 2-chat,type: feature,priority: medium,area: chat,area: editor,agent: codex" \
  --body "## Overview
Allow users to include selected code from the editor in their chat messages.

## UX Flow
1. User selects code in Monaco editor
2. User opens chat
3. Selected code is shown as context
4. User types question about the code
5. Both context and question sent to API

## Files to Modify

### src/stores/editor.store.ts
\`\`\`typescript
import { createStore } from \"solid-js/store\";

interface EditorState {
  selectedText: string;
  selectedFile: string | null;
  selectedRange: { startLine: number; endLine: number } | null;
}

const [state, setState] = createStore<EditorState>({
  selectedText: \"\",
  selectedFile: null,
  selectedRange: null,
});

export const editorStore = {
  get selectedText() { return state.selectedText; },
  get selectedFile() { return state.selectedFile; },

  setSelection(text: string, file: string, range: { startLine: number; endLine: number }) {
    setState({ selectedText: text, selectedFile: file, selectedRange: range });
  },

  clearSelection() {
    setState({ selectedText: \"\", selectedFile: null, selectedRange: null });
  },
};
\`\`\`

### Update ChatPanel to show context
\`\`\`typescript
// In ChatPanel.tsx
import { editorStore } from \"@/stores/editor.store\";

// Show context preview above input
{editorStore.selectedText && (
  <div class=\"chat-context\">
    <div class=\"context-header\">
      <span>Context from {editorStore.selectedFile}</span>
      <button onClick={() => editorStore.clearSelection()}>×</button>
    </div>
    <pre class=\"context-code\">{editorStore.selectedText}</pre>
  </div>
)}
\`\`\`

## Definition of Done
- [ ] Selection in editor updates store
- [ ] Context shown in chat panel
- [ ] Context included in API request
- [ ] Can clear context
- [ ] File name and line numbers shown

## Commit: \`feat: implement chat context from file selection\`"

# Issue #19
gh issue create --repo $REPO \
  --title "Add message timestamps and formatting" \
  --label "phase: 2-chat,type: feature,priority: low,area: chat,area: ui,agent: codex" \
  --body "## Overview
Display timestamps on messages and improve text formatting (markdown rendering).

## Requirements
- Show relative time (\"2 min ago\", \"Yesterday\")
- Render markdown in assistant messages (code blocks, lists, bold)
- User messages remain plain text

## Files to Create/Modify

### src/lib/format-time.ts
\`\`\`typescript
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return \"Just now\";
  if (minutes < 60) return \`\${minutes}m ago\`;
  if (hours < 24) return \`\${hours}h ago\`;
  if (days < 7) return \`\${days}d ago\`;

  return new Date(timestamp).toLocaleDateString();
}
\`\`\`

### Install markdown renderer
\`\`\`bash
pnpm add marked
\`\`\`

### Update message rendering
- User messages: plain text (textContent)
- Assistant messages: rendered markdown (with escapeHtml for code)

## Definition of Done
- [ ] Timestamps shown on all messages
- [ ] Relative time format (\"2m ago\")
- [ ] Markdown rendered in assistant messages
- [ ] Code blocks have syntax highlighting
- [ ] No XSS vulnerabilities

## Commit: \`feat: add message timestamps and markdown formatting\`"

# Issue #20
gh issue create --repo $REPO \
  --title "Create chat store for state management" \
  --label "phase: 2-chat,type: feature,priority: high,area: chat,agent: codex" \
  --body "## Overview
Create a centralized store for chat state including messages, selected model, and loading state.

## Files to Create

### src/stores/chat.store.ts
\`\`\`typescript
import { createStore } from \"solid-js/store\";
import { Message } from \"@/services/chat\";

interface ChatState {
  messages: Message[];
  selectedModel: string;
  isLoading: boolean;
  error: string | null;
}

const DEFAULT_MODEL = \"anthropic/claude-sonnet-4-20250514\";
const MAX_MESSAGES = 50;

const [state, setState] = createStore<ChatState>({
  messages: [],
  selectedModel: DEFAULT_MODEL,
  isLoading: false,
  error: null,
});

export const chatStore = {
  // Getters
  get messages() { return state.messages; },
  get selectedModel() { return state.selectedModel; },
  get isLoading() { return state.isLoading; },
  get error() { return state.error; },

  // Actions
  addMessage(message: Message) {
    setState(\"messages\", (msgs) => {
      const updated = [...msgs, message];
      // Enforce 50 message limit
      if (updated.length > MAX_MESSAGES) {
        return updated.slice(-MAX_MESSAGES);
      }
      return updated;
    });
  },

  setMessages(messages: Message[]) {
    setState(\"messages\", messages.slice(-MAX_MESSAGES));
  },

  setModel(modelId: string) {
    setState(\"selectedModel\", modelId);
  },

  setLoading(loading: boolean) {
    setState(\"isLoading\", loading);
  },

  setError(error: string | null) {
    setState(\"error\", error);
  },

  clearMessages() {
    setState(\"messages\", []);
  },
};
\`\`\`

## Definition of Done
- [ ] Store manages all chat state
- [ ] 50 message limit enforced
- [ ] Model selection persisted
- [ ] Loading and error states available
- [ ] ChatPanel uses store instead of local state

## Commit: \`feat: create chat store for centralized state management\`"

# Issue #21
gh issue create --repo $REPO \
  --title "Add retry logic for failed messages" \
  --label "phase: 2-chat,type: feature,priority: medium,area: chat,agent: codex" \
  --body "## Overview
Allow users to retry failed messages with exponential backoff.

## Requirements
- Show retry button on failed messages
- Auto-retry once on network errors
- Exponential backoff: 1s, 2s, 4s (max 3 attempts)
- Show attempt count

## Files to Modify

### src/services/chat.ts
\`\`\`typescript
const MAX_RETRIES = 3;
const INITIAL_DELAY = 1000;

export async function sendMessageWithRetry(
  content: string,
  model: string,
  onRetry?: (attempt: number) => void
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await sendMessage(content, model);
    } catch (error) {
      lastError = error as Error;

      // Don't retry auth errors
      if (error.message.includes(\"401\") || error.message.includes(\"403\")) {
        throw error;
      }

      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_DELAY * Math.pow(2, attempt - 1);
        onRetry?.(attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}
\`\`\`

### Update ChatPanel
- Track failed messages
- Show retry button
- Display \"Retrying (2/3)...\" status

## Definition of Done
- [ ] Auto-retry on network errors
- [ ] Exponential backoff implemented
- [ ] Max 3 attempts
- [ ] Retry button on failed messages
- [ ] Auth errors not retried

## Commit: \`feat: add retry logic with exponential backoff\`"

# Issue #22
gh issue create --repo $REPO \
  --title "Implement 50-message history limit with cleanup" \
  --label "phase: 2-chat,type: feature,priority: medium,area: chat,agent: codex" \
  --body "## Overview
Enforce 50-message history limit in both UI and database, with proper cleanup.

## Requirements (from VS Code implementation)
- Maximum 50 messages stored
- When limit reached, delete oldest messages
- Applies to both in-memory store and SQLite
- User can manually clear all history

## Files to Modify

### src-tauri/src/commands/chat.rs
\`\`\`rust
const MAX_MESSAGES: i32 = 50;

#[tauri::command]
pub async fn save_message(...) -> Result<(), String> {
    // Save message
    // Then cleanup old messages
    conn.execute(
        \"DELETE FROM messages WHERE id NOT IN (
            SELECT id FROM messages ORDER BY timestamp DESC LIMIT ?
        )\",
        [MAX_MESSAGES],
    )?;
}
\`\`\`

### src/stores/chat.store.ts
Already has limit in addMessage(), verify it works.

### Add clear history UI
\`\`\`typescript
// In ChatPanel or Settings
<button onClick={() => {
  chatStore.clearMessages();
  invoke(\"clear_history\");
}}>
  Clear Chat History
</button>
\`\`\`

## Definition of Done
- [ ] 50 message limit in store
- [ ] 50 message limit in SQLite
- [ ] Old messages auto-deleted
- [ ] Clear history button works
- [ ] Confirmation before clearing

## Commit: \`feat: implement 50-message history limit with cleanup\`"

echo ""
echo "Phase 2 issues created! (10 issues: #13-#22)"
echo "View at: https://github.com/$REPO/issues"
