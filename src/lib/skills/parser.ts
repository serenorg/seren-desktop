// ABOUTME: Parser for SKILL.md files with YAML frontmatter.
// ABOUTME: Extracts name and description per the Agent Skills spec.

import type { SkillMetadata } from "./types";

/**
 * Result of parsing a SKILL.md file.
 */
export interface ParsedSkill {
  metadata: SkillMetadata;
  content: string;
  rawContent: string;
}

const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Frontmatter is delimited by --- at the start of the file.
 */
export function parseSkillMd(rawContent: string): ParsedSkill {
  const trimmed = rawContent.trim();

  // Check for frontmatter delimiter
  if (!trimmed.startsWith("---")) {
    // No frontmatter, treat entire content as the skill description
    return {
      metadata: extractMetadataFromContent(trimmed),
      content: trimmed,
      rawContent,
    };
  }

  // Find the closing delimiter
  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    // No closing delimiter, treat as no frontmatter
    return {
      metadata: extractMetadataFromContent(trimmed),
      content: trimmed,
      rawContent,
    };
  }

  const frontmatter = trimmed.slice(3, endIndex).trim();
  const content = trimmed.slice(endIndex + 3).trim();

  const metadata = parseYamlFrontmatter(frontmatter);

  // If no name in frontmatter, try to extract from content heading
  if (!metadata.name) {
    const nameFromContent = extractSkillHeading(content);
    if (nameFromContent) {
      metadata.name = nameFromContent;
    }
  }

  return {
    metadata,
    content,
    rawContent,
  };
}

/**
 * Parse YAML-like frontmatter into metadata.
 * Extracts only spec-required fields: name and description.
 * Other fields (version, author, tags) come from the skills catalog API.
 */
function parseYamlFrontmatter(yaml: string): SkillMetadata {
  const metadata: SkillMetadata = {
    name: "",
    description: "",
  };

  const lines = yaml.split("\n");
  let currentKey: string | null = null;
  let inArray = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines, comments, and indented lines (metadata sub-keys)
    if (!trimmedLine || trimmedLine.startsWith("#") || line.startsWith(" ")) {
      continue;
    }

    // Check for array item
    if (trimmedLine.startsWith("- ") && currentKey && inArray) {
      const value = trimmedLine
        .slice(2)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (currentKey === "tags") {
        metadata.tags = [...(metadata.tags ?? []), value];
      }
      if (currentKey === "requires") {
        metadata.requires = [...(metadata.requires ?? []), value];
      }
      if (currentKey === "globs") {
        metadata.globs = [...(metadata.globs ?? []), value];
      }
      if (currentKey === "alwaysAllow") {
        metadata.alwaysAllow = [...(metadata.alwaysAllow ?? []), value];
      }
      continue;
    }

    // Check for key-value pair
    const colonIndex = trimmedLine.indexOf(":");
    if (colonIndex > 0) {
      const key = trimmedLine.slice(0, colonIndex).trim();
      const value = trimmedLine.slice(colonIndex + 1).trim();
      currentKey = key;

      // Check if this is the start of an array (empty value or explicit array)
      if (!value || value === "[]") {
        inArray = true;
        if (key === "tags") metadata.tags = [];
        if (key === "requires") metadata.requires = [];
        if (key === "globs") metadata.globs = [];
        if (key === "alwaysAllow") metadata.alwaysAllow = [];
        continue;
      }

      inArray = false;

      // Handle inline arrays [item1, item2]
      if (value.startsWith("[") && value.endsWith("]")) {
        const items = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);

        if (key === "tags") metadata.tags = items;
        if (key === "requires") metadata.requires = items;
        if (key === "globs") metadata.globs = items;
        if (key === "alwaysAllow") metadata.alwaysAllow = items;
        continue;
      }

      // Handle scalar values
      const cleanValue = value.replace(/^["']|["']$/g, "");

      switch (key) {
        case "name":
          metadata.name = cleanValue;
          break;
        case "description":
          metadata.description = cleanValue;
          break;
        case "version":
          metadata.version = cleanValue;
          break;
        case "author":
          metadata.author = cleanValue;
          break;
      }
    }
  }

  return metadata;
}

/**
 * Extract metadata from content when no frontmatter is present.
 * Uses the first heading as name and first paragraph as description.
 */
function extractMetadataFromContent(content: string): SkillMetadata {
  const name = extractSkillHeading(content) || "Unnamed Skill";
  const description = extractDescriptionFromContent(content) || "";

  return {
    name,
    description,
  };
}

/**
 * Extract the skill name from the first markdown heading.
 */
export function extractSkillHeading(content: string): string | null {
  const headingMatch = content.match(/^#\s+(.+)$/m);
  return headingMatch ? headingMatch[1].trim() : null;
}

function humanizeSlug(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Resolve a human-friendly skill name.
 * Prefers Markdown H1, then metadata name, then fallback slug.
 */
export function resolveSkillDisplayName(
  parsed: ParsedSkill,
  fallbackSlug?: string,
): string {
  const heading = extractSkillHeading(parsed.content);
  if (heading) {
    return heading;
  }

  const metadataName = parsed.metadata.name?.trim();
  if (metadataName) {
    return SKILL_SLUG_PATTERN.test(metadataName)
      ? humanizeSlug(metadataName)
      : metadataName;
  }

  if (fallbackSlug) {
    return humanizeSlug(fallbackSlug);
  }

  return "Unnamed Skill";
}

/**
 * Extract description from the first non-heading paragraph.
 */
function extractDescriptionFromContent(content: string): string | null {
  const lines = content.split("\n");
  let foundHeading = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Skip headings
    if (trimmed.startsWith("#")) {
      foundHeading = true;
      continue;
    }

    // Return first non-heading, non-empty line after a heading
    if (foundHeading && trimmed) {
      return trimmed;
    }
  }

  return null;
}

/**
 * Compute SHA-256 hash of content for change detection.
 */
export async function computeContentHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
