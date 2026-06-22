const MAX_TRACE_EVENTS = 500;

const sessions = new Map();
const completedSessions = new Map();

function nowMs() {
  return Date.now();
}

function sessionForTab(tabId) {
  return sessions.get(tabId) ?? null;
}

function serializableSession(session) {
  return session
    ? {
        id: session.id,
        startedAtMs: session.startedAtMs,
        events: session.events,
        truncated: session.truncated,
        debuggerAttached: session.debuggerAttached,
        debuggerError: session.debuggerError,
      }
    : null;
}

async function setRecordingBadge(tabId, active) {
  await chrome.action.setBadgeText({
    tabId,
    text: active ? "REC" : "",
  });
  if (active) {
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: "#dc2626",
    });
  }
}

function appendEvent(session, event) {
  if (event.type === "marker") {
    session.events.push(event);
    return;
  }
  if (session.events.length >= MAX_TRACE_EVENTS) {
    session.truncated = true;
    return;
  }
  const previous = session.events.at(-1);
  if (
    previous &&
    previous.type === "scroll" &&
    event.type === "scroll" &&
    previous.target?.selector === event.target?.selector
  ) {
    session.events[session.events.length - 1] = event;
    return;
  }
  session.events.push(event);
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function debuggerAttach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const error = chrome.runtime.lastError?.message ?? null;
      resolve({ ok: !error, error });
    });
  });
}

function debuggerSendCommand(tabId, method, params = undefined) {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, method, params, () => {
      const error = chrome.runtime.lastError?.message ?? null;
      resolve({ ok: !error, error });
    });
  });
}

function debuggerDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      const error = chrome.runtime.lastError?.message ?? null;
      resolve({ ok: !error, error });
    });
  });
}

async function notifyTab(tabId, payload) {
  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    // The content script may not be present on browser/system pages.
  }
}

async function startSession(tabId) {
  const current = sessionForTab(tabId);
  if (current) return current;
  const session = {
    id: crypto.randomUUID(),
    startedAtMs: nowMs(),
    events: [],
    truncated: false,
    debuggerAttached: false,
    debuggerError: null,
  };
  completedSessions.delete(tabId);
  sessions.set(tabId, session);
  const attachResult = await debuggerAttach(tabId);
  if (attachResult.ok) {
    const pageResult = await debuggerSendCommand(tabId, "Page.enable");
    if (pageResult.ok) {
      session.debuggerAttached = true;
    } else {
      session.debuggerError = pageResult.error;
      await debuggerDetach(tabId);
    }
  } else {
    session.debuggerError = attachResult.error;
  }
  await setRecordingBadge(tabId, true);
  await notifyTab(tabId, {
    type: "SEREN_RECORDING_SESSION",
    active: true,
    sessionId: session.id,
    startedAtMs: session.startedAtMs,
  });
  return session;
}

async function stopSession(tabId) {
  const session = sessionForTab(tabId);
  sessions.delete(tabId);
  if (session?.debuggerAttached) await debuggerDetach(tabId);
  if (session) completedSessions.set(tabId, serializableSession(session));
  await setRecordingBadge(tabId, false);
  await notifyTab(tabId, {
    type: "SEREN_RECORDING_SESSION",
    active: false,
  });
  return session;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? message?.tabId;
  if (typeof tabId !== "number") return false;

  if (message?.type === "SEREN_RECORDING_START") {
    void startSession(tabId).then((session) => {
      sendResponse({ ok: true, sessionId: session.id });
    });
    return true;
  }

  if (message?.type === "SEREN_RECORDING_STOP") {
    void stopSession(tabId).then((session) => {
      sendResponse({ ok: true, session: serializableSession(session) });
    });
    return true;
  }

  if (message?.type === "SEREN_RECORDING_EVENT") {
    const session = sessionForTab(tabId);
    if (session) appendEvent(session, message.event);
    sendResponse({ ok: true, active: Boolean(session) });
    return true;
  }

  if (message?.type === "SEREN_RECORDING_STATUS") {
    const session = sessionForTab(tabId);
    sendResponse({
      ok: true,
      active: Boolean(session),
      sessionId: session?.id ?? null,
      eventCount: session?.events.length ?? 0,
      truncated: session?.truncated ?? false,
    });
    return true;
  }

  if (message?.type === "SEREN_RECORDING_LAST_SESSION") {
    sendResponse({
      ok: true,
      session: completedSessions.get(tabId) ?? null,
    });
    return true;
  }

  if (message?.type === "SEREN_RECORDING_SESSION_SNAPSHOT") {
    sendResponse({
      ok: true,
      session:
        serializableSession(sessionForTab(tabId)) ??
        completedSessions.get(tabId) ??
        null,
    });
    return true;
  }

  return false;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (typeof tabId !== "number") return;
  const session = sessionForTab(tabId);
  if (!session?.debuggerAttached) return;
  if (method !== "Page.frameNavigated") return;
  if (params?.frame?.parentId) return;
  const url = sanitizeUrl(params?.frame?.url);
  if (!url) return;
  appendEvent(session, {
    tMs: Math.max(0, nowMs() - session.startedAtMs),
    type: "nav",
    source: "cdp",
    confidence: 0.9,
    url,
    target: {
      role: "page",
      name: url,
      selectors: [],
    },
    redacted: false,
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.id !== "number") return;
  if (sessionForTab(tab.id)) {
    void stopSession(tab.id);
  } else {
    void startSession(tab.id);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = sessionForTab(tabId);
  if (session?.debuggerAttached) void debuggerDetach(tabId);
  sessions.delete(tabId);
  completedSessions.delete(tabId);
  void setRecordingBadge(tabId, false);
});
