# Seren Desktop

Seren is an AI workspace for knowledge workers and engineers. Chat with top models, install skills, create reusable employees, and join open bounties. Connect your accounts and let agents handle repeatable work while you stay in control.

![Seren Desktop screenshot](https://github.com/user-attachments/assets/dd9858b7-363e-4fad-a0c0-460963917e4b)

[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/seren)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/serenorg/seren-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/serenorg/seren-desktop/actions/workflows/ci.yml)

---

## Download

Get the latest desktop build from the [Releases page](https://github.com/serenorg/seren-desktop/releases).

---

## Who it's for

Seren is built for people who spend their day making decisions, not stitching together five different tools.

- **Traders and investors** - run automated strategies, monitor markets, and move faster on research
- **Analysts, operators, and finance teams** - automate reporting, reconciliation, intake, and back-office workflows
- **Job seekers and independent professionals** - automate a full pipeline: company discovery, contact research, personalized outreach, and application tracking
- **Finance and tax filers** - process bank statements, reconcile transactions, and prepare crypto and traditional tax filings
- **Developers and engineers** - use Codex, Claude Code, Gemini, or Grok, open terminals, and work across project files

---

## What you can do

### Install skills for real workflows

Install a skill and let Seren handle the work, within the limits you set. Skills connect to your accounts, do the work, and report back. You stay in control.

Under the hood, skills can call hosted publishers and services on demand, so the same workspace can mix trading actions, research tools, notes, databases, and workflow automation.

- **For traders and investors** - Crypto grid trading and DCA on Coinbase or Kraken, stock strategies on Alpaca, delta-neutral hedges, DeFi yield, and Polymarket prediction markets
- **For job seekers** - Full-pipeline automation: company discovery via AlphaGrowth, research with Perplexity and Exa, contact lookup through Apollo, and personalized outreach
- **For finance and tax filers** - Wells Fargo statement processing, crypto tax reconciliation (CARF / Form 8949), recurring transaction tracking, and cash flow reports
- **For borrowers and deal-makers** - Loan qualification, commercial mortgage intros, institutional deal workflows, and grant intake
- **For research and business work** - Apollo prospecting, browser automation, AI governance assessments, and other publisher-backed tasks
- **Built into Seren Desktop** - Browse and launch all of these from the built-in skill catalog

Browse the full catalog at [serendb.com/skills](https://serendb.com/skills) or [github.com/serenorg/seren-skills](https://github.com/serenorg/seren-skills).

### Create employees

Define a cloud employee once - with its own identity, instructions, skills, and tools - then launch it from the sidebar whenever you need that role. Each employee keeps a consistent operating style and memory across sessions, so recurring roles stay recognizable instead of being rebuilt from scratch.

- Build custom employees for research, writing, operations, finance, support, security, or product work
- Import employee bundles with files like `SKILL.md`, `IDENTITY.md`, `SOUL.md`, and supporting resources
- Keep each employee's instructions and tools together so demos, handoffs, and recurring workflows are easy to reproduce
- Give skills automatic organization- or user-scoped database storage without configuring physical database credentials
- Add third-party credentials through scoped connector and Passwords flows without copying a personal Seren API key into an employee script
- Run employees in Seren Cloud for longer-running work that should continue outside the desktop app

### Join bounties

Browse open bounties from the sidebar, review the reward pool and tiers, and join with one click. Seren creates a thread with the matching skill attached and the bounty command pre-filled - review, edit, and submit when you're ready. Earnings accrue as your work meets the bounty's verification criteria.

- Browse active bounties with reward pools, customer details, and recent activity
- Start a bounty thread with the matching skill attached and the starter command pre-filled
- Bounty threads inherit your current chat or agent provider, so they fit into how you already work
- Keep bounty conversations alongside the rest of your projects, employees, and skills

### Work with native agents

Use Codex, Claude Code, Gemini, or Grok directly inside Seren and switch providers mid-task without losing the conversation. Open a project, drop files into a thread, edit them in the built-in editor, and review diffs before they land.

- Use Codex, Claude Code, Gemini, or Grok in the same workspace
- Run terminal-based Codex or Claude Code for a CLI-feel session inside the app
- Open a plain terminal alongside your threads for shell work and one-off commands
- Edit files in the built-in editor while a thread is running
- Switch the provider on any thread in place - keep the conversation, change the model

### Research faster with top AI models

Ask questions, get analysis, draft notes, briefs, and reports, or talk through a strategy - using Claude, GPT, or Gemini from a single app. Seren picks the right model for your question, or you choose.

- Let Seren route to the right model, or choose one yourself
- Work on multiple conversations simultaneously in separate tabs
- Conversation history saved locally on your machine
- Attach images or use voice input

### Keep context from one session to the next

Seren keeps track of important context across sessions so you don't have to re-explain your situation each time.

- Recalls relevant notes, past conversations, and project context automatically
- Organized by project so memories stay focused
- Optional memory sync when you want the same context on multiple devices

### Connect your accounts and tools

Link Seren to the services and platforms your agents need to operate.

- **Exchanges, brokerages, and banks** - Coinbase, Kraken, Alpaca, Wells Fargo, and more
- **Seren services**
  - Seren Cloud - hosted employee runtime
  - Seren Bounty - open bounty marketplace
  - Seren Skills - skill catalog
  - Seren Models - top public models, including frontier and open
  - Seren Private Models - private model inference in a secure environment
  - Seren DB - managed Postgres
  - Seren Notes - hosted notes and optional memory sync
  - Seren Cron - scheduled jobs
  - Seren Embed - vector embeddings
  - Seren Council - multi-model consensus
  - Seren Whisper - speech-to-text
- **External tools and data sources** - Apollo, Perplexity, Exa, AlphaGrowth, Firecrawl, broker/data integrations, and other specialist capabilities
- **Browser automation** - Playwright-based automation for web workflows that need form filling, scraping, or step-by-step interaction
- **Messaging and alerts** - Slack, Discord, Telegram, or Signal for notifications and operator workflows
- **Catalog + MCP tools** - Browse and activate from the built-in catalog with one click

### Work with files in the same app

Open the files you are already using without leaving the app. Ask AI to summarize, explain, or extract what matters from any open file.

- Open PDFs, images, markdown, text, and code side by side
- AI-assisted editing - highlight text and ask AI to rewrite, summarize, or improve it
- Save useful outputs to notes and reusable memory

### Launch agents into the cloud

Run any skill, employee, or custom prompt as a hosted workflow that keeps working when your laptop is closed. Status and outputs stream back to Seren Desktop while the work runs in the cloud.

- Always-on trading bots, scheduled monitors, intake pipelines, and other long-running workflows
- Custom agents from a prompt for market briefs, research, or recurring ops tasks
- Track status, cost, and outputs from the desktop while work runs in the cloud

### Security and control

- All credentials stored with OS-level encryption - never in plain text
- All connections made over HTTPS
- Agents operate within the limits and permissions you define - no surprises
- Option to connect directly to AI providers using your own API keys

### Pay as you go

No subscription required. Use SerenBucks credits to pay only for what you use.

- Top up with a credit card or USDC crypto
- Set automatic top-ups so you never run dry mid-session

---

## How it works

Seren Desktop is the **open source workspace**. Around it are three product layers:

- **Desktop app** - your local workspace for chat, files, notes, approvals, and task tracking
- **Skills, publishers, and hosted runtime** - installable workflows from the catalog, hosted agents that can keep running in the background, and the publishers (services and data sources) that back them
- **Gateway and data services** - authentication, model routing, billing, hosted notes with optional memory sync, and the database layer behind persistent projects

A **publisher** is anything a skill can call when it needs to do something - a broker integration, a note store, a cron service, an embedding pipeline, or a database-backed workflow. Most day-to-day workspace state stays local; Seren services are only involved when you sign in, save notes, sync memories, fund your wallet, or call a hosted tool.

---

## Development

The runtime console is quiet by default so errors and warnings stay easy to find. To inspect normal success-path breadcrumbs during a deep lifecycle investigation, enable verbose runtime console logging in DevTools:

```js
localStorage.setItem("seren.debug.verboseConsole", "true");
```

Set the value to `"false"` or remove the key to return to the default error-focused console.

---

## Links

- [Seren Website](https://serendb.com)
- [Documentation](https://docs.serendb.com)
- [Skills Repository](https://github.com/serenorg/seren-skills)
- [Discord Community](https://discord.gg/seren)
