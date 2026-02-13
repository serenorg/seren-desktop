"""
Position Tracker - Manages open positions and P&L calculation

Tracks:
- Open positions with entry prices
- Unrealized P&L
- Position updates
- Current bankroll calculation
"""

import json
import os
from typing import List, Dict, Optional
from datetime import datetime


class Position:
    """Represents a single position"""

    def __init__(
        self,
        market: str,
        market_id: str,
        token_id: str,
        side: str,
        entry_price: float,
        size: float,
        opened_at: str
    ):
        self.market = market
        self.market_id = market_id
        self.token_id = token_id
        self.side = side  # 'BUY' or 'SELL'
        self.entry_price = entry_price
        self.size = size
        self.opened_at = opened_at
        self.current_price = entry_price  # Will be updated
        self.unrealized_pnl = 0.0

    def update_price(self, current_price: float):
        """Update current price and calculate unrealized P&L"""
        self.current_price = current_price

        if self.side == 'BUY':
            # P&L = (current - entry) * shares
            # shares = size / entry_price
            shares = self.size / self.entry_price
            self.unrealized_pnl = (current_price - self.entry_price) * shares
        elif self.side == 'SELL':
            # For SELL positions, we profit when price goes down
            shares = self.size / (1 - self.entry_price)
            self.unrealized_pnl = (self.entry_price - current_price) * shares

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization"""
        return {
            'market': self.market,
            'market_id': self.market_id,
            'token_id': self.token_id,
            'side': self.side,
            'entry_price': self.entry_price,
            'current_price': self.current_price,
            'size': self.size,
            'unrealized_pnl': round(self.unrealized_pnl, 2),
            'opened_at': self.opened_at
        }

    @classmethod
    def from_dict(cls, data: Dict) -> 'Position':
        """Create Position from dictionary"""
        pos = cls(
            market=data['market'],
            market_id=data['market_id'],
            token_id=data['token_id'],
            side=data['side'],
            entry_price=data['entry_price'],
            size=data['size'],
            opened_at=data['opened_at']
        )
        pos.current_price = data.get('current_price', data['entry_price'])
        pos.unrealized_pnl = data.get('unrealized_pnl', 0.0)
        return pos


class PositionTracker:
    """Tracks all open positions and P&L"""

    def __init__(self, positions_file: str = 'logs/positions.json'):
        self.positions_file = positions_file
        self.positions: Dict[str, Position] = {}
        self.load()

    def load(self):
        """Load positions from file"""
        if not os.path.exists(self.positions_file):
            self.positions = {}
            return

        try:
            with open(self.positions_file, 'r') as f:
                data = json.load(f)

            self.positions = {}
            for pos_data in data.get('positions', []):
                pos = Position.from_dict(pos_data)
                self.positions[pos.market_id] = pos

        except Exception as e:
            print(f"Error loading positions: {e}")
            self.positions = {}

    def save(self):
        """Save positions to file"""
        os.makedirs(os.path.dirname(self.positions_file), exist_ok=True)

        data = {
            'positions': [pos.to_dict() for pos in self.positions.values()],
            'total_unrealized_pnl': self.get_total_unrealized_pnl(),
            'position_count': len(self.positions),
            'last_updated': datetime.utcnow().isoformat() + 'Z'
        }

        with open(self.positions_file, 'w') as f:
            json.dump(data, f, indent=2)

    def add_position(
        self,
        market: str,
        market_id: str,
        token_id: str,
        side: str,
        entry_price: float,
        size: float
    ) -> Position:
        """
        Add a new position

        Args:
            market: Market question/name
            market_id: Market ID
            token_id: Token ID
            side: 'BUY' or 'SELL'
            entry_price: Entry price (0.0-1.0)
            size: Position size in USDC

        Returns:
            Created Position object
        """
        pos = Position(
            market=market,
            market_id=market_id,
            token_id=token_id,
            side=side,
            entry_price=entry_price,
            size=size,
            opened_at=datetime.utcnow().isoformat() + 'Z'
        )

        self.positions[market_id] = pos
        self.save()
        return pos

    def remove_position(self, market_id: str) -> Optional[Position]:
        """Remove a position"""
        pos = self.positions.pop(market_id, None)
        if pos:
            self.save()
        return pos

    def update_prices(self, prices: Dict[str, float]):
        """
        Update current prices for positions

        Args:
            prices: Dict mapping market_id -> current_price
        """
        for market_id, price in prices.items():
            if market_id in self.positions:
                self.positions[market_id].update_price(price)

        self.save()

    def get_position(self, market_id: str) -> Optional[Position]:
        """Get a specific position"""
        return self.positions.get(market_id)

    def get_all_positions(self) -> List[Position]:
        """Get all positions"""
        return list(self.positions.values())

    def get_total_unrealized_pnl(self) -> float:
        """Calculate total unrealized P&L across all positions"""
        return sum(pos.unrealized_pnl for pos in self.positions.values())

    def get_total_deployed(self) -> float:
        """Calculate total capital deployed in positions"""
        return sum(pos.size for pos in self.positions.values())

    def get_current_bankroll(self, initial_bankroll: float) -> float:
        """
        Calculate current bankroll

        Args:
            initial_bankroll: Starting bankroll

        Returns:
            Current bankroll (initial + unrealized P&L)
        """
        return initial_bankroll + self.get_total_unrealized_pnl()

    def get_available_capital(self, initial_bankroll: float) -> float:
        """
        Calculate available capital (not deployed)

        Args:
            initial_bankroll: Starting bankroll

        Returns:
            Available capital
        """
        current = self.get_current_bankroll(initial_bankroll)
        deployed = self.get_total_deployed()
        return current - deployed

    def has_position(self, market_id: str) -> bool:
        """Check if we have a position in this market"""
        return market_id in self.positions
