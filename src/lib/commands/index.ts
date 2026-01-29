// ABOUTME: Barrel export for the slash commands module.
// ABOUTME: Ensures registry is initialized when any command API is imported.

export { getCompletions, parseCommand } from "./parser";
export { registry } from "./registry";
export type { CommandContext, ParsedCommand, SlashCommand } from "./types";
