// ABOUTME: Polymarket CLOB API authentication module.
// ABOUTME: Provides HMAC-SHA256 signing for L2 authenticated trading requests.

// Allow dead code for types prepared for future Polymarket features
#![allow(dead_code)]

pub mod commands;
mod signing;
mod types;

pub use types::PolymarketError;
