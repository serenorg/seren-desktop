// ABOUTME: Tauri IPC command handlers for crypto wallet operations.
// ABOUTME: Provides secure storage, x402 payment signing, and balance fetching via Tauri commands.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use super::{PaymentRequirements, PrivateKeyWallet, WalletError, build_x402_payment_payload};

const WALLET_STORE: &str = "crypto-wallet.json";
const PRIVATE_KEY_KEY: &str = "private_key";
const WALLET_ADDRESS_KEY: &str = "wallet_address";

// Base mainnet RPC URL and USDC contract
const BASE_RPC_URL: &str = "https://mainnet.base.org";
const USDC_CONTRACT_BASE: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/// Result type for wallet commands (serializable for IPC)
#[derive(Debug, Serialize, Deserialize)]
pub struct WalletCommandResult<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> WalletCommandResult<T> {
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

/// Store a crypto private key and return the derived wallet address.
///
/// The private key is stored in Tauri's encrypted store and never logged.
///
/// # Arguments
/// * `private_key` - Hex-encoded private key (64 chars, with or without 0x prefix)
///
/// # Returns
/// The Ethereum address derived from the private key
#[tauri::command]
pub async fn store_crypto_private_key<R: Runtime>(
    app: AppHandle<R>,
    private_key: String,
) -> WalletCommandResult<String> {
    // Validate the key by creating a wallet
    let wallet = match PrivateKeyWallet::from_key(Some(private_key.clone())) {
        Ok(Some(w)) => w,
        Ok(None) => return WalletCommandResult::err("Empty private key"),
        Err(e) => return WalletCommandResult::err(e),
    };

    let address = wallet.address().to_string();

    // Store in encrypted store
    let store = match app.store(WALLET_STORE) {
        Ok(s) => s,
        Err(e) => return WalletCommandResult::err(format!("Failed to open store: {}", e)),
    };

    // Store the private key (encrypted by Tauri)
    store.set(PRIVATE_KEY_KEY, serde_json::json!(private_key));

    // Store the address for quick lookup without loading the key
    store.set(WALLET_ADDRESS_KEY, serde_json::json!(&address));

    // Persist to disk
    if let Err(e) = store.save() {
        return WalletCommandResult::err(format!("Failed to save store: {}", e));
    }

    WalletCommandResult::ok(address)
}

/// Get the configured crypto wallet address, if any.
///
/// Returns the address without loading the private key.
#[tauri::command]
pub async fn get_crypto_wallet_address<R: Runtime>(
    app: AppHandle<R>,
) -> WalletCommandResult<Option<String>> {
    let store = match app.store(WALLET_STORE) {
        Ok(s) => s,
        Err(_) => return WalletCommandResult::ok(None), // No store = no wallet
    };

    let address = store
        .get(WALLET_ADDRESS_KEY)
        .and_then(|v| v.as_str().map(String::from));

    WalletCommandResult::ok(address)
}

/// Clear the crypto wallet (remove private key and address).
#[tauri::command]
pub async fn clear_crypto_wallet<R: Runtime>(app: AppHandle<R>) -> WalletCommandResult<()> {
    let store = match app.store(WALLET_STORE) {
        Ok(s) => s,
        Err(_) => return WalletCommandResult::ok(()), // No store = nothing to clear
    };

    store.delete(PRIVATE_KEY_KEY);
    store.delete(WALLET_ADDRESS_KEY);

    if let Err(e) = store.save() {
        return WalletCommandResult::err(format!("Failed to save store: {}", e));
    }

    WalletCommandResult::ok(())
}

/// Sign x402 payment request parameters
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignX402Request {
    /// The 402 response body (JSON string)
    pub requirements_json: String,
}

/// Sign x402 payment response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignX402Response {
    /// The header name to use (X-PAYMENT or PAYMENT-SIGNATURE)
    pub header_name: String,
    /// The base64-encoded payment payload
    pub header_value: String,
    /// The x402 protocol version used
    pub x402_version: u8,
}

/// Sign an x402 payment request using the stored private key.
///
/// Parses the 402 response body, selects the first x402 payment option,
/// and generates a signed EIP-3009 authorization.
///
/// # Arguments
/// * `requirements_json` - The 402 response body as a JSON string
///
/// # Returns
/// The header name and base64-encoded signed payload to send with the retry request
#[tauri::command]
pub async fn sign_x402_payment<R: Runtime>(
    app: AppHandle<R>,
    request: SignX402Request,
) -> WalletCommandResult<SignX402Response> {
    // Load the private key from store
    let store = match app.store(WALLET_STORE) {
        Ok(s) => s,
        Err(e) => return WalletCommandResult::err(format!("Failed to open store: {}", e)),
    };

    let private_key = match store.get(PRIVATE_KEY_KEY) {
        Some(v) => match v.as_str() {
            Some(k) => k.to_string(),
            None => return WalletCommandResult::err(WalletError::NotConfigured),
        },
        None => return WalletCommandResult::err(WalletError::NotConfigured),
    };

    // Create wallet from key
    let wallet = match PrivateKeyWallet::from_key(Some(private_key)) {
        Ok(Some(w)) => w,
        Ok(None) => return WalletCommandResult::err(WalletError::NotConfigured),
        Err(e) => return WalletCommandResult::err(e),
    };

    // Parse payment requirements
    let requirements = match PaymentRequirements::parse(&request.requirements_json) {
        Ok(r) => r,
        Err(e) => return WalletCommandResult::err(format!("Failed to parse requirements: {}", e)),
    };

    // Get the first x402 payment option
    let option = match requirements.x402_option() {
        Some(o) => o,
        None => return WalletCommandResult::err("No x402 payment option in requirements"),
    };

    // Build and sign the payment payload
    let payload = match build_x402_payment_payload(&wallet, &requirements, option).await {
        Ok(p) => p,
        Err(e) => return WalletCommandResult::err(format!("Failed to build payload: {}", e)),
    };

    // Encode to base64
    let header_value = match payload.encode_b64() {
        Ok(v) => v,
        Err(e) => return WalletCommandResult::err(format!("Failed to encode payload: {}", e)),
    };

    WalletCommandResult::ok(SignX402Response {
        header_name: payload.header_name().to_string(),
        header_value,
        x402_version: payload.x402_version(),
    })
}

/// USDC balance response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsdcBalanceResponse {
    /// Balance in USDC (human-readable, 6 decimals)
    pub balance: String,
    /// Balance in smallest unit (raw)
    pub balance_raw: String,
    /// Network name
    pub network: String,
}

/// JSON-RPC request for eth_call
#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    method: &'static str,
    params: Vec<serde_json::Value>,
    id: u32,
}

/// JSON-RPC response
#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    result: Option<String>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    message: String,
}

/// Get the USDC balance for the configured wallet on Base mainnet.
///
/// Makes an eth_call to the USDC contract's balanceOf function.
#[tauri::command]
pub async fn get_crypto_usdc_balance<R: Runtime>(
    app: AppHandle<R>,
) -> WalletCommandResult<UsdcBalanceResponse> {
    // Get the wallet address
    let store = match app.store(WALLET_STORE) {
        Ok(s) => s,
        Err(_) => return WalletCommandResult::err("Wallet not configured"),
    };

    let address = match store.get(WALLET_ADDRESS_KEY) {
        Some(v) => match v.as_str() {
            Some(a) => a.to_string(),
            None => return WalletCommandResult::err("Wallet not configured"),
        },
        None => return WalletCommandResult::err("Wallet not configured"),
    };

    // Build the eth_call data for balanceOf(address)
    // Function selector: 0x70a08231 (first 4 bytes of keccak256("balanceOf(address)"))
    // Pad address to 32 bytes
    let address_clean = address.trim_start_matches("0x").to_lowercase();
    let call_data = format!("0x70a08231000000000000000000000000{}", address_clean);

    // Build JSON-RPC request
    let request = JsonRpcRequest {
        jsonrpc: "2.0",
        method: "eth_call",
        params: vec![
            serde_json::json!({
                "to": USDC_CONTRACT_BASE,
                "data": call_data,
            }),
            serde_json::json!("latest"),
        ],
        id: 1,
    };

    // Make the RPC call
    let client = reqwest::Client::new();
    let response = match client.post(BASE_RPC_URL).json(&request).send().await {
        Ok(r) => r,
        Err(e) => return WalletCommandResult::err(format!("RPC request failed: {}", e)),
    };

    let rpc_response: JsonRpcResponse = match response.json().await {
        Ok(r) => r,
        Err(e) => return WalletCommandResult::err(format!("Failed to parse RPC response: {}", e)),
    };

    if let Some(error) = rpc_response.error {
        return WalletCommandResult::err(format!("RPC error: {}", error.message));
    }

    let result = match rpc_response.result {
        Some(r) => r,
        None => return WalletCommandResult::err("No result in RPC response"),
    };

    // Parse the hex result (32-byte uint256)
    let balance_hex = result.trim_start_matches("0x");
    let balance_raw = u128::from_str_radix(balance_hex, 16).unwrap_or(0);

    // USDC has 6 decimals
    let balance_decimal = balance_raw as f64 / 1_000_000.0;

    WalletCommandResult::ok(UsdcBalanceResponse {
        balance: format!("{:.2}", balance_decimal),
        balance_raw: balance_raw.to_string(),
        network: "Base".to_string(),
    })
}
