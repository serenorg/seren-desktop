// ABOUTME: Helpers for resolving BYOC gateway publishers to OAuth providers.
// ABOUTME: Keeps chat connect prompts and Settings reconnect state aligned.

export interface OAuthProviderRef {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
}

export interface LinkedOAuthPublisherRef {
  slug: string;
  name?: string | null;
}

export interface KnownOAuthProvider {
  providerSlug: string;
  providerName: string;
}

const KNOWN_OAUTH_PROVIDER_BY_PUBLISHER: Record<string, KnownOAuthProvider> = {
  calendar: { providerSlug: "google", providerName: "Google" },
  "github-api": { providerSlug: "github", providerName: "GitHub" },
  gmail: { providerSlug: "google", providerName: "Google" },
  "google-calendar": { providerSlug: "google", providerName: "Google" },
  "google-meet": { providerSlug: "google", providerName: "Google" },
  googlecalendar: { providerSlug: "google", providerName: "Google" },
  googlemeet: { providerSlug: "google", providerName: "Google" },
};

const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  api: "API",
  github: "GitHub",
  gmail: "Gmail",
  google: "Google",
  oauth: "OAuth",
};

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v))));
}

export function humanizeOAuthProviderSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      return (
        DISPLAY_NAME_OVERRIDES[lower] ??
        `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`
      );
    })
    .join(" ");
}

export function getKnownOAuthProviderForPublisher(
  publisherSlug: string,
): KnownOAuthProvider | null {
  return KNOWN_OAUTH_PROVIDER_BY_PUBLISHER[publisherSlug.toLowerCase()] ?? null;
}

export function getExpiredOAuthProviderSlugs(
  publisherSlug: string,
  providers: OAuthProviderRef[],
  byProvider: Record<string, LinkedOAuthPublisherRef[]>,
): string[] {
  const directProviderSlug = providers.find(
    (provider) => provider.slug === publisherSlug,
  )?.slug;
  const slugs = [directProviderSlug];

  for (const [providerId, linkedPublishers] of Object.entries(byProvider)) {
    if (
      !linkedPublishers.some((publisher) => publisher.slug === publisherSlug)
    ) {
      continue;
    }
    const provider = providers.find((item) => item.id === providerId);
    slugs.push(provider?.slug);
  }

  const known = getKnownOAuthProviderForPublisher(publisherSlug);
  slugs.push(known?.providerSlug);

  return uniqueNonEmpty(slugs).length > 0
    ? uniqueNonEmpty(slugs)
    : [publisherSlug];
}

export function isOAuthProviderExpired(
  providerSlug: string,
  providerId: string,
  byProvider: Record<string, LinkedOAuthPublisherRef[]>,
  expiredSlugs: Iterable<string>,
): boolean {
  const expired = new Set(expiredSlugs);
  if (expired.has(providerSlug)) return true;
  const linkedPublishers = byProvider[providerId] ?? [];
  return linkedPublishers.some((publisher) => expired.has(publisher.slug));
}
