import { TableauClient } from "../tableau/client.js";
import { datasourceToolDefinitions, datasourceHandlers } from "./tableauTools.js";
import { contentToolDefinitions, contentHandlers } from "./contentTools.js";
import { pulseToolDefinitions, pulseHandlers } from "./pulseTools.js";
import { adminToolDefinitions, adminHandlers } from "./adminTools.js";
import { semanticToolDefinitions, semanticHandlers } from "./semanticTools.js";
import { analyticalToolDefinitions, analyticalHandlers } from "./analyticalTools.js";
import { recordToolUsage } from "../lib/usage.js";

/** Every tool definition sent to the LLM, combined from all tool modules. */
export const toolDefinitions = [
  ...datasourceToolDefinitions,
  ...contentToolDefinitions,
  ...pulseToolDefinitions,
  ...semanticToolDefinitions,
  ...analyticalToolDefinitions,
  ...adminToolDefinitions,
] as const;

const handlers: Record<string, (client: TableauClient, args: any) => Promise<any>> = {
  ...datasourceHandlers,
  ...contentHandlers,
  ...pulseHandlers,
  ...semanticHandlers,
  ...analyticalHandlers,
  ...adminHandlers,
};

/**
 * Executes one named tool call against the given user's own TableauClient.
 * This is the single execution funnel for BOTH the chat orchestration loop
 * and the tableauBrowse route, so every tool call is metered here exactly
 * once (recordToolUsage) — success and handled-error ({ error: ... }) results
 * are recorded, and the write is fire-and-forget (it swallows its own
 * failures rather than break the tool result).
 */
export async function executeTool(client: TableauClient, name: string, args: any): Promise<any> {
  const handler = handlers[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }
  const userId = client.getUserId();
  const started = Date.now();
  try {
    const result = await handler(client, args);
    await recordToolUsage({
      userId,
      toolName: name,
      status: result && typeof result === "object" && "error" in result ? "error" : "success",
      durationMs: Date.now() - started,
      args,
      ...(result && typeof result === "object" && "error" in result ? { error: String(result.error) } : {}),
    });
    return result;
  } catch (err: any) {
    await recordToolUsage({
      userId,
      toolName: name,
      status: "error",
      durationMs: Date.now() - started,
      args,
      error: err.message ?? String(err),
    });
    return { error: err.message ?? String(err) };
  }
}
