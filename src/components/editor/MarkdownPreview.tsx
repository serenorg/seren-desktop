// ABOUTME: Markdown preview pane for rendering markdown files.
// ABOUTME: Displays rendered HTML with syntax highlighting for code blocks.

/* eslint-disable solid/no-innerhtml */
import { type Component, createMemo } from "solid-js";
import { renderMarkdown } from "@/lib/render-markdown";
import "highlight.js/styles/github-dark.css";

interface MarkdownPreviewProps {
  content: string;
}

export const MarkdownPreview: Component<MarkdownPreviewProps> = (props) => {
  const renderedHtml = createMemo(() => renderMarkdown(props.content));

  return (
    <div class="flex flex-col h-full bg-[rgba(15,23,42,0.85)] border-l border-[rgba(148,163,184,0.25)]">
      <div class="flex items-center px-4 py-2 border-b border-[rgba(148,163,184,0.15)] bg-popover">
        <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview</span>
      </div>
      <div
        class="flex-1 p-6 overflow-y-auto text-foreground leading-relaxed
          [&_h1]:mt-6 [&_h1]:mb-2 [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:leading-tight [&_h1]:border-b [&_h1]:border-[rgba(148,163,184,0.2)] [&_h1]:pb-1
          [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:leading-tight [&_h2]:border-b [&_h2]:border-[rgba(148,163,184,0.15)] [&_h2]:pb-1
          [&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:leading-tight
          [&_h4]:mt-6 [&_h4]:mb-2 [&_h4]:text-base [&_h4]:font-semibold [&_h4]:leading-tight
          [&_p]:m-0 [&_p]:mb-4
          [&_a]:text-accent [&_a]:no-underline [&_a:hover]:underline
          [&_ul]:m-0 [&_ul]:mb-4 [&_ul]:pl-8 [&_ol]:m-0 [&_ol]:mb-4 [&_ol]:pl-8
          [&_li]:mb-1 [&_li>ul]:mt-1 [&_li>ul]:mb-0 [&_li>ol]:mt-1 [&_li>ol]:mb-0
          [&_blockquote]:m-0 [&_blockquote]:mb-4 [&_blockquote]:py-2 [&_blockquote]:px-4 [&_blockquote]:border-l-4 [&_blockquote]:border-accent [&_blockquote]:bg-[rgba(99,102,241,0.1)] [&_blockquote]:text-muted-foreground [&_blockquote_p:last-child]:mb-0
          [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:py-0.5 [&_code]:px-1.5 [&_code]:bg-[rgba(148,163,184,0.15)] [&_code]:rounded
          [&_pre]:m-0 [&_pre]:mb-4 [&_pre]:p-4 [&_pre]:bg-[rgba(15,23,42,0.65)] [&_pre]:border [&_pre]:border-[rgba(148,163,184,0.2)] [&_pre]:rounded-lg [&_pre]:overflow-x-auto
          [&_pre_code]:p-0 [&_pre_code]:bg-transparent [&_pre_code]:text-[0.85rem] [&_pre_code]:leading-normal
          [&_table]:w-full [&_table]:m-0 [&_table]:mb-4 [&_table]:border-collapse
          [&_th]:py-2 [&_th]:px-4 [&_th]:border [&_th]:border-[rgba(148,163,184,0.2)] [&_th]:text-left [&_th]:bg-[rgba(148,163,184,0.1)] [&_th]:font-semibold
          [&_td]:py-2 [&_td]:px-4 [&_td]:border [&_td]:border-[rgba(148,163,184,0.2)] [&_td]:text-left
          [&_tr:nth-child(even)]:bg-[rgba(148,163,184,0.05)]
          [&_hr]:my-8 [&_hr]:border-none [&_hr]:border-t [&_hr]:border-[rgba(148,163,184,0.25)]
          [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded
          [&_input[type='checkbox']]:mr-2"
        innerHTML={renderedHtml()}
      />
    </div>
  );
};
