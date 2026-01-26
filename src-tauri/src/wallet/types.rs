// ABOUTME: Wallet types and errors for x402 signing.
// ABOUTME: Defines WalletError enum for wallet operations.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors that can occur during wallet operations
#[derive(Debug, Error, Serialize, Deserialize)]
pub enum WalletError {
    #[error("Invalid private key format")]
    InvalidPrivateKey,

    #[error("Wallet not configured")]
    NotConfigured,

    #[error("Signing failed: {0}")]
    SigningFailed(String),

    #[error("Storage error: {0}")]
    StorageError(String),
}
