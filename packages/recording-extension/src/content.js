const SENSITIVE_PATTERN =
  /(password|passcode|secret|token|api[_-]?key|authorization|cookie|session|credit|card|ssn|social)/i;
const BRIDGE_STATUS_REQUEST = "SEREN_RECORDING_EXTENSION_STATUS_REQUEST";
const BRIDGE_STATUS_RESPONSE = "SEREN_RECORDING_EXTENSION_STATUS_RESPONSE";
const BRIDGE_SESSION_SNAPSHOT_REQUEST =
  "SEREN_RECORDING_EXTENSION_SESSION_SNAPSHOT_REQUEST";
const BRIDGE_SESSION_SNAPSHOT_RESPONSE =
  "SEREN_RECORDING_EXTENSION_SESSION_SNAPSHOT_RESPONSE";

let activeSession = null;

function elapsedMs() {
  if (!activeSession) return 0;
  return Math.max(0, Date.now() - activeSession.startedAtMs);
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function elementRole(element) {
  return (
    element.getAttribute("role") ||
    element.getAttribute("type") ||
    element.tagName.toLowerCase()
  );
}

function elementName(element) {
  const label =
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("alt") ||
    element.getAttribute("placeholder") ||
    element.innerText ||
    element.textContent ||
    "";
  return label.replace(/\s+/g, " ").trim().slice(0, 120);
}

function isSensitiveElement(element) {
  const type = element.getAttribute("type") ?? "";
  const name = [
    type,
    element.getAttribute("name"),
    element.getAttribute("id"),
    element.getAttribute("autocomplete"),
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
  ]
    .filter(Boolean)
    .join(" ");
  return type === "password" || SENSITIVE_PATTERN.test(name);
}

function selectorFor(element) {
  if (element.id) return `#${cssEscape(element.id)}`;
  const dataSelector = ["data-testid", "data-test", "data-cy"]
    .map((name) => {
      const value = element.getAttribute(name);
      return value ? `[${name}="${cssEscape(value)}"]` : null;
    })
    .find(Boolean);
  if (dataSelector) return dataSelector;
  const tag = element.tagName.toLowerCase();
  const name = element.getAttribute("name");
  if (name) return `${tag}[name="${cssEscape(name)}"]`;
  return tag;
}

function targetFromEventTarget(target) {
  const element =
    target instanceof Element ? target : (target?.parentElement ?? null);
  if (!element) return null;
  const sensitive = isSensitiveElement(element);
  return {
    role: elementRole(element),
    name: sensitive ? "[redacted]" : elementName(element),
    selector: selectorFor(element),
    selectors: [selectorFor(element)],
    redacted: sensitive,
  };
}

function sendEvent(event) {
  if (!activeSession) return;
  chrome.runtime.sendMessage({
    type: "SEREN_RECORDING_EVENT",
    event,
  });
}

function isAllowedBridgeOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    if (
      (hostname === "localhost" || hostname === "127.0.0.1") &&
      ["1420", "3000", "5173"].includes(url.port)
    ) {
      return true;
    }
    return hostname === "serendb.com" || hostname.endsWith(".serendb.com");
  } catch {
    return false;
  }
}

function requestBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError?.message ?? null;
      resolve({
        ok: !error && response?.ok !== false,
        error,
        response: response ?? null,
      });
    });
  });
}

async function onBridgeMessage(event) {
  if (event.source !== window) return;
  if (!isAllowedBridgeOrigin(event.origin)) return;
  const message = event.data;
  if (!message || typeof message !== "object") return;
  const requestId =
    typeof message.requestId === "string" ? message.requestId : null;
  if (message.type === BRIDGE_STATUS_REQUEST) {
    const result = await requestBackground({ type: "SEREN_RECORDING_STATUS" });
    window.postMessage(
      {
        type: BRIDGE_STATUS_RESPONSE,
        requestId,
        ok: result.ok,
        error: result.error,
        status: result.response,
      },
      event.origin,
    );
    return;
  }
  if (message.type === BRIDGE_SESSION_SNAPSHOT_REQUEST) {
    const result = await requestBackground({
      type: "SEREN_RECORDING_SESSION_SNAPSHOT",
    });
    window.postMessage(
      {
        type: BRIDGE_SESSION_SNAPSHOT_RESPONSE,
        requestId,
        ok: result.ok,
        error: result.error,
        session: result.response?.session ?? null,
      },
      event.origin,
    );
  }
}

function baseEvent(type, target) {
  const eventTarget = targetFromEventTarget(target);
  return {
    tMs: elapsedMs(),
    type,
    source: "browser_dom",
    confidence: 0.8,
    target: eventTarget
      ? {
          role: eventTarget.role,
          name: eventTarget.name,
          selector: eventTarget.selector,
          selectors: eventTarget.selectors,
        }
      : undefined,
    redacted: Boolean(eventTarget?.redacted),
    redactionReason: eventTarget?.redacted ? "sensitive_element" : undefined,
  };
}

function onClick(event) {
  sendEvent(baseEvent("click", event.target));
}

function onFocus(event) {
  sendEvent(baseEvent("focus", event.target));
}

function onInput(event) {
  const recorded = baseEvent("input", event.target);
  recorded.value = { after: "[redacted]" };
  recorded.redacted = true;
  recorded.redactionReason = "input_value";
  sendEvent(recorded);
}

function onKeyDown(event) {
  const recorded = baseEvent("key", event.target);
  recorded.value = {
    after: event.key.length === 1 ? "[redacted]" : event.key,
  };
  recorded.redacted = event.key.length === 1 || recorded.redacted;
  recorded.redactionReason =
    event.key.length === 1 ? "key_value" : recorded.redactionReason;
  sendEvent(recorded);
}

function onScroll(event) {
  const recorded = baseEvent("scroll", event.target);
  recorded.value = {
    after: JSON.stringify({
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
    }),
  };
  sendEvent(recorded);
}

function setActiveSession(payload) {
  activeSession =
    payload.active && payload.sessionId
      ? {
          id: payload.sessionId,
          startedAtMs: payload.startedAtMs ?? Date.now(),
        }
      : null;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SEREN_RECORDING_SESSION") {
    setActiveSession(message);
  }
});

chrome.runtime.sendMessage({ type: "SEREN_RECORDING_STATUS" }, (response) => {
  if (response?.active && response.sessionId) {
    setActiveSession({
      active: true,
      sessionId: response.sessionId,
      startedAtMs: Date.now(),
    });
  }
});

document.addEventListener("click", onClick, true);
document.addEventListener("focus", onFocus, true);
document.addEventListener("input", onInput, true);
document.addEventListener("keydown", onKeyDown, true);
document.addEventListener("scroll", onScroll, true);
window.addEventListener("message", onBridgeMessage);
