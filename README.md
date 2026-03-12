# Seren Desktop

Seren is an AI workspace for knowledge workers. Install skills, connect your accounts, and let agents handle repeatable work while you stay in control.

[![CI](https://github.com/serenorg/seren-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/serenorg/seren-desktop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Download

Get the latest release for your platform from the [Releases page](https://github.com/serenorg/seren-desktop/releases):

- **macOS** — `.dmg` (Apple Silicon & Intel)
- **Windows** — `.msi` / `.exe`
- **Linux** — `.deb` / `.AppImage`

Updates install automatically from within the app.

---

## Who it's for

Seren is built for people who spend their day making decisions, not stitching together five different tools.

- **Traders and investors** — run automated strategies, monitor markets, and move faster on research
- **Analysts, operators, and finance teams** — automate reporting, reconciliation, intake, and back-office workflows
- **Job seekers and independent professionals** — automate a full pipeline: company discovery, contact research, personalized outreach, and application tracking
- **Finance and tax filers** — process bank statements, reconcile transactions, and prepare crypto and traditional tax filings
- **Knowledge workers** — keep chat, files, notes, automations, and approvals in one place

---

## What you can do

### Install AI skills for real workflows

Install a skill and let an AI agent handle the work — 24/7, within the limits you set. Agents connect to your accounts, execute your strategy, and report back. You stay in control.

Under the hood, skills can call hosted publishers and services on demand, so the same workspace can mix trading actions, research tools, notes, databases, and scheduled automations.

- **For traders and investors** — Crypto grid trading and smart DCA on Coinbase or Kraken, stock strategies through Alpaca, delta-neutral hedged shorts, DeFi yield workflows, and Polymarket prediction market automation
- **For job seekers** — Full-pipeline job search automation: pull your resume and LinkedIn, discover 50 target companies via AlphaGrowth, research the top 20 with Perplexity and Exa, surface 100 hiring manager contacts via Apollo, generate personalized outreach, and automate parts of the application flow when the required integrations are available.
- **For finance and tax filers** — Wells Fargo statement processing with LLM-assisted transaction categorization, crypto tax reconciliation (CARF / Form 8949), recurring transaction tracking, and cash flow reporting
- **For borrowers and deal-makers** — Loan qualification, commercial mortgage introductions, institutional deal workflows, and grant intake
- **For research and business work** — Apollo prospecting, browser automation, AI governance assessments, and other publisher-backed tasks
- **Built into Seren Desktop** — Browse and launch all of these workflows from the built-in skill catalog

Browse the full catalog at [serendb.com/skills](https://serendb.com/skills) or [github.com/serenorg/seren-skills](https://github.com/serenorg/seren-skills).

### Research faster with top AI models

Ask questions, get analysis, draft notes, briefs, and reports, or talk through a strategy — using Claude, GPT, or Gemini from a single app. Seren picks the right model for your question, or you choose.

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

- **Exchanges, brokerages, and banks** — Coinbase, Kraken, Alpaca, Wells Fargo, and more
- **Seren services** — SerenCloud for cloud agent hosting, SerenNotes for hosted notes and optional memory sync, SerenCron for scheduled jobs, SerenEmbed for vector embeddings, SerenCouncil for multi-model consensus, SerenWhisper for speech-to-text, and SerenSwarm for multi-agent coordination
- **External tools and data sources** — Apollo, Perplexity, Exa, AlphaGrowth, Firecrawl, broker/data integrations, and other specialist capabilities
- **Browser automation** — Playwright-based automation for web workflows that need form filling, scraping, or step-by-step interaction
- **Messaging and alerts** — Slack, Discord, Telegram, or Signal for notifications and operator workflows
- **Catalog + MCP tools** — Browse and activate from the built-in catalog with one click

### Work with files in the same app

Open the files you are already using without leaving the app. Ask AI to summarize, explain, or extract what matters from any open file.

- Open PDFs, images, markdown, text, and code side by side
- AI-assisted editing — highlight text and ask AI to rewrite, summarize, or improve it
- Save useful outputs to notes and reusable memory

### Launch agents into the cloud

Seren is designed to launch agents that keep working when your laptop is closed. Run a skill as a hosted workflow, or create a custom agent from a prompt and let Seren handle the cloud runtime.

- Turn a trading skill into an always-on bot that can place trades or notify you when a signal appears
- Launch scheduled or long-running agents for monitoring, reporting, intake, and follow-up workflows
- Create prompt-based custom agents for market briefs, research monitors, ops routing, and other repeatable tasks
- Track task status and outputs from Seren Desktop while the work runs in Seren Cloud

### Security and control

- All credentials stored with OS-level encryption — never in plain text
- All connections made over HTTPS
- Agents operate within the limits and permissions you define — no surprises
- Option to connect directly to AI providers using your own API keys

### Pay as you go

No subscription required. Use SerenBucks credits to pay only for what you use.

- Top up with a credit card or USDC crypto
- Set automatic top-ups so you never run dry mid-session

---

## How it works

Seren Desktop is the **open source workspace**. Around it are three product layers:

- **Desktop app** — your local workspace for chat, files, notes, approvals, and task tracking
- **Skills, publishers, and Seren Cloud** — installable workflows from the skills catalog plus hosted agents and services for trading, browser work, research, notes, and other tasks
- **Seren Gateway and SerenDB** — authentication, model routing, billing, wallet funding, optional memory sync, hosted notes, integrations, and the database layer behind persistent projects and structured workflows

Think of it as one workspace connected to a marketplace of skills, publishers, and cloud services.

In Seren, a publisher is a service or data source your agent can call when needed. That can mean a broker integration, a note store, a cron service, a consensus service, an embedding pipeline, or a database-backed workflow.

Most day-to-day workspace state stays local. Some features use Seren services when you sign in, sync memories, save notes, fund your wallet, or call hosted tools.

---

## Links

- [Seren Website](https://serendb.com)
- [Documentation](https://docs.serendb.com)
- [Skills Repository](https://github.com/serenorg/seren-skills)
- [Discord Community](https://discord.gg/seren)
