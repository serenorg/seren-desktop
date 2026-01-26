# Seren Desktop

A lightweight (~10MB) AI desktop client built with Tauri, SolidJS, and Monaco Editor.

[![CI](https://github.com/serenorg/seren-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/serenorg/seren-desktop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

### AI Chat

- **Multi-model support** - Claude, GPT-4, Gemini via Seren Gateway or direct API keys
- **Multi-tab conversations** - Work on multiple chats simultaneously with tabbed interface
- **Streaming responses** - Real-time token-by-token output
- **Conversation persistence** - Chat history saved locally in SQLite
- **Auto-refresh authentication** - Seamless token refresh on expiration

### Code Editor

- **Monaco Editor** - Full VS Code editing experience
- **Syntax highlighting** - 100+ languages supported
- **Multi-file tabs** - Open and edit multiple files
- **Markdown preview** - Live preview for `.md` files
- **Image viewer** - View images inline
- **PDF viewer** - Read PDF documents

### File Explorer

- **Tree navigation** - Browse local directories
- **File operations** - Create, rename, delete files and folders
- **Context menu** - Right-click actions
- **Dotfile support** - Show/hide hidden files

### Database Panel (SerenDB)

- **Project management** - Create and delete SerenDB projects
- **Branch navigation** - Browse project branches
- **Connection strings** - Copy database connection strings
- **Organization support** - Multi-org project creation

### MCP Integration (Model Context Protocol)

- **Tool execution** - Run AI agent tools with approval workflow
- **Resource browsing** - Access MCP server resources
- **Multi-server support** - Connect to multiple MCP servers
- **x402 payments** - Automatic micropayments for premium tools

### Publisher Catalog

- **Browse APIs** - Discover AI-accessible services
- **Publisher details** - View pricing, capabilities, usage
- **Quick connect** - One-click publisher activation

### Wallet & Payments

- **SerenBucks** - View balance and transaction history
- **Stripe deposits** - Add funds via credit card
- **Auto top-up** - Configure automatic balance refresh
- **Crypto payments** - x402 USDC payments on Base network

### Security

- **Encrypted storage** - Tokens stored in OS keychain
- **Secure IPC** - Tauri's secure inter-process communication
- **HTTPS only** - All API calls over TLS

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (1.75+)
- [Node.js](https://nodejs.org/) (20+)
- [pnpm](https://pnpm.io/) (9+)

### Development

```bash
# Clone the repository
git clone https://github.com/serenorg/seren-desktop.git
cd seren-desktop

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev
```

### Testing

```bash
# Unit tests (Vitest)
pnpm test

# Type checking
pnpm exec tsc --noEmit

# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

### Build

```bash
# Build for production
pnpm tauri build
```

Builds are available for:

- **macOS** - `.dmg` (Apple Silicon & Intel)
- **Windows** - `.msi` / `.exe`
- **Linux** - `.deb` / `.AppImage`

## Architecture

Seren Desktop is the **open source client**. It connects to Seren's proprietary Gateway API for:

- **Authentication & Billing** - SerenBucks payment system
- **AI Model Access** - Claude, GPT, Gemini, and other models
- **Publisher Marketplace** - Firecrawl, Perplexity, databases
- **MCP Server Hosting** - Email, calendar, CRM actions
- **SerenDB** - Serverless PostgreSQL databases

Think of it like VS Code (open source) connecting to the Extension Marketplace (proprietary).

```text
┌─────────────────────────────────────────────────────┐
│           Seren Desktop (Open Source)                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │  AI Chat    │  │   Editor    │  │  Database   │  │
│  │  Multi-tab  │  │   Monaco    │  │   Panel     │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │    MCP      │  │   Wallet    │  │  Catalog    │  │
│  │   Tools     │  │  Payments   │  │  Browser    │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │
│                                                      │
│  Backend: Rust/Tauri  │  Frontend: SolidJS/TS       │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│           Seren Gateway (Proprietary)                │
│  • api.serendb.com                                   │
│  • Authentication & billing (SerenBucks)            │
│  • AI model routing (Claude, GPT, Gemini)           │
│  • Publisher ecosystem (50+ services)               │
│  • MCP server hosting                               │
│  • SerenDB serverless PostgreSQL                    │
└─────────────────────────────────────────────────────┘
```

## Project Structure

```text
seren-desktop/
├── src/                    # SolidJS frontend
│   ├── components/
│   │   ├── auth/          # SignIn
│   │   ├── chat/          # ChatPanel, ChatTabBar, ModelSelector
│   │   ├── editor/        # MonacoEditor, FileTabs, MarkdownPreview
│   │   ├── sidebar/       # FileTree, DatabasePanel, CatalogPanel
│   │   ├── mcp/           # McpToolsPanel, McpToolCallApproval
│   │   ├── wallet/        # DepositModal, TransactionHistory
│   │   ├── settings/      # ProviderSettings, McpServersPanel
│   │   └── common/        # Header, Sidebar, StatusBar
│   ├── services/          # API clients
│   ├── stores/            # SolidJS reactive stores
│   └── lib/               # Utilities
├── src-tauri/             # Rust backend
│   ├── src/
│   │   ├── commands/      # Tauri IPC handlers
│   │   ├── services/      # Database, file watching
│   │   ├── mcp/           # MCP protocol client
│   │   └── wallet/        # x402 crypto signing
│   └── Cargo.toml
└── tests/                 # E2E tests
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | SolidJS 1.8+, TypeScript 5+, Vite |
| Backend | Rust, Tauri 2.0 |
| Editor | Monaco Editor 0.52+ |
| Database | SQLite (local chat history) |
| State | SolidJS stores |
| Styling | Plain CSS |
| Storage | tauri-plugin-store (encrypted) |
| Crypto | alloy-rs (Ethereum signing) |

## Configuration

### Environment Variables

Create `.env.local` for local development:

```env
VITE_SEREN_API_URL=https://api.serendb.com
```

### Provider API Keys

You can use Seren's gateway (default) or configure direct API access:

1. Open **Settings** (gear icon)
2. Navigate to **Providers**
3. Enter API keys for Anthropic, OpenAI, or Google

## Contributing

We welcome contributions! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

### Development Workflow

1. Fork the repository
2. Create a feature branch in a worktree:

   ```bash
   git worktree add ../.worktrees/feature-name -b feature/feature-name
   ```

3. Make changes and test: `pnpm test`
4. Commit with conventional commits: `git commit -m "feat: add feature"`
5. Push and open a PR

### Good First Issues

Look for issues labeled [`good first issue`](https://github.com/serenorg/seren-desktop/labels/good%20first%20issue).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Development Setup](docs/DEVELOPMENT.md)
- [Security Policy](SECURITY.md)
- [API Reference](docs/API.md)

## License

MIT License - see [LICENSE](LICENSE)

## Links

- [Seren Website](https://serendb.com)
- [Seren Documentation](https://docs.serendb.com)
- [Discord Community](https://discord.gg/seren)
- [GitHub Issues](https://github.com/serenorg/seren-desktop/issues)
