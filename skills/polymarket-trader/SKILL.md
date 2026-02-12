---
name: polymarket-trader
description: Autonomous prediction market trading agent. Scans Polymarket, estimates fair value with Claude, finds mispricing, and executes trades using Kelly criterion. Use when the user wants to trade on Polymarket or set up autonomous trading.
tags: [trading, polymarket, prediction-markets, autonomous, seren-ecosystem]
version: 1.0.0
---

# Polymarket Trading Skill

Autonomous trading agent for prediction markets. This skill showcases the full Seren ecosystem by integrating:
- **Seren-cron** for autonomous scheduling
- **Seren MCP publishers** (polymarket-data, perplexity, seren-models)
- **SerenBucks** for API payments
- **Seren Desktop** secure credential storage

## When to Use This Skill

Activate this skill when the user mentions:
- "trade on Polymarket"
- "set up polymarket trading"
- "start prediction market trading"
- "check my polymarket positions"
- "autonomous trading"

## Overview

This skill helps users set up and manage an autonomous trading agent that:
1. **Scans** Polymarket for active prediction markets
2. **Researches** opportunities using Perplexity
3. **Estimates** fair value with Claude (seren-models)
4. **Identifies** mispriced markets (edge > threshold)
5. **Executes** trades using Kelly Criterion for position sizing
6. **Runs autonomously** on seren-cron schedule
7. **Monitors** positions and reports P&L

## Setup Workflow

### Phase 1: Credential Check & Setup

First, check if Polymarket credentials are configured:

```typescript
const creds = await invoke('get_polymarket_credentials');
```

If missing, guide the user through obtaining credentials:

```
You'll need Polymarket API credentials to trade. Here's how to get them:

1. Visit https://polymarket.com
2. Connect your wallet
3. Navigate to Settings > API Keys
4. Click "Derive API Key"
5. Save your credentials securely

Once you have them, I can store them securely in Seren Desktop.

Please provide:
• API Key: [wait for input]
• API Secret: [wait for input]
• Passphrase: [wait for input]
• Wallet Address: [wait for input]
```

Then store credentials securely:

```typescript
await invoke('store_polymarket_credentials', {
  apiKey: user_input.apiKey,
  apiSecret: user_input.apiSecret,
  passphrase: user_input.passphrase,
  address: user_input.address
});
```

**Alternative:** Users can also configure credentials via Settings > Wallet > Polymarket Trading.

### Phase 2: Balance Check & Funding

Check both required balances:

1. **SerenBucks balance** (for API calls):
```typescript
const balance = await fetch('/api/wallet/balance');
```

2. **Polymarket balance** (for trades):
```python
# Via Python agent using Polymarket API
balance = get_polymarket_balance(api_key, api_secret)
```

Display current state:
```
Current balances:
  • SerenBucks: $X.XX (for API calls - Claude, Perplexity, data)
  • Polymarket: $Y.YY USDC (for placing trades)

Estimated costs:
  • ~$0.50-2.00 in SerenBucks per scan cycle (varies with market count)
  • Your configured bankroll for trades
```

If insufficient, guide through funding:

**For SerenBucks:**
```
Your SerenBucks balance is low. You can deposit at:
https://app.serendb.com/wallet/deposit

The agent will cost approximately $0.50-2.00 per scan cycle depending on:
- Number of markets scanned
- Research depth (Perplexity calls)
- Fair value estimates (Claude calls)
```

**For Polymarket:**
```
To fund your Polymarket wallet:
1. Bridge USDC to Polygon PoS
2. Send USDC to your Polymarket address: {address}
3. Wait for confirmation (usually < 1 minute)

You can check your balance at: https://polymarket.com/wallet
```

### Phase 3: Risk Parameter Configuration

Walk the user through EACH parameter with clear explanations:

#### 1. Bankroll
```
BANKROLL - Total capital available for trading

This is the maximum amount the agent can have deployed across all positions.

Recommendations:
  • Testing: $50-100 (learn the system with minimal risk)
  • Serious trading: $500+ (enough for diversification)
  • Always only risk what you can afford to lose

Your bankroll: $___
```

**Validate:** Must be > $10

#### 2. Mispricing Threshold
```
MISPRICING THRESHOLD - Minimum edge required to trade

Only trade when estimated fair value differs from market price by at least this percentage.
Higher threshold = fewer but higher-quality opportunities.

Examples:
  • 5%: Aggressive (more trades, smaller edges)
  • 8%: Balanced (recommended)
  • 12%: Conservative (fewer trades, larger edges)

Your threshold: ___% (default: 8%)
```

**Validate:** Range 5-15%

#### 3. Max Kelly Fraction
```
MAX KELLY FRACTION - Maximum % of bankroll per trade

Controls position sizing using the Kelly Criterion. The agent uses quarter-Kelly
(conservative) but this caps the maximum position size.

Examples:
  • 3%: Very conservative (max $3 per trade on $100 bankroll)
  • 6%: Balanced (recommended)
  • 10%: Aggressive (larger positions, higher variance)

Your max fraction: ___% (default: 6%)
```

**Validate:** Range 3-10%

#### 4. Scan Interval
```
SCAN INTERVAL - How often to scan for opportunities

More frequent scanning finds opportunities faster but costs more in API calls.

Options:
  • 5 minutes: High frequency (higher costs, ~$5-10/day)
  • 10 minutes: Balanced (recommended, ~$2-5/day)
  • 15 minutes: Moderate (~$1-3/day)
  • 30 minutes: Conservative (~$0.50-1.50/day)

Your interval: ___ minutes (default: 10)
```

**Validate:** Options: 5, 10, 15, 30 minutes

#### 5. Max Positions
```
MAX POSITIONS - Maximum concurrent open positions

Limits exposure and encourages diversification.

Recommendations:
  • Small bankroll (<$100): 5-10 positions
  • Medium bankroll ($100-500): 10-20 positions
  • Large bankroll (>$500): 20-50 positions

Your max positions: ___ (default: 10)
```

**Validate:** Range 1-50

#### 6. Stop Loss Bankroll
```
STOP LOSS - Stop trading if bankroll drops to this amount

Protective circuit breaker to prevent total loss.

Recommendations:
  • $0 - Stop only if completely depleted
  • 50% of initial bankroll - Stop if down 50%
  • 25% of initial bankroll - Stop if down 75%

Your stop loss: $___ (default: $0)
```

**Validate:** Must be >= 0 and < bankroll

#### Save Configuration

Create `config.json` in the skill directory:

```json
{
  "bankroll": 100.0,
  "mispricing_threshold": 0.08,
  "max_kelly_fraction": 0.06,
  "scan_interval_minutes": 10,
  "max_positions": 10,
  "stop_loss_bankroll": 0.0,
  "created_at": "2026-02-12T14:30:00Z",
  "last_updated": "2026-02-12T14:30:00Z"
}
```

### Phase 4: Dependency Check & Installation

Check for Python and required packages:

```bash
# Check Python version (need 3.9+)
python3 --version

# Check if dependencies installed
python3 -c "import seren_agent; import requests; print('✓ Dependencies ready')"
```

If missing, auto-install:

```bash
# Install from requirements.txt
pip3 install -r skills/polymarket-trader/requirements.txt

# Verify installation
python3 -c "import seren_agent; import requests; print('✓ Installation successful')"
```

Show progress to user:
```
Installing dependencies...
  ✓ seren_agent>=0.1.0
  ✓ requests>=2.31.0

Dependencies installed successfully!
```

### Phase 5: Dry-Run Test (Recommended)

Strongly recommend testing before live trading:

```
Setup complete! Before going live with real money, I recommend a dry-run test.

DRY-RUN MODE will:
  ✓ Scan real markets on Polymarket
  ✓ Research opportunities using Perplexity
  ✓ Estimate fair value with Claude
  ✓ Calculate position sizes using Kelly Criterion
  ✗ NOT place actual trades (simulation only)

This costs SerenBucks for API calls (~$0.50-2.00) but won't risk your trading capital.

Would you like to run a dry-run test first? (Recommended: Yes)
```

If user agrees, run dry-run:

```bash
cd skills/polymarket-trader
python3 agent.py --dry-run --config config.json
```

Show real-time output as it runs:
```
🔍 Scanning 500 active markets...
📊 Found 23 potential opportunities

🧠 Researching: "Will BTC hit $100k by March 2026?"
   Current market price: 54%

💡 Fair value estimate: 67% (confidence: medium)
   Edge: 13% (exceeds 8% threshold ✓)

💰 Position size: $3.24 (5.4% Kelly, capped at 6%)
   Side: BUY (fair value > market price)

[DRY-RUN] Would place BUY order:
  • Market: "Will BTC hit $100k by March 2026?"
  • Size: $3.24
  • Price: 54%
  • Expected value: +$0.42

... (continues for all opportunities) ...

Dry-run complete!

Results:
  • Markets scanned: 500
  • Opportunities found: 23
  • Would have placed: 8 trades
  • Total would-be capital deployed: $28.45
  • Largest position: $5.20
  • Estimated EV: +$3.67
  • API cost: $1.23 SerenBucks

The agent is working correctly. Ready to go live?
```

### Phase 6: Live Trading Confirmation

**CRITICAL - Must get explicit confirmation before enabling live trading**

Display warning and configuration summary:

```
⚠️  LIVE TRADING CONFIRMATION

You're about to enable LIVE TRADING with real money.

Configuration:
  • Bankroll: $100.00
  • Max per trade: 6% ($6.00)
  • Scan interval: Every 10 minutes
  • Stop loss: $0.00 (stop when depleted)
  • Max positions: 10

Estimated Costs:
  • SerenBucks: ~$2-5 per day (for API calls)
  • Trading capital: Up to $100.00 (your bankroll)

Risks:
  ⚠️  You can lose money - prediction markets are uncertain
  ⚠️  Only risk what you can afford to lose
  ⚠️  Past performance doesn't guarantee future results
  ⚠️  The agent makes autonomous decisions based on AI estimates
  ⚠️  Market conditions can change rapidly
  ⚠️  Slippage and fees may reduce returns

The agent will run automatically via seren-cron until you stop it.
You can monitor positions and P&L anytime with 'show status'.

Type exactly: START LIVE TRADING
(or 'cancel' to abort)
```

Wait for EXACT confirmation text. Do not proceed unless user types "START LIVE TRADING".

### Phase 7: Enable Autonomous Trading

Once confirmed, set up seren-cron job:

```typescript
// Call seren-cron publisher via MCP
const cronResult = await mcpPublisher.call('seren-cron', 'create_job', {
  name: 'polymarket-trader',
  schedule: `*/${config.scan_interval_minutes} * * * *`, // Cron expression
  command: `cd ${skillPath} && python3 agent.py --config config.json`,
  environment: {
    SEREN_API_KEY: await getApiKey(),
    POLYMARKET_API_KEY: creds.apiKey,
    POLYMARKET_API_SECRET: creds.apiSecret,
    POLYMARKET_PASSPHRASE: creds.passphrase,
    POLYMARKET_ADDRESS: creds.address
  }
});
```

Update config with cron job ID:

```json
{
  ...existing config...,
  "cron_job_id": cronResult.job_id,
  "enabled": true,
  "enabled_at": "2026-02-12T14:35:00Z"
}
```

Confirm to user:

```
✓ Live trading enabled successfully!

Status:
  ✓ Seren-cron job created (ID: {job_id})
  ✓ Next scan: in {scan_interval_minutes} minutes
  ✓ Logs: skills/polymarket-trader/logs/

The agent is now running autonomously. You can:
  • 'show status' - See current positions and P&L
  • 'show recent trades' - View trade history
  • 'pause trading' - Temporarily stop scanning (keeps positions)
  • 'resume trading' - Restart after pause
  • 'stop trading' - Disable completely
  • 'update config' - Modify risk parameters

I'll notify you of important events:
  • Significant wins/losses
  • Errors or API issues
  • Bankroll milestones
  • Stop loss triggered

Happy trading! 📊
```

## Control Commands

### Show Status

Command: `show status` or `status`

Display current state:

```typescript
// Read current positions
const positions = JSON.parse(await readFile('skills/polymarket-trader/logs/positions.json'));

// Read config
const config = JSON.parse(await readFile('skills/polymarket-trader/config.json'));

// Calculate current bankroll
const currentBankroll = calculateCurrentBankroll(positions, config);

// Get recent trades
const trades = await readLastNLines('skills/polymarket-trader/logs/trades.jsonl', 5);
```

Format output:

```
📊 Polymarket Trading Status

Agent: ACTIVE ✓
Next scan: in 3 minutes

Bankroll:
  • Initial: $100.00
  • Current: $103.45
  • P&L: +$3.45 (+3.45%)
  • Available: $78.30 (not deployed)

Positions: 4 / 10 max
  1. "Will BTC hit $100k by March?" - BUY $5.20 @ 54% → Now: 58% (+$0.84)
  2. "Will Fed cut rates in Q1?" - SELL $3.80 @ 32% → Now: 30% (+$0.76)
  3. "Will Trump win 2024?" - BUY $6.00 @ 45% → Now: 44% (-$0.60)
  4. "Will inflation exceed 3%?" - BUY $4.50 @ 61% → Now: 63% (+$0.90)

Recent Activity:
  • Last trade: 12 minutes ago (BUY $4.50)
  • Last scan: 3 minutes ago
  • Today's trades: 6
  • Today's P&L: +$2.34

Configuration:
  • Scan interval: 10 minutes
  • Max per trade: 6% ($6.00)
  • Mispricing threshold: 8%
```

### Show Recent Trades

Command: `show recent trades` or `show trades`

Read and format trades log:

```typescript
const trades = await readLastNLines('skills/polymarket-trader/logs/trades.jsonl', 20);
const parsedTrades = trades.map(line => JSON.parse(line));
```

Display:

```
📝 Recent Trades (Last 20)

1. 12 min ago - BUY $4.50 @ 61% "Will inflation exceed 3%?"
   Status: OPEN → Now: 63% (+$0.90 unrealized)

2. 2 hrs ago - SELL $3.80 @ 32% "Will Fed cut rates in Q1?"
   Status: OPEN → Now: 30% (+$0.76 unrealized)

3. 5 hrs ago - BUY $5.20 @ 54% "Will BTC hit $100k by March?"
   Status: OPEN → Now: 58% (+$0.84 unrealized)

4. 1 day ago - BUY $4.20 @ 48% "Will unemployment drop?"
   Status: CLOSED @ 52% → P&L: +$1.68 ✓

5. 1 day ago - SELL $3.50 @ 67% "Will gas prices rise?"
   Status: CLOSED @ 71% → P&L: -$1.40 ✗

... (continues) ...

Summary (Last 20 trades):
  • Wins: 12 (60%)
  • Losses: 8 (40%)
  • Total P&L: +$5.67
  • Avg win: +$1.23
  • Avg loss: -$0.87
```

### Pause Trading

Command: `pause trading` or `pause`

Pause the cron job without canceling it:

```typescript
await mcpPublisher.call('seren-cron', 'pause_job', {
  job_id: config.cron_job_id
});

// Update config
config.enabled = false;
config.paused_at = new Date().toISOString();
```

Confirm:

```
⏸️  Trading paused

The agent will stop scanning for new opportunities.
Your existing positions remain open.

To resume: 'resume trading'
To close all positions: 'stop trading' (requires confirmation)
```

### Resume Trading

Command: `resume trading` or `resume`

Resume the paused cron job:

```typescript
await mcpPublisher.call('seren-cron', 'resume_job', {
  job_id: config.cron_job_id
});

config.enabled = true;
config.resumed_at = new Date().toISOString();
```

Confirm:

```
▶️  Trading resumed

The agent will resume scanning for opportunities.
Next scan: in {scan_interval_minutes} minutes
```

### Stop Trading

Command: `stop trading` or `stop`

**Requires confirmation - this is a significant action**

First, ask for confirmation:

```
⚠️  Stop Trading Confirmation

This will:
  ✓ Cancel the seren-cron job (no more scans)
  ✓ Stop the autonomous trading agent
  ✗ Your open positions will remain on Polymarket

Current positions: 4 (total value: $21.50)

Options:
  1. Stop agent, keep positions (you manage them manually)
  2. Stop agent AND close all positions immediately
  3. Cancel (don't stop)

Your choice (1/2/3):
```

If option 1 (stop only):

```typescript
await mcpPublisher.call('seren-cron', 'delete_job', {
  job_id: config.cron_job_id
});

config.enabled = false;
config.stopped_at = new Date().toISOString();
```

If option 2 (stop + close positions):

```python
# Via Python agent
for position in open_positions:
    close_position(position.market_id, position.size)
```

Confirm:

```
🛑 Trading stopped

The autonomous agent is disabled.
Your positions: {kept open / closed}

To start trading again: 'I want to trade on Polymarket'
```

### Update Config

Command: `update config` or `change [parameter]`

Allow users to modify risk parameters:

```
Which parameter would you like to update?

1. Bankroll (current: $100.00)
2. Mispricing threshold (current: 8%)
3. Max Kelly fraction (current: 6%)
4. Scan interval (current: 10 minutes)
5. Max positions (current: 10)
6. Stop loss (current: $0.00)

Your choice (1-6):
```

Then walk through updating that specific parameter with the same guidance as in Phase 3.

Update config file and restart cron job if needed.

## Monitoring & Notifications

### Real-Time Chat Updates

During scan cycles (when user is active in chat), show progress:

```
🔍 Polymarket Scan Starting...

Scanning 500 active markets...
Found 23 potential opportunities

Researching top prospects:
  1. "Will BTC hit $100k by March 2026?"
     Market: 54% → Fair value: 67% → Edge: 13% ✓
     Position: BUY $3.24 (5.4% Kelly)
     ✅ Order placed

  2. "Will Fed cut rates in Q1 2026?"
     Market: 32% → Fair value: 28% → Edge: 4% ✗
     Skipped (edge below 8% threshold)

... (continues) ...

Scan complete!
  • Trades executed: 3
  • Capital deployed: $9.45
  • API cost: $1.12 SerenBucks
  • Next scan: in 10 minutes
```

### Log Files

All activity automatically written to log files:

**trades.jsonl** - One line per trade:

```json
{"timestamp": "2026-02-12T14:35:00Z", "market": "Will BTC hit $100k by March?", "market_id": "0x123...", "side": "BUY", "size": 3.24, "price": 0.54, "fair_value": 0.67, "edge": 0.13, "status": "open", "pnl": null}
{"timestamp": "2026-02-12T18:22:00Z", "market": "Will BTC hit $100k by March?", "market_id": "0x123...", "side": "BUY", "size": 3.24, "price": 0.54, "fair_value": 0.67, "edge": 0.13, "status": "closed", "pnl": 0.84}
```

**scan_results.jsonl** - One line per scan cycle:

```json
{"timestamp": "2026-02-12T14:35:00Z", "dry_run": false, "markets_scanned": 500, "opportunities_found": 23, "trades_executed": 3, "capital_deployed": 9.45, "api_cost": 1.12, "serenbucks_balance": 48.88, "polymarket_balance": 103.45}
```

**positions.json** - Current state (updated after each trade):

```json
{
  "positions": [
    {
      "market": "Will BTC hit $100k by March?",
      "market_id": "0x123...",
      "side": "BUY",
      "entry_price": 0.54,
      "current_price": 0.58,
      "size": 3.24,
      "unrealized_pnl": 0.84,
      "opened_at": "2026-02-12T14:35:00Z"
    }
  ],
  "total_value": 103.45,
  "unrealized_pnl": 3.45,
  "last_updated": "2026-02-12T18:00:00Z"
}
```

### Chat Notifications (Critical Events)

Send chat messages for important events:

#### Bankroll Depletion

```
⚠️ Polymarket Trader Alert - Bankroll Depleted

Your bankroll has dropped below the stop loss threshold:
  • Current bankroll: $2.15
  • Stop loss threshold: $0.00
  • Status: ❌ Trading paused automatically

Open positions: 3 (total exposure: $18.45)
Unrealized P&L: -$4.32

The agent has stopped scanning. To resume trading:
1. Deposit more funds to Polymarket
2. Update bankroll: 'update config'
3. Resume trading: 'resume trading'
```

#### API Errors

```
⚠️ Polymarket Trader Alert - API Error

Scan cycle failed:
  • Error: Polymarket API timeout (HTTP 504)
  • Time: 2:35 PM
  • Retry: Will retry in 10 minutes

If errors persist, check:
  • Polymarket API status: https://status.polymarket.com
  • Your network connectivity
  • API credentials: 'update polymarket credentials'

Current status: Agent still enabled, will retry automatically
```

#### Credential Issues

```
⚠️ Polymarket Trader Alert - Authentication Failed

Your Polymarket credentials appear to be invalid or expired:
  • Error: Invalid signature (HTTP 401)
  • Status: ❌ Trading paused

Please update your credentials:
  • Via Settings: Settings > Wallet > Polymarket Trading
  • Via chat: 'update polymarket credentials'

Once updated, resume with: 'resume trading'
```

#### Large Win

```
🎉 Polymarket Trader - Significant Win!

Position closed with profit:
  • Market: "Will BTC hit $100k by March?"
  • Outcome: YES (won)
  • Entry: $3.24 @ 54%
  • Exit: $6.00 (resolved)
  • Profit: +$2.76 (+85%)

Current status:
  • Session P&L: +$8.45
  • Bankroll: $108.45
  • Win rate: 65% (13/20 trades)

Keep it up! 📈
```

#### Large Loss

```
📊 Polymarket Trader - Position Closed

Significant loss on position:
  • Market: "Will Fed cut rates in Q1?"
  • Outcome: NO (lost)
  • Entry: $4.50 @ 68%
  • Exit: $0.00 (resolved against us)
  • Loss: -$4.50 (-100%)

Current status:
  • Session P&L: -$2.23
  • Bankroll: $97.77
  • Win rate: 58% (11/19 trades)

The agent continues scanning for opportunities.
```

## Error Handling & Recovery

### Graceful Degradation

The agent handles errors without crashing:

#### Low SerenBucks Balance

```
⚠️ Low SerenBucks Balance

Current balance: $0.75 (need ~$0.50-2.00 per scan)

The agent will continue scanning but may fail if balance runs out.
Please deposit SerenBucks: https://app.serendb.com/wallet/deposit
```

Agent continues until balance is completely depleted.

#### Low Polymarket Balance

```
⚠️ Low Polymarket Trading Balance

Current balance: $15.20
Configured bankroll: $100.00

The agent will only place trades up to your available balance.
Position sizes will be smaller than configured.

To restore full functionality, deposit USDC to: {address}
```

Agent trades with available funds, smaller positions.

#### API Rate Limits

```
⚠️ Polymarket API Rate Limit Hit

The agent has hit Polymarket's rate limit:
  • Limit: 100 requests/minute
  • Current usage: 105 requests/minute

Automatic response:
  ✓ Reducing scan frequency temporarily
  ✓ Will retry in 2 minutes
  ✓ Normal frequency resumes after 10 minutes

No action needed - this is handled automatically.
```

Agent backs off, reduces frequency temporarily.

#### Repeated Failures

```
⚠️ Polymarket Trader - Multiple Failures

The agent has encountered 3 consecutive scan failures:
  1. 2:30 PM - Polymarket API timeout
  2. 2:40 PM - Polymarket API timeout
  3. 2:50 PM - Polymarket API timeout

Status: ❌ Trading paused automatically (circuit breaker)

This usually indicates:
  • Polymarket API is down
  • Network connectivity issues
  • Rate limiting

Check Polymarket status: https://status.polymarket.com

The agent will not retry automatically. To resume:
1. Verify Polymarket API is working
2. Resume trading: 'resume trading'
```

After 3 consecutive failures, agent pauses automatically.

### Safety Guardrails

Built-in protections:

1. **Maximum Position Size Enforced**
   - No single trade can exceed `max_kelly_fraction` of bankroll
   - Prevents over-concentration

2. **Stop Loss Automatically Pauses**
   - When bankroll drops to `stop_loss_bankroll`, trading stops
   - Prevents total loss

3. **Sanity Checks on Fair Value**
   - Rejects estimates with "low" confidence
   - Requires confidence level of "medium" or "high"

4. **Rate Limiting on API Calls**
   - Tracks SerenBucks spend per cycle
   - Warns if costs exceed $5 per cycle

5. **Explicit Confirmation Required**
   - User must type "START LIVE TRADING" exactly
   - No accidental live trading

## Testing Checklist

Before considering the skill working, verify:

- [ ] Credential storage/retrieval works
- [ ] Balance checking (SerenBucks + Polymarket)
- [ ] Dry-run mode executes without placing trades
- [ ] Live trading requires exact confirmation text
- [ ] Seren-cron scheduling works
- [ ] Real-time chat updates display during scans
- [ ] Log files written correctly (trades.jsonl, scan_results.jsonl, positions.json)
- [ ] Error notifications trigger (low balance, API errors, etc.)
- [ ] Stop loss pauses trading when triggered
- [ ] All control commands work (status, pause, resume, stop)
- [ ] Config updates persist and restart cron if needed
- [ ] Positions tracked accurately with P&L

## Best Practices

### For Users

1. **Start small**: Test with $50-100 before scaling up
2. **Use dry-run first**: Always test before going live
3. **Monitor regularly**: Check 'show status' daily
4. **Adjust conservatively**: Increase bankroll gradually based on results
5. **Understand the risks**: Only trade what you can afford to lose
6. **Keep SerenBucks funded**: Maintain at least $20 balance for uninterrupted operation

### For the Agent (Implementation Notes)

1. **Always validate inputs**: Check all config parameters are in valid ranges
2. **Never skip confirmation**: Live trading requires exact "START LIVE TRADING" text
3. **Log everything**: All trades, scans, errors go to log files
4. **Handle errors gracefully**: Never crash - log and notify
5. **Protect credentials**: Pass via environment variables, never log
6. **Estimate costs proactively**: Warn users about SerenBucks costs before starting

## Common Pitfalls

### User Mistakes

1. **Insufficient balance**: Forgetting to fund SerenBucks or Polymarket
2. **Over-aggressive config**: Setting thresholds too low, positions too large
3. **Ignoring notifications**: Missing alerts about errors or low balances
4. **Expecting instant profits**: Prediction markets take time, variance is high

### Implementation Mistakes

1. **Not handling expired credentials**: API keys can expire, must detect and notify
2. **Silent failures**: Always notify user of errors via chat
3. **Incorrect Kelly calculation**: Double-check the math: `kelly = (p * (b + 1) - 1) / b`
4. **Not validating API responses**: Check for errors before using data
5. **Skipping dry-run**: Always offer dry-run, don't go straight to live

## Success Criteria

The skill is working when:

✅ User can set up trading in < 5 minutes
✅ Dry-run mode works without real trades
✅ Live trading requires explicit confirmation with risk warnings
✅ Agent runs autonomously via seren-cron
✅ All control commands work intuitively
✅ Real-time chat updates during scans
✅ Persistent logs with complete trade history
✅ Error handling for all failure modes
✅ Stop loss automatically pauses trading
✅ Users can monitor P&L easily

## AgentSkills.io Standard

This skill follows the [AgentSkills.io](https://agentskills.io) open standard for agent skills, ensuring compatibility across:
- Claude Code
- OpenAI Codex
- Google Gemini
- Any compatible LLM tool

Taariq Lewis, SerenAI, Paloma, and Volume at https://serendb.com
Email: hello@serendb.com
