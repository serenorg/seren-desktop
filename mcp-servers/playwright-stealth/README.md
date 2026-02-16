# Playwright Stealth MCP Server

A Model Context Protocol (MCP) server providing stealth browser automation with anti-bot detection bypass capabilities.

## Features

- **Stealth Browser**: Uses `playwright-extra` with `puppeteer-extra-plugin-stealth` to avoid bot detection
- **Anti-Detection Measures**:
  - Removes `navigator.webdriver` flag
  - Mocks plugins array
  - Sets realistic browser headers
  - Configures proper timezone and locale
  - Disables automation-controlled Chrome features
- **Full Playwright API**: All standard Playwright tools (navigate, screenshot, click, fill, etc.)

## Installation

```bash
cd mcp-servers/playwright-stealth
pnpm install
pnpm build
```

## Usage

This MCP server is automatically configured in Seren Desktop. It provides the same tools as the standard Playwright server but with stealth features enabled:

### Available Tools

- `playwright_navigate` - Navigate to a URL with stealth features
- `playwright_screenshot` - Capture screenshots
- `playwright_click` - Click elements
- `playwright_fill` - Fill form inputs
- `playwright_evaluate` - Execute JavaScript
- `playwright_extract_content` - Extract text content
- `playwright_navigate_back` - Go back in history
- `playwright_navigate_forward` - Go forward in history
- `playwright_select` - Select dropdown options
- `playwright_hover` - Hover over elements
- `playwright_press` - Press keyboard keys
- `playwright_close` - Close browser
- `playwright_reset` - Reset page

## How Stealth Works

The stealth plugin applies multiple evasion techniques:

1. **WebDriver Flag**: Sets `navigator.webdriver = false` (normally `true` in automated browsers)
2. **Plugins**: Mocks `navigator.plugins` to appear like a real browser
3. **Languages**: Sets `navigator.languages` to realistic values
4. **Permissions**: Overrides permission queries to behave like a real browser
5. **Chrome Features**: Disables `AutomationControlled` and other automation flags
6. **User Agent**: Uses realistic Chrome user agent string
7. **Viewport**: Sets standard desktop viewport (1920x1080)

## Example Usage

```typescript
// Navigate to a site that blocks bots
await playwright_navigate({ url: "https://example.com" });

// Extract data
const content = await playwright_extract_content();

// Take a screenshot
const screenshot = await playwright_screenshot({ name: "example.png" });
```

## When to Use Stealth

Use this server instead of standard Playwright when:
- Website blocks automated browsers
- Site checks for `navigator.webdriver`
- Bot detection systems are in place
- You need to appear as a regular user

## Technical Details

- **Package**: `@seren/mcp-playwright-stealth`
- **Dependencies**:
  - `playwright-extra` - Playwright with plugin support
  - `puppeteer-extra-plugin-stealth` - Anti-detection plugin
  - `@modelcontextprotocol/sdk` - MCP protocol implementation
- **Transport**: stdio (command-line invocation)

## License

MIT
