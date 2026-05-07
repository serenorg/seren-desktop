// ABOUTME: Cross-component trigger for the skills publish modals.
// ABOUTME: Lets the editor header and the sidebar both request the same flow.

import { createSignal } from "solid-js";

const [firstPublishPath, setFirstPublishPath] = createSignal<string | null>(
  null,
);
const [versionPublishPath, setVersionPublishPath] = createSignal<string | null>(
  null,
);

/**
 * Drives whichever publish modal is currently open. The skill object itself
 * is looked up by `path` against `skillsStore.installed` at render time so
 * stale references can't survive a refresh.
 */
export const skillPublishStore = {
  /** Path of the skill awaiting first-time publish, or null. */
  get firstPublishPath(): string | null {
    return firstPublishPath();
  },
  /** Path of the skill awaiting a new-version publish, or null. */
  get versionPublishPath(): string | null {
    return versionPublishPath();
  },
  /** Open the first-time publish modal for the skill at this path. */
  requestFirstPublish(path: string): void {
    setFirstPublishPath(path);
  },
  /** Open the new-version publish modal for the skill at this path. */
  requestVersionPublish(path: string): void {
    setVersionPublishPath(path);
  },
  clearFirstPublish(): void {
    setFirstPublishPath(null);
  },
  clearVersionPublish(): void {
    setVersionPublishPath(null);
  },
};
