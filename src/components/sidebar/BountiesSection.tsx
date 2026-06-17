// ABOUTME: Sidebar section for active Seren Bounty opportunities.
// ABOUTME: Lists public open bounties from the seren-bounty publisher.

import { createQuery } from "@tanstack/solid-query";
import {
  type Component,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { listBountiesOptions } from "@/api/generated/seren-bounty/@tanstack/solid-query.gen";
import type { BountyListItem } from "@/api/seren-bounty";
import {
  isPublisherErrorEnvelope,
  publisherErrorMessage,
  unwrapPublisherBody,
} from "@/lib/publisher-response";
import { threadStore } from "@/stores/thread.store";

const BOUNTY_REFRESH_INTERVAL_MS = 30_000;
const ACTIVE_BOUNTY_LIMIT = 200;

export const OPEN_BOUNTY_DETAIL_EVENT = "seren:open-bounty-detail";
export const CLOSE_BOUNTY_DETAIL_EVENT = "seren:close-bounty-detail";

// Snapshot of the conversation row that was active when the user clicked
// the bounty. The sidebar clears `threadStore.activeThreadId` to drop the
// dual-row highlight, which would otherwise erase this information before
// the detail pane has a chance to read it; ride it through the open event
// so `BountyDetail` can inherit provider/model when the user joins.
//
// `agentCwd` carries the agent thread's own cwd because the file tree
// state may have drifted from the thread (e.g. the user navigated the
// file tree elsewhere while staying on the same Codex thread).
export type BountyInheritFrom = {
  kind: "chat" | "agent";
  provider: string | null;
  model: string | null;
  projectRoot: string | null;
  agentType: string | null;
  agentCwd: string | null;
};

export type BountyDetailEventDetail = {
  bountyId: string;
  inheritFrom?: BountyInheritFrom | null;
};

type BountyListShape = {
  bounties: BountyListItem[];
  next_page_cursor?: string | null;
};

type ActiveBounty = {
  id: string;
  customerSlug: string;
  title: string;
  poolRemainingAtomic: number;
  deadline: string | null;
  createdAt: string;
};

function fromBounty(row: BountyListItem): ActiveBounty {
  return {
    id: row.id,
    customerSlug: row.customer_slug,
    title: row.title,
    poolRemainingAtomic: row.pool_remaining_atomic,
    deadline: row.deadline ?? null,
    createdAt: row.created_at,
  };
}

function createdAtTime(value: string): number {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function formatSerenBucks(atomic: number): string {
  if (!Number.isFinite(atomic) || atomic <= 0) return "0 SB";
  const value = atomic / 1_000_000;
  if (value >= 1000) {
    return `${new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 1,
      notation: "compact",
    }).format(value)} SB`;
  }
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 10 ? 0 : 2,
  }).format(value)} SB`;
}

function formatBountyDeadline(iso: string | null): string | null {
  if (!iso) return null;
  const deadline = new Date(iso).getTime();
  if (Number.isNaN(deadline)) return null;
  const diffMs = deadline - Date.now();
  if (diffMs <= 0) return "Expired";
  const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays <= 1) return "Due today";
  if (diffDays < 30) return `${diffDays}d left`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const BountyRow: Component<{
  bounty: ActiveBounty;
  active: boolean;
  onSelect: (id: string) => void;
}> = (props) => {
  const deadline = () => formatBountyDeadline(props.bounty.deadline);
  const title = () =>
    [
      props.bounty.customerSlug,
      `${formatSerenBucks(props.bounty.poolRemainingAtomic)} remaining`,
      deadline(),
    ]
      .filter(Boolean)
      .join(" - ");
  return (
    <button
      type="button"
      class="thread-list-row flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md bg-transparent border-none border-l-2 border-l-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-surface-2/60 focus-visible:outline-none focus-visible:bg-surface-2 focus-visible:ring-1 focus-visible:ring-primary/60"
      classList={{
        "!bg-surface-2/80 !border-l-primary": props.active,
      }}
      aria-current={props.active ? "page" : undefined}
      aria-label={`Open bounty ${props.bounty.title}, ${props.bounty.customerSlug}, ${formatSerenBucks(props.bounty.poolRemainingAtomic)} remaining`}
      title={title()}
      onClick={() => props.onSelect(props.bounty.id)}
    >
      <span
        class="flex items-center justify-center w-[22px] h-[22px] rounded-md border border-border/80 text-[12px] text-muted-foreground/85 flex-none transition-colors duration-150"
        classList={{
          "!border-primary/60 !text-primary": props.active,
        }}
        aria-hidden="true"
      >
        $
      </span>
      <div class="flex-1 min-w-0">
        <div
          class="thread-list-title text-foreground truncate"
          classList={{ "!text-foreground": props.active }}
        >
          {props.bounty.title}
        </div>
        <div class="thread-list-meta text-muted-foreground truncate">
          {props.bounty.customerSlug}
          {" - "}
          {formatSerenBucks(props.bounty.poolRemainingAtomic)} remaining
          <Show when={deadline()}>
            {(label) => (
              <>
                {" - "}
                {label()}
              </>
            )}
          </Show>
        </div>
      </div>
    </button>
  );
};

export const BountiesSection: Component = () => {
  const [collapsed, setCollapsed] = createSignal(false);
  const [activeId, setActiveId] = createSignal<string | null>(null);

  const handleSelectBounty = (bountyId: string) => {
    // Snapshot the active thread's binding BEFORE clearing the active
    // thread - this is the source of truth for "what provider is the user
    // currently using" (the global `providerStore.activeProvider` is
    // chat-only and doesn't reflect native-agent selection). The detail
    // pane uses this to inherit provider/model when the user joins.
    const activeThreadId = threadStore.activeThreadId;
    const row = activeThreadId
      ? threadStore.findConversation(activeThreadId)
      : null;
    const inheritFrom: BountyInheritFrom | null = row
      ? {
          kind: row.kind,
          provider: row.provider,
          model: row.model,
          projectRoot: row.projectRoot,
          agentType: row.agentType,
          agentCwd: row.agentCwd,
        }
      : null;

    // Clear the active thread before activating the bounty so the chat /
    // agent thread row in the sidebar drops its highlight (otherwise the
    // sidebar shows two simultaneously-active rows). Mirrors what
    // `EmployeesSection.handleSelect` does for the same reason.
    threadStore.setActiveThread(null);
    setActiveId(bountyId);
    window.dispatchEvent(new CustomEvent("seren:close-employee-detail"));
    window.dispatchEvent(
      new CustomEvent<BountyDetailEventDetail>(OPEN_BOUNTY_DETAIL_EVENT, {
        detail: { bountyId, inheritFrom },
      }),
    );
  };

  // Keep the sidebar active highlight in sync with the AppShell's active
  // bounty pane: it dispatches CLOSE when the user clicks a thread, and
  // re-dispatches OPEN when navigating back. Mirrors EmployeesSection.
  const handleOpenBountyDetail = (event: Event) => {
    const detail = (event as CustomEvent<BountyDetailEventDetail>).detail;
    setActiveId(detail?.bountyId ?? null);
  };
  const handleCloseBountyDetail = () => {
    setActiveId(null);
  };
  onMount(() => {
    window.addEventListener(OPEN_BOUNTY_DETAIL_EVENT, handleOpenBountyDetail);
    window.addEventListener(CLOSE_BOUNTY_DETAIL_EVENT, handleCloseBountyDetail);
  });
  onCleanup(() => {
    window.removeEventListener(
      OPEN_BOUNTY_DETAIL_EVENT,
      handleOpenBountyDetail,
    );
    window.removeEventListener(
      CLOSE_BOUNTY_DETAIL_EVENT,
      handleCloseBountyDetail,
    );
  });

  const bountiesQuery = createQuery(() => ({
    ...listBountiesOptions({
      query: { status: "open", limit: ACTIVE_BOUNTY_LIMIT },
      parseAs: "json",
    }),
    refetchInterval: BOUNTY_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // Gateway responses for /publishers/<slug>/* may carry either the
    // single DataResponse envelope or the double publisher-proxy envelope
    // (`{ data: { status, body } }`). `unwrapPublisherBody` peels both and
    // is a no-op when the response is already the bare publisher body.
    select: (response) => {
      const body = unwrapPublisherBody<BountyListShape>(response);
      if (isPublisherErrorEnvelope(body)) {
        throw new Error(
          publisherErrorMessage(body) ?? "Failed to load bounties",
        );
      }
      return body as BountyListShape;
    },
  }));
  const activeBounties = createMemo(() =>
    (bountiesQuery.data?.bounties ?? [])
      .map(fromBounty)
      .sort((a, b) => createdAtTime(b.createdAt) - createdAtTime(a.createdAt)),
  );

  const errorMessage = createMemo(() =>
    bountiesQuery.error instanceof Error
      ? bountiesQuery.error.message
      : bountiesQuery.error
        ? "Failed to load bounties"
        : null,
  );

  return (
    <div class="mb-1.5">
      <button
        type="button"
        class="flex items-center gap-1.5 w-full px-3 pt-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 select-none bg-transparent border-none cursor-pointer text-left rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed()}
      >
        <span class="flex-1">Bounties</span>
        <Show
          when={
            !errorMessage() &&
            !bountiesQuery.isLoading &&
            activeBounties().length > 0
          }
        >
          <span class="text-[10.5px] font-medium text-muted-foreground opacity-60 normal-case tracking-normal">
            {activeBounties().length}
          </span>
        </Show>
      </button>
      <Show when={!collapsed()}>
        <div class="flex flex-col gap-0.5 px-1">
          <Show when={errorMessage()}>
            <div
              class="px-2 py-1 text-[12px] text-status-error opacity-80"
              role="alert"
            >
              {errorMessage()}
            </div>
          </Show>
          <Show when={!errorMessage() && bountiesQuery.isLoading}>
            <div class="px-2 py-1 text-[12px] text-muted-foreground/70">
              Loading active bounties...
            </div>
          </Show>
          <Show
            when={
              !errorMessage() &&
              !bountiesQuery.isLoading &&
              activeBounties().length > 0
            }
          >
            <For each={activeBounties()}>
              {(bounty) => (
                <BountyRow
                  bounty={bounty}
                  active={activeId() === bounty.id}
                  onSelect={handleSelectBounty}
                />
              )}
            </For>
          </Show>
          <Show
            when={
              !errorMessage() &&
              !bountiesQuery.isLoading &&
              activeBounties().length === 0
            }
          >
            <div class="px-2 py-1 text-[12px] text-muted-foreground/70">
              No active bounties
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};
