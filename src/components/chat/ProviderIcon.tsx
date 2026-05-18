// ABOUTME: Single-glyph icon for chat providers and external-agent runtimes.
// ABOUTME: Mirrors the unicode glyphs the ThreadSidebar "new thread" launcher
// ABOUTME: uses so pickers and launcher stay visually consistent.

import type { Component } from "solid-js";

interface Props {
  /**
   * Provider or agent identifier — accepts any string so callers can pass
   * unified row values without narrowing first. Unknown ids fall back to a
   * generic glyph.
   */
  provider: string;
  /**
   * Font-size in pixels for the glyph. Defaults to 14 to match the
   * thread-sidebar launcher rows; pickers can drop to 12 for inline
   * badges next to a label.
   */
  size?: number;
  label?: string;
}

/**
 * Single source of truth for the provider glyph mapping. Mirrors the
 * inline emoji `ThreadSidebar` uses in its launcher rows so a user who
 * recognizes a glyph in one surface also recognizes it in the other.
 * `anthropic` and `openai` (bring-your-own-key chat providers, never
 * surfaced in the launcher) borrow their family agent's glyph so the
 * picker doesn't introduce a brand-new mark just for the picker.
 */
const GLYPHS: Record<string, string> = {
  seren: "\u{1F4AC}", // 💬 speech balloon
  "seren-private": "\u{1F512}", // 🔒 lock
  anthropic: "\u{1F916}", // 🤖 robot — Anthropic / Claude family
  "claude-code": "\u{1F916}", // 🤖 robot
  openai: "\u{26A1}", // ⚡ lightning bolt — OpenAI / Codex family
  codex: "\u{26A1}", // ⚡ lightning bolt
  gemini: "\u{2728}", // ✨ sparkles
};

export function providerGlyph(provider: string): string {
  return GLYPHS[provider] ?? "\u{1F4AD}"; // 💭 thought balloon as neutral fallback
}

export const ProviderIcon: Component<Props> = (props) => (
  <span
    aria-label={props.label ?? props.provider}
    style={{
      "font-size": `${props.size ?? 14}px`,
      "line-height": 1,
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
    }}
  >
    {providerGlyph(props.provider)}
  </span>
);
