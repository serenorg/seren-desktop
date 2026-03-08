// ABOUTME: Native folder/file dialog helpers for browser-local runtime.
// ABOUTME: Uses platform CLI tools so the local browser mode stays dependency-light.

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { dirname } from "node:path";

const os = platform();

function exec(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60_000 }, (error, stdout) => {
      if (error) {
        if (error.code === 1 || error.killed) {
          resolve("");
          return;
        }
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function openFolderDialog() {
  if (os === "darwin") {
    const result = await exec("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Select Project Folder")',
    ]);
    return result || null;
  }

  if (os === "linux") {
    const result = await exec("zenity", [
      "--file-selection",
      "--directory",
      "--title=Select Project Folder",
    ]);
    return result || null;
  }

  if (os === "win32") {
    const result = await exec("powershell", [
      "-NoProfile",
      "-Command",
      "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }",
    ]);
    return result || null;
  }

  throw new Error(`Unsupported platform: ${os}`);
}

export async function openFileDialog() {
  if (os === "darwin") {
    const result = await exec("osascript", [
      "-e",
      'POSIX path of (choose file with prompt "Select File")',
    ]);
    return result || null;
  }

  if (os === "linux") {
    const result = await exec("zenity", [
      "--file-selection",
      "--title=Select File",
    ]);
    return result || null;
  }

  if (os === "win32") {
    const result = await exec("powershell", [
      "-NoProfile",
      "-Command",
      "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $f = New-Object System.Windows.Forms.OpenFileDialog; if ($f.ShowDialog() -eq 'OK') { $f.FileName }",
    ]);
    return result || null;
  }

  throw new Error(`Unsupported platform: ${os}`);
}

export async function saveFileDialog({ defaultPath } = {}) {
  if (os === "darwin") {
    const script = defaultPath
      ? `POSIX path of (choose file name with prompt "Save File" default name "${defaultPath}")`
      : 'POSIX path of (choose file name with prompt "Save File")';
    const result = await exec("osascript", ["-e", script]);
    return result || null;
  }

  if (os === "linux") {
    const args = ["--file-selection", "--save", "--title=Save File"];
    if (defaultPath) {
      args.push(`--filename=${defaultPath}`);
    }
    const result = await exec("zenity", args);
    return result || null;
  }

  if (os === "win32") {
    const result = await exec("powershell", [
      "-NoProfile",
      "-Command",
      "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $f = New-Object System.Windows.Forms.SaveFileDialog; if ($f.ShowDialog() -eq 'OK') { $f.FileName }",
    ]);
    return result || null;
  }

  throw new Error(`Unsupported platform: ${os}`);
}

export async function revealInFileManager({ path }) {
  if (os === "darwin") {
    await exec("open", ["-R", path]);
    return;
  }

  if (os === "linux") {
    await exec("xdg-open", [dirname(path)]);
    return;
  }

  if (os === "win32") {
    await exec("explorer", [`/select,${path}`]);
    return;
  }

  throw new Error(`Unsupported platform: ${os}`);
}
