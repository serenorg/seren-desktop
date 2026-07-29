// ABOUTME: Shared helpers for staging the embedded Node runtime in the platform prepare scripts.
// ABOUTME: Provides Tauri-safe npm/npx/corepack wrappers and the staged-Node version marker.

import * as fs from 'fs';
import * as path from 'path';

/** Replace an extracted symlink with a regular wrapper without touching its target. */
export function replaceRuntimeShim(wrapperPath: string, contents: string): void {
	fs.rmSync(wrapperPath, { force: true });
	fs.writeFileSync(wrapperPath, contents, { mode: 0o755 });
}

/**
 * Replace the extracted bin/npm, bin/npx and bin/corepack symlinks with shell
 * wrappers.
 *
 * Tauri resolves symlinks into regular files when bundling, which breaks
 * `require('../lib/cli.js')` because the path resolves relative to bin/
 * rather than lib/node_modules/npm/bin/ where the symlink target lives. A shell
 * wrapper computes its own directory at runtime and stays correct whether or
 * not Tauri has dereferenced it. The darwin and linux Node tarballs share this
 * symlink layout; Windows ships real npm.cmd/npx.cmd and needs no shims.
 */
export function ensureRuntimeShims(nodeDir: string): void {
	const npmWrapper = `#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/../lib/node_modules/npm/bin/npm-cli.js" "$@"\n`;
	const npxWrapper = `#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/../lib/node_modules/npm/bin/npx-cli.js" "$@"\n`;
	const corepackWrapper = `#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/../lib/node_modules/corepack/dist/corepack.js" "$@"\n`;
	replaceRuntimeShim(path.join(nodeDir, 'bin', 'npm'), npmWrapper);
	replaceRuntimeShim(path.join(nodeDir, 'bin', 'npx'), npxWrapper);
	replaceRuntimeShim(path.join(nodeDir, 'bin', 'corepack'), corepackWrapper);
	console.log('Replaced bin/npm, bin/npx, and bin/corepack with Tauri-safe shell wrappers.');
}

/**
 * The staged-Node version marker records which Node version was actually
 * extracted into `<outputDir>/node`. The prepare scripts skip the download when
 * that directory exists, and before this marker they had no way to tell a
 * current tree from a stale one — after a NODE_VERSION bump a cached dev
 * staging dir silently shipped the old binary while embedded-runtime.json
 * claimed the new version (#3450).
 *
 * A marker file is used instead of running `<staged node> --version` because
 * the staged binary is not always executable on the staging host (e.g. the
 * linux runtime staged on macOS).
 */
function stagedNodeVersionPath(outputDir: string): string {
	return path.join(outputDir, 'staged-node-version');
}

/** Read the recorded staged Node version, or null when no marker exists. */
export function readStagedNodeVersion(outputDir: string): string | null {
	try {
		return fs.readFileSync(stagedNodeVersionPath(outputDir), 'utf8').trim() || null;
	} catch {
		return null;
	}
}

/**
 * Remove the marker before (re-)staging begins so an interrupted download or
 * extraction can never leave a marker that matches a broken tree.
 */
export function clearStagedNodeVersion(outputDir: string): void {
	fs.rmSync(stagedNodeVersionPath(outputDir), { force: true });
}

/** Record the staged Node version. Call only after staging fully succeeds. */
export function writeStagedNodeVersion(outputDir: string, version: string): void {
	fs.writeFileSync(stagedNodeVersionPath(outputDir), `${version}\n`);
}
