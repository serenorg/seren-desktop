import type { Component } from "solid-js";
import { createSignal, onCleanup, onMount } from "solid-js";
import "./StreamingMessage.css";

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
    <article class="chat-message assistant streaming">
      <div class="message-content">
        {content()}
        {isStreaming() && <span class="streaming-cursor" />}
      </div>
    </article>
  );
};
