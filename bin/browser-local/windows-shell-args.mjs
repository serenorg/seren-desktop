// ABOUTME: Windows cmd.exe argument quoting helpers for provider-runtime child processes.
// ABOUTME: Keeps shell=true process launches from splitting structured config args.

export function quoteWindowsShellArg(arg) {
  const value = String(arg);
  if (value.length === 0) return '""';

  return `"${value
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, "$1$1")}"`;
}

export function composeWindowsShellCommand(command, args = []) {
  return [command, ...args].map((arg) => quoteWindowsShellArg(arg)).join(" ");
}
