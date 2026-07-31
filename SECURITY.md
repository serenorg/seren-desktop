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

// CORRECT - use the native OS credential-store command
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

// CORRECT - use Seren's native OS credential-store boundary
crate::credential_store::store_access_token(&app, &token)?;
```

`tauri-plugin-store` is for non-secret preferences and credential metadata only. Desktop authentication tokens, API keys, and OAuth credentials must use the native OS credential store (macOS Keychain, Windows Credential Manager, or Linux Secret Service). Other secret classes must use their approved secret boundary. Production code must fail closed when that boundary is unavailable; it must not fall back to app-data JSON or browser storage.

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
