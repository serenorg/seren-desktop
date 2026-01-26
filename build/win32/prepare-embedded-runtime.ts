// ABOUTME: Downloads and prepares Node.js and Git binaries for Windows embedded runtime.
// ABOUTME: Called during the build process to bundle these tools with the Tauri installer.

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { pipeline } from 'stream/promises';
import { execSync } from 'child_process';

// Version configuration - update these for new releases
const NODE_VERSION = '22.12.0';
const GIT_VERSION = '2.47.1';

// Node.js download URLs for Windows
const NODE_DOWNLOADS: Record<string, { url: string }> = {
	'x64': {
		url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`
	},
	'arm64': {
		url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-arm64.zip`
	}
};

// Git for Windows portable download URLs
const GIT_DOWNLOADS: Record<string, { url: string }> = {
	'x64': {
		url: `https://github.com/git-for-windows/git/releases/download/v${GIT_VERSION}.windows.1/PortableGit-${GIT_VERSION}-64-bit.7z.exe`
	},
	'arm64': {
		// ARM64 uses x64 emulation for now - Git for Windows doesn't have native ARM64 yet
		url: `https://github.com/git-for-windows/git/releases/download/v${GIT_VERSION}.windows.1/PortableGit-${GIT_VERSION}-64-bit.7z.exe`
	}
};

interface DownloadOptions {
	arch: 'x64' | 'arm64';
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

async function extractZip(zipPath: string, destDir: string): Promise<void> {
	console.log(`Extracting ${zipPath} to ${destDir}...`);

	// Use PowerShell to extract zip on Windows
	const command = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
	execSync(command, { stdio: 'inherit' });
}

async function extract7z(archivePath: string, destDir: string): Promise<void> {
	console.log(`Extracting ${archivePath} to ${destDir}...`);

	// PortableGit is a self-extracting archive, run it with -o to specify output
	const command = `"${archivePath}" -o"${destDir}" -y`;
	execSync(command, { stdio: 'inherit' });
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

	const zipPath = path.join(outputDir, `node-${arch}.zip`);
	await downloadFile(nodeConfig.url, zipPath);

	// Extract to temp directory
	const tempDir = path.join(outputDir, 'node-temp');
	fs.mkdirSync(tempDir, { recursive: true });
	await extractZip(zipPath, tempDir);

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
	fs.unlinkSync(zipPath);

	console.log(`Node.js prepared at ${nodeDir}`);
	return nodeDir;
}

async function prepareGit(options: DownloadOptions): Promise<string> {
	const { arch, outputDir } = options;
	const gitConfig = GIT_DOWNLOADS[arch];
	const gitDir = path.join(outputDir, 'git');

	if (fs.existsSync(gitDir)) {
		console.log(`Git directory already exists at ${gitDir}, skipping...`);
		return gitDir;
	}

	fs.mkdirSync(gitDir, { recursive: true });

	const archivePath = path.join(outputDir, `git-${arch}.7z.exe`);
	await downloadFile(gitConfig.url, archivePath);

	// Extract using the self-extracting archive
	await extract7z(archivePath, gitDir);

	// Cleanup
	fs.unlinkSync(archivePath);

	console.log(`Git prepared at ${gitDir}`);
	return gitDir;
}

export async function prepareEmbeddedRuntime(arch: 'x64' | 'arm64', outputDir: string): Promise<{ nodeDir: string; gitDir: string }> {
	console.log(`Preparing embedded runtime for Windows ${arch}...`);

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
		platform: 'win32',
		preparedAt: new Date().toISOString()
	};
	fs.writeFileSync(
		path.join(outputDir, 'embedded-runtime.json'),
		JSON.stringify(versionInfo, null, 2)
	);

	console.log('Embedded runtime prepared successfully.');
	return { nodeDir, gitDir };
}

// CLI entry point (ESM compatible)
const arch = (process.argv[2] as 'x64' | 'arm64') || 'x64';
const outputDir = process.argv[3] || path.join(process.cwd(), 'src-tauri', 'embedded-runtime', `win32-${arch}`);

prepareEmbeddedRuntime(arch, outputDir)
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('Failed to prepare embedded runtime:', err);
		process.exit(1);
	});
