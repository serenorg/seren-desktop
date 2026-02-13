---
name: polymarket-bot
description: Autonomous trading agent for Polymarket prediction markets using Seren ecosystem
author: Seren AI
version: 1.0.0
tags: [trading, polymarket, prediction-markets, ai, autonomous, seren]
---

# Polymarket Trading Bot

Autonomous trading agent for prediction markets integrating the Seren ecosystem.

## ⚠️ IMPORTANT LEGAL DISCLAIMERS

**READ THIS BEFORE USING**

### Geographic Restrictions - CRITICAL
⚠️ **Polymarket is BLOCKED in the United States** following their 2022 CFTC settlement.
⚠️ **Using VPNs or other methods to circumvent geographic restrictions may violate laws**.
⚠️ **You are responsible for verifying that prediction market trading is legal in your jurisdiction**.

### Regulatory Status
- Prediction markets exist in a **regulatory gray area** in many jurisdictions
- Some governments classify them as **gambling**, others as **financial instruments**
- Some jurisdictions **prohibit them entirely**
- **Consult local laws and seek professional advice if uncertain**

### Not Financial Advice
- This bot is provided for **informational and educational purposes only**
- It does NOT constitute **financial, investment, legal, or tax advice**
- AI-generated estimates are **not guarantees and may be inaccurate**
- You are **solely responsible** for your trading decisions and any resulting gains or losses

### Risk of Loss
- Trading prediction markets involves **substantial risk of loss**
- Only risk capital you **can afford to lose completely**
- **Past performance does not indicate future results**
- Market conditions can change rapidly and unpredictably

### Tax Obligations
- Trading profits **may be subject to taxation** in your jurisdiction
- Consult a tax professional regarding your **reporting obligations**

### Age Restriction
- You must be **at least 18 years old** (or the age of majority in your jurisdiction) to use this bot

### No Warranty
- This software is provided **"as is" without warranty of any kind**
- The developers assume **no liability** for trading losses, technical failures, or regulatory consequences

---

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
2. **Researches** opportunities using Perplexity AI
3. **Estimates** fair value with Claude (Anthropic)
4. **Identifies** mispriced markets (edge > threshold)
5. **Executes** trades using Kelly Criterion for position sizing
6. **Runs autonomously** on seren-cron schedule
7. **Monitors** positions and reports P&L

## Architecture

**Pure Python Implementation**
- Python agent calls Seren publishers via HTTP
- Credentials stored in `.env` file (environment variables)
- Logs written to JSONL files
- Seren-cron executes Python script on schedule

**Components:**
- `agent.py` - Main trading loop
- `seren_client.py` - Seren API client (calls publishers)
- `polymarket_client.py` - Polymarket CLOB API wrapper
- `kelly.py` - Position sizing calculator
- `position_tracker.py` - Position management
- `logger.py` - Trading logger

**Seren Publishers Used:**
- `polymarket-data` - Market data (prices, volume, liquidity)
- `polymarket-trading-serenai` - Trading operations (orders, positions, balance)
- `perplexity` - AI-powered research
- `seren-models` - LLM inference (Claude)
- `seren-cron` - Job scheduling

---

## Setup Workflow

### Phase 1: Install Dependencies

Check Python version and install requirements:

```bash
cd skills/polymarket-trader

# Check Python version (need 3.9+)
python3 --version

# Install dependencies
pip3 install -r requirements.txt
```

### Phase 2: Configure Credentials

Create `.env` file from template:

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

```bash
# Seren API key - get from https://app.serendb.com/settings/api-keys
SEREN_API_KEY=your_seren_api_key_here

# Polymarket credentials - get from https://polymarket.com
# (Settings > API Keys > Derive API Key)
POLY_API_KEY=your_polymarket_api_key_here
POLY_PASSPHRASE=your_polymarket_passphrase_here
POLY_SECRET=your_polymarket_secret_here
POLY_ADDRESS=your_wallet_address_here
```

**How to get Polymarket credentials:**
1. Visit [polymarket.com](https://polymarket.com)
2. Connect your wallet
3. Navigate to Settings > API Keys
4. Click "Derive API Key"
5. Save your credentials securely

**Security Note:**
- Never commit `.env` to git (already in `.gitignore`)
- Keep credentials secure
- Credentials grant access to your Polymarket wallet

### Phase 3: Configure Risk Parameters

Copy the example config and customize:

```bash
cp config.example.json config.json
```

Edit `config.json` to set your risk parameters:

```json
{
  "bankroll": 100.0,
  "mispricing_threshold": 0.08,
  "max_kelly_fraction": 0.06,
  "scan_interval_minutes": 10,
  "max_positions": 10,
  "stop_loss_bankroll": 0.0
}
```

**Parameter Guide:**

#### bankroll
Total capital available for trading (in USDC).
- Testing: $50-100
- Serious: $500+
- **Only risk what you can afford to lose**

#### mispricing_threshold
Minimum edge required to trade (as decimal, e.g., 0.08 = 8%).
- 0.05: Aggressive (more trades, smaller edges)
- 0.08: Balanced (recommended)
- 0.12: Conservative (fewer trades, larger edges)

#### max_kelly_fraction
Maximum % of bankroll per trade (as decimal, e.g., 0.06 = 6%).
- 0.03: Very conservative
- 0.06: Balanced (recommended)
- 0.10: Aggressive (higher variance)

#### scan_interval_minutes
How often to scan for opportunities.
- 5 minutes: High frequency (~$5-10/day in API costs)
- 10 minutes: Balanced (~$2-5/day)
- 30 minutes: Conservative (~$0.50-1.50/day)

#### max_positions
Maximum concurrent open positions.
- Small bankroll (<$100): 5-10
- Medium bankroll ($100-500): 10-20
- Large bankroll (>$500): 20-50

#### stop_loss_bankroll
Stop trading if bankroll drops to this amount.
- 0: Stop only if completely depleted
- 50% of initial: Stop if down 50%

### Phase 4: Check Balances

Before running, ensure you have sufficient balances:

**SerenBucks** (for API calls):
- Visit: https://app.serendb.com/wallet/deposit
- Recommended: $20+ for uninterrupted operation
- Cost: ~$0.50-2.00 per scan cycle

**Polymarket** (for trading):
- Bridge USDC to Polygon PoS
- Send to your Polymarket wallet address
- Check balance: https://polymarket.com/wallet

### Phase 5: Dry-Run Test (STRONGLY RECOMMENDED)

Test the bot without placing real trades:

```bash
python3 agent.py --config config.json --dry-run
```

**Dry-run mode:**
- ✅ Scans markets (when implemented)
- ✅ Researches opportunities using Perplexity
- ✅ Estimates fair values using Claude
- ✅ Calculates position sizes using Kelly Criterion
- ✅ Logs everything to files
- ❌ Does NOT place actual trades

**Expected output:**
```
============================================================
🔍 Polymarket Scan Starting - 2026-02-12 14:35:00 UTC
============================================================

Balances:
  SerenBucks: $23.45
  Polymarket: $100.00

Scanning markets...
  Found 23 markets

Evaluating: "Will BTC hit $100k by March 2026?"
  Current price: 54.0%
  🧠 Researching: "Will BTC hit $100k by March 2026?"
  💡 Estimating fair value...
     Fair value: 67.0% (confidence: medium)
    ✓ Opportunity found!
      Edge: 13.0%
      Side: BUY
      Size: $3.24 (5.4% of available)
      Expected value: +$0.42

    [DRY-RUN] Would place BUY order:
      Market: "Will BTC hit $100k by March 2026?"
      Size: $3.24
      Price: 54.0%
      Expected value: +$0.42

============================================================
Scan complete!
  Markets scanned: 23
  Opportunities: 8
  Trades executed: 0 (dry-run)
  Capital deployed: $0.00
  API cost: ~$0.46 SerenBucks
============================================================
```

### Phase 6: Live Trading Confirmation

⚠️ **CRITICAL - You must explicitly confirm before enabling live trading**

**Before going live, ask yourself:**
1. Have I tested in dry-run mode?
2. Do I understand the risks?
3. Can I afford to lose this capital?
4. Is prediction market trading legal in my jurisdiction?
5. Have I funded both SerenBucks and Polymarket?

**Display this warning:**

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

The agent will run on schedule until you stop it.

Type exactly: START LIVE TRADING
(or 'cancel' to abort)
```

**Wait for EXACT confirmation.** Do not proceed unless user types "START LIVE TRADING".

### Phase 7: Run Live

Once confirmed, run the agent:

```bash
# Run once
python3 agent.py --config config.json

# Or set up with seren-cron for autonomous operation
```

**Setting up seren-cron** (for autonomous scheduling):

```python
from seren_client import SerenClient

seren = SerenClient()

# Create cron job
job = seren.create_cron_job(
    name='polymarket-trader',
    schedule='*/10 * * * *',  # Every 10 minutes
    url='http://localhost:8000/run-scan',  # Your endpoint
    method='POST',
    headers={
        'Authorization': 'Bearer YOUR_WEBHOOK_TOKEN'
    }
)

print(f"Cron job created: {job['id']}")
```

**Note:** You'll need to set up a web endpoint that calls `agent.py` when triggered.

---

## Control Commands

### Show Status

Read current positions and display status:

```python
import json

# Read positions
with open('skills/polymarket-trader/logs/positions.json', 'r') as f:
    data = json.load(f)

# Display
print("📊 Polymarket Trading Status\n")
print(f"Positions: {data['position_count']}")
print(f"Total unrealized P&L: ${data['total_unrealized_pnl']:.2f}")

for pos in data['positions']:
    pnl_symbol = '+' if pos['unrealized_pnl'] >= 0 else ''
    print(f"\n  {pos['market']}")
    print(f"  {pos['side']} ${pos['size']:.2f} @ {pos['entry_price'] * 100:.1f}%")
    print(f"  Now: {pos['current_price'] * 100:.1f}% ({pnl_symbol}${pos['unrealized_pnl']:.2f})")
```

### Show Recent Trades

Read and display trade history:

```python
import json

# Read last 20 trades
with open('skills/polymarket-trader/logs/trades.jsonl', 'r') as f:
    lines = f.readlines()

trades = [json.loads(line) for line in lines[-20:]]

print("📝 Recent Trades (Last 20)\n")

for i, trade in enumerate(reversed(trades), 1):
    pnl_symbol = '' if trade['pnl'] is None else ('+' if trade['pnl'] >= 0 else '')
    status_emoji = '🟢' if trade['status'] == 'open' else '✓' if trade['pnl'] and trade['pnl'] > 0 else '✗'

    print(f"{i}. {status_emoji} {trade['side']} ${trade['size']:.2f} @ {trade['price'] * 100:.1f}%")
    print(f"   \"{trade['market']}\"")
    if trade['pnl'] is not None:
        print(f"   P&L: {pnl_symbol}${trade['pnl']:.2f}")
    print()
```

### Pause/Resume Trading

**Pause** (stop scanning, keep positions):
```python
seren = SerenClient()
config = json.load(open('config.json'))

seren.pause_cron_job(config['cron_job_id'])
print("⏸️  Trading paused")
```

**Resume**:
```python
seren.resume_cron_job(config['cron_job_id'])
print("▶️  Trading resumed")
```

### Stop Trading

**Stop completely** (cancel cron job):
```python
seren.delete_cron_job(config['cron_job_id'])
print("🛑 Trading stopped")
```

---

## Monitoring & Logs

All activity is logged to JSONL files in `logs/`:

### trades.jsonl
One line per trade (opened or closed):

```json
{"timestamp": "2026-02-12T14:35:00Z", "market": "Will BTC hit $100k by March?", "market_id": "0x123...", "side": "BUY", "size": 3.24, "price": 0.54, "fair_value": 0.67, "edge": 0.13, "status": "open", "pnl": null}
```

### scan_results.jsonl
One line per scan cycle:

```json
{"timestamp": "2026-02-12T14:35:00Z", "dry_run": false, "markets_scanned": 500, "opportunities_found": 23, "trades_executed": 3, "capital_deployed": 9.45, "api_cost": 1.12, "serenbucks_balance": 48.88, "polymarket_balance": 103.45}
```

### positions.json
Current state (updated after each trade):

```json
{
  "positions": [
    {
      "market": "Will BTC hit $100k by March?",
      "market_id": "0x123...",
      "token_id": "0x456...",
      "side": "BUY",
      "entry_price": 0.54,
      "current_price": 0.58,
      "size": 3.24,
      "unrealized_pnl": 0.84,
      "opened_at": "2026-02-12T14:35:00Z"
    }
  ],
  "total_unrealized_pnl": 0.84,
  "position_count": 1,
  "last_updated": "2026-02-12T18:00:00Z"
}
```

### notifications.jsonl
Critical events for user notification:

```json
{"timestamp": "2026-02-12T15:00:00Z", "level": "warning", "title": "Low SerenBucks Balance", "message": "Current: $1.23, Recommended: $20.00"}
```

---

## How It Works (Technical Details)

### Fair Value Estimation

The bot uses Claude to estimate true probabilities:

```python
def estimate_fair_value(market_question, current_price, research):
    prompt = f"""You are an expert analyst estimating the true probability of prediction market outcomes.

Market Question: {market_question}

Current Market Price: {current_price * 100:.1f}%

Research Summary:
{research}

Based on the research and your analysis, estimate the TRUE probability of this outcome occurring.

Provide your response in this exact format:
PROBABILITY: [number between 0 and 100]
CONFIDENCE: [low, medium, or high]
REASONING: [brief explanation]"""

    # Call Claude via seren-models
    response = seren.call_publisher(
        publisher='seren-models',
        method='POST',
        path='/chat/completions',
        body={
            'model': 'anthropic/claude-sonnet-4-20250514',
            'messages': [{'role': 'user', 'content': prompt}],
            'temperature': 0.3
        }
    )

    # Parse and return
    # (parsing logic extracts PROBABILITY and CONFIDENCE from response)
```

### Position Sizing (Kelly Criterion)

```python
def calculate_position_size(fair_value, market_price, bankroll, max_kelly=0.06):
    """
    Calculate optimal position size using Kelly Criterion

    Formula: kelly = (fair_value - price) / (1 - price) for BUY
    Uses quarter-Kelly (divide by 4) for conservatism
    Caps at max_kelly of bankroll
    """
    kelly = (fair_value - market_price) / (1 - market_price)
    kelly_adjusted = kelly / 4  # Quarter-Kelly
    kelly_capped = min(kelly_adjusted, max_kelly)

    position_size = bankroll * kelly_capped
    return round(position_size, 2)
```

---

## Known Limitations & TODOs

### Currently Implemented ✅
- ✅ Seren API client
- ✅ Polymarket client wrapper
- ✅ Fair value estimation via Claude
- ✅ Kelly Criterion calculator
- ✅ Position tracking
- ✅ Comprehensive logging
- ✅ Dry-run mode
- ✅ Configuration system
- ✅ Environment variable credentials

### Fully Implemented ✅

- ✅ **Market scanning** - Via `polymarket-data` publisher
- ✅ **Order placement** - Via `polymarket-trading-serenai` publisher
- ✅ **EIP-712 order signing** - Handled server-side by `polymarket-trading-serenai`
- ✅ **Position tracking** - Via `polymarket-trading-serenai` publisher
- ✅ **Price fetching** - Market data via publishers
- ✅ **Kelly Criterion position sizing** - Full implementation
- ✅ **Fair value estimation** - AI-powered via Perplexity + Claude

### Not Yet Implemented ❌

- ❌ **Actual wallet balance checking** - Currently calculates from positions only (TODO: blockchain query)
- ❌ **Automated position closing** - Manual closing only
- ❌ **Autonomous scheduling** - No seren-cron integration yet
- ❌ **Email/webhook notifications** - Only logs to files
- ❌ **Web dashboard** - Command-line only
- ❌ **Backtesting** - No historical data testing

**To complete full autonomy:**
1. Add blockchain balance query for accurate USDC balance
2. Implement automated position closing/rebalancing logic
3. Integrate with seren-cron for autonomous scheduling
4. Build notification system (email, webhook, or chat integration)
5. Create web dashboard for monitoring

---

## Cost Estimation

### SerenBucks (API Calls)
Per scan cycle:
- Perplexity research: $0.01 × markets researched
- Claude fair value: $0.01 × markets evaluated
- Total: ~$0.50-2.00 per scan (depends on markets scanned)

**Daily costs:**
- Every 5 min: $5-10/day
- Every 10 min: $2-5/day
- Every 30 min: $0.50-1.50/day

### Polymarket Trading
- Order placement: $0.005 per order
- Order cancellation: $0.002 per cancellation
- Price queries: $0.001 per request

---

## Troubleshooting

### "SEREN_API_KEY is required"
- Create `.env` file from `.env.example`
- Add your Seren API key

### "Polymarket credentials required"
- Add `POLY_API_KEY`, `POLY_PASSPHRASE`, `POLY_ADDRESS` to `.env`

### "Market scanning not yet implemented"
- This is expected - market scanning needs to be implemented
- See "Known Limitations" section above

### "Low SerenBucks balance"
- Deposit at: https://app.serendb.com/wallet/deposit
- Maintain at least $20 for smooth operation

### "Publisher call failed: 401"
- Check your API keys are correct
- Verify credentials haven't expired

---

## Best Practices

### For Users

1. **Start small**: Test with $50-100 before scaling up
2. **Use dry-run first**: Always test before going live
3. **Monitor regularly**: Check logs and positions daily
4. **Adjust conservatively**: Increase bankroll gradually
5. **Understand the risks**: Only trade what you can afford to lose
6. **Keep funded**: Maintain sufficient SerenBucks balance

### For Developers

1. **Always validate inputs**: Check config parameters are in valid ranges
2. **Never skip confirmation**: Live trading requires explicit user consent
3. **Log everything**: All trades, scans, errors go to log files
4. **Handle errors gracefully**: Never crash - log and notify
5. **Protect credentials**: Use environment variables, never log secrets
6. **Estimate costs proactively**: Warn users about SerenBucks costs

---

## AgentSkills.io Standard

This skill follows the [AgentSkills.io](https://agentskills.io) open standard for agent skills, ensuring compatibility across:
- Claude Code
- OpenAI Codex
- Google Gemini
- Any compatible LLM tool

Taariq Lewis, SerenAI, Paloma, and Volume at https://serendb.com
Email: hello@serendb.com
