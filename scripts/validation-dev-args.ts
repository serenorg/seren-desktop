// ABOUTME: Normalizes package-manager arguments before the validation Tauri launch.
// ABOUTME: Keeps pnpm's separator from being forwarded as an application argument.

export function validationDevArgs(args: string[]): string[] {
  return args[0] === "--" ? args.slice(1) : [...args];
}

export function shouldSkipValidationBuild(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    args.includes("--no-build") ||
    env.SEREN_VALIDATION_SKIP_BUILD === "1"
  );
}

export function removeValidationBuildFlag(args: string[]): string[] {
  return args.filter((argument) => argument !== "--no-build");
}
