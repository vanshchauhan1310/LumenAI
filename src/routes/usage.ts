import { Router } from "express";
import { supabase, Tables, logSupabaseError } from "../lib/db.js";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth.js";

/**
 * Usage metering/monetization endpoints. Everything is scoped to the
 * authenticated user — there is no cross-user path, mirroring every other
 * route. Two shapes:
 *
 *   GET /usage          — recent LlmUsage + ToolUsage rows (audit trail)
 *   GET /usage/summary  — aggregates: totals, per-day, per-provider,
 *                         per-tool, success/error
 *
 * The per-day/per-provider/per-tool grouping is done in JS over the user's
 * most recent 2000 rows rather than SQL GROUP BY — plenty for a personal
 * usage dashboard and keeps the Supabase queries trivial.
 */

export const usageRouter = Router();
usageRouter.use(requireAuth);

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Fetches the user's recent LLM usage rows (newest first). */
async function fetchLlmRows(userId: string, take: number) {
  const { data, error } = await supabase
    .from(Tables.llmUsage)
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(take);
  logSupabaseError("fetch llm usage", error);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    provider: r.provider,
    model: r.model,
    promptTokens: r.prompt_tokens ?? 0,
    completionTokens: r.completion_tokens ?? 0,
    estimatedCostUsd: r.estimated_cost_usd ?? null,
    createdAt: new Date(r.created_at),
  }));
}

/** Fetches the user's recent tool usage rows (newest first). */
async function fetchToolRows(userId: string, take: number) {
  const { data, error } = await supabase
    .from(Tables.toolUsage)
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(take);
  logSupabaseError("fetch tool usage", error);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    toolName: r.tool_name,
    status: r.status,
    durationMs: r.duration_ms ?? 0,
    createdAt: new Date(r.created_at),
  }));
}

usageRouter.get("/", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const [llmRows, toolRows] = await Promise.all([
    fetchLlmRows(userId, 50),
    fetchToolRows(userId, 50),
  ]);

  res.json({
    llm: llmRows.map((r) => ({
      id: r.id,
      provider: r.provider,
      model: r.model,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      estimatedCostUsd: r.estimatedCostUsd,
      createdAt: r.createdAt.toISOString(),
    })),
    tools: toolRows.map((r) => ({
      id: r.id,
      toolName: r.toolName,
      status: r.status,
      durationMs: r.durationMs,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

usageRouter.get("/summary", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const [llmRows, toolRows] = await Promise.all([
    fetchLlmRows(userId, 2000),
    fetchToolRows(userId, 2000),
  ]);

  const totalPrompt = llmRows.reduce((s, r) => s + r.promptTokens, 0);
  const totalCompletion = llmRows.reduce((s, r) => s + r.completionTokens, 0);
  const totalCost = llmRows.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0);

  // Per-day rolling view (both turn and tool activity).
  const byDay = new Map<string, { llmTurns: number; toolCalls: number; promptTokens: number; completionTokens: number; estimatedCostUsd: number }>();
  const bumpDay = (date: Date, mutate: (e: NonNullable<ReturnType<typeof byDay.get>>) => void) => {
    const key = dayKey(date);
    const entry =
      byDay.get(key) ?? { llmTurns: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 };
    mutate(entry);
    byDay.set(key, entry);
  };
  for (const r of llmRows) {
    bumpDay(r.createdAt, (e) => {
      e.llmTurns += 1;
      e.promptTokens += r.promptTokens;
      e.completionTokens += r.completionTokens;
      e.estimatedCostUsd += r.estimatedCostUsd ?? 0;
    });
  }
  for (const r of toolRows) {
    bumpDay(r.createdAt, (e) => {
      e.toolCalls += 1;
    });
  }
  const days = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v, estimatedCostUsd: round6(v.estimatedCostUsd) }));

  // Per-provider token/cost breakdown.
  const providerAggs = new Map<string, { llmTurns: number; promptTokens: number; completionTokens: number; estimatedCostUsd: number }>();
  for (const r of llmRows) {
    const entry =
      providerAggs.get(r.provider) ?? { llmTurns: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 };
    entry.llmTurns += 1;
    entry.promptTokens += r.promptTokens;
    entry.completionTokens += r.completionTokens;
    entry.estimatedCostUsd += r.estimatedCostUsd ?? 0;
    providerAggs.set(r.provider, entry);
  }
  const providers = [...providerAggs.entries()].map(([provider, v]) => ({
    provider,
    ...v,
    estimatedCostUsd: round6(v.estimatedCostUsd),
  }));

  // Per-tool + per-status breakdowns — computed in JS from the same rows we
  // already fetched (Supabase JS has no Prisma-style groupBy).
  const toolCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  for (const r of toolRows) {
    toolCounts.set(r.toolName, (toolCounts.get(r.toolName) ?? 0) + 1);
    statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
  }
  const tools = [...toolCounts.entries()]
    .map(([toolName, calls]) => ({ toolName, calls }))
    .sort((a, b) => b.calls - a.calls);
  const status = Object.fromEntries(statusCounts);
  const errorCount = Number(status.error ?? 0);

  res.json({
    totals: {
      llmTurns: llmRows.length,
      toolCalls: toolRows.length,
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      totalTokens: totalPrompt + totalCompletion,
      estimatedCostUsd: round6(totalCost),
      toolErrorRate: toolRows.length > 0 ? Math.round((errorCount / toolRows.length) * 1000) / 1000 : 0,
    },
    days,
    providers,
    tools,
    status,
  });
});
