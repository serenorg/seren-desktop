// ABOUTME: Rotating thinking status indicator with elapsed time counter.
// ABOUTME: Shows pulsing dots, cycling status text, and seconds elapsed since prompt started.

import { ChatThinkingStatus } from "@seren/chat-ui";
import type { Accessor } from "solid-js";

const THINKING_WORDS = [
  "Thinking",
  "Reasoning",
  "Pondering",
  "Analyzing",
  "Considering",
  "Processing",
  "Reflecting",
  "Evaluating",
  "Working",
  "Deliberating",
];

const ROTATION_INTERVAL_MS = 3000;

export function ThinkingStatus(props: {
  startTime?: Accessor<number | undefined>;
}) {
  return (
    <ChatThinkingStatus
      words={THINKING_WORDS}
      rotationIntervalMs={ROTATION_INTERVAL_MS}
      startTime={props.startTime}
      class="inline-flex items-center gap-2 text-[0.93em] text-foreground"
      classNames={{
        dots: "inline-flex items-center gap-[3px]",
        dot: "inline-block w-[6px] h-[6px] rounded-full bg-primary thinking-dot",
        elapsed: "text-muted-foreground",
      }}
      dotClassNames={["thinking-dot-1", "thinking-dot-2", "thinking-dot-3"]}
    />
  );
}
