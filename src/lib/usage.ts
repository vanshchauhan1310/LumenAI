import { supabase, Tables } from "./db.js";
import { estimateCostUsd } from "./pricing.js";

/**
 * Usage-meting writes for LLM turns and tool calls. Both are fire-and-forget
 * writes appended to by the single funnels in the codebase:
 *
 *   - LLM turns: chat.ts records one LlmUsage row per llm.sendTurn() result.
 *   - Tool calls: executeTool (tools/index.ts) records one ToolUsage row per
 *     call, for BOTH the chat orchestration loop and the tableauBrowse route
 *     (they share executeTool).
 *
 * A failed metering write must never break the thing it's metering, so these
 * swallow errors (and log once server-side) instead of throwing.
 */

const TRUNCATED_ARGS_CHARS = 2000;

/** Persists one LLM turn's token usage + estimated cost. Swallows errors. */
export async function recordLlmUsage(params: {
  userId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}): Promise<void> {
  const estimatedCostUsd = estimateCostUsd(params.provider, params.model, params.promptTokens, params.completionTokens);
  try {
    const { error } = await supabase.from(Tables.llmUsage).insert({
      user_id: params.userId,
      provider: params.provider,
      model: params.model,
      prompt_tokens: params.promptTokens,
      completion_tokens: params.completionTokens,
      estimated_cost_usd: estimatedCostUsd,
    });
    if (error) throw error;
  } catch (err) {
    console.error("Failed to record LLM usage:", err);
  }
}

/** Truncated JSON snapshot of tool args — enough for audit, no huge payloads. */
function summarizeArgs(args: any): string | null {
  try {
    const json = JSON.stringify(args ?? {});
    return json.length > TRUNCATED_ARGS_CHARS ? `${json.slice(0, TRUNCATED_ARGS_CHARS)}...[truncated]` : json;
  } catch {
    return null;
  }
}

/** Persists one tool-call record. Swallows errors. */
export async function recordToolUsage(params: {
  userId: string;
  toolName: string;
  status: "success" | "error";
  durationMs: number;
  args?: any;
  error?: string;
}): Promise<void> {
  const inputArgs = summarizeArgs(params.args);
  try {
    const { error } = await supabase.from(Tables.toolUsage).insert({
      user_id: params.userId,
      tool_name: params.toolName,
      status: params.status,
      duration_ms: params.durationMs,
      input_args: inputArgs,
      error: params.error ? String(params.error).slice(0, 500) : null,
    });
    if (error) throw error;
  } catch (err) {
    console.error("Failed to record tool usage:", err);
  }
}
