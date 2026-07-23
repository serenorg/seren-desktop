// ABOUTME: Live check that the credential broker refuses misuse and, with a real key, brokers Seren MCP traffic.
// ABOUTME: Runs the refusal checks with no credential; set SEREN_LIVE_BROKER_API_KEY to add the gateway round trip.
//
// Usage:
//   cargo run --example credential_broker_live --manifest-path src-tauri/Cargo.toml
//   SEREN_LIVE_BROKER_API_KEY=... cargo run --example credential_broker_live \
//     --manifest-path src-tauri/Cargo.toml
//
// Every check runs against the real listener, the real https://mcp.serendb.com,
// and the real https://api.serendb.com. Nothing is stubbed.
//
// Without a key: the broker refuses wrong capabilities, rebound Host
// authorities, disallowed methods, routes outside `publishers/`, encoded
// traversal, and any request after revocation.
//
// With a key: the same capability additionally completes a real MCP
// initialize + tools/list through the broker, while being rejected outright
// when presented straight to the gateway.

use std::time::Duration;

use seren_desktop_lib::credential_broker::PublisherCredentialBroker;

const SESSION_ID: &str = "credential-broker-live-probe";

fn main() -> Result<(), String> {
    // The refusal checks never reach the point of using key material, so they
    // are meaningful with a placeholder. Only the gateway round trip needs a
    // real key.
    let api_key = std::env::var("SEREN_LIVE_BROKER_API_KEY").ok();
    let expires_at = (jiff::Timestamp::now() + jiff::SignedDuration::from_hours(1)).to_string();

    let broker = PublisherCredentialBroker::start()?;
    let endpoints = broker.register(
        SESSION_ID,
        api_key.as_deref().unwrap_or("no-live-key-configured"),
        &expires_at,
    )?;
    println!("broker mcp url: {}", endpoints.mcp_url);
    println!("broker api base: {}", endpoints.api_base_url);
    println!("capability length: {}", endpoints.capability.len());

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;

    if let Some(api_key) = api_key.as_deref() {
        let (session_header, initialize_body) = mcp_post(
            &client,
            &endpoints.mcp_url,
            &endpoints.capability,
            None,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"seren-broker-live","version":"0.1.0"}}}"#,
        )?;
        check("1. initialize reaches the gateway", || {
            initialize_body.contains("serverInfo") || initialize_body.contains("protocolVersion")
        })?;

        if let Some(session) = session_header.as_deref() {
            mcp_post(
                &client,
                &endpoints.mcp_url,
                &endpoints.capability,
                Some(session),
                r#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#,
            )?;
        }

        let (_, tools_body) = mcp_post(
            &client,
            &endpoints.mcp_url,
            &endpoints.capability,
            session_header.as_deref(),
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
        )?;
        check("1b. tools/list returns real gateway tools", || {
            tools_body.contains("list_agent_publishers") || tools_body.contains("\"tools\"")
        })?;
        check("1c. no key material is echoed back to the caller", || {
            !tools_body.contains(api_key)
        })?;
    } else {
        println!("SKIP  1. gateway round trip (SEREN_LIVE_BROKER_API_KEY unset)");
    }

    // The capability is only meaningful to the broker. Presented straight to
    // the gateway it must fail, which is what makes child-env exposure harmless.
    let direct = client
        .post("https://mcp.serendb.com/mcp")
        .bearer_auth(&endpoints.capability)
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .body(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#)
        .send()
        .map_err(|error| error.to_string())?;
    check("4. the capability is rejected by the gateway itself", || {
        direct.status().as_u16() == 401 || direct.status().as_u16() == 403
    })?;

    let route_root = endpoints
        .mcp_url
        .strip_suffix("/mcp")
        .ok_or("broker mcp url has an unexpected shape")?;

    let escape = client
        .get(format!("{route_root}/api/organizations/default/api-keys"))
        .bearer_auth(&endpoints.capability)
        .send()
        .map_err(|error| error.to_string())?;
    check("5. api-key management is outside the brokered namespace", || {
        escape.status().as_u16() == 404
    })?;

    let traversal = client
        .get(format!("{route_root}/api/publishers/x/%2E%2E/%2E%2E/organizations"))
        .bearer_auth(&endpoints.capability)
        .send()
        .map_err(|error| error.to_string())?;
    check("6. encoded traversal out of publishers/ is refused", || {
        traversal.status().as_u16() == 404
    })?;

    let wrong_capability = client
        .post(&endpoints.mcp_url)
        .bearer_auth("not-the-capability")
        .body("{}")
        .send()
        .map_err(|error| error.to_string())?;
    check("7. a wrong capability is refused", || {
        wrong_capability.status().as_u16() == 401
    })?;

    let rebound_host = client
        .post(&endpoints.mcp_url)
        .bearer_auth(&endpoints.capability)
        .header("host", "attacker.example")
        .body("{}")
        .send()
        .map_err(|error| error.to_string())?;
    check("8. a rebound Host authority is refused", || {
        rebound_host.status().as_u16() == 403
    })?;

    let bad_method = client
        .put(&endpoints.mcp_url)
        .bearer_auth(&endpoints.capability)
        .body("{}")
        .send()
        .map_err(|error| error.to_string())?;
    check("9. a method outside the route allowlist is refused", || {
        bad_method.status().as_u16() == 405
    })?;

    broker.revoke_session(SESSION_ID);
    let after_revoke = client
        .post(&endpoints.mcp_url)
        .bearer_auth(&endpoints.capability)
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .body(r#"{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}"#)
        .send()
        .map_err(|error| error.to_string())?;
    check("10. revocation denies the capability immediately", || {
        after_revoke.status().as_u16() == 401
    })?;

    println!("\nAll live credential-broker checks passed.");
    Ok(())
}

fn mcp_post(
    client: &reqwest::blocking::Client,
    url: &str,
    capability: &str,
    session: Option<&str>,
    body: &'static str,
) -> Result<(Option<String>, String), String> {
    let mut request = client
        .post(url)
        .bearer_auth(capability)
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .header("mcp-protocol-version", "2025-06-18")
        .body(body);
    if let Some(session) = session {
        request = request.header("mcp-session-id", session);
    }
    let response = request.send().map_err(|error| error.to_string())?;
    let status = response.status();
    let session_header = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let text = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("brokered MCP request failed: HTTP {status} {text}"));
    }
    Ok((session_header, text))
}

fn check(label: &str, passed: impl Fn() -> bool) -> Result<(), String> {
    if passed() {
        println!("PASS  {label}");
        Ok(())
    } else {
        Err(format!("FAIL  {label}"))
    }
}
