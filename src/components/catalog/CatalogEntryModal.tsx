// ABOUTME: Create / edit modal for an agent catalog entry.
// ABOUTME: Identity fields (namespace/name/version/kind) are locked when editing.

import {
  type Component,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  agentCatalog,
  type CatalogEntry,
  type CatalogEntryKind,
} from "@/services/agent-catalog";

const KIND_OPTIONS: { value: CatalogEntryKind; label: string }[] = [
  { value: "agent", label: "Agent" },
  { value: "skill", label: "Skill" },
  { value: "mcp_server", label: "MCP server" },
  { value: "prompt", label: "Prompt" },
  { value: "runtime_policy", label: "Runtime policy" },
];

type Mode = "create" | "edit";

interface CatalogEntryModalProps {
  organizationId: string;
  entry?: CatalogEntry;
  onClose: () => void;
  onSaved: (entry: CatalogEntry) => void;
}

function parseJsonOrFallback(value: string, fallback: unknown): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function stringifyJsonOrFallback(value: unknown, fallback: unknown): string {
  const candidate = value ?? fallback;
  try {
    const json = JSON.stringify(candidate, null, 2);
    return typeof json === "string" ? json : JSON.stringify(fallback, null, 2);
  } catch {
    return JSON.stringify(fallback, null, 2);
  }
}

export const CatalogEntryModal: Component<CatalogEntryModalProps> = (props) => {
  const mode = (): Mode => (props.entry ? "edit" : "create");

  const [namespace, setNamespace] = createSignal(
    props.entry?.namespace ?? "default",
  );
  const [name, setName] = createSignal(props.entry?.name ?? "");
  const [version, setVersion] = createSignal(props.entry?.version ?? "");
  const [tag, setTag] = createSignal(props.entry?.tag ?? "");
  const [kind, setKind] = createSignal<CatalogEntryKind>(
    props.entry?.kind ?? "agent",
  );
  const [description, setDescription] = createSignal(
    props.entry?.description ?? "",
  );
  const [category, setCategory] = createSignal(props.entry?.category ?? "");
  const [deprecated, setDeprecated] = createSignal(
    props.entry?.deprecated ?? false,
  );
  const [labelsText, setLabelsText] = createSignal(
    props.entry ? stringifyJsonOrFallback(props.entry.labels, {}) : "{}",
  );
  const [sourceText, setSourceText] = createSignal(
    props.entry
      ? stringifyJsonOrFallback(props.entry.source, { type: "inline" })
      : '{"type": "inline"}',
  );

  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const modalId = createUniqueId();
  const titleId = `catalog-entry-modal-title-${modalId}`;
  const submitReasonId = `catalog-entry-submit-reason-${modalId}`;

  const labelsParsed = createMemo(() => parseJsonOrFallback(labelsText(), {}));
  const sourceParsed = createMemo(() => parseJsonOrFallback(sourceText(), {}));

  const submitReason = createMemo((): string | null => {
    if (mode() === "create") {
      if (name().trim() === "") return "Name is required.";
      if (version().trim() === "") return "Version is required.";
    }
    if (labelsParsed() === null) return "Labels must be valid JSON.";
    if (sourceParsed() === null) return "Source must be valid JSON.";
    return null;
  });

  const canSubmit = createMemo(() => !submitting() && submitReason() === null);

  const handleSubmit = async () => {
    if (!canSubmit()) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode() === "create") {
        const entry = await agentCatalog.create(props.organizationId, {
          namespace: namespace().trim() || undefined,
          name: name().trim(),
          version: version().trim(),
          tag: tag().trim() || undefined,
          kind: kind(),
          description: description().trim() || undefined,
          category: category().trim() || undefined,
          source: sourceParsed() as Record<string, unknown> | undefined,
          labels: labelsParsed() as Record<string, unknown> | undefined,
          deprecated: deprecated(),
        });
        props.onSaved(entry);
      } else {
        const existing = props.entry;
        if (!existing) throw new Error("missing entry");
        const tagValue = tag().trim();
        const descriptionValue = description().trim();
        const categoryValue = category().trim();
        // Treat null and empty string as equivalent so "no-op save" does not
        // dirty-write blank strings into nullable text columns.
        const sameText = (next: string, current: string | null | undefined) =>
          next === (current ?? "");
        const labelsValue = labelsParsed();
        const sourceValue = sourceParsed();
        const labelsChanged =
          JSON.stringify(labelsValue ?? {}) !==
          JSON.stringify(existing.labels ?? {});
        const sourceChanged =
          JSON.stringify(sourceValue ?? {}) !==
          JSON.stringify(existing.source ?? {});
        const entry = await agentCatalog.update(
          props.organizationId,
          existing.id,
          {
            tag: tagValue || undefined,
            clear_tag: tagValue === "" && Boolean(existing.tag),
            description: sameText(descriptionValue, existing.description)
              ? undefined
              : descriptionValue || undefined,
            category: sameText(categoryValue, existing.category)
              ? undefined
              : categoryValue || undefined,
            clear_category: categoryValue === "" && Boolean(existing.category),
            labels: labelsChanged
              ? (labelsValue as Record<string, unknown> | undefined)
              : undefined,
            source: sourceChanged
              ? (sourceValue as Record<string, unknown> | undefined)
              : undefined,
            deprecated:
              deprecated() === existing.deprecated ? undefined : deprecated(),
          },
        );
        props.onSaved(entry);
      }
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  let dialogRef: HTMLDivElement | undefined;
  let lastFocusedBeforeOpen: HTMLElement | null = null;

  const focusableSelector =
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const isVisibleFocusable = (el: HTMLElement): boolean => {
    if (el.closest("[hidden], [aria-hidden='true']")) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    return el.getClientRects().length > 0;
  };

  const focusableElements = (): HTMLElement[] => {
    if (!dialogRef) return [];
    return Array.from(
      dialogRef.querySelectorAll<HTMLElement>(focusableSelector),
    ).filter(isVisibleFocusable);
  };

  // Escape closes the modal unless a save is in flight (matches the click
  // outside guard so partial writes can't be abandoned). Tab/Shift+Tab cycle
  // focus within the modal so keyboard users cannot tab into background UI.
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !submitting()) {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef) return;
    const focusables = focusableElements();
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || !dialogRef.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !dialogRef.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  };

  onMount(() => {
    lastFocusedBeforeOpen = document.activeElement as HTMLElement | null;
    window.addEventListener("keydown", handleKeyDown);
    // Focus the first input on open so keyboard users land inside the modal.
    queueMicrotask(() => focusableElements()[0]?.focus());
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown);
    // Restore focus to whatever the user was on before opening the modal so
    // keyboard navigation resumes from the trigger.
    lastFocusedBeforeOpen?.focus?.();
  });

  return (
    <div
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_0.15s_ease-out]"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting()) {
          props.onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        ref={dialogRef}
        class="bg-popover border border-border rounded-lg w-[640px] max-w-[92vw] max-h-[88vh] overflow-hidden flex flex-col shadow-xl animate-[slideUp_0.2s_ease-out]"
      >
        <header class="px-5 py-4 border-b border-border">
          <h2 id={titleId} class="m-0 text-base font-semibold text-foreground">
            {mode() === "create" ? "New catalog entry" : "Edit catalog entry"}
          </h2>
        </header>

        <div class="flex-1 overflow-y-auto px-5 py-4 grid gap-3">
          <Show when={mode() === "create"}>
            <div class="grid grid-cols-2 gap-3">
              <label class="block">
                <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
                  Namespace
                </span>
                <input
                  type="text"
                  class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[13px] font-mono focus:outline-none focus:border-primary"
                  value={namespace()}
                  onInput={(e) => setNamespace(e.currentTarget.value)}
                  placeholder="default"
                />
              </label>
              <label class="block">
                <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
                  Kind
                </span>
                <select
                  class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[13px] focus:outline-none focus:border-primary"
                  value={kind()}
                  onChange={(e) =>
                    setKind(e.currentTarget.value as CatalogEntryKind)
                  }
                >
                  <For each={KIND_OPTIONS}>
                    {(opt) => <option value={opt.value}>{opt.label}</option>}
                  </For>
                </select>
              </label>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <label class="block">
                <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
                  Name
                </span>
                <input
                  type="text"
                  class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[13px] font-mono focus:outline-none focus:border-primary"
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                  placeholder="research-monitor"
                />
              </label>
              <label class="block">
                <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
                  Version
                </span>
                <input
                  type="text"
                  class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[13px] font-mono focus:outline-none focus:border-primary"
                  value={version()}
                  onInput={(e) => setVersion(e.currentTarget.value)}
                  placeholder="1.0.0"
                />
              </label>
            </div>
          </Show>
          <Show when={mode() === "edit"}>
            <div class="text-[12px] text-muted-foreground">
              <span class="font-mono">
                {namespace()}/{name()}
              </span>{" "}
              <span class="font-mono">{version()}</span>{" "}
              <span class="text-[11px]">- {kind()}</span>
            </div>
          </Show>

          <label class="block">
            <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
              Tag (mutable pointer, optional)
            </span>
            <input
              type="text"
              class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[13px] font-mono focus:outline-none focus:border-primary"
              value={tag()}
              onInput={(e) => setTag(e.currentTarget.value)}
              placeholder="stable"
            />
          </label>

          <label class="block">
            <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
              Description
            </span>
            <textarea
              class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[13px] focus:outline-none focus:border-primary resize-y"
              rows="2"
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
            />
          </label>

          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
                Category (optional)
              </span>
              <input
                type="text"
                class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[13px] focus:outline-none focus:border-primary"
                value={category()}
                onInput={(e) => setCategory(e.currentTarget.value)}
              />
            </label>
            <label class="flex items-center gap-2 self-end pb-2 text-[12px] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={deprecated()}
                onChange={(e) => setDeprecated(e.currentTarget.checked)}
              />
              Mark deprecated
            </label>
          </div>

          <label class="block">
            <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
              Labels (JSON object)
            </span>
            <textarea
              class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[12px] font-mono focus:outline-none focus:border-primary resize-y"
              rows="3"
              value={labelsText()}
              onInput={(e) => setLabelsText(e.currentTarget.value)}
            />
          </label>

          <label class="block">
            <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
              Source (JSON)
            </span>
            <textarea
              class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-[12px] font-mono focus:outline-none focus:border-primary resize-y"
              rows="4"
              value={sourceText()}
              onInput={(e) => setSourceText(e.currentTarget.value)}
            />
          </label>

          <Show when={error()}>
            <div
              class="text-[12px] text-red-400"
              role="status"
              aria-live="polite"
            >
              {error()}
            </div>
          </Show>
        </div>

        <footer class="flex justify-end gap-2 py-3 px-5 border-t border-border bg-popover">
          <Show when={submitReason()}>
            <span
              id={submitReasonId}
              class="mr-auto self-center text-[12px] text-muted-foreground"
              role="status"
            >
              {submitReason()}
            </span>
          </Show>
          <button
            type="button"
            class="py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={props.onClose}
            disabled={submitting()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-primary text-primary-foreground border border-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSubmit}
            disabled={!canSubmit()}
            title={submitReason() ?? undefined}
            aria-describedby={submitReason() ? submitReasonId : undefined}
          >
            {submitting()
              ? "Saving..."
              : mode() === "create"
                ? "Create"
                : "Save changes"}
          </button>
        </footer>
      </div>
    </div>
  );
};
