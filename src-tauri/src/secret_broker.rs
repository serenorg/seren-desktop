// ABOUTME: Host-side skill secret broker for per-skill credentials.
// ABOUTME: Stores raw key material in Tauri storage while list/audit APIs expose metadata only.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

const SECRET_BROKER_STORE: &str = "skill-keys.json";
const SECRET_BROKER_STATE_KEY: &str = "state";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyApprovalPolicy {
    pub mode: String,
    pub per_transaction_cap_usd: f64,
    pub session_duration_minutes: u32,
    pub session_cap_usd: f64,
    pub log_every_use: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretBindingSummary {
    pub id: String,
    pub service_id: String,
    pub service_name: String,
    pub skill_id: String,
    pub skill_name: String,
    pub variable_names: Vec<String>,
    pub secret_count: usize,
    pub approval_policy: KeyApprovalPolicy,
    pub last_used_at: Option<String>,
    pub active_session: Option<SecretAccessSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSecretBinding {
    pub id: String,
    pub service_id: String,
    pub service_name: String,
    pub skill_id: String,
    pub skill_name: String,
    pub variable_names: Vec<String>,
    pub secret_values: BTreeMap<String, String>,
    pub approval_policy: KeyApprovalPolicy,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSkillSecretBindingRequest {
    pub service_id: String,
    pub service_name: String,
    pub skill_id: String,
    pub skill_name: String,
    pub secret_values: BTreeMap<String, String>,
    pub approval_policy: KeyApprovalPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSecretEnvRequest {
    pub binding_id: String,
    pub operation: String,
    pub amount_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSecretEnvResponse {
    pub binding_id: String,
    pub variable_names: Vec<String>,
    pub secret_values: BTreeMap<String, String>,
    pub decision: String,
    pub active_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretAccessSession {
    pub id: String,
    pub binding_id: String,
    pub service_id: String,
    pub skill_id: String,
    pub granted_at: String,
    pub expires_at: String,
    pub cap_usd: f64,
    pub spent_usd: f64,
    pub ended_at: Option<String>,
    pub ended_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretAccessAuditEvent {
    pub id: String,
    pub binding_id: String,
    pub service_id: String,
    pub service_name: String,
    pub skill_id: String,
    pub skill_name: String,
    pub operation: String,
    pub amount_usd: Option<f64>,
    pub decision: String,
    pub created_at: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEnvMigrationProposal {
    pub id: String,
    pub service_id: String,
    pub service_name: String,
    pub skill_id: String,
    pub source_path: String,
    pub migrated_path: String,
    pub variable_names: Vec<String>,
    pub requires_confirmation: bool,
    pub post_import_action: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretBrokerState {
    bindings: Vec<StoredSecretBinding>,
    sessions: Vec<SecretAccessSession>,
    audit: Vec<SecretAccessAuditEvent>,
}

#[derive(Debug, Clone)]
struct ServiceDefinition {
    id: &'static str,
    name: &'static str,
    env_names: &'static [&'static str],
    env_prefixes: &'static [&'static str],
}

const SERVICES: &[ServiceDefinition] = &[
    ServiceDefinition {
        id: "polymarket",
        name: "Polymarket",
        env_names: &[
            "POLY_API_KEY",
            "POLY_PASSPHRASE",
            "POLY_SECRET",
            "POLY_PRIVATE_KEY",
            "POLYMARKET_PRIVATE_KEY",
            "POLYMARKET_WALLET_ADDRESS",
        ],
        env_prefixes: &["POLY_", "POLYMARKET_"],
    },
    ServiceDefinition {
        id: "kraken",
        name: "Kraken",
        env_names: &[
            "KRAKEN_API_KEY",
            "KRAKEN_API_SECRET",
            "KRAKEN_API_SECRET_KEY",
        ],
        env_prefixes: &["KRAKEN_"],
    },
    ServiceDefinition {
        id: "alpaca",
        name: "Alpaca",
        env_names: &[
            "APCA_API_KEY_ID",
            "APCA_API_SECRET_KEY",
            "APCA_API_BASE_URL",
        ],
        env_prefixes: &["APCA_"],
    },
    ServiceDefinition {
        id: "hyperliquid",
        name: "Hyperliquid",
        env_names: &["HYPERLIQUID_PRIVATE_KEY"],
        env_prefixes: &["HYPERLIQUID_"],
    },
    ServiceDefinition {
        id: "payments",
        name: "Payments",
        env_names: &[
            "WISE_API_TOKEN",
            "VENMO_COOKIES",
            "PAYPAL_CLIENT_ID",
            "PAYPAL_CLIENT_SECRET",
        ],
        env_prefixes: &["WISE_", "VENMO_", "PAYPAL_"],
    },
    ServiceDefinition {
        id: "seren-api",
        name: "Seren API",
        env_names: &["SEREN_API_KEY", "API_KEY"],
        env_prefixes: &[],
    },
];

fn now_iso() -> String {
    jiff::Timestamp::now().to_string()
}

fn add_minutes_iso(minutes: u32) -> String {
    let now = std::time::SystemTime::now();
    let expires = now + std::time::Duration::from_secs((minutes as u64) * 60);
    let secs = expires
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    jiff::Timestamp::from_second(secs)
        .unwrap_or_else(|_| jiff::Timestamp::now())
        .to_string()
}

fn binding_id(service_id: &str, skill_id: &str) -> String {
    format!("{service_id}::{skill_id}")
}

fn default_skills_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".config").join("seren").join("skills"))
}

fn service_for_env_var(name: &str) -> Option<&'static ServiceDefinition> {
    let normalized = name.trim().to_ascii_uppercase();
    if normalized.is_empty() {
        return None;
    }

    if let Some(service) = SERVICES
        .iter()
        .find(|service| service.env_names.contains(&normalized.as_str()))
    {
        return Some(service);
    }

    SERVICES.iter().find(|service| {
        service
            .env_prefixes
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
    })
}

fn parse_env_variable_names(contents: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let assignment = trimmed.strip_prefix("export ").unwrap_or(trimmed).trim();
        let Some((name, _)) = assignment.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if name
            .chars()
            .all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
            && name
                .chars()
                .next()
                .is_some_and(|ch| ch == '_' || ch.is_ascii_alphabetic())
        {
            names.push(name.to_ascii_uppercase());
        }
    }
    names
}

fn read_state(app: &AppHandle) -> Result<SecretBrokerState, String> {
    let store = app.store(SECRET_BROKER_STORE).map_err(|e| e.to_string())?;
    let state = store
        .get(SECRET_BROKER_STATE_KEY)
        .and_then(|value| serde_json::from_value::<SecretBrokerState>(value.clone()).ok())
        .unwrap_or_default();
    Ok(state)
}

fn write_state(app: &AppHandle, state: &SecretBrokerState) -> Result<(), String> {
    let store = app.store(SECRET_BROKER_STORE).map_err(|e| e.to_string())?;
    store.set(SECRET_BROKER_STATE_KEY, serde_json::json!(state));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

fn active_session_for(state: &SecretBrokerState, binding_id: &str) -> Option<SecretAccessSession> {
    state
        .sessions
        .iter()
        .rev()
        .find(|session| is_active_session(session, binding_id, None))
        .cloned()
}

fn is_active_session(
    session: &SecretAccessSession,
    binding_id: &str,
    amount_usd: Option<f64>,
) -> bool {
    if session.binding_id != binding_id || session.ended_at.is_some() {
        return false;
    }
    if session.expires_at <= now_iso() {
        return false;
    }
    if let Some(amount) = amount_usd {
        if session.spent_usd + amount > session.cap_usd {
            return false;
        }
    }
    true
}

fn to_summary(state: &SecretBrokerState, binding: &StoredSecretBinding) -> SecretBindingSummary {
    SecretBindingSummary {
        id: binding.id.clone(),
        service_id: binding.service_id.clone(),
        service_name: binding.service_name.clone(),
        skill_id: binding.skill_id.clone(),
        skill_name: binding.skill_name.clone(),
        variable_names: binding.variable_names.clone(),
        secret_count: binding.secret_values.len(),
        approval_policy: binding.approval_policy.clone(),
        last_used_at: binding.last_used_at.clone(),
        active_session: active_session_for(state, &binding.id),
    }
}

fn push_audit(
    state: &mut SecretBrokerState,
    binding: &StoredSecretBinding,
    operation: impl Into<String>,
    decision: impl Into<String>,
    detail: impl Into<String>,
    amount_usd: Option<f64>,
) {
    state.audit.push(SecretAccessAuditEvent {
        id: Uuid::new_v4().to_string(),
        binding_id: binding.id.clone(),
        service_id: binding.service_id.clone(),
        service_name: binding.service_name.clone(),
        skill_id: binding.skill_id.clone(),
        skill_name: binding.skill_name.clone(),
        operation: operation.into(),
        amount_usd,
        decision: decision.into(),
        created_at: now_iso(),
        detail: detail.into(),
    });
}

#[tauri::command]
pub async fn list_skill_secret_bindings(
    app: AppHandle,
) -> Result<Vec<SecretBindingSummary>, String> {
    let state = read_state(&app)?;
    Ok(state
        .bindings
        .iter()
        .map(|binding| to_summary(&state, binding))
        .collect())
}

#[tauri::command]
pub async fn upsert_skill_secret_binding(
    app: AppHandle,
    request: UpsertSkillSecretBindingRequest,
) -> Result<SecretBindingSummary, String> {
    let service_id = request.service_id.trim().to_string();
    let skill_id = request.skill_id.trim().to_string();
    if service_id.is_empty() || skill_id.is_empty() {
        return Err("service_id and skill_id are required".to_string());
    }

    let id = binding_id(&service_id, &skill_id);
    let mut state = read_state(&app)?;
    let now = now_iso();
    let variable_names: Vec<String> = request
        .secret_values
        .keys()
        .map(|name| name.trim().to_ascii_uppercase())
        .filter(|name| !name.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    let mut replacement = false;
    let created_at = if let Some(existing) = state.bindings.iter().find(|b| b.id == id) {
        replacement = true;
        existing.created_at.clone()
    } else {
        now.clone()
    };

    if replacement {
        for session in &mut state.sessions {
            if session.binding_id == id && session.ended_at.is_none() {
                session.ended_at = Some(now.clone());
                session.ended_reason = Some("key_edited".to_string());
            }
        }
        state.bindings.retain(|binding| binding.id != id);
    }

    let binding = StoredSecretBinding {
        id: id.clone(),
        service_id,
        service_name: request.service_name,
        skill_id,
        skill_name: request.skill_name,
        variable_names,
        secret_values: request.secret_values,
        approval_policy: request.approval_policy,
        created_at,
        updated_at: now,
        last_used_at: None,
    };

    push_audit(
        &mut state,
        &binding,
        if replacement {
            "Key replaced; active sessions ended"
        } else {
            "Key stored"
        },
        if replacement {
            "key_edited"
        } else {
            "approved_by_user"
        },
        if replacement {
            "Key edited"
        } else {
            "Stored by you"
        },
        None,
    );
    state.bindings.push(binding.clone());
    write_state(&app, &state)?;

    Ok(to_summary(&state, &binding))
}

#[tauri::command]
pub async fn request_skill_secret_env(
    app: AppHandle,
    request: SkillSecretEnvRequest,
) -> Result<SkillSecretEnvResponse, String> {
    let amount_usd = request.amount_usd.unwrap_or(0.0).max(0.0);
    let mut state = read_state(&app)?;
    let Some(binding) = state
        .bindings
        .iter()
        .find(|binding| binding.id == request.binding_id)
        .cloned()
    else {
        return Err("Key binding not found".to_string());
    };

    let active_session = state
        .sessions
        .iter_mut()
        .rev()
        .find(|session| is_active_session(session, &binding.id, Some(amount_usd)));

    let mut decision = "approval_required".to_string();
    let mut session_id = None;
    if let Some(session) = active_session {
        session.spent_usd += amount_usd;
        session_id = Some(session.id.clone());
        decision = "session_approved".to_string();
    } else if binding.approval_policy.mode == "auto_approve_cap"
        && amount_usd <= binding.approval_policy.per_transaction_cap_usd
    {
        decision = "auto_approved".to_string();
    }

    if decision == "approval_required" {
        push_audit(
            &mut state,
            &binding,
            request.operation,
            "approval_required",
            "Default $0 cap requires an explicit approval before secrets are released",
            Some(amount_usd),
        );
        write_state(&app, &state)?;
        return Err("approval_required".to_string());
    }

    if let Some(stored) = state
        .bindings
        .iter_mut()
        .find(|stored| stored.id == binding.id)
    {
        stored.last_used_at = Some(now_iso());
    }

    push_audit(
        &mut state,
        &binding,
        request.operation,
        decision.clone(),
        "Secret released by host broker",
        Some(amount_usd),
    );
    write_state(&app, &state)?;

    Ok(SkillSecretEnvResponse {
        binding_id: binding.id,
        variable_names: binding.variable_names,
        secret_values: binding.secret_values,
        decision,
        active_session_id: session_id,
    })
}

#[tauri::command]
pub async fn delete_skill_secret_binding(app: AppHandle, binding_id: String) -> Result<(), String> {
    let mut state = read_state(&app)?;
    let now = now_iso();
    state.bindings.retain(|binding| binding.id != binding_id);
    for session in &mut state.sessions {
        if session.binding_id == binding_id && session.ended_at.is_none() {
            session.ended_at = Some(now.clone());
            session.ended_reason = Some("key_edited".to_string());
        }
    }
    write_state(&app, &state)
}

#[tauri::command]
pub async fn scan_skill_env_migrations(
    skills_root: Option<String>,
) -> Result<Vec<SkillEnvMigrationProposal>, String> {
    let root = skills_root
        .map(PathBuf::from)
        .or_else(default_skills_root)
        .ok_or_else(|| "Could not resolve skills root".to_string())?;

    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut proposals = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let env_path = path.join(".env");
        if !env_path.is_file() {
            continue;
        }

        let skill_id = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        let contents = fs::read_to_string(&env_path).map_err(|e| e.to_string())?;
        proposals.extend(build_env_migration_proposals_for_file(
            &skill_id, &env_path, &contents,
        ));
    }

    Ok(proposals)
}

fn build_env_migration_proposals_for_file(
    skill_id: &str,
    env_path: &Path,
    contents: &str,
) -> Vec<SkillEnvMigrationProposal> {
    let mut variables_by_service: BTreeMap<&'static str, BTreeSet<String>> = BTreeMap::new();
    for name in parse_env_variable_names(contents) {
        let Some(service) = service_for_env_var(&name) else {
            continue;
        };
        variables_by_service
            .entry(service.id)
            .or_default()
            .insert(name);
    }

    variables_by_service
        .into_iter()
        .filter_map(|(service_id, variable_names)| {
            let service = SERVICES.iter().find(|service| service.id == service_id)?;
            let source_path = env_path.to_string_lossy().to_string();
            Some(SkillEnvMigrationProposal {
                id: binding_id(service_id, skill_id),
                service_id: service_id.to_string(),
                service_name: service.name.to_string(),
                skill_id: skill_id.to_string(),
                migrated_path: source_path.replace(".env", ".env.migrated"),
                source_path,
                variable_names: variable_names.into_iter().collect(),
                requires_confirmation: true,
                post_import_action: "rename_env_to_env_migrated".to_string(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn list_secret_access_audit(
    app: AppHandle,
) -> Result<Vec<SecretAccessAuditEvent>, String> {
    let mut audit = read_state(&app)?.audit;
    audit.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(audit)
}

#[tauri::command]
pub async fn grant_skill_secret_session(
    app: AppHandle,
    binding_id: String,
    duration_minutes: u32,
    cap_usd: f64,
) -> Result<SecretAccessSession, String> {
    if duration_minutes == 0 || cap_usd <= 0.0 {
        return Err("duration_minutes and cap_usd must be positive".to_string());
    }

    let mut state = read_state(&app)?;
    let Some(binding) = state
        .bindings
        .iter()
        .find(|binding| binding.id == binding_id)
        .cloned()
    else {
        return Err("Key binding not found".to_string());
    };

    let now = now_iso();
    let session = SecretAccessSession {
        id: Uuid::new_v4().to_string(),
        binding_id: binding.id.clone(),
        service_id: binding.service_id.clone(),
        skill_id: binding.skill_id.clone(),
        granted_at: now,
        expires_at: add_minutes_iso(duration_minutes),
        cap_usd,
        spent_usd: 0.0,
        ended_at: None,
        ended_reason: None,
    };

    state.sessions.push(session.clone());
    push_audit(
        &mut state,
        &binding,
        format!("Session granted · {duration_minutes} min · ${cap_usd:.0} cap"),
        "session_start",
        "Approved by you",
        None,
    );
    write_state(&app, &state)?;

    Ok(session)
}

#[tauri::command]
pub async fn end_skill_secret_session(app: AppHandle, session_id: String) -> Result<(), String> {
    let mut state = read_state(&app)?;
    let now = now_iso();
    let Some(index) = state
        .sessions
        .iter()
        .position(|session| session.id == session_id)
    else {
        return Ok(());
    };

    if state.sessions[index].ended_at.is_some() {
        return Ok(());
    }

    state.sessions[index].ended_at = Some(now);
    state.sessions[index].ended_reason = Some("user_ended".to_string());

    if let Some(binding) = state
        .bindings
        .iter()
        .find(|binding| binding.id == state.sessions[index].binding_id)
        .cloned()
    {
        push_audit(
            &mut state,
            &binding,
            "Session ended by user",
            "session_end",
            "Ended by you",
            None,
        );
    }

    write_state(&app, &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_env_vars() {
        let names = parse_env_variable_names(
            "POLY_API_KEY=abc\nexport KRAKEN_API_SECRET=def\n#APCA_API_KEY_ID=no\n",
        );
        assert_eq!(names, vec!["POLY_API_KEY", "KRAKEN_API_SECRET"]);
    }

    #[test]
    fn migration_groups_by_service_and_skill() {
        let proposals = build_env_migration_proposals_for_file(
            "polymarket-bot",
            Path::new("/tmp/polymarket-bot/.env"),
            "POLY_API_KEY=abc\nPOLY_SECRET=def\nSEREN_API_KEY=seren\n",
        );
        assert_eq!(proposals.len(), 2);
        assert_eq!(proposals[0].id, "polymarket::polymarket-bot");
        assert_eq!(
            proposals[0].post_import_action,
            "rename_env_to_env_migrated"
        );
        assert!(proposals[0].requires_confirmation);
    }
}
