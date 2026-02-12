// ABOUTME: Inline announcement when the orchestrator reroutes to a different model.
// ABOUTME: Renders a UnifiedMessage of type "reroute" with amber styling.

import type { Component } from "solid-js";
import type { UnifiedMessage } from "@/types/conversation";

interface RerouteAnnouncementProps {
  message: UnifiedMessage;
}

export const RerouteAnnouncement: Component<RerouteAnnouncementProps> = (
  props,
) => {
  return (
    <div class="flex items-center gap-2 px-3 py-1.5 border-l-2 border-warning text-warning text-xs leading-normal animate-[fadeInUp_300ms_ease-in]">
      <span class="font-semibold whitespace-nowrap">Rerouted</span>
      <span class="text-muted-foreground">{props.message.content}</span>
    </div>
  );
};
