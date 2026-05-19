// ABOUTME: Detail view for a single Seren Bounty.
// ABOUTME: Replaces the main content area when a bounty row is selected in the sidebar.

import { createQuery } from "@tanstack/solid-query";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import {
  getBountyLeaderboardOptions,
  getBountyOptions,
  getBountyStatsOptions,
  listBountiesOptions,
  listBountyEarningsOptions,
} from "@/api/generated/seren-bounty/@tanstack/solid-query.gen";
import {
  type BountyDetail as BountyDetailRow,
  type BountyList,
  type BountyListItem,
  type BountyStats,
  type Earning,
  type EarningsList,
  type JoinBountyResponse,
  joinBounty,
  type LeaderboardEntry,
  type Tier,
} from "@/api/seren-bounty";
import type { BountyInheritFrom } from "@/components/sidebar/BountiesSection";
import { PROVIDER_CONFIGS, type ProviderId } from "@/lib/providers/types";
import {
  isPublisherErrorEnvelope,
  publisherErrorMessage,
  unwrapPublisherBody,
} from "@/lib/publisher-response";
import type { InstalledSkill, Skill } from "@/lib/skills";
import { setThreadDraft } from "@/lib/tauri-bridge";
import type { AgentType } from "@/services/providers";
import { skills as skillsService } from "@/services/skills";
import { agentStore } from "@/stores/agent.store";
import { chatStore } from "@/stores/chat.store";
import { fileTreeState } from "@/stores/fileTree";
import { skillsStore } from "@/stores/skills.store";
import { threadStore } from "@/stores/thread.store";

const SEREN_BOUNTY_SLUG = "seren-bounty";
const SEREN_BOUNTY_SOURCE_URL = `seren-skills:${SEREN_BOUNTY_SLUG}`;

interface BountyDetailProps {
  bountyId: string;
  // Snapshot of the conversation row that was active when the user
  // opened this pane. The sidebar captures it before clearing the
  // active-thread state to drop the dual-row highlight, so reading
  // `threadStore.activeThreadId` here at join time would be too late.
  inheritFrom?: BountyInheritFrom | null;
}

// View-side projection assembled from up to three sources: the public list
// row (gives us description, tiers, submission instructions), the public
// stats rollup (gives us pool / participants / earned), and the optional
// detail row (only when the user is in the bounty's org). We never trust
// any single source - the merged view picks the best available value.
interface BountyView {
  id: string;
  title: string;
  status: string;
  health_status: string;
  customer_slug: string;
  description: string | null;
  pool_remaining_atomic: number;
  max_pool_atomic: number;
  deadline: string | null;
  hold_days: number;
  submission_mode: string;
  submission_instructions: string | null;
  tiers: Tier[];
  current_tier_index: number;
  cumulative_qualifying_count: number;
  created_at: string | null;
  updated_at: string | null;
  verifier_failure_count: number;
  verifier_last_error: string | null;
  verifier_last_success_at: string | null;
  earnings_count: number;
}

interface ListRow {
  id: string;
  title: string | null;
  status: string | null;
  health_status: string | null;
  customer_slug: string | null;
  description: string | null;
  pool_remaining_atomic: number | null;
  max_pool_atomic: number | null;
  deadline: string | null;
  hold_days: number | null;
  submission_mode: string | null;
  submission_instructions: string | null;
  tiers: Tier[] | null;
  current_tier_index: number | null;
  cumulative_qualifying_count: number | null;
  created_at: string | null;
  updated_at: string | null;
  verifier_failure_count: number | null;
  verifier_last_error: string | null;
  verifier_last_success_at: string | null;
  earnings_count: number | null;
}

function projectRowLoose(raw: unknown): ListRow | null {
  if (!raw || typeof raw !== "object" || isPublisherErrorEnvelope(raw))
    return null;
  const row = raw as Record<string, unknown> & {
    progress?: {
      cumulative_qualifying_count?: number;
      current_tier_index?: number;
    } | null;
  };
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) return null;
  const progress = row.progress ?? null;
  const cumulative =
    (progress?.cumulative_qualifying_count as number | undefined) ??
    (row.cumulative_qualifying_count as number | undefined) ??
    null;
  const currentTier =
    (progress?.current_tier_index as number | undefined) ??
    (row.current_tier_index as number | undefined) ??
    null;
  return {
    id,
    title: typeof row.title === "string" ? row.title : null,
    status: typeof row.status === "string" ? row.status : null,
    health_status:
      typeof row.health_status === "string" ? row.health_status : null,
    customer_slug:
      typeof row.customer_slug === "string" ? row.customer_slug : null,
    description: typeof row.description === "string" ? row.description : null,
    pool_remaining_atomic:
      typeof row.pool_remaining_atomic === "number"
        ? row.pool_remaining_atomic
        : null,
    max_pool_atomic:
      typeof row.max_pool_atomic === "number" ? row.max_pool_atomic : null,
    deadline: typeof row.deadline === "string" ? row.deadline : null,
    hold_days: typeof row.hold_days === "number" ? row.hold_days : null,
    submission_mode:
      typeof row.submission_mode === "string" ? row.submission_mode : null,
    submission_instructions:
      typeof row.submission_instructions === "string"
        ? row.submission_instructions
        : null,
    tiers: Array.isArray(row.tiers) ? (row.tiers as Tier[]) : null,
    current_tier_index: currentTier,
    cumulative_qualifying_count: cumulative,
    created_at: typeof row.created_at === "string" ? row.created_at : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    verifier_failure_count:
      typeof row.verifier_failure_count === "number"
        ? row.verifier_failure_count
        : null,
    verifier_last_error:
      typeof row.verifier_last_error === "string"
        ? row.verifier_last_error
        : null,
    verifier_last_success_at:
      typeof row.verifier_last_success_at === "string"
        ? row.verifier_last_success_at
        : null,
    earnings_count:
      typeof row.earnings_count === "number" ? row.earnings_count : null,
  };
}

function mergeView(
  detail: ListRow | null,
  listed: ListRow | null,
  stats: BountyStats | null,
  bountyId: string,
): BountyView | null {
  if (!detail && !listed && !stats) return null;
  const pickStr = (
    ...values: Array<string | null | undefined>
  ): string | null => {
    for (const v of values) {
      if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
  };
  const pickNum = (
    ...values: Array<number | null | undefined>
  ): number | null => {
    for (const v of values) {
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return null;
  };
  const tiers =
    detail?.tiers && detail.tiers.length > 0
      ? detail.tiers
      : (listed?.tiers ?? []);
  return {
    id: detail?.id ?? listed?.id ?? bountyId,
    title:
      pickStr(detail?.title, listed?.title, stats?.title ?? null) ?? "Bounty",
    status: pickStr(detail?.status, listed?.status, stats?.status) ?? "unknown",
    health_status:
      pickStr(
        detail?.health_status,
        listed?.health_status,
        stats?.health_status ?? null,
      ) ?? "unknown",
    customer_slug: pickStr(detail?.customer_slug, listed?.customer_slug) ?? "",
    description: pickStr(detail?.description, listed?.description),
    pool_remaining_atomic:
      pickNum(
        detail?.pool_remaining_atomic,
        listed?.pool_remaining_atomic,
        stats?.pool_remaining_atomic,
      ) ?? 0,
    max_pool_atomic:
      pickNum(
        detail?.max_pool_atomic,
        listed?.max_pool_atomic,
        stats?.max_pool_atomic,
      ) ?? 0,
    deadline: pickStr(
      detail?.deadline,
      listed?.deadline,
      stats?.deadline ?? null,
    ),
    hold_days: pickNum(detail?.hold_days, listed?.hold_days) ?? 0,
    submission_mode:
      pickStr(detail?.submission_mode, listed?.submission_mode) ?? "",
    submission_instructions: pickStr(
      detail?.submission_instructions,
      listed?.submission_instructions,
    ),
    tiers,
    current_tier_index:
      pickNum(
        detail?.current_tier_index,
        listed?.current_tier_index,
        stats?.current_tier_index,
      ) ?? 0,
    cumulative_qualifying_count:
      pickNum(
        detail?.cumulative_qualifying_count,
        listed?.cumulative_qualifying_count,
        stats?.cumulative_qualifying_count,
      ) ?? 0,
    created_at: pickStr(
      detail?.created_at,
      listed?.created_at,
      stats?.created_at ?? null,
    ),
    updated_at: pickStr(detail?.updated_at, listed?.updated_at),
    verifier_failure_count:
      pickNum(detail?.verifier_failure_count, listed?.verifier_failure_count) ??
      0,
    verifier_last_error: pickStr(
      detail?.verifier_last_error,
      listed?.verifier_last_error,
    ),
    verifier_last_success_at: pickStr(
      detail?.verifier_last_success_at,
      listed?.verifier_last_success_at,
    ),
    earnings_count:
      pickNum(detail?.earnings_count, listed?.earnings_count) ?? 0,
  };
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

function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatDateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatRelative(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  const diffMs = Date.now() - ts;
  if (diffMs < 0) {
    const diffMin = Math.abs(Math.round(diffMs / 60000));
    if (diffMin < 60) return `in ${diffMin}m`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `in ${diffHr}h`;
    const diffDay = Math.round(diffHr / 24);
    return `in ${diffDay}d`;
  }
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return formatDateOnly(iso);
}

function shortUuid(id: string): string {
  if (!id) return "";
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

function statusTone(status: string): string {
  if (status === "open")
    return "bg-emerald-500/10 text-emerald-700 border-emerald-600/25 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30";
  if (status === "funding" || status === "draft")
    return "bg-sky-500/10 text-sky-700 border-sky-600/25 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30";
  if (status === "exhausted")
    return "bg-amber-500/10 text-amber-800 border-amber-600/25 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30";
  if (status === "expired" || status === "cancelled")
    return "bg-muted-foreground/15 text-muted-foreground border-border";
  return "bg-muted-foreground/15 text-muted-foreground border-border";
}

function earningStatusTone(status: string): string {
  if (status === "paid")
    return "bg-emerald-500/10 text-emerald-700 border-emerald-600/25 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30";
  if (status === "released")
    return "bg-sky-500/10 text-sky-700 border-sky-600/25 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30";
  if (status === "earned")
    return "bg-amber-500/10 text-amber-800 border-amber-600/25 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30";
  if (status === "clawed_back")
    return "bg-red-500/10 text-red-700 border-red-600/25 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30";
  return "bg-muted-foreground/15 text-muted-foreground border-border";
}

const StatCard: Component<{
  label: string;
  value: string;
  sub?: string | null;
}> = (props) => (
  <div class="px-3 py-2.5 rounded-md border border-border/50 bg-surface-2/40">
    <div class="text-[12px] uppercase tracking-[0.12em] text-muted-foreground/70">
      {props.label}
    </div>
    <div class="text-[15px] font-medium text-foreground tabular-nums">
      {props.value}
    </div>
    <Show when={props.sub}>
      <div class="text-[12.5px] text-muted-foreground/70 tabular-nums">
        {props.sub}
      </div>
    </Show>
  </div>
);

const TierRow: Component<{
  tier: Tier;
  index: number;
  currentIndex: number;
}> = (props) => (
  <div
    class="flex items-center justify-between gap-4 px-3 py-2 rounded-md border border-border/50 bg-surface-2/40"
    classList={{
      "ring-1 ring-primary/40 !border-primary/40":
        props.index === props.currentIndex,
    }}
  >
    <div class="flex items-center gap-3 min-w-0">
      <span class="flex items-center justify-center w-6 h-6 rounded-md bg-surface-3 text-[12px] font-semibold text-muted-foreground shrink-0">
        {props.index + 1}
      </span>
      <div class="text-[13px] text-foreground">
        After {props.tier.threshold.toLocaleString()} qualifying
      </div>
    </div>
    <div class="text-[13px] font-medium text-foreground tabular-nums">
      {formatSerenBucks(props.tier.rate_atomic)} / earning
    </div>
  </div>
);

export const BountyDetail: Component<BountyDetailProps> = (props) => {
  // Primary source #1: public list endpoint, scanned for the matching id.
  // Returns the full `Bounty` shape (description, tiers, submission_*,
  // verifier_*) which the auth-only `get_bounty` endpoint duplicates but
  // gates by org membership.
  const listQuery = createQuery(() => ({
    ...listBountiesOptions({
      query: { limit: 200 },
      parseAs: "json",
    }),
    // Keep the BountyList shape (TanStack's generated options fix TData);
    // unwrap the envelope here and let the consumer pluck `.bounties`.
    select: (response) => {
      const body = unwrapPublisherBody<BountyList>(response);
      if (isPublisherErrorEnvelope(body)) {
        throw new Error(publisherErrorMessage(body) ?? "Failed to load bounty");
      }
      const rows = (body as { bounties?: unknown } | null)?.bounties;
      return {
        bounties: Array.isArray(rows) ? (rows as BountyListItem[]) : [],
      } satisfies BountyList;
    },
  }));

  // Primary source #2: public stats rollup. This is the only source that
  // returns participant/earner/pool-consumed numbers, plus the canonical
  // title/status/health when the list scan misses.
  const statsQuery = createQuery(() => ({
    ...getBountyStatsOptions({
      path: { id: props.bountyId },
      parseAs: "json",
    }),
    select: (response) =>
      unwrapPublisherBody<BountyStats>(response) as BountyStats,
  }));

  // Best-effort enrichment: detail endpoint adds fields the list doesn't
  // expose, but only succeeds when the caller is in the bounty's org. The
  // gateway returns HTTP 200 with `{ error: { code: 404, ... } }` for
  // non-members, so we filter those out at the boundary.
  const detailQuery = createQuery(() => ({
    ...getBountyOptions({
      path: { id: props.bountyId },
      parseAs: "json",
    }),
    select: (response) =>
      unwrapPublisherBody<BountyDetailRow>(response) as BountyDetailRow,
  }));

  const leaderboardQuery = createQuery(() => ({
    ...getBountyLeaderboardOptions({
      path: { id: props.bountyId },
      query: { limit: 5 },
      parseAs: "json",
    }),
    // Leaderboard returns an array directly per spec; some publisher proxies
    // wrap it in `{ entries }`. Accept both shapes.
    select: (response) => {
      const body = unwrapPublisherBody<LeaderboardEntry[]>(response);
      if (Array.isArray(body)) return body as LeaderboardEntry[];
      const entries = (body as { entries?: unknown } | null)?.entries;
      return Array.isArray(entries) ? (entries as LeaderboardEntry[]) : [];
    },
  }));

  // Earnings is auth-only too; same 404 envelope when out-of-org.
  const earningsQuery = createQuery(() => ({
    ...listBountyEarningsOptions({
      path: { id: props.bountyId },
      query: { limit: 6 },
      parseAs: "json",
    }),
    select: (response) =>
      unwrapPublisherBody<EarningsList>(response) as EarningsList,
  }));

  const listedRow = createMemo(() => {
    const rows = listQuery.data?.bounties;
    if (!Array.isArray(rows)) return null;
    const match = rows.find(
      (r) => (r as { id?: string }).id === props.bountyId,
    );
    return match ? projectRowLoose(match) : null;
  });

  const detailRow = createMemo(() => {
    const raw = detailQuery.data;
    if (!raw || isPublisherErrorEnvelope(raw)) return null;
    return projectRowLoose(raw);
  });

  const stats = createMemo(() => {
    const raw = statsQuery.data;
    if (!raw || isPublisherErrorEnvelope(raw)) return null;
    return raw as BountyStats;
  });

  const bounty = createMemo(() =>
    mergeView(detailRow(), listedRow(), stats(), props.bountyId),
  );

  const detailRestricted = createMemo(
    () =>
      detailQuery.data !== undefined &&
      isPublisherErrorEnvelope(detailQuery.data),
  );

  // Stats is a public endpoint, but the publisher proxy can still rewrap an
  // upstream 404 (bounty deleted or never existed) as HTTP 200 with an
  // `{ error: { code: 404, ... } }` body. That hides the failure from
  // `statsQuery.error` and would otherwise leave us with no signal.
  const statsRestricted = createMemo(
    () =>
      statsQuery.data !== undefined &&
      isPublisherErrorEnvelope(statsQuery.data),
  );

  const leaderboard = createMemo(() => leaderboardQuery.data ?? []);
  const earnings = createMemo<Earning[]>(() => {
    const raw = earningsQuery.data;
    if (!raw || isPublisherErrorEnvelope(raw)) return [];
    const list = (raw as { earnings?: unknown }).earnings;
    return Array.isArray(list) ? (list as Earning[]) : [];
  });

  const poolPercentRemaining = createMemo(() => {
    const b = bounty();
    if (!b || b.max_pool_atomic <= 0) return 0;
    return Math.max(
      0,
      Math.min(100, (b.pool_remaining_atomic / b.max_pool_atomic) * 100),
    );
  });

  const primaryLoading = createMemo(
    () => listQuery.isLoading || statsQuery.isLoading,
  );

  const sideErrors = createMemo(() => {
    const errs: Array<{ label: string; message: string }> = [];
    if (listQuery.error) {
      errs.push({
        label: "list",
        message:
          listQuery.error instanceof Error ? listQuery.error.message : "failed",
      });
    }
    if (statsQuery.error) {
      errs.push({
        label: "stats",
        message:
          statsQuery.error instanceof Error
            ? statsQuery.error.message
            : "failed",
      });
    } else if (statsRestricted()) {
      // Stats returned `{ error: { code, message } }` over HTTP 200. Surface
      // it so the user understands why pool/participant numbers are missing.
      errs.push({
        label: "stats",
        message: publisherErrorMessage(statsQuery.data) ?? "not available",
      });
    }
    if (leaderboardQuery.error) {
      errs.push({
        label: "leaderboard",
        message:
          leaderboardQuery.error instanceof Error
            ? leaderboardQuery.error.message
            : "failed",
      });
    }
    // Detail and earnings 404 silently when the user isn't in the bounty's
    // org. Surfacing that as an error would be misleading; we already note
    // the restricted state via `detailRestricted()`.
    if (detailQuery.error && !detailRestricted()) {
      errs.push({
        label: "detail",
        message:
          detailQuery.error instanceof Error
            ? detailQuery.error.message
            : "failed",
      });
    }
    const earningsEnvelope = earningsQuery.data;
    const earningsRestricted =
      earningsEnvelope !== undefined &&
      isPublisherErrorEnvelope(earningsEnvelope);
    if (earningsQuery.error && !earningsRestricted) {
      errs.push({
        label: "earnings",
        message:
          earningsQuery.error instanceof Error
            ? earningsQuery.error.message
            : "failed",
      });
    }
    return errs;
  });

  const errorMessage = createMemo(() => {
    // Surface a top-level error only when EVERY public source failed and we
    // therefore have nothing to render. A working stats response with a
    // detail 404 is the common case and should not look like an error.
    if (bounty() !== null) return null;
    if (primaryLoading()) return null;
    if (listQuery.error instanceof Error) return listQuery.error.message;
    if (statsQuery.error instanceof Error) return statsQuery.error.message;
    if (listQuery.error || statsQuery.error) return "Failed to load bounty";
    // No HTTP error fired but `mergeView` still produced nothing: stats was
    // rewrapped as a 200-with-error-envelope, the bounty wasn't in the
    // public list page, and detail is org-restricted. Without a message
    // the pane would render blank, which looks broken.
    return "Bounty unavailable.";
  });

  const canJoinBounty = createMemo(() => {
    const b = bounty();
    if (!b) return false;
    // Joining only makes sense on bounties that can actually pay out.
    // Funding/draft are pre-open; exhausted/expired/cancelled are dead.
    return b.status === "open";
  });

  const [joining, setJoining] = createSignal(false);
  const [joinError, setJoinError] = createSignal<string | null>(null);

  createEffect(
    on(
      () => props.bountyId,
      () => setJoinError(null),
    ),
  );

  // Best-effort call to `POST /bounties/{id}/join` — records the user as a
  // participant and returns a referral code. We never block the chat-thread
  // handoff on this: a 4xx/5xx (or the publisher-proxy `{ error }` envelope)
  // just means we skip the referral arg and open a plain seeded thread.
  async function tryJoinBounty(id: string): Promise<string | null> {
    try {
      const result = await joinBounty({
        path: { id },
        parseAs: "json",
        throwOnError: false,
      });
      if (result.error) return null;
      const body = unwrapPublisherBody<JoinBountyResponse>(result.data);
      if (!body || isPublisherErrorEnvelope(body)) return null;
      const code = (body as JoinBountyResponse).referral_code;
      return typeof code === "string" && code.length > 0 ? code : null;
    } catch (error) {
      console.warn("[BountyDetail] join_bounty failed", error);
      return null;
    }
  }

  // Install the seren-bounty skill into the seren scope on demand. Mirrors
  // the `ensureSkillCreatorInstalled` flow in SkillsExplorer: looks up by
  // slug, fetches the bundle content via the catalog, and installs.
  async function ensureSerenBountySkill(): Promise<InstalledSkill | null> {
    const existing = skillsStore.installed.find(
      (s) =>
        s.scope === "seren" &&
        s.slug === SEREN_BOUNTY_SLUG &&
        s.payloadStatus !== "failed",
    );
    if (existing) return existing;
    try {
      const skillRow: Skill = {
        id: `seren:${SEREN_BOUNTY_SLUG}`,
        slug: SEREN_BOUNTY_SLUG,
        name: "Seren Bounty",
        description:
          "Walk a user through joining and submitting work for a Seren bounty.",
        source: "seren",
        sourceUrl: SEREN_BOUNTY_SOURCE_URL,
        tags: ["bounty"],
        author: "SerenAI",
      };
      const content = await skillsService.fetchContent(skillRow);
      if (!content) return null;
      return await skillsStore.install(skillRow, content, "seren");
    } catch (error) {
      console.warn(
        "[BountyDetail] Failed to install seren-bounty skill:",
        error,
      );
      return null;
    }
  }

  // Build the slash-command invocation. The user sees this pre-filled but
  // unsent so they can edit before submitting.
  function buildSerenBountyCommand(
    b: BountyView,
    referralCode: string | null,
  ): string {
    const parts = [`/seren-bounty ${b.id}`];
    if (b.customer_slug) parts.push(`--customer=${b.customer_slug}`);
    if (referralCode) parts.push(`--referral=${referralCode}`);
    return parts.join(" ");
  }

  function isChatProvider(
    value: string | null | undefined,
  ): value is ProviderId {
    return !!value && value in PROVIDER_CONFIGS;
  }

  function isAgentType(value: string | null | undefined): value is AgentType {
    return value === "claude-code" || value === "codex" || value === "gemini";
  }

  const handleJoinBounty = async () => {
    const b = bounty();
    if (!b || joining()) return;
    setJoining(true);
    setJoinError(null);
    try {
      // Join the bounty server-side and install the skill in parallel.
      // Both are best-effort: a failure on either still produces a usable
      // thread the user can edit.
      const [skill, referralCode] = await Promise.all([
        ensureSerenBountySkill(),
        tryJoinBounty(b.id),
      ]);

      const command = buildSerenBountyCommand(b, referralCode);

      // Inherit the binding from the conversation the sidebar snapshotted
      // before clearing the active thread. `providerStore.activeProvider`
      // only tracks chat providers, and `threadStore.activeThreadId` was
      // cleared by `BountiesSection.handleSelectBounty` so the sidebar
      // could drop its dual-row highlight - neither would tell us a
      // Codex thread was the user's current context.
      const inheritFrom = props.inheritFrom ?? null;

      let threadId: string | null = null;

      // Native agent active? Spawn the bounty thread on the same agent.
      // We don't fall back to `agentStore.selectedAgentType` because its
      // default of "claude-code" would mis-route a user who's been on
      // chat their whole session if the snapshot is briefly empty.
      const targetAgent: AgentType | null =
        inheritFrom?.kind === "agent" && isAgentType(inheritFrom.agentType)
          ? inheritFrom.agentType
          : null;

      // Only spawn native agents when the source thread snapshot carries
      // its cwd; the global file tree may belong to a different thread.
      const spawnCwd =
        inheritFrom?.kind === "agent" ? inheritFrom.agentCwd : null;
      const attachmentCwd =
        inheritFrom?.kind === "agent"
          ? inheritFrom.agentCwd
          : (inheritFrom?.projectRoot ?? fileTreeState.rootPath ?? null);

      if (targetAgent && spawnCwd) {
        // We inline the spawn (instead of calling threadStore.createAgentThread)
        // so we can write the slash-command draft via `setThreadDraft` BEFORE
        // calling selectThread. AgentChat reads the draft asynchronously when
        // activeAgentThread changes; if we wrote the draft afterward, an
        // in-flight `getThreadDraft("")` would clobber it on the next
        // microtask. Persisting first guarantees the agent composer mounts
        // with the prefilled command.
        const sessionId = await agentStore.spawnSession(spawnCwd, targetAgent, {
          conversationTitle: b.title,
        });
        if (sessionId) {
          await agentStore.refreshRecentAgentConversations(200);
          const session = agentStore.sessions[sessionId];
          if (session) {
            threadId = session.conversationId;
            await setThreadDraft(threadId, command);
            threadStore.selectThread(threadId, "agent");
          }
        }
      }

      // Fall through to a chat thread when the active thread is chat-side,
      // or when we couldn't spawn an agent (no cwd, etc.). We pre-fill the
      // slash command via `chatStore.pendingInput`, which ChatContent
      // watches and seeds into the input box on mount; agent threads spawn
      // straight from the bounty context held in the attached skill.
      if (!threadId) {
        const inheritedProvider =
          inheritFrom?.kind === "chat" && isChatProvider(inheritFrom.provider)
            ? inheritFrom.provider
            : undefined;
        const inheritedModel =
          inheritFrom?.kind === "chat" && inheritFrom.model
            ? inheritFrom.model
            : undefined;
        chatStore.setPendingInput(command);
        threadId = await threadStore.createChatThreadWithOptions(b.title, {
          provider: inheritedProvider ?? null,
          model: inheritedModel,
          projectRoot:
            inheritFrom?.kind === "chat" ? inheritFrom.projectRoot : undefined,
        });
      }

      // Attach the skill to just this thread so its instructions land in
      // context. `setThreadSkills` is project-scoped, so we need a cwd;
      // without one the skill is still globally installed and the user
      // can attach it manually from the skills picker if desired.
      if (skill && attachmentCwd && threadId) {
        await skillsStore.attachSkillToThread(
          attachmentCwd,
          threadId,
          skill.path,
        );
      }
    } catch (error) {
      console.warn("[BountyDetail] Failed to join bounty", error);
      setJoinError(
        error instanceof Error
          ? error.message
          : "Failed to join bounty. Please try again.",
      );
    } finally {
      setJoining(false);
    }
  };

  return (
    <div class="flex flex-col h-full min-h-0 overflow-hidden bg-background">
      <header class="flex items-center gap-3 px-5 pt-4 pb-3 border-b border-border/40">
        <Show
          when={bounty()}
          fallback={
            <div
              class="w-9 h-9 rounded-lg border border-border/40 bg-surface-2/40 flex-none"
              aria-hidden="true"
            />
          }
        >
          {(b) => (
            <div
              class="flex items-center justify-center w-9 h-9 rounded-lg border border-border/70 bg-surface-2/60 text-primary text-[18px] font-semibold flex-none shadow-sm"
              aria-label={b().customer_slug || b().title}
              title={b().customer_slug || b().title}
            >
              $
            </div>
          )}
        </Show>
        <div class="flex-1 min-w-0">
          <div class="text-[12px] uppercase tracking-[0.14em] text-muted-foreground/70">
            Bounty
          </div>
          <Show
            when={bounty()}
            fallback={
              <div class="text-[15px] text-muted-foreground">
                {primaryLoading() ? "Loading..." : "Bounty"}
              </div>
            }
          >
            {(b) => (
              <div class="text-[15px] font-medium text-foreground truncate">
                {b().title}
              </div>
            )}
          </Show>
        </div>
        <Show when={canJoinBounty()}>
          <button
            type="button"
            class="group inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/15 border border-primary/40 text-primary text-[13px] font-medium hover:bg-primary/25 hover:border-primary/60 active:bg-primary/30 transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            onClick={handleJoinBounty}
            disabled={joining()}
            aria-busy={joining()}
            title="Join this bounty and open a chat seeded with its context"
          >
            <Show
              when={!joining()}
              fallback={
                <span
                  class="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin"
                  aria-hidden="true"
                />
              }
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                class="transition-transform group-hover:translate-x-0.5"
              >
                <path
                  d="M3 5h7m0 0L7 2.5M10 5L7 7.5M3 11h10"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </Show>
            <span>{joining() ? "Joining..." : "Join the bounty"}</span>
          </button>
        </Show>
      </header>

      <div class="flex-1 min-h-0 overflow-auto px-5 py-5">
        <Show when={errorMessage()}>
          <div
            class="px-3 py-2 rounded-md border border-status-error/30 bg-status-error/10 text-[13px] text-status-error"
            role="alert"
          >
            {errorMessage()}
          </div>
        </Show>
        <Show when={joinError()}>
          <div
            class="mb-3 px-3 py-2 rounded-md border border-status-error/30 bg-status-error/10 text-[13px] text-status-error"
            role="alert"
          >
            {joinError()}
          </div>
        </Show>

        <Show when={!errorMessage() && primaryLoading() && !bounty()}>
          <div class="text-[13px] text-muted-foreground/80">
            Loading bounty details...
          </div>
        </Show>

        <Show when={bounty()}>
          {(b) => (
            <div class="flex flex-col gap-5 max-w-4xl">
              {/* Pills + meta line */}
              <div class="flex flex-wrap items-center gap-2">
                <span
                  class={`text-[12.5px] font-semibold uppercase tracking-[0.08em] px-2 py-0.5 rounded-full border ${statusTone(b().status)}`}
                >
                  {b().status}
                </span>
                <span class="text-[12.5px] text-muted-foreground">
                  {b().customer_slug}
                </span>
                <Show when={formatDateOnly(b().created_at)}>
                  {(label) => (
                    <span class="text-[12.5px] text-muted-foreground/70">
                      Created {label()}
                    </span>
                  )}
                </Show>
                <Show when={formatRelative(b().updated_at)}>
                  {(label) => (
                    <span class="text-[12.5px] text-muted-foreground/60">
                      Updated {label()}
                    </span>
                  )}
                </Show>
              </div>

              {/* Org-restricted notice: detail and earnings endpoints 404
                  for non-members. Surfacing this explicitly so the user
                  understands why those sections are sparse. */}
              <Show when={detailRestricted()}>
                <div class="text-[13px] leading-relaxed text-muted-foreground/85 px-3 py-2.5 rounded-md border border-border/40 bg-surface-2/30">
                  Showing public details. Some fields and earnings activity are
                  visible only to members of{" "}
                  <span class="font-mono text-foreground/85">
                    {b().customer_slug || "the bounty's organization"}
                  </span>
                  .
                </div>
              </Show>

              {/* Description */}
              <Show
                when={b().description}
                fallback={
                  <p class="text-[13px] italic text-muted-foreground/60">
                    No description provided.
                  </p>
                }
              >
                <p class="text-[13.5px] leading-relaxed text-foreground/90 whitespace-pre-wrap">
                  {b().description}
                </p>
              </Show>

              {/* Pool progress bar */}
              <section class="px-3.5 py-3 rounded-md border border-border/50 bg-surface-2/40">
                <div class="flex items-baseline justify-between gap-3">
                  <div class="text-[12px] uppercase tracking-[0.12em] text-muted-foreground/70">
                    Pool
                  </div>
                  <div class="text-[12.5px] tabular-nums text-muted-foreground">
                    {formatSerenBucks(b().pool_remaining_atomic)} of{" "}
                    {formatSerenBucks(b().max_pool_atomic)} remaining
                  </div>
                </div>
                <div
                  class="mt-2 h-2 rounded-full bg-surface-3 overflow-hidden"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(poolPercentRemaining())}
                  aria-label="Pool remaining"
                >
                  <div
                    class="h-full bg-primary transition-all duration-300"
                    style={{ width: `${poolPercentRemaining()}%` }}
                  />
                </div>
                <Show when={stats()}>
                  {(s) => (
                    <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[12.5px] text-muted-foreground/80">
                      <span>
                        <span class="tabular-nums">
                          {formatSerenBucks(s().pool_consumed_atomic)}
                        </span>{" "}
                        distributed
                      </span>
                      <span>
                        <span class="tabular-nums">
                          {formatSerenBucks(s().total_paid_atomic)}
                        </span>{" "}
                        paid out
                      </span>
                      <Show when={s().total_clawed_back_atomic > 0}>
                        <span class="text-status-error/80">
                          <span class="tabular-nums">
                            {formatSerenBucks(s().total_clawed_back_atomic)}
                          </span>{" "}
                          clawed back
                        </span>
                      </Show>
                    </div>
                  )}
                </Show>
              </section>

              {/* Stats grid */}
              <section class="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                  label="Qualifying earnings"
                  value={b().cumulative_qualifying_count.toLocaleString()}
                  sub={
                    b().tiers.length > 0
                      ? `Tier ${b().current_tier_index + 1} of ${b().tiers.length}`
                      : `Tier ${b().current_tier_index + 1}`
                  }
                />
                <StatCard
                  label="Participants"
                  value={
                    stats()?.participant_count.toLocaleString() ??
                    (statsQuery.isLoading ? "..." : "0")
                  }
                  sub={
                    stats()
                      ? `${stats()?.earner_count.toLocaleString()} earners`
                      : null
                  }
                />
                <StatCard
                  label="Total earned"
                  value={
                    stats()
                      ? formatSerenBucks(stats()?.total_earned_atomic ?? 0)
                      : statsQuery.isLoading
                        ? "..."
                        : "-"
                  }
                  sub={
                    stats()
                      ? `${stats()?.earning_count.toLocaleString()} events`
                      : null
                  }
                />
                <Show
                  when={formatDateTime(b().deadline)}
                  fallback={
                    <StatCard
                      label="Earnings released after"
                      value={`${b().hold_days} day${b().hold_days === 1 ? "" : "s"}`}
                    />
                  }
                >
                  {(label) => (
                    <StatCard
                      label="Deadline"
                      value={label()}
                      sub={`Released after ${b().hold_days}d hold`}
                    />
                  )}
                </Show>
              </section>

              {/* Reward tiers */}
              <Show when={b().tiers.length > 0}>
                <section>
                  <div class="text-[12px] uppercase tracking-[0.14em] text-muted-foreground/70 mb-2">
                    Reward tiers
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <For each={b().tiers}>
                      {(tier, index) => (
                        <TierRow
                          tier={tier}
                          index={index()}
                          currentIndex={b().current_tier_index}
                        />
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              {/* Top earners + Recent activity */}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <section>
                  <div class="flex items-baseline justify-between mb-2">
                    <div class="text-[12px] uppercase tracking-[0.14em] text-muted-foreground/70">
                      Top earners
                    </div>
                    <Show when={leaderboard().length > 0}>
                      <div class="text-[11.5px] text-muted-foreground/60">
                        top {leaderboard().length}
                      </div>
                    </Show>
                  </div>
                  <Show
                    when={leaderboard().length > 0}
                    fallback={
                      <div class="text-[13px] text-muted-foreground/70 italic">
                        {leaderboardQuery.isLoading
                          ? "Loading leaderboard..."
                          : "No earners yet."}
                      </div>
                    }
                  >
                    <div class="flex flex-col gap-1">
                      <For each={leaderboard()}>
                        {(entry, index) => (
                          <div class="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md border border-border/40 bg-surface-2/30">
                            <span class="flex items-center justify-center w-5 h-5 rounded-full bg-surface-3 text-[12px] font-semibold text-muted-foreground shrink-0">
                              {index() + 1}
                            </span>
                            <div class="flex-1 min-w-0">
                              <div
                                class="text-[13px] text-foreground font-mono truncate"
                                title={entry.user_id}
                              >
                                {shortUuid(entry.user_id)}
                              </div>
                              <div class="text-[12.5px] text-muted-foreground/70 tabular-nums">
                                {entry.earning_count.toLocaleString()} earning
                                {entry.earning_count === 1 ? "" : "s"}
                              </div>
                            </div>
                            <div class="text-[13px] font-medium text-foreground tabular-nums">
                              {formatSerenBucks(entry.total_earned_atomic)}
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </section>

                <section>
                  <div class="text-[12px] uppercase tracking-[0.14em] text-muted-foreground/70 mb-2">
                    Recent activity
                  </div>
                  <Show
                    when={earnings().length > 0}
                    fallback={
                      <div class="text-[13px] text-muted-foreground/70 italic">
                        {earningsQuery.isLoading
                          ? "Loading recent earnings..."
                          : "No earnings recorded yet."}
                      </div>
                    }
                  >
                    <div class="flex flex-col gap-1">
                      <For each={earnings()}>
                        {(earning) => (
                          <div class="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md border border-border/40 bg-surface-2/30">
                            <span
                              class={`text-[11.5px] font-semibold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border ${earningStatusTone(earning.status)} shrink-0`}
                            >
                              {earning.status.replace("_", " ")}
                            </span>
                            <div class="flex-1 min-w-0">
                              <div
                                class="text-[12.5px] text-foreground font-mono truncate"
                                title={earning.user_id}
                              >
                                {shortUuid(earning.user_id)}
                              </div>
                              <div class="text-[12.5px] text-muted-foreground/70">
                                {formatRelative(earning.earned_at) ?? "—"}
                              </div>
                            </div>
                            <div class="text-[12.5px] font-medium text-foreground tabular-nums">
                              {formatSerenBucks(earning.tier_rate_atomic)}
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </section>
              </div>

              {/* Submission instructions */}
              <Show
                when={
                  b().submission_instructions ||
                  b().submission_mode !== "disabled"
                }
              >
                <section>
                  <div class="text-[12px] uppercase tracking-[0.14em] text-muted-foreground/70 mb-2">
                    How to submit
                  </div>
                  <Show
                    when={b().submission_instructions}
                    fallback={
                      <p class="text-[13px] text-muted-foreground/80 italic">
                        No instructions provided.
                      </p>
                    }
                  >
                    <p class="text-[13px] leading-relaxed text-foreground/85 whitespace-pre-wrap">
                      {b().submission_instructions}
                    </p>
                  </Show>
                  <div class="text-[12.5px] text-muted-foreground/70 mt-1.5">
                    Submission mode: {b().submission_mode}
                  </div>
                </section>
              </Show>

              {/* Verifier health (footer note when degraded) */}
              <Show
                when={
                  b().health_status !== "healthy" ||
                  b().verifier_failure_count > 0
                }
              >
                <section class="px-3 py-2 rounded-md border border-amber-600/25 bg-amber-500/5 dark:border-amber-500/30">
                  <div class="text-[12px] uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300/90 mb-1">
                    Verifier status
                  </div>
                  <div class="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
                    <Show when={b().verifier_failure_count > 0}>
                      <span>
                        {b().verifier_failure_count.toLocaleString()}{" "}
                        consecutive failure
                        {b().verifier_failure_count === 1 ? "" : "s"}
                      </span>
                    </Show>
                    <Show when={formatRelative(b().verifier_last_success_at)}>
                      {(label) => <span>Last success {label()}</span>}
                    </Show>
                  </div>
                  <Show when={b().verifier_last_error}>
                    <pre class="mt-1.5 px-2 py-1 text-[12.5px] text-status-error/80 bg-background/60 rounded font-mono whitespace-pre-wrap break-words">
                      {b().verifier_last_error}
                    </pre>
                  </Show>
                </section>
              </Show>

              {/* Side-query errors surfaced inline so we can tell when the
                  enrichment endpoints aren't reachable. */}
              <Show when={sideErrors().length > 0}>
                <section class="px-3 py-2 rounded-md border border-status-error/30 bg-status-error/5">
                  <div class="text-[12px] uppercase tracking-[0.14em] text-status-error/90 mb-1">
                    Enrichment unavailable
                  </div>
                  <ul class="text-[12.5px] text-muted-foreground/85 list-disc list-inside space-y-0.5">
                    <For each={sideErrors()}>
                      {(err) => (
                        <li>
                          <span class="font-mono text-muted-foreground">
                            {err.label}
                          </span>
                          : {err.message}
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
};
