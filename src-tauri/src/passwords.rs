// ABOUTME: Tauri commands for creating encrypted Seren Passwords entries.
// ABOUTME: Uses seren-secrets crypto locally so Desktop never sends plaintext to the service.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use crate::orchestrator::gateway_envelope::{publisher_status, unwrap_publisher_body};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use seren_secrets_crypto::CryptoError;
use seren_secrets_crypto::keys::{
    IdentityKemPublicKey, IdentitySigningPublicKey, ItemContentKey, VaultKey,
};
use seren_secrets_crypto::protocol::account::{AccountSecrets, account_setup, unlock_account};
use seren_secrets_crypto::protocol::item::{
    ApiCredentialContent, ApiCredentialKind, CustomField, CustomFieldKind, DecryptedItemContent,
    FieldPurpose, ItemContent, LoginContent, LoginUrl, TotpAlgorithm, TotpConfig,
    decrypt_item_with_content_key, decrypt_metadata_json, decrypt_tags, decrypt_title,
    encrypt_item_with_content_key, encrypt_metadata_json, encrypt_tags, encrypt_title,
    generate_item_content_key, unwrap_item_content_key, wrap_item_content_key,
};
use seren_secrets_crypto::protocol::vault::{
    decrypt_vault_name, encrypt_vault_description, encrypt_vault_name, generate_vault_key,
    unwrap_vault_key, wrap_vault_key_for_identity,
};
use tauri::AppHandle;
use tokio::sync::Mutex;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const PASSWORDS_BASE_URL: &str = "https://api.serendb.com/publishers/seren-passwords";
const MAX_SECRET_FIELDS: usize = 16;
const MAX_FIELD_NAME_LEN: usize = 128;
const MAX_FIELD_VALUE_LEN: usize = 32 * 1024;
const MIN_MASTER_PASSWORD_LEN: usize = 8;
const MIN_MASTER_PASSWORD_BITS: u32 = 60;

static PASSWORDS_SESSION: OnceLock<Mutex<Option<PasswordsSession>>> = OnceLock::new();

fn passwords_session() -> &'static Mutex<Option<PasswordsSession>> {
    PASSWORDS_SESSION.get_or_init(|| Mutex::new(None))
}

// Types that carry master passwords, plaintext field values, or the
// recovery key deliberately do not derive `Debug`, so they cannot be
// formatted into logs or error strings.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordsSecretFieldInput {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePasswordsApiCredentialRequest {
    master_password: String,
    title: String,
    service_name: String,
    fields: Vec<PasswordsSecretFieldInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePasswordsApiCredentialResponse {
    vault_id: String,
    item_id: String,
    references: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockPasswordsVaultRequest {
    master_password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockPasswordsVaultResponse {
    vaults: Vec<PasswordsVaultSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupPasswordsVaultRequest {
    master_password: String,
    display_name: String,
    vault_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupPasswordsVaultResponse {
    recovery_key_display: String,
    personal_vault_id: String,
    vaults: Vec<PasswordsVaultSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordsVaultSummary {
    vault_id: String,
    name: String,
    writable: bool,
    item_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordsItemSummary {
    vault_id: String,
    item_id: String,
    title: String,
    item_kind: String,
    favorite: bool,
    sensitive: bool,
    reprompt: bool,
    tags: Vec<String>,
    updated_at: String,
    decrypt_error: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordsItemField {
    name: String,
    value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordsItemDetail {
    vault_id: String,
    item_id: String,
    title: String,
    item_kind: String,
    fields: Vec<PasswordsItemField>,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePasswordsApiCredentialRequest {
    vault_id: String,
    item_id: Option<String>,
    title: String,
    service_name: String,
    fields: Vec<PasswordsSecretFieldInput>,
}

#[derive(Clone)]
struct PasswordsSession {
    // KEM public key proven to match the unwrapped private key at unlock;
    // later wrap operations must use this copy rather than re-fetching the
    // server-supplied value, which is unauthenticated.
    kem_public: IdentityKemPublicKey,
    vaults: BTreeMap<Uuid, UnlockedVault>,
}

#[derive(Clone)]
struct UnlockedVault {
    vault_id: Uuid,
    name: String,
    vault_key: VaultKey,
    vault_key_version: i32,
    writable: bool,
    item_count: usize,
}

#[derive(Debug, Deserialize)]
struct DataResponse<T> {
    data: T,
}

#[derive(Debug, Serialize)]
struct AccountSetupRequest {
    kdf_params: serde_json::Value,
    recovery_kdf_params: serde_json::Value,
    account_key_wrap: String,
    account_kem_private_wrap: String,
    account_signing_private_wrap: String,
    recovery_key_wrap: String,
    display_name: String,
    kem_public_key: String,
    signing_public_key: String,
    personal_vault_wrapped_key: String,
    personal_vault_id: Uuid,
    personal_vault_name_ciphertext: String,
    personal_vault_description_ciphertext: Option<String>,
    personal_vault_granted_signature: String,
}

#[derive(Debug, Deserialize)]
struct AccountSetupResponse {
    personal_vault_id: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePasswordsVaultRequest {
    name: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateVaultRequest {
    vault_id: Uuid,
    name_ciphertext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description_ciphertext: Option<String>,
    owner_kind: &'static str,
    access_level: &'static str,
    initial_wrapped_vault_key: String,
    granted_signature: String,
}

#[derive(Debug, Deserialize)]
struct AccountSecretsRecord {
    kdf_params: seren_secrets_crypto::kdf::KdfParams,
    recovery_kdf_params: seren_secrets_crypto::kdf::KdfParams,
    account_key_wrap: String,
    account_kem_private_wrap: String,
    account_signing_private_wrap: String,
    recovery_key_wrap: String,
}

#[derive(Debug, Deserialize)]
struct IdentityRecord {
    identity_id: Uuid,
    kem_public_key: String,
    signing_public_key: String,
}

#[derive(Debug, Deserialize)]
struct SyncResponse {
    vaults: Vec<VaultRecord>,
    #[serde(default)]
    memberships: Option<Vec<MembershipRecord>>,
}

#[derive(Debug, Deserialize)]
struct VaultRecord {
    vault_id: Uuid,
    name_ciphertext: Option<String>,
    wrapped_vault_key: Option<String>,
    vault_key_version: i32,
}

#[derive(Debug, Deserialize)]
struct MembershipRecord {
    vault_id: Uuid,
    identity_id: Uuid,
    access_level: String,
}

#[derive(Debug, Serialize)]
struct CreateItemRequest {
    item_id: Uuid,
    title_ciphertext: String,
    content_ciphertext: String,
    tags_ciphertext: Option<String>,
    title_blind_index: String,
    content_key_wrap: String,
    metadata_ciphertext: String,
    sensitive: bool,
    wrapping_key_version: Option<i32>,
}

#[derive(Debug, Serialize)]
struct UpdateItemRequest {
    title_ciphertext: String,
    content_ciphertext: String,
    tags_ciphertext: Option<String>,
    title_blind_index: String,
    content_key_wrap: String,
    metadata_ciphertext: String,
    sensitive: bool,
    wrapping_key_version: Option<i32>,
}

impl From<&CreateItemRequest> for UpdateItemRequest {
    fn from(value: &CreateItemRequest) -> Self {
        Self {
            title_ciphertext: value.title_ciphertext.clone(),
            content_ciphertext: value.content_ciphertext.clone(),
            tags_ciphertext: value.tags_ciphertext.clone(),
            title_blind_index: value.title_blind_index.clone(),
            content_key_wrap: value.content_key_wrap.clone(),
            metadata_ciphertext: value.metadata_ciphertext.clone(),
            sensitive: value.sensitive,
            wrapping_key_version: value.wrapping_key_version,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ItemSummaryRecord {
    item_id: Uuid,
    vault_id: Uuid,
    title_ciphertext: String,
    tags_ciphertext: Option<String>,
    metadata_ciphertext: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct ItemRecord {
    item_id: Uuid,
    vault_id: Uuid,
    title_ciphertext: String,
    content_ciphertext: String,
    content_key_wrap: String,
    tags_ciphertext: Option<String>,
    metadata_ciphertext: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ItemListMetadata {
    #[serde(default = "default_item_kind")]
    item_kind: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    sensitive: bool,
    #[serde(default)]
    reprompt: bool,
}

struct ExistingItemState {
    metadata: ItemListMetadata,
    content_key: ItemContentKey,
    content_key_wrap: String,
    tags_ciphertext: Option<String>,
    content: DecryptedItemContent,
}

fn default_item_kind() -> String {
    "secure_note".to_string()
}

fn default_api_credential_metadata() -> ItemListMetadata {
    ItemListMetadata {
        item_kind: "api_credential".to_string(),
        favorite: false,
        sensitive: false,
        reprompt: false,
    }
}

#[tauri::command]
pub async fn create_passwords_api_credential(
    app: AppHandle,
    request: CreatePasswordsApiCredentialRequest,
) -> Result<CreatePasswordsApiCredentialResponse, String> {
    // `Zeroizing` scrubs the buffer on drop, so cancellation or a panic
    // during the inner await still wipes the master password instead of
    // leaving it in the heap.
    let master_password = Zeroizing::new(request.master_password.into_bytes());
    let mut fields = sanitize_fields(request.fields)?;
    let title = sanitize_title(&request.title, &request.service_name);

    let result = create_passwords_api_credential_inner(&app, &master_password, &title, &fields)
        .await
        .map_err(|err| err.to_string());

    for field in &mut fields {
        field.value.zeroize();
    }

    result
}

#[tauri::command]
pub async fn unlock_passwords_vault(
    app: AppHandle,
    request: UnlockPasswordsVaultRequest,
) -> Result<UnlockPasswordsVaultResponse, String> {
    let master_password = Zeroizing::new(request.master_password.into_bytes());
    unlock_passwords_vault_inner(&app, &master_password)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn setup_passwords_vault(
    app: AppHandle,
    request: SetupPasswordsVaultRequest,
) -> Result<SetupPasswordsVaultResponse, String> {
    let master_password = Zeroizing::new(request.master_password.into_bytes());
    let display_name = sanitize_display_name(&request.display_name);
    let vault_name = sanitize_vault_name(&request.vault_name);
    setup_passwords_vault_inner(&app, &master_password, &display_name, &vault_name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn create_passwords_vault(
    app: AppHandle,
    request: CreatePasswordsVaultRequest,
) -> Result<UnlockPasswordsVaultResponse, String> {
    let name = sanitize_vault_name(&request.name);
    let description = request
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(512).collect::<String>());
    create_passwords_vault_inner(&app, &name, description.as_deref())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn lock_passwords_vault() -> Result<(), String> {
    let mut session = passwords_session().lock().await;
    *session = None;
    Ok(())
}

#[tauri::command]
pub async fn list_passwords_items(
    app: AppHandle,
    vault_id: String,
) -> Result<Vec<PasswordsItemSummary>, String> {
    let vault_id = parse_uuid(&vault_id, "vault_id")?;
    list_passwords_items_inner(&app, vault_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_passwords_item(
    app: AppHandle,
    vault_id: String,
    item_id: String,
) -> Result<PasswordsItemDetail, String> {
    let vault_id = parse_uuid(&vault_id, "vault_id")?;
    let item_id = parse_uuid(&item_id, "item_id")?;
    get_passwords_item_inner(&app, vault_id, item_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_passwords_api_credential(
    app: AppHandle,
    request: SavePasswordsApiCredentialRequest,
) -> Result<CreatePasswordsApiCredentialResponse, String> {
    let vault_id = parse_uuid(&request.vault_id, "vault_id")?;
    let item_id = match request.item_id.as_deref() {
        Some(value) if !value.trim().is_empty() => Some(parse_uuid(value, "item_id")?),
        _ => None,
    };
    let mut fields = request.fields;
    let title = sanitize_title(&request.title, &request.service_name);

    let result = save_passwords_api_credential_inner(&app, vault_id, item_id, &title, &mut fields)
        .await
        .map_err(|err| err.to_string());

    for field in &mut fields {
        field.value.zeroize();
    }

    result
}

async fn create_passwords_api_credential_inner(
    app: &AppHandle,
    master_password: &[u8],
    title: &str,
    fields: &[PasswordsSecretFieldInput],
) -> anyhow::Result<CreatePasswordsApiCredentialResponse> {
    let client = reqwest::Client::new();
    let account_record = get_account_secrets(app, &client).await?;
    let identity: IdentityRecord = get_data(app, &client, "/identities/me").await?;
    let identity_id = identity.identity_id;
    let account_secrets = build_account_secrets(account_record, identity)?;
    let unlocked = unlock_account_for_passwords(master_password, &account_secrets)?;
    let sync: SyncResponse = get_data(app, &client, "/sync").await?;
    let vault = select_writable_vault(sync, identity_id)?;
    let wrapped_vault_key = vault
        .wrapped_vault_key
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Selected vault is missing its wrapped key"))?;
    let wrapped_vault_key = decode_b64(wrapped_vault_key, "wrapped_vault_key")?;
    let vault_key = unwrap_vault_key(&unlocked.kem_private, &wrapped_vault_key)?;

    let item_id = Uuid::new_v4();
    let mut content = build_secret_reference_content(fields);
    let create_body = build_create_item_request(
        &vault_key,
        item_id,
        &content,
        title,
        &[],
        &default_api_credential_metadata(),
        vault.vault_key_version,
    );
    zeroize_item_content(&mut content);
    drop(content);
    drop(vault_key);
    drop(unlocked);
    let create_body = create_body?;

    post_item(app, &client, vault.vault_id, &create_body).await?;

    let references = fields
        .iter()
        .map(|field| {
            (
                field.name.clone(),
                format!(
                    "seren-secrets://{}/{}/{}",
                    vault.vault_id, item_id, field.name
                ),
            )
        })
        .collect();

    Ok(CreatePasswordsApiCredentialResponse {
        vault_id: vault.vault_id.to_string(),
        item_id: item_id.to_string(),
        references,
    })
}

async fn unlock_passwords_vault_inner(
    app: &AppHandle,
    master_password: &[u8],
) -> anyhow::Result<UnlockPasswordsVaultResponse> {
    let client = reqwest::Client::new();
    let account_record = get_account_secrets(app, &client).await?;
    let identity: IdentityRecord = get_data(app, &client, "/identities/me").await?;
    let identity_id = identity.identity_id;
    let account_secrets = build_account_secrets(account_record, identity)?;
    let unlocked = unlock_account_for_passwords(master_password, &account_secrets)?;
    let sync: SyncResponse = get_data(app, &client, "/sync").await?;
    let writable_vault_ids = writable_vault_ids(sync.memberships.as_deref(), identity_id);

    let (unlocked_vaults, failed_vaults) = unlock_vaults(
        sync.vaults,
        &unlocked.kem_private,
        writable_vault_ids.as_ref(),
    );
    drop(unlocked);
    if unlocked_vaults.is_empty() && failed_vaults > 0 {
        return Err(anyhow::anyhow!(
            "No Seren Passwords vault could be unlocked; {failed_vaults} vault key(s) failed to decrypt"
        ));
    }

    let mut session = PasswordsSession {
        kem_public: account_secrets.kem_public_key,
        vaults: unlocked_vaults,
    };
    let vault_ids: Vec<Uuid> = session.vaults.keys().copied().collect();
    for vault_id in vault_ids {
        if let Ok(items) = list_item_summaries(app, &client, vault_id).await
            && let Some(vault) = session.vaults.get_mut(&vault_id)
        {
            vault.item_count = items.len();
        }
    }

    let response = UnlockPasswordsVaultResponse {
        vaults: session_vault_summaries(&session),
    };
    let mut stored = passwords_session().lock().await;
    *stored = Some(session);
    Ok(response)
}

async fn setup_passwords_vault_inner(
    app: &AppHandle,
    master_password: &[u8],
    display_name: &str,
    vault_name: &str,
) -> anyhow::Result<SetupPasswordsVaultResponse> {
    validate_master_password(master_password)?;
    let client = reqwest::Client::new();
    let bundle = account_setup(master_password)?;
    let recovery_key_display = bundle.recovery_key.to_display_string();
    let vault_key = generate_vault_key();
    let personal_vault_id = Uuid::new_v4();
    let mut wrapped_vault_key = wrap_vault_key_for_identity(&vault_key, &bundle.kem_keypair.public);
    let mut vault_name_ciphertext =
        encrypt_vault_name(&vault_key, personal_vault_id.as_bytes(), vault_name);

    let body = AccountSetupRequest {
        kdf_params: serde_json::to_value(&bundle.secrets.kdf_params)?,
        recovery_kdf_params: serde_json::to_value(&bundle.secrets.recovery_kdf_params)?,
        account_key_wrap: B64.encode(&bundle.secrets.account_key_wrap),
        account_kem_private_wrap: B64.encode(&bundle.secrets.account_kem_private_wrap),
        account_signing_private_wrap: B64.encode(&bundle.secrets.account_signing_private_wrap),
        recovery_key_wrap: B64.encode(&bundle.secrets.recovery_key_wrap),
        display_name: display_name.to_string(),
        kem_public_key: B64.encode(bundle.kem_keypair.public.as_bytes()),
        signing_public_key: B64.encode(bundle.signing_keypair.public.as_bytes()),
        personal_vault_wrapped_key: B64.encode(&wrapped_vault_key),
        personal_vault_id,
        personal_vault_name_ciphertext: B64.encode(&vault_name_ciphertext),
        personal_vault_description_ciphertext: None,
        personal_vault_granted_signature: String::new(),
    };

    let setup_response = put_account_setup(app, &client, &body).await?;
    wrapped_vault_key.zeroize();
    vault_name_ciphertext.zeroize();
    drop(vault_key);
    drop(bundle);

    let unlocked = unlock_passwords_vault_inner(app, master_password).await?;
    Ok(SetupPasswordsVaultResponse {
        recovery_key_display,
        personal_vault_id: setup_response.personal_vault_id.to_string(),
        vaults: unlocked.vaults,
    })
}

async fn create_passwords_vault_inner(
    app: &AppHandle,
    name: &str,
    description: Option<&str>,
) -> anyhow::Result<UnlockPasswordsVaultResponse> {
    // Creating a vault is a post-unlock action: refuse unless a session is
    // live so the new vault key can be cached alongside the others. The new
    // vault key is sealed to the session's KEM public key, which unlock
    // verified against the unwrapped private key; a freshly fetched,
    // server-supplied public key would be unauthenticated here.
    let kem_public = {
        let session = passwords_session().lock().await;
        session
            .as_ref()
            .map(|session| session.kem_public)
            .ok_or_else(|| anyhow::anyhow!("Unlock Seren Passwords first"))?
    };

    let client = reqwest::Client::new();

    let vault_id = Uuid::new_v4();
    let vault_key = generate_vault_key();
    let mut wrapped_vault_key = wrap_vault_key_for_identity(&vault_key, &kem_public);
    let mut name_ciphertext = encrypt_vault_name(&vault_key, vault_id.as_bytes(), name);
    let mut description_ciphertext =
        description.map(|value| encrypt_vault_description(&vault_key, vault_id.as_bytes(), value));

    let body = CreateVaultRequest {
        vault_id,
        name_ciphertext: B64.encode(&name_ciphertext),
        description_ciphertext: description_ciphertext
            .as_ref()
            .map(|ciphertext| B64.encode(ciphertext)),
        owner_kind: "user",
        access_level: "admin",
        initial_wrapped_vault_key: B64.encode(&wrapped_vault_key),
        granted_signature: String::new(),
    };

    let result = post_vault(app, &client, &body).await;
    wrapped_vault_key.zeroize();
    name_ciphertext.zeroize();
    if let Some(ciphertext) = description_ciphertext.as_mut() {
        ciphertext.zeroize();
    }
    let created_version = result?.vault_key_version;

    let mut stored = passwords_session().lock().await;
    let Some(session) = stored.as_mut() else {
        return Err(anyhow::anyhow!("Unlock Seren Passwords first"));
    };
    session.vaults.insert(
        vault_id,
        UnlockedVault {
            vault_id,
            name: name.to_string(),
            vault_key,
            vault_key_version: created_version,
            writable: true,
            item_count: 0,
        },
    );
    Ok(UnlockPasswordsVaultResponse {
        vaults: session_vault_summaries(session),
    })
}

async fn list_passwords_items_inner(
    app: &AppHandle,
    vault_id: Uuid,
) -> anyhow::Result<Vec<PasswordsItemSummary>> {
    let vault = unlocked_vault(vault_id).await?;
    let client = reqwest::Client::new();
    let items = list_item_summaries(app, &client, vault_id).await?;
    Ok(items
        .into_iter()
        .map(|item| decrypt_item_summary(&vault, item))
        .collect())
}

async fn get_passwords_item_inner(
    app: &AppHandle,
    vault_id: Uuid,
    item_id: Uuid,
) -> anyhow::Result<PasswordsItemDetail> {
    let vault = unlocked_vault(vault_id).await?;
    let client = reqwest::Client::new();
    let item = get_item_record(app, &client, vault_id, item_id).await?;
    decrypt_item_detail(&vault, item)
}

async fn save_passwords_api_credential_inner(
    app: &AppHandle,
    vault_id: Uuid,
    item_id: Option<Uuid>,
    title: &str,
    fields: &mut [PasswordsSecretFieldInput],
) -> anyhow::Result<CreatePasswordsApiCredentialResponse> {
    let vault = unlocked_vault(vault_id).await?;
    if !vault.writable {
        return Err(anyhow::anyhow!("Selected vault is read-only"));
    }

    let update_existing = item_id.is_some();
    let item_id = item_id.unwrap_or_else(Uuid::new_v4);
    let client = reqwest::Client::new();
    let existing_state = if update_existing {
        Some(load_existing_item_state(app, &client, &vault, item_id).await?)
    } else {
        None
    };
    let mut existing_state = existing_state;
    let mut content = match existing_state.as_mut() {
        Some(state) => match state.metadata.item_kind.as_str() {
            "api_credential" => {
                sanitize_fields_in_place(fields).map_err(anyhow::Error::msg)?;
                let mut content = build_secret_reference_content(fields);
                merge_api_credential_content(&mut content, state.content.as_mut());
                content
            }
            "login" => {
                sanitize_password_item_fields_in_place(fields).map_err(anyhow::Error::msg)?;
                merge_login_content_fields(state.content.as_mut(), fields)?;
                state.content.as_ref().clone()
            }
            item_kind => {
                return Err(anyhow::anyhow!(
                    "Existing entry is a {item_kind} item; only login and API credential entries can be edited here"
                ));
            }
        },
        None => {
            sanitize_fields_in_place(fields).map_err(anyhow::Error::msg)?;
            build_secret_reference_content(fields)
        }
    };
    let body = match existing_state.as_ref() {
        Some(state) => {
            let mut body = build_item_request_with_content_key(
                &vault.vault_key,
                item_id,
                &state.content_key,
                state.content_key_wrap.clone(),
                &content,
                title,
                &[],
                &state.metadata,
                vault.vault_key_version,
            )?;
            body.tags_ciphertext = state.tags_ciphertext.clone();
            Ok(body)
        }
        None => build_create_item_request(
            &vault.vault_key,
            item_id,
            &content,
            title,
            &[],
            &default_api_credential_metadata(),
            vault.vault_key_version,
        ),
    };
    zeroize_item_content(&mut content);
    drop(content);
    let body = body?;

    if update_existing {
        patch_item(
            app,
            &client,
            vault_id,
            item_id,
            &UpdateItemRequest::from(&body),
        )
        .await?;
    } else {
        post_item(app, &client, vault_id, &body).await?;
    }

    let references = fields
        .iter()
        .map(|field| {
            (
                field.name.clone(),
                format!("seren-secrets://{vault_id}/{item_id}/{}", field.name),
            )
        })
        .collect();

    Ok(CreatePasswordsApiCredentialResponse {
        vault_id: vault_id.to_string(),
        item_id: item_id.to_string(),
        references,
    })
}

/// Fetches and decrypts the item being updated so the new request preserves
/// what the editor does not model: the stored metadata (item kind, favorite,
/// sensitive, reprompt), the item content key, tags, and hidden content fields.
async fn load_existing_item_state(
    app: &AppHandle,
    client: &reqwest::Client,
    vault: &UnlockedVault,
    item_id: Uuid,
) -> anyhow::Result<ExistingItemState> {
    let record = get_item_record(app, client, vault.vault_id, item_id).await?;
    let metadata_json = decrypt_metadata_json(
        &vault.vault_key,
        item_id.as_bytes(),
        &decode_b64(&record.metadata_ciphertext, "metadata_ciphertext")?,
    )?;
    let metadata: ItemListMetadata = serde_json::from_str(&metadata_json)
        .map_err(|err| anyhow::anyhow!("Existing item metadata is malformed: {err}"))?;
    let (content_key, content) = decrypt_item_content(&vault.vault_key, &record)?;
    Ok(ExistingItemState {
        metadata,
        content_key,
        content_key_wrap: record.content_key_wrap,
        tags_ciphertext: record.tags_ciphertext,
        content,
    })
}

/// The editor round-trips only the fields `api_credential_fields` surfaces:
/// the custom fields, or the primary/secondary/notes alias values when no
/// custom fields exist. Those are fully replaced by the submitted fields,
/// including deliberate removals. Everything else (credential kind, headers,
/// rotation, sections, raw import) plus alias slots the editor never showed
/// is carried forward so an update cannot silently destroy data written by
/// other clients. Preserved values are moved out of `existing`; the caller
/// scrubs whatever remains.
fn merge_api_credential_content(content: &mut ItemContent, existing: &mut ItemContent) {
    let (ItemContent::ApiCredential(new), ItemContent::ApiCredential(old)) =
        (&mut *content, &mut *existing)
    else {
        return;
    };
    new.kind = old.kind.clone();
    new.headers = std::mem::take(&mut old.headers);
    new.rotation = old.rotation.take();
    new.sections = std::mem::take(&mut old.sections);
    new.raw_import = std::mem::take(&mut old.raw_import);
    if !editor_surfaced_alias(old, ApiCredentialAlias::Primary) {
        new.primary_value = std::mem::take(&mut old.primary_value);
    }
    if !editor_surfaced_alias(old, ApiCredentialAlias::Secondary) {
        new.secondary_value = std::mem::take(&mut old.secondary_value);
    }
    if !editor_surfaced_alias(old, ApiCredentialAlias::Notes) {
        new.notes = std::mem::take(&mut old.notes);
        new.notes_text = std::mem::take(&mut old.notes_text);
    }
}

/// Mirrors the visibility rule in `api_credential_fields`: with no custom
/// fields the editor shows the alias slots directly; otherwise an alias was
/// visible only if a custom field carries an aliased name. A slot the editor
/// never showed cannot have been deliberately cleared by the submitted
/// fields.
fn editor_surfaced_alias(existing: &ApiCredentialContent, alias: ApiCredentialAlias) -> bool {
    if existing.custom_fields.is_empty() {
        return true;
    }
    existing
        .custom_fields
        .iter()
        .any(|field| api_credential_alias(&field.name) == Some(alias))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LoginFieldAlias {
    Username,
    Password,
    Url,
    Totp,
    Notes,
}

fn login_field_alias(name: &str) -> Option<LoginFieldAlias> {
    match name.trim().to_ascii_lowercase().as_str() {
        "username" | "user" | "login" => Some(LoginFieldAlias::Username),
        "password" | "pass" => Some(LoginFieldAlias::Password),
        "url" | "uri" | "website" | "site" => Some(LoginFieldAlias::Url),
        "totp" | "otp" | "one_time_password" | "one-time password" => Some(LoginFieldAlias::Totp),
        "notes" | "note" => Some(LoginFieldAlias::Notes),
        _ => None,
    }
}

fn merge_login_content_fields(
    content: &mut ItemContent,
    fields: &[PasswordsSecretFieldInput],
) -> anyhow::Result<()> {
    let ItemContent::Login(login) = content else {
        return Err(anyhow::anyhow!("Existing item content is not a login"));
    };

    let mut username: Option<String> = None;
    let mut password: Option<String> = None;
    let mut url: Option<String> = None;
    let mut totp: Option<String> = None;
    let mut notes: Option<String> = None;
    let mut custom_fields = Vec::new();
    let mut existing_custom = std::mem::take(&mut login.custom_fields)
        .into_iter()
        .map(|field| (field.name.to_ascii_lowercase(), field))
        .collect::<BTreeMap<_, _>>();

    for field in fields {
        match login_field_alias(&field.name) {
            Some(LoginFieldAlias::Username) => username = Some(field.value.clone()),
            Some(LoginFieldAlias::Password) => password = Some(field.value.clone()),
            Some(LoginFieldAlias::Url) => url = Some(field.value.clone()),
            Some(LoginFieldAlias::Totp) => totp = Some(field.value.clone()),
            Some(LoginFieldAlias::Notes) => notes = Some(field.value.clone()),
            None => {
                let key = field.name.to_ascii_lowercase();
                let mut custom = existing_custom.remove(&key).unwrap_or_else(|| CustomField {
                    name: field.name.clone(),
                    kind: CustomFieldKind::Concealed,
                    value: String::new(),
                    purpose: field_purpose_for_name(&field.name),
                    section_id: None,
                });
                custom.name = field.name.clone();
                custom.value = field.value.clone();
                if custom.purpose.is_none() {
                    custom.purpose = field_purpose_for_name(&field.name);
                }
                custom_fields.push(custom);
            }
        }
    }

    login.username = username.unwrap_or_default();
    login.password = password.unwrap_or_default();
    match url {
        Some(value) => {
            if let Some(first) = login.urls.first_mut() {
                first.url = value;
            } else {
                login.urls.push(LoginUrl::plain(value));
            }
        }
        None => {
            if !login.urls.is_empty() {
                login.urls.remove(0);
            }
        }
    }
    if let Some(secret_base32) = totp {
        let mut existing = login.totp.take().unwrap_or(TotpConfig {
            secret_base32: String::new(),
            algorithm: TotpAlgorithm::Sha1,
            digits: 6,
            period_seconds: 30,
        });
        existing.secret_base32 = secret_base32;
        login.totp = Some(existing);
    } else {
        login.totp = None;
    }
    let notes = notes.unwrap_or_default();
    let (notes_doc, notes_text) = seren_secrets_crypto::prose::from_plaintext(&notes);
    login.notes = notes_doc;
    login.notes_text = notes_text;
    login.custom_fields = custom_fields;
    Ok(())
}

fn passwords_url(path: &str) -> String {
    format!("{PASSWORDS_BASE_URL}{path}")
}

fn list_items_path(vault_id: Uuid) -> String {
    format!("/vaults/{vault_id}/items?state=active")
}

fn item_path(vault_id: Uuid, item_id: Uuid) -> String {
    format!("/vaults/{vault_id}/items/{item_id}")
}

async fn get_data<T: for<'de> Deserialize<'de>>(
    app: &AppHandle,
    client: &reqwest::Client,
    path: &str,
) -> anyhow::Result<T> {
    let url = passwords_url(path);
    let response = crate::auth::authenticated_request(app, client, |client, token| {
        client.get(&url).bearer_auth(token)
    })
    .await
    .map_err(anyhow::Error::msg)?;
    parse_data_response(response).await
}

async fn get_account_secrets(
    app: &AppHandle,
    client: &reqwest::Client,
) -> anyhow::Result<AccountSecretsRecord> {
    let data: serde_json::Value = get_data(app, client, "/account/secrets").await?;
    parse_account_secrets_data(data)
}

async fn list_item_summaries(
    app: &AppHandle,
    client: &reqwest::Client,
    vault_id: Uuid,
) -> anyhow::Result<Vec<ItemSummaryRecord>> {
    get_data(app, client, &list_items_path(vault_id)).await
}

async fn get_item_record(
    app: &AppHandle,
    client: &reqwest::Client,
    vault_id: Uuid,
    item_id: Uuid,
) -> anyhow::Result<ItemRecord> {
    get_data(app, client, &item_path(vault_id, item_id)).await
}

async fn put_account_setup(
    app: &AppHandle,
    client: &reqwest::Client,
    body: &AccountSetupRequest,
) -> anyhow::Result<AccountSetupResponse> {
    let url = format!("{PASSWORDS_BASE_URL}/account");
    let payload = serde_json::to_value(body)?;
    let response = crate::auth::authenticated_request(app, client, |client, token| {
        client.put(&url).bearer_auth(token).json(&payload)
    })
    .await
    .map_err(anyhow::Error::msg)?;
    parse_data_response(response).await
}

async fn post_vault(
    app: &AppHandle,
    client: &reqwest::Client,
    body: &CreateVaultRequest,
) -> anyhow::Result<VaultRecord> {
    let url = format!("{PASSWORDS_BASE_URL}/vaults");
    let payload = serde_json::to_value(body)?;
    let response = crate::auth::authenticated_request(app, client, |client, token| {
        client.post(&url).bearer_auth(token).json(&payload)
    })
    .await
    .map_err(anyhow::Error::msg)?;
    parse_data_response(response).await
}

async fn post_item(
    app: &AppHandle,
    client: &reqwest::Client,
    vault_id: Uuid,
    body: &CreateItemRequest,
) -> anyhow::Result<ItemRecord> {
    let url = format!("{PASSWORDS_BASE_URL}/vaults/{vault_id}/items");
    let payload = serde_json::to_value(body)?;
    let response = crate::auth::authenticated_request(app, client, |client, token| {
        client.post(&url).bearer_auth(token).json(&payload)
    })
    .await
    .map_err(anyhow::Error::msg)?;
    parse_data_response(response).await
}

async fn patch_item(
    app: &AppHandle,
    client: &reqwest::Client,
    vault_id: Uuid,
    item_id: Uuid,
    body: &UpdateItemRequest,
) -> anyhow::Result<ItemRecord> {
    let url = format!("{PASSWORDS_BASE_URL}/vaults/{vault_id}/items/{item_id}");
    let payload = serde_json::to_value(body)?;
    let response = crate::auth::authenticated_request(app, client, |client, token| {
        client.patch(&url).bearer_auth(token).json(&payload)
    })
    .await
    .map_err(anyhow::Error::msg)?;
    parse_data_response(response).await
}

async fn parse_data_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> anyhow::Result<T> {
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(anyhow::anyhow!(
            "Seren Passwords request failed with HTTP {}: {}",
            status,
            truncate_error_body(&body)
        ));
    }
    parse_data_body(&body)
}

fn parse_data_body<T: for<'de> Deserialize<'de>>(body: &str) -> anyhow::Result<T> {
    let value: serde_json::Value = serde_json::from_str(body)?;
    if let Some(status) = publisher_status(&value).filter(|status| *status >= 400) {
        let payload = unwrap_publisher_body(&value);
        return Err(anyhow::anyhow!(
            "Seren Passwords request failed with upstream HTTP {}: {}",
            status,
            truncate_error_body(&payload.to_string())
        ));
    }
    let payload = parse_publisher_payload(unwrap_publisher_body(&value))?;
    let wrapped: DataResponse<T> = serde_json::from_value(payload)?;
    Ok(wrapped.data)
}

fn parse_publisher_payload(payload: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
    match payload.as_str() {
        Some(text) => serde_json::from_str(text).map_err(anyhow::Error::new),
        None => Ok(payload.clone()),
    }
}

fn parse_account_secrets_data(data: serde_json::Value) -> anyhow::Result<AccountSecretsRecord> {
    let candidate = data
        .get("secrets")
        .or_else(|| data.get("account_secrets"))
        .or_else(|| data.get("accountSecrets"))
        .unwrap_or(&data);
    serde_json::from_value(candidate.clone()).map_err(|err| {
        let keys = data
            .as_object()
            .map(|object| object.keys().cloned().collect::<Vec<_>>().join(", "))
            .unwrap_or_else(|| data_type_name(&data).to_string());
        anyhow::anyhow!("could not read account secrets from response ({keys}): {err}")
    })
}

fn data_type_name(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

fn unlock_account_for_passwords(
    master_password: &[u8],
    account_secrets: &AccountSecrets,
) -> anyhow::Result<seren_secrets_crypto::protocol::account::UnlockedAccount> {
    unlock_account(master_password, account_secrets).map_err(|err| match err {
        CryptoError::AuthFailure => anyhow::anyhow!("Incorrect vault password."),
        other => anyhow::Error::new(other),
    })
}

fn truncate_error_body(body: &str) -> String {
    const LIMIT: usize = 240;
    if body.chars().count() <= LIMIT {
        return body.to_string();
    }
    format!(
        "{}...[truncated]",
        body.chars().take(LIMIT).collect::<String>()
    )
}

fn build_account_secrets(
    record: AccountSecretsRecord,
    identity: IdentityRecord,
) -> anyhow::Result<AccountSecrets> {
    let kem_public_key =
        IdentityKemPublicKey::from_slice(&decode_b64(&identity.kem_public_key, "kem_public_key")?)?;
    let signing_public_key = IdentitySigningPublicKey::from_slice(&decode_b64(
        &identity.signing_public_key,
        "signing_public_key",
    )?)?;

    Ok(AccountSecrets {
        kdf_params: record.kdf_params,
        recovery_kdf_params: record.recovery_kdf_params,
        account_key_wrap: decode_b64(&record.account_key_wrap, "account_key_wrap")?,
        account_kem_private_wrap: decode_b64(
            &record.account_kem_private_wrap,
            "account_kem_private_wrap",
        )?,
        account_signing_private_wrap: decode_b64(
            &record.account_signing_private_wrap,
            "account_signing_private_wrap",
        )?,
        recovery_key_wrap: decode_b64(&record.recovery_key_wrap, "recovery_key_wrap")?,
        kem_public_key,
        signing_public_key,
    })
}

async fn unlocked_vault(vault_id: Uuid) -> anyhow::Result<UnlockedVault> {
    let session = passwords_session().lock().await;
    session
        .as_ref()
        .and_then(|session| session.vaults.get(&vault_id).cloned())
        .ok_or_else(|| anyhow::anyhow!("Unlock Seren Passwords first"))
}

fn session_vault_summaries(session: &PasswordsSession) -> Vec<PasswordsVaultSummary> {
    session
        .vaults
        .values()
        .map(|vault| PasswordsVaultSummary {
            vault_id: vault.vault_id.to_string(),
            name: vault.name.clone(),
            writable: vault.writable,
            item_count: vault.item_count,
        })
        .collect()
}

fn writable_vault_ids(
    memberships: Option<&[MembershipRecord]>,
    identity_id: Uuid,
) -> Option<BTreeSet<Uuid>> {
    memberships.map(|memberships| {
        memberships
            .iter()
            .filter(|membership| membership.identity_id == identity_id)
            .filter(|membership| {
                membership.access_level.eq_ignore_ascii_case("write")
                    || membership.access_level.eq_ignore_ascii_case("admin")
            })
            .map(|membership| membership.vault_id)
            .collect::<BTreeSet<_>>()
    })
}

/// Unwraps each vault key, skipping records that fail to decode or decrypt
/// so one corrupt server-supplied vault record cannot block access to the
/// remaining vaults. Returns the unlocked vaults and the skipped count.
fn unlock_vaults(
    vaults: Vec<VaultRecord>,
    kem_private: &seren_secrets_crypto::keys::IdentityKemPrivateKey,
    writable_vault_ids: Option<&BTreeSet<Uuid>>,
) -> (BTreeMap<Uuid, UnlockedVault>, usize) {
    let mut unlocked_vaults = BTreeMap::new();
    let mut failed_vaults = 0usize;
    for vault in vaults {
        let Some(wrapped_vault_key) = vault.wrapped_vault_key.as_deref() else {
            continue;
        };
        let vault_key = decode_b64(wrapped_vault_key, "wrapped_vault_key")
            .and_then(|wrap| unwrap_vault_key(kem_private, &wrap).map_err(anyhow::Error::new));
        let vault_key = match vault_key {
            Ok(vault_key) => vault_key,
            Err(_) => {
                log::warn!(
                    "Skipping Seren Passwords vault {}: vault key failed to decrypt",
                    vault.vault_id
                );
                failed_vaults += 1;
                continue;
            }
        };
        let name = vault
            .name_ciphertext
            .as_deref()
            .and_then(|ciphertext| decode_b64(ciphertext, "name_ciphertext").ok())
            .and_then(|blob| decrypt_vault_name(&vault_key, vault.vault_id.as_bytes(), &blob).ok())
            .unwrap_or_else(|| fallback_vault_name(vault.vault_id));
        let writable = writable_vault_ids.is_none_or(|ids| ids.contains(&vault.vault_id));
        unlocked_vaults.insert(
            vault.vault_id,
            UnlockedVault {
                vault_id: vault.vault_id,
                name,
                vault_key,
                vault_key_version: vault.vault_key_version,
                writable,
                item_count: 0,
            },
        );
    }
    (unlocked_vaults, failed_vaults)
}

fn fallback_vault_name(vault_id: Uuid) -> String {
    format!("Vault {}", &vault_id.to_string()[..8])
}

fn parse_uuid(value: &str, label: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value.trim()).map_err(|err| format!("Invalid {label}: {err}"))
}

fn select_writable_vault(sync: SyncResponse, identity_id: Uuid) -> anyhow::Result<VaultRecord> {
    let writable_vault_ids = writable_vault_ids(sync.memberships.as_deref(), identity_id);

    sync.vaults
        .into_iter()
        .find(|vault| {
            vault.wrapped_vault_key.is_some()
                && writable_vault_ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&vault.vault_id))
        })
        .ok_or_else(|| anyhow::anyhow!("No writable Seren Passwords vault is available"))
}

fn decrypt_item_summary(vault: &UnlockedVault, item: ItemSummaryRecord) -> PasswordsItemSummary {
    let tags = item
        .tags_ciphertext
        .as_deref()
        .and_then(|ciphertext| {
            decode_b64(ciphertext, "tags_ciphertext")
                .ok()
                .and_then(|blob| {
                    decrypt_tags(&vault.vault_key, item.item_id.as_bytes(), &blob).ok()
                })
        })
        .unwrap_or_default();

    let title = decode_b64(&item.title_ciphertext, "title_ciphertext")
        .ok()
        .and_then(|blob| decrypt_title(&vault.vault_key, item.item_id.as_bytes(), &blob).ok());
    let metadata = decode_b64(&item.metadata_ciphertext, "metadata_ciphertext")
        .ok()
        .and_then(|blob| {
            decrypt_metadata_json(&vault.vault_key, item.item_id.as_bytes(), &blob).ok()
        })
        .and_then(|json| serde_json::from_str::<ItemListMetadata>(&json).ok());

    match (title, metadata) {
        (Some(title), Some(metadata)) => PasswordsItemSummary {
            vault_id: item.vault_id.to_string(),
            item_id: item.item_id.to_string(),
            title,
            item_kind: metadata.item_kind,
            favorite: metadata.favorite,
            sensitive: metadata.sensitive,
            reprompt: metadata.reprompt,
            tags,
            updated_at: item.updated_at,
            decrypt_error: false,
        },
        _ => PasswordsItemSummary {
            vault_id: item.vault_id.to_string(),
            item_id: item.item_id.to_string(),
            title: "(decrypt failed)".to_string(),
            item_kind: default_item_kind(),
            favorite: false,
            sensitive: false,
            reprompt: false,
            tags,
            updated_at: item.updated_at,
            decrypt_error: true,
        },
    }
}

fn decrypt_item_detail(
    vault: &UnlockedVault,
    item: ItemRecord,
) -> anyhow::Result<PasswordsItemDetail> {
    let title = decrypt_title(
        &vault.vault_key,
        item.item_id.as_bytes(),
        &decode_b64(&item.title_ciphertext, "title_ciphertext")?,
    )?;
    let metadata_json = decrypt_metadata_json(
        &vault.vault_key,
        item.item_id.as_bytes(),
        &decode_b64(&item.metadata_ciphertext, "metadata_ciphertext")?,
    )?;
    let metadata: ItemListMetadata =
        serde_json::from_str(&metadata_json).unwrap_or(ItemListMetadata {
            item_kind: default_item_kind(),
            favorite: false,
            sensitive: false,
            reprompt: false,
        });
    if metadata.reprompt {
        return Err(anyhow::anyhow!(
            "This entry requires a master password reprompt in Seren Passwords"
        ));
    }
    // Only credential-like content is surfaced in the key/value editor. Other
    // kinds stay encrypted so their plaintext is not materialized in a form
    // this module cannot present or zeroize correctly.
    let fields = if matches!(metadata.item_kind.as_str(), "api_credential" | "login") {
        let (_content_key, content) = decrypt_item_content(&vault.vault_key, &item)?;
        item_content_fields(&content)
    } else {
        Vec::new()
    };

    Ok(PasswordsItemDetail {
        vault_id: item.vault_id.to_string(),
        item_id: item.item_id.to_string(),
        title,
        item_kind: metadata.item_kind,
        fields,
        updated_at: item.updated_at,
    })
}

fn decrypt_item_content(
    vault_key: &seren_secrets_crypto::keys::VaultKey,
    item: &ItemRecord,
) -> anyhow::Result<(ItemContentKey, DecryptedItemContent)> {
    let content_key = unwrap_item_content_key(
        vault_key,
        item.item_id.as_bytes(),
        &decode_b64(&item.content_key_wrap, "content_key_wrap")?,
    )?;
    let content = decrypt_item_with_content_key(
        &content_key,
        item.item_id.as_bytes(),
        &decode_b64(&item.content_ciphertext, "content_ciphertext")?,
    )?;
    Ok((content_key, content))
}

fn item_content_fields(content: &ItemContent) -> Vec<PasswordsItemField> {
    match content {
        ItemContent::ApiCredential(content) => api_credential_fields(content),
        ItemContent::Login(content) => login_fields(content),
        _ => Vec::new(),
    }
}

fn api_credential_fields(content: &ApiCredentialContent) -> Vec<PasswordsItemField> {
    let mut fields = Vec::new();
    if content.custom_fields.is_empty() {
        push_field(&mut fields, "PRIMARY", &content.primary_value);
        push_field(&mut fields, "SECONDARY", &content.secondary_value);
        push_field(
            &mut fields,
            "NOTES",
            &projected_prose_text(&content.notes_text, &content.notes),
        );
        return fields;
    }

    content
        .custom_fields
        .iter()
        .map(|field| PasswordsItemField {
            name: field.name.clone(),
            value: field.value.clone(),
        })
        .collect()
}

fn login_fields(content: &LoginContent) -> Vec<PasswordsItemField> {
    let mut fields = Vec::new();
    push_field(&mut fields, "username", &content.username);
    push_field(&mut fields, "password", &content.password);
    if let Some(url) = content.urls.first() {
        push_field(&mut fields, "url", &url.url);
    }
    if let Some(totp) = content.totp.as_ref() {
        push_field(&mut fields, "totp", &totp.secret_base32);
    }
    push_field(
        &mut fields,
        "notes",
        &projected_prose_text(&content.notes_text, &content.notes),
    );
    fields.extend(
        content
            .custom_fields
            .iter()
            .map(|field| PasswordsItemField {
                name: field.name.clone(),
                value: field.value.clone(),
            }),
    );
    fields
}

fn push_field(fields: &mut Vec<PasswordsItemField>, name: &str, value: &str) {
    if value.is_empty() {
        return;
    }
    fields.push(PasswordsItemField {
        name: name.to_string(),
        value: value.to_string(),
    });
}

fn projected_prose_text(text: &str, doc: &seren_secrets_crypto::prose::ProseDoc) -> String {
    if !text.is_empty() {
        return text.to_string();
    }
    doc.plain_text()
}

fn build_create_item_request(
    vault_key: &seren_secrets_crypto::keys::VaultKey,
    item_id: Uuid,
    content: &ItemContent,
    title: &str,
    tags: &[String],
    metadata: &ItemListMetadata,
    vault_key_version: i32,
) -> anyhow::Result<CreateItemRequest> {
    let content_key = generate_item_content_key();
    let content_key_wrap = wrap_item_content_key(vault_key, item_id.as_bytes(), &content_key);
    build_item_request_with_content_key(
        vault_key,
        item_id,
        &content_key,
        B64.encode(content_key_wrap),
        content,
        title,
        tags,
        metadata,
        vault_key_version,
    )
}

fn build_item_request_with_content_key(
    vault_key: &seren_secrets_crypto::keys::VaultKey,
    item_id: Uuid,
    content_key: &ItemContentKey,
    content_key_wrap: String,
    content: &ItemContent,
    title: &str,
    tags: &[String],
    metadata: &ItemListMetadata,
    vault_key_version: i32,
) -> anyhow::Result<CreateItemRequest> {
    let item_id_bytes = item_id.as_bytes();
    let title_ct = encrypt_title(vault_key, item_id_bytes, title);
    let tags_ct = if tags.is_empty() {
        None
    } else {
        Some(encrypt_tags(vault_key, item_id_bytes, tags)?)
    };
    let body_ct = encrypt_item_with_content_key(&content_key, item_id_bytes, content)?;
    let metadata_json = serde_json::to_string(metadata)?;
    let metadata_ct = encrypt_metadata_json(vault_key, item_id_bytes, &metadata_json);

    Ok(CreateItemRequest {
        item_id,
        title_ciphertext: B64.encode(title_ct),
        content_ciphertext: B64.encode(body_ct),
        tags_ciphertext: tags_ct.map(|tags| B64.encode(tags)),
        title_blind_index: String::new(),
        content_key_wrap,
        metadata_ciphertext: B64.encode(metadata_ct),
        sensitive: metadata.sensitive,
        wrapping_key_version: Some(vault_key_version),
    })
}

fn decode_b64(value: &str, label: &str) -> anyhow::Result<Vec<u8>> {
    B64.decode(value.as_bytes())
        .map_err(|err| anyhow::anyhow!("Invalid {label}: {err}"))
}

fn build_secret_reference_content(fields: &[PasswordsSecretFieldInput]) -> ItemContent {
    let mut content = ApiCredentialContent {
        kind: ApiCredentialKind::ApiKey,
        ..Default::default()
    };
    for field in fields {
        match api_credential_alias(&field.name) {
            Some(ApiCredentialAlias::Primary) => content.primary_value = field.value.clone(),
            Some(ApiCredentialAlias::Secondary) => content.secondary_value = field.value.clone(),
            Some(ApiCredentialAlias::Notes) => {
                // `notes` is the canonical document; `notes_text` is its
                // projection and must be derived on every write so other
                // clients reading the document see the edited notes.
                (content.notes, content.notes_text) =
                    seren_secrets_crypto::prose::from_plaintext(&field.value);
            }
            None => {}
        }
    }
    content.custom_fields = fields
        .iter()
        .map(|field| CustomField {
            name: field.name.clone(),
            kind: CustomFieldKind::Concealed,
            value: field.value.clone(),
            purpose: field_purpose_for_name(&field.name),
            section_id: None,
        })
        .collect();
    ItemContent::ApiCredential(content)
}

fn zeroize_item_content(content: &mut ItemContent) {
    // Delegate to the crypto crate's scrub, which covers every item kind and
    // field (object keys stay, since they are names rather than values). This
    // wrapper keeps the call sites stable and the intent local.
    content.zeroize();
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ApiCredentialAlias {
    Primary,
    Secondary,
    Notes,
}

fn api_credential_alias(name: &str) -> Option<ApiCredentialAlias> {
    match name.to_ascii_lowercase().as_str() {
        "primary" | "primary_value" | "value" | "key" => Some(ApiCredentialAlias::Primary),
        "secondary" | "secondary_value" | "secret" => Some(ApiCredentialAlias::Secondary),
        "notes" | "note" => Some(ApiCredentialAlias::Notes),
        _ => None,
    }
}

fn field_purpose_for_name(name: &str) -> Option<FieldPurpose> {
    let normalized = name.to_ascii_lowercase();
    if normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("private_key")
    {
        return Some(FieldPurpose::Password);
    }
    if normalized.contains("api_key") || normalized.ends_with("_key") {
        return Some(FieldPurpose::PrivateKey);
    }
    None
}

fn sanitize_title(title: &str, service_name: &str) -> String {
    let clean = title.trim();
    if !clean.is_empty() {
        return clean.chars().take(160).collect();
    }
    let service = service_name.trim();
    if service.is_empty() {
        "Desktop API credential".to_string()
    } else {
        format!("{service} API credential")
    }
}

fn sanitize_display_name(display_name: &str) -> String {
    let clean = display_name.trim();
    if clean.is_empty() {
        "Desktop".to_string()
    } else {
        clean.chars().take(120).collect()
    }
}

fn sanitize_vault_name(vault_name: &str) -> String {
    let clean = vault_name.trim();
    if clean.is_empty() {
        "Personal".to_string()
    } else {
        clean.chars().take(120).collect()
    }
}

fn validate_master_password(master_password: &[u8]) -> anyhow::Result<()> {
    let password = std::str::from_utf8(master_password)
        .map_err(|_| anyhow::anyhow!("Master password must be valid UTF-8"))?;
    if password.chars().count() < MIN_MASTER_PASSWORD_LEN {
        return Err(anyhow::anyhow!(
            "Master password must be at least {MIN_MASTER_PASSWORD_LEN} characters"
        ));
    }
    let bits = estimate_master_password_bits(password);
    if bits < MIN_MASTER_PASSWORD_BITS {
        return Err(anyhow::anyhow!(
            "Master password is too weak; use at least {MIN_MASTER_PASSWORD_BITS} estimated bits"
        ));
    }
    Ok(())
}

fn estimate_master_password_bits(password: &str) -> u32 {
    if password.is_empty() {
        return 0;
    }
    let pool = character_pool_size(password).max(1) as f64;
    let char_count = password.chars().count() as f64;
    let mut bits = char_count * pool.log2();
    bits -= repeated_run_penalty(password) as f64;
    bits -= low_variety_penalty(password) as f64;
    bits.max(0.0).round() as u32
}

fn character_pool_size(password: &str) -> u32 {
    let mut pool = 0;
    if password.chars().any(|ch| ch.is_ascii_lowercase()) {
        pool += 26;
    }
    if password.chars().any(|ch| ch.is_ascii_uppercase()) {
        pool += 26;
    }
    if password.chars().any(|ch| ch.is_ascii_digit()) {
        pool += 10;
    }
    if password
        .chars()
        .any(|ch| !ch.is_ascii_alphanumeric() || !ch.is_ascii())
    {
        pool += 33;
    }
    pool
}

fn repeated_run_penalty(password: &str) -> u32 {
    let mut chars = password.chars();
    let Some(mut previous) = chars.next() else {
        return 0;
    };
    let mut max_run = 1u32;
    let mut run = 1u32;
    for ch in chars {
        if ch == previous {
            run += 1;
            max_run = max_run.max(run);
        } else {
            run = 1;
            previous = ch;
        }
    }
    max_run.saturating_sub(2) * 4
}

fn low_variety_penalty(password: &str) -> u32 {
    let unique = password.chars().collect::<BTreeSet<_>>().len();
    if unique <= 2 {
        32
    } else if unique <= 4 {
        16
    } else {
        0
    }
}

fn sanitize_fields(
    mut fields: Vec<PasswordsSecretFieldInput>,
) -> Result<Vec<PasswordsSecretFieldInput>, String> {
    match sanitize_fields_in_place(&mut fields) {
        Ok(()) => Ok(fields),
        Err(err) => {
            // Submitted values are secrets even when validation rejects the
            // batch; scrub them before reporting the error.
            for field in &mut fields {
                field.value.zeroize();
            }
            Err(err)
        }
    }
}

fn sanitize_fields_in_place(fields: &mut [PasswordsSecretFieldInput]) -> Result<(), String> {
    if fields.is_empty() {
        return Err("Add at least one field to store in Seren Passwords".to_string());
    }
    if fields.len() > MAX_SECRET_FIELDS {
        return Err(format!(
            "At most {MAX_SECRET_FIELDS} fields can be saved at once"
        ));
    }

    let mut names = BTreeSet::new();
    let mut primary_alias: Option<String> = None;
    let mut secondary_alias: Option<String> = None;
    let mut notes_alias: Option<String> = None;
    for field in fields.iter_mut() {
        field.name = field.name.trim().to_ascii_uppercase();
        if field.name.is_empty() || !is_valid_env_name(&field.name) {
            return Err("Each field name must be a valid environment variable".to_string());
        }
        if field.name.len() > MAX_FIELD_NAME_LEN {
            return Err("Field names are too long".to_string());
        }
        if field.value.is_empty() {
            return Err(format!("{} is empty", field.name));
        }
        if field.value.len() > MAX_FIELD_VALUE_LEN {
            return Err(format!("{} is too large", field.name));
        }
        if !names.insert(field.name.clone()) {
            return Err(format!("{} is duplicated", field.name));
        }
        match api_credential_alias(&field.name) {
            Some(ApiCredentialAlias::Primary) => {
                if let Some(existing) = &primary_alias {
                    return Err(format!(
                        "{} conflicts with {} as a generic API key reference",
                        field.name, existing
                    ));
                }
                primary_alias = Some(field.name.clone());
            }
            Some(ApiCredentialAlias::Secondary) => {
                if let Some(existing) = &secondary_alias {
                    return Err(format!(
                        "{} conflicts with {} as a generic API secret reference",
                        field.name, existing
                    ));
                }
                secondary_alias = Some(field.name.clone());
            }
            Some(ApiCredentialAlias::Notes) => {
                if let Some(existing) = &notes_alias {
                    return Err(format!(
                        "{} conflicts with {} as a generic note reference",
                        field.name, existing
                    ));
                }
                notes_alias = Some(field.name.clone());
            }
            None => {}
        }
    }
    Ok(())
}

fn sanitize_password_item_fields_in_place(
    fields: &mut [PasswordsSecretFieldInput],
) -> Result<(), String> {
    if fields.is_empty() {
        return Err("Add at least one field to store in Seren Passwords".to_string());
    }
    if fields.len() > MAX_SECRET_FIELDS {
        return Err(format!(
            "At most {MAX_SECRET_FIELDS} fields can be saved at once"
        ));
    }

    let mut names = BTreeSet::new();
    for field in fields.iter_mut() {
        field.name = field.name.trim().to_string();
        if field.name.is_empty() {
            return Err("Each field name must have a label".to_string());
        }
        if field.name.len() > MAX_FIELD_NAME_LEN {
            return Err("Field names are too long".to_string());
        }
        if field.value.is_empty() {
            return Err(format!("{} is empty", field.name));
        }
        if field.value.len() > MAX_FIELD_VALUE_LEN {
            return Err(format!("{} is too large", field.name));
        }
        let normalized = field.name.to_ascii_lowercase();
        if !names.insert(normalized) {
            return Err(format!("{} is duplicated", field.name));
        }
    }
    Ok(())
}

fn is_valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z'))
        && chars.all(|ch| matches!(ch, '_' | 'A'..='Z' | '0'..='9'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account_secrets_record_json() -> &'static str {
        r#"{
            "user_id": "11111111-1111-4111-8111-111111111111",
            "kdf_params": {
                "version": 1,
                "algorithm": "argon2id",
                "memory_kib": 65536,
                "time_cost": 2,
                "parallelism": 1,
                "output_len": 32,
                "salt": "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            "recovery_kdf_params": {
                "version": 1,
                "algorithm": "argon2id",
                "memory_kib": 65536,
                "time_cost": 2,
                "parallelism": 1,
                "output_len": 32,
                "salt": "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            "account_key_wrap": "AA==",
            "account_kem_private_wrap": "AA==",
            "account_signing_private_wrap": "AA==",
            "recovery_key_wrap": "AA=="
        }"#
    }

    #[test]
    fn parses_account_secrets_from_setup_envelope() {
        let data = serde_json::json!({
            "identity": {
                "identity_id": "22222222-2222-4222-8222-222222222222",
                "kem_public_key": "AA==",
                "signing_public_key": "AA=="
            },
            "secrets": serde_json::from_str::<serde_json::Value>(account_secrets_record_json()).unwrap(),
            "personal_vault_id": "33333333-3333-4333-8333-333333333333"
        });

        let record = parse_account_secrets_data(data).unwrap();

        assert_eq!(record.kdf_params.version, 1);
        assert_eq!(record.account_key_wrap, "AA==");
    }

    #[test]
    fn parses_account_secrets_from_account_secrets_envelope() {
        let data = serde_json::json!({
            "account_secrets": serde_json::from_str::<serde_json::Value>(account_secrets_record_json()).unwrap()
        });

        let record = parse_account_secrets_data(data).unwrap();

        assert_eq!(record.kdf_params.version, 1);
        assert_eq!(record.account_key_wrap, "AA==");
    }

    #[test]
    fn parses_account_secrets_from_publisher_proxy_envelope() {
        let body = serde_json::json!({
            "data": {
                "asset_symbol": "SEREN",
                "body": {
                    "data": serde_json::from_str::<serde_json::Value>(account_secrets_record_json()).unwrap()
                },
                "cost": "0",
                "execution_time_ms": 10,
                "payment_source": "account",
                "response_bytes": 1024,
                "status": 200
            }
        });

        let data = parse_data_body::<serde_json::Value>(&body.to_string()).unwrap();
        let record = parse_account_secrets_data(data).unwrap();

        assert_eq!(record.kdf_params.version, 1);
        assert_eq!(record.account_key_wrap, "AA==");
    }

    #[test]
    fn parses_account_secrets_from_string_publisher_body() {
        let upstream = serde_json::json!({
            "data": serde_json::from_str::<serde_json::Value>(account_secrets_record_json()).unwrap()
        });
        let body = serde_json::json!({
            "data": {
                "body": upstream.to_string(),
                "status": 200
            }
        });

        let data = parse_data_body::<serde_json::Value>(&body.to_string()).unwrap();
        let record = parse_account_secrets_data(data).unwrap();

        assert_eq!(record.kdf_params.version, 1);
        assert_eq!(record.account_key_wrap, "AA==");
    }

    #[test]
    fn passwords_item_paths_match_live_publisher_contract() {
        let vault_id = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let item_id = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();

        assert_eq!(
            passwords_url(&list_items_path(vault_id)),
            "https://api.serendb.com/publishers/seren-passwords/vaults/11111111-1111-4111-8111-111111111111/items?state=active"
        );
        assert_eq!(
            passwords_url(&item_path(vault_id, item_id)),
            "https://api.serendb.com/publishers/seren-passwords/vaults/11111111-1111-4111-8111-111111111111/items/22222222-2222-4222-8222-222222222222"
        );
    }

    #[test]
    fn reports_publisher_upstream_error() {
        let body = serde_json::json!({
            "data": {
                "body": {
                    "error": {
                        "message": "setup required"
                    }
                },
                "status": 404
            }
        });

        let err = parse_data_body::<serde_json::Value>(&body.to_string()).unwrap_err();

        assert!(err.to_string().contains("upstream HTTP 404"));
    }

    #[test]
    fn wrong_master_password_returns_user_facing_error() {
        let bundle = account_setup(b"correct horse battery staple").unwrap();
        let err = unlock_account_for_passwords(b"wrong password", &bundle.secrets).unwrap_err();

        assert_eq!(err.to_string(), "Incorrect vault password.");
    }

    #[test]
    fn master_password_policy_rejects_low_entropy_values() {
        assert!(validate_master_password(b"aaaaaaaaaaaa").is_err());
        assert!(validate_master_password(b"CorrectHorseBatteryStaple!2026").is_ok());
    }

    #[test]
    fn create_vault_name_round_trips() {
        let vault_key = generate_vault_key();
        let vault_id = Uuid::new_v4();
        let name_ct = encrypt_vault_name(&vault_key, vault_id.as_bytes(), "Trading keys");

        let body = CreateVaultRequest {
            vault_id,
            name_ciphertext: B64.encode(&name_ct),
            description_ciphertext: None,
            owner_kind: "user",
            access_level: "admin",
            initial_wrapped_vault_key: B64.encode([0u8; 48]),
            granted_signature: String::new(),
        };

        let decoded = B64.decode(body.name_ciphertext.as_bytes()).unwrap();
        let name = decrypt_vault_name(&vault_key, vault_id.as_bytes(), &decoded).unwrap();
        assert_eq!(name, "Trading keys");
    }

    #[test]
    fn create_vault_body_omits_absent_description_and_uses_snake_case() {
        let body = CreateVaultRequest {
            vault_id: Uuid::nil(),
            name_ciphertext: "bmFtZQ==".into(),
            description_ciphertext: None,
            owner_kind: "user",
            access_level: "admin",
            initial_wrapped_vault_key: "AA==".into(),
            granted_signature: String::new(),
        };

        let json = serde_json::to_value(&body).unwrap();
        assert!(json.get("description_ciphertext").is_none());
        assert_eq!(json["owner_kind"], "user");
        assert_eq!(json["access_level"], "admin");
        assert_eq!(json["granted_signature"], "");
        assert!(json.get("name_ciphertext").is_some());
        assert!(json.get("initial_wrapped_vault_key").is_some());
    }

    #[test]
    fn sanitizes_secret_fields() {
        let fields = sanitize_fields(vec![PasswordsSecretFieldInput {
            name: " api_key ".into(),
            value: "secret".into(),
        }])
        .unwrap();

        assert_eq!(fields[0].name, "API_KEY");
        assert_eq!(fields[0].value, "secret");
    }

    #[test]
    fn rejects_invalid_secret_fields() {
        assert!(sanitize_fields(Vec::new()).is_err());
        assert!(
            sanitize_fields(vec![PasswordsSecretFieldInput {
                name: "1BAD".into(),
                value: "secret".into(),
            }])
            .is_err()
        );
        assert!(
            sanitize_fields(vec![PasswordsSecretFieldInput {
                name: "GOOD".into(),
                value: String::new(),
            }])
            .is_err()
        );
        assert!(
            sanitize_fields(vec![
                PasswordsSecretFieldInput {
                    name: "API_KEY".into(),
                    value: "secret".into(),
                },
                PasswordsSecretFieldInput {
                    name: " api_key ".into(),
                    value: "other".into(),
                },
            ])
            .is_err()
        );
    }

    #[test]
    fn sanitizes_password_item_fields_without_env_name_rules() {
        let mut fields = vec![
            PasswordsSecretFieldInput {
                name: " username ".into(),
                value: "taariq@example.com".into(),
            },
            PasswordsSecretFieldInput {
                name: "workspace".into(),
                value: "Glide".into(),
            },
        ];

        sanitize_password_item_fields_in_place(&mut fields).unwrap();

        assert_eq!(fields[0].name, "username");
        assert_eq!(fields[1].name, "workspace");

        fields.push(PasswordsSecretFieldInput {
            name: "WORKSPACE".into(),
            value: "duplicate".into(),
        });
        let err = sanitize_password_item_fields_in_place(&mut fields).unwrap_err();
        assert!(err.contains("duplicated"));
    }

    #[test]
    fn builds_api_credential_content() {
        let fields = sanitize_fields(vec![PasswordsSecretFieldInput {
            name: "api_key".into(),
            value: "secret".into(),
        }])
        .unwrap();
        let content = build_secret_reference_content(&fields);

        let ItemContent::ApiCredential(api) = content else {
            panic!("expected api credential content");
        };
        assert_eq!(api.kind, ApiCredentialKind::ApiKey);
        assert_eq!(api.custom_fields[0].name, "API_KEY");
        assert_eq!(api.custom_fields[0].value, "secret");
        assert!(api.primary_value.is_empty());
    }

    #[test]
    fn api_credential_content_populates_builtin_aliases() {
        let fields = sanitize_fields(vec![
            PasswordsSecretFieldInput {
                name: "KEY".into(),
                value: "public-ish".into(),
            },
            PasswordsSecretFieldInput {
                name: "SECRET".into(),
                value: "private".into(),
            },
            PasswordsSecretFieldInput {
                name: "PASSWORD".into(),
                value: "password-value".into(),
            },
        ])
        .unwrap();
        let content = build_secret_reference_content(&fields);

        let ItemContent::ApiCredential(api) = content else {
            panic!("expected api credential content");
        };
        assert_eq!(api.primary_value, "public-ish");
        assert_eq!(api.secondary_value, "private");
        assert_eq!(api.custom_fields.len(), 3);
    }

    #[test]
    fn rejects_conflicting_builtin_aliases() {
        assert!(
            sanitize_fields(vec![
                PasswordsSecretFieldInput {
                    name: "KEY".into(),
                    value: "secret".into(),
                },
                PasswordsSecretFieldInput {
                    name: "VALUE".into(),
                    value: "secret".into(),
                },
            ])
            .is_err()
        );
    }

    #[test]
    fn truncates_error_body_on_char_boundary() {
        let body = "a".repeat(239) + "é trailing";
        let truncated = truncate_error_body(&body);

        assert!(truncated.ends_with("...[truncated]"));
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn unlock_vaults_skips_records_with_undecryptable_keys() {
        use seren_secrets_crypto::keys::IdentityKemKeypair;

        let keypair = IdentityKemKeypair::generate();
        let vault_key = generate_vault_key();
        let good_vault_id = Uuid::new_v4();
        let bad_vault_id = Uuid::new_v4();
        let wrapped = wrap_vault_key_for_identity(&vault_key, &keypair.public);

        let (unlocked, failed) = unlock_vaults(
            vec![
                VaultRecord {
                    vault_id: bad_vault_id,
                    name_ciphertext: None,
                    wrapped_vault_key: Some(B64.encode([0u8; 48])),
                    vault_key_version: 1,
                },
                VaultRecord {
                    vault_id: good_vault_id,
                    name_ciphertext: None,
                    wrapped_vault_key: Some(B64.encode(&wrapped)),
                    vault_key_version: 3,
                },
            ],
            &keypair.private,
            None,
        );

        assert_eq!(failed, 1);
        assert_eq!(unlocked.len(), 1);
        let vault = unlocked.get(&good_vault_id).unwrap();
        assert_eq!(vault.vault_key_version, 3);
        assert!(vault.writable);
    }

    #[test]
    fn select_writable_vault_uses_membership_access() {
        let identity_id = Uuid::new_v4();
        let read_only_vault_id = Uuid::new_v4();
        let writable_vault_id = Uuid::new_v4();

        let selected = select_writable_vault(
            SyncResponse {
                vaults: vec![
                    VaultRecord {
                        vault_id: read_only_vault_id,
                        name_ciphertext: None,
                        wrapped_vault_key: Some("read-only-wrap".into()),
                        vault_key_version: 1,
                    },
                    VaultRecord {
                        vault_id: writable_vault_id,
                        name_ciphertext: None,
                        wrapped_vault_key: Some("write-wrap".into()),
                        vault_key_version: 2,
                    },
                ],
                memberships: Some(vec![
                    MembershipRecord {
                        vault_id: read_only_vault_id,
                        identity_id,
                        access_level: "read".into(),
                    },
                    MembershipRecord {
                        vault_id: writable_vault_id,
                        identity_id,
                        access_level: "write".into(),
                    },
                ]),
            },
            identity_id,
        )
        .unwrap();

        assert_eq!(selected.vault_id, writable_vault_id);
        assert_eq!(selected.vault_key_version, 2);
    }

    #[test]
    fn select_writable_vault_rejects_read_only_membership() {
        let identity_id = Uuid::new_v4();
        let vault_id = Uuid::new_v4();

        let err = select_writable_vault(
            SyncResponse {
                vaults: vec![VaultRecord {
                    vault_id,
                    name_ciphertext: None,
                    wrapped_vault_key: Some("read-only-wrap".into()),
                    vault_key_version: 1,
                }],
                memberships: Some(vec![MembershipRecord {
                    vault_id,
                    identity_id,
                    access_level: "read".into(),
                }]),
            },
            identity_id,
        )
        .unwrap_err();

        assert_eq!(
            err.to_string(),
            "No writable Seren Passwords vault is available"
        );
    }

    #[test]
    fn select_writable_vault_rejects_explicit_empty_memberships() {
        let identity_id = Uuid::new_v4();
        let vault_id = Uuid::new_v4();

        let err = select_writable_vault(
            SyncResponse {
                vaults: vec![VaultRecord {
                    vault_id,
                    name_ciphertext: None,
                    wrapped_vault_key: Some("wrapped-key".into()),
                    vault_key_version: 1,
                }],
                memberships: Some(Vec::new()),
            },
            identity_id,
        )
        .unwrap_err();

        assert_eq!(
            err.to_string(),
            "No writable Seren Passwords vault is available"
        );
    }

    #[test]
    fn select_writable_vault_keeps_old_sync_fallback() {
        let identity_id = Uuid::new_v4();
        let vault_id = Uuid::new_v4();

        let selected = select_writable_vault(
            SyncResponse {
                vaults: vec![VaultRecord {
                    vault_id,
                    name_ciphertext: None,
                    wrapped_vault_key: Some("wrapped-key".into()),
                    vault_key_version: 1,
                }],
                memberships: None,
            },
            identity_id,
        )
        .unwrap();

        assert_eq!(selected.vault_id, vault_id);
    }

    #[test]
    fn build_create_request_round_trips_content_and_omits_empty_tags() {
        use seren_secrets_crypto::protocol::item::{
            decrypt_item_with_content_key, decrypt_metadata_json, decrypt_title,
            unwrap_item_content_key,
        };
        use seren_secrets_crypto::protocol::vault::generate_vault_key;

        let fields = sanitize_fields(vec![PasswordsSecretFieldInput {
            name: "api_key".into(),
            value: "secret".into(),
        }])
        .unwrap();
        let content = build_secret_reference_content(&fields);
        let vault_key = generate_vault_key();
        let item_id = Uuid::new_v4();

        let request = build_create_item_request(
            &vault_key,
            item_id,
            &content,
            "Desktop API",
            &[],
            &default_api_credential_metadata(),
            7,
        )
        .unwrap();

        assert_eq!(request.item_id, item_id);
        assert!(request.tags_ciphertext.is_none());
        assert_eq!(request.wrapping_key_version, Some(7));

        let content_key_wrap = B64.decode(request.content_key_wrap.as_bytes()).unwrap();
        let content_key =
            unwrap_item_content_key(&vault_key, item_id.as_bytes(), &content_key_wrap).unwrap();
        let body_ct = B64.decode(request.content_ciphertext.as_bytes()).unwrap();
        let recovered =
            decrypt_item_with_content_key(&content_key, item_id.as_bytes(), &body_ct).unwrap();
        let title_ct = B64.decode(request.title_ciphertext.as_bytes()).unwrap();
        let title = decrypt_title(&vault_key, item_id.as_bytes(), &title_ct).unwrap();
        let metadata_ct = B64.decode(request.metadata_ciphertext.as_bytes()).unwrap();
        let metadata = decrypt_metadata_json(&vault_key, item_id.as_bytes(), &metadata_ct).unwrap();

        assert_eq!(title, "Desktop API");
        assert!(metadata.contains(r#""item_kind":"api_credential""#));
        let ItemContent::ApiCredential(api) = recovered.as_ref() else {
            panic!("expected api credential");
        };
        assert_eq!(api.custom_fields[0].name, "API_KEY");
        assert_eq!(api.custom_fields[0].value, "secret");
    }

    #[test]
    fn update_request_reuses_existing_content_key_wrap() {
        use seren_secrets_crypto::protocol::item::{
            decrypt_item_with_content_key, unwrap_item_content_key,
        };

        let vault_key = generate_vault_key();
        let item_id = Uuid::new_v4();
        let existing_content_key = generate_item_content_key();
        let existing_wrap =
            wrap_item_content_key(&vault_key, item_id.as_bytes(), &existing_content_key);
        let existing_wrap_b64 = B64.encode(&existing_wrap);
        let fields = sanitize_fields(vec![PasswordsSecretFieldInput {
            name: "API_KEY".into(),
            value: "new-secret".into(),
        }])
        .unwrap();
        let content = build_secret_reference_content(&fields);

        let request = build_item_request_with_content_key(
            &vault_key,
            item_id,
            &existing_content_key,
            existing_wrap_b64.clone(),
            &content,
            "Updated API",
            &["trading".to_string()],
            &default_api_credential_metadata(),
            4,
        )
        .unwrap();

        assert_eq!(request.content_key_wrap, existing_wrap_b64);
        assert!(request.tags_ciphertext.is_some());
        assert_eq!(request.wrapping_key_version, Some(4));
        let recovered_content_key = unwrap_item_content_key(
            &vault_key,
            item_id.as_bytes(),
            &B64.decode(request.content_key_wrap.as_bytes()).unwrap(),
        )
        .unwrap();
        let body_ct = B64.decode(request.content_ciphertext.as_bytes()).unwrap();
        let recovered =
            decrypt_item_with_content_key(&recovered_content_key, item_id.as_bytes(), &body_ct)
                .unwrap();
        let ItemContent::ApiCredential(api) = recovered.as_ref() else {
            panic!("expected api credential");
        };
        assert_eq!(api.custom_fields[0].value, "new-secret");
    }

    #[test]
    fn decrypt_item_detail_returns_fields_after_source_is_zeroized() {
        use seren_secrets_crypto::protocol::vault::generate_vault_key;

        let fields = sanitize_fields(vec![
            PasswordsSecretFieldInput {
                name: "api_key".into(),
                value: "ak_live".into(),
            },
            PasswordsSecretFieldInput {
                name: "secret".into(),
                value: "shh".into(),
            },
        ])
        .unwrap();
        let content = build_secret_reference_content(&fields);
        let vault_key = generate_vault_key();
        let item_id = Uuid::new_v4();
        let vault_uuid = Uuid::new_v4();

        let request = build_create_item_request(
            &vault_key,
            item_id,
            &content,
            "Desktop API",
            &[],
            &default_api_credential_metadata(),
            1,
        )
        .unwrap();

        let vault = UnlockedVault {
            vault_id: vault_uuid,
            name: "Personal".to_string(),
            vault_key,
            vault_key_version: 1,
            writable: true,
            item_count: 0,
        };
        let record = ItemRecord {
            item_id,
            vault_id: vault_uuid,
            title_ciphertext: request.title_ciphertext.clone(),
            content_ciphertext: request.content_ciphertext.clone(),
            content_key_wrap: request.content_key_wrap.clone(),
            tags_ciphertext: request.tags_ciphertext.clone(),
            metadata_ciphertext: request.metadata_ciphertext.clone(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };

        let detail = decrypt_item_detail(&vault, record).unwrap();

        assert_eq!(detail.title, "Desktop API");
        assert_eq!(detail.item_kind, "api_credential");
        let by_name: BTreeMap<_, _> = detail
            .fields
            .iter()
            .map(|field| (field.name.clone(), field.value.clone()))
            .collect();
        assert_eq!(by_name.get("API_KEY").map(String::as_str), Some("ak_live"));
        assert_eq!(by_name.get("SECRET").map(String::as_str), Some("shh"));
    }

    #[test]
    fn decrypt_item_detail_returns_login_fields() {
        use seren_secrets_crypto::protocol::item::{LoginUrl, TotpAlgorithm, TotpConfig};
        use seren_secrets_crypto::protocol::vault::generate_vault_key;

        let (notes, notes_text) = seren_secrets_crypto::prose::from_plaintext("shared team login");
        let totp_value = "fixture";
        let content = ItemContent::Login(LoginContent {
            username: "taariq@example.com".into(),
            password: "vault-password".into(),
            urls: vec![LoginUrl::plain("https://www.canva.com")],
            totp: Some(TotpConfig {
                secret_base32: totp_value.into(),
                algorithm: TotpAlgorithm::Sha1,
                digits: 6,
                period_seconds: 30,
            }),
            notes,
            notes_text,
            custom_fields: vec![CustomField {
                name: "workspace".into(),
                kind: CustomFieldKind::String,
                value: "Glide".into(),
                purpose: None,
                section_id: None,
            }],
            ..Default::default()
        });
        let vault_key = generate_vault_key();
        let item_id = Uuid::new_v4();
        let vault_uuid = Uuid::new_v4();
        let metadata = ItemListMetadata {
            item_kind: "login".to_string(),
            favorite: false,
            sensitive: true,
            reprompt: false,
        };

        let request =
            build_create_item_request(&vault_key, item_id, &content, "Canva", &[], &metadata, 1)
                .unwrap();

        let vault = UnlockedVault {
            vault_id: vault_uuid,
            name: "Glide".to_string(),
            vault_key,
            vault_key_version: 1,
            writable: true,
            item_count: 0,
        };
        let record = ItemRecord {
            item_id,
            vault_id: vault_uuid,
            title_ciphertext: request.title_ciphertext.clone(),
            content_ciphertext: request.content_ciphertext.clone(),
            content_key_wrap: request.content_key_wrap.clone(),
            tags_ciphertext: request.tags_ciphertext.clone(),
            metadata_ciphertext: request.metadata_ciphertext.clone(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };

        let detail = decrypt_item_detail(&vault, record).unwrap();

        assert_eq!(detail.title, "Canva");
        assert_eq!(detail.item_kind, "login");
        let by_name: BTreeMap<_, _> = detail
            .fields
            .iter()
            .map(|field| (field.name.clone(), field.value.clone()))
            .collect();
        assert_eq!(
            by_name.get("username").map(String::as_str),
            Some("taariq@example.com")
        );
        assert_eq!(
            by_name.get("password").map(String::as_str),
            Some("vault-password")
        );
        assert_eq!(
            by_name.get("url").map(String::as_str),
            Some("https://www.canva.com")
        );
        assert_eq!(by_name.get("totp").map(String::as_str), Some(totp_value));
        assert_eq!(
            by_name.get("notes").map(String::as_str),
            Some("shared team login")
        );
        assert_eq!(by_name.get("workspace").map(String::as_str), Some("Glide"));
    }

    #[test]
    fn decrypt_item_detail_refuses_reprompt_items() {
        use seren_secrets_crypto::protocol::vault::generate_vault_key;

        let fields = sanitize_fields(vec![PasswordsSecretFieldInput {
            name: "API_KEY".into(),
            value: "ak_live".into(),
        }])
        .unwrap();
        let content = build_secret_reference_content(&fields);
        let vault_key = generate_vault_key();
        let item_id = Uuid::new_v4();
        let vault_uuid = Uuid::new_v4();
        let metadata = ItemListMetadata {
            item_kind: "api_credential".to_string(),
            favorite: false,
            sensitive: true,
            reprompt: true,
        };
        let request = build_create_item_request(
            &vault_key,
            item_id,
            &content,
            "Desktop API",
            &[],
            &metadata,
            1,
        )
        .unwrap();

        let vault = UnlockedVault {
            vault_id: vault_uuid,
            name: "Personal".to_string(),
            vault_key,
            vault_key_version: 1,
            writable: true,
            item_count: 0,
        };
        let record = ItemRecord {
            item_id,
            vault_id: vault_uuid,
            title_ciphertext: request.title_ciphertext.clone(),
            content_ciphertext: request.content_ciphertext.clone(),
            content_key_wrap: request.content_key_wrap.clone(),
            tags_ciphertext: request.tags_ciphertext.clone(),
            metadata_ciphertext: request.metadata_ciphertext.clone(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };

        let Err(err) = decrypt_item_detail(&vault, record) else {
            panic!("reprompt item should not decrypt");
        };

        assert!(
            err.to_string()
                .contains("requires a master password reprompt")
        );
    }

    #[test]
    fn decrypt_item_detail_skips_content_for_non_credential_kinds() {
        use seren_secrets_crypto::protocol::vault::generate_vault_key;

        let vault_key = generate_vault_key();
        let item_id = Uuid::new_v4();
        let vault_uuid = Uuid::new_v4();
        let title_ct = encrypt_title(&vault_key, item_id.as_bytes(), "A secure note");
        let metadata_ct = encrypt_metadata_json(
            &vault_key,
            item_id.as_bytes(),
            r#"{"item_kind":"secure_note","favorite":false,"sensitive":false,"reprompt":false}"#,
        );

        let vault = UnlockedVault {
            vault_id: vault_uuid,
            name: "Personal".to_string(),
            vault_key,
            vault_key_version: 1,
            writable: true,
            item_count: 0,
        };
        // Garbage content blobs prove the content path is never decrypted for
        // non-credential kinds the editor does not surface.
        let record = ItemRecord {
            item_id,
            vault_id: vault_uuid,
            title_ciphertext: B64.encode(title_ct),
            content_ciphertext: B64.encode([0u8; 64]),
            content_key_wrap: B64.encode([0u8; 64]),
            tags_ciphertext: None,
            metadata_ciphertext: B64.encode(metadata_ct),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };

        let detail = decrypt_item_detail(&vault, record).unwrap();

        assert_eq!(detail.item_kind, "secure_note");
        assert!(detail.fields.is_empty());
    }

    /// End-to-end round trip for the body Desktop posts to the service.
    ///
    /// Encrypts via the same `encrypt_item_with_content_key` Desktop uses,
    /// then decrypts with the matching primitive and verifies field values
    /// survive intact. Anything that breaks the wire shape of
    /// `ApiCredentialContent` (for instance the historical duplicate-`kind`
    /// collision between the outer `ItemContent` tag and the inner kind
    /// field) makes this assertion fail.
    ///
    #[test]
    fn api_credential_item_round_trips_through_aead() {
        use seren_secrets_crypto::keys::ItemContentKey;
        use seren_secrets_crypto::protocol::item::{
            decrypt_item_with_content_key, encrypt_item_with_content_key,
        };

        let fields = sanitize_fields(vec![
            PasswordsSecretFieldInput {
                name: "POLY_API_KEY".into(),
                value: "ak_live".into(),
            },
            PasswordsSecretFieldInput {
                name: "POLY_SECRET".into(),
                value: "secret-value".into(),
            },
        ])
        .unwrap();
        let content = build_secret_reference_content(&fields);
        let content_key = ItemContentKey::random();
        let item_id = Uuid::new_v4();

        let blob =
            encrypt_item_with_content_key(&content_key, item_id.as_bytes(), &content).unwrap();
        let recovered =
            decrypt_item_with_content_key(&content_key, item_id.as_bytes(), &blob).unwrap();

        let ItemContent::ApiCredential(api) = recovered.as_ref() else {
            panic!("api_credential variant did not survive the round trip");
        };
        assert_eq!(api.custom_fields.len(), 2);
        let by_name: std::collections::BTreeMap<_, _> = api
            .custom_fields
            .iter()
            .map(|f| (f.name.clone(), f.value.clone()))
            .collect();
        assert_eq!(
            by_name.get("POLY_API_KEY").map(String::as_str),
            Some("ak_live")
        );
        assert_eq!(
            by_name.get("POLY_SECRET").map(String::as_str),
            Some("secret-value")
        );
    }

    #[test]
    fn build_create_request_round_trips_supplied_metadata() {
        let fields = sanitize_fields(vec![PasswordsSecretFieldInput {
            name: "api_key".into(),
            value: "secret".into(),
        }])
        .unwrap();
        let content = build_secret_reference_content(&fields);
        let vault_key = generate_vault_key();
        let item_id = Uuid::new_v4();
        let metadata = ItemListMetadata {
            item_kind: "api_credential".to_string(),
            favorite: true,
            sensitive: true,
            reprompt: true,
        };

        let request = build_create_item_request(
            &vault_key,
            item_id,
            &content,
            "Desktop API",
            &[],
            &metadata,
            1,
        )
        .unwrap();

        assert!(request.sensitive);
        let metadata_ct = B64.decode(request.metadata_ciphertext.as_bytes()).unwrap();
        let json = decrypt_metadata_json(&vault_key, item_id.as_bytes(), &metadata_ct).unwrap();
        let recovered: ItemListMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(recovered.item_kind, "api_credential");
        assert!(recovered.favorite);
        assert!(recovered.sensitive);
        assert!(recovered.reprompt);
    }

    #[test]
    fn notes_alias_writes_canonical_doc_and_projection() {
        let fields = sanitize_fields(vec![PasswordsSecretFieldInput {
            name: "NOTES".into(),
            value: "line one\nline two".into(),
        }])
        .unwrap();
        let content = build_secret_reference_content(&fields);

        let ItemContent::ApiCredential(api) = content else {
            panic!("expected api credential content");
        };
        assert_eq!(api.notes_text, "line one\nline two");
        assert_eq!(api.notes.plain_text(), "line one\nline two");
    }

    fn foreign_api_credential(custom_fields: Vec<CustomField>) -> ItemContent {
        let (notes, notes_text) = seren_secrets_crypto::prose::from_plaintext("imported notes");
        ItemContent::ApiCredential(ApiCredentialContent {
            kind: ApiCredentialKind::Oauth2Token,
            primary_value: "foreign-primary".to_string(),
            secondary_value: "foreign-secondary".to_string(),
            headers: BTreeMap::from([("Authorization".to_string(), "Bearer abc".to_string())])
                .into(),
            rotation: None,
            notes,
            notes_text,
            custom_fields,
            sections: Vec::new(),
            raw_import: serde_json::json!({"source": "import"}).into(),
        })
    }

    #[test]
    fn merge_preserves_content_the_editor_never_surfaces() {
        let mut existing = foreign_api_credential(vec![CustomField {
            name: "API_KEY".to_string(),
            kind: CustomFieldKind::Concealed,
            value: "old-secret".to_string(),
            purpose: None,
            section_id: None,
        }]);
        let fields = sanitize_fields(vec![PasswordsSecretFieldInput {
            name: "API_KEY".into(),
            value: "new-secret".into(),
        }])
        .unwrap();
        let mut content = build_secret_reference_content(&fields);

        merge_api_credential_content(&mut content, &mut existing);

        let ItemContent::ApiCredential(merged) = content else {
            panic!("expected api credential content");
        };
        assert_eq!(merged.kind, ApiCredentialKind::Oauth2Token);
        assert_eq!(
            merged.headers.get("Authorization").map(String::as_str),
            Some("Bearer abc")
        );
        assert_eq!(merged.raw_import["source"], "import");
        // Alias slots and notes were never visible alongside the existing
        // custom fields, so the update must not clear them.
        assert_eq!(merged.primary_value, "foreign-primary");
        assert_eq!(merged.secondary_value, "foreign-secondary");
        assert_eq!(merged.notes_text, "imported notes");
        assert_eq!(merged.notes.plain_text(), "imported notes");
        // The surfaced custom fields are fully replaced by the submission.
        assert_eq!(merged.custom_fields.len(), 1);
        assert_eq!(merged.custom_fields[0].value, "new-secret");
    }

    #[test]
    fn merge_honors_deliberate_alias_removal() {
        let mut existing = foreign_api_credential(vec![
            CustomField {
                name: "KEY".to_string(),
                kind: CustomFieldKind::Concealed,
                value: "foreign-primary".to_string(),
                purpose: None,
                section_id: None,
            },
            CustomField {
                name: "NOTES".to_string(),
                kind: CustomFieldKind::Concealed,
                value: "imported notes".to_string(),
                purpose: None,
                section_id: None,
            },
        ]);
        let fields = sanitize_fields(vec![PasswordsSecretFieldInput {
            name: "API_KEY".into(),
            value: "new-secret".into(),
        }])
        .unwrap();
        let mut content = build_secret_reference_content(&fields);

        merge_api_credential_content(&mut content, &mut existing);

        let ItemContent::ApiCredential(merged) = content else {
            panic!("expected api credential content");
        };
        // KEY and NOTES were visible in the editor and omitted from the
        // submission, so the removal sticks.
        assert!(merged.primary_value.is_empty());
        assert!(merged.notes_text.is_empty());
        assert!(merged.notes.plain_text().is_empty());
        // SECRET was never surfaced, so the stored value survives.
        assert_eq!(merged.secondary_value, "foreign-secondary");
    }

    #[test]
    fn merge_login_content_fields_updates_visible_fields_only() {
        let (notes, notes_text) = seren_secrets_crypto::prose::from_plaintext("old note");
        let mut content = ItemContent::Login(LoginContent {
            username: "old-user".to_string(),
            password: "old-password".to_string(),
            urls: vec![
                LoginUrl::plain("https://old.example.com"),
                LoginUrl::plain("https://secondary.example.com"),
            ],
            totp: Some(TotpConfig {
                secret_base32: "OLDTOTP".to_string(),
                algorithm: TotpAlgorithm::Sha256,
                digits: 8,
                period_seconds: 45,
            }),
            notes,
            notes_text,
            custom_fields: vec![CustomField {
                name: "workspace".to_string(),
                kind: CustomFieldKind::String,
                value: "Old".to_string(),
                purpose: None,
                section_id: Some("details".to_string()),
            }],
            autofill_on_page_load: Some(true),
            ..Default::default()
        });
        let mut fields = vec![
            PasswordsSecretFieldInput {
                name: "username".into(),
                value: "new-user".into(),
            },
            PasswordsSecretFieldInput {
                name: "password".into(),
                value: "new-password".into(),
            },
            PasswordsSecretFieldInput {
                name: "url".into(),
                value: "https://new.example.com".into(),
            },
            PasswordsSecretFieldInput {
                name: "totp".into(),
                value: "NEWTOTP".into(),
            },
            PasswordsSecretFieldInput {
                name: "notes".into(),
                value: "new note".into(),
            },
            PasswordsSecretFieldInput {
                name: "workspace".into(),
                value: "Glide".into(),
            },
            PasswordsSecretFieldInput {
                name: "team secret".into(),
                value: "shared".into(),
            },
        ];
        sanitize_password_item_fields_in_place(&mut fields).unwrap();

        merge_login_content_fields(&mut content, &fields).unwrap();

        let ItemContent::Login(login) = content else {
            panic!("expected login content");
        };
        assert_eq!(login.username, "new-user");
        assert_eq!(login.password, "new-password");
        assert_eq!(login.urls[0].url, "https://new.example.com");
        assert_eq!(login.urls[1].url, "https://secondary.example.com");
        let totp = login.totp.unwrap();
        assert_eq!(totp.secret_base32, "NEWTOTP");
        assert_eq!(totp.algorithm, TotpAlgorithm::Sha256);
        assert_eq!(totp.digits, 8);
        assert_eq!(totp.period_seconds, 45);
        assert_eq!(login.notes_text, "new note");
        assert_eq!(login.autofill_on_page_load, Some(true));
        assert_eq!(login.custom_fields.len(), 2);
        assert_eq!(login.custom_fields[0].name, "workspace");
        assert_eq!(login.custom_fields[0].kind, CustomFieldKind::String);
        assert_eq!(
            login.custom_fields[0].section_id.as_deref(),
            Some("details")
        );
        assert_eq!(login.custom_fields[1].name, "team secret");
        assert_eq!(login.custom_fields[1].kind, CustomFieldKind::Concealed);
    }
}
