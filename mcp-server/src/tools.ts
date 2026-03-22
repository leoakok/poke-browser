import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  bridge,
  EVALUATE_JS_TIMEOUT_MS,
  extensionBridgeDisconnectedMessage,
  isScreenshotResultPayload,
  jsonText,
  PENDING_REQUEST_TIMEOUT_MS,
  RateLimitError,
  type ExtensionCommand,
} from "./transport.js";

export function toolText(data: unknown): CallToolResult {
  return {
    content: [{ type: "text" as const, text: jsonText(data) }],
  };
}

export function toolError(text: string): CallToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

async function callTool(
  command: ExtensionCommand,
  payload: unknown,
  timeoutMs: number = PENDING_REQUEST_TIMEOUT_MS
): Promise<CallToolResult> {
  if (!bridge.isReady()) {
    return toolError(extensionBridgeDisconnectedMessage());
  }
  try {
    const result = await bridge.request(command, payload, timeoutMs);
    return toolText(result);
  } catch (e) {
    if (e instanceof RateLimitError) {
      return toolText({ error: "rate_limit_exceeded", retryAfter: e.retryAfter });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return toolError(msg);
  }
}

const tabIdSchema = z.number().int().positive();

/**
 * Single z.object (not z.discriminatedUnion): @modelcontextprotocol/sdk only JSON-serializes
 * object-shaped schemas for tools/list. A discriminatedUnion has no `.shape`, so clients saw
 * inputSchema `{}` and could send args that fail union discrimination on the server.
 */
const manageTabsInputSchema = z
  .object({
    action: z.enum(["list", "get_active", "new", "close", "switch"]),
    url: z.string().min(1).optional(),
    tabId: tabIdSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.action === "close" || val.action === "switch") {
      if (val.tabId === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "tabId is required when action is close or switch",
          path: ["tabId"],
        });
      }
    }
  });

export function registerTools(mcp: McpServer): void {
  mcp.registerTool(
    "navigate_to",
    {
      description: "Navigate a tab to a URL (defaults to the active tab). Optionally wait until the load completes.",
      inputSchema: {
        url: z.string().min(1).describe("Destination URL"),
        tabId: tabIdSchema.optional().describe("Optional tab id; defaults to active tab"),
        waitForLoad: z
          .boolean()
          .optional()
          .describe("If true, wait up to 30s for status complete before returning"),
      },
    },
    async ({ url, tabId, waitForLoad }) =>
      callTool("navigate_to", { url, tabId, waitForLoad }, PENDING_REQUEST_TIMEOUT_MS + 35_000)
  );

  mcp.registerTool(
    "click_element",
    {
      description:
        "Click via CSS selector / XPath (content script) or viewport coordinates (Chrome DevTools Protocol). Provide either selector or x+y.",
      inputSchema: {
        selector: z
          .string()
          .min(1)
          .optional()
          .describe("CSS selector, '//xpath', or 'xpath:expr'"),
        x: z.number().optional().describe("Viewport X when using coordinate click (debugger)"),
        y: z.number().optional().describe("Viewport Y when using coordinate click (debugger)"),
        tabId: tabIdSchema.optional(),
      },
    },
    async ({ selector, x, y, tabId }) => callTool("click_element", { selector, x, y, tabId })
  );

  mcp.registerTool(
    "type_text",
    {
      description:
        "Type into an input, textarea, or contenteditable (selector optional; uses focused element if omitted). Falls back to CDP key events.",
      inputSchema: {
        text: z.string().describe("Text to type"),
        selector: z.string().min(1).optional(),
        tabId: tabIdSchema.optional(),
        clearFirst: z.boolean().optional().describe("Select-all and replace field contents first"),
      },
    },
    async ({ text, selector, tabId, clearFirst }) =>
      callTool("type_text", { text, selector, tabId, clearFirst })
  );

  mcp.registerTool(
    "scroll_window",
    {
      description: "Scroll the window or scroll a selector into view.",
      inputSchema: {
        x: z.number().optional().describe("Absolute scrollLeft"),
        y: z.number().optional().describe("Absolute scrollTop"),
        deltaX: z.number().optional(),
        deltaY: z.number().optional(),
        selector: z.string().min(1).optional().describe("Element to scroll into view"),
        tabId: tabIdSchema.optional(),
        behavior: z.enum(["smooth", "instant"]).optional().describe("Scroll behavior (default instant)"),
      },
    },
    async (args) => callTool("scroll_window", args)
  );

  mcp.registerTool(
    "capture_screenshot",
    {
      description:
        "Capture the visible area of a browser tab as an image (PNG or JPEG). Defaults to the active tab. May activate the target tab briefly to capture it.",
      inputSchema: {
        tabId: tabIdSchema.optional().describe("Tab to capture; defaults to the active tab in the focused window"),
        format: z
          .enum(["png", "jpeg"])
          .optional()
          .describe("Image format (default png). JPEG supports quality."),
        quality: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("JPEG quality 0–100 (only used when format is jpeg)"),
      },
    },
    async ({ tabId, format, quality }): Promise<CallToolResult> => {
      if (!bridge.isReady()) {
        return toolError(extensionBridgeDisconnectedMessage());
      }
      try {
        const result = await bridge.request(
          "screenshot",
          { tabId, format: format ?? "png", quality },
          PENDING_REQUEST_TIMEOUT_MS
        );
        if (!isScreenshotResultPayload(result)) {
          return toolError("Extension returned an invalid screenshot payload.");
        }
        return {
          content: [
            {
              type: "image" as const,
              data: result.data,
              mimeType: result.mimeType,
            },
          ],
        };
      } catch (e) {
        if (e instanceof RateLimitError) {
          return toolText({ error: "rate_limit_exceeded", retryAfter: e.retryAfter });
        }
        return toolError(e instanceof Error ? e.message : String(e));
      }
    }
  );

  mcp.registerTool(
    "full_page_capture",
    {
      description:
        "Capture a full-page screenshot by scrolling the viewport and stitching strips (OffscreenCanvas). Slower than capture_screenshot; may duplicate fixed headers between strips.",
      inputSchema: {
        tabId: tabIdSchema.optional(),
        format: z.enum(["png", "jpeg"]).optional(),
        quality: z.number().min(0).max(100).optional().describe("JPEG quality when format is jpeg"),
      },
    },
    async ({ tabId, format, quality }): Promise<CallToolResult> => {
      if (!bridge.isReady()) {
        return toolError(extensionBridgeDisconnectedMessage());
      }
      try {
        const result = await bridge.request(
          "full_page_capture",
          { tabId, format: format ?? "png", quality },
          120_000,
        );
        if (!isScreenshotResultPayload(result)) {
          return toolError("Extension returned an invalid full_page_capture payload.");
        }
        return {
          content: [
            {
              type: "image" as const,
              data: result.data,
              mimeType: result.mimeType,
            },
          ],
        };
      } catch (e) {
        if (e instanceof RateLimitError) {
          return toolText({ error: "rate_limit_exceeded", retryAfter: e.retryAfter });
        }
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  mcp.registerTool(
    "pdf_export",
    {
      description:
        "Export the current page as PDF via CDP Page.printToPDF (printBackground true). Returns base64-encoded PDF data.",
      inputSchema: {
        tabId: tabIdSchema.optional(),
        landscape: z.boolean().optional(),
        scale: z.number().positive().max(2).optional().describe("Scale factor (default 1)"),
      },
    },
    async ({ tabId, landscape, scale }) =>
      callTool("pdf_export", { tabId, landscape, scale }, 120_000),
  );

  mcp.registerTool(
    "device_emulate",
    {
      description:
        "Apply CDP device metrics and optional user-agent override (mobile/tablet/desktop presets). Debugger attaches briefly; viewport may reset when the session detaches.",
      inputSchema: {
        tabId: tabIdSchema.optional(),
        device: z.enum(["mobile", "tablet", "desktop"]).optional().describe("Preset (default desktop)"),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        deviceScaleFactor: z.number().positive().optional(),
        userAgent: z.string().optional(),
      },
    },
    async ({ tabId, device, width, height, deviceScaleFactor, userAgent }) =>
      callTool("device_emulate", { tabId, device, width, height, deviceScaleFactor, userAgent }, 30_000),
  );

  mcp.registerTool(
    "managetabs",
    {
      description:
        "List tabs, read the active tab, open, close, or switch tabs in the connected Chrome profile.",
      inputSchema: manageTabsInputSchema,
    },
    async (args): Promise<CallToolResult> => {
      switch (args.action) {
        case "list":
          return callTool("list_tabs", {});
        case "get_active":
          return callTool("get_active_tab", {});
        case "new":
          return callTool("new_tab", { url: args.url });
        case "close":
          return callTool("close_tab", { tabId: args.tabId! });
        case "switch":
          return callTool("switch_tab", { tabId: args.tabId! });
      }
    }
  );

  mcp.registerTool(
    "evaluate_js",
    {
      description: "Evaluate JavaScript in the page's main world (via content-script relay)",
      inputSchema: {
        code: z.string().min(1).describe("JavaScript source to evaluate"),
        tabId: tabIdSchema.optional(),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(120_000)
          .optional()
          .describe("Optional timeout in ms (default 30000 in extension)"),
      },
    },
    async ({ code, tabId, timeoutMs }) =>
      callTool("evaluate_js", { code, tabId, timeoutMs }, EVALUATE_JS_TIMEOUT_MS)
  );

  mcp.registerTool(
    "get_dom_snapshot",
    {
      description:
        "Capture a compact DOM tree from the active (or chosen) tab: tags, ids, classes, roles, aria-label, short text, bounding rects, interactivity, and children up to maxDepth.",
      inputSchema: {
        tabId: tabIdSchema.optional().describe("Tab to read; defaults to active tab in focused window"),
        includeHidden: z
          .boolean()
          .optional()
          .describe("If true, include display:none / visibility:hidden and offsetParent-null nodes (default false)"),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("Max depth from document.body (default 6)"),
      },
    },
    async ({ tabId, includeHidden, maxDepth }) =>
      callTool("get_dom_snapshot", { tabId, includeHidden, maxDepth }, EVALUATE_JS_TIMEOUT_MS)
  );

  mcp.registerTool(
    "get_accessibility_tree",
    {
      description:
        "Flat list of semantic nodes (roles, names, selectors, heading levels, form state) in reading order (top-to-bottom, left-to-right).",
      inputSchema: {
        tabId: tabIdSchema.optional(),
        interactiveOnly: z
          .boolean()
          .optional()
          .describe("If true, only focusable / interactive elements (default false)"),
      },
    },
    async ({ tabId, interactiveOnly }) =>
      callTool("get_accessibility_tree", { tabId, interactiveOnly }, EVALUATE_JS_TIMEOUT_MS)
  );

  mcp.registerTool(
    "find_element",
    {
      description:
        "Find up to 5 elements by CSS selector, visible text, ARIA/title/alt, or XPath. Strategy auto tries css, then text, then aria.",
      inputSchema: {
        query: z.string().min(1).describe("Selector string, text snippet, aria substring, or XPath expression"),
        tabId: tabIdSchema.optional(),
        strategy: z
          .enum(["auto", "css", "text", "aria", "xpath"])
          .optional()
          .describe("Matching strategy (default auto)"),
      },
    },
    async ({ query, tabId, strategy }) =>
      callTool("find_element", { query, tabId, strategy }, EVALUATE_JS_TIMEOUT_MS)
  );

  mcp.registerTool(
    "read_page",
    {
      description:
        "Extract page content as structured data (default), plain text, or lightweight markdown (headings, links, lists, code). Skips script/style/nav/header/footer noise.",
      inputSchema: {
        tabId: tabIdSchema.optional(),
        format: z
          .enum(["markdown", "text", "structured"])
          .optional()
          .describe("structured (default), text, or markdown"),
      },
    },
    async ({ tabId, format }) =>
      callTool("read_page", { tabId, format }, EVALUATE_JS_TIMEOUT_MS)
  );

  mcp.registerTool(
    "wait_for_selector",
    {
      description:
        "Poll every 100ms until a CSS selector or XPath matches in the page (content script). Optional strict visibility checks.",
      inputSchema: {
        selector: z
          .string()
          .min(1)
          .describe("CSS selector, '//xpath', or 'xpath:expr' (same as find_element)"),
        tabId: tabIdSchema.optional(),
        timeout: z
          .number()
          .int()
          .positive()
          .max(120_000)
          .optional()
          .describe("Max wait in ms (default 10000)"),
        visible: z
          .boolean()
          .optional()
          .describe(
            "If true, require visible layout (offsetParent / fixed-sticky rules) and not display:none, visibility:hidden, or opacity:0"
          ),
      },
    },
    async ({ selector, tabId, timeout, visible }) => {
      const t = timeout ?? 10_000;
      return callTool("wait_for_selector", { selector, tabId, timeout: t, visible }, t + 3000);
    }
  );

  mcp.registerTool(
    "execute_script",
    {
      description:
        "Run an async script in the page main world via chrome.scripting. The script body is wrapped so `await` works; `args` is available as `args`. Result is JSON-clone-safe (circular refs become \"[Circular]\").",
      inputSchema: {
        script: z.string().min(1).describe("JavaScript source body executed as async IIFE"),
        tabId: tabIdSchema.optional(),
        args: z.array(z.unknown()).optional().describe("Array available inside the script as `args`"),
      },
    },
    async ({ script, tabId, args }) =>
      callTool("execute_script", { script, tabId, args: args ?? [] }, 60_000)
  );

  mcp.registerTool(
    "error_reporter",
    {
      description:
        "Return the last N uncaught page errors and unhandled promise rejections (separate from console logs): message, stack, filename, line/column, timestamp.",
      inputSchema: {
        tabId: tabIdSchema.optional(),
        limit: z.number().int().positive().max(200).optional().describe("Max entries (default 50)"),
      },
    },
    async ({ tabId, limit }) => callTool("error_reporter", { tabId, limit: limit ?? 50 })
  );

  mcp.registerTool(
    "get_performance_metrics",
    {
      description:
        "Navigation timing (domContentLoaded, loadEventEnd), paint timings (firstPaint, firstContentfulPaint), and JS heap from CDP Performance.getMetrics (requires debugger attach briefly).",
      inputSchema: {
        tabId: tabIdSchema.optional(),
      },
    },
    async ({ tabId }) => callTool("get_performance_metrics", { tabId }, EVALUATE_JS_TIMEOUT_MS)
  );

  mcp.registerTool(
    "get_console_logs",
    {
      description:
        "Read console entries captured by the content script ring buffer (max 500). Requires the page to have loaded the poke-browser content script.",
      inputSchema: {
        tabId: tabIdSchema.optional(),
        level: z.enum(["all", "error", "warn", "info", "log"]).optional().describe("Filter (default all)"),
        limit: z.number().int().positive().max(500).optional().describe("Max entries (default 100)"),
      },
    },
    async ({ tabId, level, limit }) =>
      callTool("get_console_logs", { tabId, level: level ?? "all", limit: limit ?? 100 })
  );

  mcp.registerTool(
    "clear_console_logs",
    {
      description: "Clear the tab's console capture ring buffer in the content script.",
      inputSchema: {
        tabId: tabIdSchema.optional(),
      },
    },
    async ({ tabId }) => callTool("clear_console_logs", { tabId })
  );

  mcp.registerTool(
    "start_network_capture",
    {
      description:
        "Enable CDP Network.* events for a tab and clear its prior in-memory network buffer (max 200 requests per tab).",
      inputSchema: {
        tabId: tabIdSchema.optional(),
      },
    },
    async ({ tabId }) => callTool("start_network_capture", { tabId })
  );

  mcp.registerTool(
    "stop_network_capture",
    {
      description: "Detach CDP from the tab when it was attached only for network capture (stops new events).",
      inputSchema: {
        tabId: tabIdSchema.optional(),
      },
    },
    async ({ tabId }) => callTool("stop_network_capture", { tabId })
  );

  mcp.registerTool(
    "get_network_logs",
    {
      description:
        "Return buffered network requests for a tab. Optionally include response bodies (Network.getResponseBody). Use start_network_capture first to record new traffic.",
      inputSchema: {
        tabId: tabIdSchema.optional(),
        filter: z.string().optional().describe("Substring filter on URL"),
        limit: z.number().int().positive().max(200).optional().describe("Max entries (default 50)"),
        includeBody: z.boolean().optional().describe("Fetch bodies for completed requests (slower)"),
      },
    },
    async ({ tabId, filter, limit, includeBody }) =>
      callTool(
        "get_network_logs",
        {
          tabId,
          filter,
          limit: limit ?? 50,
          includeBody: includeBody === true,
        },
        includeBody === true ? 60_000 : PENDING_REQUEST_TIMEOUT_MS
      )
  );

  mcp.registerTool(
    "clear_network_logs",
    {
      description: "Clear in-memory network request buffer for a tab.",
      inputSchema: {
        tabId: tabIdSchema.optional(),
      },
    },
    async ({ tabId }) => callTool("clear_network_logs", { tabId })
  );

  mcp.registerTool(
    "hover_element",
    {
      description:
        "Hover using a selector (content script: mousemove/mouseover/mouseenter at element center) or viewport coordinates (CDP mouseMoved).",
      inputSchema: {
        selector: z.string().min(1).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        tabId: tabIdSchema.optional(),
      },
    },
    async ({ selector, x, y, tabId }) => callTool("hover_element", { selector, x, y, tabId })
  );

  const fillFormFieldSchema = z.object({
    selector: z.string().min(1),
    value: z.string(),
    type: z.enum(["text", "select", "checkbox", "radio", "file"]).optional(),
  });

  mcp.registerTool(
    "script_inject",
    {
      description:
        "Inject a `<script>` into the page DOM (main world), unlike evaluate_js/execute_script isolated worlds. Optional persistent registration survives navigations on the same origin via a bundled loader + storage.",
      inputSchema: {
        script: z.string().min(1).describe("JavaScript source executed as a classic script tag in the page"),
        tabId: tabIdSchema.optional(),
        persistent: z.boolean().optional().describe("If true, store and re-inject on future loads for this origin (registerContentScripts)"),
        runAt: z
          .enum(["document_start", "document_end", "document_idle"])
          .optional()
          .describe("When to inject (default document_idle for one-shot; persistent loader honors timing per entry)"),
      },
    },
    async ({ script, tabId, persistent, runAt }) =>
      callTool(
        "script_inject",
        { script, tabId, persistent, runAt: runAt ?? "document_idle" },
        EVALUATE_JS_TIMEOUT_MS
      )
  );

  mcp.registerTool(
    "cookie_manager",
    {
      description:
        "Read/write/delete cookies via chrome.cookies (Chrome profile). Actions: get, get_all, set, delete, delete_all.",
      inputSchema: {
        action: z.enum(["get", "get_all", "set", "delete", "delete_all"]),
        url: z.string().optional().describe("Cookie store URL (often required for get/set/delete)"),
        name: z.string().optional(),
        value: z.string().optional(),
        domain: z.string().optional().describe("For get_all / delete_all / some set operations"),
        path: z.string().optional(),
        secure: z.boolean().optional(),
        httpOnly: z.boolean().optional(),
        expirationDate: z.number().optional(),
        tabId: tabIdSchema.optional().describe("Derive url from tab when url omitted"),
      },
    },
    async (args) => callTool("cookie_manager", args, PENDING_REQUEST_TIMEOUT_MS)
  );

  mcp.registerTool(
    "fill_form",
    {
      description:
        "Fill multiple form fields in one round trip (text, select, checkbox, radio). Optional form submit via selector or default submit button.",
      inputSchema: {
        fields: z.array(fillFormFieldSchema).min(1),
        tabId: tabIdSchema.optional(),
        submitAfter: z.boolean().optional(),
        submitSelector: z.string().optional().describe("CSS selector for submit control; else first [type=submit] in same form"),
      },
    },
    async ({ fields, tabId, submitAfter, submitSelector }) =>
      callTool("fill_form", { fields, tabId, submitAfter, submitSelector }, EVALUATE_JS_TIMEOUT_MS)
  );

  mcp.registerTool(
    "get_storage",
    {
      description:
        "Read localStorage, sessionStorage (page origin), or cookies (Chrome cookie store for the tab URL). Single key or entire map.",
      inputSchema: {
        type: z.enum(["local", "session", "cookie"]),
        key: z.string().optional(),
        tabId: tabIdSchema.optional(),
      },
    },
    async ({ type, key, tabId }) => callTool("get_storage", { type, key, tabId }, EVALUATE_JS_TIMEOUT_MS)
  );

  mcp.registerTool(
    "set_storage",
    {
      description: "Write a key to localStorage or sessionStorage in the page origin (not cookies).",
      inputSchema: {
        type: z.enum(["local", "session"]),
        key: z.string().min(1),
        value: z.string(),
        tabId: tabIdSchema.optional(),
      },
    },
    async ({ type, key, value, tabId }) =>
      callTool("set_storage", { type, key, value, tabId }, PENDING_REQUEST_TIMEOUT_MS)
  );
}
