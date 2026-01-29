// ABOUTME: Type definitions for the slash command system.
// ABOUTME: Shared between registry, parser, and UI components.

export interface SlashCommand {
  name: string;
  description: string;
  /** Optional argument hint shown in autocomplete, e.g. "<model-name>" */
  argHint?: string;
  /** Which panels support this command */
  panels: ("chat" | "agent")[];
  /** Execute the command. Returns true if handled (suppress send). */
  execute: (ctx: CommandContext) => boolean | Promise<boolean>;
}

export interface CommandContext {
  /** The full raw input string */
  rawInput: string;
  /** Arguments after the command name */
  args: string;
  /** Which panel invoked the command */
  panel: "chat" | "agent";
  /** Clear the input field */
  clearInput: () => void;
  /** Navigate to an overlay panel */
  openPanel: (panel: string) => void;
  /** Show a transient status message in chat */
  showStatus: (message: string) => void;
}

export interface ParsedCommand {
  command: SlashCommand;
  args: string;
}
