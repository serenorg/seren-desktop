// ABOUTME: Minimal inline icons for recording surfaces (no icon-lib dependency).
// ABOUTME: 14px stroked glyphs that inherit currentColor for tinting.

import type { JSX } from "solid-js";

function Glyph(props: { children: JSX.Element; label?: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props.label ? undefined : "true"}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      class="shrink-0"
    >
      {props.children}
    </svg>
  );
}

export function FilmIcon() {
  return (
    <Glyph>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </Glyph>
  );
}

export function RevealIcon() {
  return (
    <Glyph>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    </Glyph>
  );
}

export function TrashIcon() {
  return (
    <Glyph>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </Glyph>
  );
}

export function CloseIcon() {
  return (
    <Glyph>
      <path d="M6 6l12 12M18 6 6 18" />
    </Glyph>
  );
}

export function CheckIcon() {
  return (
    <Glyph>
      <path d="M5 13l4 4L19 7" />
    </Glyph>
  );
}

export function SparkIcon() {
  return (
    <Glyph>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </Glyph>
  );
}
