// ABOUTME: CLI installer store for managing auto-installation of Claude Code, Codex, and other CLIs
// ABOUTME: Handles detection, downloading, and installation with progress tracking

import { createStore } from "solid-js/store";

export type CliTool = "claude" | "codex";

export type InstallStatus =
	| "idle"
	| "checking"
	| "not_installed"
	| "downloading"
	| "installing"
	| "installed"
	| "error";

interface CliInstallState {
	tool: CliTool;
	status: InstallStatus;
	progressPercent: number;
	downloadedBytes: number;
	totalBytes: number;
	errorMessage?: string;
}

interface CliInstallerState {
	tools: Record<CliTool, CliInstallState>;
}

const initialState: CliInstallerState = {
	tools: {
		claude: {
			tool: "claude",
			status: "idle",
			progressPercent: 0,
			downloadedBytes: 0,
			totalBytes: 0,
		},
		codex: {
			tool: "codex",
			status: "idle",
			progressPercent: 0,
			downloadedBytes: 0,
			totalBytes: 0,
		},
	},
};

const [state, setState] = createStore<CliInstallerState>(initialState);

export const cliInstallerStore = {
	get state() {
		return state;
	},

	/**
	 * Check if a CLI tool is installed
	 */
	async checkInstalled(tool: CliTool): Promise<boolean> {
		setState("tools", tool, "status", "checking");

		try {
			const { invoke } = await import("@tauri-apps/api/core");
			const installed = await invoke<boolean>("check_cli_installed", { tool });

			setState("tools", tool, "status", installed ? "installed" : "not_installed");
			return installed;
		} catch (error) {
			console.error(`[CliInstaller] Failed to check ${tool} installation:`, error);
			setState("tools", tool, {
				status: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	},

	/**
	 * Install a CLI tool
	 */
	async install(tool: CliTool): Promise<boolean> {
		console.log(`[CliInstaller] Starting installation of ${tool}...`);
		setState("tools", tool, {
			status: "downloading",
			progressPercent: 0,
			downloadedBytes: 0,
			totalBytes: 0,
			errorMessage: undefined,
		});

		try {
			const { invoke } = await import("@tauri-apps/api/core");
			const success = await invoke<boolean>("install_cli_tool", { tool });

			if (success) {
				setState("tools", tool, "status", "installed");
				console.log(`[CliInstaller] ${tool} installed successfully`);
			} else {
				setState("tools", tool, {
					status: "error",
					errorMessage: "Installation failed",
				});
			}

			return success;
		} catch (error) {
			console.error(`[CliInstaller] Failed to install ${tool}:`, error);
			setState("tools", tool, {
				status: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	},

	/**
	 * Update installation progress (called by Tauri events)
	 */
	updateProgress(tool: CliTool, downloaded: number, total: number) {
		const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
		setState("tools", tool, {
			progressPercent: percent,
			downloadedBytes: downloaded,
			totalBytes: total,
		});
	},

	/**
	 * Set installation status (called by Tauri events)
	 */
	setStatus(tool: CliTool, status: InstallStatus) {
		setState("tools", tool, "status", status);
	},

	/**
	 * Set error message
	 */
	setError(tool: CliTool, message: string) {
		setState("tools", tool, {
			status: "error",
			errorMessage: message,
		});
	},

	/**
	 * Reset installation state
	 */
	reset(tool: CliTool) {
		setState("tools", tool, {
			status: "idle",
			progressPercent: 0,
			downloadedBytes: 0,
			totalBytes: 0,
			errorMessage: undefined,
		});
	},
};
