# Kraken Grid Trading Bot

**Version**: 1.0.0
**Author**: Taariq Lewis
**License**: MIT

---

## Table of Contents

1. [Overview](#overview)
2. [What is Grid Trading](#what-is-grid-trading)
3. [How It Works](#how-it-works)
4. [Cost Analysis](#cost-analysis)
5. [Setup](#setup)
6. [Configuration](#configuration)
7. [Usage](#usage)
8. [Architecture](#architecture)
9. [Risk Management](#risk-management)
10. [Troubleshooting](#troubleshooting)
11. [FAQ](#faq)

---

## Overview

The Kraken Grid Trading Bot is an automated trading system that profits from BTC price volatility using a mechanical, non-directional grid strategy. It places buy and sell orders at regular price intervals and automatically replaces them as they fill, capturing profit from price oscillations.

### Key Features

- **Mechanical Strategy**: No predictions or market timing required
- **Non-Directional**: Profits in both up and down markets (as long as price moves)
- **Risk-Managed**: Stop-loss, position limits, bankroll protection
- **Cost-Efficient**: 0.16% maker fees via Kraken (lowest tier)
- **Always Active**: Always has trading opportunities
- **Fully Automated**: Set-and-forget operation via cron
- **Audit Trail**: JSONL logs for every operation
- **Dry-Run Mode**: Test strategy risk-free

### Business Model

- **Publisher**: Kraken (via Seren Gateway)
- **Cost**: 0.16% maker fee per trade (Kraken)
- **Revenue**: Grid spread (1-5%) minus fees
- **Edge**: 1.68% net per cycle with 2% spacing

---

## What is Grid Trading

Grid trading is a quantitative trading strategy that places orders at regular price intervals, forming a "grid" of buy and sell orders.

### How It Works

1. **Define Price Range**: Set min and max prices (e.g., $45k - $55k)
2. **Create Grid**: Divide range into levels (e.g., 20 levels)
3. **Place Orders**:
   - **Buy orders** below current price
   - **Sell orders** above current price
4. **Profit from Fills**:
   - Price drops → Buy order fills → Accumulate BTC
   - Price rises → Sell order fills → Take profit
   - Net profit: Buy low, sell high repeatedly

### Example Trade Sequence

**Setup:**
- Bankroll: $1,000
- Grid spacing: 2%
- Order size: $50 (5% of bankroll)

**Trades:**
1. Price at $50,000 → Place buy at $49,000, sell at $51,000
2. Price drops to $49,000 → Buy fills ($50 spent, +0.00102 BTC)
3. Price rises to $51,000 → Sell fills ($52 received, -0.00102 BTC)
4. **Profit**: $52 - $50 - $0.32 fees = **$1.68 net** (3.36% return)

### Why Grid Trading Works

- **Volatility is Consistent**: BTC moves 2-5% daily (grid captures this)
- **No Market Timing**: Doesn't require predicting direction
- **High Frequency**: 10-20 fills per day in normal markets
- **Compound Growth**: Profits reinvested automatically

---

## How It Works

### Trading Cycle

The bot runs in a continuous loop:

```
1. Get current BTC price
2. Update balances from Kraken
3. Check stop-loss threshold
4. Detect filled orders
5. Calculate required grid orders
6. Place missing orders
7. Log position update
8. Sleep for scan_interval_seconds
9. Repeat
```

### Order Placement Logic

```python
for each grid_level in grid:
    if level < current_price:
        # Place buy order
        volume = order_size_usd / level
        place_limit_buy(price=level, volume=volume)

    elif level > current_price:
        # Place sell order
        volume = order_size_usd / level
        place_limit_sell(price=level, volume=volume)
```

### Fill Detection

The bot tracks `active_orders` (orders we placed) and compares against Kraken's `open_orders`:

```python
filled_orders = active_orders.keys() - open_orders.keys()

for order_id in filled_orders:
    # Order filled!
    record_fill(order_id)
    remove_from_active_orders(order_id)
    # Bot will replace it in next cycle
```

### Grid Rebalancing

If price moves more than 10% from grid center, bot automatically rebalances:

```python
if abs(current_price - grid_center) / grid_center > 0.10:
    # Cancel all orders
    cancel_all_orders()

    # Recalculate grid centered on new price
    grid = GridManager(
        min_price=current_price * 0.90,
        max_price=current_price * 1.10,
        ...
    )

    # Place new grid orders
    place_grid_orders()
```

---

## Cost Analysis

### Kraken Fee Structure

| Order Type | Fee | When Applied |
|------------|-----|--------------|
| Maker (Limit) | 0.16% | Order adds liquidity |
| Taker (Market) | 0.26% | Order removes liquidity |

**Grid bots use maker orders only** → 0.16% per fill

### Round-Trip Cost

Each grid cycle involves:
1. **Buy at lower level** → 0.16% fee
2. **Sell at higher level** → 0.16% fee
3. **Total round-trip fee**: 0.32%

### Profit Calculation

**Example: 2% grid spacing, $1,000 position**

| Metric | Value |
|--------|-------|
| Buy at | $50,000 |
| Sell at | $51,000 |
| Gross profit | $1,000 × 2% = $20.00 |
| Buy fee | $1,000 × 0.16% = $1.60 |
| Sell fee | $1,020 × 0.16% = $1.63 |
| Total fees | $3.23 |
| **Net profit** | **$16.77 (1.68%)** |

### Grid Spacing Comparison

| Spacing | Gross Profit | Fees | Net Profit | Net % | Viable? |
|---------|--------------|------|------------|-------|---------|
| 0.5% | $5.00 | $3.20 | $1.80 | 0.18% | ⚠️ Thin |
| 1.0% | $10.00 | $3.20 | $6.80 | 0.68% | ✅ Good |
| 2.0% | $20.00 | $3.20 | $16.80 | 1.68% | ✅ Best |
| 3.0% | $30.00 | $3.20 | $26.80 | 2.68% | ✅ Wider |
| 5.0% | $50.00 | $3.20 | $46.80 | 4.68% | ⚠️ Too wide |

**Recommendation**: Use **2% spacing** for optimal balance of:
- **Profit**: 1.68% net per cycle (84% more than 1% spacing)
- **Fill frequency**: 10-15 fills per day in normal volatility
- **Safety**: Wide enough to avoid overtrading

### Expected Returns

**Scenario: $1,000 bankroll, 2% spacing, 15 fills/day**

| Timeframe | Fills | Net Profit | ROI |
|-----------|-------|------------|-----|
| Per cycle | 1 | $16.80 | 1.68% |
| Daily | 15 | $252.00 | 25.2% |
| Weekly | 105 | $1,764.00 | 176.4% |
| Monthly | 450 | $7,560.00 | 756% |

**Important**: Actual results depend on market volatility. Sideways markets produce more fills than trending markets.

### Break-Even Analysis

**Minimum viable spacing** = (Round-trip fees / 2) × Safety factor

- Round-trip fees: 0.32%
- Safety factor: 2× for comfortable margin
- **Minimum spacing**: 0.64%

**Below 0.64% spacing**, fees consume more than 50% of gross profit.

---

## Setup

### Phase 1: Install Dependencies

```bash
cd skills/kraken-grid-trader
pip install -r requirements.txt
```

**Dependencies:**
- `requests` - HTTP client for Seren Gateway API
- `python-dotenv` - Environment variable management
- `python-dateutil` - Date/time utilities

### Phase 2: Configure Seren API Key

```bash
# Copy example env file
cp .env.example .env

# Add your API key
echo "SEREN_API_KEY=sb_your_key_here" > .env
```

Get your Seren API key at: https://serendb.com

### Phase 3: Fund Kraken Account

The bot requires:
- **USD balance** for buy orders
- **BTC balance** for sell orders

**Recommended initial funding:**
- USD: 50% of bankroll
- BTC: 50% of bankroll (at current price)

Example for $1,000 bankroll:
- Deposit $500 USD
- Deposit 0.01 BTC (~$500 at $50k/BTC)

### Phase 4: Configure Trading Parameters

```bash
# Copy example config
cp config.example.json config.json

# Edit with your parameters
nano config.json
```

**Key parameters to customize:**
- `bankroll` - Your total allocated capital
- `price_range` - Set min/max 20-30% around current price
- `grid_levels` - Start with 20 levels
- `grid_spacing_percent` - Use 2.0% (recommended)
- `stop_loss_bankroll` - Set to 80% of bankroll

### Phase 5: Run Setup

```bash
python agent.py setup --config config.json
```

This will:
1. Validate your configuration
2. Connect to Kraken via Seren Gateway
3. Fetch current BTC price
4. Calculate grid levels
5. Show expected profit projections
6. Initialize JSONL logging

**Expected output:**

```
============================================================
KRAKEN GRID TRADER - SETUP
============================================================

Campaign:        BTC_Grid_2026
Trading Pair:    XBTUSD
Bankroll:        $1,000.00
Grid Levels:     20
Grid Spacing:    2.0%
Order Size:      5.0% of bankroll
Price Range:     $45,000 - $55,000
Scan Interval:   60s
Stop Loss:       $800.00

Fetching current market data...
Current Price:   $50,123.45

Expected Performance (15 fills/day):
  Gross Profit/Cycle:  $20.00
  Fees/Cycle:          $3.20
  Net Profit/Cycle:    $16.80
  Daily Profit:        $252.00 (25.2%)
  Monthly Profit:      $7,560.00 (756%)

✓ Setup complete!

Next steps:
  1. Run dry-run mode: python agent.py dry-run --config config.json
  2. Run live mode:    python agent.py start --config config.json

============================================================
```

### Phase 6: Test with Dry-Run

```bash
python agent.py dry-run --config config.json --cycles 10
```

This simulates 10 trading cycles **without placing real orders** (zero cost).

**What it does:**
1. Fetches real market data from Kraken
2. Calculates which orders would be placed
3. Shows next buy/sell levels
4. Does NOT place actual orders
5. Does NOT incur any costs

**Expected output:**

```
============================================================
KRAKEN GRID TRADER - DRY RUN
============================================================

Simulating 10 cycles...
Scan interval: 60s

--- Cycle 1/10 ---
Current Price: $50,123.45
Would place 10 buy orders below $50,123.45
Would place 10 sell orders above $50,123.45
Next buy level:  $49,100.00
Next sell level: $51,000.00

--- Cycle 2/10 ---
Current Price: $50,234.12
Would place 10 buy orders below $50,234.12
Would place 10 sell orders above $50,234.12
Next buy level:  $49,200.00
Next sell level: $51,100.00

...

✓ Dry run complete!

To run live mode:
  python agent.py start --config config.json

============================================================
```

### Phase 7: Start Live Trading

```bash
python agent.py start --config config.json
```

This starts **live trading with real orders**. Press `Ctrl+C` to stop.

---

## Configuration

### Full Config Reference

```json
{
  "campaign_name": "BTC_Grid_2026",
  "trading_pair": "XBTUSD",

  "strategy": {
    "bankroll": 1000.0,
    "grid_levels": 20,
    "grid_spacing_percent": 2.0,
    "order_size_percent": 5.0,
    "price_range": {
      "min": 45000,
      "max": 55000
    },
    "scan_interval_seconds": 60
  },

  "risk_management": {
    "stop_loss_bankroll": 800.0,
    "max_position_size": 0.1,
    "max_open_orders": 40
  },

  "execution": {
    "dry_run": true,
    "log_level": "INFO"
  }
}
```

### Parameter Guide

#### Strategy Parameters

**bankroll** (float, required)
- Total capital allocated to bot (USD)
- Range: $100 - $10,000 (start small)
- Example: `1000.0` for $1,000

**grid_levels** (int, required)
- Number of price levels in grid
- Range: 10-50
- More levels = tighter grid = more fills
- Recommended: `20` for 2% spacing

**grid_spacing_percent** (float, required)
- Spacing between grid levels (%)
- Range: 0.5% - 5%
- Affects profit per fill and fill frequency
- Recommended: `2.0` (optimal balance)

**order_size_percent** (float, required)
- Order size as % of bankroll
- Range: 1% - 10%
- Smaller = more diversified
- Recommended: `5.0` (20 positions max)

**price_range.min** (float, required)
- Minimum grid price (USD)
- Should be 10-15% below current price
- Example: `45000` if current is $50k

**price_range.max** (float, required)
- Maximum grid price (USD)
- Should be 10-15% above current price
- Example: `55000` if current is $50k

**scan_interval_seconds** (int, required)
- How often to check for fills (seconds)
- Range: 30-300s
- Shorter = faster response, more API calls
- Recommended: `60` (1 minute)

#### Risk Management Parameters

**stop_loss_bankroll** (float, required)
- Auto-stop if portfolio value drops below this (USD)
- Protects against catastrophic loss
- Recommended: 80% of bankroll
- Example: `800.0` for $1,000 bankroll

**max_position_size** (float, required)
- Maximum BTC position size
- Range: 0.01 - 0.5 BTC
- Prevents overexposure
- Example: `0.1` (0.1 BTC ~$5,000 at $50k)

**max_open_orders** (int, required)
- Maximum number of open orders
- Range: 10-100
- Must be ≥ 2 × grid_levels
- Example: `40` for 20 grid levels

---

## Usage

### Command Reference

```bash
# Setup and validate configuration
python agent.py setup --config config.json

# Simulate trading without real orders
python agent.py dry-run --config config.json [--cycles N]

# Start live trading
python agent.py start --config config.json

# Check current status
python agent.py status --config config.json

# Stop trading and cancel all orders
python agent.py stop --config config.json
```

### Running as a Service (Cron)

For continuous operation, use cron or systemd.

**Option 1: Cron (Simple)**

```bash
# Edit crontab
crontab -e

# Add entry to check every minute
* * * * * cd /path/to/kraken-grid-trader && python agent.py start --config config.json >> logs/cron.log 2>&1
```

**Option 2: Systemd Service (Production)**

Create `/etc/systemd/system/kraken-grid-trader.service`:

```ini
[Unit]
Description=Kraken Grid Trading Bot
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/kraken-grid-trader
ExecStart=/usr/bin/python3 agent.py start --config config.json
Restart=always
RestartSec=60

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable kraken-grid-trader
sudo systemctl start kraken-grid-trader
sudo systemctl status kraken-grid-trader
```

### Monitoring

**Check status:**

```bash
python agent.py status --config config.json
```

**Watch logs in real-time:**

```bash
tail -f logs/fills.jsonl
tail -f logs/positions.jsonl
tail -f logs/errors.jsonl
```

**Check recent fills:**

```bash
tail -20 logs/fills.jsonl | jq .
```

---

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────┐
│                   agent.py                          │
│            (Main orchestration)                     │
└───────────────┬────────────────────────────┬────────┘
                │                            │
        ┌───────▼──────┐            ┌────────▼────────┐
        │ seren_client │            │  grid_manager   │
        │  (Gateway)   │            │  (Grid logic)   │
        └───────┬──────┘            └────────┬────────┘
                │                            │
        ┌───────▼──────┐            ┌────────▼────────┐
        │   Kraken API │            │position_tracker │
        │  (via Seren) │            │   (State)       │
        └──────────────┘            └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │     logger      │
                                    │   (JSONL logs)  │
                                    └─────────────────┘
```

### File Structure

```
skills/kraken-grid-trader/
├── agent.py                    # Main bot implementation
├── seren_client.py             # Seren Gateway API client
├── grid_manager.py             # Grid calculation logic
├── position_tracker.py         # Position and P&L tracking
├── logger.py                   # JSONL logging
├── config.example.json         # Example configuration
├── requirements.txt            # Python dependencies
├── .env.example                # API key template
├── .gitignore                  # Exclude secrets
├── README.md                   # Quick start guide
└── SKILL.md                    # This file

logs/                           # Created at runtime
├── grid_setup.jsonl
├── orders.jsonl
├── fills.jsonl
├── positions.jsonl
└── errors.jsonl
```

### Data Flow

1. **agent.py** loads config and initializes components
2. **seren_client** fetches market data from Kraken
3. **grid_manager** calculates required orders
4. **agent.py** places orders via seren_client
5. **position_tracker** updates balances and P&L
6. **logger** writes all events to JSONL files
7. Loop repeats every `scan_interval_seconds`

### API Integration

All Kraken API calls go through Seren Gateway:

```python
# Example: Get ticker
response = seren_client._call_publisher(
    publisher='kraken',
    method='GET',
    path='/0/public/Ticker',
    params={'pair': 'XBTUSD'}
)

# Example: Place order
response = seren_client._call_publisher(
    publisher='kraken',
    method='POST',
    path='/0/private/AddOrder',
    body={
        'pair': 'XBTUSD',
        'type': 'buy',
        'ordertype': 'limit',
        'price': '50000',
        'volume': '0.001'
    }
)
```

---

## Risk Management

### Stop-Loss

Bot automatically stops if portfolio value drops below `stop_loss_bankroll`:

```python
current_value = btc_balance * btc_price + usd_balance

if current_value < stop_loss_bankroll:
    print("⚠ STOP LOSS TRIGGERED")
    cancel_all_orders()
    stop_trading()
```

**Example:**
- Bankroll: $1,000
- Stop-loss: $800 (80%)
- If value drops to $799, bot stops and cancels all orders

### Position Limits

Bot enforces maximum position size to prevent overexposure:

```python
if abs(btc_balance) > max_position_size:
    print("⚠ Position limit reached")
    skip_new_orders()
```

### Order Limits

Bot limits total open orders to prevent:
- Margin calls
- Insufficient funds
- Account restrictions

```python
if len(active_orders) >= max_open_orders:
    print("⚠ Order limit reached")
    skip_new_orders()
```

### Graceful Shutdown

When stopped (Ctrl+C or stop command):

1. Cancel all open orders
2. Calculate final P&L
3. Export fills to CSV
4. Print summary
5. Exit cleanly

```python
try:
    while running:
        trading_cycle()
        time.sleep(scan_interval)
except KeyboardInterrupt:
    print("Stopping...")
    cancel_all_orders()
    export_fills()
    print_summary()
```

---

## Troubleshooting

### Common Issues

**Issue: "SEREN_API_KEY is required"**

Solution:
```bash
# Create .env file with API key
echo "SEREN_API_KEY=sb_your_key_here" > .env
```

**Issue: "Insufficient funds" error**

Causes:
- Not enough USD for buy orders
- Not enough BTC for sell orders

Solution:
- Check Kraken balance: `python agent.py status`
- Deposit more funds to Kraken
- Reduce `order_size_percent` in config

**Issue: Orders not filling**

Causes:
- Grid spacing too wide (price not reaching levels)
- Price range doesn't include current price
- Low market volatility

Solution:
- Check current price vs grid range
- Tighten grid spacing (use 1-2%)
- Wait for market to move into grid range

**Issue: Bot stops unexpectedly**

Causes:
- Stop-loss triggered
- API error
- Network issue
- Insufficient funds

Solution:
- Check `logs/errors.jsonl` for details
- Verify Kraken account status
- Check network connectivity
- Review stop-loss threshold

**Issue: Too many API calls / rate limit**

Cause:
- `scan_interval_seconds` too low

Solution:
- Increase to 60-120 seconds
- Kraken rate limit: ~15 calls per minute

**Issue: Orders placed at wrong prices**

Cause:
- Price range in config is stale

Solution:
- Update `price_range` in config.json
- Re-run `python agent.py setup`
- Bot auto-rebalances if price moves >10% from center

### Debug Checklist

1. **Check logs**: `tail -f logs/errors.jsonl`
2. **Verify API key**: `echo $SEREN_API_KEY`
3. **Test connection**: `python agent.py setup --config config.json`
4. **Check Kraken balance**: Login to kraken.com
5. **Review config**: Validate all parameters
6. **Run dry-run**: Test without real orders

---

## FAQ

**Q: How much capital do I need to start?**

A: Minimum $100, recommended $1,000+. Smaller bankrolls limit diversification and increase relative fee impact.

**Q: What returns can I expect?**

A: Highly variable depending on volatility. In normal markets (2-5% daily BTC moves), expect 10-30% monthly returns. In choppy markets, 50-100%+ is possible. In trending markets (continuous up/down), expect lower returns.

**Q: Is this profitable in a bull market?**

A: Yes, but less than in sideways markets. Grid trading profits from volatility, not direction. In strong trends, you'll capture smaller gains as price moves through grid quickly.

**Q: What's the maximum drawdown?**

A: With 80% stop-loss, maximum loss is 20% of bankroll before auto-stop. Actual risk is lower due to gradual position building.

**Q: How much time does this require?**

A: Near zero. Setup takes 10 minutes. After that, bot runs autonomously. Check status weekly or when you see notifications.

**Q: Can I run multiple grids?**

A: Yes! Create separate config files for different pairs (e.g., ETHUSD, SOLUSD) or different BTC strategies (tight vs wide grids).

**Q: What if price breaks out of grid range?**

A: Bot auto-rebalances when price moves >10% from grid center. It cancels old orders and creates new grid centered on current price.

**Q: Should I use this with leverage?**

A: NO. Grid trading is safest with spot trading (no leverage). Leverage amplifies both gains and losses, and can lead to liquidation.

**Q: How do I cash out profits?**

A: 1. Stop bot: `python agent.py stop`
2. Sell all BTC to USD on Kraken
3. Withdraw USD to your bank

**Q: Can this handle black swan events?**

A: The stop-loss provides protection, but extreme events (e.g., BTC drops 50% in minutes) may breach stop-loss before orders can be cancelled. Consider this when sizing your bankroll.

**Q: What's the best grid spacing?**

A: 2% is optimal for BTC. It balances:
- High enough profit per cycle (1.68% net)
- Tight enough for frequent fills (10-15/day)
- Safe enough to avoid overtrading

---

## Changelog

### v1.0.0 (2026-02-16)
- Initial release
- BTC/USD grid trading
- Kraken integration via Seren Gateway
- 2% default grid spacing
- JSONL logging
- Dry-run mode
- Stop-loss protection
- Auto-rebalancing

---

## Roadmap

### v1.1 (Future)
- Multi-asset support (ETH, SOL, etc.)
- Dynamic grid spacing based on volatility
- Web dashboard for monitoring
- Mobile notifications (Telegram, Discord)
- Backtesting framework
- Portfolio rebalancing

### v1.2 (Future)
- Machine learning for optimal spacing
- Integration with TradingView alerts
- Multi-exchange support (Binance, Coinbase)
- Advanced risk metrics (Sharpe ratio, max drawdown)

---

## Support

- Seren Docs: https://docs.serendb.com
- Kraken API: https://docs.kraken.com/api
- Issues: https://github.com/serenorg/seren-desktop-issues

---

**Taariq Lewis, SerenAI, Paloma, and Volume at https://serendb.com**
**Email: hello@serendb.com**
