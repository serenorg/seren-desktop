// ABOUTME: Public Seren Employee catalog API client for desktop intake surfaces.
// ABOUTME: Fetches role definitions from the website without touching deployed employees.

import { appFetch } from "@/lib/fetch";

export type EmployeeCatalogClusterKey =
  | "office-of-the-ceo"
  | "finance-investment"
  | "revenue-market"
  | "technology-security"
  | "risk-legal-people";

export interface EmployeeCatalogCluster {
  key: EmployeeCatalogClusterKey;
  label: string;
}

export interface EmployeeCatalogItem {
  slug: string;
  title: string;
  cluster: EmployeeCatalogClusterKey;
  seniority: number;
  tagline: string;
  featured: boolean;
  imageUrl: string;
  heroImageUrl: string;
  skillSlug: string;
}

export interface EmployeeCatalog {
  employees: EmployeeCatalogItem[];
  clusters: EmployeeCatalogCluster[];
  total: number;
}

type RawEmployeeCatalogItem = {
  slug?: unknown;
  title?: unknown;
  cluster?: unknown;
  seniority?: unknown;
  tagline?: unknown;
  featured?: unknown;
  image_url?: unknown;
  hero_image_url?: unknown;
  skill_slug?: unknown;
};

type RawEmployeeCatalogResponse = {
  employees?: unknown;
  clusters?: unknown;
  total?: unknown;
};

const CATALOG_URL =
  import.meta.env.VITE_SEREN_EMPLOYEE_CATALOG_URL ??
  "https://serendb.com/api/employees";

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `employee catalog field '${field}' must be a non-empty string`,
    );
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `employee catalog field '${field}' must be a finite number`,
    );
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`employee catalog field '${field}' must be a boolean`);
  }
  return value;
}

function normalizeEmployee(raw: RawEmployeeCatalogItem): EmployeeCatalogItem {
  const slug = asString(raw.slug, "slug");
  return {
    slug,
    title: asString(raw.title, "title"),
    cluster: asString(raw.cluster, "cluster") as EmployeeCatalogClusterKey,
    seniority: asNumber(raw.seniority, "seniority"),
    tagline: asString(raw.tagline, "tagline"),
    featured: asBoolean(raw.featured, "featured"),
    imageUrl: asString(raw.image_url, "image_url"),
    heroImageUrl: asString(raw.hero_image_url, "hero_image_url"),
    skillSlug:
      typeof raw.skill_slug === "string" && raw.skill_slug.length > 0
        ? raw.skill_slug
        : slug,
  };
}

function normalizeCluster(raw: unknown): EmployeeCatalogCluster {
  if (!raw || typeof raw !== "object") {
    throw new Error("employee catalog cluster must be an object");
  }
  const row = raw as { key?: unknown; label?: unknown };
  return {
    key: asString(row.key, "cluster.key") as EmployeeCatalogClusterKey,
    label: asString(row.label, "cluster.label"),
  };
}

export function normalizeEmployeeCatalogResponse(
  raw: RawEmployeeCatalogResponse,
): EmployeeCatalog {
  if (!Array.isArray(raw.employees)) {
    throw new Error("employee catalog response must include employees[]");
  }
  if (!Array.isArray(raw.clusters)) {
    throw new Error("employee catalog response must include clusters[]");
  }

  const employees = raw.employees.map((item) =>
    normalizeEmployee(item as RawEmployeeCatalogItem),
  );
  return {
    employees,
    clusters: raw.clusters.map(normalizeCluster),
    total: typeof raw.total === "number" ? raw.total : employees.length,
  };
}

export async function fetchEmployeeCatalog(): Promise<EmployeeCatalog> {
  const response = await appFetch(CATALOG_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch employee catalog: HTTP ${response.status}`,
    );
  }
  return normalizeEmployeeCatalogResponse(await response.json());
}
