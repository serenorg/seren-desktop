// ABOUTME: Web fetch command for retrieving URL content from public URLs.
// ABOUTME: Converts HTML to markdown for AI readability, no paid publishers required.

use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use serde::{Deserialize, Serialize};

/// Maximum content size in bytes (1MB) to prevent context overflow
const MAX_CONTENT_SIZE: usize = 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
pub struct WebFetchResult {
    pub content: String,
    pub content_type: String,
    pub url: String,
    pub status: u16,
    pub truncated: bool,
}

/// Fetch content from a public URL and convert HTML to markdown.
///
/// # Arguments
/// * `url` - The URL to fetch (must be http or https)
/// * `timeout_ms` - Request timeout in milliseconds (default: 30000)
///
/// # Returns
/// * `WebFetchResult` with content, content_type, final url, and status code
#[tauri::command]
pub async fn web_fetch(url: String, timeout_ms: Option<u64>) -> Result<WebFetchResult, String> {
    // Validate URL
    let parsed_url = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    // Only allow http/https
    if !["http", "https"].contains(&parsed_url.scheme()) {
        return Err("Only HTTP/HTTPS URLs are supported".to_string());
    }

    // Build client with timeout and user agent
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(30000));
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Seren-Desktop/1.0"));

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .default_headers(headers)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Fetch URL
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/plain")
        .to_string();

    // Get the final URL after redirects
    let final_url = response.url().to_string();

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // Convert HTML to markdown if content is HTML
    let raw_content = if content_type.contains("text/html") {
        html_to_markdown(&body)
    } else {
        body
    };

    // Truncate content if too large
    let (content, truncated) = truncate_content(&raw_content, MAX_CONTENT_SIZE);

    // Wrap in content markers for prompt injection protection
    let wrapped_content = wrap_with_markers(&content, &final_url, truncated);

    Ok(WebFetchResult {
        content: wrapped_content,
        content_type,
        url: final_url,
        status,
        truncated,
    })
}

/// Convert HTML to markdown using html2md.
///
/// Strips `<script>`, `<style>`, and `<noscript>` blocks first because
/// `html2md` emits their raw text content otherwise, which floods the
/// `<web_content>` envelope with minified JS / CSS that is unreadable
/// for the model and the user.
fn html_to_markdown(html: &str) -> String {
    let cleaned = strip_scripts_and_styles(html);
    html2md::parse_html(&cleaned)
}

/// Remove `<script>`, `<style>`, and `<noscript>` elements (open tag
/// through close tag, including their content). Case-insensitive,
/// dotall, non-greedy — mirrors how the HTML spec parses raw-text
/// content models for these elements.
///
/// Rust's `regex` crate has no backreferences, so each element gets
/// its own pattern. `RegexSet` would not help here since we need the
/// replacements, not just match detection.
fn strip_scripts_and_styles(html: &str) -> String {
    use std::sync::OnceLock;

    static PATTERNS: OnceLock<[regex::Regex; 3]> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            regex::Regex::new(r"(?is)<script\b[^>]*>.*?</\s*script\s*>")
                .expect("script regex compiles"),
            regex::Regex::new(r"(?is)<style\b[^>]*>.*?</\s*style\s*>")
                .expect("style regex compiles"),
            regex::Regex::new(r"(?is)<noscript\b[^>]*>.*?</\s*noscript\s*>")
                .expect("noscript regex compiles"),
        ]
    });

    let mut out = std::borrow::Cow::Borrowed(html);
    for re in patterns.iter() {
        match re.replace_all(&out, "") {
            std::borrow::Cow::Borrowed(_) => {}
            std::borrow::Cow::Owned(replaced) => out = std::borrow::Cow::Owned(replaced),
        }
    }
    out.into_owned()
}

/// Truncate content to max size, preserving UTF-8 boundaries.
fn truncate_content(content: &str, max_size: usize) -> (String, bool) {
    if content.len() <= max_size {
        return (content.to_string(), false);
    }

    // Find a valid UTF-8 boundary near max_size
    let mut end = max_size;
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }

    (content[..end].to_string(), true)
}

/// Wrap content in XML-style markers to help AI identify untrusted content.
fn wrap_with_markers(content: &str, url: &str, truncated: bool) -> String {
    let truncated_attr = if truncated { " truncated=\"true\"" } else { "" };
    format!(
        "<web_content url=\"{}\" source=\"untrusted\"{}>\n{}\n</web_content>",
        url, truncated_attr, content
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_removes_script_style_and_noscript_with_attributes_and_mixed_case() {
        let html = r#"<html><head>
            <STYLE type="text/css">body{background:#fff}</STYLE>
            <script type="text/javascript">var x=1;function f(){return 2;}</script>
            <NoScript>fallback content</NoScript>
            </head><body><p>Hello world</p>
            <script src="https://cdn.example.com/anti-bot.js">window._csv='challenge';</script>
            </body></html>"#;

        let stripped = strip_scripts_and_styles(html);

        // Tag bodies are gone.
        assert!(!stripped.contains("body{background:#fff}"));
        assert!(!stripped.contains("var x=1"));
        assert!(!stripped.contains("function f()"));
        assert!(!stripped.contains("fallback content"));
        assert!(!stripped.contains("window._csv"));
        // Tags themselves (including attribute payloads) are gone.
        assert!(!stripped.to_lowercase().contains("<script"));
        assert!(!stripped.to_lowercase().contains("<style"));
        assert!(!stripped.to_lowercase().contains("<noscript"));
        // Real page content survives.
        assert!(stripped.contains("Hello world"));
    }

    #[test]
    fn html_to_markdown_drops_inline_css_and_js_keeps_text() {
        // Mirrors the bug repro: a page that ships inline <style> and
        // <script> blocks alongside its actual content.
        let html = r#"<html><head>
            <style>:root{--body-bg:#fff} body{background:#fff}</style>
            <script>(function(){var sctm=false;window.google={};})();</script>
            </head><body>
            <h1>Polymarket geographic restrictions</h1>
            <p>Bermuda is not listed.</p>
            </body></html>"#;

        let md = html_to_markdown(html);

        assert!(!md.contains("--body-bg"), "css token leaked: {md}");
        assert!(!md.contains("sctm"), "inline JS leaked: {md}");
        assert!(!md.contains("window.google"), "inline JS leaked: {md}");
        assert!(md.contains("Polymarket geographic restrictions"));
        assert!(md.contains("Bermuda is not listed"));
    }

    #[test]
    fn wrap_with_markers_preserves_envelope_shape() {
        let wrapped = wrap_with_markers("body", "https://example.test/", false);
        assert_eq!(
            wrapped,
            "<web_content url=\"https://example.test/\" source=\"untrusted\">\nbody\n</web_content>"
        );

        let wrapped_trunc = wrap_with_markers("body", "https://example.test/", true);
        assert!(wrapped_trunc.contains("truncated=\"true\""));
    }
}
