// ABOUTME: Canonical platform detection shared across keybindings, hints, and UI.
// ABOUTME: Case-insensitive with a userAgent fallback so webviews reporting
// ABOUTME: "macOS" (lowercase) for navigator.platform still resolve as Mac.

/**
 * True when running on an Apple platform.
 *
 * `navigator.platform` is deprecated and some webviews (notably WKWebView under
 * Tauri) report the string "macOS" instead of the historical "MacIntel". A
 * case-sensitive `/Mac/` test misses the lowercase form, so we match
 * case-insensitively and fall back to `userAgent` when `platform` is blank.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  if (/mac|iphone|ipad|ipod/i.test(platform)) return true;
  const userAgent = navigator.userAgent ?? "";
  return /mac os x|macintosh|iphone|ipad|ipod/i.test(userAgent);
}
