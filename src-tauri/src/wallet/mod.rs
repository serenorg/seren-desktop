// ABOUTME: Wallet module for x402 local signing.
// ABOUTME: Provides private key management and EIP-712 signing for x402 payments.

// Allow dead code for types prepared for future x402 features
#![allow(dead_code)]

pub mod commands;
mod payment;
mod privatekey;
mod signing;
mod types;
pub use payment::{PaymentRequirements, build_x402_payment_payload};
pub use privatekey::PrivateKeyWallet;
pub use signing::{Eip712Domain, build_authorization_message, sign_transfer_authorization};
pub use types::WalletError;
