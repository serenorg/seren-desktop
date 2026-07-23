// ABOUTME: Rust-owned, expiring API-key leases for individual agent sessions.
// ABOUTME: Persists only non-secret revoke records so a later launch can reap orphaned remote keys.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

use crate::credential_broker::PublisherCredentialBroker;

const GATEWAY_BASE_URL: &str = "https://api.serendb.com";
const DEFAULT_ORG_API_KEYS_PATH: &str = "/organizations/default/api-keys";
const LEASE_STORE: &str = "credential-leases.json";
const LEASE_LEDGER_KEY: &str = "orphaned_leases";
const LEASE_EXPIRY_DAYS: u8 = 1;
// Core now publishes and enforces a per-publisher scope grammar
// (`publisher:*`, `publisher:<slug>`, `publisher:<slug>:operation:<id>`; see
// seren-core#222). The lease stays `publisher:*` because a general agent
// session does not know its publisher set at spawn — the Seren MCP catalog is
// dynamic — so narrowing needs a per-publisher capability minted at first use,
// not a scope-string change. One residual on the wildcard is tracked in
// seren-core#224: for a user key it still authorizes destructive
// seren-passwords operations. See #3194.
const VERIFIED_LEASE_SCOPES: &[&str] = &["publisher:*"];

/// What the renderer and provider runtime are allowed to see. The real key is
/// deliberately absent: only the loopback broker holds it, and the capability
/// below is meaningless anywhere else.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialLease {
    pub session_id: String,
    pub key_id: String,
    pub expires_at: String,
    pub capability: String,
    pub mcp_url: String,
    pub api_base_url: String,
}

#[derive(Clone)]
struct ActiveLease {
    key_id: String,
    revoke_id: String,
    expires_at: String,
    endpoints: crate::credential_broker::BrokeredEndpoints,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct LeaseLedgerEntry {
    session_id: String,
    /// Short public identifier, kept for diagnostics.
    key_id: String,
    /// Record UUID used to revoke. Absent in ledgers written before this was
    /// distinguished from `key_id`; those records cannot be revoked remotely.
    #[serde(default)]
    revoke_id: String,
    expires_at: String,
    #[serde(default)]
    pending_revocation: bool,
}

#[derive(Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct CredentialLeaseLedger {
    #[serde(default)]
    leases: Vec<LeaseLedgerEntry>,
}

#[derive(Deserialize)]
struct DataResponse<T> {
    data: T,
}

#[derive(Deserialize)]
struct ApiKeyCreated {
    api_key: String,
    /// Record UUID. Despite the delete route naming its path parameter
    /// `key_id`, it is typed `format: uuid` and only accepts this value.
    id: String,
    /// Short public identifier. Useful for logs; rejected by the delete route.
    key_id: String,
    expires_at: Option<String>,
}

/// Owns active session key material in memory and durable, non-secret cleanup
/// records on disk. The mutex serializes create/revoke operations so one
/// session id cannot race into multiple remote keys.
#[derive(Clone)]
pub struct CredentialLeaseManager {
    active: Arc<Mutex<HashMap<String, ActiveLease>>>,
    operation_lock: Arc<Mutex<()>>,
    startup_reaper_pending: Arc<AtomicBool>,
    broker: Option<PublisherCredentialBroker>,
    client: reqwest::Client,
}

impl CredentialLeaseManager {
    pub fn new(broker: Option<PublisherCredentialBroker>) -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
            operation_lock: Arc::new(Mutex::new(())),
            startup_reaper_pending: Arc::new(AtomicBool::new(false)),
            broker,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    /// Called synchronously during app setup, before the background reaper is
    /// spawned. New leases wait for that pass so it cannot accidentally revoke
    /// a freshly created key that appears in the same durable ledger.
    pub fn begin_startup_reaper(&self) {
        self.startup_reaper_pending.store(true, Ordering::Release);
    }

    /// Create a one-day key for a session and hand it to the loopback broker.
    /// The caller receives only the broker's opaque capability, so the key
    /// value never crosses the command boundary at all.
    pub async fn create_lease(
        &self,
        app: &AppHandle,
        session_id: String,
    ) -> Result<CredentialLease, String> {
        let session_id = validate_session_id(session_id)?;
        let Some(broker) = self.broker.as_ref() else {
            // Fail closed. Without a broker there is nowhere to put the key
            // except a child environment, which is the exposure this exists to
            // remove.
            return Err(
                "The publisher credential broker is unavailable; refusing to issue a lease."
                    .to_string(),
            );
        };
        while self.startup_reaper_pending.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let _operation = self.operation_lock.lock().await;

        // Retrying a previous failed revoke is best-effort. It must not turn a
        // transient network problem into a denial of a fresh user session.
        if let Err(error) = self.retry_pending_revocations_locked(app).await {
            log::warn!("[credential-lease] Pending revocation retry failed: {error}");
        }

        if let Some(existing) = self.active.lock().await.get(&session_id).cloned() {
            return Ok(CredentialLease {
                session_id,
                key_id: existing.key_id,
                expires_at: existing.expires_at,
                capability: existing.endpoints.capability,
                mcp_url: existing.endpoints.mcp_url,
                api_base_url: existing.endpoints.api_base_url,
            });
        }

        let request_body = serde_json::json!({
            "name": "Seren Desktop session lease",
            "scopes": VERIFIED_LEASE_SCOPES,
            "expires_in_days": LEASE_EXPIRY_DAYS,
        });
        let response = crate::auth::authenticated_request(app, &self.client, |client, token| {
            client
                .post(format!("{GATEWAY_BASE_URL}{DEFAULT_ORG_API_KEYS_PATH}"))
                .bearer_auth(token)
                .json(&request_body)
        })
        .await?;

        if !response.status().is_success() {
            return Err(format!(
                "Credential lease creation failed with HTTP {}",
                response.status()
            ));
        }

        let created = response
            .json::<DataResponse<ApiKeyCreated>>()
            .await
            .map_err(|error| format!("Credential lease creation response was invalid: {error}"))?
            .data;
        if created.api_key.trim().is_empty() {
            return Err("Credential lease creation response omitted key material.".to_string());
        }
        // Without the revocation handle the key could never be withdrawn, so
        // treat its absence as a failed creation rather than issuing a lease
        // that only server-side expiry can end.
        if created.id.trim().is_empty() {
            return Err("Credential lease creation response omitted its revocation id.".to_string());
        }

        let expires_at = created.expires_at.unwrap_or_default();
        let record = LeaseLedgerEntry {
            session_id: session_id.clone(),
            key_id: created.key_id.clone(),
            revoke_id: created.id.clone(),
            expires_at: expires_at.clone(),
            pending_revocation: false,
        };

        if let Err(error) = self.append_ledger_record(app, record.clone()) {
            let revoke_result = self.revoke_remote_key(app, &record.revoke_id).await;
            return Err(match revoke_result {
                Ok(()) => format!("Could not persist credential lease cleanup record: {error}"),
                Err(revoke_error) => format!(
                    "Could not persist credential lease cleanup record ({error}); emergency revocation failed: {revoke_error}"
                ),
            });
        }

        // A key without a server-confirmed expiry would be a durable secret.
        // Keep its non-secret record, attempt revocation, and fail the spawn.
        if expires_at.trim().is_empty() {
            let revoke_result = self.revoke_records_locked(app, vec![record]).await;
            return Err(match revoke_result {
                Ok(()) => "Credential lease creation response omitted expiry; key was revoked."
                    .to_string(),
                Err(error) => format!(
                    "Credential lease creation response omitted expiry; key revocation was queued: {error}"
                ),
            });
        }

        // The key moves straight into the broker. `created.api_key` is not
        // returned, logged, or stored anywhere else.
        let endpoints = match broker.register(&session_id, &created.api_key, &expires_at) {
            Ok(endpoints) => endpoints,
            Err(error) => {
                let revoke_result = self.revoke_records_locked(app, vec![record]).await;
                return Err(match revoke_result {
                    Ok(()) => format!("Credential broker registration failed ({error}); key was revoked."),
                    Err(revoke_error) => format!(
                        "Credential broker registration failed ({error}); key revocation was queued: {revoke_error}"
                    ),
                });
            }
        };

        self.active.lock().await.insert(
            session_id.clone(),
            ActiveLease {
                key_id: created.key_id.clone(),
                revoke_id: created.id.clone(),
                expires_at: expires_at.clone(),
                endpoints: endpoints.clone(),
            },
        );

        Ok(CredentialLease {
            session_id,
            key_id: created.key_id,
            expires_at,
            capability: endpoints.capability,
            mcp_url: endpoints.mcp_url,
            api_base_url: endpoints.api_base_url,
        })
    }

    /// Close the broker route before anything else, so the session is denied
    /// even while the remote revocation is still in flight. Failed remote
    /// requests remain in the non-secret ledger for a later retry/reaper.
    pub async fn revoke_lease(&self, app: &AppHandle, session_id: String) -> Result<(), String> {
        let session_id = validate_session_id(session_id)?;
        if let Some(broker) = self.broker.as_ref() {
            broker.revoke_session(&session_id);
        }
        let _operation = self.operation_lock.lock().await;

        let active = self.active.lock().await.remove(&session_id);
        let mut records = self.records_for_session(app, &session_id)?;
        if let Some(active) = active {
            if !records
                .iter()
                .any(|record| record.revoke_id == active.revoke_id)
            {
                records.push(LeaseLedgerEntry {
                    session_id,
                    key_id: active.key_id,
                    revoke_id: active.revoke_id,
                    expires_at: active.expires_at,
                    pending_revocation: false,
                });
            }
        }
        self.revoke_records_locked(app, records).await
    }

    /// Locally deny every active lease, then make one best-effort remote
    /// revocation attempt per known key.
    pub async fn revoke_all(&self, app: &AppHandle) -> Result<(), String> {
        if let Some(broker) = self.broker.as_ref() {
            broker.revoke_all();
        }
        let _operation = self.operation_lock.lock().await;
        let active = std::mem::take(&mut *self.active.lock().await);
        let mut records = read_ledger(app)?.leases;
        for (session_id, lease) in active {
            if !records
                .iter()
                .any(|record| record.revoke_id == lease.revoke_id)
            {
                records.push(LeaseLedgerEntry {
                    session_id,
                    key_id: lease.key_id,
                    revoke_id: lease.revoke_id,
                    expires_at: lease.expires_at,
                    pending_revocation: false,
                });
            }
        }
        self.revoke_records_locked(app, records).await
    }

    /// On startup all persisted records belong to an earlier process, so every
    /// one is an orphan candidate. The caller logs failures; records remain for
    /// a later manager operation rather than being silently discarded.
    pub async fn startup_reaper(&self, app: &AppHandle) -> Result<(), String> {
        let _operation = self.operation_lock.lock().await;
        let result = async {
            let records = select_startup_reaper_records(&read_ledger(app)?.leases);
            self.revoke_records_locked(app, records).await
        }
        .await;
        self.startup_reaper_pending.store(false, Ordering::Release);
        result
    }

    fn append_ledger_record(
        &self,
        app: &AppHandle,
        record: LeaseLedgerEntry,
    ) -> Result<(), String> {
        let mut ledger = read_ledger(app)?;
        ledger.leases.retain(|entry| entry.revoke_id != record.revoke_id);
        ledger.leases.push(record);
        write_ledger(app, &ledger)
    }

    fn records_for_session(
        &self,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<Vec<LeaseLedgerEntry>, String> {
        Ok(read_ledger(app)?
            .leases
            .into_iter()
            .filter(|record| record.session_id == session_id)
            .collect())
    }

    async fn retry_pending_revocations_locked(&self, app: &AppHandle) -> Result<(), String> {
        let records = read_ledger(app)?
            .leases
            .into_iter()
            .filter(|record| record.pending_revocation)
            .collect();
        self.revoke_records_locked(app, records).await
    }

    async fn revoke_records_locked(
        &self,
        app: &AppHandle,
        records: Vec<LeaseLedgerEntry>,
    ) -> Result<(), String> {
        if records.is_empty() {
            return Ok(());
        }

        let mut revoked_ids = HashSet::new();
        let mut failed_ids = HashSet::new();
        let mut failures = Vec::new();
        for record in &records {
            // A record written before the revocation handle was distinguished
            // from the public key id carries no usable value. Retrying it
            // forever would just log the same rejection every launch, so drop
            // it and let server-side expiry finish the job.
            if record.revoke_id.trim().is_empty() {
                log::warn!(
                    "[credential-lease] Discarding a lease record with no revocation id; \
                     the remote key expires on its own."
                );
                revoked_ids.insert(record.revoke_id.clone());
                continue;
            }
            match self.revoke_remote_key(app, &record.revoke_id).await {
                Ok(()) => {
                    revoked_ids.insert(record.revoke_id.clone());
                }
                Err(error) => {
                    failed_ids.insert(record.revoke_id.clone());
                    failures.push(error);
                }
            }
        }

        let mut ledger = read_ledger(app)?;
        ledger
            .leases
            .retain(|record| !revoked_ids.contains(&record.revoke_id));
        for mut failed_record in records
            .into_iter()
            .filter(|record| failed_ids.contains(&record.revoke_id))
        {
            if let Some(existing) = ledger
                .leases
                .iter_mut()
                .find(|record| record.revoke_id == failed_record.revoke_id)
            {
                existing.pending_revocation = true;
            } else {
                failed_record.pending_revocation = true;
                ledger.leases.push(failed_record);
            }
        }
        write_ledger(app, &ledger)?;

        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "{} credential lease revocation request(s) failed",
                failures.len()
            ))
        }
    }

    /// `revoke_id` is the API key record UUID. The delete route names its path
    /// parameter `key_id` but only accepts the UUID; the short public `key_id`
    /// is rejected with HTTP 400. See #3237.
    async fn revoke_remote_key(&self, app: &AppHandle, revoke_id: &str) -> Result<(), String> {
        let revoke_id = revoke_id.trim();
        if revoke_id.is_empty() {
            return Err("Credential lease record omitted a revocation id.".to_string());
        }
        let path = format!(
            "{GATEWAY_BASE_URL}{DEFAULT_ORG_API_KEYS_PATH}/{}",
            urlencoding::encode(revoke_id)
        );
        let response = crate::auth::authenticated_request(app, &self.client, |client, token| {
            client.delete(&path).bearer_auth(token)
        })
        .await?;
        if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(format!(
            "Credential lease revocation failed with HTTP {}",
            response.status()
        ))
    }
}

fn validate_session_id(session_id: String) -> Result<String, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("A credential lease requires a session id.".to_string());
    }
    if session_id.len() > 256 {
        return Err("Credential lease session id is too long.".to_string());
    }
    Ok(session_id)
}

fn read_ledger(app: &AppHandle) -> Result<CredentialLeaseLedger, String> {
    let store = app.store(LEASE_STORE).map_err(|error| error.to_string())?;
    store
        .get(LEASE_LEDGER_KEY)
        .map(|value| {
            serde_json::from_value(value.clone())
                .map_err(|error| format!("Credential lease ledger was invalid: {error}"))
        })
        .transpose()
        .map(|ledger| ledger.unwrap_or_default())
}

fn write_ledger(app: &AppHandle, ledger: &CredentialLeaseLedger) -> Result<(), String> {
    let store = app.store(LEASE_STORE).map_err(|error| error.to_string())?;
    store.set(
        LEASE_LEDGER_KEY,
        serde_json::to_value(ledger)
            .map_err(|error| format!("Credential lease ledger could not be encoded: {error}"))?,
    );
    store.save().map_err(|error| error.to_string())
}

fn select_startup_reaper_records(records: &[LeaseLedgerEntry]) -> Vec<LeaseLedgerEntry> {
    records.to_vec()
}

#[cfg(test)]
mod tests {
    use super::{
        ApiKeyCreated, CredentialLease, CredentialLeaseLedger, LeaseLedgerEntry,
        select_startup_reaper_records,
    };

    /// The renderer reads these exact names. A rename here silently leaves a
    /// session without Seren MCP, so pin the wire contract rather than trusting
    /// the derive.
    #[test]
    fn credential_lease_exposes_broker_endpoints_and_no_key() {
        let lease = CredentialLease {
            session_id: "session-a".to_string(),
            key_id: "key-a".to_string(),
            expires_at: "2030-01-01T00:00:00Z".to_string(),
            capability: "capability-a".to_string(),
            mcp_url: "http://127.0.0.1:1/route/mcp".to_string(),
            api_base_url: "http://127.0.0.1:1/route/api/".to_string(),
        };
        let value = serde_json::to_value(&lease).expect("lease serializes");
        let object = value.as_object().expect("lease is an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["apiBaseUrl", "capability", "expiresAt", "keyId", "mcpUrl", "sessionId"]
        );
        assert!(object.get("apiKey").is_none());
        assert!(object.get("api_key").is_none());
    }

    fn record(session_id: &str, key_id: &str, pending_revocation: bool) -> LeaseLedgerEntry {
        LeaseLedgerEntry {
            session_id: session_id.to_string(),
            key_id: key_id.to_string(),
            revoke_id: format!("00000000-0000-4000-8000-{key_id:0>12}"),
            expires_at: "2030-01-01T00:00:00Z".to_string(),
            pending_revocation,
        }
    }

    /// The delete route names its path parameter `key_id` but types it
    /// `format: uuid`, so sending the short public key id gets HTTP 400 and no
    /// lease is ever withdrawn. Pin the two apart. See #3237.
    #[test]
    fn credential_lease_revokes_with_the_record_uuid_not_the_public_key_id() {
        let created: ApiKeyCreated = serde_json::from_value(serde_json::json!({
            "api_key": "seren_public_secret",
            "id": "8ec6b4b4-6f0e-4a1e-9a1a-1d2f3c4b5a60",
            "key_id": "Ii0O3Sc78q",
            "expires_at": "2030-01-01T00:00:00Z",
        }))
        .expect("creation response deserializes");

        let entry = LeaseLedgerEntry {
            session_id: "session-a".to_string(),
            key_id: created.key_id.clone(),
            revoke_id: created.id.clone(),
            expires_at: created.expires_at.clone().unwrap_or_default(),
            pending_revocation: false,
        };

        assert_ne!(entry.revoke_id, entry.key_id);
        assert_eq!(entry.revoke_id, "8ec6b4b4-6f0e-4a1e-9a1a-1d2f3c4b5a60");
        assert_eq!(uuid::Uuid::parse_str(&entry.revoke_id).is_ok(), true);
        assert!(uuid::Uuid::parse_str(&entry.key_id).is_err());
    }

    /// Ledgers written before the two ids were distinguished carry no usable
    /// revocation handle. They must be dropped, not retried every launch.
    #[test]
    fn credential_lease_ledger_reads_records_written_before_revoke_ids() {
        let legacy = serde_json::json!({
            "leases": [{
                "session_id": "session-a",
                "key_id": "Ii0O3Sc78q",
                "expires_at": "2030-01-01T00:00:00Z",
                "pending_revocation": true,
            }]
        });
        let ledger: CredentialLeaseLedger =
            serde_json::from_value(legacy).expect("legacy ledger still parses");
        assert_eq!(ledger.leases[0].revoke_id, "");
    }

    #[test]
    fn credential_lease_ledger_round_trips_non_secret_records() {
        let ledger = CredentialLeaseLedger {
            leases: vec![record("session-a", "key-a", false)],
        };
        let value = serde_json::to_value(&ledger).expect("ledger serializes");
        assert!(value.get("api_key").is_none());
        let decoded: CredentialLeaseLedger =
            serde_json::from_value(value).expect("ledger deserializes");
        assert_eq!(decoded, ledger);
    }

    #[test]
    fn credential_lease_startup_reaper_selects_all_orphaned_records() {
        let records = vec![
            record("session-a", "key-a", false),
            record("session-b", "key-b", true),
        ];
        assert_eq!(select_startup_reaper_records(&records), records);
    }

    #[test]
    fn credential_lease_ledger_keeps_retry_state_non_secret() {
        let ledger = CredentialLeaseLedger {
            leases: vec![record("session-a", "key-a", true)],
        };
        let encoded = serde_json::to_string(&ledger).expect("ledger serializes");
        assert!(encoded.contains("pending_revocation"));
        assert!(!encoded.contains("api_key"));
    }
}
