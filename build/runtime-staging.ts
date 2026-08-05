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
 * A staged-component version marker records which version of a runtime
 * component (node, git, python) was actually extracted into
 * `<outputDir>/<component>`. The prepare scripts skip the download when that
 * directory exists, and without a marker they cannot tell a complete tree
 * from a stale one (#3450) or from an interrupted extraction that left the
 * directory behind (#3697) — either way the broken tree latches forever.
 *
 * A marker file is used instead of running the staged binary because it is
 * not always executable on the staging host (e.g. the linux runtime staged
 * on macOS).
 */
function stagedComponentVersionPath(outputDir: string, component: string): string {
	return path.join(outputDir, `staged-${component}-version`);
}

/** Read the recorded staged component version, or null when no marker exists. */
export function readStagedComponentVersion(outputDir: string, component: string): string | null {
	try {
		return fs.readFileSync(stagedComponentVersionPath(outputDir, component), 'utf8').trim() || null;
	} catch {
		return null;
	}
}

/**
 * Remove the marker before (re-)staging begins so an interrupted download or
 * extraction can never leave a marker that matches a broken tree.
 */
export function clearStagedComponentVersion(outputDir: string, component: string): void {
	fs.rmSync(stagedComponentVersionPath(outputDir, component), { force: true });
}

/** Record the staged component version. Call only after staging fully succeeds. */
export function writeStagedComponentVersion(
	outputDir: string,
	component: string,
	version: string
): void {
	fs.writeFileSync(stagedComponentVersionPath(outputDir, component), `${version}\n`);
}

/** Read the recorded staged Node version, or null when no marker exists. */
export function readStagedNodeVersion(outputDir: string): string | null {
	return readStagedComponentVersion(outputDir, 'node');
}

/**
 * Remove the marker before (re-)staging begins so an interrupted download or
 * extraction can never leave a marker that matches a broken tree.
 */
export function clearStagedNodeVersion(outputDir: string): void {
	clearStagedComponentVersion(outputDir, 'node');
}

/** Record the staged Node version. Call only after staging fully succeeds. */
export function writeStagedNodeVersion(outputDir: string, version: string): void {
	writeStagedComponentVersion(outputDir, 'node', version);
}
