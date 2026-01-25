# Seren Desktop

A lightweight (~10MB) AI desktop client built with Tauri, SolidJS, and Monaco Editor.

[![CI](https://github.com/serenorg/seren-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/serenorg/seren-desktop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **AI Chat** - Claude and GPT models via Seren's API
- **Code Editor** - Monaco Editor with inline AI completion
- **Publisher Catalog** - Browse AI-accessible APIs and databases
- **MCP Actions** - Execute agent tasks (email, calendar, CRM)

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

### Build

```bash
# Build for production
pnpm tauri build
```

## Architecture

Seren Desktop is the **open source client**. It connects to Seren's proprietary Gateway API for:

- **Authentication & Billing** - SerenBucks payment system
- **AI Model Access** - Claude, GPT, and other models
- **Publisher Marketplace** - Firecrawl, Perplexity, databases
- **MCP Server Hosting** - Email, calendar, CRM actions

Think of it like VS Code (open source) connecting to the Extension Marketplace (proprietary).

```
┌─────────────────────────────────────┐
│     Seren Desktop (Open Source)     │
│  • Tauri + Rust backend             │
│  • SolidJS frontend                 │
│  • Monaco Editor                    │
│  • MCP client                       │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│    Seren Gateway (Proprietary)      │
│  • api.serendb.com                  │
│  • Authentication & billing         │
│  • AI model routing                 │
│  • Publisher ecosystem              │
│  • MCP server hosting               │
└─────────────────────────────────────┘
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Contributing

We welcome contributions! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

### Good First Issues

Look for issues labeled [`good first issue`](https://github.com/serenorg/seren-desktop/labels/good%20first%20issue).

### Development Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make changes and test: `pnpm test`
4. Commit with conventional commits: `git commit -m "feat: add feature"`
5. Push and open a PR

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Development Setup](docs/DEVELOPMENT.md)
- [Security Policy](SECURITY.md)
- [API Reference](docs/API.md)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | SolidJS, TypeScript, Vite |
| Backend | Rust, Tauri 2.0 |
| Editor | Monaco Editor |
| State | SolidJS stores |
| Storage | tauri-plugin-store (encrypted) |

## License

MIT License - see [LICENSE](LICENSE)

## Links

- [Seren Website](https://serendb.com)
- [Seren Documentation](https://docs.serendb.com)
- [Discord Community](https://discord.gg/seren)
- [GitHub Issues](https://github.com/serenorg/seren-desktop/issues)
