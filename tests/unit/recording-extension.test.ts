// ABOUTME: Guards the browser extension scaffold for workflow recording.
// ABOUTME: Keeps event capture bounded and value-redacted before integration.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// The extension scripts are plain (non-module) Chrome scripts. Running them in a
// vm context with stubbed extension globals exposes their top-level `function`
// declarations on the context, so security-critical helpers can be exercised
// behaviorally instead of only matched as source strings.
function loadExtensionScript(source: string): Record<string, unknown> {
  const noop = () => undefined;
  const listener = { addListener: noop };
  const chrome = {
    runtime: { onMessage: listener, sendMessage: noop, lastError: undefined },
    debugger: {
      onEvent: listener,
      attach: noop,
      detach: noop,
      sendCommand: noop,
    },
    action: {
      onClicked: listener,
      setBadgeText: noop,
      setBadgeBackgroundColor: noop,
    },
    tabs: { onRemoved: listener, sendMessage: noop },
  };
  const context: Record<string, unknown> = {
    chrome,
    window: {
      addEventListener: noop,
      CSS: { escape: (value: string) => value },
      location: { origin: "" },
      scrollX: 0,
      scrollY: 0,
    },
    document: { addEventListener: noop },
    URL,
    crypto: { randomUUID: () => "test-id" },
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

interface ElementStub {
  tagName: string;
  innerText: string;
  textContent: string;
  getAttribute(name: string): string | null;
}

function elementStub(
  tagName: string,
  options: {
    attributes?: Record<string, string>;
    innerText?: string;
    textContent?: string;
  } = {},
): ElementStub {
  const attributes = options.attributes ?? {};
  return {
    tagName: tagName.toUpperCase(),
    innerText: options.innerText ?? "",
    textContent: options.textContent ?? options.innerText ?? "",
    getAttribute(name: string): string | null {
      return attributes[name] ?? null;
    },
  };
}

const manifest = JSON.parse(
  readFileSync(resolve("packages/recording-extension/manifest.json"), "utf-8"),
) as {
  manifest_version: number;
  permissions: string[];
  background: { service_worker: string };
  content_scripts: Array<{ js: string[]; matches: string[] }>;
};
const backgroundSource = readFileSync(
  resolve("packages/recording-extension/src/background.js"),
  "utf-8",
);
const contentSource = readFileSync(
  resolve("packages/recording-extension/src/content.js"),
  "utf-8",
);

describe("recording browser extension scaffold", () => {
  it("declares the planned browser trace permissions explicitly", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["activeTab", "debugger", "scripting", "tabs"]),
    );
    expect(manifest.background.service_worker).toBe("src/background.js");
    expect(manifest.content_scripts[0]?.js).toContain("src/content.js");
  });

  it("bounds captured events and coalesces scroll updates", () => {
    expect(backgroundSource).toContain("MAX_TRACE_EVENTS");
    expect(backgroundSource).toContain("session.truncated = true");
    expect(backgroundSource).toContain('previous.type === "scroll"');
    expect(backgroundSource).toContain('event.type === "scroll"');
  });

  it("lets the extension action toggle an active-tab recording session", () => {
    expect(backgroundSource).toContain("chrome.action.onClicked.addListener");
    expect(backgroundSource).toContain("startSession(tab.id)");
    expect(backgroundSource).toContain("stopSession(tab.id)");
    expect(backgroundSource).toContain('text: active ? "REC" : ""');
    expect(backgroundSource).toContain("chrome.action.setBadgeBackgroundColor");
  });

  it("retains the last completed session for bridge retrieval", () => {
    expect(backgroundSource).toContain("completedSessions");
    expect(backgroundSource).toContain("SEREN_RECORDING_LAST_SESSION");
    expect(backgroundSource).toContain("SEREN_RECORDING_SESSION_SNAPSHOT");
    expect(backgroundSource).toContain("serializableSession(sessionForTab(tabId))");
    expect(backgroundSource).toContain("completedSessions.set");
    expect(backgroundSource).toContain("completedSessions.delete(tabId)");
  });

  it("uses the debugger API to capture top-level navigation events", () => {
    expect(backgroundSource).toContain("chrome.debugger.attach");
    expect(backgroundSource).toContain("chrome.debugger.sendCommand");
    expect(backgroundSource).toContain('"Page.enable"');
    expect(backgroundSource).toContain("chrome.debugger.onEvent.addListener");
    expect(backgroundSource).toContain('"Page.frameNavigated"');
    expect(backgroundSource).toContain('type: "nav"');
    expect(backgroundSource).toContain('source: "cdp"');
    expect(backgroundSource).toContain("sanitizeUrl");
    expect(backgroundSource).toContain("debuggerAttached");
    expect(backgroundSource).toContain("debuggerError");
  });

  it("redacts sensitive element names and input values", () => {
    expect(contentSource).toContain("SENSITIVE_PATTERN");
    expect(contentSource).toContain('type === "password"');
    expect(contentSource).toContain('name: sensitive ? "[redacted]"');
    expect(contentSource).toContain('recorded.value = { after: "[redacted]" }');
    expect(contentSource).toContain("event.key.length === 1");
    expect(contentSource).toContain('after: event.key.length === 1 ? "[redacted]"');
  });

  it("exposes a read-only page bridge for approved Seren origins", () => {
    expect(contentSource).toContain("isAllowedBridgeOrigin");
    expect(contentSource).toContain('["1420", "3000", "5173"]');
    expect(contentSource).toContain('hostname === "serendb.com"');
    expect(contentSource).toContain('hostname.endsWith(".serendb.com")');
    expect(contentSource).toContain(
      '"SEREN_RECORDING_EXTENSION_STATUS_REQUEST"',
    );
    expect(contentSource).toContain(
      '"SEREN_RECORDING_EXTENSION_SESSION_SNAPSHOT_REQUEST"',
    );
    expect(contentSource).toContain('"SEREN_RECORDING_STATUS"');
    expect(contentSource).toContain('"SEREN_RECORDING_SESSION_SNAPSHOT"');
    expect(contentSource).toContain(
      'window.addEventListener("message", onBridgeMessage)',
    );
    expect(contentSource).not.toContain(
      '"SEREN_RECORDING_EXTENSION_START_REQUEST"',
    );
    expect(contentSource).not.toContain(
      '"SEREN_RECORDING_EXTENSION_STOP_REQUEST"',
    );
  });

  it("origin-gates the page bridge to Seren app origins", () => {
    const context = loadExtensionScript(contentSource);
    const isAllowed = context.isAllowedBridgeOrigin as (
      origin: string,
    ) => boolean;

    expect(isAllowed("https://app.serendb.com")).toBe(true);
    expect(isAllowed("https://serendb.com")).toBe(true);
    expect(isAllowed("http://localhost:1420")).toBe(true);
    expect(isAllowed("http://127.0.0.1:3000")).toBe(true);

    // Look-alike and embedded hostnames must not pass.
    expect(isAllowed("https://evilserendb.com")).toBe(false);
    expect(isAllowed("https://serendb.com.evil.com")).toBe(false);
    expect(isAllowed("https://evil.com")).toBe(false);
    // Non-dev localhost ports and non-web schemes must not pass.
    expect(isAllowed("http://localhost:9999")).toBe(false);
    expect(isAllowed("file:///etc/passwd")).toBe(false);
    expect(isAllowed("not a url")).toBe(false);
  });

  it("only captures visible text for control-label roles and scrubs PII", () => {
    const context = loadExtensionScript(contentSource);
    const elementName = context.elementName as (
      element: ElementStub,
    ) => string;

    // A button label is a stable control name and may be captured, but a
    // digit run within it must be masked.
    expect(
      elementName(
        elementStub("button", { innerText: "Pay invoice 12345" }),
      ),
    ).toBe("Pay invoice [redacted]");

    // Arbitrary page content (a div) must not have its visible text captured.
    expect(
      elementName(
        elementStub("div", {
          innerText: "Customer SSN 123-45-6789 and balance",
        }),
      ),
    ).toBe("");

    // Explicit accessible labels are still captured (with PII scrubbed),
    // regardless of tag.
    expect(
      elementName(
        elementStub("div", {
          attributes: { "aria-label": "Email user@example.com" },
          innerText: "ignored body text",
        }),
      ),
    ).toBe("Email [redacted]");
  });

  it("strips query and fragment from captured navigation URLs", () => {
    const context = loadExtensionScript(backgroundSource);
    const sanitizeUrl = context.sanitizeUrl as (value: string) => string;

    expect(sanitizeUrl("https://bank.example.com/pay?token=secret#frag")).toBe(
      "https://bank.example.com/pay",
    );
    expect(sanitizeUrl("not a url")).toBe("");
  });

  it("preserves markers while capping high-volume events", () => {
    const context = loadExtensionScript(backgroundSource);
    const appendEvent = context.appendEvent as (
      session: { events: unknown[]; truncated: boolean },
      event: unknown,
    ) => void;
    const session = { events: [] as unknown[], truncated: false };

    for (let index = 0; index < 600; index += 1) {
      appendEvent(session, { type: "click", target: { selector: `#a${index}` } });
    }
    expect(session.truncated).toBe(true);

    const cappedLength = session.events.length;
    appendEvent(session, { type: "marker", markerKind: "important" });
    // Markers must bypass the cap so operator intent is never dropped.
    expect(session.events.length).toBe(cappedLength + 1);
  });
});
