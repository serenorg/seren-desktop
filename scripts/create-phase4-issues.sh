#!/bin/bash
# Create Phase 4 GitHub issues for seren-desktop repository
# Phase 4: Projects & Catalog - Project picker, file sync, publisher catalog

set -e

REPO="serenorg/seren-desktop"

echo "Creating Phase 4 issues (Projects & Catalog) for $REPO..."

# Issue #33
gh issue create --repo $REPO \
  --title "Create project picker UI" \
  --label "phase: 4-catalog,type: feature,priority: high,area: ui,agent: codex" \
  --body "## Overview
Create a modal/panel for selecting, creating, and managing projects.

## Features
- List existing projects
- Create new project
- Delete project (with confirmation)
- Switch between projects
- Show project region

## Files to Create

### src/components/sidebar/ProjectPicker.tsx
\`\`\`typescript
import { Component, For, createSignal, Show } from \"solid-js\";
import { projectStore } from \"@/stores/project.store\";
import { projects } from \"@/services/projects\";
import \"./ProjectPicker.css\";

export const ProjectPicker: Component = () => {
  const [isCreating, setIsCreating] = createSignal(false);
  const [newName, setNewName] = createSignal(\"\");
  const [selectedRegion, setSelectedRegion] = createSignal(\"us-east-1\");

  const handleCreate = async () => {
    await projects.create(newName(), selectedRegion());
    setNewName(\"\");
    setIsCreating(false);
    await projectStore.refresh();
  };

  const handleDelete = async (id: string, name: string) => {
    if (confirm(\`Delete project \"\${name}\"? This cannot be undone.\`)) {
      await projects.delete(id);
      await projectStore.refresh();
    }
  };

  return (
    <div class=\"project-picker\">
      <div class=\"project-picker-header\">
        <h2>Projects</h2>
        <button onClick={() => setIsCreating(true)}>+ New</button>
      </div>

      <Show when={isCreating()}>
        <div class=\"project-create-form\">
          <input
            type=\"text\"
            placeholder=\"Project name\"
            value={newName()}
            onInput={(e) => setNewName(e.currentTarget.value)}
          />
          <select value={selectedRegion()} onChange={(e) => setSelectedRegion(e.currentTarget.value)}>
            <option value=\"us-east-1\">US East</option>
            <option value=\"us-west-2\">US West</option>
            <option value=\"eu-west-1\">EU West</option>
            <option value=\"ap-southeast-1\">Asia Pacific</option>
          </select>
          <button onClick={handleCreate}>Create</button>
          <button onClick={() => setIsCreating(false)}>Cancel</button>
        </div>
      </Show>

      <div class=\"project-list\">
        <For each={projectStore.projects}>
          {(project) => (
            <div
              class={\"project-item \" + (project.id === projectStore.activeProject?.id ? \"active\" : \"\")}
              onClick={() => projectStore.setActive(project.id)}
            >
              <span class=\"project-name\">{project.name}</span>
              <span class=\"project-region\">{project.region}</span>
              <button
                class=\"project-delete\"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(project.id, project.name);
                }}
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};
\`\`\`

## Definition of Done
- [ ] Lists all user projects
- [ ] Can create new project
- [ ] Can delete project with confirmation
- [ ] Can switch active project
- [ ] Shows region for each project

## Commit: \`feat: create project picker UI\`"

# Issue #34
gh issue create --repo $REPO \
  --title "Implement project service (CRUD)" \
  --label "phase: 4-catalog,type: feature,priority: high,area: rust,agent: codex" \
  --body "## Overview
Create service for project CRUD operations via Seren API.

## API Endpoints
\`\`\`
GET    /v1/projects          - List projects
POST   /v1/projects          - Create project
GET    /v1/projects/:id      - Get project
PUT    /v1/projects/:id      - Update project
DELETE /v1/projects/:id      - Delete project
\`\`\`

## Files to Create

### src/services/projects.ts
\`\`\`typescript
import { config } from \"@/lib/config\";
import { auth } from \"./auth\";

export interface Project {
  id: string;
  name: string;
  region: string;
  created_at: string;
  updated_at: string;
}

export const projects = {
  async list(): Promise<Project[]> {
    const token = await auth.getToken();
    const res = await fetch(\`\${config.apiBase}/projects\`, {
      headers: { Authorization: \`Bearer \${token}\` },
    });
    if (!res.ok) throw new Error(\"Failed to list projects\");
    const data = await res.json();
    return data.projects;
  },

  async create(name: string, region: string): Promise<Project> {
    const token = await auth.getToken();
    const res = await fetch(\`\${config.apiBase}/projects\`, {
      method: \"POST\",
      headers: {
        \"Content-Type\": \"application/json\",
        Authorization: \`Bearer \${token}\`,
      },
      body: JSON.stringify({ name, region }),
    });
    if (!res.ok) throw new Error(\"Failed to create project\");
    return res.json();
  },

  async delete(id: string): Promise<void> {
    const token = await auth.getToken();
    const res = await fetch(\`\${config.apiBase}/projects/\${id}\`, {
      method: \"DELETE\",
      headers: { Authorization: \`Bearer \${token}\` },
    });
    if (!res.ok) throw new Error(\"Failed to delete project\");
  },

  async get(id: string): Promise<Project> {
    const token = await auth.getToken();
    const res = await fetch(\`\${config.apiBase}/projects/\${id}\`, {
      headers: { Authorization: \`Bearer \${token}\` },
    });
    if (!res.ok) throw new Error(\"Failed to get project\");
    return res.json();
  },
};
\`\`\`

## Definition of Done
- [ ] List projects works
- [ ] Create project works
- [ ] Delete project works
- [ ] Get single project works
- [ ] Errors handled gracefully

## Commit: \`feat: implement project service CRUD operations\`"

# Issue #35
gh issue create --repo $REPO \
  --title "Add multi-region support" \
  --label "phase: 4-catalog,type: feature,priority: medium,agent: codex" \
  --body "## Overview
Support multiple regions for project creation and API routing.

## Regions (from VS Code implementation)
- us-east-1 (US East - Virginia)
- us-west-2 (US West - Oregon)
- eu-west-1 (EU West - Ireland)
- ap-southeast-1 (Asia Pacific - Singapore)

## Files to Create

### src/lib/regions.ts
\`\`\`typescript
export interface Region {
  id: string;
  name: string;
  location: string;
}

export const REGIONS: Region[] = [
  { id: \"us-east-1\", name: \"US East\", location: \"Virginia\" },
  { id: \"us-west-2\", name: \"US West\", location: \"Oregon\" },
  { id: \"eu-west-1\", name: \"EU West\", location: \"Ireland\" },
  { id: \"ap-southeast-1\", name: \"Asia Pacific\", location: \"Singapore\" },
];

export function getRegionName(id: string): string {
  return REGIONS.find(r => r.id === id)?.name || id;
}
\`\`\`

## Definition of Done
- [ ] Region list available
- [ ] Project picker shows regions
- [ ] Can create project in any region
- [ ] Region displayed in project list

## Commit: \`feat: add multi-region support\`"

# Issue #36
gh issue create --repo $REPO \
  --title "Create file sync service (Rust notify crate)" \
  --label "phase: 4-catalog,type: feature,priority: high,area: rust,agent: codex" \
  --body "## Overview
Watch project directory for file changes and sync with Seren.

## Dependencies
\`\`\`toml
[dependencies]
notify = \"6\"
\`\`\`

## Files to Create

### src-tauri/src/services/file_watcher.rs
\`\`\`rust
use notify::{Watcher, RecursiveMode, Result, Event};
use std::path::Path;
use std::sync::mpsc::channel;
use tauri::{AppHandle, Manager};

pub struct FileWatcher {
    watcher: notify::RecommendedWatcher,
}

impl FileWatcher {
    pub fn new(app: AppHandle, path: &str) -> Result<Self> {
        let (tx, rx) = channel();

        let mut watcher = notify::recommended_watcher(move |res: Result<Event>| {
            if let Ok(event) = res {
                tx.send(event).unwrap();
            }
        })?;

        watcher.watch(Path::new(path), RecursiveMode::Recursive)?;

        // Spawn thread to handle events
        let app_clone = app.clone();
        std::thread::spawn(move || {
            for event in rx {
                // Emit event to frontend
                app_clone.emit(\"file-changed\", &event.paths).ok();
            }
        });

        Ok(Self { watcher })
    }
}
\`\`\`

### src-tauri/src/commands/sync.rs
\`\`\`rust
#[tauri::command]
pub async fn start_watching(app: AppHandle, path: String) -> Result<(), String> {
    // Start file watcher
}

#[tauri::command]
pub async fn stop_watching(app: AppHandle) -> Result<(), String> {
    // Stop file watcher
}

#[tauri::command]
pub async fn get_sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    // Return current sync status
}
\`\`\`

## Definition of Done
- [ ] File watcher starts on project open
- [ ] Changes detected and emitted
- [ ] Frontend receives change events
- [ ] Watcher stops on project close
- [ ] No memory leaks

## Commit: \`feat: create file sync service with notify crate\`"

# Issue #37
gh issue create --repo $REPO \
  --title "Add sync status indicator" \
  --label "phase: 4-catalog,type: feature,priority: medium,area: ui,agent: codex" \
  --body "## Overview
Show sync status in the status bar (syncing, synced, error).

## States
- Idle (gray)
- Syncing (blue, animated)
- Synced (green checkmark)
- Error (red, with message)

## Files to Create

### src/components/common/SyncIndicator.tsx
\`\`\`typescript
import { Component } from \"solid-js\";
import { syncStore } from \"@/stores/sync.store\";
import \"./SyncIndicator.css\";

export const SyncIndicator: Component = () => {
  const statusClass = () => {
    switch (syncStore.status) {
      case \"syncing\": return \"syncing\";
      case \"synced\": return \"synced\";
      case \"error\": return \"error\";
      default: return \"idle\";
    }
  };

  const statusIcon = () => {
    switch (syncStore.status) {
      case \"syncing\": return \"↻\";
      case \"synced\": return \"✓\";
      case \"error\": return \"✗\";
      default: return \"○\";
    }
  };

  return (
    <div class={\"sync-indicator \" + statusClass()} title={syncStore.message}>
      <span class=\"sync-icon\">{statusIcon()}</span>
      <span class=\"sync-text\">{syncStore.status}</span>
    </div>
  );
};
\`\`\`

## Definition of Done
- [ ] Shows current sync status
- [ ] Animated during syncing
- [ ] Error message on hover
- [ ] Updates in real-time

## Commit: \`feat: add sync status indicator\`"

# Issue #38
gh issue create --repo $REPO \
  --title "Create publisher catalog panel" \
  --label "phase: 4-catalog,type: feature,priority: high,area: catalog,area: ui,agent: codex" \
  --body "## Overview
Create a panel to browse Seren publisher catalog.

## Features
- List all publishers
- Search/filter publishers
- Show publisher details
- Categories (Database, API, Integration)

## Files to Create

### src/components/sidebar/CatalogPanel.tsx
\`\`\`typescript
import { Component, For, createSignal, createResource } from \"solid-js\";
import { catalog } from \"@/services/catalog\";
import \"./CatalogPanel.css\";

export const CatalogPanel: Component = () => {
  const [search, setSearch] = createSignal(\"\");
  const [publishers] = createResource(() => catalog.list());

  const filtered = () => {
    const query = search().toLowerCase();
    return publishers()?.filter(p =>
      p.name.toLowerCase().includes(query) ||
      p.description.toLowerCase().includes(query)
    ) || [];
  };

  return (
    <div class=\"catalog-panel\">
      <div class=\"catalog-header\">
        <h2>Publishers</h2>
        <input
          type=\"search\"
          placeholder=\"Search publishers...\"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
      </div>

      <div class=\"catalog-list\">
        <For each={filtered()}>
          {(publisher) => (
            <div class=\"publisher-card\" onClick={() => /* show details */}>
              <img src={publisher.logo_url} alt={publisher.name} class=\"publisher-logo\" />
              <div class=\"publisher-info\">
                <h3>{publisher.name}</h3>
                <p>{publisher.description}</p>
                <span class=\"publisher-category\">{publisher.category}</span>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};
\`\`\`

## Definition of Done
- [ ] Lists all publishers
- [ ] Search filters results
- [ ] Shows logo, name, description
- [ ] Click opens details view
- [ ] Loading state shown

## Commit: \`feat: create publisher catalog panel\`"

# Issue #39
gh issue create --repo $REPO \
  --title "Implement publisher service" \
  --label "phase: 4-catalog,type: feature,priority: high,area: catalog,agent: codex" \
  --body "## Overview
Create service for fetching publisher data from Seren API.

## API Endpoints
\`\`\`
GET /v1/publishers           - List publishers
GET /v1/publishers/:slug     - Get publisher details
\`\`\`

## Files to Create

### src/services/catalog.ts
\`\`\`typescript
import { config } from \"@/lib/config\";
import { auth } from \"./auth\";

export interface Publisher {
  id: string;
  slug: string;
  name: string;
  description: string;
  logo_url: string;
  category: string;
  pricing: {
    price_per_call: string;
  };
  capabilities: string[];
  is_verified: boolean;
}

export const catalog = {
  async list(): Promise<Publisher[]> {
    const token = await auth.getToken();
    const res = await fetch(\`\${config.apiBase}/publishers\`, {
      headers: { Authorization: \`Bearer \${token}\` },
    });
    if (!res.ok) throw new Error(\"Failed to list publishers\");
    const data = await res.json();
    return data.publishers;
  },

  async get(slug: string): Promise<Publisher> {
    const token = await auth.getToken();
    const res = await fetch(\`\${config.apiBase}/publishers/\${slug}\`, {
      headers: { Authorization: \`Bearer \${token}\` },
    });
    if (!res.ok) throw new Error(\"Failed to get publisher\");
    return res.json();
  },

  async suggest(query: string): Promise<Publisher[]> {
    const token = await auth.getToken();
    const res = await fetch(\`\${config.apiBase}/publishers/suggest?q=\${encodeURIComponent(query)}\`, {
      headers: { Authorization: \`Bearer \${token}\` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.suggestions;
  },
};
\`\`\`

## Definition of Done
- [ ] List publishers works
- [ ] Get publisher details works
- [ ] Suggest publishers works
- [ ] Errors handled gracefully

## Commit: \`feat: implement publisher service\`"

# Issue #40
gh issue create --repo $REPO \
  --title "Add publisher details view" \
  --label "phase: 4-catalog,type: feature,priority: medium,area: catalog,area: ui,agent: codex" \
  --body "## Overview
Create a detailed view for individual publishers.

## Features
- Full description
- Pricing information
- Capabilities list
- Example usage
- Link to documentation

## Files to Create

### src/components/sidebar/PublisherDetails.tsx
\`\`\`typescript
import { Component, Show, createResource } from \"solid-js\";
import { catalog, Publisher } from \"@/services/catalog\";
import { escapeHtml } from \"@/lib/escape-html\";
import \"./PublisherDetails.css\";

interface PublisherDetailsProps {
  slug: string;
  onBack: () => void;
}

export const PublisherDetails: Component<PublisherDetailsProps> = (props) => {
  const [publisher] = createResource(() => props.slug, catalog.get);

  return (
    <div class=\"publisher-details\">
      <button class=\"back-button\" onClick={props.onBack}>← Back</button>

      <Show when={publisher()} fallback={<div>Loading...</div>}>
        {(pub) => (
          <>
            <div class=\"publisher-header\">
              <img src={pub().logo_url} alt={pub().name} />
              <div>
                <h1>{pub().name}</h1>
                {pub().is_verified && <span class=\"verified-badge\">✓ Verified</span>}
              </div>
            </div>

            <p class=\"publisher-description\">{pub().description}</p>

            <div class=\"publisher-pricing\">
              <h3>Pricing</h3>
              <p>\${pub().pricing.price_per_call} per call</p>
            </div>

            <div class=\"publisher-capabilities\">
              <h3>Capabilities</h3>
              <ul>
                {pub().capabilities.map(cap => <li>{cap}</li>)}
              </ul>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};
\`\`\`

## Definition of Done
- [ ] Shows full publisher info
- [ ] Pricing displayed clearly
- [ ] Capabilities listed
- [ ] Back button works
- [ ] Loading state shown

## Commit: \`feat: add publisher details view\`"

# Issue #41
gh issue create --repo $REPO \
  --title "Create settings panel" \
  --label "phase: 4-catalog,type: feature,priority: high,area: ui,agent: codex" \
  --body "## Overview
Create a settings panel for user preferences.

## Settings Categories
- **General**: Theme, language
- **Editor**: Font size, tab size, word wrap
- **Completion**: Enable/disable, delay, disabled languages
- **Wallet**: Balance display, low balance threshold
- **Account**: Email, logout

## Files to Create

### src/components/sidebar/SettingsPanel.tsx
Component with multiple sections.

### src/stores/settings.store.ts
\`\`\`typescript
import { createStore } from \"solid-js/store\";
import { invoke } from \"@tauri-apps/api/core\";

interface Settings {
  // Editor
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: boolean;

  // Completion
  completionEnabled: boolean;
  completionDelay: number;
  completionDisabledLanguages: string[];

  // Wallet
  showBalance: boolean;
  lowBalanceThreshold: number;

  // Auto top-up
  autoTopUpEnabled: boolean;
  autoTopUpThreshold: number;
  autoTopUpAmount: number;
}

const DEFAULT_SETTINGS: Settings = {
  editorFontSize: 14,
  editorTabSize: 2,
  editorWordWrap: true,
  completionEnabled: true,
  completionDelay: 300,
  completionDisabledLanguages: [\"markdown\", \"plaintext\"],
  showBalance: true,
  lowBalanceThreshold: 1.0,
  autoTopUpEnabled: false,
  autoTopUpThreshold: 5.0,
  autoTopUpAmount: 25.0,
};

// Load from Tauri store on init
// Save to Tauri store on change
\`\`\`

## Definition of Done
- [ ] All settings categories shown
- [ ] Changes saved immediately
- [ ] Settings persist after restart
- [ ] Reset to defaults option
- [ ] Logout button works

## Commit: \`feat: create settings panel\`"

# Issue #42
gh issue create --repo $REPO \
  --title "Implement auto top-up configuration" \
  --label "phase: 4-catalog,type: feature,priority: medium,area: wallet,agent: codex" \
  --body "## Overview
Allow users to configure automatic SerenBucks top-up.

## Configuration (from VS Code implementation)
- Enable/disable auto top-up
- Threshold: trigger when balance below (default: \$5.00)
- Amount: how much to add (default: \$25.00)
- Links to Stripe checkout

## Files to Modify

### src/components/sidebar/SettingsPanel.tsx
Add auto top-up section:
\`\`\`tsx
<div class=\"settings-section\">
  <h3>Auto Top-Up</h3>
  <label>
    <input
      type=\"checkbox\"
      checked={settings.autoTopUpEnabled}
      onChange={(e) => settingsStore.set(\"autoTopUpEnabled\", e.currentTarget.checked)}
    />
    Enable automatic top-up
  </label>

  <Show when={settings.autoTopUpEnabled}>
    <label>
      When balance falls below:
      <input
        type=\"number\"
        min=\"1\"
        value={settings.autoTopUpThreshold}
        onChange={(e) => settingsStore.set(\"autoTopUpThreshold\", parseFloat(e.currentTarget.value))}
      />
    </label>

    <label>
      Top-up amount:
      <select
        value={settings.autoTopUpAmount}
        onChange={(e) => settingsStore.set(\"autoTopUpAmount\", parseFloat(e.currentTarget.value))}
      >
        <option value=\"10\">$10</option>
        <option value=\"25\">$25</option>
        <option value=\"50\">$50</option>
        <option value=\"100\">$100</option>
      </select>
    </label>
  </Show>
</div>
\`\`\`

### src/services/wallet.ts
Add top-up trigger check:
\`\`\`typescript
export async function checkAutoTopUp(balance: number): Promise<void> {
  const settings = settingsStore;
  if (!settings.autoTopUpEnabled) return;
  if (balance >= settings.autoTopUpThreshold) return;

  // Redirect to Stripe checkout
  const checkoutUrl = await createCheckoutSession(settings.autoTopUpAmount);
  await invoke(\"open_external_url\", { url: checkoutUrl });
}
\`\`\`

## Definition of Done
- [ ] Toggle to enable/disable
- [ ] Configurable threshold
- [ ] Configurable amount
- [ ] Triggers Stripe checkout
- [ ] Settings persisted

## Commit: \`feat: implement auto top-up configuration\`"

echo ""
echo "Phase 4 issues created! (10 issues: #33-#42)"
echo "View at: https://github.com/$REPO/issues"
