// ABOUTME: Tauri IPC command handlers for Polymarket CLOB API authentication.
// ABOUTME: Provides credential storage and HMAC-SHA256 L2 signing via Tauri commands.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

use super::PolymarketError;
use super::signing::{ApiCredentials, build_l2_headers};
use super::websocket::{Channel, PolymarketWebSocket};

const POLYMARKET_STORE: &str = "polymarket.json";
const PM_API_KEY: &str = "api_key";
const PM_API_SECRET: &str = "api_secret";
const PM_PASSPHRASE: &str = "passphrase";
const PM_WALLET_ADDRESS: &str = "wallet_address";

/// Result type for Polymarket commands (serializable for IPC)
#[derive(Debug, Serialize, Deserialize)]
pub struct PolymarketCommandResult<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> PolymarketCommandResult<T> {
    fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    fn err(error: impl ToString) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.to_string()),
        }
    }
}

/// Request to store Polymarket API credentials
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorePolymarketCredentialsRequest {
    pub api_key: String,
    pub api_secret: String,
    pub passphrase: String,
    pub wallet_address: String,
}

/// Store Polymarket CLOB API credentials in encrypted store.
///
/// Credentials are obtained from Polymarket's "Derive API Key" flow
/// and consist of apiKey, secret, and passphrase.
///
/// # Security
/// Credentials are stored using Tauri's encrypted store and never logged.
#[tauri::command]
pub async fn store_polymarket_credentials<R: Runtime>(
    app: AppHandle<R>,
    request: StorePolymarketCredentialsRequest,
) -> PolymarketCommandResult<String> {
    if request.api_key.trim().is_empty()
        || request.api_secret.trim().is_empty()
        || request.passphrase.trim().is_empty()
    {
        return PolymarketCommandResult::err("API key, secret, and passphrase are all required");
    }
    if request.wallet_address.trim().is_empty() {
        return PolymarketCommandResult::err("Wallet address is required");
    }

    let store = match app.store(POLYMARKET_STORE) {
        Ok(s) => s,
        Err(e) => {
            return PolymarketCommandResult::err(format!("Failed to open store: {}", e));
        }
    };

    store.set(PM_API_KEY, serde_json::json!(request.api_key));
    store.set(PM_API_SECRET, serde_json::json!(request.api_secret));
    store.set(PM_PASSPHRASE, serde_json::json!(request.passphrase));
    store.set(PM_WALLET_ADDRESS, serde_json::json!(request.wallet_address));

    if let Err(e) = store.save() {
        return PolymarketCommandResult::err(format!("Failed to save store: {}", e));
    }

    PolymarketCommandResult::ok(request.wallet_address)
}

/// Get the configured Polymarket wallet address, if any.
///
/// Returns the address without loading the API secret.
#[tauri::command]
pub async fn get_polymarket_address<R: Runtime>(
    app: AppHandle<R>,
) -> PolymarketCommandResult<Option<String>> {
    let store = match app.store(POLYMARKET_STORE) {
        Ok(s) => s,
        Err(_) => return PolymarketCommandResult::ok(None),
    };

    let address = store
        .get(PM_WALLET_ADDRESS)
        .and_then(|v| v.as_str().map(String::from));

    PolymarketCommandResult::ok(address)
}

/// Clear all Polymarket credentials from the store.
#[tauri::command]
pub async fn clear_polymarket_credentials<R: Runtime>(
    app: AppHandle<R>,
) -> PolymarketCommandResult<()> {
    let store = match app.store(POLYMARKET_STORE) {
        Ok(s) => s,
        Err(_) => return PolymarketCommandResult::ok(()),
    };

    store.delete(PM_API_KEY);
    store.delete(PM_API_SECRET);
    store.delete(PM_PASSPHRASE);
    store.delete(PM_WALLET_ADDRESS);

    if let Err(e) = store.save() {
        return PolymarketCommandResult::err(format!("Failed to save store: {}", e));
    }

    PolymarketCommandResult::ok(())
}

/// Request to sign a Polymarket CLOB API call
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignPolymarketRequest {
    /// HTTP method (GET, POST, DELETE)
    pub method: String,
    /// API path (e.g., "/orders")
    pub path: String,
    /// Request body (JSON string, empty for GET)
    #[serde(default)]
    pub body: String,
}

/// Signed L2 authentication headers
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignPolymarketResponse {
    pub poly_address: String,
    pub poly_signature: String,
    pub poly_timestamp: String,
    pub poly_api_key: String,
    pub poly_passphrase: String,
}

/// Sign a Polymarket CLOB API request with HMAC-SHA256 (L2 auth).
///
/// Loads stored credentials and generates all five POLY_* headers
/// needed for authenticated requests to the CLOB API.
///
/// # Arguments
/// * `method` - HTTP method (GET, POST, DELETE)
/// * `path` - API path (e.g., "/orders")
/// * `body` - Request body JSON string (empty for GET)
///
/// # Returns
/// All five POLY_* headers for the authenticated request
#[tauri::command]
pub async fn sign_polymarket_request<R: Runtime>(
    app: AppHandle<R>,
    request: SignPolymarketRequest,
) -> PolymarketCommandResult<SignPolymarketResponse> {
    let store = match app.store(POLYMARKET_STORE) {
        Ok(s) => s,
        Err(e) => {
            return PolymarketCommandResult::err(format!("Failed to open store: {}", e));
        }
    };

    // Load credentials from encrypted store
    let api_key = match store
        .get(PM_API_KEY)
        .and_then(|v| v.as_str().map(String::from))
    {
        Some(k) => k,
        None => return PolymarketCommandResult::err(PolymarketError::NotConfigured),
    };
    let api_secret = match store
        .get(PM_API_SECRET)
        .and_then(|v| v.as_str().map(String::from))
    {
        Some(s) => s,
        None => return PolymarketCommandResult::err(PolymarketError::NotConfigured),
    };
    let passphrase = match store
        .get(PM_PASSPHRASE)
        .and_then(|v| v.as_str().map(String::from))
    {
        Some(p) => p,
        None => return PolymarketCommandResult::err(PolymarketError::NotConfigured),
    };
    let address = match store
        .get(PM_WALLET_ADDRESS)
        .and_then(|v| v.as_str().map(String::from))
    {
        Some(a) => a,
        None => return PolymarketCommandResult::err(PolymarketError::NotConfigured),
    };

    let credentials = ApiCredentials {
        api_key,
        api_secret,
        passphrase,
    };

    let headers = match build_l2_headers(
        &credentials,
        &address,
        &request.method,
        &request.path,
        &request.body,
    ) {
        Ok(h) => h,
        Err(e) => return PolymarketCommandResult::err(e),
    };

    PolymarketCommandResult::ok(SignPolymarketResponse {
        poly_address: headers.poly_address,
        poly_signature: headers.poly_signature,
        poly_timestamp: headers.poly_timestamp,
        poly_api_key: headers.poly_api_key,
        poly_passphrase: headers.poly_passphrase,
    })
}

// ============================================================================
// WebSocket Commands
// ============================================================================

/// Global WebSocket client state
pub type PolymarketWsState<R = tauri::Wry> = Arc<Mutex<Option<PolymarketWebSocket<R>>>>;

/// Connect to Polymarket WebSocket for real-time updates
#[tauri::command]
pub async fn connect_polymarket_websocket<R: Runtime>(
    app: AppHandle<R>,
    ws_state: State<'_, PolymarketWsState<R>>,
) -> Result<String, String> {
    let mut state = ws_state.lock().await;

    if state.is_some() {
        return Ok("Already connected".to_string());
    }

    let ws_client = PolymarketWebSocket::new(app.clone());

    match ws_client.connect().await {
        Ok(()) => {
            *state = Some(ws_client);
            Ok("Connected to Polymarket WebSocket".to_string())
        }
        Err(e) => Err(format!("Failed to connect: {}", e)),
    }
}

/// Subscribe to market price updates
#[tauri::command]
pub async fn subscribe_polymarket_market<R: Runtime>(
    market_id: String,
    ws_state: State<'_, PolymarketWsState<R>>,
) -> Result<String, String> {
    let state = ws_state.lock().await;

    match &*state {
        Some(ws) => {
            let channel = Channel::Market { market_id: market_id.clone() };
            match ws.subscribe(channel).await {
                Ok(()) => Ok(format!("Subscribed to market {}", market_id)),
                Err(e) => Err(format!("Subscription failed: {}", e)),
            }
        }
        None => Err("WebSocket not connected".to_string()),
    }
}

/// Subscribe to user order updates (authenticated)
#[tauri::command]
pub async fn subscribe_polymarket_user<R: Runtime>(
    app: AppHandle<R>,
    ws_state: State<'_, PolymarketWsState<R>>,
) -> Result<String, String> {
    // Load API key from store
    let store = match app.store(POLYMARKET_STORE) {
        Ok(s) => s,
        Err(e) => {
            return Err(format!("Failed to open store: {}", e));
        }
    };

    let api_key = match store
        .get(PM_API_KEY)
        .and_then(|v| v.as_str().map(String::from))
    {
        Some(k) => k,
        None => return Err("Credentials not configured".to_string()),
    };

    let state = ws_state.lock().await;

    match &*state {
        Some(ws) => {
            let channel = Channel::User { api_key };
            match ws.subscribe(channel).await {
                Ok(()) => Ok("Subscribed to user updates".to_string()),
                Err(e) => Err(format!("Subscription failed: {}", e)),
            }
        }
        None => Err("WebSocket not connected".to_string()),
    }
}
