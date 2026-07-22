// ABOUTME: Validated, canonical sandbox policy shared by all provider backends.
// ABOUTME: Paths are resolved before profile generation so a profile cannot scope a spelling alias.

use std::path::PathBuf;
use std::str::FromStr;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    FullAccess,
}

impl FromStr for SandboxMode {
    type Err = SandboxError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim() {
            "read-only" => Ok(Self::ReadOnly),
            "workspace-write" => Ok(Self::WorkspaceWrite),
            "full-access" | "danger-full-access" => Ok(Self::FullAccess),
            other => Err(SandboxError::InvalidMode(other.to_string())),
        }
    }
}

#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("invalid agent sandbox mode: {0}")]
    InvalidMode(String),
    #[error("sandbox path cannot be canonicalized: {path}: {source}")]
    PathCanonicalization {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("a bounded sandbox requires at least one workspace root")]
    EmptyWorkspaceRoots,
    #[error("a full-access session does not have a sandbox profile")]
    FullAccessNoProfile,
    #[error("the sandbox backend is unavailable on this platform")]
    BackendUnavailable,
    #[error("sandbox command path cannot be empty")]
    EmptyCommand,
    #[error("sandbox policy serialization failed: {0}")]
    PolicySerialization(String),
    #[error("sandbox policy decoding failed: {0}")]
    PolicyDecode(String),
    #[error("Landlock backend error: {0}")]
    Landlock(String),
    #[error("Windows sandbox backend error: {0}")]
    Windows(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxPolicy {
    pub mode: SandboxMode,
    pub workspace_roots: Vec<PathBuf>,
    pub deny_read: Vec<PathBuf>,
    pub network_enabled: bool,
}

pub fn encode_policy(policy: &SandboxPolicy) -> Result<String, SandboxError> {
    let serialized = serde_json::to_vec(policy)
        .map_err(|error| SandboxError::PolicySerialization(error.to_string()))?;
    Ok(STANDARD.encode(serialized))
}

impl SandboxPolicy {
    pub fn new(
        mode: SandboxMode,
        workspace_roots: Vec<PathBuf>,
        deny_read: Vec<PathBuf>,
        network_enabled: bool,
    ) -> Result<Self, SandboxError> {
        if mode != SandboxMode::FullAccess && workspace_roots.is_empty() {
            return Err(SandboxError::EmptyWorkspaceRoots);
        }

        let workspace_roots = workspace_roots
            .into_iter()
            .map(canonicalize)
            .collect::<Result<Vec<_>, _>>()?;
        let deny_read = deny_read
            .into_iter()
            .map(canonicalize)
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            mode,
            workspace_roots,
            deny_read,
            network_enabled,
        })
    }
}

fn canonicalize(path: PathBuf) -> Result<PathBuf, SandboxError> {
    std::fs::canonicalize(&path)
        .map_err(|source| SandboxError::PathCanonicalization { path, source })
}
