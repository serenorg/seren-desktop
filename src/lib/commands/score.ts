// ABOUTME: Boundary-aware match scorer for slash-command/skill autocomplete.
// ABOUTME: Lower scores rank higher; null means no match. Built for hyphenated slugs.

const BOUNDARY = /[-_/.:\s]/;

/**
 * Score `candidate` against `query`. Returns a non-negative number (lower is
 * better) or `null` when there is no match at all.
 *
 * Tiers, best to worst:
 * - `0`           exact case-insensitive match.
 * - `1`           prefix match (`prophet` over `prophet-arb-bot`).
 * - `2..99`       boundary match — query begins at a word boundary inside the
 *                 candidate. `arb` against `prophet-arb-bot` scores 10 (the
 *                 position of `arb`); earlier boundaries win.
 * - `100..199`    substring match anywhere inside the candidate.
 * - `200..N`      initials match — query letters match the first letter of
 *                 each boundary-delimited segment. `pab` against
 *                 `prophet-arb-bot` scores 200; longer initial chains rank
 *                 slightly worse so the most specific candidate wins.
 *
 * The score function is deliberately simple — no full subsequence matching.
 * It is enough to fix the common pain points without a fuzzy-finder library.
 */
export function scoreCandidate(
  candidate: string,
  query: string,
): number | null {
  if (query === "") return 0;
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (c === q) return 0;
  if (c.startsWith(q)) return 1;
  // Boundary: query begins at a word boundary inside candidate. Earlier
  // positions win so `arb` against `prophet-arb-bot` is preferred over the
  // same substring deep inside a longer candidate.
  for (let i = 1; i < c.length - q.length + 1; i++) {
    const prev = c.charAt(i - 1);
    if (!BOUNDARY.test(prev)) continue;
    if (c.startsWith(q, i)) return 2 + i;
  }
  // Includes: query appears as a substring anywhere else.
  const idx = c.indexOf(q);
  if (idx > 0) return 100 + idx;
  // Initials: query matches the leading letter of each boundary-delimited
  // segment. `pab` against `prophet-arb-bot` yields initials `pab` -> match.
  // Penalise longer initials chains so a tighter candidate ranks first.
  const initials = c
    .split(/[-_/.:\s]+/)
    .map((part) => part.charAt(0))
    .filter((ch) => ch !== "")
    .join("");
  if (initials.length > 0 && initials.startsWith(q)) {
    return 200 + (initials.length - q.length);
  }
  return null;
}

/**
 * Return the better of two optional scores. Used when ranking a candidate
 * across multiple fields (slug, display name) — whichever field is the closer
 * match wins.
 */
export function bestScore(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
