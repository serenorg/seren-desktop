// ABOUTME: Deterministic avatar gradient + initial helpers for employees.
// ABOUTME: Keeps employee identity visually stable without storing image bytes.

const PALETTE: [string, string][] = [
  ["#5b9dff", "#8b5cf6"],
  ["#fbbf24", "#ef4444"],
  ["#10b981", "#06b6d4"],
  ["#f472b6", "#ef4444"],
  ["#a78bfa", "#22d3ee"],
  ["#f59e0b", "#84cc16"],
  ["#34d399", "#3b82f6"],
  ["#fb7185", "#f97316"],
];

const COMBINING_DIACRITICS = /[\u0300-\u036f]/g;

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

export function gradientFor(seed: string): string {
  const [a, b] = PALETTE[hashSeed(seed) % PALETTE.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

export function initialFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.charAt(0).toUpperCase();
}

export function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}
