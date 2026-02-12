// ABOUTME: Inline announcement when the orchestrator switches models.
// ABOUTME: Renders a UnifiedMessage of type "transition" as a subtle indicator.

import type { Component } from "solid-js";
import type { UnifiedMessage } from "@/types/conversation";

interface TransitionAnnouncementProps {
  message: UnifiedMessage;
}

export const TransitionAnnouncement: Component<TransitionAnnouncementProps> = (
  props,
) => {
  return (
    <div class="flex items-center gap-2 px-3 py-1.5 border-l-2 border-primary text-muted-foreground text-xs leading-normal animate-[fadeInUp_300ms_ease-in]">
      {props.message.content}
    </div>
  );
};
