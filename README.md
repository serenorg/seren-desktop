# Seren Desktop

An open source AI desktop client built with Tauri, SolidJS, and Monaco Editor. Chat with AI models, run coding agents, manage databases, and connect to messaging platforms — all from one app.

[![CI](https://github.com/serenorg/seren-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/serenorg/seren-desktop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **🐛 Report bugs and request features:** [serenorg/seren-desktop-issues](https://github.com/serenorg/seren-desktop-issues/issues)

## Features

### AI Chat

- **Multi-model support** — Claude, GPT-4, Gemini via Seren Gateway or direct API keys
- **Smart model routing** — Satisfaction-driven model selection using Thompson sampling
- **Auto-reroute on failure** — Falls back to satisfaction-ranked model on 408/timeout errors
- **Task classification** — Routes prompts to the optimal worker (chat, agent, or publisher)
- **Free tier included** — Start chatting with Gemini 2.0 Flash (Free), no payment required
- **Multi-tab conversations** — Work on multiple chats simultaneously
- **Streaming responses** — Real-time token-by-token output
- **Thinking display** — Toggle chain-of-thought reasoning visibility
- **Query cost tracking** — Shows Gateway cost alongside response duration
- **Image attachments** — Attach images to chat messages
- **Voice input** — Speech-to-text via Seren Whisper publisher with auto-submit option
- **Slash commands** — `/` command autocomplete with `/login`, `/clear`, `/new`, `/copy`
- **Satisfaction signals** — Thumbs up/down feedback that trains the model router
- **Semantic code context** — AI retrieves relevant code from your indexed codebase
- **Smart balance warnings** — Prompts to top up or switch to free model when low on credits
- **Conversation persistence** — Chat history saved locally

### AI Coding Agents (ACP)

- **Multi-agent support** — Run Claude Code and Codex agents side by side
- **Multiple concurrent sessions** — Tabbed interface with agent type picker
- **Inline diff review** — Monaco diff editor with accept/reject for file edits
- **Tool execution** — Agents read files, execute commands, and make edits
- **Permission system** — User approval for sensitive operations with risk levels
- **Sandbox modes** — ReadOnly, WorkspaceWrite, or FullAccess execution tiers
- **GPG signing support** — Sandbox allows gpg-agent access for signed commits
- **Cancel with cleanup** — Force-stop agents, clear tool spinners, flush queued messages
- **Auth error detection** — Auto-launches `claude login` when authentication is needed
- **Thinking animation** — Bouncing dot indicator with rotating status words

### OpenClaw Messaging

- **Multi-platform agents** — Connect AI to Discord, Slack, Telegram, and more
- **Per-channel trust levels** — Auto-respond, mention-only, or approval-required
- **Agent mode per channel** — Choose which AI model handles each channel
- **Message approval workflow** — Review and approve agent responses before sending
- **Channel connection wizard** — Guided setup for new messaging channels
- **Process lifecycle management** — Start, stop, restart with crash recovery

### Code Editor

- **Monaco Editor** — Full VS Code editing experience
- **Syntax highlighting** — 100+ languages supported
- **Multi-file tabs** — Open and edit multiple files
- **Cmd+K inline editing** — AI-powered code modification with streaming diff preview
- **Context menu actions** — Right-click to add code to chat, explain, or improve
- **Markdown preview** — Live preview for `.md` files
- **Image viewer** — View images inline
- **PDF viewer** — Read PDF documents

### Semantic Codebase Indexing

- **AI-powered embeddings** — Index your entire codebase with SerenEmbed
- **Instant vector search** — Local sqlite-vec storage for zero-latency retrieval
- **Automatic context injection** — AI gets relevant code context during conversations
- **Language-aware chunking** — Smart code splitting for Rust, TypeScript/JavaScript, Python
- **File watcher integration** — Automatic re-indexing on save
- **Hash-based change detection** — Only re-index modified files

### File Explorer

- **Tree navigation** — Browse local directories
- **File operations** — Create, rename, delete files and folders
- **Context menu** — Right-click actions
- **Dotfile support** — Show/hide hidden files

### Database Panel (SerenDB)

- **Project management** — Create and delete SerenDB projects
- **Branch navigation** — Browse project branches
- **Connection strings** — Copy database connection strings
- **Organization support** — Multi-org project creation

### MCP Integration (Model Context Protocol)

- **90+ built-in tools** — Gateway MCP via mcp.serendb.com
- **Tool execution** — Run tools with approval workflow
- **Resource browsing** — Access MCP server resources
- **Multi-server support** — Connect to multiple MCP servers
- **OAuth flows** — MCP server and publisher OAuth authentication
- **x402 payments** — Automatic micropayments for premium tools

### Publisher Catalog

- **Browse APIs** — Discover AI-accessible services
- **Publisher details** — View pricing, capabilities, usage
- **Quick connect** — One-click publisher activation with OAuth
- **Connection status** — Visual indicators for authenticated publishers

### Wallet & Payments

- **SerenBucks** — View balance and transaction history
- **Daily claim** — Free daily SerenBucks credits
- **Stripe deposits** — Add funds via credit card
- **Auto top-up** — Configure automatic balance refresh
- **Crypto payments** — x402 USDC payments on Base network

### Auto-Updater

- **In-app updates** — Check for and install updates without leaving the app
- **Download progress** — Progress bar with quips during update download
- **Cross-platform** — Signed updates for macOS, Windows, and Linux

### Security

- **Encrypted storage** — Tokens stored via Tauri secure storage
- **Sandboxed execution** — macOS seatbelt profiles for agent commands
- **Targeted deny lists** — Private keys blocked, GPG agent access preserved
- **Secure IPC** — Tauri's secure inter-process communication
- **HTTPS only** — All API calls over TLS

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

# Lint and format (Biome)
pnpm check

# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

### Build

```bash
# Build for production
pnpm tauri build
```

Builds are available for:

- **macOS** — `.dmg` (Apple Silicon & Intel)
- **Windows** — `.msi` / `.exe`
- **Linux** — `.deb` / `.AppImage`

## Architecture

Seren Desktop is the **open source client**. It connects to Seren's proprietary Gateway API for:

- **Authentication & Billing** — SerenBucks payment system
- **AI Model Access** — Claude, GPT, Gemini, and other models
- **Publisher Marketplace** — Firecrawl, Perplexity, databases
- **MCP Server Hosting** — Email, calendar, CRM actions
- **SerenDB** — Serverless PostgreSQL databases

Think of it like VS Code (open source) connecting to the Extension Marketplace (proprietary).

```text
┌──────────────────────────────────────────────────────────┐
│             Seren Desktop (Open Source)                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ AI Chat  │  │  Editor  │  │ Database │  │ OpenClaw │ │
│  │ + Voice  │  │  Monaco  │  │  SerenDB │  │ Discord  │ │
│  │ + Images │  │  + Cmd+K │  │          │  │ Slack    │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │   ACP    │  │   MCP    │  │  Wallet  │  │ Catalog  │ │
│  │ Claude   │  │ 90+ Tools│  │ Payments │  │ Browser  │ │
│  │ Codex    │  │ + OAuth  │  │ + Crypto │  │          │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │Orchestr. │  │ Indexing │  │ Sandbox  │               │
│  │ Router   │  │sqlite-vec│  │ Terminal │               │
│  │ Classify │  │          │  │          │               │
│  └──────────┘  └──────────┘  └──────────┘               │
│                                                          │
│  Backend: Rust/Tauri  │  Frontend: SolidJS/TypeScript    │
│  Embedded: Node.js + Git (bundled per platform)          │
└─────────────────────────┬────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│             Seren Gateway (Proprietary)                   │
│  • api.serendb.com                                       │
│  • Authentication & billing (SerenBucks)                 │
│  • AI model routing (Claude, GPT, Gemini)                │
│  • Publisher ecosystem (50+ services)                    │
│  • MCP server hosting                                    │
│  • SerenDB serverless PostgreSQL                         │
│  • SerenEmbed API (embeddings)                           │
│  • SerenWhisper API (speech-to-text)                     │
└──────────────────────────────────────────────────────────┘
```

## Project Structure

```text
seren-desktop/
├── src/                      # SolidJS frontend
│   ├── components/
│   │   ├── acp/             # Permission dialog, diff proposals
│   │   ├── auth/            # SignIn
│   │   ├── catalog/         # Publisher catalog, connection status
│   │   ├── chat/            # Chat, agents, voice input, thinking display
│   │   ├── common/          # Header, sidebar, status bar, about dialog
│   │   ├── editor/          # Monaco, file tabs, inline edit, viewers
│   │   ├── mcp/             # MCP tools, resources, OAuth, x402 approval
│   │   ├── settings/        # Providers, MCP servers, OpenClaw config
│   │   ├── sidebar/         # File explorer, database panel, indexing
│   │   └── wallet/          # Deposits, transactions, daily claim
│   ├── services/            # API clients (chat, ACP, MCP, wallet, OAuth, ...)
│   ├── stores/              # SolidJS stores (state management)
│   └── lib/                 # Utilities (indexing, audio, commands, rendering)
├── src-tauri/               # Rust backend
│   ├── src/
│   │   ├── acp.rs           # Agent Client Protocol
│   │   ├── orchestrator/    # Task classifier, model router, workers
│   │   ├── openclaw.rs      # OpenClaw messaging integration
│   │   ├── terminal.rs      # Terminal process management
│   │   ├── sandbox.rs       # macOS sandbox profiles (GPG-aware)
│   │   ├── mcp.rs           # MCP server management
│   │   ├── embedded_runtime.rs  # Bundled Node.js/Git runtime
│   │   ├── oauth.rs         # OAuth callback server
│   │   ├── commands/        # Tauri commands (chat, indexing, web)
│   │   ├── services/        # Vector store, chunker, indexer
│   │   └── wallet/          # x402 payments, Ethereum signing
│   └── embedded-runtime/    # Bundled runtimes and OpenClaw
├── tests/                   # E2E tests (Playwright)
├── build/                   # Platform-specific build scripts
└── .github/workflows/       # CI and release automation
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | SolidJS 1.8+, TypeScript 5+, Vite |
| Backend | Rust, Tauri 2.0 |
| Editor | Monaco Editor 0.52+ |
| Vector Store | sqlite-vec (semantic search) |
| State | SolidJS stores |
| Styling | Plain CSS |
| Storage | tauri-plugin-store (encrypted) |
| Crypto | alloy-rs (Ethereum signing) |
| ACP | agent-client-protocol |
| Linting | Biome 2.3+ |
| Testing | Vitest (unit), Playwright (e2e) |

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

### Bug Reports & Feature Requests

Report bugs and request features in our public issue tracker: **[seren-desktop-issues](https://github.com/serenorg/seren-desktop-issues/issues)**

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

Look for issues labeled [`good first issue`](https://github.com/serenorg/seren-desktop-issues/labels/good%20first%20issue) in the issues repo.

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
