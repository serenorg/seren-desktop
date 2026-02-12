// ABOUTME: Rotating thinking status indicator with varied words.
// ABOUTME: Shows pulsing dot + cycling status text like Claude Code's thinking animation.

import { createSignal, onCleanup, onMount } from "solid-js";

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

export function ThinkingStatus() {
  const [index, setIndex] = createSignal(
    Math.floor(Math.random() * THINKING_WORDS.length),
  );

  let timer: ReturnType<typeof setInterval>;

  onMount(() => {
    timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % THINKING_WORDS.length);
    }, ROTATION_INTERVAL_MS);
  });

  onCleanup(() => clearInterval(timer));

  return (
    <span class="inline-flex items-center gap-2 text-sm text-foreground">
      <span class="inline-flex items-center gap-[3px]">
        <span class="inline-block w-[6px] h-[6px] rounded-full bg-primary thinking-dot thinking-dot-1" />
        <span class="inline-block w-[6px] h-[6px] rounded-full bg-primary thinking-dot thinking-dot-2" />
        <span class="inline-block w-[6px] h-[6px] rounded-full bg-primary thinking-dot thinking-dot-3" />
      </span>
      <span>{THINKING_WORDS[index()]}…</span>
    </span>
  );
}
