// ABOUTME: Compact markdown renderer for readable employee instruction panels.
// ABOUTME: Delegates external links to the system browser instead of the app webview.

/* eslint-disable solid/no-innerhtml */
import { type Component, createMemo, onCleanup } from "solid-js";
import { openExternalLink } from "@/lib/external-link";
import { renderMarkdown } from "@/lib/render-markdown";

interface MarkdownProseProps {
  content: string;
  class?: string;
}

export const MarkdownProse: Component<MarkdownProseProps> = (props) => {
  const renderedHtml = createMemo(() => renderMarkdown(props.content));
  let copyRestoreTimer: ReturnType<typeof setTimeout> | undefined;

  const handleClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const copyBtn = target?.closest(
      ".code-copy-btn",
    ) as HTMLButtonElement | null;
    if (copyBtn) {
      const code = copyBtn.dataset.code;
      if (!code || typeof navigator === "undefined" || !navigator.clipboard) {
        return;
      }

      const textarea = document.createElement("textarea");
      textarea.innerHTML = code;
      const decodedCode = textarea.value;
      const originalText = copyBtn.innerHTML;

      if (copyRestoreTimer) clearTimeout(copyRestoreTimer);
      void navigator.clipboard
        .writeText(decodedCode)
        .then(() => {
          copyBtn.classList.add("copied");
          copyBtn.textContent = "Copied!";
          copyRestoreTimer = setTimeout(() => {
            copyBtn.classList.remove("copied");
            copyBtn.innerHTML = originalText;
          }, 2000);
        })
        .catch(() => {
          // Clipboard permissions can be denied by the host; keep the control inert.
        });
      return;
    }

    const link = target?.closest(".external-link") as HTMLAnchorElement | null;
    if (!link) return;

    event.preventDefault();
    void openExternalLink(link.getAttribute("data-external-url") ?? "");
  };

  onCleanup(() => {
    if (copyRestoreTimer) clearTimeout(copyRestoreTimer);
  });

  return (
    <div
      class={`max-w-[72ch] text-[13px] leading-relaxed text-foreground
        [&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:leading-tight [&_h1]:border-b [&_h1]:border-border-hover [&_h1]:pb-1
        [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:leading-tight [&_h2]:border-b [&_h2]:border-border-medium [&_h2]:pb-1
        [&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:leading-tight
        [&_h4]:mt-4 [&_h4]:mb-1.5 [&_h4]:text-[13px] [&_h4]:font-semibold [&_h4]:leading-tight
        [&_p]:m-0 [&_p]:mb-3
        [&_a]:text-accent [&_a]:no-underline [&_a:hover]:underline
        [&_ul]:m-0 [&_ul]:mb-3 [&_ul]:pl-6 [&_ol]:m-0 [&_ol]:mb-3 [&_ol]:pl-6
        [&_li]:mb-1 [&_li>ul]:mt-1 [&_li>ul]:mb-0 [&_li>ol]:mt-1 [&_li>ol]:mb-0
        [&_blockquote]:m-0 [&_blockquote]:mb-3 [&_blockquote]:border-l-2 [&_blockquote]:border-accent [&_blockquote]:bg-primary/10 [&_blockquote]:px-3 [&_blockquote]:py-2 [&_blockquote]:text-muted-foreground [&_blockquote_p:last-child]:mb-0
        [&_code]:rounded [&_code]:bg-border-medium [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em]
        [&_pre]:m-0 [&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border-hover [&_pre]:bg-background/65 [&_pre]:p-3
        [&_.code-block-wrapper]:mb-3 [&_.code-block-wrapper_pre]:mb-0 [&_.code-block-wrapper_pre]:rounded-t-none [&_.code-block-wrapper_pre]:border-t-0
        [&_.code-block-header]:rounded-t-md [&_.code-block-header]:border [&_.code-block-header]:border-border-hover [&_.code-block-header]:bg-surface-2
        [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[12px] [&_pre_code]:leading-normal
        [&_table]:mb-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border-hover [&_th]:bg-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-border-hover [&_td]:px-2 [&_td]:py-1.5 [&_td]:text-left
        [&_hr]:my-5 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-border-strong
        [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded
        [&_input[type='checkbox']]:mr-2 ${props.class ?? ""}`}
      onClick={handleClick}
      innerHTML={renderedHtml()}
    />
  );
};
