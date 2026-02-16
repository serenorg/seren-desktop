#!/usr/bin/env node

// ABOUTME: MCP server entry point for Playwright stealth browser automation

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
      {
        name: "playwright_navigate",
        description: "Navigate to a URL with stealth features enabled",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to navigate to",
            },
          },
          required: ["url"],
        },
      },
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
        result = await tools.navigate(args.url as string);
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
