// ABOUTME: Wallet module for x402 local signing.
// ABOUTME: Provides private key management and EIP-712 signing for x402 payments.

pub mod commands;
mod payment;
mod privatekey;
mod signing;
mod types;
pub use payment::{
    BuiltX402PaymentPayload, PaymentError, PaymentMethod, PaymentOption, PaymentRequirements,
    UserCapabilities, X402Authorization, X402PayloadInner, X402PaymentOption, X402PaymentPayload,
    build_x402_payment_payload, select_payment_method,
};
pub use privatekey::PrivateKeyWallet;
pub use signing::{
    AuthorizationMessage, Eip712Domain, build_authorization_message, sign_transfer_authorization,
};
pub use types::WalletError;
