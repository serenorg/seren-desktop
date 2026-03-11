// ABOUTME: Rotating thinking status indicator with elapsed time counter.
// ABOUTME: Shows pulsing dots, cycling status text, and seconds elapsed since prompt started.

import {
  type Accessor,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

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

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  return `${seconds}s`;
}

export function ThinkingStatus(props: {
  startTime?: Accessor<number | undefined>;
}) {
  const [index, setIndex] = createSignal(
    Math.floor(Math.random() * THINKING_WORDS.length),
  );
  const [elapsed, setElapsed] = createSignal(0);

  let wordTimer: ReturnType<typeof setInterval>;
  let tickTimer: ReturnType<typeof setInterval>;

  onMount(() => {
    wordTimer = setInterval(() => {
      setIndex((prev) => (prev + 1) % THINKING_WORDS.length);
    }, ROTATION_INTERVAL_MS);

    tickTimer = setInterval(() => {
      const start = props.startTime?.();
      setElapsed(start ? Date.now() - start : 0);
    }, 1000);
  });

  onCleanup(() => {
    clearInterval(wordTimer);
    clearInterval(tickTimer);
  });

  return (
    <span class="inline-flex items-center gap-2 text-sm text-foreground">
      <span class="inline-flex items-center gap-[3px]">
        <span class="inline-block w-[6px] h-[6px] rounded-full bg-primary thinking-dot thinking-dot-1" />
        <span class="inline-block w-[6px] h-[6px] rounded-full bg-primary thinking-dot thinking-dot-2" />
        <span class="inline-block w-[6px] h-[6px] rounded-full bg-primary thinking-dot thinking-dot-3" />
      </span>
      <span>{THINKING_WORDS[index()]}…</span>
      <Show when={elapsed() >= 5000}>
        <span class="text-muted-foreground">{formatElapsed(elapsed())}</span>
      </Show>
    </span>
  );
}
