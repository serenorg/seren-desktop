// ABOUTME: Reusable Solid chat rendering primitives for Seren agent transcripts.
// ABOUTME: Keeps transcript display app-neutral through host-provided classes.

import type { Accessor, JSX } from "solid-js";
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  parseChatInlineText,
  parseChatStructuredText,
} from "./structured-text";

export type {
  ChatInlineTextSegment,
  ChatStructuredTextBlock,
} from "./structured-text";

export type ChatStructuredTextSlot =
  | "root"
  | "heading1"
  | "heading2"
  | "heading3"
  | "unorderedList"
  | "orderedList"
  | "listItem"
  | "quote"
  | "codeBlock"
  | "codeHeader"
  | "codePre"
  | "inlineCode"
  | "strong";

export type ChatStructuredTextClassNames = Partial<
  Record<ChatStructuredTextSlot, string>
>;

export type ChatThinkingStatusSlot =
  | "root"
  | "dots"
  | "dot"
  | "label"
  | "elapsed";

export type ChatThinkingStatusClassNames = Partial<
  Record<ChatThinkingStatusSlot, string>
>;

export interface ChatStructuredTextProps {
  text: string;
  class?: string;
  classNames?: ChatStructuredTextClassNames;
}

export interface ChatThinkingStatusProps {
  words?: readonly string[];
  rotationIntervalMs?: number;
  startTime?: Accessor<number | undefined>;
  showElapsedAfterMs?: number;
  dotClassNames?: readonly string[];
  class?: string;
  classNames?: ChatThinkingStatusClassNames;
}

const DEFAULT_THINKING_WORDS = [
  "Thinking",
  "Reasoning",
  "Analyzing",
  "Checking context",
  "Working",
];

const DEFAULT_ROTATION_INTERVAL_MS = 3000;

type ClassValue = string | false | null | undefined;

function cx(...classes: ClassValue[]): string {
  return classes
    .filter((className): className is string => Boolean(className))
    .join(" ");
}

function ChatInlineText(props: {
  text: string;
  classNames?: ChatStructuredTextClassNames;
}) {
  return (
    <For each={parseChatInlineText(props.text)}>
      {(segment) => {
        if (segment.kind === "code") {
          return (
            <code class={props.classNames?.inlineCode}>{segment.text}</code>
          );
        }
        if (segment.kind === "strong") {
          return (
            <strong class={props.classNames?.strong}>{segment.text}</strong>
          );
        }
        return <>{segment.text}</>;
      }}
    </For>
  );
}

function ChatParagraphText(props: {
  text: string;
  classNames?: ChatStructuredTextClassNames;
}) {
  const lines = () => props.text.split("\n");
  return (
    <For each={lines()}>
      {(line, index) => (
        <>
          <Show when={index() > 0}>
            <br />
          </Show>
          <ChatInlineText text={line} classNames={props.classNames} />
        </>
      )}
    </For>
  );
}

export function ChatStructuredText(props: ChatStructuredTextProps) {
  const blocks = createMemo(() => parseChatStructuredText(props.text));

  return (
    <div class={cx(props.class, props.classNames?.root)}>
      <For each={blocks()}>
        {(block) => {
          if (block.kind === "heading") {
            const className =
              block.level === 1
                ? props.classNames?.heading1
                : block.level === 2
                  ? props.classNames?.heading2
                  : props.classNames?.heading3;
            return (
              <p class={className}>
                <ChatInlineText
                  text={block.text}
                  classNames={props.classNames}
                />
              </p>
            );
          }
          if (block.kind === "unordered-list") {
            return (
              <ul class={props.classNames?.unorderedList}>
                <For each={block.items}>
                  {(item) => (
                    <li class={props.classNames?.listItem}>
                      <ChatInlineText
                        text={item}
                        classNames={props.classNames}
                      />
                    </li>
                  )}
                </For>
              </ul>
            );
          }
          if (block.kind === "ordered-list") {
            return (
              <ol class={props.classNames?.orderedList}>
                <For each={block.items}>
                  {(item) => (
                    <li class={props.classNames?.listItem}>
                      <ChatInlineText
                        text={item}
                        classNames={props.classNames}
                      />
                    </li>
                  )}
                </For>
              </ol>
            );
          }
          if (block.kind === "quote") {
            return (
              <blockquote class={props.classNames?.quote}>
                <ChatParagraphText
                  text={block.text}
                  classNames={props.classNames}
                />
              </blockquote>
            );
          }
          if (block.kind === "code") {
            return (
              <div class={props.classNames?.codeBlock}>
                <Show when={block.language}>
                  <div class={props.classNames?.codeHeader}>
                    {block.language}
                  </div>
                </Show>
                <pre class={props.classNames?.codePre}>
                  <code>{block.text}</code>
                </pre>
              </div>
            );
          }
          return (
            <p>
              <ChatParagraphText
                text={block.text}
                classNames={props.classNames}
              />
            </p>
          );
        }}
      </For>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  return `${seconds}s`;
}

export function ChatThinkingStatus(props: ChatThinkingStatusProps) {
  const words = () =>
    props.words && props.words.length > 0
      ? props.words
      : DEFAULT_THINKING_WORDS;
  // Start deterministic so SSR and the first client render agree; randomize the
  // starting word only after mount (client-only) to avoid a hydration mismatch.
  const [index, setIndex] = createSignal(0);
  const [elapsed, setElapsed] = createSignal(0);

  let wordTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;

  // Declared before onMount because onMount reads it. When a mismatched
  // solid-js instance runs onMount synchronously during render (instead of
  // deferring), a declaration placed after onMount lands in the temporal dead
  // zone and throws a ReferenceError that takes down the whole surface.
  const showElapsedAfterMs = () => props.showElapsedAfterMs ?? 5000;

  onMount(() => {
    setIndex(Math.floor(Math.random() * words().length));
    wordTimer = setInterval(() => {
      setIndex((prev) => (prev + 1) % words().length);
    }, props.rotationIntervalMs ?? DEFAULT_ROTATION_INTERVAL_MS);

    if (props.startTime && Number.isFinite(showElapsedAfterMs())) {
      tickTimer = setInterval(() => {
        const start = props.startTime?.();
        setElapsed(start ? Date.now() - start : 0);
      }, 1000);
    }
  });

  onCleanup(() => {
    if (wordTimer) clearInterval(wordTimer);
    if (tickTimer) clearInterval(tickTimer);
  });

  return (
    <span class={cx(props.class, props.classNames?.root)}>
      <span class={props.classNames?.dots} aria-hidden="true">
        <span class={cx(props.classNames?.dot, props.dotClassNames?.[0])} />
        <span class={cx(props.classNames?.dot, props.dotClassNames?.[1])} />
        <span class={cx(props.classNames?.dot, props.dotClassNames?.[2])} />
      </span>
      <span class={props.classNames?.label}>{words()[index()]}...</span>
      <Show when={elapsed() >= showElapsedAfterMs()}>
        <span class={props.classNames?.elapsed}>
          {formatElapsed(elapsed())}
        </span>
      </Show>
    </span>
  );
}

export type ChatUiElement = JSX.Element;
