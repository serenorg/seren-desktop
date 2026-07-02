// ABOUTME: Helpers for scrolling persisted chat/agent message rows into view.
// ABOUTME: Used by conversation history search hit navigation.

function messageSelector(messageId: string): string {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(messageId)
      : messageId.replace(/["\\]/g, "\\$&");
  return `[data-message-id="${escaped}"]`;
}

export function scrollMessageIntoView(
  container: HTMLElement | undefined,
  messageId: string,
): boolean {
  const element = container?.querySelector<HTMLElement>(
    messageSelector(messageId),
  );
  if (!element) return false;

  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.classList.add(
    "ring-1",
    "ring-primary/70",
    "bg-primary/5",
    "transition-colors",
    "duration-300",
  );
  window.setTimeout(() => {
    element.classList.remove(
      "ring-1",
      "ring-primary/70",
      "bg-primary/5",
      "transition-colors",
      "duration-300",
    );
  }, 1600);

  return true;
}
