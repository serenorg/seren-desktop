// ABOUTME: Pure positioning helper for the floating meeting recording controls.
// ABOUTME: Keeps default placement testable without importing Solid TSX.

export const DEFAULT_EDGE_INSET = 16;
export const DEFAULT_COMPOSER_GAP = 12;
export const DEFAULT_TITLEBAR_HEIGHT = 40;

export interface Position {
  x: number;
  y: number;
}

export interface RecordingIndicatorPlacementInput {
  viewportWidth: number;
  viewportHeight: number;
  indicatorWidth: number;
  indicatorHeight: number;
  composerTop: number | null;
  titlebarHeight?: number;
}

export function defaultRecordingIndicatorPosition(
  input: RecordingIndicatorPlacementInput,
): Position {
  const safeTop =
    (input.titlebarHeight ?? DEFAULT_TITLEBAR_HEIGHT) + DEFAULT_COMPOSER_GAP;
  const maxX = Math.max(0, input.viewportWidth - input.indicatorWidth);
  const maxY = Math.max(0, input.viewportHeight - input.indicatorHeight);
  const preferredX =
    input.viewportWidth - input.indicatorWidth - DEFAULT_EDGE_INSET;
  const bottomRightY =
    input.viewportHeight - input.indicatorHeight - DEFAULT_EDGE_INSET;
  const composerSafeY =
    input.composerTop === null
      ? null
      : input.composerTop - input.indicatorHeight - DEFAULT_COMPOSER_GAP;
  const preferredY =
    composerSafeY !== null && composerSafeY >= safeTop
      ? composerSafeY
      : input.composerTop !== null
        ? safeTop
        : bottomRightY;

  return {
    x: Math.min(Math.max(DEFAULT_EDGE_INSET, preferredX), maxX),
    y: Math.min(Math.max(0, preferredY), maxY),
  };
}
