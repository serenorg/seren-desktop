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
    <span class="inline-flex items-center gap-2 text-sm text-[#8b949e]">
      <span class="inline-block w-2 h-2 rounded-full bg-[#58a6ff] animate-pulse" />
      <span>{THINKING_WORDS[index()]}…</span>
    </span>
  );
}
