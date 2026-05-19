// ABOUTME: Tailwind class invariants for the agent composer toolbar layout.
// ABOUTME: Guards against regression of the Cancel-button-clip bug (#1982).

export const COMPOSER_TOOLBAR_ROOT_CLASSES =
  "flex justify-between items-center gap-2";

export const COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES =
  "flex items-center gap-3 min-w-0 flex-1 overflow-x-auto scrollbar-none";

export const COMPOSER_TOOLBAR_RIGHT_GROUP_CLASSES =
  "flex items-center gap-2 shrink-0";
