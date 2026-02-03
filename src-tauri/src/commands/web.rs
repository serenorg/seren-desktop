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
fn html_to_markdown(html: &str) -> String {
    html2md::parse_html(html)
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
