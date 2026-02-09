// ABOUTME: Inline announcement when the orchestrator switches models.
// ABOUTME: Renders a UnifiedMessage of type "transition" as a subtle indicator.

import type { Component } from "solid-js";
import type { UnifiedMessage } from "@/types/conversation";
import "./TransitionAnnouncement.css";

interface TransitionAnnouncementProps {
  message: UnifiedMessage;
}

export const TransitionAnnouncement: Component<TransitionAnnouncementProps> = (
  props,
) => {
  return <div class="transition-announcement">{props.message.content}</div>;
};
