#!/usr/bin/env python3
"""
Autonomous Polymarket trading agent.

Scans markets, estimates fair value with Claude, finds mispricing,
and executes trades using Kelly criterion.
"""

import os
import sys
import json
import argparse
import logging
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional
from collections import deque

try:
    from seren_agent import SerenaAgent
except ImportError as e:
    print(f"Error: Required dependency missing: {e}")
    print("Please run: pip3 install -r requirements.txt")
    sys.exit(1)


# Configuration
SKILL_DIR = Path(__file__).parent
LOGS_DIR = SKILL_DIR / "logs"
CONFIG_FILE = SKILL_DIR / "config.json"
TRADES_LOG = LOGS_DIR / "trades.jsonl"
SCAN_LOG = LOGS_DIR / "scan_results.jsonl"
POSITIONS_FILE = LOGS_DIR / "positions.json"

# Ensure logs directory exists
LOGS_DIR.mkdir(exist_ok=True)

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOGS_DIR / 'agent.log')
    ]
)
logger = logging.getLogger(__name__)


class PolymarketTrader:
    """Autonomous trading agent for Polymarket."""

    # Rate limit: 60 orders/minute per Polymarket API docs
    MAX_ORDERS_PER_MINUTE = 60
    RATE_LIMIT_WINDOW = 60  # seconds

    def __init__(self, config_path: Path, dry_run: bool = False):
        """
        Initialize the trading agent.

        Args:
            config_path: Path to config.json
            dry_run: If True, simulate trades without placing real orders
        """
        self.config = self._load_config(config_path)
        self.dry_run = dry_run
        self.agent = self._init_agent()

        # Rate limiting tracker
        self.order_timestamps = deque()  # Track order timestamps for rate limiting

        logger.info(f"Initialized PolymarketTrader (dry_run={dry_run})")
        logger.info(f"Bankroll: ${self.config['bankroll']:.2f}")
        logger.info(f"Scan interval: {self.config['scan_interval_minutes']} minutes")

    def _load_config(self, path: Path) -> Dict:
        """Load configuration from JSON file."""
        if not path.exists():
            raise FileNotFoundError(
                f"Config file not found: {path}\n"
                f"Please run the skill setup first."
            )

        with open(path, 'r') as f:
            config = json.load(f)

        # Validate required fields
        required = [
            'bankroll',
            'mispricing_threshold',
            'max_kelly_fraction',
            'scan_interval_minutes',
            'max_positions',
            'stop_loss_bankroll'
        ]

        for field in required:
            if field not in config:
                raise ValueError(f"Missing required config field: {field}")

        return config

    def _init_agent(self) -> SerenaAgent:
        """Initialize Seren agent for MCP publisher calls."""
        api_key = os.getenv('SEREN_API_KEY')
        if not api_key:
            raise ValueError(
                "SEREN_API_KEY environment variable not set\n"
                "This should be set automatically by the skill."
            )

        return SerenaAgent(api_key=api_key)

    def check_balances(self) -> Dict[str, float]:
        """Check SerenBucks and Polymarket balances."""
        logger.info("Checking balances...")

        # Check SerenBucks via Seren API
        try:
            serenbucks_result = self.agent.call_publisher(
                'seren-wallet',
                'get_balance',
                {}
            )
            serenbucks = float(serenbucks_result.get('balance', 0))
        except Exception as e:
            logger.error(f"Failed to check SerenBucks balance: {e}")
            serenbucks = 0.0

        # Check Polymarket balance
        try:
            polymarket_balance = self._get_polymarket_balance()
        except Exception as e:
            logger.error(f"Failed to check Polymarket balance: {e}")
            polymarket_balance = 0.0

        balances = {
            'serenbucks': serenbucks,
            'polymarket': polymarket_balance
        }

        logger.info(f"Balances: SerenBucks=${balances['serenbucks']:.2f}, Polymarket=${balances['polymarket']:.2f}")
        return balances

    def _get_polymarket_balance(self) -> float:
        """Get Polymarket wallet balance via Seren polymarket publisher."""
        try:
            result = self.agent.call_publisher(
                'polymarket',
                'get_balance',
                {}
            )
            return float(result.get('balance', 0))
        except Exception as e:
            logger.error(f"Failed to get Polymarket balance via MCP: {e}")
            return 0.0

    def scan_markets(self) -> List[Dict]:
        """Scan Polymarket for active markets."""
        logger.info("Scanning active markets...")

        try:
            result = self.agent.call_publisher(
                'polymarket-data',
                'scan_active_markets',
                {
                    'limit': 500,
                    'min_volume': 1000.0,
                    'status': 'active'
                }
            )

            markets = result.get('markets', [])
            logger.info(f"Found {len(markets)} active markets")
            return markets

        except Exception as e:
            logger.error(f"Failed to scan markets: {e}")
            return []

    def research_market(self, question: str) -> str:
        """Research a market question using Perplexity."""
        logger.info(f"Researching: {question}")

        try:
            result = self.agent.call_publisher(
                'perplexity',
                'research',
                {
                    'question': question,
                    'depth': 'standard'
                }
            )

            research = result.get('summary', '')
            logger.info(f"Research complete ({len(research)} chars)")
            return research

        except Exception as e:
            logger.error(f"Failed to research market: {e}")
            return ""

    def estimate_fair_value(self, question: str, research: str) -> Optional[Dict]:
        """Estimate fair probability using Claude via seren-models."""
        logger.info(f"Estimating fair value for: {question}")

        prompt = f"""You are a probabilistic forecaster. Based on the research below, estimate the probability that the following event will occur:

Question: {question}

Research:
{research}

Provide:
1. Your probability estimate (0-100%, as a decimal 0.0-1.0)
2. Confidence level (low/medium/high)
3. Brief reasoning (1-2 sentences)

Respond ONLY with valid JSON in this exact format:
{{
    "probability": 0.67,
    "confidence": "medium",
    "reasoning": "Based on historical trends and current data..."
}}"""

        try:
            result = self.agent.call_publisher(
                'seren-models',
                'generate',
                {
                    'model': 'claude-sonnet-4.5',
                    'prompt': prompt,
                    'temperature': 0.3,
                    'max_tokens': 500
                }
            )

            # Parse JSON response
            text = result.get('text', '').strip()

            # Try to extract JSON if response includes extra text
            if '{' in text and '}' in text:
                start = text.index('{')
                end = text.rindex('}') + 1
                json_str = text[start:end]
                estimate = json.loads(json_str)
            else:
                estimate = json.loads(text)

            # Validate response
            required_fields = ['probability', 'confidence', 'reasoning']
            if not all(field in estimate for field in required_fields):
                logger.error(f"Invalid estimate response: {estimate}")
                return None

            # Validate probability is in range
            if not (0.0 <= estimate['probability'] <= 1.0):
                logger.error(f"Probability out of range: {estimate['probability']}")
                return None

            # Validate confidence level
            if estimate['confidence'] not in ['low', 'medium', 'high']:
                logger.error(f"Invalid confidence level: {estimate['confidence']}")
                return None

            logger.info(f"Estimate: {estimate['probability']:.1%} (confidence: {estimate['confidence']})")
            return estimate

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse estimate JSON: {e}")
            return None
        except Exception as e:
            logger.error(f"Failed to estimate fair value: {e}")
            return None

    def find_opportunities(self, markets: List[Dict]) -> List[Dict]:
        """Find mispriced markets."""
        opportunities = []
        processed = 0
        max_to_research = 50  # Limit research to top 50 markets to control costs

        logger.info(f"Analyzing up to {max_to_research} markets for opportunities...")

        for market in markets[:max_to_research]:
            processed += 1

            try:
                # Research the market
                research = self.research_market(market['question'])
                if not research:
                    logger.warning(f"Skipping market (no research): {market['question']}")
                    continue

                # Estimate fair value
                estimate = self.estimate_fair_value(market['question'], research)
                if not estimate:
                    logger.warning(f"Skipping market (no estimate): {market['question']}")
                    continue

                # Skip low-confidence estimates
                if estimate['confidence'] == 'low':
                    logger.info(f"Skipping low-confidence estimate: {market['question']}")
                    continue

                fair_value = estimate['probability']
                current_price = market['current_price']
                edge = abs(fair_value - current_price)

                # Check if mispricing exceeds threshold
                if edge >= self.config['mispricing_threshold']:
                    opportunities.append({
                        'market': market,
                        'fair_value': fair_value,
                        'current_price': current_price,
                        'edge': edge,
                        'confidence': estimate['confidence'],
                        'reasoning': estimate['reasoning']
                    })

                    logger.info(f"✓ Opportunity found: {market['question']}")
                    logger.info(f"  Fair: {fair_value:.1%}, Market: {current_price:.1%}, Edge: {edge:.1%}")
                else:
                    logger.debug(f"Edge too small ({edge:.1%}): {market['question']}")

            except Exception as e:
                logger.error(f"Error analyzing market '{market.get('question', 'unknown')}': {e}")
                continue

        logger.info(f"Analyzed {processed} markets, found {len(opportunities)} opportunities")
        return opportunities

    def calculate_position_size(self, opportunity: Dict) -> float:
        """Calculate position size using Kelly criterion."""
        p = opportunity['fair_value']  # Probability of winning
        b = 1.0  # Even money bet (1:1 odds)

        # Full Kelly formula: (p * (b + 1) - 1) / b
        kelly = (p * (b + 1) - 1) / b

        # Apply quarter-Kelly for conservative sizing
        fraction_kelly = kelly * 0.25

        # Apply max Kelly fraction cap
        position_fraction = min(abs(fraction_kelly), self.config['max_kelly_fraction'])

        # Calculate dollar amount
        position_size = self.config['bankroll'] * position_fraction

        # Minimum position size
        return max(position_size, 1.0)

    def _check_rate_limit(self):
        """
        Check and enforce rate limit (60 orders/minute).
        Sleeps if necessary to stay within limits.
        """
        now = datetime.utcnow()
        cutoff = now - timedelta(seconds=self.RATE_LIMIT_WINDOW)

        # Remove timestamps older than 1 minute
        while self.order_timestamps and self.order_timestamps[0] < cutoff:
            self.order_timestamps.popleft()

        # Check if at rate limit
        if len(self.order_timestamps) >= self.MAX_ORDERS_PER_MINUTE:
            # Calculate how long to wait
            oldest = self.order_timestamps[0]
            wait_until = oldest + timedelta(seconds=self.RATE_LIMIT_WINDOW)
            wait_seconds = (wait_until - now).total_seconds()

            if wait_seconds > 0:
                logger.warning(
                    f"Rate limit reached ({self.MAX_ORDERS_PER_MINUTE} orders/min). "
                    f"Waiting {wait_seconds:.1f}s..."
                )
                time.sleep(wait_seconds)

                # Clean up old timestamps after waiting
                now = datetime.utcnow()
                cutoff = now - timedelta(seconds=self.RATE_LIMIT_WINDOW)
                while self.order_timestamps and self.order_timestamps[0] < cutoff:
                    self.order_timestamps.popleft()

    def place_trade(self, opportunity: Dict) -> Optional[Dict]:
        """Place a trade on Polymarket."""
        # Calculate position size
        position_size = self.calculate_position_size(opportunity)

        # Determine side (BUY if we think fair value > market, SELL otherwise)
        side = 'BUY' if opportunity['fair_value'] > opportunity['current_price'] else 'SELL'

        # Log trade intent
        logger.info(f"{'[DRY-RUN] ' if self.dry_run else ''}Placing {side} order:")
        logger.info(f"  Market: {opportunity['market']['question']}")
        logger.info(f"  Size: ${position_size:.2f}")
        logger.info(f"  Price: {opportunity['current_price']:.1%}")
        logger.info(f"  Fair value: {opportunity['fair_value']:.1%}")
        logger.info(f"  Edge: {opportunity['edge']:.1%}")
        logger.info(f"  Reasoning: {opportunity['reasoning']}")

        trade = {
            'timestamp': datetime.utcnow().isoformat(),
            'dry_run': self.dry_run,
            'market': opportunity['market']['question'],
            'market_id': opportunity['market'].get('id', 'unknown'),
            'side': side,
            'size': position_size,
            'price': opportunity['current_price'],
            'fair_value': opportunity['fair_value'],
            'edge': opportunity['edge'],
            'confidence': opportunity['confidence'],
            'reasoning': opportunity['reasoning'],
            'status': 'simulated' if self.dry_run else 'open',
            'pnl': None
        }

        if self.dry_run:
            # In dry-run mode, just log and return
            logger.info(f"[DRY-RUN] Trade simulated (not placed)")
            self._log_trade(trade)
            return trade

        # Check rate limit before placing order
        self._check_rate_limit()

        # Place actual order via Seren polymarket publisher
        try:
            result = self.agent.call_publisher(
                'polymarket',
                'place_order',
                {
                    'market_id': opportunity['market']['id'],
                    'side': side,
                    'size': position_size,
                    'price': opportunity['current_price'],
                    'order_type': 'limit'  # Use limit orders for better price control
                }
            )

            # Update trade with order details
            trade['order_id'] = result.get('order_id')
            trade['status'] = result.get('status', 'open')

            # Track order for rate limiting
            self.order_timestamps.append(datetime.utcnow())

            # Log trade
            self._log_trade(trade)

            logger.info(f"Order placed successfully: {trade['order_id']}")
            return trade

        except Exception as e:
            logger.error(f"Failed to place trade via MCP: {e}")
            return None

    def _log_trade(self, trade: Dict):
        """Append trade to trades log file."""
        with open(TRADES_LOG, 'a') as f:
            f.write(json.dumps(trade) + '\n')

    def _load_positions(self) -> List[Dict]:
        """Load current open positions."""
        if not POSITIONS_FILE.exists():
            return []

        try:
            with open(POSITIONS_FILE, 'r') as f:
                data = json.load(f)
                return data.get('positions', [])
        except Exception as e:
            logger.error(f"Failed to load positions: {e}")
            return []

    def _save_positions(self, positions: List[Dict]):
        """Save current positions to file."""
        data = {
            'positions': positions,
            'last_updated': datetime.utcnow().isoformat()
        }

        with open(POSITIONS_FILE, 'w') as f:
            json.dump(data, f, indent=2)

    def check_stop_loss(self) -> bool:
        """Check if stop loss threshold has been reached."""
        # Calculate current bankroll (initial - deployed capital)
        positions = self._load_positions()
        deployed = sum(p.get('size', 0) for p in positions)
        current_bankroll = self.config['bankroll'] - deployed

        if current_bankroll <= self.config['stop_loss_bankroll']:
            logger.warning(f"Stop loss triggered: ${current_bankroll:.2f} <= ${self.config['stop_loss_bankroll']:.2f}")
            return True

        return False

    def run_cycle(self):
        """Run one complete trading cycle."""
        logger.info("=" * 60)
        logger.info(f"Starting {'DRY-RUN ' if self.dry_run else ''}scan cycle")
        logger.info("=" * 60)

        cycle_start = datetime.utcnow()

        # Check balances
        balances = self.check_balances()

        if balances['serenbucks'] < 1.0:
            logger.warning("Insufficient SerenBucks balance - cannot run scan")
            logger.warning("Please deposit SerenBucks to continue")
            return

        # Check stop loss
        if self.check_stop_loss():
            logger.error("Stop loss triggered - trading halted")
            logger.error("Please increase bankroll to resume trading")
            return

        # Load current positions
        positions = self._load_positions()
        logger.info(f"Current open positions: {len(positions)}/{self.config['max_positions']}")

        # Check if at max positions
        if len(positions) >= self.config['max_positions']:
            logger.info("Max positions reached - skipping scan")
            return

        # Scan markets
        markets = self.scan_markets()
        if not markets:
            logger.warning("No markets found - skipping cycle")
            return

        # Find opportunities
        opportunities = self.find_opportunities(markets)
        logger.info(f"Found {len(opportunities)} opportunities")

        # Execute trades
        trades_executed = 0
        max_new_positions = self.config['max_positions'] - len(positions)

        for opp in opportunities[:max_new_positions]:
            trade = self.place_trade(opp)
            if trade:
                trades_executed += 1

                # Add to positions if not dry-run
                if not self.dry_run:
                    positions.append({
                        'market': trade['market'],
                        'market_id': trade['market_id'],
                        'side': trade['side'],
                        'entry_price': trade['price'],
                        'current_price': trade['price'],
                        'size': trade['size'],
                        'unrealized_pnl': 0.0,
                        'opened_at': trade['timestamp']
                    })

        # Save updated positions
        if not self.dry_run and trades_executed > 0:
            self._save_positions(positions)

        # Calculate cycle duration
        cycle_duration = (datetime.utcnow() - cycle_start).total_seconds()

        # Log scan results
        scan_result = {
            'timestamp': cycle_start.isoformat(),
            'dry_run': self.dry_run,
            'markets_scanned': len(markets),
            'opportunities_found': len(opportunities),
            'trades_executed': trades_executed,
            'cycle_duration_seconds': cycle_duration,
            'serenbucks_balance': balances['serenbucks'],
            'polymarket_balance': balances['polymarket']
        }

        with open(SCAN_LOG, 'a') as f:
            f.write(json.dumps(scan_result) + '\n')

        logger.info(f"Scan cycle complete in {cycle_duration:.1f}s")
        logger.info(f"Trades executed: {trades_executed}")
        logger.info(f"Next scan: in {self.config['scan_interval_minutes']} minutes")
        logger.info("=" * 60)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Polymarket Trading Agent - Autonomous prediction market trading'
    )
    parser.add_argument(
        '--config',
        type=Path,
        default=CONFIG_FILE,
        help='Path to config.json file'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Run in dry-run mode (simulate trades without placing real orders)'
    )

    args = parser.parse_args()

    try:
        trader = PolymarketTrader(args.config, dry_run=args.dry_run)
        trader.run_cycle()
        sys.exit(0)

    except FileNotFoundError as e:
        logger.error(f"Configuration error: {e}")
        sys.exit(1)

    except ValueError as e:
        logger.error(f"Configuration error: {e}")
        sys.exit(1)

    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
