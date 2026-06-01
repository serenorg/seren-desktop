// ABOUTME: Downloads and prepares the Windows embeddable CPython distribution.
// ABOUTME: Bundles Python with the Tauri installer so skills work without a system install.

import { execSync } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import { pipeline } from "stream/promises";
import { pathToFileURL } from "node:url";

// Version configuration — keep this pinned. The Python freshness workflow
// (.github/workflows/check-python-version.yml) opens a PR to bump the patch
// version monthly; minor-version bumps (3.12 → 3.13) stay manual because
// wheel availability for skills' transitive deps may lag a release.
const PYTHON_VERSION = "3.12.10";

interface DownloadConfig {
	url: string;
	pthFile: string;
}

function downloadConfig(arch: "x64" | "arm64"): DownloadConfig {
	const archSlug = arch === "x64" ? "amd64" : "arm64";
	return {
		url: `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-${archSlug}.zip`,
		// e.g. python312._pth — derived from the major.minor version
		pthFile: `python${PYTHON_VERSION.split(".").slice(0, 2).join("")}._pth`,
	};
}

const GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py";

interface PrepareOptions {
	arch: "x64" | "arm64";
	outputDir: string;
}

async function downloadFile(url: string, dest: string): Promise<void> {
	console.log(`Downloading ${url}...`);

	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(dest);
		const request = https.get(url, (response) => {
			if (response.statusCode === 302 || response.statusCode === 301) {
				file.close();
				fs.unlinkSync(dest);
				downloadFile(response.headers.location!, dest)
					.then(resolve)
					.catch(reject);
				return;
			}

			if (response.statusCode !== 200) {
				reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
				return;
			}

			pipeline(response, file).then(() => resolve()).catch(reject);
		});

		request.on("error", (err) => {
			if (fs.existsSync(dest)) fs.unlinkSync(dest);
			reject(err);
		});
	});
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
	console.log(`Extracting ${zipPath} to ${destDir}...`);
	const command = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
	execSync(command, { stdio: "inherit" });
}

/**
 * The official Windows embeddable Python ships with site-packages disabled —
 * the bundled `python3X._pth` file has `import site` commented out, which
 * keeps `pip` from working. Uncomment it so `python -m venv` and
 * `python -m pip` resolve through the standard site initialization.
 *
 * Exported for tests so the rewrite logic is unit-testable without a real
 * Python install.
 */
export function enableSitePackages(pthContents: string): string {
	const lines = pthContents.split(/\r?\n/);
	const rewritten = lines.map((line) => {
		const trimmed = line.trim();
		if (trimmed === "#import site" || trimmed === "# import site") {
			return "import site";
		}
		return line;
	});
	// If the file already has `import site` uncommented, leave it alone.
	// If it has no `import site` line at all (unlikely but possible across
	// patch versions), append one — the embed package contract is that the
	// file is the only path config python.exe reads at boot.
	const hasUncommented = rewritten.some((l) => l.trim() === "import site");
	if (!hasUncommented) {
		rewritten.push("import site");
	}
	return rewritten.join("\n");
}

async function installPip(pythonDir: string): Promise<void> {
	console.log(`Bootstrapping pip in ${pythonDir}...`);
	const getPipPath = path.join(pythonDir, "get-pip.py");
	await downloadFile(GET_PIP_URL, getPipPath);

	const pythonExe = path.join(pythonDir, "python.exe");
	execSync(
		`"${pythonExe}" "${getPipPath}" --no-warn-script-location --disable-pip-version-check`,
		{ stdio: "inherit" },
	);

	fs.unlinkSync(getPipPath);
}

async function preparePython(options: PrepareOptions): Promise<string> {
	const { arch, outputDir } = options;
	const cfg = downloadConfig(arch);
	const pythonDir = path.join(outputDir, "python");

	if (fs.existsSync(pythonDir)) {
		console.log(`Python directory already exists at ${pythonDir}, skipping...`);
		return pythonDir;
	}

	fs.mkdirSync(pythonDir, { recursive: true });

	const zipPath = path.join(outputDir, `python-${arch}.zip`);
	await downloadFile(cfg.url, zipPath);
	await extractZip(zipPath, pythonDir);

	// Enable site-packages so pip and venv work out of the box.
	const pthPath = path.join(pythonDir, cfg.pthFile);
	if (fs.existsSync(pthPath)) {
		const original = fs.readFileSync(pthPath, "utf-8");
		fs.writeFileSync(pthPath, enableSitePackages(original));
	} else {
		console.warn(`[prepare-python-runtime] Expected ${cfg.pthFile} not found; pip may not work.`);
	}

	// Provide a `python3.exe` alias alongside `python.exe`. Skills written
	// for Linux/macOS invoke `python3` directly; without the alias the
	// agent has to translate every invocation. The Windows embed package
	// only ships `python.exe`, so we copy it as `python3.exe` — CPython
	// doesn't dispatch on argv[0] on Windows, the two names behave
	// identically. Costs ~25 KB on disk (the executable is a thin
	// launcher; the heavy bits live in `python3X.dll`, which is shared).
	const pythonExe = path.join(pythonDir, "python.exe");
	const python3Exe = path.join(pythonDir, "python3.exe");
	if (fs.existsSync(pythonExe) && !fs.existsSync(python3Exe)) {
		fs.copyFileSync(pythonExe, python3Exe);
	}

	// Bootstrap pip into the embedded interpreter so skills can run
	// `python -m venv .venv && pip install -r requirements.txt` directly.
	// Only run pip install when the build host can execute the downloaded
	// python.exe — i.e. the host is Windows. Cross-platform CI prepares
	// the zip extraction only; pip install happens on the Windows runner.
	if (process.platform === "win32") {
		await installPip(pythonDir);
	} else {
		console.log(
			"[prepare-python-runtime] Skipping pip bootstrap on non-Windows host — " +
				"the embedded python.exe cannot execute here. The Windows release runner " +
				"will run this script and install pip.",
		);
	}

	fs.unlinkSync(zipPath);

	console.log(`Python prepared at ${pythonDir}`);
	return pythonDir;
}

export async function preparePythonRuntime(
	arch: "x64" | "arm64",
	outputDir: string,
): Promise<{ pythonDir: string }> {
	console.log(`Preparing embedded Python runtime for Windows ${arch}...`);

	fs.mkdirSync(outputDir, { recursive: true });
	const pythonDir = await preparePython({ arch, outputDir });

	const manifestPath = path.join(outputDir, "embedded-python.json");
	const manifest = {
		python: PYTHON_VERSION,
		arch,
		platform: "win32",
		preparedAt: new Date().toISOString(),
		pipBootstrapped: process.platform === "win32",
	};
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

	console.log("Embedded Python runtime prepared successfully.");
	return { pythonDir };
}

// Cross-platform check for "this module was invoked as a CLI". On Windows,
// `import.meta.url` is `file:///D:/.../prepare-python-runtime.ts` (POSIX
// slashes, three slashes after `file:`) while `process.argv[1]` is a
// backslash path with a drive letter — naive string-concat comparisons miss
// every Windows invocation and the script exits as a silent no-op, leaving
// `embedded-runtime/win32-x64/python/` empty in every Windows installer
// (serenorg/seren-desktop#2053). `pathToFileURL` normalises both forms.
//
// Exported for the regression test in `tests/unit/prepare-python-cli-detection.test.ts`.
export function isInvokedAsCli(
	importMetaUrl: string,
	argv1: string | undefined,
): boolean {
	if (!argv1) return false;
	try {
		return importMetaUrl === pathToFileURL(argv1).href;
	} catch {
		return false;
	}
}

// CLI entry point (ESM compatible). Mirrors prepare-embedded-runtime.ts so
// `pnpm prepare:python:win32-<arch>` writes alongside the Node bundle.
if (isInvokedAsCli(import.meta.url, process.argv[1])) {
	const arch = (process.argv[2] as "x64" | "arm64") || "x64";
	const outputDir =
		process.argv[3] ||
		path.join(process.cwd(), "src-tauri", "embedded-runtime", `win32-${arch}`);

	preparePythonRuntime(arch, outputDir)
		.then(() => process.exit(0))
		.catch((err) => {
			console.error("Failed to prepare embedded Python runtime:", err);
			process.exit(1);
		});
}

export { PYTHON_VERSION };
