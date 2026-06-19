#!/usr/bin/env node

// ABOUTME: MCP server entry point for Playwright stealth browser automation

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getActiveBrowserType } from "./browser.js";
import {
  DualStdioServerTransport,
  pingTimeoutMsFromEnv,
} from "./dual_stdio_transport.js";
import {
  createNavigateToolDefinition,
  type NavigateOptions,
} from "./tool_definitions.js";
import * as tools from "./tools.js";

const server = new Server(
  {
    name: "playwright-stealth",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      createNavigateToolDefinition(),
      {
        name: "playwright_screenshot",
        description: "Capture a screenshot of the current page",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Optional filename for the screenshot",
            },
          },
        },
      },
      {
        name: "playwright_click",
        description: "Click an element on the page",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the element to click",
            },
          },
          required: ["selector"],
        },
      },
      {
        name: "playwright_fill",
        description: "Fill a form input field",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the input field",
            },
            value: {
              type: "string",
              description: "Value to fill",
            },
          },
          required: ["selector", "value"],
        },
      },
      {
        name: "playwright_evaluate",
        description: "Execute JavaScript in the browser context",
        inputSchema: {
          type: "object",
          properties: {
            script: {
              type: "string",
              description: "JavaScript code to execute",
            },
          },
          required: ["script"],
        },
      },
      {
        name: "playwright_extract_content",
        description: "Extract text content from the page",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description:
                "Optional CSS selector to limit extraction to specific element",
            },
          },
        },
      },
      {
        name: "playwright_navigate_back",
        description: "Go back in browser history",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "playwright_navigate_forward",
        description: "Go forward in browser history",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "playwright_select",
        description: "Select an option from a dropdown",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the select element",
            },
            value: {
              type: "string",
              description: "Value to select",
            },
          },
          required: ["selector", "value"],
        },
      },
      {
        name: "playwright_hover",
        description: "Hover over an element",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the element",
            },
          },
          required: ["selector"],
        },
      },
      {
        name: "playwright_press",
        description: "Press a keyboard key",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the element",
            },
            key: {
              type: "string",
              description: "Key to press (e.g., 'Enter', 'Escape')",
            },
          },
          required: ["selector", "key"],
        },
      },
      {
        name: "playwright_close",
        description: "Close the browser",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "playwright_reset",
        description: "Reset the page (close and create new)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "playwright_list_pages",
        description:
          "List open pages/tabs in the active browser context. In CDP attach mode this lists the attached browser's existing tabs so the agent can bind to the user's authenticated tab.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "playwright_select_page",
        description:
          "Select the active page/tab by id, index, URL substring, or title substring. Use playwright_list_pages first to inspect available targets.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "Stable page id returned by playwright_list_pages, such as page-1.",
            },
            index: {
              type: "number",
              description:
                "Zero-based index returned by playwright_list_pages.",
            },
            urlContains: {
              type: "string",
              description: "Select the first page whose URL contains this text.",
            },
            titleContains: {
              type: "string",
              description:
                "Select the first page whose title contains this text.",
            },
          },
        },
      },
      {
        name: "playwright_list_browsers",
        description:
          "List all browsers installed on this system that can be used for automation. Returns name, engine, executable path, stealth support, and which browser is currently active.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "playwright_set_browser",
        description:
          "Switch to a different installed browser. Closes the current browser session and opens a new one with the specified browser. Use playwright_list_browsers first to see available options.",
        inputSchema: {
          type: "object",
          properties: {
            browser: {
              type: "string",
              description:
                "System browser channel name (e.g. 'chrome', 'msedge', 'moz-firefox'). " +
                "Also accepts aliases: 'firefox' → 'moz-firefox', 'chromium' → 'chrome', 'edge' → 'msedge'.",
            },
          },
          required: ["browser"],
        },
      },
      {
        name: "playwright_get_cookie",
        description:
          "Read a cookie value from the current browser context. Works for HttpOnly cookies, which document.cookie / playwright_evaluate cannot see. Returns { value: string | null } — null if no cookie with that name exists for the active page's origin.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Cookie name to read.",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "playwright_add_cookies",
        description:
          "Write cookies to the current browser context. Supports HttpOnly and Secure cookies that playwright_evaluate cannot set. Each cookie requires either (domain + path) or url. Used to restore cached authentication sessions before navigation.",
        inputSchema: {
          type: "object",
          properties: {
            cookies: {
              type: "array",
              description: "Cookies to add to the browser context.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  value: { type: "string" },
                  url: { type: "string" },
                  domain: { type: "string" },
                  path: { type: "string" },
                  expires: { type: "number" },
                  httpOnly: { type: "boolean" },
                  secure: { type: "boolean" },
                  sameSite: {
                    type: "string",
                    enum: ["Strict", "Lax", "None"],
                  },
                },
                required: ["name", "value"],
              },
            },
          },
          required: ["cookies"],
        },
      },
      {
        name: "playwright_add_init_script",
        description:
          "Register a JavaScript snippet to run before any page script on every navigation in the active context. Used to seed window.localStorage / window.sessionStorage with cached tokens before the page's SPA bootstrap code runs.",
        inputSchema: {
          type: "object",
          properties: {
            script: {
              type: "string",
              description:
                "JavaScript source to execute in page context before the page's own scripts.",
            },
          },
          required: ["script"],
        },
      },
      {
        name: "playwright_wait_for_selector",
        description:
          "Wait for a selector to reach the requested state before continuing. Returns once the element matches; rejects with a Playwright TimeoutError if it does not appear in time. Default state is 'visible', default timeout is 30000ms.",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector to wait for.",
            },
            state: {
              type: "string",
              enum: ["attached", "detached", "visible", "hidden"],
              description: "Selector state to wait for. Defaults to 'visible'.",
            },
            timeout: {
              type: "number",
              description: "Timeout in milliseconds. Defaults to 30000.",
            },
          },
          required: ["selector"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error("Missing arguments");
  }

  try {
    let result: unknown;

    switch (name) {
      case "playwright_navigate":
        result = await tools.navigate(args.url as string, {
          waitUntil: args.waitUntil as NavigateOptions["waitUntil"],
          timeout: args.timeout as number | undefined,
        });
        break;
      case "playwright_screenshot":
        result = await tools.screenshot(args.name as string | undefined);
        break;
      case "playwright_click":
        result = await tools.click(args.selector as string);
        break;
      case "playwright_fill":
        result = await tools.fill(
          args.selector as string,
          args.value as string,
        );
        break;
      case "playwright_evaluate":
        result = await tools.evaluate(args.script as string);
        break;
      case "playwright_extract_content":
        result = await tools.extractContent(
          args.selector as string | undefined,
        );
        break;
      case "playwright_navigate_back":
        result = await tools.navigateBack();
        break;
      case "playwright_navigate_forward":
        result = await tools.navigateForward();
        break;
      case "playwright_select":
        result = await tools.selectOption(
          args.selector as string,
          args.value as string,
        );
        break;
      case "playwright_hover":
        result = await tools.hover(args.selector as string);
        break;
      case "playwright_press":
        result = await tools.pressKey(
          args.selector as string,
          args.key as string,
        );
        break;
      case "playwright_close":
        result = await tools.close();
        break;
      case "playwright_reset":
        result = await tools.reset();
        break;
      case "playwright_list_pages":
        result = await tools.listPages();
        break;
      case "playwright_select_page":
        result = await tools.selectPage({
          id: args.id as string | undefined,
          index: args.index as number | undefined,
          urlContains: args.urlContains as string | undefined,
          titleContains: args.titleContains as string | undefined,
        });
        break;
      case "playwright_list_browsers":
        result = tools.listBrowsers();
        break;
      case "playwright_get_cookie":
        result = await tools.getCookie(args.name as string);
        break;
      case "playwright_add_cookies":
        result = await tools.addCookies(
          args.cookies as Parameters<typeof tools.addCookies>[0],
        );
        break;
      case "playwright_add_init_script":
        result = await tools.addInitScript(args.script as string);
        break;
      case "playwright_wait_for_selector":
        result = await tools.waitForSelector(args.selector as string, {
          state: args.state as
            | "attached"
            | "detached"
            | "visible"
            | "hidden"
            | undefined,
          timeout: args.timeout as number | undefined,
        });
        break;
      case "playwright_set_browser": {
        const browserArg =
          (args.browser as string | undefined) ??
          (args.browserName as string | undefined) ??
          (args.name as string | undefined);
        if (!browserArg) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Missing required argument 'browser'. Use playwright_list_browsers to see available options.",
              },
            ],
            isError: true,
          };
        }
        result = await tools.switchBrowser(browserArg);
        break;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  // Connect stdio first so the MCP `initialize` handshake can resolve before
  // any browser detection happens. `getActiveBrowserType()` lazily walks
  // Playwright's registry — a slow probe was timing out the prophet-arb-bot
  // Python child on cold start (#1921).
  const transport = new DualStdioServerTransport(
    process.stdin,
    process.stdout,
    {
      idleTimeoutMs: pingTimeoutMsFromEnv(),
    },
  );
  await server.connect(transport);
  console.error(
    `[playwright-stealth] Stdio transport ready; framing: line-jsonrpc, content-length; default browser: ${getActiveBrowserType()}`,
  );
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
