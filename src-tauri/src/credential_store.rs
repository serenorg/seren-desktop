// ABOUTME: Stores desktop credentials in the native OS credential store.
// ABOUTME: Migrates legacy Tauri JSON values only after a verified keychain write.

use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_store::StoreExt;

const AUTH_STORE: &str = "auth.json";
const PROVIDERS_STORE: &str = "providers.json";
const OAUTH_STORE: &str = "oauth.json";
const MCP_OAUTH_STORE: &str = "mcp-oauth.json";
const METADATA_STORE: &str = "credential-metadata.json";

const TOKEN_KEY: &str = "token";
const REFRESH_TOKEN_KEY: &str = "refresh_token";
const SEREN_API_KEY: &str = "seren_api_key";
const SEREN_SKILL_API_KEY: &str = "seren_skill_api_key";
const MCP_ACCESS_TOKEN_KEY: &str = "mcp_access_token";
const MCP_REFRESH_TOKEN_KEY: &str = "mcp_refresh_token";

const FIXED_CREDENTIALS: &str = "fixed_credentials";
const PROVIDER_API_KEYS: &str = "provider_api_keys";
const PROVIDER_OAUTH: &str = "provider_oauth";

const ACCESS_TOKEN_ACCOUNT: &str = "seren.auth.access-token.v1";
const REFRESH_TOKEN_ACCOUNT: &str = "seren.auth.refresh-token.v1";
const SEREN_API_KEY_ACCOUNT: &str = "seren.api-key.v1";
const SEREN_SKILL_API_KEY_ACCOUNT: &str = "seren.skill-api-key.v1";
const MCP_ACCESS_TOKEN_ACCOUNT: &str = "seren.mcp-oauth.access-token.v1";
const MCP_REFRESH_TOKEN_ACCOUNT: &str = "seren.mcp-oauth.refresh-token.v1";

trait SecureBackend: Send + Sync {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;
}

struct KeyringBackend;

impl KeyringBackend {
    fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(service, account).map_err(|error| error.to_string())
    }
}

impl SecureBackend for KeyringBackend {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        match Self::entry(service, account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        Self::entry(service, account)?
            .set_password(value)
            .map_err(|error| error.to_string())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        match Self::entry(service, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// Process-local owner for credential mutations. The mutex serializes migration,
/// refresh, sign-in, and sign-out so a legacy value cannot race a newer keychain
/// write back into service.
pub(crate) struct CredentialStoreState {
    secure: Arc<dyn SecureBackend>,
    mutation: Mutex<()>,
    #[cfg(test)]
    test_persistence: Option<Mutex<TestPersistence>>,
}

impl CredentialStoreState {
    pub(crate) fn new_os() -> Self {
        Self {
            secure: Arc::new(KeyringBackend),
            mutation: Mutex::new(()),
            #[cfg(test)]
            test_persistence: None,
        }
    }

    #[cfg(test)]
    fn new_test(secure: Arc<dyn SecureBackend>) -> Self {
        Self {
            secure,
            mutation: Mutex::new(()),
            test_persistence: Some(Mutex::new(TestPersistence::default())),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_memory_for_tests() -> Self {
        Self::new_test(Arc::new(TestMemorySecureBackend::default()))
    }
}

#[cfg(test)]
#[derive(Default)]
struct TestMemorySecureBackend {
    values: Mutex<std::collections::HashMap<(String, String), String>>,
}

#[cfg(test)]
impl SecureBackend for TestMemorySecureBackend {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        Ok(self
            .values
            .lock()
            .map_err(|_| "test OS credential store lock poisoned".to_string())?
            .get(&(service.to_string(), account.to_string()))
            .cloned())
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "test OS credential store lock poisoned".to_string())?
            .insert(
                (service.to_string(), account.to_string()),
                value.to_string(),
            );
        Ok(())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "test OS credential store lock poisoned".to_string())?
            .remove(&(service.to_string(), account.to_string()));
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProtectedSetting {
    SerenApiKey,
    SerenSkillApiKey,
    McpAccessToken,
    McpRefreshToken,
}

pub(crate) fn protected_setting(store: &str, key: &str) -> Option<ProtectedSetting> {
    match (store, key) {
        (AUTH_STORE, SEREN_API_KEY) => Some(ProtectedSetting::SerenApiKey),
        (AUTH_STORE, SEREN_SKILL_API_KEY) => Some(ProtectedSetting::SerenSkillApiKey),
        (MCP_OAUTH_STORE, MCP_ACCESS_TOKEN_KEY) => Some(ProtectedSetting::McpAccessToken),
        (MCP_OAUTH_STORE, MCP_REFRESH_TOKEN_KEY) => Some(ProtectedSetting::McpRefreshToken),
        _ => None,
    }
}

struct CredentialDescriptor<'a> {
    account: String,
    legacy_store: &'static str,
    legacy_key: Cow<'a, str>,
    metadata_group: &'static str,
    metadata_id: Cow<'a, str>,
    label: &'static str,
}

impl CredentialDescriptor<'static> {
    fn access_token() -> Self {
        Self::fixed(
            ACCESS_TOKEN_ACCOUNT,
            AUTH_STORE,
            TOKEN_KEY,
            "Seren access token",
        )
    }

    fn refresh_token() -> Self {
        Self::fixed(
            REFRESH_TOKEN_ACCOUNT,
            AUTH_STORE,
            REFRESH_TOKEN_KEY,
            "Seren refresh token",
        )
    }

    fn seren_api_key() -> Self {
        Self::fixed(
            SEREN_API_KEY_ACCOUNT,
            AUTH_STORE,
            SEREN_API_KEY,
            "Seren API key",
        )
    }

    fn seren_skill_api_key() -> Self {
        Self::fixed(
            SEREN_SKILL_API_KEY_ACCOUNT,
            AUTH_STORE,
            SEREN_SKILL_API_KEY,
            "Seren skill API key",
        )
    }

    fn mcp_access_token() -> Self {
        Self::fixed(
            MCP_ACCESS_TOKEN_ACCOUNT,
            MCP_OAUTH_STORE,
            MCP_ACCESS_TOKEN_KEY,
            "MCP OAuth access token",
        )
    }

    fn mcp_refresh_token() -> Self {
        Self::fixed(
            MCP_REFRESH_TOKEN_ACCOUNT,
            MCP_OAUTH_STORE,
            MCP_REFRESH_TOKEN_KEY,
            "MCP OAuth refresh token",
        )
    }

    fn fixed(
        account: &'static str,
        legacy_store: &'static str,
        legacy_key: &'static str,
        label: &'static str,
    ) -> Self {
        Self {
            account: account.to_string(),
            legacy_store,
            legacy_key: Cow::Borrowed(legacy_key),
            metadata_group: FIXED_CREDENTIALS,
            metadata_id: Cow::Borrowed(account),
            label,
        }
    }
}

impl<'a> CredentialDescriptor<'a> {
    fn provider_api_key(provider: &'a str) -> Self {
        Self::provider(
            "seren.provider-api-key.v1",
            PROVIDERS_STORE,
            PROVIDER_API_KEYS,
            provider,
            "provider API key",
        )
    }

    fn provider_oauth(provider: &'a str) -> Self {
        Self::provider(
            "seren.provider-oauth.v1",
            OAUTH_STORE,
            PROVIDER_OAUTH,
            provider,
            "provider OAuth credentials",
        )
    }

    fn provider(
        account_prefix: &'static str,
        legacy_store: &'static str,
        metadata_group: &'static str,
        provider: &'a str,
        label: &'static str,
    ) -> Self {
        let provider_hash = hex::encode(Sha256::digest(provider.as_bytes()));
        Self {
            account: format!("{account_prefix}.{provider_hash}"),
            legacy_store,
            legacy_key: Cow::Borrowed(provider),
            metadata_group,
            metadata_id: Cow::Borrowed(provider),
            label,
        }
    }
}

fn credential_state<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<tauri::State<'_, CredentialStoreState>, String> {
    app.try_state::<CredentialStoreState>().ok_or_else(|| {
        "OS credential store is not initialized; restart Seren Desktop and retry".to_string()
    })
}

fn mutation_guard(state: &CredentialStoreState) -> Result<MutexGuard<'_, ()>, String> {
    state.mutation.lock().map_err(|_| {
        "OS credential store mutation lock is unavailable; restart and retry".to_string()
    })
}

fn credential_error(label: &str, operation: &str, error: &str) -> String {
    format!(
        "OS credential store could not {operation} {label}: {error}. Unlock or configure the platform credential store and retry; Seren will not fall back to plaintext storage"
    )
}

fn secure_get<R: Runtime>(
    app: &AppHandle<R>,
    state: &CredentialStoreState,
    descriptor: &CredentialDescriptor<'_>,
) -> Result<Option<String>, String> {
    state
        .secure
        .get(&app.config().identifier, &descriptor.account)
        .map_err(|error| credential_error(descriptor.label, "read", &error))
}

fn secure_set_verified<R: Runtime>(
    app: &AppHandle<R>,
    state: &CredentialStoreState,
    descriptor: &CredentialDescriptor<'_>,
    value: &str,
) -> Result<(), String> {
    let service = &app.config().identifier;
    state
        .secure
        .set(service, &descriptor.account, value)
        .map_err(|error| credential_error(descriptor.label, "store", &error))?;

    match state.secure.get(service, &descriptor.account) {
        Ok(Some(stored)) if stored == value => Ok(()),
        Ok(Some(_)) => Err(credential_error(
            descriptor.label,
            "verify",
            "the value read back did not match the value written",
        )),
        Ok(None) => Err(credential_error(
            descriptor.label,
            "verify",
            "the value was absent immediately after writing",
        )),
        Err(error) => Err(credential_error(descriptor.label, "verify", &error)),
    }
}

fn secure_delete<R: Runtime>(
    app: &AppHandle<R>,
    state: &CredentialStoreState,
    descriptor: &CredentialDescriptor<'_>,
) -> Result<(), String> {
    state
        .secure
        .delete(&app.config().identifier, &descriptor.account)
        .map_err(|error| credential_error(descriptor.label, "delete", &error))
}

#[cfg(test)]
#[derive(Default, serde::Serialize)]
struct TestPersistence {
    legacy: std::collections::BTreeMap<(String, String), String>,
    metadata: std::collections::BTreeMap<String, BTreeSet<String>>,
}

fn legacy_get<R: Runtime>(
    app: &AppHandle<R>,
    _state: &CredentialStoreState,
    store_name: &str,
    key: &str,
) -> Result<Option<String>, String> {
    #[cfg(test)]
    if let Some(persistence) = &_state.test_persistence {
        return Ok(persistence
            .lock()
            .map_err(|_| "test credential persistence lock poisoned".to_string())?
            .legacy
            .get(&(store_name.to_string(), key.to_string()))
            .cloned());
    }

    let store = app.store(store_name).map_err(|error| {
        format!("failed to open legacy credential store for migration: {error}")
    })?;
    match store.get(key) {
        Some(value) => value
            .as_str()
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| {
                "legacy credential value has an unexpected format; it was preserved".to_string()
            }),
        None => Ok(None),
    }
}

fn legacy_keys<R: Runtime>(
    app: &AppHandle<R>,
    _state: &CredentialStoreState,
    store_name: &str,
) -> Result<Vec<String>, String> {
    #[cfg(test)]
    if let Some(persistence) = &_state.test_persistence {
        let persistence = persistence
            .lock()
            .map_err(|_| "test credential persistence lock poisoned".to_string())?;
        return Ok(persistence
            .legacy
            .keys()
            .filter(|(candidate_store, _)| candidate_store == store_name)
            .map(|(_, key)| key.clone())
            .collect());
    }

    app.store(store_name)
        .map(|store| store.keys())
        .map_err(|error| format!("failed to enumerate legacy credential store: {error}"))
}

fn legacy_delete<R: Runtime>(
    app: &AppHandle<R>,
    _state: &CredentialStoreState,
    store_name: &str,
    key: &str,
) -> Result<(), String> {
    #[cfg(test)]
    if let Some(persistence) = &_state.test_persistence {
        persistence
            .lock()
            .map_err(|_| "test credential persistence lock poisoned".to_string())?
            .legacy
            .remove(&(store_name.to_string(), key.to_string()));
        return Ok(());
    }

    let store = app
        .store(store_name)
        .map_err(|error| format!("failed to open legacy credential store for cleanup: {error}"))?;
    let previous = store.get(key);
    if previous.is_none() {
        return Ok(());
    }

    store.delete(key);
    if let Err(error) = store.save() {
        if let Some(previous) = previous {
            store.set(key, previous);
            let _ = store.save();
        }
        return Err(format!(
            "failed to remove a migrated plaintext credential; the legacy value was preserved for retry: {error}"
        ));
    }
    Ok(())
}

fn metadata_list<R: Runtime>(
    app: &AppHandle<R>,
    _state: &CredentialStoreState,
    group: &str,
) -> Result<BTreeSet<String>, String> {
    #[cfg(test)]
    if let Some(persistence) = &_state.test_persistence {
        return Ok(persistence
            .lock()
            .map_err(|_| "test credential persistence lock poisoned".to_string())?
            .metadata
            .get(group)
            .cloned()
            .unwrap_or_default());
    }

    let store = app
        .store(METADATA_STORE)
        .map_err(|error| format!("failed to open credential metadata: {error}"))?;
    match store.get(group) {
        Some(value) => serde_json::from_value::<BTreeSet<String>>(value.clone())
            .map_err(|_| "credential metadata is invalid; no secret was read".to_string()),
        None => Ok(BTreeSet::new()),
    }
}

fn metadata_replace<R: Runtime>(
    app: &AppHandle<R>,
    _state: &CredentialStoreState,
    group: &str,
    values: &BTreeSet<String>,
) -> Result<(), String> {
    #[cfg(test)]
    if let Some(persistence) = &_state.test_persistence {
        let mut persistence = persistence
            .lock()
            .map_err(|_| "test credential persistence lock poisoned".to_string())?;
        if values.is_empty() {
            persistence.metadata.remove(group);
        } else {
            persistence
                .metadata
                .insert(group.to_string(), values.clone());
        }
        return Ok(());
    }

    let store = app
        .store(METADATA_STORE)
        .map_err(|error| format!("failed to open credential metadata: {error}"))?;
    let previous = store.get(group);
    if values.is_empty() {
        store.delete(group);
    } else {
        store.set(group, serde_json::json!(values));
    }

    if let Err(error) = store.save() {
        match previous {
            Some(previous) => store.set(group, previous),
            None => {
                store.delete(group);
            }
        }
        let _ = store.save();
        return Err(format!(
            "failed to persist non-secret credential metadata: {error}"
        ));
    }
    Ok(())
}

fn metadata_contains<R: Runtime>(
    app: &AppHandle<R>,
    state: &CredentialStoreState,
    descriptor: &CredentialDescriptor<'_>,
) -> Result<bool, String> {
    Ok(metadata_list(app, state, descriptor.metadata_group)?
        .contains(descriptor.metadata_id.as_ref()))
}

fn metadata_mark<R: Runtime>(
    app: &AppHandle<R>,
    state: &CredentialStoreState,
    descriptor: &CredentialDescriptor<'_>,
) -> Result<(), String> {
    let mut values = metadata_list(app, state, descriptor.metadata_group)?;
    if values.insert(descriptor.metadata_id.to_string()) {
        metadata_replace(app, state, descriptor.metadata_group, &values)?;
    }
    Ok(())
}

fn metadata_unmark<R: Runtime>(
    app: &AppHandle<R>,
    state: &CredentialStoreState,
    descriptor: &CredentialDescriptor<'_>,
) -> Result<(), String> {
    let mut values = metadata_list(app, state, descriptor.metadata_group)?;
    if values.remove(descriptor.metadata_id.as_ref()) {
        metadata_replace(app, state, descriptor.metadata_group, &values)?;
    }
    Ok(())
}

fn read_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &CredentialStoreState,
    descriptor: &CredentialDescriptor<'_>,
) -> Result<Option<String>, String> {
    let legacy = legacy_get(
        app,
        state,
        descriptor.legacy_store,
        descriptor.legacy_key.as_ref(),
    )?;
    let marked = metadata_contains(app, state, descriptor)?;

    if !marked {
        let Some(legacy_value) = legacy else {
            // Every successful keychain write records metadata before deleting
            // plaintext. With neither marker nor legacy value, no credential is
            // canonical, so do not probe or expose an orphaned keychain entry.
            return Ok(None);
        };
        if legacy_value.trim().is_empty() {
            legacy_delete(
                app,
                state,
                descriptor.legacy_store,
                descriptor.legacy_key.as_ref(),
            )?;
            return Ok(None);
        }
        return migrate_legacy_inner(app, state, descriptor, legacy_value);
    }

    match secure_get(app, state, descriptor)? {
        Some(value) => {
            if legacy.is_some() {
                legacy_delete(
                    app,
                    state,
                    descriptor.legacy_store,
                    descriptor.legacy_key.as_ref(),
                )?;
            }
            Ok(Some(value))
        }
        None => match legacy {
            Some(legacy_value) if !legacy_value.trim().is_empty() => {
                // A marker with a missing native entry can happen after an OS
                // credential-store reset. Preserve availability by remigrating
                // the still-present legacy value through the same verify gate.
                migrate_legacy_inner(app, state, descriptor, legacy_value)
            }
            Some(_) => {
                legacy_delete(
                    app,
                    state,
                    descriptor.legacy_store,
                    descriptor.legacy_key.as_ref(),
                )?;
                metadata_unmark(app, state, descriptor)?;
                Ok(None)
            }
            None => {
                metadata_unmark(app, state, descriptor)?;
                Ok(None)
            }
        },
    }
}

fn migrate_legacy_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &CredentialStoreState,
    descriptor: &CredentialDescriptor<'_>,
    legacy_value: String,
) -> Result<Option<String>, String> {
    secure_set_verified(app, state, descriptor, &legacy_value)?;
    if let Err(error) = metadata_mark(app, state, descriptor) {
        let _ = secure_delete(app, state, descriptor);
        return Err(error);
    }
    legacy_delete(
        app,
        state,
        descriptor.legacy_store,
        descriptor.legacy_key.as_ref(),
    )?;
    Ok(Some(legacy_value))
}

fn store_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &CredentialStoreState,
    descriptor: &CredentialDescriptor<'_>,
    value: &str,
) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{} must not be empty", descriptor.label));
    }

    secure_set_verified(app, state, descriptor, value)?;
    if let Err(error) = metadata_mark(app, state, descriptor) {
        let _ = secure_delete(app, state, descriptor);
        return Err(error);
    }
    legacy_delete(
        app,
        state,
        descriptor.legacy_store,
        descriptor.legacy_key.as_ref(),
    )
}

fn delete_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &CredentialStoreState,
    descriptor: &CredentialDescriptor<'_>,
) -> Result<(), String> {
    // Scrub legacy first so a failed native delete cannot be followed by a
    // retry that resurrects old plaintext into the keychain.
    legacy_delete(
        app,
        state,
        descriptor.legacy_store,
        descriptor.legacy_key.as_ref(),
    )?;
    secure_delete(app, state, descriptor)?;
    metadata_unmark(app, state, descriptor)
}

fn read<R: Runtime>(
    app: &AppHandle<R>,
    descriptor: CredentialDescriptor<'_>,
) -> Result<Option<String>, String> {
    let state = credential_state(app)?;
    let _guard = mutation_guard(&state)?;
    read_inner(app, &state, &descriptor)
}

fn store<R: Runtime>(
    app: &AppHandle<R>,
    descriptor: CredentialDescriptor<'_>,
    value: &str,
) -> Result<(), String> {
    let state = credential_state(app)?;
    let _guard = mutation_guard(&state)?;
    store_inner(app, &state, &descriptor, value)
}

fn delete<R: Runtime>(
    app: &AppHandle<R>,
    descriptor: CredentialDescriptor<'_>,
) -> Result<(), String> {
    let state = credential_state(app)?;
    let _guard = mutation_guard(&state)?;
    delete_inner(app, &state, &descriptor)
}

pub(crate) fn store_access_token<R: Runtime>(
    app: &AppHandle<R>,
    value: &str,
) -> Result<(), String> {
    store(app, CredentialDescriptor::access_token(), value)
}

pub(crate) fn get_access_token<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    read(app, CredentialDescriptor::access_token())
}

pub(crate) fn clear_access_token<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    delete(app, CredentialDescriptor::access_token())
}

pub(crate) fn store_refresh_token<R: Runtime>(
    app: &AppHandle<R>,
    value: &str,
) -> Result<(), String> {
    store(app, CredentialDescriptor::refresh_token(), value)
}

pub(crate) fn get_refresh_token<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    read(app, CredentialDescriptor::refresh_token())
}

pub(crate) fn clear_refresh_token<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    delete(app, CredentialDescriptor::refresh_token())
}

pub(crate) fn store_seren_api_key<R: Runtime>(
    app: &AppHandle<R>,
    value: &str,
) -> Result<(), String> {
    store(app, CredentialDescriptor::seren_api_key(), value)
}

pub(crate) fn get_seren_api_key<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    read(app, CredentialDescriptor::seren_api_key())
}

pub(crate) fn clear_seren_api_key<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    delete(app, CredentialDescriptor::seren_api_key())
}

pub(crate) fn store_seren_skill_api_key<R: Runtime>(
    app: &AppHandle<R>,
    value: &str,
) -> Result<(), String> {
    store(app, CredentialDescriptor::seren_skill_api_key(), value)
}

/// The publisher-invocation-only key handed to skill child processes and the
/// SerenDB data plane. Deliberately separate from the Desktop key, which also
/// carries publisher-administration scopes for the approval-gated MCP path
/// and must never be exported into a child process. #3675
pub(crate) fn get_seren_skill_api_key<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<String>, String> {
    read(app, CredentialDescriptor::seren_skill_api_key())
}

pub(crate) fn clear_seren_skill_api_key<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    delete(app, CredentialDescriptor::seren_skill_api_key())
}

pub(crate) fn store_provider_api_key<R: Runtime>(
    app: &AppHandle<R>,
    provider: &str,
    value: &str,
) -> Result<(), String> {
    validate_provider(provider)?;
    store(app, CredentialDescriptor::provider_api_key(provider), value)
}

pub(crate) fn get_provider_api_key<R: Runtime>(
    app: &AppHandle<R>,
    provider: &str,
) -> Result<Option<String>, String> {
    validate_provider(provider)?;
    read(app, CredentialDescriptor::provider_api_key(provider))
}

pub(crate) fn clear_provider_api_key<R: Runtime>(
    app: &AppHandle<R>,
    provider: &str,
) -> Result<(), String> {
    validate_provider(provider)?;
    delete(app, CredentialDescriptor::provider_api_key(provider))
}

pub(crate) fn configured_api_key_providers<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<String>, String> {
    configured_providers(app, PROVIDERS_STORE, PROVIDER_API_KEYS, |provider| {
        CredentialDescriptor::provider_api_key(provider)
    })
}

pub(crate) fn store_provider_oauth<R: Runtime>(
    app: &AppHandle<R>,
    provider: &str,
    value: &str,
) -> Result<(), String> {
    validate_provider(provider)?;
    store(app, CredentialDescriptor::provider_oauth(provider), value)
}

pub(crate) fn get_provider_oauth<R: Runtime>(
    app: &AppHandle<R>,
    provider: &str,
) -> Result<Option<String>, String> {
    validate_provider(provider)?;
    read(app, CredentialDescriptor::provider_oauth(provider))
}

pub(crate) fn clear_provider_oauth<R: Runtime>(
    app: &AppHandle<R>,
    provider: &str,
) -> Result<(), String> {
    validate_provider(provider)?;
    delete(app, CredentialDescriptor::provider_oauth(provider))
}

pub(crate) fn configured_oauth_providers<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<String>, String> {
    configured_providers(app, OAUTH_STORE, PROVIDER_OAUTH, |provider| {
        CredentialDescriptor::provider_oauth(provider)
    })
}

fn configured_providers<R, F>(
    app: &AppHandle<R>,
    legacy_store: &str,
    metadata_group: &str,
    descriptor: F,
) -> Result<Vec<String>, String>
where
    R: Runtime,
    F: for<'a> Fn(&'a str) -> CredentialDescriptor<'a>,
{
    let state = credential_state(app)?;
    let _guard = mutation_guard(&state)?;
    for provider in legacy_keys(app, &state, legacy_store)? {
        validate_provider(&provider)?;
        read_inner(app, &state, &descriptor(&provider))?;
    }
    Ok(metadata_list(app, &state, metadata_group)?
        .into_iter()
        .collect())
}

fn validate_provider(provider: &str) -> Result<(), String> {
    if provider.trim().is_empty() {
        Err("provider identifier must not be empty".to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn get_protected_setting<R: Runtime>(
    app: &AppHandle<R>,
    setting: ProtectedSetting,
) -> Result<Option<String>, String> {
    match setting {
        ProtectedSetting::SerenApiKey => get_seren_api_key(app),
        ProtectedSetting::SerenSkillApiKey => get_seren_skill_api_key(app),
        ProtectedSetting::McpAccessToken => read(app, CredentialDescriptor::mcp_access_token()),
        ProtectedSetting::McpRefreshToken => read(app, CredentialDescriptor::mcp_refresh_token()),
    }
}

pub(crate) fn set_protected_setting<R: Runtime>(
    app: &AppHandle<R>,
    setting: ProtectedSetting,
    value: &str,
) -> Result<(), String> {
    if value.trim().is_empty() {
        return match setting {
            ProtectedSetting::SerenApiKey => clear_seren_api_key(app),
            ProtectedSetting::SerenSkillApiKey => clear_seren_skill_api_key(app),
            ProtectedSetting::McpAccessToken => {
                delete(app, CredentialDescriptor::mcp_access_token())
            }
            ProtectedSetting::McpRefreshToken => {
                delete(app, CredentialDescriptor::mcp_refresh_token())
            }
        };
    }

    match setting {
        ProtectedSetting::SerenApiKey => store_seren_api_key(app, value),
        ProtectedSetting::SerenSkillApiKey => store_seren_skill_api_key(app, value),
        ProtectedSetting::McpAccessToken => {
            store(app, CredentialDescriptor::mcp_access_token(), value)
        }
        ProtectedSetting::McpRefreshToken => {
            store(app, CredentialDescriptor::mcp_refresh_token(), value)
        }
    }
}

/// Migrate every known legacy credential class. Startup logs an error and
/// continues if this fails so the renderer can surface the same actionable
/// error on access; no command falls back to plaintext.
pub(crate) fn migrate_legacy_credentials<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = credential_state(app)?;
    let _guard = mutation_guard(&state)?;

    for descriptor in [
        CredentialDescriptor::access_token(),
        CredentialDescriptor::refresh_token(),
        CredentialDescriptor::seren_api_key(),
        CredentialDescriptor::mcp_access_token(),
        CredentialDescriptor::mcp_refresh_token(),
    ] {
        if legacy_get(
            app,
            &state,
            descriptor.legacy_store,
            descriptor.legacy_key.as_ref(),
        )?
        .is_some()
        {
            read_inner(app, &state, &descriptor)?;
        }
    }

    for provider in legacy_keys(app, &state, PROVIDERS_STORE)? {
        validate_provider(&provider)?;
        read_inner(
            app,
            &state,
            &CredentialDescriptor::provider_api_key(&provider),
        )?;
    }
    for provider in legacy_keys(app, &state, OAUTH_STORE)? {
        validate_provider(&provider)?;
        read_inner(
            app,
            &state,
            &CredentialDescriptor::provider_oauth(&provider),
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// The skill key exists so a child process never receives the Desktop
    /// key's publisher-administration scopes. Aliasing the two slots would
    /// silently hand the broad key back to skills. #3675
    #[test]
    fn skill_key_never_aliases_the_desktop_key_slot() {
        let desktop = CredentialDescriptor::seren_api_key();
        let skill = CredentialDescriptor::seren_skill_api_key();

        assert_ne!(desktop.account, skill.account);
        assert_ne!(desktop.legacy_key, skill.legacy_key);
        assert_eq!(
            protected_setting(AUTH_STORE, SEREN_SKILL_API_KEY),
            Some(ProtectedSetting::SerenSkillApiKey)
        );
        assert_eq!(
            protected_setting(AUTH_STORE, SEREN_API_KEY),
            Some(ProtectedSetting::SerenApiKey)
        );
    }

    #[derive(Default)]
    struct MemorySecureBackend {
        values: Mutex<HashMap<(String, String), String>>,
        set_calls: AtomicUsize,
        fail_set_call: AtomicUsize,
        corrupt_next_read: AtomicUsize,
    }

    impl MemorySecureBackend {
        fn fail_on_set_call(&self, call: usize) {
            self.fail_set_call.store(call, Ordering::SeqCst);
        }

        fn corrupt_next_read(&self) {
            self.corrupt_next_read.store(1, Ordering::SeqCst);
        }
    }

    impl SecureBackend for MemorySecureBackend {
        fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            let value = self
                .values
                .lock()
                .expect("memory secure store locks")
                .get(&(service.to_string(), account.to_string()))
                .cloned();
            if self.corrupt_next_read.swap(0, Ordering::SeqCst) == 1 && value.is_some() {
                return Ok(Some("verification-mismatch".to_string()));
            }
            Ok(value)
        }

        fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
            let call = self.set_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if self.fail_set_call.load(Ordering::SeqCst) == call {
                return Err("injected secure-store failure".to_string());
            }
            self.values
                .lock()
                .expect("memory secure store locks")
                .insert(
                    (service.to_string(), account.to_string()),
                    value.to_string(),
                );
            Ok(())
        }

        fn delete(&self, service: &str, account: &str) -> Result<(), String> {
            self.values
                .lock()
                .expect("memory secure store locks")
                .remove(&(service.to_string(), account.to_string()));
            Ok(())
        }
    }

    fn test_app(secure: Arc<MemorySecureBackend>) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(CredentialStoreState::new_test(secure));
        app
    }

    fn seed_legacy<R: Runtime>(
        app: &tauri::App<R>,
        descriptor: &CredentialDescriptor<'_>,
        value: &str,
    ) {
        let state = app.state::<CredentialStoreState>();
        state
            .test_persistence
            .as_ref()
            .expect("test persistence configured")
            .lock()
            .expect("test persistence locks")
            .legacy
            .insert(
                (
                    descriptor.legacy_store.to_string(),
                    descriptor.legacy_key.to_string(),
                ),
                value.to_string(),
            );
    }

    fn all_descriptors() -> Vec<CredentialDescriptor<'static>> {
        vec![
            CredentialDescriptor::access_token(),
            CredentialDescriptor::refresh_token(),
            CredentialDescriptor::seren_api_key(),
            CredentialDescriptor::mcp_access_token(),
            CredentialDescriptor::mcp_refresh_token(),
            CredentialDescriptor::provider_api_key("test-provider"),
            CredentialDescriptor::provider_oauth("test-oauth-provider"),
        ]
    }

    #[test]
    fn every_credential_class_supports_create_read_update_and_delete() {
        let secure = Arc::new(MemorySecureBackend::default());
        let app = test_app(secure);
        let state = app.state::<CredentialStoreState>();

        for (index, descriptor) in all_descriptors().iter().enumerate() {
            let first = format!("test-secret-{index}-first");
            let second = format!("test-secret-{index}-second");
            store_inner(app.handle(), &state, descriptor, &first).unwrap();
            assert_eq!(
                read_inner(app.handle(), &state, descriptor).unwrap(),
                Some(first)
            );
            store_inner(app.handle(), &state, descriptor, &second).unwrap();
            assert_eq!(
                read_inner(app.handle(), &state, descriptor).unwrap(),
                Some(second)
            );
            delete_inner(app.handle(), &state, descriptor).unwrap();
            assert_eq!(read_inner(app.handle(), &state, descriptor).unwrap(), None);
        }
    }

    #[test]
    fn partial_migration_preserves_plaintext_then_retries_all_classes() {
        let secure = Arc::new(MemorySecureBackend::default());
        secure.fail_on_set_call(3);
        let app = test_app(secure.clone());
        let descriptors = all_descriptors();
        let seeded: Vec<String> = descriptors
            .iter()
            .enumerate()
            .map(|(index, descriptor)| {
                let value = format!("legacy-test-secret-{index}");
                seed_legacy(&app, descriptor, &value);
                value
            })
            .collect();

        let first = migrate_legacy_credentials(app.handle());
        assert!(
            first.is_err(),
            "the injected third write must stop migration"
        );

        let state = app.state::<CredentialStoreState>();
        let persistence = state.test_persistence.as_ref().unwrap().lock().unwrap();
        assert!(
            !persistence.legacy.contains_key(&(
                descriptors[0].legacy_store.to_string(),
                descriptors[0].legacy_key.to_string()
            )),
            "successfully verified migrations scrub their legacy value"
        );
        assert!(
            persistence.legacy.contains_key(&(
                descriptors[2].legacy_store.to_string(),
                descriptors[2].legacy_key.to_string()
            )),
            "the failed migration preserves plaintext for retry"
        );
        drop(persistence);

        migrate_legacy_credentials(app.handle()).unwrap();
        let persistence = state.test_persistence.as_ref().unwrap().lock().unwrap();
        assert!(persistence.legacy.is_empty());

        let persisted_fixture = serde_json::to_string(&*persistence).unwrap();
        for value in &seeded {
            assert!(
                !persisted_fixture.contains(value),
                "persisted app-store metadata must not contain seeded secret material"
            );
        }
        drop(persistence);

        for (descriptor, expected) in descriptors.iter().zip(seeded) {
            assert_eq!(
                read_inner(app.handle(), &state, descriptor).unwrap(),
                Some(expected)
            );
        }
        assert_eq!(
            configured_api_key_providers(app.handle()).unwrap(),
            vec!["test-provider".to_string()]
        );
        assert_eq!(
            configured_oauth_providers(app.handle()).unwrap(),
            vec!["test-oauth-provider".to_string()]
        );
    }

    #[test]
    fn failed_write_verification_keeps_legacy_value_for_retry() {
        let secure = Arc::new(MemorySecureBackend::default());
        secure.corrupt_next_read();
        let app = test_app(secure);
        let descriptor = CredentialDescriptor::provider_oauth("verification-test-provider");
        seed_legacy(&app, &descriptor, "legacy-verification-test-secret");

        let state = app.state::<CredentialStoreState>();
        assert!(read_inner(app.handle(), &state, &descriptor).is_err());
        assert_eq!(
            legacy_get(
                app.handle(),
                &state,
                descriptor.legacy_store,
                descriptor.legacy_key.as_ref()
            )
            .unwrap(),
            Some("legacy-verification-test-secret".to_string())
        );

        assert_eq!(
            read_inner(app.handle(), &state, &descriptor).unwrap(),
            Some("legacy-verification-test-secret".to_string())
        );
        assert_eq!(
            legacy_get(
                app.handle(),
                &state,
                descriptor.legacy_store,
                descriptor.legacy_key.as_ref()
            )
            .unwrap(),
            None
        );
    }

    #[test]
    #[cfg_attr(
        target_os = "linux",
        ignore = "requires a running Secret Service session"
    )]
    fn native_backend_round_trip_uses_platform_credential_store() {
        let service = "com.serendb.desktop.credential-store-test";
        let account = format!(
            "credential-store-test-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        );
        let backend = KeyringBackend;
        let _ = backend.delete(service, &account);

        backend
            .set(service, &account, "native-test-secret")
            .unwrap();
        #[cfg(target_os = "macos")]
        assert!(
            std::process::Command::new("security")
                .args(["find-generic-password", "-s", service, "-a", &account])
                .output()
                .unwrap()
                .status
                .success()
        );
        assert_eq!(
            backend.get(service, &account).unwrap(),
            Some("native-test-secret".to_string())
        );
        backend.delete(service, &account).unwrap();
        assert_eq!(backend.get(service, &account).unwrap(), None);
    }
}
