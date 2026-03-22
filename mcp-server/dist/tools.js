import { z } from "zod";
import { bridge, EVALUATE_JS_TIMEOUT_MS, isScreenshotResultPayload, jsonText, PENDING_REQUEST_TIMEOUT_MS, } from "./transport.js";
export function toolText(data) {
    return {
        content: [{ type: "text", text: jsonText(data) }],
    };
}
export function toolError(text) {
    return { isError: true, content: [{ type: "text", text }] };
}
async function callTool(command, payload, timeoutMs = PENDING_REQUEST_TIMEOUT_MS) {
    if (!bridge.isReady()) {
        return toolError("Chrome extension is not connected. Load poke-browser in Chrome and ensure the WebSocket port matches POKE_BROWSER_WS_PORT.");
    }
    try {
        const result = await bridge.request(command, payload, timeoutMs);
        return toolText(result);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolError(msg);
    }
}
const tabIdSchema = z.number().int().positive();
const manageTabsInputSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("list") }),
    z.object({ action: z.literal("get_active") }),
    z.object({
        action: z.literal("new"),
        url: z.string().min(1).optional(),
    }),
    z.object({
        action: z.literal("close"),
        tabId: tabIdSchema,
    }),
    z.object({
        action: z.literal("switch"),
        tabId: tabIdSchema,
    }),
]);
export function registerTools(mcp) {
    mcp.registerTool("navigate_to", {
        description: "Navigate a tab to a URL (defaults to the active tab). Optionally wait until the load completes.",
        inputSchema: {
            url: z.string().min(1).describe("Destination URL"),
            tabId: tabIdSchema.optional().describe("Optional tab id; defaults to active tab"),
            waitForLoad: z
                .boolean()
                .optional()
                .describe("If true, wait up to 30s for status complete before returning"),
        },
    }, async ({ url, tabId, waitForLoad }) => callTool("navigate_to", { url, tabId, waitForLoad }, PENDING_REQUEST_TIMEOUT_MS + 35_000));
    mcp.registerTool("click_element", {
        description: "Click via CSS selector / XPath (content script) or viewport coordinates (Chrome DevTools Protocol). Provide either selector or x+y.",
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
    }, async ({ selector, x, y, tabId }) => callTool("click_element", { selector, x, y, tabId }));
    mcp.registerTool("type_text", {
        description: "Type into an input, textarea, or contenteditable (selector optional; uses focused element if omitted). Falls back to CDP key events.",
        inputSchema: {
            text: z.string().describe("Text to type"),
            selector: z.string().min(1).optional(),
            tabId: tabIdSchema.optional(),
            clearFirst: z.boolean().optional().describe("Select-all and replace field contents first"),
        },
    }, async ({ text, selector, tabId, clearFirst }) => callTool("type_text", { text, selector, tabId, clearFirst }));
    mcp.registerTool("scroll_window", {
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
    }, async (args) => callTool("scroll_window", args));
    mcp.registerTool("capture_screenshot", {
        description: "Capture the visible area of a browser tab as an image (PNG or JPEG). Defaults to the active tab. May activate the target tab briefly to capture it.",
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
    }, async ({ tabId, format, quality }) => {
        if (!bridge.isReady()) {
            return toolError("Chrome extension is not connected. Load poke-browser in Chrome and ensure the WebSocket port matches POKE_BROWSER_WS_PORT.");
        }
        try {
            const result = await bridge.request("screenshot", { tabId, format: format ?? "png", quality }, PENDING_REQUEST_TIMEOUT_MS);
            if (!isScreenshotResultPayload(result)) {
                return toolError("Extension returned an invalid screenshot payload.");
            }
            return {
                content: [
                    {
                        type: "image",
                        data: result.data,
                        mimeType: result.mimeType,
                    },
                ],
            };
        }
        catch (e) {
            return toolError(e instanceof Error ? e.message : String(e));
        }
    });
    mcp.registerTool("manage_tabs", {
        description: "List tabs, read the active tab, open, close, or switch tabs in the connected Chrome profile.",
        inputSchema: manageTabsInputSchema,
    }, async (args) => {
        switch (args.action) {
            case "list":
                return callTool("list_tabs", {});
            case "get_active":
                return callTool("get_active_tab", {});
            case "new":
                return callTool("new_tab", { url: args.url });
            case "close":
                return callTool("close_tab", { tabId: args.tabId });
            case "switch":
                return callTool("switch_tab", { tabId: args.tabId });
            default: {
                const _exhaustive = args;
                return toolError(`Unsupported action: ${String(_exhaustive)}`);
            }
        }
    });
    mcp.registerTool("evaluate_js", {
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
    }, async ({ code, tabId, timeoutMs }) => callTool("evaluate_js", { code, tabId, timeoutMs }, EVALUATE_JS_TIMEOUT_MS));
}
//# sourceMappingURL=tools.js.map