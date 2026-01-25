// ABOUTME: Multi-region support for Seren projects.
// ABOUTME: Defines available regions and utilities for region display.

/**
 * Region definition with display information.
 */
export interface Region {
  id: string;
  name: string;
  location: string;
}

/**
 * Available Seren regions.
 * These match the regions supported by Seren infrastructure.
 */
export const REGIONS: Region[] = [
  { id: "us-east-1", name: "US East", location: "Virginia" },
  { id: "us-west-2", name: "US West", location: "Oregon" },
  { id: "eu-west-1", name: "EU West", location: "Ireland" },
  { id: "ap-southeast-1", name: "Asia Pacific", location: "Singapore" },
];

/**
 * Get human-readable region name from region ID.
 * Returns the ID itself if region not found.
 */
export function getRegionName(id: string): string {
  const region = REGIONS.find((r) => r.id === id);
  return region ? region.name : id;
}

/**
 * Get full region display string (name + location).
 */
export function getRegionDisplay(id: string): string {
  const region = REGIONS.find((r) => r.id === id);
  return region ? `${region.name} (${region.location})` : id;
}

/**
 * Get the default region for new projects.
 */
export function getDefaultRegion(): string {
  return REGIONS[0].id;
}

/**
 * Check if a region ID is valid.
 */
export function isValidRegion(id: string): boolean {
  return REGIONS.some((r) => r.id === id);
}
