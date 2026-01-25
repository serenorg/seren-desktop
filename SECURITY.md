# Security Policy

## Reporting a Vulnerability

**Do NOT open a public issue for security vulnerabilities.**

Email: security@serendb.com

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will respond within 48 hours.

## Security Requirements

All contributions must follow these rules:

### 1. No Hardcoded Secrets

```typescript
// WRONG - never do this
const API_KEY = "sk_live_abc123";

// CORRECT - use Tauri secure storage
const apiKey = await invoke("get_api_key");
```

### 2. Sanitize User Input

```typescript
// WRONG - XSS vulnerability
element.innerHTML = userInput;

// CORRECT - use textContent
element.textContent = userInput;

// CORRECT - if you need HTML formatting
import { escapeHtml } from "@/lib/escape-html";
element.innerHTML = escapeHtml(userInput);
```

### 3. Use HTTPS Only

```typescript
// WRONG
fetch("http://api.serendb.com/...");

// CORRECT
fetch("https://api.serendb.com/...");
```

### 4. Validate URLs

```typescript
// WRONG - allows file:// and javascript:
window.open(userProvidedUrl);

// CORRECT - validate protocol
const url = new URL(userProvidedUrl);
if (url.protocol !== "https:" && url.protocol !== "http:") {
  throw new Error("Only HTTPS URLs allowed");
}
```

### 5. Secure Token Storage

```rust
// WRONG - plaintext storage
std::fs::write("token.txt", token);

// CORRECT - use Tauri secure storage
use tauri_plugin_store::StoreExt;
let store = app.store("auth.json")?;
store.set("token", serde_json::json!(token));
store.save()?;
```

### 6. Scrub PII from Error Reports

Before sending any error data to telemetry, always use the `scrubSensitive()` function to remove:

- API keys
- Email addresses
- File paths with usernames
- UUIDs
- Bearer tokens

## Pre-Commit Checklist

Before every commit, verify:

- [ ] No API keys, tokens, or passwords in code
- [ ] No hardcoded URLs to internal services
- [ ] User input is sanitized before display
- [ ] External URLs are validated
- [ ] Error messages don't leak sensitive info

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |
