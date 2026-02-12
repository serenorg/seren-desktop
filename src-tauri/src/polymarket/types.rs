// ABOUTME: Polymarket types and errors for CLOB API authentication.
// ABOUTME: Defines PolymarketError enum for authentication operations.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors that can occur during Polymarket authentication operations
#[derive(Debug, Error, Serialize, Deserialize)]
pub enum PolymarketError {
    #[error("Invalid API credentials")]
    InvalidCredentials,

    #[error("Credentials not configured")]
    NotConfigured,

    #[error("Signing failed: {0}")]
    SigningFailed(String),

    #[error("Storage error: {0}")]
    StorageError(String),

    #[error("WebSocket error: {0}")]
    WebSocketError(String),

    #[error("Connection failed: {0}")]
    ConnectionFailed(String),
}
