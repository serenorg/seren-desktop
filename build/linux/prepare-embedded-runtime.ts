// ABOUTME: Downloads and prepares Node.js and Git binaries for Linux embedded runtime.
// ABOUTME: Called during the build process to bundle these tools with the Tauri AppImage/deb.

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { pipeline } from 'stream/promises';
import { execSync } from 'child_process';

// Version configuration - update these for new releases
const NODE_VERSION = '22.12.0';
const GIT_VERSION = '2.47.1';

// Node.js download URLs for Linux
const NODE_DOWNLOADS: Record<string, { url: string }> = {
	'x64': {
		url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz`
	},
	'arm64': {
		url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.gz`
	},
	'armhf': {
		url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-armv7l.tar.gz`
	}
};

interface DownloadOptions {
	arch: 'x64' | 'arm64' | 'armhf';
	outputDir: string;
}

async function downloadFile(url: string, dest: string): Promise<void> {
	console.log(`Downloading ${url}...`);

	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(dest);
		const request = https.get(url, (response) => {
			if (response.statusCode === 302 || response.statusCode === 301) {
				// Handle redirect
				file.close();
				fs.unlinkSync(dest);
				downloadFile(response.headers.location!, dest).then(resolve).catch(reject);
				return;
			}

			if (response.statusCode !== 200) {
				reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
				return;
			}

			pipeline(response, file)
				.then(() => resolve())
				.catch(reject);
		});

		request.on('error', (err) => {
			fs.unlinkSync(dest);
			reject(err);
		});
	});
}

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
	console.log(`Extracting ${archivePath} to ${destDir}...`);
	execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
}

async function prepareNodejs(options: DownloadOptions): Promise<string> {
	const { arch, outputDir } = options;
	const nodeConfig = NODE_DOWNLOADS[arch];
	const nodeDir = path.join(outputDir, 'node');

	if (fs.existsSync(nodeDir)) {
		console.log(`Node.js directory already exists at ${nodeDir}, skipping...`);
		return nodeDir;
	}

	fs.mkdirSync(nodeDir, { recursive: true });

	const tarPath = path.join(outputDir, `node-${arch}.tar.gz`);
	await downloadFile(nodeConfig.url, tarPath);

	// Extract to temp directory
	const tempDir = path.join(outputDir, 'node-temp');
	fs.mkdirSync(tempDir, { recursive: true });
	await extractTarGz(tarPath, tempDir);

	// Move contents from extracted folder to nodeDir
	const extractedFolder = fs.readdirSync(tempDir).find(f => f.startsWith('node-'));
	if (extractedFolder) {
		const srcDir = path.join(tempDir, extractedFolder);
		const files = fs.readdirSync(srcDir);
		for (const file of files) {
			fs.renameSync(path.join(srcDir, file), path.join(nodeDir, file));
		}
	}

	// Cleanup
	fs.rmSync(tempDir, { recursive: true, force: true });
	fs.unlinkSync(tarPath);

	console.log(`Node.js prepared at ${nodeDir}`);
	return nodeDir;
}

async function prepareGit(options: DownloadOptions): Promise<string> {
	const { outputDir } = options;
	const gitDir = path.join(outputDir, 'git');

	if (fs.existsSync(gitDir)) {
		console.log(`Git directory already exists at ${gitDir}, skipping...`);
		return gitDir;
	}

	// On Linux, we create a wrapper that uses system git
	// Building git from source requires many dependencies
	// Most Linux distributions have git available via package manager

	fs.mkdirSync(path.join(gitDir, 'bin'), { recursive: true });

	// Create a wrapper script that falls back to system git
	const gitWrapper = `#!/bin/bash
# ABOUTME: Wrapper for git - uses system git if available
# ABOUTME: Ensures git works even if not separately bundled

if command -v /usr/bin/git &> /dev/null; then
	exec /usr/bin/git "$@"
elif command -v /usr/local/bin/git &> /dev/null; then
	exec /usr/local/bin/git "$@"
else
	echo "Error: Git not found. Please install git via your package manager (apt, dnf, pacman, etc.)." >&2
	exit 1
fi
`;

	fs.writeFileSync(path.join(gitDir, 'bin', 'git'), gitWrapper, { mode: 0o755 });

	console.log(`Git wrapper prepared at ${gitDir}`);
	return gitDir;
}

export async function prepareEmbeddedRuntime(arch: 'x64' | 'arm64' | 'armhf', outputDir: string): Promise<{ nodeDir: string; gitDir: string }> {
	console.log(`Preparing embedded runtime for Linux ${arch}...`);

	fs.mkdirSync(outputDir, { recursive: true });

	const [nodeDir, gitDir] = await Promise.all([
		prepareNodejs({ arch, outputDir }),
		prepareGit({ arch, outputDir })
	]);

	// Create a version file for tracking
	const versionInfo = {
		node: NODE_VERSION,
		git: GIT_VERSION,
		arch,
		platform: 'linux',
		preparedAt: new Date().toISOString()
	};
	fs.writeFileSync(
		path.join(outputDir, 'embedded-runtime.json'),
		JSON.stringify(versionInfo, null, 2)
	);

	console.log('Embedded runtime prepared successfully.');
	return { nodeDir, gitDir };
}

// CLI entry point
if (require.main === module) {
	const arch = (process.argv[2] as 'x64' | 'arm64' | 'armhf') || 'x64';
	const outputDir = process.argv[3] || path.join(process.cwd(), '.build', 'embedded-runtime', `linux-${arch}`);

	prepareEmbeddedRuntime(arch, outputDir)
		.then(() => process.exit(0))
		.catch((err) => {
			console.error('Failed to prepare embedded runtime:', err);
			process.exit(1);
		});
}
