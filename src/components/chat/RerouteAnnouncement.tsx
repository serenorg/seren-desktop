// ABOUTME: Inline announcement when the orchestrator reroutes to a different model.
// ABOUTME: Renders a UnifiedMessage of type "reroute" with amber styling.

import type { Component } from "solid-js";
import type { UnifiedMessage } from "@/types/conversation";
import "./RerouteAnnouncement.css";

interface RerouteAnnouncementProps {
  message: UnifiedMessage;
}

export const RerouteAnnouncement: Component<RerouteAnnouncementProps> = (
  props,
) => {
  return (
    <div class="reroute-announcement">
      <span class="reroute-announcement__label">Rerouted</span>
      <span class="reroute-announcement__reason">{props.message.content}</span>
    </div>
  );
};
