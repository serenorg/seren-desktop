// ABOUTME: Loopback HTTP broker that holds real publisher credentials inside the Rust host.
// ABOUTME: Child processes present an opaque per-session capability; only the broker adds Authorization.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

/// Every credential-bearing request leaves the host for exactly one of these
/// two origins. They are compile-time constants so no caller-supplied value can
/// steer a credential to another destination.
const MCP_UPSTREAM_URL: &str = "https://mcp.serendb.com/mcp";
const API_UPSTREAM_ORIGIN: &str = "https://api.serendb.com";

/// Only publisher traffic is brokered. A capability cannot reach organization,
/// billing, or api-key management routes.
const API_UPSTREAM_PREFIX: &str = "publishers/";

const MAX_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS: usize = 64;
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Request headers the broker relays upstream. `authorization`, `cookie`,
/// `host`, and every `proxy-*` header are absent by construction: anything not
/// on this list is dropped rather than forwarded.
const FORWARDED_REQUEST_HEADERS: &[&str] = &[
    "accept",
    "content-type",
    "idempotency-key",
    "last-event-id",
    "mcp-protocol-version",
    "mcp-session-id",
    "payment-signature",
    "user-agent",
    "x-payment",
    "x-seren-oauth-connection-id",
];

/// Response headers relayed back to the child. `set-cookie` and `www-
/// authenticate` are withheld so an upstream challenge cannot teach a child
/// process how to authenticate on its own.
const FORWARDED_RESPONSE_HEADERS: &[&str] = &[
    "cache-control",
    "content-type",
    "mcp-session-id",
    "payment-required",
    "x-request-id",
    "x-seren-reauth-reason",
    "x-seren-reauth-required",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrokeredEndpoints {
    /// Streamable-HTTP MCP endpoint the provider runtime points its Seren MCP
    /// server at.
    pub mcp_url: String,
    /// Base URL the provider runtime resolves publisher API paths against.
    /// Always ends in `/` so `new URL("publishers/x", base)` stays inside it.
    pub api_base_url: String,
    /// Opaque bearer value. Useless off this loopback listener and revoked with
    /// the session.
    pub capability: String,
}

#[derive(Clone)]
struct BrokerRoute {
    session_id: String,
    capability: String,
    api_key: String,
    /// Server-issued lease expiry. Enforced here as well as at the Gateway so a
    /// stale capability stops working even if revocation never ran.
    expires_at: Option<jiff::Timestamp>,
    revoked: Arc<AtomicBool>,
}

struct BrokerInner {
    /// Keyed by the unguessable path segment, so an unknown route is rejected
    /// before any comparison touches key material.
    routes: Mutex<HashMap<String, BrokerRoute>>,
    port: u16,
    in_flight: AtomicUsize,
    client: reqwest::blocking::Client,
}

/// Owns the loopback listener and the real credential for every live session.
/// Cloning shares one listener; the server thread holds a clone for its life.
#[derive(Clone)]
pub struct PublisherCredentialBroker {
    inner: Arc<BrokerInner>,
}

impl PublisherCredentialBroker {
    /// Bind the loopback listener and start accepting. Fails closed: without a
    /// broker no session can be issued a capability, so no credential leaves
    /// the host at all.
    pub fn start() -> Result<Self, String> {
        let server = Server::http("127.0.0.1:0")
            .map_err(|error| format!("Credential broker could not bind loopback: {error}"))?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or("Credential broker did not bind an IP socket")?
            .port();

        // `no_proxy` keeps HTTPS_PROXY / ALL_PROXY out of the credential path:
        // an environment variable must not be able to name the host that
        // receives a bearer token. `redirect::Policy::none()` keeps a 30x from
        // replaying the injected Authorization to a redirect target.
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
            .timeout(None)
            .https_only(true)
            .build()
            .map_err(|error| format!("Credential broker could not build its client: {error}"))?;

        let inner = Arc::new(BrokerInner {
            routes: Mutex::new(HashMap::new()),
            port,
            in_flight: AtomicUsize::new(0),
            client,
        });
        let broker = Self {
            inner: Arc::clone(&inner),
        };

        let server = Arc::new(server);
        thread::spawn(move || {
            log::info!("[credential-broker] Listening on 127.0.0.1:{port}");
            for request in server.incoming_requests() {
                let broker = broker.clone();
                // One thread per request: a long-lived MCP event stream must
                // not stall the next tools/call.
                if thread::Builder::new()
                    .name("seren-credential-broker".to_string())
                    .spawn(move || broker.serve(request))
                    .is_err()
                {
                    log::warn!("[credential-broker] Could not spawn a request thread");
                }
            }
            log::info!("[credential-broker] Stopped");
        });

        Ok(Self { inner })
    }

    /// Publish a capability for one session. The real key stays here; the
    /// caller only ever sees the returned opaque values.
    pub fn register(
        &self,
        session_id: &str,
        api_key: &str,
        expires_at: &str,
    ) -> Result<BrokeredEndpoints, String> {
        let route_id = random_token();
        let capability = random_token();
        let mut routes = self
            .inner
            .routes
            .lock()
            .map_err(|_| "Credential broker route table is poisoned".to_string())?;
        routes.insert(
            route_id.clone(),
            BrokerRoute {
                session_id: session_id.to_string(),
                capability: capability.clone(),
                api_key: api_key.to_string(),
                expires_at: expires_at.parse::<jiff::Timestamp>().ok(),
                revoked: Arc::new(AtomicBool::new(false)),
            },
        );
        Ok(BrokeredEndpoints {
            mcp_url: format!("http://127.0.0.1:{}/{route_id}/mcp", self.inner.port),
            api_base_url: format!("http://127.0.0.1:{}/{route_id}/api/", self.inner.port),
            capability,
        })
    }

    /// Deny the session's capability. Requests already streaming stop at their
    /// next upstream chunk; new requests are refused immediately.
    pub fn revoke_session(&self, session_id: &str) {
        let Ok(mut routes) = self.inner.routes.lock() else {
            log::warn!("[credential-broker] Route table is poisoned; cannot revoke");
            return;
        };
        routes.retain(|_, route| {
            if route.session_id == session_id {
                route.revoked.store(true, Ordering::Release);
                false
            } else {
                true
            }
        });
    }

    /// Deny every capability. Used by logout and app exit.
    pub fn revoke_all(&self) {
        let Ok(mut routes) = self.inner.routes.lock() else {
            log::warn!("[credential-broker] Route table is poisoned; cannot revoke all");
            return;
        };
        for route in routes.values() {
            route.revoked.store(true, Ordering::Release);
        }
        routes.clear();
    }

    fn serve(&self, request: Request) {
        if self.inner.in_flight.fetch_add(1, Ordering::AcqRel) >= MAX_CONCURRENT_REQUESTS {
            self.inner.in_flight.fetch_sub(1, Ordering::AcqRel);
            respond_error(request, 503, "broker_busy");
            return;
        }
        self.handle(request);
        self.inner.in_flight.fetch_sub(1, Ordering::AcqRel);
    }

    fn handle(&self, mut request: Request) {
        // Loopback binding already excludes remote peers; assert it anyway so a
        // future bind-address change cannot silently widen exposure.
        if !request
            .remote_addr()
            .map(|addr| addr.ip().is_loopback())
            .unwrap_or(false)
        {
            respond_error(request, 403, "not_loopback");
            return;
        }

        if !host_header_is_local(&request, self.inner.port) {
            respond_error(request, 403, "host_mismatch");
            return;
        }
        if !origin_header_is_local(&request) {
            respond_error(request, 403, "origin_rejected");
            return;
        }

        let Some(target) = parse_target(request.url()) else {
            respond_error(request, 404, "unknown_route");
            return;
        };

        let route = {
            let Ok(routes) = self.inner.routes.lock() else {
                respond_error(request, 500, "route_table_unavailable");
                return;
            };
            routes.get(&target.route_id).cloned()
        };
        let Some(route) = route else {
            respond_error(request, 401, "capability_revoked");
            return;
        };

        let presented = bearer_capability(&request).unwrap_or_default();
        if !constant_time_eq(presented.as_bytes(), route.capability.as_bytes()) {
            respond_error(request, 401, "capability_rejected");
            return;
        }

        if lease_has_expired(route.expires_at, jiff::Timestamp::now()) {
            respond_error(request, 401, "capability_expired");
            return;
        }

        let method = request.method().clone();
        let upstream = match build_upstream_request(&target, &method) {
            Ok(upstream) => upstream,
            Err(reason) => {
                respond_error(request, 405, reason);
                return;
            }
        };

        let body = match read_body(&mut request) {
            Ok(body) => body,
            Err(reason) => {
                respond_error(request, 413, reason);
                return;
            }
        };

        let mut builder = self
            .inner
            .client
            .request(upstream.method, &upstream.url)
            // The one place a real credential is ever attached, against a URL
            // built from constants rather than from anything the child sent.
            .bearer_auth(&route.api_key)
            // Node's fetch decodes transparently; ask for identity so relayed
            // bytes always match the relayed content-type.
            .header("accept-encoding", "identity");
        for (name, value) in forwarded_request_headers(&request) {
            builder = builder.header(name, value);
        }
        if !body.is_empty() {
            builder = builder.body(body);
        }

        let response = match builder.send() {
            Ok(response) => response,
            Err(error) => {
                log::warn!(
                    "[credential-broker] Upstream request failed: {}",
                    error.without_url()
                );
                respond_error(request, 502, "upstream_unreachable");
                return;
            }
        };

        let status = StatusCode(response.status().as_u16());
        let headers = forwarded_response_headers(&response);
        relay_streamed_response(
            request,
            status,
            headers,
            RevocableReader {
                inner: response,
                revoked: Arc::clone(&route.revoked),
            },
        );
    }
}

/// Writes the response frame by hand instead of through `Response`, because
/// tiny_http's chunked encoder buffers 8 KiB before it touches the socket. An
/// MCP event stream is far smaller than that, so a buffered relay would hold
/// the child's `initialize` result unsent until the upstream closed.
fn relay_streamed_response(
    request: Request,
    status: StatusCode,
    headers: Vec<Header>,
    mut reader: impl Read,
) {
    let mut head = format!("HTTP/1.1 {} {}\r\n", status.0, status.default_reason_phrase());
    for header in &headers {
        let _ = write!(head, "{}: {}\r\n", header.field, header.value.as_str());
    }
    // Self-delimiting framing, and a closed connection afterwards so a stream
    // cut short by revocation cannot leave a half-written body on a reused
    // socket.
    head.push_str("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n");

    let mut writer = request.into_writer();
    if writer.write_all(head.as_bytes()).is_err() || writer.flush().is_err() {
        return;
    }

    let mut buffer = [0u8; 8192];
    loop {
        let filled = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(filled) => filled,
            // Revocation and upstream faults both land here. Drop the socket
            // without a terminating chunk so the child sees a truncated stream
            // rather than a clean, trustworthy end.
            Err(_) => return,
        };
        if write!(writer, "{filled:x}\r\n").is_err()
            || writer.write_all(&buffer[..filled]).is_err()
            || writer.write_all(b"\r\n").is_err()
            || writer.flush().is_err()
        {
            return;
        }
    }
    let _ = writer.write_all(b"0\r\n\r\n");
    let _ = writer.flush();
}

/// Stops relaying upstream bytes once the session's capability is revoked, so a
/// terminated session cannot keep draining an already-authorized event stream.
struct RevocableReader<R: Read> {
    inner: R,
    revoked: Arc<AtomicBool>,
}

impl<R: Read> Read for RevocableReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.revoked.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "credential lease revoked",
            ));
        }
        self.inner.read(buf)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct BrokerTarget {
    route_id: String,
    kind: TargetKind,
    query: String,
}

#[derive(Debug, PartialEq, Eq)]
enum TargetKind {
    Mcp,
    /// Publisher API path relative to `API_UPSTREAM_ORIGIN`, already validated
    /// to start with `publishers/`.
    Api(String),
}

struct UpstreamRequest {
    method: reqwest::Method,
    url: String,
}

fn parse_target(url: &str) -> Option<BrokerTarget> {
    let (path, query) = match url.split_once('?') {
        Some((path, query)) => (path, query.to_string()),
        None => (url, String::new()),
    };
    let mut segments = path.trim_start_matches('/').splitn(3, '/');
    let route_id = segments.next().filter(|value| is_route_token(value))?;
    let kind = match segments.next()? {
        "mcp" => {
            if segments.next().is_some_and(|rest| !rest.is_empty()) {
                return None;
            }
            TargetKind::Mcp
        }
        "api" => TargetKind::Api(validate_publisher_path(segments.next().unwrap_or(""))?),
        _ => return None,
    };
    Some(BrokerTarget {
        route_id: route_id.to_string(),
        kind,
        query,
    })
}

/// The publisher path arrives from the provider runtime, which built it from
/// model-supplied arguments. Keep it inside `/publishers/` and reject anything
/// that could traverse, re-anchor, or smuggle a second request. Percent escapes
/// are checked after decoding, because the upstream normalizes them before
/// routing.
fn validate_publisher_path(path: &str) -> Option<String> {
    if !path.starts_with(API_UPSTREAM_PREFIX) || path.len() > 2048 {
        return None;
    }
    if !path_segments_are_safe(path) {
        return None;
    }
    let decoded = urlencoding::decode(path).ok()?;
    if !decoded.starts_with(API_UPSTREAM_PREFIX) || !path_segments_are_safe(&decoded) {
        return None;
    }
    Some(path.to_string())
}

fn path_segments_are_safe(path: &str) -> bool {
    if path.starts_with('/') || path.contains("//") {
        return false;
    }
    // `\` re-anchors on some routers, `@` and `:` can turn a path into an
    // authority, and controls can smuggle a second request line.
    if path
        .chars()
        .any(|c| c.is_ascii_control() || c == '\\' || c == '@' || c == ':' || c == '?' || c == '#')
    {
        return false;
    }
    path.split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn lease_has_expired(expires_at: Option<jiff::Timestamp>, now: jiff::Timestamp) -> bool {
    expires_at.is_some_and(|expiry| expiry <= now)
}

fn is_route_token(value: &str) -> bool {
    value.len() == 48 && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn build_upstream_request(
    target: &BrokerTarget,
    method: &Method,
) -> Result<UpstreamRequest, &'static str> {
    let allowed: &[Method] = match &target.kind {
        // Streamable HTTP MCP: POST carries JSON-RPC, GET opens the server
        // stream, DELETE ends the MCP session.
        TargetKind::Mcp => &[Method::Post, Method::Get, Method::Delete],
        TargetKind::Api(_) => &[
            Method::Get,
            Method::Post,
            Method::Put,
            Method::Patch,
            Method::Delete,
        ],
    };
    if !allowed.contains(method) {
        return Err("method_not_allowed");
    }
    let upstream_method =
        reqwest::Method::from_bytes(method.as_str().as_bytes()).map_err(|_| "bad_method")?;

    let base = match &target.kind {
        TargetKind::Mcp => MCP_UPSTREAM_URL.to_string(),
        TargetKind::Api(path) => format!("{API_UPSTREAM_ORIGIN}/{path}"),
    };
    let url = if target.query.is_empty() {
        base
    } else {
        format!("{base}?{}", target.query)
    };
    Ok(UpstreamRequest {
        method: upstream_method,
        url,
    })
}

fn read_body(request: &mut Request) -> Result<Vec<u8>, &'static str> {
    if request
        .body_length()
        .is_some_and(|length| length > MAX_REQUEST_BODY_BYTES)
    {
        return Err("body_too_large");
    }
    let mut body = Vec::new();
    request
        .as_reader()
        .take(MAX_REQUEST_BODY_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|_| "body_unreadable")?;
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err("body_too_large");
    }
    Ok(body)
}

fn bearer_capability(request: &Request) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("authorization"))
        .and_then(|header| {
            header
                .value
                .as_str()
                .strip_prefix("Bearer ")
                .map(str::to_string)
        })
}

/// A DNS-rebinding attempt reaches the listener with an attacker hostname in
/// `Host`. Only the two loopback authorities the broker itself hands out are
/// accepted.
fn host_header_is_local(request: &Request, port: u16) -> bool {
    let host = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("host"))
        .map(|header| header.value.as_str().to_string());
    match host {
        None => true,
        Some(host) => host_authority_is_local(&host, port),
    }
}

fn host_authority_is_local(host: &str, port: u16) -> bool {
    let expected = [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ];
    expected.iter().any(|candidate| candidate == host)
}

/// A browser-originated request (the classic rebinding vector) always carries
/// `Origin`. Local MCP clients do not, so anything but a loopback origin is
/// refused.
fn origin_header_is_local(request: &Request) -> bool {
    let Some(origin) = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("origin"))
        .map(|header| header.value.as_str().to_string())
    else {
        return true;
    };
    origin
        .strip_prefix("http://")
        .is_some_and(|authority| authority.split(':').next() == Some("127.0.0.1"))
}

fn forwarded_request_headers(request: &Request) -> Vec<(String, String)> {
    request
        .headers()
        .iter()
        .filter_map(|header| {
            let name = header.field.as_str().as_str().to_ascii_lowercase();
            FORWARDED_REQUEST_HEADERS
                .contains(&name.as_str())
                .then(|| (name, header.value.as_str().to_string()))
        })
        .collect()
}

fn forwarded_response_headers(response: &reqwest::blocking::Response) -> Vec<Header> {
    response
        .headers()
        .iter()
        .filter(|(name, _)| FORWARDED_RESPONSE_HEADERS.contains(&name.as_str()))
        .filter_map(|(name, value)| {
            Header::from_bytes(name.as_str().as_bytes(), value.as_bytes()).ok()
        })
        .collect()
}

fn respond_error(request: Request, status: u16, reason: &str) {
    let body = format!(r#"{{"error":"{reason}"}}"#);
    let response = Response::from_string(body)
        .with_status_code(StatusCode(status))
        .with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("static header is valid"),
        );
    let _ = request.respond(response);
}

fn random_token() -> String {
    let bytes: [u8; 24] = rand::random();
    hex::encode(bytes)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mcp_target(route: &str) -> Option<BrokerTarget> {
        parse_target(&format!("/{route}/mcp"))
    }

    fn route() -> String {
        "a".repeat(48)
    }

    #[test]
    fn broker_rejects_paths_outside_the_two_published_routes() {
        let route = route();
        assert!(parse_target(&format!("/{route}/mcp")).is_some());
        assert!(parse_target(&format!("/{route}/api/publishers/seren-notes/notes")).is_some());
        assert!(parse_target(&format!("/{route}/mcp/extra")).is_none());
        assert!(parse_target(&format!("/{route}/admin")).is_none());
        assert!(parse_target(&format!("/{route}")).is_none());
        assert!(parse_target("/short/mcp").is_none());
    }

    #[test]
    fn broker_denies_an_expired_lease_on_its_own_clock() {
        let now: jiff::Timestamp = "2026-07-23T12:00:00Z".parse().expect("now parses");
        let past: jiff::Timestamp = "2026-07-22T12:00:00Z".parse().expect("past parses");
        let future: jiff::Timestamp = "2026-07-24T12:00:00Z".parse().expect("future parses");
        assert!(lease_has_expired(Some(past), now));
        assert!(!lease_has_expired(Some(future), now));
        assert!(!lease_has_expired(None, now));
    }

    #[test]
    fn broker_confines_publisher_paths_to_the_publishers_namespace() {
        // The organization api-key route is what a stolen credential would go
        // after first; it must not be reachable through the publisher route.
        assert!(validate_publisher_path("organizations/default/api-keys").is_none());
        assert!(validate_publisher_path("publishers/../organizations/default").is_none());
        assert!(validate_publisher_path("publishers/x/..%2F..").is_none());
        assert!(validate_publisher_path("publishers//x").is_none());
        assert!(validate_publisher_path("publishers/evil.com:443/x").is_none());
        assert!(validate_publisher_path("publishers/a@evil.com/x").is_none());
        // An escape that only becomes a traversal after the upstream decodes it.
        assert!(validate_publisher_path("publishers/x/%2E%2E/%2E%2E/organizations").is_none());
        assert!(validate_publisher_path("publishers/x/a%2Fb%2F..%2Forganizations").is_none());
        assert!(validate_publisher_path("publishers/seren-notes/notes").is_some());
        // Ordinary escapes inside a segment stay usable.
        assert!(validate_publisher_path("publishers/seren-storage/objects/my%20file.txt").is_some());
        assert!(validate_publisher_path("publishers/seren-notes/_mcp/tools/list_notes").is_some());
    }

    #[test]
    fn broker_builds_upstream_urls_only_from_constants() {
        let target = mcp_target(&route()).expect("mcp target parses");
        let upstream =
            build_upstream_request(&target, &Method::Post).expect("POST /mcp is allowed");
        assert_eq!(upstream.url, MCP_UPSTREAM_URL);

        let api = parse_target(&format!("/{}/api/publishers/seren-notes/notes", route()))
            .expect("api target parses");
        let upstream = build_upstream_request(&api, &Method::Get).expect("GET publisher allowed");
        assert_eq!(
            upstream.url,
            "https://api.serendb.com/publishers/seren-notes/notes"
        );
    }

    #[test]
    fn broker_rejects_methods_outside_each_route_allowlist() {
        let target = mcp_target(&route()).expect("mcp target parses");
        assert!(build_upstream_request(&target, &Method::Put).is_err());
        assert!(build_upstream_request(&target, &Method::Get).is_ok());
        assert!(build_upstream_request(&target, &Method::Delete).is_ok());
    }

    #[test]
    fn broker_rejects_non_loopback_host_authorities() {
        assert!(host_authority_is_local("127.0.0.1:8000", 8000));
        assert!(host_authority_is_local("localhost:8000", 8000));
        assert!(!host_authority_is_local("attacker.example:8000", 8000));
        // A rebound name resolving to 127.0.0.1 still carries its own authority.
        assert!(!host_authority_is_local("127.0.0.1.nip.io:8000", 8000));
        assert!(!host_authority_is_local("127.0.0.1:9999", 8000));
    }

    #[test]
    fn broker_never_relays_authorization_from_a_child_process() {
        assert!(!FORWARDED_REQUEST_HEADERS.contains(&"authorization"));
        assert!(!FORWARDED_REQUEST_HEADERS.contains(&"cookie"));
        assert!(!FORWARDED_REQUEST_HEADERS.contains(&"host"));
        assert!(
            !FORWARDED_REQUEST_HEADERS
                .iter()
                .any(|name| name.starts_with("proxy-"))
        );
        assert!(!FORWARDED_RESPONSE_HEADERS.contains(&"www-authenticate"));
        assert!(!FORWARDED_RESPONSE_HEADERS.contains(&"set-cookie"));
    }

    #[test]
    fn broker_capabilities_are_unique_and_compared_in_constant_time() {
        assert_ne!(random_token(), random_token());
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
