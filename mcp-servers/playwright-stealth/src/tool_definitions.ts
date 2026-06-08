// ABOUTME: MCP tool schema builders shared between the server and tests.
// ABOUTME: Keeps tool contract changes covered without starting the stdio server.

export const NAVIGATION_WAIT_UNTIL_VALUES = [
  "load",
  "domcontentloaded",
  "networkidle",
] as const;

export type NavigationWaitUntil = (typeof NAVIGATION_WAIT_UNTIL_VALUES)[number];

export type NavigateOptions = {
  waitUntil?: NavigationWaitUntil;
  timeout?: number;
};

export function createNavigateToolDefinition() {
  return {
    name: "playwright_navigate",
    description: "Navigate to a URL with stealth features enabled",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to navigate to",
        },
        waitUntil: {
          type: "string",
          enum: NAVIGATION_WAIT_UNTIL_VALUES,
          description:
            "Page-load wait condition. Defaults to 'load'; SPAs with heartbeats often never reach 'networkidle'.",
        },
        timeout: {
          type: "number",
          description: "Navigation timeout in milliseconds. Defaults to 30000.",
        },
      },
      required: ["url"],
    },
  };
}
