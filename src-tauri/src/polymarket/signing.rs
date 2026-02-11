// ABOUTME: HMAC-SHA256 signing for Polymarket CLOB API L2 authentication.
// ABOUTME: Generates POLY_SIGNATURE headers for authenticated trading requests.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use super::PolymarketError;

type HmacSha256 = Hmac<Sha256>;

/// Polymarket API credentials for L2 authentication
///
/// # Security
/// The `api_secret` is base64url-encoded and MUST NOT be logged.
#[derive(Clone)]
pub struct ApiCredentials {
    pub api_key: String,
    pub api_secret: String,
    pub passphrase: String,
}

// Custom Debug to avoid logging secrets
impl std::fmt::Debug for ApiCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiCredentials")
            .field("api_key", &self.api_key)
            .field("api_secret", &"[REDACTED]")
            .field("passphrase", &"[REDACTED]")
            .finish()
    }
}

/// L2 authentication headers for Polymarket CLOB API
#[derive(Debug, Clone, serde::Serialize)]
pub struct L2Headers {
    pub poly_address: String,
    pub poly_signature: String,
    pub poly_timestamp: String,
    pub poly_api_key: String,
    pub poly_passphrase: String,
}

/// Build HMAC-SHA256 signature for Polymarket L2 authentication.
///
/// The signature is computed as:
/// `HMAC-SHA256(base64url_decode(secret), timestamp + method + path + body)`
/// and base64url-encoded.
///
/// # Arguments
/// * `secret` - Base64url-encoded API secret
/// * `timestamp` - Unix timestamp as string
/// * `method` - HTTP method (GET, POST, DELETE)
/// * `request_path` - The API path (e.g., "/orders")
/// * `body` - Request body (JSON string, empty for GET requests)
pub fn build_hmac_signature(
    secret: &str,
    timestamp: &str,
    method: &str,
    request_path: &str,
    body: &str,
) -> Result<String, PolymarketError> {
    // Decode the base64url-encoded secret
    let decoded_secret = URL_SAFE.decode(secret).map_err(|e| {
        PolymarketError::SigningFailed(format!("Failed to decode API secret: {}", e))
    })?;

    // Build message: timestamp + method + requestPath + body
    let mut message = format!("{}{}{}", timestamp, method, request_path);
    if !body.is_empty() {
        message.push_str(body);
    }

    // Compute HMAC-SHA256
    let mut mac = HmacSha256::new_from_slice(&decoded_secret)
        .map_err(|e| PolymarketError::SigningFailed(format!("HMAC key error: {}", e)))?;
    mac.update(message.as_bytes());
    let result = mac.finalize();

    // Base64url-encode the signature (with padding, matching Polymarket's expectation)
    Ok(URL_SAFE.encode(result.into_bytes()))
}

/// Build L2 authentication headers for a Polymarket CLOB API request.
///
/// # Arguments
/// * `credentials` - API credentials (key, secret, passphrase)
/// * `address` - Ethereum wallet address
/// * `method` - HTTP method (GET, POST, DELETE)
/// * `request_path` - API endpoint path (e.g., "/orders")
/// * `body` - Request body (empty string for GET)
pub fn build_l2_headers(
    credentials: &ApiCredentials,
    address: &str,
    method: &str,
    request_path: &str,
    body: &str,
) -> Result<L2Headers, PolymarketError> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| PolymarketError::SigningFailed(format!("Time error: {}", e)))?
        .as_secs()
        .to_string();

    let signature = build_hmac_signature(
        &credentials.api_secret,
        &timestamp,
        method,
        request_path,
        body,
    )?;

    Ok(L2Headers {
        poly_address: address.to_string(),
        poly_signature: signature,
        poly_timestamp: timestamp,
        poly_api_key: credentials.api_key.clone(),
        poly_passphrase: credentials.passphrase.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_hmac_signature_deterministic() {
        // Use a known base64url-encoded secret
        let secret = URL_SAFE.encode(b"test-secret-key-for-hmac");

        let sig1 = build_hmac_signature(&secret, "1704067200", "GET", "/orders", "").unwrap();
        let sig2 = build_hmac_signature(&secret, "1704067200", "GET", "/orders", "").unwrap();

        assert_eq!(sig1, sig2, "Same inputs should produce same signature");
    }

    #[test]
    fn test_build_hmac_signature_with_body() {
        let secret = URL_SAFE.encode(b"test-secret-key-for-hmac");

        let sig_no_body =
            build_hmac_signature(&secret, "1704067200", "POST", "/orders", "").unwrap();
        let sig_with_body = build_hmac_signature(
            &secret,
            "1704067200",
            "POST",
            "/orders",
            r#"{"side":"BUY","price":"0.50"}"#,
        )
        .unwrap();

        assert_ne!(
            sig_no_body, sig_with_body,
            "Different bodies should produce different signatures"
        );
    }

    #[test]
    fn test_build_hmac_signature_different_methods() {
        let secret = URL_SAFE.encode(b"test-secret-key-for-hmac");

        let sig_get = build_hmac_signature(&secret, "1704067200", "GET", "/orders", "").unwrap();
        let sig_post = build_hmac_signature(&secret, "1704067200", "POST", "/orders", "").unwrap();

        assert_ne!(
            sig_get, sig_post,
            "Different methods should produce different signatures"
        );
    }

    #[test]
    fn test_build_hmac_signature_different_timestamps() {
        let secret = URL_SAFE.encode(b"test-secret-key-for-hmac");

        let sig1 = build_hmac_signature(&secret, "1704067200", "GET", "/orders", "").unwrap();
        let sig2 = build_hmac_signature(&secret, "1704067201", "GET", "/orders", "").unwrap();

        assert_ne!(
            sig1, sig2,
            "Different timestamps should produce different signatures"
        );
    }

    #[test]
    fn test_build_hmac_signature_is_base64url() {
        let secret = URL_SAFE.encode(b"test-secret-key-for-hmac");
        let sig = build_hmac_signature(&secret, "1704067200", "GET", "/orders", "").unwrap();

        // base64url should not contain + or /
        assert!(
            !sig.contains('+'),
            "base64url should not contain '+': {}",
            sig
        );
        assert!(
            !sig.contains('/'),
            "base64url should not contain '/': {}",
            sig
        );

        // Should be decodable
        let decoded = URL_SAFE.decode(&sig);
        assert!(decoded.is_ok(), "Signature should be valid base64url");

        // HMAC-SHA256 produces 32 bytes
        assert_eq!(decoded.unwrap().len(), 32, "HMAC-SHA256 should be 32 bytes");
    }

    #[test]
    fn test_build_hmac_signature_rejects_invalid_secret() {
        let result =
            build_hmac_signature("not-valid-base64!!!", "1704067200", "GET", "/orders", "");
        assert!(result.is_err());
    }

    #[test]
    fn test_build_l2_headers_populates_all_fields() {
        let secret = URL_SAFE.encode(b"test-secret-key-for-hmac");
        let credentials = ApiCredentials {
            api_key: "test-api-key".to_string(),
            api_secret: secret,
            passphrase: "test-passphrase".to_string(),
        };

        let headers = build_l2_headers(&credentials, "0xABCD1234", "GET", "/orders", "").unwrap();

        assert_eq!(headers.poly_address, "0xABCD1234");
        assert_eq!(headers.poly_api_key, "test-api-key");
        assert_eq!(headers.poly_passphrase, "test-passphrase");
        assert!(!headers.poly_signature.is_empty());
        assert!(!headers.poly_timestamp.is_empty());

        // Timestamp should be a valid number
        let ts: u64 = headers
            .poly_timestamp
            .parse()
            .expect("timestamp should be numeric");
        assert!(ts > 1704067200, "Timestamp should be recent");
    }

    #[test]
    fn test_credentials_debug_hides_secrets() {
        let credentials = ApiCredentials {
            api_key: "my-api-key".to_string(),
            api_secret: "super-secret-value".to_string(),
            passphrase: "my-passphrase".to_string(),
        };

        let debug_output = format!("{:?}", credentials);
        assert!(
            !debug_output.contains("super-secret-value"),
            "Debug should not contain api_secret"
        );
        assert!(
            !debug_output.contains("my-passphrase"),
            "Debug should not contain passphrase"
        );
        assert!(
            debug_output.contains("REDACTED"),
            "Debug should show REDACTED for secrets"
        );
    }
}
