// ABOUTME: Provider-runtime log prefix helpers shared by local agent runtimes.
// ABOUTME: Keeps desktop-native logs from inheriting browser-local directory names.

const LOG_TOKEN_RE = /^[a-z0-9][a-z0-9-]*$/;
const FALLBACK_RUNTIME_MODE = "provider-runtime";

function normalizeLogToken(value, fallback) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  return LOG_TOKEN_RE.test(normalized) ? normalized : fallback;
}

export function normalizeRuntimeLogMode(runtimeMode) {
  return normalizeLogToken(runtimeMode, FALLBACK_RUNTIME_MODE);
}

export function providerLogPrefix(providerName, runtimeMode) {
  const runtime = normalizeRuntimeLogMode(runtimeMode);
  const provider = normalizeLogToken(providerName, "");
  return provider ? `[${runtime}][${provider}]` : `[${runtime}]`;
}
