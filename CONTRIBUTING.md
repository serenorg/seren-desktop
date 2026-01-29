# Contributing to Seren Desktop

Thank you for your interest in contributing!

## Code of Conduct

Be respectful. We're all here to build something useful.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone git@github.com:YOUR_USERNAME/seren-desktop.git`
3. Create a worktree for your feature:

   ```bash
   git worktree add ../.worktrees/your-feature -b feature/your-feature
   cd ../.worktrees/your-feature
   ```

4. Make changes
5. Test: `pnpm test`
6. Lint: `pnpm check`
7. Commit: `git commit -m "feat: add your feature"`
8. Push: `git push origin feature/your-feature`
9. Open a Pull Request
10. Clean up: `git worktree remove ../.worktrees/your-feature`

## Development Setup

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Node.js (use nvm)
nvm install 20
nvm use 20

# Install pnpm
npm install -g pnpm

# Install Tauri CLI
cargo install tauri-cli

# Optional: Install faster linker (Linux only)
# Linux:
sudo apt install mold
```

### Running Locally

```bash
# Install dependencies
pnpm install

# Start development server
pnpm tauri dev

# Fast Rust type checking (no full build)
cargo check --manifest-path src-tauri/Cargo.toml
```

### Project Structure

```
seren-desktop/
├── src/                    # SolidJS frontend
│   ├── components/         # UI components
│   ├── services/           # API services
│   ├── stores/             # State management
│   └── lib/                # Utilities
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── commands/       # Tauri IPC commands
│   │   ├── services/       # Backend services
│   │   └── mcp/            # MCP client
│   └── Cargo.toml
├── docs/                   # Documentation
└── tests/                  # Tests
```

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation only
- `style:` Formatting (no code change)
- `refactor:` Code change that neither fixes nor adds
- `test:` Adding tests
- `chore:` Maintenance

Examples:

- `feat: add model selection dropdown`
- `fix: handle SSE connection timeout`
- `docs: update API authentication section`

## Pull Request Process

1. Update documentation if needed
2. Add tests for new features
3. Ensure `pnpm test` passes
4. Ensure `pnpm check` passes (Biome linting and formatting)
5. Request review from maintainers

## Security

**NEVER commit:**

- API keys or tokens
- Passwords
- Private keys
- User data

If you find a security issue, email security@serendb.com instead of opening an issue.

See [SECURITY.md](SECURITY.md) for full security policy.

## Testing

```bash
# Run unit tests
pnpm test

# Run e2e tests (headless)
pnpm test:e2e

# Run e2e tests with UI
pnpm test:e2e:ui

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Run with coverage
pnpm test --coverage
```

## Questions?

- Open a [Discussion](https://github.com/serenorg/seren-desktop/discussions)
- Join [Discord](https://discord.gg/seren)
