import type { Component } from "solid-js";
import { createSignal, onCleanup, onMount } from "solid-js";

interface StreamingMessageProps {
  stream: AsyncGenerator<string>;
  onComplete: (fullContent: string) => void;
  onError?: (error: Error) => void;
  onContentUpdate?: () => void;
}

export const StreamingMessage: Component<StreamingMessageProps> = (props) => {
  const [content, setContent] = createSignal("");
  const [isStreaming, setIsStreaming] = createSignal(true);
  let isCancelled = false;

  const consume = async () => {
    let fullContent = "";
    let hadError = false;
    try {
      for await (const token of props.stream) {
        if (isCancelled) break;
        fullContent += token;
        setContent(fullContent);
        props.onContentUpdate?.();
      }
    } catch (error) {
      hadError = true;
      props.onError?.(error as Error);
    } finally {
      setIsStreaming(false);
      if (!isCancelled && !hadError) {
        props.onComplete(fullContent);
      }
    }
  };

  onMount(() => {
    void consume();
  });

  onCleanup(() => {
    isCancelled = true;
    void props.stream.return?.(undefined);
  });

  return (
    <article class="px-5 py-4 border-b border-[#21262d] bg-transparent">
      <div class="text-sm leading-relaxed text-[#e6edf3] break-words">
        {content()}
        {isStreaming() && (
          <span class="inline-block w-0.5 h-[1em] bg-[#58a6ff] ml-0.5 align-text-bottom animate-[blink_1s_step-end_infinite]" />
        )}
      </div>
    </article>
  );
};
