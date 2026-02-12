# Polymarket Trading Skill

Autonomous prediction market trading agent for Seren Desktop.

## Overview

This skill enables autonomous trading on Polymarket using AI-powered market analysis:

1. **Scans** Polymarket for active prediction markets
2. **Researches** opportunities using Perplexity
3. **Estimates** fair value with Claude (Sonnet 4.5)
4. **Identifies** mispriced markets
5. **Executes** trades using Kelly Criterion for optimal position sizing
6. **Runs autonomously** on a configurable schedule via seren-cron

## Quick Start

### Prerequisites

- **Seren Desktop** installed and running
- **Polymarket account** with API credentials
- **SerenBucks balance** for API calls (~$2-5/day depending on usage)
- **Trading capital** on Polymarket (USDC on Polygon PoS)

### Setup

1. **Get Polymarket API credentials:**
   - Visit [polymarket.com](https://polymarket.com)
   - Connect your wallet
   - Navigate to Settings > API Keys
   - Click "Derive API Key"
   - Save your credentials securely

2. **Activate the skill in Seren Desktop:**
   ```
   Say: "I want to trade on Polymarket"
   ```

3. **Follow the interactive setup:**
   - Enter your Polymarket credentials
   - Configure risk parameters (bankroll, thresholds, etc.)
   - Run a dry-run test (recommended)
   - Confirm live trading

4. **Monitor your trading:**
   ```
   "show status"         - View positions and P&L
   "show recent trades"  - See trade history
   "pause trading"       - Temporarily stop
   "stop trading"        - Disable completely
   ```

## How It Works

### Market Analysis

The agent uses a multi-step process to identify trading opportunities:

1. **Market Scanning** - Queries Polymarket for active markets with sufficient volume
2. **Research** - Uses Perplexity to gather relevant news and data
3. **Valuation** - Claude estimates the fair probability based on research
4. **Edge Calculation** - Compares fair value to market price
5. **Filtering** - Only trades markets with edge above your threshold

### Position Sizing

The agent uses the **Kelly Criterion** for optimal position sizing:

```
Kelly % = (p × (b + 1) - 1) / b

Where:
  p = probability of winning (fair value estimate)
  b = odds (1.0 for even money)
```

For conservative sizing, the agent uses **quarter-Kelly** (25% of full Kelly) and caps positions at your configured `max_kelly_fraction`.

**Example:**
- Fair value: 60%
- Market price: 50%
- Full Kelly: 20% of bankroll
- Quarter-Kelly: 5% of bankroll
- Max Kelly fraction: 6%
- **Actual position: 5% of bankroll** (min of quarter-Kelly and cap)

### Risk Management

Built-in safety features:

- **Bankroll limit** - Maximum total capital deployed
- **Position limit** - Maximum concurrent positions
- **Edge threshold** - Minimum mispricing required to trade
- **Stop loss** - Auto-pause if bankroll drops to threshold
- **Confidence filtering** - Only trades "medium" or "high" confidence estimates

## Configuration

### Risk Parameters

| Parameter | Description | Recommended | Range |
|-----------|-------------|-------------|-------|
| **Bankroll** | Total capital for trading | $50-100 (testing)<br>$500+ (serious) | $10+ |
| **Mispricing Threshold** | Min edge to trade | 8% | 5-15% |
| **Max Kelly Fraction** | Max % per trade | 6% | 3-10% |
| **Scan Interval** | Minutes between scans | 10 | 5, 10, 15, 30 |
| **Max Positions** | Concurrent positions | 10-20 | 1-50 |
| **Stop Loss** | Stop if bankroll drops to | $0 | $0 - bankroll |

### Updating Configuration

You can update parameters anytime:

```
"update config"               - Interactive update
"change interval to 15 minutes"  - Quick update
"change bankroll to $200"         - Quick update
```

Changes take effect on the next scan cycle.

## Costs

### SerenBucks (API Calls)

Estimated costs per scan cycle:

- **Perplexity research:** ~$0.50-1.00 (varies with opportunities)
- **Claude estimates:** ~$0.30-0.80 (varies with opportunities)
- **Market data:** ~$0.10-0.20
- **Total per cycle:** ~$0.50-2.00

**Daily costs** depend on scan frequency:
- 5 min intervals: ~$5-10/day
- 10 min intervals: ~$2-5/day
- 15 min intervals: ~$1-3/day
- 30 min intervals: ~$0.50-1.50/day

### Trading Capital

Your configured bankroll on Polymarket. This is NOT spent on fees - it's your trading capital that the agent manages.

## Monitoring

### Real-Time Updates

When active in Seren Desktop, you'll see:

```
🔍 Polymarket Scan Starting...

Scanning 500 active markets...
Found 23 potential opportunities

Researching top prospects:
  ✓ "Will BTC hit $100k by March?"
    Market: 54% → Fair: 67% → Edge: 13%
    BUY $3.24 (5.4% Kelly)

Scan complete! 3 trades executed.
Next scan: in 10 minutes
```

### Status Command

Check your performance anytime:

```
"show status"

📊 Polymarket Trading Status

Bankroll:
  • Initial: $100.00
  • Current: $103.45
  • P&L: +$3.45 (+3.45%)

Positions: 4/10 open
  1. BTC $100k - BUY $5.20 @ 54% → 58% (+$0.84)
  2. Fed cuts Q1 - SELL $3.80 @ 32% → 30% (+$0.76)
  ...
```

### Log Files

All activity logged to `skills/polymarket-trader/logs/`:

- **trades.jsonl** - Every trade with P&L
- **scan_results.jsonl** - Each scan cycle summary
- **positions.json** - Current open positions
- **agent.log** - Detailed agent logs

## Notifications

You'll be notified of critical events:

### Wins & Losses

```
🎉 Significant Win!
Position closed: +$2.76 (+85%)
Market: "Will BTC hit $100k?"
Current P&L: +$8.45
```

### Errors

```
⚠️ API Error
Polymarket API timeout - will retry in 10 minutes
```

### Stop Loss

```
⚠️ Bankroll Depleted
Current: $2.15 / Stop loss: $0.00
Trading paused automatically
```

## Commands Reference

### Control

| Command | Description |
|---------|-------------|
| `show status` | Current positions and P&L |
| `show recent trades` | Last 20 trades with results |
| `show positions` | All open positions |
| `pause trading` | Stop scanning, keep positions |
| `resume trading` | Restart scanning |
| `stop trading` | Cancel cron job, optionally close positions |

### Configuration

| Command | Description |
|---------|-------------|
| `update config` | Interactive config update |
| `change interval to N minutes` | Update scan frequency |
| `change bankroll to $X` | Update available capital |
| `change threshold to N%` | Update mispricing threshold |

## Testing

### Dry-Run Mode

Before risking real money, test with dry-run mode:

```
"run a dry-run test"
```

Dry-run will:
- ✅ Scan real markets
- ✅ Research with Perplexity
- ✅ Estimate fair values with Claude
- ✅ Calculate position sizes
- ❌ NOT place actual trades

This costs SerenBucks (~$0.50-2.00) but won't risk trading capital.

### Small Capital Testing

After dry-run, test live with small capital:

1. Start with $10-20 bankroll
2. Run 2-3 scan cycles
3. Verify trades execute correctly
4. Check P&L tracking
5. Scale up if satisfied

## Risk Warnings

**⚠️ Important - Read Before Trading**

- **You can lose money** - Prediction markets are uncertain
- **Only risk what you can afford to lose** - Never trade with essential funds
- **AI estimates can be wrong** - Claude is powerful but not perfect
- **Past performance ≠ future results** - Backtests don't guarantee profits
- **Market conditions change** - Liquidity, volatility, and efficiency vary
- **Fees and slippage** - Real costs may reduce theoretical edges
- **Autonomous trading = less control** - The agent operates independently

**This is experimental software. Trade at your own risk.**

## FAQ

### Q: How much can I make?

**A:** Unknown. Prediction markets are difficult to beat consistently. The agent uses sound principles (Kelly sizing, edge-based trading) but success depends on market conditions and AI accuracy.

### Q: What if I lose money?

**A:** That's a real possibility. The stop loss helps limit losses, but you should only trade what you can afford to lose entirely.

### Q: Can I trade manually while the agent is running?

**A:** Yes, but the agent doesn't know about manual trades. Your manual positions won't count toward `max_positions` or bankroll calculations.

### Q: What markets does the agent trade?

**A:** Any active market on Polymarket with sufficient volume. You can't filter by category currently.

### Q: How accurate are the fair value estimates?

**A:** Varies by market. The agent only trades "medium" or "high" confidence estimates and requires a mispricing threshold to account for uncertainty.

### Q: What happens if Polymarket goes down?

**A:** The agent will fail to scan and log an error. After 3 consecutive failures, it automatically pauses. You'll be notified.

### Q: Can I run multiple agents with different configurations?

**A:** Not currently. Only one agent per Seren Desktop instance.

### Q: How do I close all positions?

**A:** Say "stop trading" and choose option 2 (stop + close positions). Or close them manually on Polymarket.

### Q: What if I run out of SerenBucks mid-scan?

**A:** The scan will fail. The agent will retry on the next cycle but won't complete until you deposit more SerenBucks.

### Q: Can I paper trade long-term?

**A:** Yes! Run with `--dry-run` flag continuously. All features work except real trades.

## Troubleshooting

### "Insufficient SerenBucks balance"

**Solution:** Deposit SerenBucks at https://app.serendb.com/wallet/deposit

### "Authentication failed - credentials may have expired"

**Solutions:**
1. Check Polymarket credentials: Settings > Wallet > Polymarket
2. Regenerate API key on Polymarket if expired
3. Update credentials: "update polymarket credentials"

### "Stop loss triggered"

**Solutions:**
1. Deposit more USDC to Polymarket
2. Update bankroll: "update config"
3. Resume trading: "resume trading"

### "Max positions reached"

**Solution:** Either:
1. Wait for positions to close (markets resolve)
2. Manually close positions on Polymarket
3. Increase `max_positions`: "update config"

### Agent not finding opportunities

**Possible causes:**
1. **Threshold too high** - Lower `mispricing_threshold`
2. **Markets already efficient** - Less mispricing available
3. **Low confidence estimates** - Agent filters these out
4. **Small sample** - Run more cycles

### High SerenBucks costs

**Solutions:**
1. Increase `scan_interval` (scan less frequently)
2. Markets are researched in batches - costs vary
3. Consider if the potential returns justify the costs

## Support

### Getting Help

- **Seren Discord:** https://discord.gg/seren
- **Documentation:** https://docs.serendb.com
- **Email:** hello@serendb.com

### Reporting Issues

If you encounter bugs or unexpected behavior:

1. Check `skills/polymarket-trader/logs/agent.log`
2. Note error messages and timestamps
3. Report in #polymarket-trading on Discord
4. Include relevant log excerpts (remove API keys!)

## Advanced

### Manual Execution

You can run the agent manually:

```bash
cd skills/polymarket-trader

# Dry-run
python3 agent.py --dry-run

# Live trading (requires env vars)
export SEREN_API_KEY="..."
export POLYMARKET_API_KEY="..."
export POLYMARKET_API_SECRET="..."
export POLYMARKET_PASSPHRASE="..."
export POLYMARKET_ADDRESS="..."

python3 agent.py
```

### Custom Modifications

The agent is open source. You can modify:

- `agent.py` - Trading logic
- `config.json` - Parameters
- `SKILL.md` - Agent behavior prompts

**Note:** Modifications may break future updates.

## License

MIT License - See root LICENSE file

## Credits

Built by the Seren team to showcase the Seren ecosystem:
- Seren Desktop - Agent platform
- Seren-cron - Autonomous scheduling
- Seren MCP - Publisher integration
- SerenBucks - Unified payments

Taariq Lewis, SerenAI, Paloma, and Volume at https://serendb.com
Email: hello@serendb.com
