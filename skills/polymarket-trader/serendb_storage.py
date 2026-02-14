"""
SerenDB Storage - Database client for Polymarket trading bot

Stores trading data in SerenDB cloud database:
- Positions (open positions tracking)
- Trades (executed trade history)
- Scan logs (bot activity logs)
- Config (bot configuration)
"""

import json
from typing import Dict, List, Optional, Any
from datetime import datetime
from seren_client import SerenClient


class SerenDBStorage:
    """Client for storing Polymarket bot data in SerenDB"""

    def __init__(
        self,
        seren_client: SerenClient,
        project_name: str = "polymarket-trader"
    ):
        """
        Initialize SerenDB storage

        Args:
            seren_client: SerenClient instance for API calls
            project_name: SerenDB project name (default: polymarket-trader)
        """
        self.seren = seren_client
        self.project_name = project_name
        self.project_id: Optional[str] = None
        self.branch_id: Optional[str] = None
        self.database_name = "trading_db"

    def setup_database(self) -> bool:
        """
        Create SerenDB project and tables if they don't exist

        Returns:
            True if setup successful, False otherwise
        """
        try:
            # Step 1: Get or create project
            print(f"Setting up SerenDB project '{self.project_name}'...")

            projects = self._list_projects()
            project = next((p for p in projects if p['name'] == self.project_name), None)

            if not project:
                print(f"  Creating new project...")
                project = self._create_project(self.project_name)
                print(f"  ✓ Project created: {project['id']}")
            else:
                print(f"  ✓ Project found: {project['id']}")

            self.project_id = project['id']

            # Step 2: Get main branch
            branches = self._list_branches(self.project_id)
            main_branch = next((b for b in branches if b['name'] == 'main'), None)

            if not main_branch:
                raise Exception("Main branch not found")

            self.branch_id = main_branch['id']
            print(f"  ✓ Using branch: {self.branch_id}")

            # Step 3: Create tables
            print("  Creating tables...")

            # Create positions table
            self._execute_sql("""
                CREATE TABLE IF NOT EXISTS positions (
                    id SERIAL PRIMARY KEY,
                    market_id TEXT UNIQUE NOT NULL,
                    market TEXT NOT NULL,
                    token_id TEXT,
                    side TEXT NOT NULL,
                    entry_price REAL NOT NULL,
                    current_price REAL NOT NULL,
                    size REAL NOT NULL,
                    unrealized_pnl REAL DEFAULT 0.0,
                    opened_at TIMESTAMP NOT NULL,
                    updated_at TIMESTAMP NOT NULL
                )
            """)

            # Create trades table
            self._execute_sql("""
                CREATE TABLE IF NOT EXISTS trades (
                    id SERIAL PRIMARY KEY,
                    market_id TEXT NOT NULL,
                    market TEXT NOT NULL,
                    side TEXT NOT NULL,
                    price REAL NOT NULL,
                    size REAL NOT NULL,
                    executed_at TIMESTAMP NOT NULL,
                    tx_hash TEXT
                )
            """)

            # Create scan_logs table
            self._execute_sql("""
                CREATE TABLE IF NOT EXISTS scan_logs (
                    id SERIAL PRIMARY KEY,
                    scan_at TIMESTAMP NOT NULL,
                    markets_scanned INTEGER NOT NULL,
                    opportunities_found INTEGER NOT NULL,
                    trades_executed INTEGER NOT NULL,
                    capital_deployed REAL NOT NULL,
                    api_cost REAL NOT NULL,
                    serenbucks_balance REAL,
                    polymarket_balance REAL
                )
            """)

            # Create config table
            self._execute_sql("""
                CREATE TABLE IF NOT EXISTS config (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMP NOT NULL
                )
            """)

            print(f"✅ SerenDB setup complete")
            return True

        except Exception as e:
            print(f"❌ Failed to setup database: {e}")
            import traceback
            traceback.print_exc()
            return False

    # Position methods

    def save_position(self, position: Dict[str, Any]) -> bool:
        """
        Save or update a position

        Args:
            position: Position data dict

        Returns:
            True if successful
        """
        try:
            now = datetime.utcnow().isoformat() + 'Z'

            # Try to update existing position first
            result = self._execute_sql("""
                UPDATE positions
                SET current_price = ?,
                    unrealized_pnl = ?,
                    updated_at = ?
                WHERE market_id = ?
            """, (
                position['current_price'],
                position['unrealized_pnl'],
                now,
                position['market_id']
            ))

            # If no rows updated, insert new position
            if result.get('changes', 0) == 0:
                self._execute_sql("""
                    INSERT INTO positions (
                        market_id, market, token_id, side,
                        entry_price, current_price, size,
                        unrealized_pnl, opened_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    position['market_id'],
                    position['market'],
                    position.get('token_id', ''),
                    position['side'],
                    position['entry_price'],
                    position['current_price'],
                    position['size'],
                    position['unrealized_pnl'],
                    position['opened_at'],
                    now
                ))

            return True

        except Exception as e:
            print(f"Error saving position: {e}")
            return False

    def get_positions(self) -> List[Dict[str, Any]]:
        """
        Get all open positions

        Returns:
            List of position dicts
        """
        try:
            result = self._execute_sql("SELECT * FROM positions ORDER BY opened_at DESC")
            return result.get('rows', [])
        except Exception as e:
            print(f"Error getting positions: {e}")
            return []

    def get_position(self, market_id: str) -> Optional[Dict[str, Any]]:
        """
        Get a specific position by market_id

        Args:
            market_id: Market ID

        Returns:
            Position dict or None
        """
        try:
            result = self._execute_sql(
                "SELECT * FROM positions WHERE market_id = ?",
                (market_id,)
            )
            rows = result.get('rows', [])
            return rows[0] if rows else None
        except Exception as e:
            print(f"Error getting position: {e}")
            return None

    def delete_position(self, market_id: str) -> bool:
        """
        Delete a position

        Args:
            market_id: Market ID

        Returns:
            True if successful
        """
        try:
            self._execute_sql("DELETE FROM positions WHERE market_id = ?", (market_id,))
            return True
        except Exception as e:
            print(f"Error deleting position: {e}")
            return False

    # Trade methods

    def save_trade(self, trade: Dict[str, Any]) -> bool:
        """
        Save a trade execution

        Args:
            trade: Trade data dict

        Returns:
            True if successful
        """
        try:
            self._execute_sql("""
                INSERT INTO trades (
                    market_id, market, side, price, size, executed_at, tx_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                trade['market_id'],
                trade['market'],
                trade['side'],
                trade['price'],
                trade['size'],
                trade['executed_at'],
                trade.get('tx_hash', '')
            ))
            return True
        except Exception as e:
            print(f"Error saving trade: {e}")
            return False

    def get_trades(self, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Get recent trades

        Args:
            limit: Maximum number of trades to return

        Returns:
            List of trade dicts
        """
        try:
            result = self._execute_sql(
                "SELECT * FROM trades ORDER BY executed_at DESC LIMIT ?",
                (limit,)
            )
            return result.get('rows', [])
        except Exception as e:
            print(f"Error getting trades: {e}")
            return []

    # Scan log methods

    def save_scan_log(self, log: Dict[str, Any]) -> bool:
        """
        Save a scan cycle log

        Args:
            log: Scan log data dict

        Returns:
            True if successful
        """
        try:
            self._execute_sql("""
                INSERT INTO scan_logs (
                    scan_at, markets_scanned, opportunities_found,
                    trades_executed, capital_deployed, api_cost,
                    serenbucks_balance, polymarket_balance
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                log['scan_at'],
                log['markets_scanned'],
                log['opportunities_found'],
                log['trades_executed'],
                log['capital_deployed'],
                log['api_cost'],
                log.get('serenbucks_balance'),
                log.get('polymarket_balance')
            ))
            return True
        except Exception as e:
            print(f"Error saving scan log: {e}")
            return False

    def get_scan_logs(self, limit: int = 50) -> List[Dict[str, Any]]:
        """
        Get recent scan logs

        Args:
            limit: Maximum number of logs to return

        Returns:
            List of scan log dicts
        """
        try:
            result = self._execute_sql(
                "SELECT * FROM scan_logs ORDER BY scan_at DESC LIMIT ?",
                (limit,)
            )
            return result.get('rows', [])
        except Exception as e:
            print(f"Error getting scan logs: {e}")
            return []

    # Config methods

    def save_config(self, key: str, value: Any) -> bool:
        """
        Save a config value

        Args:
            key: Config key
            value: Config value (will be JSON serialized)

        Returns:
            True if successful
        """
        try:
            now = datetime.utcnow().isoformat() + 'Z'
            value_json = json.dumps(value)

            # Try update first
            result = self._execute_sql(
                "UPDATE config SET value = ?, updated_at = ? WHERE key = ?",
                (value_json, now, key)
            )

            # If no rows updated, insert
            if result.get('changes', 0) == 0:
                self._execute_sql(
                    "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)",
                    (key, value_json, now)
                )

            return True
        except Exception as e:
            print(f"Error saving config: {e}")
            return False

    def get_config(self, key: str, default: Any = None) -> Any:
        """
        Get a config value

        Args:
            key: Config key
            default: Default value if key not found

        Returns:
            Config value (JSON deserialized)
        """
        try:
            result = self._execute_sql(
                "SELECT value FROM config WHERE key = ?",
                (key,)
            )
            rows = result.get('rows', [])
            if rows:
                return json.loads(rows[0]['value'])
            return default
        except Exception as e:
            print(f"Error getting config: {e}")
            return default

    # Private helper methods

    def _execute_sql(self, query: str, params: tuple = ()) -> Dict[str, Any]:
        """
        Execute SQL query via SerenDB REST API

        Args:
            query: SQL query string
            params: Query parameters (for parameterized queries)

        Returns:
            Query result dict
        """
        if not self.project_id or not self.branch_id:
            raise Exception("Database not initialized. Call setup_database() first.")

        # Format parameterized query
        if params:
            # Convert Python parameterized query to SQL
            # Replace ? with actual values (properly escaped)
            for param in params:
                if isinstance(param, str):
                    # Escape single quotes in strings
                    escaped = param.replace("'", "''")
                    query = query.replace('?', f"'{escaped}'", 1)
                elif param is None:
                    query = query.replace('?', 'NULL', 1)
                else:
                    query = query.replace('?', str(param), 1)

        # Call Seren Gateway database API
        url = f"{self.seren.gateway_url}/databases/projects/{self.project_id}/branches/{self.branch_id}/query"

        response = self.seren.session.post(
            url,
            json={'query': query},
            timeout=30
        )

        response.raise_for_status()
        return response.json()

    def _list_projects(self) -> List[Dict[str, Any]]:
        """List all SerenDB projects"""
        url = f"{self.seren.gateway_url}/databases/projects"
        response = self.seren.session.get(url, timeout=10)
        response.raise_for_status()
        return response.json().get('data', [])

    def _create_project(self, name: str) -> Dict[str, Any]:
        """Create a new SerenDB project"""
        url = f"{self.seren.gateway_url}/databases/projects"
        response = self.seren.session.post(
            url,
            json={'name': name, 'region': 'aws-us-east-2'},
            timeout=30
        )
        response.raise_for_status()
        data = response.json()
        # Return full project details
        project_id = data['data']['id']
        return self._get_project(project_id)

    def _get_project(self, project_id: str) -> Dict[str, Any]:
        """Get project details"""
        url = f"{self.seren.gateway_url}/databases/projects/{project_id}"
        response = self.seren.session.get(url, timeout=10)
        response.raise_for_status()
        return response.json().get('data', {})

    def _list_branches(self, project_id: str) -> List[Dict[str, Any]]:
        """List branches for a project"""
        url = f"{self.seren.gateway_url}/databases/projects/{project_id}/branches"
        response = self.seren.session.get(url, timeout=10)
        response.raise_for_status()
        return response.json().get('data', [])
