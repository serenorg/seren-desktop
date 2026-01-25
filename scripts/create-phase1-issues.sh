#!/bin/bash
# Create Phase 1 GitHub issues for seren-desktop repository
# Run: gh auth login && ./scripts/create-phase1-issues.sh

set -e

REPO="serenorg/seren-desktop"

echo "Creating Phase 1 issues for $REPO..."

# Issue #1
gh issue create --repo $REPO \
  --title "Scaffold Tauri + SolidJS + Vite project" \
  --label "phase: 1-foundation,type: chore,priority: critical" \
  --body "## Overview
Initialize the monorepo with Tauri 2.0, SolidJS, and Vite.

## Steps

1. Create Tauri project: \`pnpm create tauri-app seren-desktop --template solid-ts --manager pnpm\`
2. Verify structure matches expected layout
3. Update package.json scripts
4. Configure tauri.conf.json with product name and window settings
5. Test that \`pnpm tauri dev\` launches the app

## Definition of Done
- [ ] \`pnpm tauri dev\` launches app window
- [ ] Window shows \"Seren Desktop\" title
- [ ] No console errors

## Commit: \`chore: scaffold Tauri + SolidJS + Vite project\`"

# Issue #2
gh issue create --repo $REPO \
  --title "Add TypeScript path aliases and project structure" \
  --label "phase: 1-foundation,type: chore,priority: high" \
  --body "## Overview
Set up path aliases so we can import with \`@/\` instead of relative paths.

## Steps

1. Update tsconfig.json with baseUrl and paths
2. Update vite.config.ts with resolve.alias
3. Create directory structure: src/{components,services,stores,lib}
4. Create component subdirs: src/components/{chat,editor,sidebar,mcp,common}

## Definition of Done
- [ ] Can import with \`@/components/...\`
- [ ] All directories exist
- [ ] No TypeScript errors

## Commit: \`chore: add TypeScript path aliases and project structure\`"

# Issue #3
gh issue create --repo $REPO \
  --title "Install and configure ESLint + Prettier" \
  --label "phase: 1-foundation,type: chore,priority: medium" \
  --body "## Overview
Set up linting and formatting for consistent code style.

## Steps

1. Install: eslint, @typescript-eslint/parser, @typescript-eslint/eslint-plugin, eslint-plugin-solid, prettier, eslint-config-prettier
2. Create .eslintrc.json with TypeScript and SolidJS rules
3. Create .prettierrc and .prettierignore
4. Add lint and format scripts to package.json

## Definition of Done
- [ ] \`pnpm lint\` runs without config errors
- [ ] \`pnpm format\` formats files
- [ ] No \`any\` types allowed (eslint rule)

## Commit: \`chore: configure ESLint and Prettier\`"

# Issue #4
gh issue create --repo $REPO \
  --title "Create escapeHtml utility with tests" \
  --label "phase: 1-foundation,type: feature,priority: critical,security" \
  --body "## Overview
Create a utility to escape HTML special characters. This prevents XSS attacks.

## SECURITY WARNING
This function is critical. All user content displayed with innerHTML must use this.

## Files to Create

- src/lib/escape-html.ts
- tests/unit/escape-html.test.ts

## Test Cases
- Escapes &, <, >, \", '
- Escapes script tags
- Handles empty string
- Passes through safe text

## Definition of Done
- [ ] Function exists and is exported
- [ ] All 8 tests pass
- [ ] \`pnpm test\` passes

## Commit: \`feat: add escapeHtml utility with tests\`"

# Issue #5
gh issue create --repo $REPO \
  --title "Create scrubSensitive utility with tests" \
  --label "phase: 1-foundation,type: feature,priority: critical,security" \
  --body "## Overview
Create a utility to remove sensitive data from error messages before telemetry.

## SECURITY WARNING
All error messages sent to the server must use this to remove:
- API keys (sk_live_*, sk_test_*)
- Email addresses
- File paths with usernames
- UUIDs
- Bearer tokens

## Files to Create

- src/lib/scrub-sensitive.ts
- tests/unit/scrub-sensitive.test.ts

## Definition of Done
- [ ] Function exists and is exported
- [ ] All tests pass
- [ ] No sensitive data leaks in scrubbed output

## Commit: \`feat: add scrubSensitive utility for PII removal\`"

# Issue #6
gh issue create --repo $REPO \
  --title "Set up Tauri secure storage plugin" \
  --label "phase: 1-foundation,type: feature,priority: critical,area: rust,security" \
  --body "## Overview
Configure Tauri's secure storage plugin for storing authentication tokens.

## SECURITY WARNING
NEVER store tokens in localStorage or plain files. Use OS keychain via Tauri.

## Steps

1. Add tauri-plugin-store to Cargo.toml
2. Register plugin in src-tauri/src/lib.rs
3. Create auth commands: store_token, get_token, clear_token
4. Create frontend wrapper in src/lib/tauri-bridge.ts

## Definition of Done
- [ ] Plugin installed and registered
- [ ] store_token command works
- [ ] get_token retrieves stored token
- [ ] clear_token removes token
- [ ] Tokens persist after app restart

## Commit: \`feat: set up Tauri secure storage for auth tokens\`"

# Issue #7
gh issue create --repo $REPO \
  --title "Create API base URL configuration" \
  --label "phase: 1-foundation,type: feature,priority: high" \
  --body "## Overview
Create a centralized configuration for the Seren Gateway API URL.

## Files to Create

- src/lib/config.ts

## Configuration
- API_URL: https://api.serendb.com
- API_VERSION: v1
- apiBase getter: \${API_URL}/\${API_VERSION}

## SECURITY
API_URL must always be HTTPS in production.

## Definition of Done
- [ ] Config file created
- [ ] API_URL is https://api.serendb.com
- [ ] Can import config from @/lib/config

## Commit: \`feat: add API base URL configuration\`"

# Issue #8
gh issue create --repo $REPO \
  --title "Create auth service with login function" \
  --label "phase: 1-foundation,type: feature,priority: critical,area: auth" \
  --body "## Overview
Create the authentication service that handles login and token management.

## API Endpoint
POST https://api.serendb.com/v1/auth/login

## Files to Create

- src/services/auth.ts
- src/services/index.ts

## Functions
- login(email, password) - calls API, stores token
- logout() - clears token
- isLoggedIn() - checks for stored token
- getToken() - returns stored token

## Definition of Done
- [ ] auth.login() calls API
- [ ] Token stored securely on success
- [ ] Error thrown on failure
- [ ] auth.logout() clears token

## Commit: \`feat: create auth service with login function\`"

# Issue #9
gh issue create --repo $REPO \
  --title "Create basic App layout component" \
  --label "phase: 1-foundation,type: feature,priority: high,area: ui" \
  --body "## Overview
Create the main App layout with sidebar, main panel, and header.

## Layout
- Header: Title, user actions
- Sidebar: Navigation (Chat, Editor, Catalog, Settings)
- Main Panel: Active panel content
- Status Bar: Status messages

## Files to Create/Modify

- src/components/common/Header.tsx
- src/components/common/Sidebar.tsx
- src/components/common/StatusBar.tsx
- src/App.tsx
- src/App.css

## Definition of Done
- [ ] Header shows \"Seren Desktop\"
- [ ] Sidebar has 4 navigation items
- [ ] Clicking sidebar changes active panel
- [ ] Dark theme applied

## Commit: \`feat: create basic App layout with sidebar and header\`"

# Issue #10
gh issue create --repo $REPO \
  --title "Create SignIn component" \
  --label "phase: 1-foundation,type: feature,priority: critical,area: auth,area: ui" \
  --body "## Overview
Create the sign-in form component for user authentication.

## SECURITY WARNINGS
1. Never log passwords
2. Use type=\"password\" for password input
3. Disable autocomplete for password

## Files to Create

- src/components/auth/SignIn.tsx
- src/components/auth/SignIn.css

## Features
- Email and password inputs
- Form validation
- Loading state
- Error display
- onSuccess callback

## Definition of Done
- [ ] Form has email and password inputs
- [ ] Password input uses type=\"password\"
- [ ] Submit calls auth.login()
- [ ] Error message displays on failure
- [ ] Loading state disables button

## Commit: \`feat: create SignIn component with form validation\`"

# Issue #11
gh issue create --repo $REPO \
  --title "Create auth store and integrate SignIn with App" \
  --label "phase: 1-foundation,type: feature,priority: high,area: auth" \
  --body "## Overview
Create a SolidJS store for authentication state and integrate SignIn with App.

## Files to Create/Modify

- src/stores/auth.store.ts
- Update src/App.tsx

## Store State
- user: User | null
- isLoading: boolean
- isAuthenticated: boolean

## App Behavior
1. Check auth status on mount
2. Show loading while checking
3. Show SignIn if not authenticated
4. Show main app if authenticated

## Definition of Done
- [ ] Auth store manages state
- [ ] App checks auth on mount
- [ ] Shows SignIn when not authenticated
- [ ] Shows main app when authenticated

## Commit: \`feat: create auth store and integrate SignIn flow\`"

# Issue #12
gh issue create --repo $REPO \
  --title "Create basic ChatPanel component" \
  --label "phase: 1-foundation,type: feature,priority: high,area: chat,area: ui,good first issue" \
  --body "## Overview
Create a basic chat panel that can send a message and display responses.

Note: This is non-streaming. Streaming will be added in Phase 2.

## Files to Create

- src/services/chat.ts
- src/components/chat/ChatPanel.tsx
- src/components/chat/ChatPanel.css

## Features
- Display messages (user and assistant)
- Text input with Enter to send
- Loading state while waiting
- Error handling

## Definition of Done
- [ ] Chat panel displays messages
- [ ] Can type and send a message
- [ ] Response appears after API call
- [ ] Loading state shown while waiting
- [ ] Enter key sends message

## Commit: \`feat: create basic ChatPanel with message sending\`"

echo ""
echo "Phase 1 issues created! (12 issues)"
echo "View at: https://github.com/$REPO/issues"
