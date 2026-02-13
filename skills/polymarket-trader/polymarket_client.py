"""
Polymarket Client - Wrapper for Polymarket CLOB API via Seren

Uses the polymarket-trading-serenai publisher to:
- Get market data (prices, order book, positions)
- Place and cancel orders
- Track positions and P&L
"""

import os
import json
import hashlib
from typing import Dict, List, Any, Optional
from seren_client import SerenClient


class PolymarketClient:
    """Client for Polymarket CLOB API via Seren publisher"""

    def __init__(
        self,
        seren_client: SerenClient,
        poly_api_key: Optional[str] = None,
        poly_passphrase: Optional[str] = None,
        poly_secret: Optional[str] = None,
        poly_address: Optional[str] = None
    ):
        """
        Initialize Polymarket client

        Args:
            seren_client: Seren client instance
            poly_api_key: Polymarket API key (from env if not provided)
            poly_passphrase: Polymarket passphrase
            poly_secret: Polymarket secret
            poly_address: Polymarket wallet address
        """
        self.seren = seren_client

        # Get credentials from env if not provided
        self.poly_api_key = poly_api_key or os.getenv('POLY_API_KEY')
        self.poly_passphrase = poly_passphrase or os.getenv('POLY_PASSPHRASE')
        self.poly_secret = poly_secret or os.getenv('POLY_SECRET')
        self.poly_address = poly_address or os.getenv('POLY_ADDRESS')

        if not all([self.poly_api_key, self.poly_passphrase, self.poly_address]):
            raise ValueError(
                "Polymarket credentials required: POLY_API_KEY, POLY_PASSPHRASE, POLY_ADDRESS"
            )

    def _get_auth_headers(self) -> Dict[str, str]:
        """Get authentication headers for Polymarket API"""
        return {
            'POLY_API_KEY': self.poly_api_key,
            'POLY_PASSPHRASE': self.poly_passphrase,
            'POLY_ADDRESS': self.poly_address
        }

    def get_markets(self, limit: int = 500, active: bool = True) -> List[Dict]:
        """
        Get list of prediction markets

        Args:
            limit: Max markets to return
            active: Only active markets

        Returns:
            List of market dicts with format:
            {
                'market_id': str,
                'question': str,
                'token_id': str,
                'price': float (0.0-1.0),
                'volume': float,
                'liquidity': float,
                'end_date': str
            }
        """
        # Call polymarket-data publisher to get markets
        response = self.seren.call_publisher(
            publisher='polymarket-data',
            method='GET',
            path='/markets',
            body={
                'limit': limit,
                'active': active,
                'closed': False
            }
        )

        markets = []

        # Parse response and normalize to our format
        for market_data in response.get('data', []):
            # Extract relevant fields
            market_id = market_data.get('condition_id') or market_data.get('id')
            question = market_data.get('question', '')

            # Get YES token ID (we trade YES/NO outcomes)
            tokens = market_data.get('tokens', [])
            yes_token = None
            for token in tokens:
                if token.get('outcome', '').upper() == 'YES':
                    yes_token = token
                    break

            if not yes_token:
                continue  # Skip markets without YES token

            token_id = yes_token.get('token_id', '')

            # Get current price (best ask for YES)
            price = float(market_data.get('outcome_prices', [0.5])[0])  # Default to 50%

            # Volume and liquidity
            volume = float(market_data.get('volume', 0))
            liquidity = float(market_data.get('liquidity', 0))

            # End date
            end_date = market_data.get('end_date_iso', '')

            # Only include markets with sufficient liquidity
            if liquidity < 100:  # Skip markets with < $100 liquidity
                continue

            markets.append({
                'market_id': market_id,
                'question': question,
                'token_id': token_id,
                'price': price,
                'volume': volume,
                'liquidity': liquidity,
                'end_date': end_date
            })

        return markets[:limit]

    def get_price(self, token_id: str, side: str) -> float:
        """
        Get current price for a token

        Args:
            token_id: ERC1155 token ID
            side: 'BUY' or 'SELL'

        Returns:
            Price as float (0.0-1.0)
        """
        response = self.seren.call_publisher(
            publisher='polymarket-trading-serenai',
            method='GET',
            path='/price',
            headers=self._get_auth_headers(),
            body={'token_id': token_id, 'side': side}
        )
        return float(response.get('price', 0))

    def get_midpoint(self, token_id: str) -> float:
        """
        Get midpoint price (average of best bid and ask)

        Args:
            token_id: ERC1155 token ID

        Returns:
            Midpoint price as float (0.0-1.0)
        """
        response = self.seren.call_publisher(
            publisher='polymarket-trading-serenai',
            method='GET',
            path='/midpoint',
            headers=self._get_auth_headers(),
            body={'token_id': token_id}
        )
        return float(response.get('mid', 0))

    def get_positions(self) -> List[Dict]:
        """
        Get current positions

        Returns:
            List of position dicts with market, size, entry_price, etc.
        """
        response = self.seren.call_publisher(
            publisher='polymarket-trading-serenai',
            method='GET',
            path='/positions',
            headers=self._get_auth_headers()
        )
        return response.get('data', [])

    def get_open_orders(self, market: Optional[str] = None) -> List[Dict]:
        """
        Get open orders

        Args:
            market: Filter by market ID (optional)

        Returns:
            List of open orders
        """
        body = {}
        if market:
            body['market'] = market

        response = self.seren.call_publisher(
            publisher='polymarket-trading-serenai',
            method='GET',
            path='/orders',
            headers=self._get_auth_headers(),
            body=body if body else None
        )
        return response.get('data', [])

    def _build_eip712_order(
        self,
        token_id: str,
        side: str,
        size: float,
        price: float,
        order_type: str = 'GTC'
    ) -> Dict[str, Any]:
        """
        Build EIP-712 typed data for order

        Args:
            token_id: ERC1155 token ID
            side: 'BUY' or 'SELL'
            size: Order size in USDC
            price: Limit price (0.0-1.0)
            order_type: Order type (GTC, GTD, FOK, FAK)

        Returns:
            EIP-712 typed data structure
        """
        # Convert to maker/taker amounts
        # For BUY orders: maker_amount is USDC we're spending
        # For SELL orders: maker_amount is tokens we're selling
        if side == 'BUY':
            maker_amount = int(size * 1e6)  # USDC has 6 decimals
            taker_amount = int((size / price) * 1e6) if price > 0 else 0
        else:  # SELL
            maker_amount = int(size * 1e6)
            taker_amount = int(size * price * 1e6)

        # Build EIP-712 domain
        domain = {
            'name': 'Polymarket CTF Exchange',
            'version': '1',
            'chainId': 137,  # Polygon mainnet
            'verifyingContract': '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'  # CLOB contract
        }

        # Build order struct
        import time
        nonce = int(time.time() * 1000)  # Millisecond timestamp as nonce
        expiration = int(time.time()) + 86400  # 24 hours from now

        message = {
            'salt': nonce,
            'maker': self.poly_address,
            'signer': self.poly_address,
            'taker': '0x0000000000000000000000000000000000000000',  # Anyone can fill
            'tokenId': token_id,
            'makerAmount': str(maker_amount),
            'takerAmount': str(taker_amount),
            'side': side,
            'expiration': str(expiration),
            'nonce': str(nonce),
            'feeRateBps': '0',  # 0 basis points fee
            'signatureType': 0  # EOA signature
        }

        # EIP-712 types
        types = {
            'EIP712Domain': [
                {'name': 'name', 'type': 'string'},
                {'name': 'version', 'type': 'string'},
                {'name': 'chainId', 'type': 'uint256'},
                {'name': 'verifyingContract', 'type': 'address'}
            ],
            'Order': [
                {'name': 'salt', 'type': 'uint256'},
                {'name': 'maker', 'type': 'address'},
                {'name': 'signer', 'type': 'address'},
                {'name': 'taker', 'type': 'address'},
                {'name': 'tokenId', 'type': 'uint256'},
                {'name': 'makerAmount', 'type': 'uint256'},
                {'name': 'takerAmount', 'type': 'uint256'},
                {'name': 'side', 'type': 'uint8'},
                {'name': 'expiration', 'type': 'uint256'},
                {'name': 'nonce', 'type': 'uint256'},
                {'name': 'feeRateBps', 'type': 'uint256'},
                {'name': 'signatureType', 'type': 'uint8'}
            ]
        }

        return {
            'types': types,
            'domain': domain,
            'primaryType': 'Order',
            'message': message
        }

    def _sign_order(self, typed_data: Dict[str, Any]) -> str:
        """
        Sign EIP-712 typed data with private key

        Note: This requires eth-account library and private key.
        For production, the private key should be securely managed.

        Args:
            typed_data: EIP-712 typed data structure

        Returns:
            Hex-encoded signature
        """
        try:
            from eth_account import Account
            from eth_account.messages import encode_structured_data

            # Get private key from environment
            private_key = os.getenv('POLY_PRIVATE_KEY')
            if not private_key:
                raise ValueError("POLY_PRIVATE_KEY environment variable required for signing")

            # Encode structured data
            encoded_data = encode_structured_data(typed_data)

            # Sign
            account = Account.from_key(private_key)
            signed_message = account.sign_message(encoded_data)

            # Return signature as hex
            return signed_message.signature.hex()

        except ImportError:
            raise ImportError(
                "eth-account library required for EIP-712 signing. "
                "Install with: pip install eth-account"
            )

    def place_order(
        self,
        token_id: str,
        side: str,
        size: float,
        price: float,
        order_type: str = 'GTC'
    ) -> Dict:
        """
        Place an order

        Args:
            token_id: ERC1155 token ID
            side: 'BUY' or 'SELL'
            size: Order size in USDC
            price: Limit price (0.0-1.0)
            order_type: Order type (GTC, GTD, FOK, FAK)

        Returns:
            Order details
        """
        # Build EIP-712 typed data
        typed_data = self._build_eip712_order(token_id, side, size, price, order_type)

        # Sign the order
        signature = self._sign_order(typed_data)

        # Submit signed order to Polymarket CLOB
        order_data = {
            **typed_data['message'],
            'signature': signature,
            'orderType': order_type
        }

        response = self.seren.call_publisher(
            publisher='polymarket-trading-serenai',
            method='POST',
            path='/order',
            headers=self._get_auth_headers(),
            body=order_data
        )
        return response

    def cancel_order(self, order_id: str) -> Dict:
        """
        Cancel an open order

        Args:
            order_id: Order ID to cancel

        Returns:
            Cancellation confirmation
        """
        response = self.seren.call_publisher(
            publisher='polymarket-trading-serenai',
            method='DELETE',
            path='/order',
            headers=self._get_auth_headers(),
            body={'orderID': order_id}
        )
        return response

    def get_balance(self) -> float:
        """
        Get USDC balance

        Note: This would need to query the actual wallet balance
        For now, we'll calculate from positions

        Returns:
            Balance in USDC
        """
        # TODO: Implement actual balance checking
        # This would need to query the blockchain or Polymarket API
        positions = self.get_positions()

        # Calculate total value from positions
        total = 0.0
        for pos in positions:
            total += float(pos.get('size', 0))

        return total
