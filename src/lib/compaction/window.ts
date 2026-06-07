// ABOUTME: Token-budgeted compaction tail selection shared by chat and agent paths (#2104).
// ABOUTME: Replaces fixed preserve counts so one oversized message can't overflow the model.

/**
 * One transcript message reduced to the fields the boundary selector needs.
 * `tokens` is supplied by the caller (content-only today; tool/media-aware
 * accounting lands in #2105 without changing this contract).
 */
export interface CompactionWindowItem {
  /** Estimated token cost of this message. */
  tokens: number;
  /** Coarse role used for latest-user anchoring. */
  role: "user" | "assistant" | "system" | "tool" | "other";
  /**
   * Group key for messages that must not be split across the compaction
   * boundary (e.g. an assistant turn and the tool results it produced).
   * Messages sharing a non-null key are kept together in the preserved tail.
   */
  groupId?: string | null;
}

export interface SelectCompactionWindowOptions {
  /** Total model/agent context window in tokens. */
  contextLimit: number;
  /** Fraction of the window the preserved tail may occupy. Default 0.35. */
  targetTailRatio?: number;
  /** Tokens held back from the tail budget for the model response. Default 0. */
  reservedResponseTokens?: number;
  /** Never preserve fewer than this many tail messages when available. Default 2. */
  minTailMessages?: number;
  /** Absolute ceiling on preserved-tail tokens, regardless of ratio. */
  maxTailTokens?: number;
  /** Force the latest user message into the tail. Default true. */
  anchorLatestUser?: boolean;
}

export interface CompactionWindow {
  /** Preserved tail is `items.slice(cutIndex)`; compacted half is the prefix. */
  cutIndex: number;
  /** Number of preserved tail messages (`items.length - cutIndex`). */
  preserveCount: number;
  /** Estimated tokens in the preserved tail. */
  tailTokens: number;
  /** Token budget the tail was selected against. */
  tailBudget: number;
  /** True when the minimum tail alone exceeded the budget (soft ceiling hit). */
  overBudget: boolean;
}

const DEFAULT_TARGET_TAIL_RATIO = 0.35;
const DEFAULT_MIN_TAIL_MESSAGES = 2;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Snap a cut backward so it never lands inside a tool/turn group. */
function snapToGroupStart(items: CompactionWindowItem[], cut: number): number {
  if (cut <= 0 || cut >= items.length) return cut;
  const g = items[cut].groupId;
  if (g == null) return cut;
  let j = cut;
  while (j > 0 && items[j - 1].groupId === g) j--;
  return j;
}

function sumTokens(items: CompactionWindowItem[], fromIndex: number): number {
  let total = 0;
  for (let i = fromIndex; i < items.length; i++) total += items[i].tokens;
  return total;
}

/**
 * Choose the compaction boundary by token budget instead of a fixed message
 * count. Walks backward from the newest message, preserving messages until the
 * tail budget is hit, while (1) keeping at least `minTailMessages`, (2) never
 * splitting a tool/turn group, and (3) anchoring the latest user message into
 * the tail. The soft ceiling guarantees compaction still runs even when the
 * last message alone exceeds the budget — it just flags `overBudget`.
 */
export function selectCompactionWindow(
  items: CompactionWindowItem[],
  options: SelectCompactionWindowOptions,
): CompactionWindow {
  const n = items.length;
  const targetTailRatio = options.targetTailRatio ?? DEFAULT_TARGET_TAIL_RATIO;
  const reserved = options.reservedResponseTokens ?? 0;
  const anchorLatestUser = options.anchorLatestUser ?? true;
  const minTail =
    n === 0
      ? 0
      : clamp(options.minTailMessages ?? DEFAULT_MIN_TAIL_MESSAGES, 1, n);

  const ratioBudget = Math.max(
    0,
    options.contextLimit * targetTailRatio - reserved,
  );
  const tailBudget = Math.min(
    options.maxTailTokens ?? Number.POSITIVE_INFINITY,
    ratioBudget,
  );

  if (n === 0) {
    return {
      cutIndex: 0,
      preserveCount: 0,
      tailTokens: 0,
      tailBudget,
      overBudget: false,
    };
  }

  // Backward walk: force-include the minimum tail, then keep going while the
  // running tail total stays within budget.
  let cut = n;
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    const countIfIncluded = n - i;
    if (countIfIncluded <= minTail) {
      acc += items[i].tokens;
      cut = i;
      continue;
    }
    if (acc + items[i].tokens <= tailBudget) {
      acc += items[i].tokens;
      cut = i;
    } else {
      break;
    }
  }

  cut = snapToGroupStart(items, cut);

  // Anchor the latest user message: it must be inside the preserved tail so
  // the post-compaction model sees the active request verbatim.
  if (anchorLatestUser) {
    let lastUser = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (items[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    if (lastUser >= 0 && cut > lastUser) {
      cut = snapToGroupStart(items, lastUser);
    }
  }

  const tailTokens = sumTokens(items, cut);
  return {
    cutIndex: cut,
    preserveCount: n - cut,
    tailTokens,
    tailBudget,
    // overBudget reports the soft-ceiling case: the tail we were forced to keep
    // (min floor / latest-user anchor / whole group) costs more than the budget.
    overBudget: tailTokens > tailBudget,
  };
}
