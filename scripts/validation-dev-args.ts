// ABOUTME: Normalizes package-manager arguments before the validation Tauri launch.
// ABOUTME: Keeps pnpm's separator from being forwarded as an application argument.

export function validationDevArgs(args: string[]): string[] {
  return args[0] === "--" ? args.slice(1) : [...args];
}
