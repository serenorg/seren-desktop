// ABOUTME: Orchestrator module for intelligent task routing between workers.
// ABOUTME: Contains types, worker trait, classifier, router, and worker adapters.

pub mod chat_model_worker;
pub mod classifier;
pub mod eval;
pub mod router;
pub mod service;
pub mod types;
pub mod worker;

#[cfg(feature = "acp")]
pub mod acp_worker;
