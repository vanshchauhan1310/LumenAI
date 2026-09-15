import { Router } from "express";
import { z } from "zod";
import { supabase, Tables, mapConversation, mapMessage, logSupabaseError } from "../lib/db.js";
import { decryptSecret } from "../lib/crypto.js";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth.js";
import { createLlmAdapter, LlmProviderName } from "../llm/factory.js";
import { getTableauClientForUser } from "../tableau/forUser.js";
import { TableauClient } from "../tableau/client.js";
import { toolDefinitions } from "../tools/index.js";
import { ChatMessage, LlmAdapter, ToolDefinition, LlmTurnResult } from "../llm/types.js";
import { executeScopedTool, scopeSystemPromptAddendum, getBlockedToolNames, DATASOURCE_QUERY_TOOLS } from "../lib/scope.js";
import { executeTool } from "../tools/index.js";
import { collectIds, findInvalidIdArg } from "../lib/idTracking.js";
import { sanitizeFinalAnswer } from "../lib/answerFormat.js";
import { resizeAndCompress } from "../lib/image.js";
import { recordLlmUsage } from "../lib/usage.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { tryFastPath, recordPaginationState } from "../lib/queryRouter.js";

export const chatRouter = Router();
chatRouter.use(requireAuth);
// Chat hits the paid LLM API on every message — keep one user from burning
// through the whole platform's cost (or a provider's rate limit) in a loop.
chatRouter.use(rateLimit({ refillPerMinute: 30, burst: 20 }));

// Some providers (see openaiAdapter.ts) are forced to one tool call per
// round instead of several in parallel, so multi-step questions now cost
// more rounds than before — give a bit more headroom accordingly.
// Several providers (see openaiAdapter.ts) are forced to one tool call per
// round instead of several in parallel, so multi-step questions now cost
// more rounds than before — AND a long verbatim answer (e.g. every workbook
// description) may need one or more "continue where you stopped" rounds on
// top of the discovery chain. Give the loop headroom for both without
// letting a genuinely stuck model spin forever.
const MAX_TOOL_ROUNDS = 24;

const bodySchema = z.object({ message: z.string().min(1) });

/**
 * Loads the user's most recent LLM connection. orderBy is defense-in-depth:
 * /connections/llm now replaces rather than accumulates, but this guards
 * against any pre-existing duplicate rows by always preferring the most
 * recently saved connection.
 */
async function loadLlmConnectionForUser(userId: string) {
  const { data, error } = await supabase
    .from(Tables.llmConnections)
    .select("provider, model, encrypted_api_key")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  logSupabaseError("load llm connection", error);
  return data;
}

// Optimized system prompt — concise and directive for better model compliance.
// Key improvements: shorter (less confusion for NVIDIA), explicit rules,
// direct intent→tool mapping, and clear data-sources-vs-workbooks distinction.
const SYSTEM_PROMPT = `You are Lumen, a Tableau analytics assistant. Answer questions by calling tools against the user's Tableau site. Never invent data, IDs, or field names.

CRITICAL RULES:
1. Every id (workbookId, viewId, datasourceLuid, definitionId) MUST come from a prior tool result in this conversation. NEVER guess or invent ids.
2. NEVER confuse tool names: "data sources" → list_datasources, "workbooks" → list_workbooks, "dashboards/views" → list_site_views, "users" → list_users.
3. You may only call ONE tool per turn. Chain across turns if needed. NEVER loop a per-item tool over many items: prefer the bulk tool whose result already contains the field. Example: workbook descriptions come back in list_workbooks itself (each workbook has a 'description' field) — do NOT call get_workbook_details or list_workbook_revisions per workbook for descriptions.
4. If a tool fails, try the fix immediately — don't describe a plan without executing it.
5. Field captions for query_datasource MUST come from get_datasource_metadata — never guess.
6. NEVER copy tool-result JSON into your reply. Read the JSON, then answer in plain prose/bullets/tables. A reply containing braces { } or raw JSON is a failure.
7. When asked for descriptions, quote each description VERBATIM and IN FULL from the tool result — never paraphrase, shorten, summarize, or invent one. If a workbook's description is null, state that it has no description. If the list is long, keep going until every item is covered — if your reply gets cut off you will be asked to continue, so do not stop early and do not abbreviate.
8. ASK BEFORE GUESSING A DATA SOURCE: For analytical / data-query / aggregation questions (totals, averages, trends, comparisons, rankings, breakdowns, forecasts, statistics, ...), if the user did NOT name a specific data source or workbook in their message, and you have not already discovered a datasourceLuid in this conversation, STOP and ask the user which data source or workbook to use — never pick one for them and never invent a datasourceLuid.
9. LIST vs COUNT are DIFFERENT requests: "list / show me / what X do I have / name all X" means list EVERY matching item BY NAME (e.g. "workbook A, workbook B, ..."). "how many X / count of X / total X / number of X" means reply with JUST the number (e.g. "You have 7 workbooks"). Never answer a LIST question with only a number, and never answer a COUNT question with a long list — but it is fine to briefly mention the number while listing.
10. SEARCH is NOT data analysis: If the user asks to "search for anything named X", "find content named X", "anything named X on my site", or similar site-wide search, call search_content with the exact search terms — NEVER query_datasource, get_datasource_metadata, or get_field_values. A search question finds content by name; it is not an aggregation.

TOOL SELECTION GUIDE:
- Count/list data sources → list_datasources (check 'total' field in response)
- Count/list workbooks → list_workbooks
- Count/list users → list_users
- Count/list dashboards → list_site_views
- Count/list projects → list_projects
- Count/list flows → list_flows
- Search by name → search_content (ONLY for "search/find anything named X on my site" questions — never use a datasource query for those)
- Datasource fields/types → get_datasource_metadata(datasourceLuid)
- Query data/aggregations → query_datasource(datasourceLuid, fields, filters)
- Distinct field values → get_field_values(datasourceLuid, fieldCaption)
- Views in a workbook → list_workbook_views(workbookId)
- View data (CSV) → get_view_data(viewId)
- Dashboard overview text → get_dashboard_summary(viewId, workbookId)
- Dashboard image → get_view_image(viewId) [only if user asks about visual design]
- Dashboard PDF → get_view_pdf(viewId)
- Period comparison → compare_periods(datasourceLuid, measure, dateField, dates)
- Trend/forecast → forecast_metric(datasourceLuid, measure, dateField, granularity)
- Anomaly detection → anomaly_detection(datasourceLuid, measure, dateField, granularity)
- Top/bottom N → rank_categories(datasourceLuid, measure, dimension)
- Cross-tab → pivot_cross_tab(datasourceLuid, measure, rowDimension, colDimension)
- Correlation → correlation_analysis(datasourceLuid, measureX, measureY)
- Field statistics → field_statistics(datasourceLuid, field)
- Share of total → share_of_total(datasourceLuid, measure, dimension)
- Quick summary → get_summary_table(datasourceLuid, measure, dateField, start, end)
- Pulse metrics list → list_pulse_metrics
- Pulse metric value → get_pulse_metric_insight(definitionId)
- Pulse metric history → get_metric_history(definitionId)
- Chart recommendation → recommend_visualization(fields, intent)
- Field glossary → get_datasource_glossary(datasourceLuid)
- Field usage → get_field_usage(datasourceLuid, fieldName?)
- Workbook details → get_workbook_details(workbookId)
- Permissions → query_workbook_permissions / query_view_permissions
- Server info → get_server_info
- Users/groups → list_users, list_groups, get_group_members(groupId)
- Schedules/subscriptions → list_schedules, list_subscriptions
- Tags → list_tags(workbookId), add_tags(workbookId, tags), remove_tags(workbookId, tag)
- Favorites → list_favorites, add_favorite, remove_favorite

WORKFLOW:
1. For data questions: discover (list_*) → get metadata (get_datasource_metadata) → query (query_datasource)
2. For dashboard questions: find view (list_workbook_views/list_site_views) → get data (get_view_data/get_dashboard_summary)
3. For analytical questions: if no data source or workbook was named and none is discovered yet, ASK which one first (rule 8) — never guess a datasourceLuid. Then get the datasourceLuid (list_datasources or list_workbook_datasources) and use the analytical tools directly.
4. If the user's message itself names a data source or workbook, resolve THAT one (list_datasources with a nameFilter, or list_workbook_datasources for a workbook) and use only its datasourceLuid.

ANSWER FORMAT: Be concise. Present data in tables when multiple rows. Use bold for key numbers. Always cite the source (datasource/workbook name). Never output raw JSON.`;

// Legacy tool categories (kept for reference, not sent to model):
// - Discovery: list_projects, list_workbooks, list_flows, list_datasources, list_site_views, search_content, list_pulse_metrics, list_users
// A tool-role message's text content is what gets shrunk when there's no
// image to blame for a 413 — e.g. get_dashboard_summary/get_view_data
// returning a large CSV preview. Cut hard, since the whole point is getting
// comfortably under whatever tight per-request budget just rejected it.
const TEXT_SHRINK_CHARS = 1500;

// Some tool results are too valuable to gut when a 413 forces us to shrink
// history: list_workbooks/list_datasources carry the complete descriptions of
// every item (which the model must quote VERBATIM — rule 7), so truncating
// them to 1500 chars would make "list every description" impossible to answer
// fully. They get a much larger budget; the generic 1500 still applies to
// every other oversized result (CSV previews, dashboard summaries, ...).
const TEXT_SHRINK_CHARS_LARGE = 30000;

function textShrinkCapFor(m: ChatMessage): number {
  if (m.role === "tool" && (m.toolName === "list_workbooks" || m.toolName === "list_datasources")) {
    return TEXT_SHRINK_CHARS_LARGE;
  }
  return TEXT_SHRINK_CHARS;
}

/**
 * Wraps llm.sendTurn() with a single automatic retry when a provider rejects
 * the request as too large (HTTP 413). Shrinks whatever is most likely the
 * dominant contributor — the most recent image (get_view_image), or failing
 * that the largest tool-result text (get_dashboard_summary/get_view_data
 * with a big CSV preview) — in place, then retries once. Any other error, a
 * second failure, or a history with nothing left worth shrinking propagates
 * normally rather than looping.
 */
async function sendTurnWithImageFallback(
  llm: LlmAdapter,
  history: ChatMessage[],
  tools: ToolDefinition[],
): Promise<LlmTurnResult> {
  // Retry once on transient connection errors (DNS, network, TLS, timeout)
  // so a flaky network doesn't fail the whole turn. The NVIDIA NIM adapter's
  // 60s timeout gives enough headroom for cold-starts; this covers the case
  // where the request never got an HTTP response at all.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await llm.sendTurn(history, tools);
    } catch (err: any) {
      const isLastAttempt = attempt === 1;
      const msgText = String(err?.error?.message ?? err?.message ?? "");
      const isConnectionError = !err?.status && (/connect|network|dns|tls|ssl|econnrefused|enotfound|unreachable|getaddrinfo|fetch failed|socket hang up/i.test(msgText) || /connection error/i.test(msgText));

      if (isConnectionError && !isLastAttempt) {
        console.warn(`[chat] LLM turn connection error (attempt ${attempt + 1}/2) — retrying once. Error: ${msgText}`);
        // Brief pause to let transient network issues resolve
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      // Two failure modes mean "the request is too big for this provider":
      //  - HTTP 413 (request entity too large), and
      //  - 400 with a context/token-length message, which some NIM/vLLM
      //    deployments return when the INPUT (large tool results replayed in
      //    history) overflows the model's context window — e.g. a workbook
      //    description list. The openaiAdapter already retries once on
      //    max_tokens 400s at a smaller OUTPUT budget; an input-overflow 400
      //    survives that retry and lands here, where shrinking history is the
      //    only thing left that can fix it.
      const isOversize = err?.status === 413 || (err?.status === 400 && /context|token|too (large|long)|sequence length/i.test(msgText));
      if (!isOversize) throw err;

      const lastImageMessage = [...history].reverse().find((m) => m.role === "tool" && m.image);
      if (lastImageMessage?.image) {
        console.error("413 (request too large) with an image in history — retrying once at a smaller size.");
        const shrunk = await resizeAndCompress(Buffer.from(lastImageMessage.image.base64, "base64"), 450, 35);
        lastImageMessage.image = { mediaType: "image/jpeg", base64: shrunk.toString("base64") };
        return await llm.sendTurn(history, tools);
      }

      // Truncate EVERY oversized tool result, not just the single largest —
      // several medium-sized ones (e.g. a few get_view_data calls earlier in
      // this same conversation) can add up to a 413 just as easily as one huge
      // one, especially once several turns of history are being replayed.
      const oversizedToolMessages = history.filter(
        (m) => m.role === "tool" && typeof m.content === "string" && m.content.length > TEXT_SHRINK_CHARS,
      );
      if (oversizedToolMessages.length > 0) {
        console.error(`413 (request too large) with no image — retrying once with ${oversizedToolMessages.length} large tool result(s) truncated.`);
        // Shrink the LARGEST results first (using the per-tool caps above), so a
        // few enormous CSV previews get cut hard while workbook description
        // lists keep as much of their content as possible.
        oversizedToolMessages.sort((a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0));
        for (const m of oversizedToolMessages) {
          const cap = textShrinkCapFor(m);
          m.content =
            m.content!.slice(0, cap) +
            `\n...[truncated — this result was too large for the model's request limit; ask a narrower question if you need more of it]`;
        }
        return await llm.sendTurn(history, tools);
      }

      throw err;
    }
  }
  // Unreachable — loop always returns or throws — but satisfies TypeScript's
  // control-flow analysis for the noImplicitReturns case.
  throw new Error("sendTurnWithImageFallback: exhausted retries without returning");
}

// Bare "overview"/"summary" style requests trigger the text/image/link menu
// (see the deterministic gate in the route handler below) — but only when
// the user hasn't already stated a format preference, since that counts as
// having answered the menu already (rule 17 in SYSTEM_PROMPT mirrors this
// exception for the cases the LLM still handles itself, e.g. workbook/
// project-scoped or unscoped conversations, which aren't gated here).
const OVERVIEW_INTENT_RE = /\b(overview|summary|summarize|summarise|snapshot|complete breakdown|full breakdown)\b/i;
const EXPLICIT_FORMAT_RE = /\b(text|data|image|picture|visual|link|url)\b/i;

function isGenericOverviewRequest(message: string): boolean {
  return OVERVIEW_INTENT_RE.test(message) && !EXPLICIT_FORMAT_RE.test(message);
}

// Fixed phrase we control entirely (never generated by the LLM), so checking
// for it in the last assistant message reliably detects "the menu was just
// shown, so this incoming message is presumably the user's answer to it" —
// no ambiguity the way parsing free-form LLM text would have.
const OVERVIEW_MENU_MARKER = "A) Text summary";

function buildOverviewMenu(viewName: string, link: string | null): string {
  const lines = [
    `How would you like to see the "${viewName}" dashboard?`,
    `${OVERVIEW_MENU_MARKER} — key numbers and breakdowns as text`,
    "B) Image — a picture of the dashboard exactly as it looks in Tableau",
  ];
  if (link) lines.push(`C) Direct link — open it yourself in Tableau: ${link}`);
  lines.push("\nJust reply with the letter (or word) you'd like.");
  return lines.join("\n");
}

/**
 * Structured version of the same three choices, carried in the message's
 * toolCalls JSON (reusing that column rather than adding a new one) so the
 * frontend can render real clickable buttons instead of making the user type
 * a reply — recognized by buildMessageEl in app.js via `type: "menu"`,
 * distinct from a normal array of tool-call chips.
 */
function buildOverviewMenuOptions(link: string | null): [{ type: "menu"; options: { label: string; value: string }[] }] {
  const options = [
    { label: "📝 Text summary", value: "Text summary" },
    { label: "🖼️ Image", value: "Image" },
  ];
  if (link) options.push({ label: "🔗 Direct link", value: "Direct link" });
  return [{ type: "menu", options }];
}

// ---------------------------------------------------------------------------
// Deterministic "which data source/workbook?" gate for analytical / data-query
// / aggregation requests (call site in the chat route below). When the user
// asks to aggregate or analyze DATA but has not named a data source or
// workbook, weak models pick (or invent) a datasourceLuid — usually the wrong
// one, or a placeholder ("datasource123"), or a name from a different content
// type. Prompting alone hasn't stopped that (same lesson as idTracking.ts and
// the overview-menu gate above), so we short-circuit: list the site's data
// sources and ask which one to use. This mirrors the overview A/B/C menu — a
// cheap server-side step that replaces several slow, error-prone LLM
// discovery rounds (each NIM turn can take 30-120s), so it improves BOTH
// accuracy and response time.
// ---------------------------------------------------------------------------
const DS_MENU_MARKER = "Which data source or workbook should I use for this?";

// All three must hold to fire the gate: the message is doing data aggregation
// (an operation word) on a measurement (a measure word), and it does not name
// a specific content target (workbook/dashboard/datasource/...) — if a target
// is named, the LLM resolves exactly that one instead.
const DS_OP_RE =
  /\b(sum|total|average|avg|mean|median|minimum|maximum|counts?|aggregate|group by|breakdown|compare|comparison|vs\.?|trend|forecast|predict|anomal|outlier|correlat|rank|categor|pivot|cross.?tab|share of|percentage|percent|%|histogram|distribution|percentile|year.to.date|ytd|qtd|mtd|month.to.date|m\.?o\.?m|q\.?o\.?q|y\.?o\.?y|previous (month|quarter|year|period)|last (month|quarter|year|period))\b/i;
const DS_MEASURE_RE =
  /\b(revenue|sales|profit|profitability|margin|orders?|units?|quantity|amount|spend|spending|costs?|expenses?|gross|net|price|pricing|value|volume|invoices?|claims?|premiums?|customers?|clicks?|impressions?|conversions?|signups?|leads?|churn|kpis?|metrics?)\b/i;
const DS_TARGET_RE =
  /\b(workbook|dashboard|view|project|flow|user|group|tag|favorite|favourit|permission|revision|schedule|subscription|datasource|data source|server|connection|pulse|glossary|definition)\w*\b/i;
// Generic analytical intent for phrasings that carry no measure word: "I want
// to run an analytical/data query", "can you do data aggregation/analysis".
// Without this, those generic requests slipped past the gate and a weak model
// guessed a datasource instead of asking (the exact behavior the gate exists
// to stop). Only applies when no content target is named (checked below).
const DS_GENERIC_RE =
  /\b(analys[ei]|analytics?|aggregat(?:e|ion|ing)|data\s+(?:quer|analys|insight|explor|extract)|business\s+intelligence|kpis?|statistics?|run\s+.*query|do\s+.*analys[ei])\b/i;

// Deterministic detection of site-search intent ("search for anything named
// X", "find anything named X", "... on my site"). When it fires, the data-
// query/analytical tools are withheld from the model for THIS request so it
// literally cannot run query_datasource/get_datasource_metadata on a search
// question — it must use search_content. Seen in practice: "Search for
// anything named Revenue on my site" triggered query_datasource with a
// datasourceLuid the model pulled from context instead of a content search.
const SEARCH_INTENT_RE =
  /\bsearch\b[^.!?\n]{0,80}\b(for|named|anything)\b|\bsearch\b[^.!?\n]{0,120}\bon\s+(the\s+|my\s+)?(site|tableau|server)\b|\bfind\b[^.!?\n]{0,80}\b(content|anything|named|dashboards?|workbooks?|projects?|flows?|views?)\b|\banything\s+named\b|\b(content|dashboards?|workbooks?|projects?|flows?|views?)\s+(named|matching|containing)\b/i;

function isDataAggregationRequest(message: string): boolean {
  if (DS_TARGET_RE.test(message)) return false;
  return (DS_OP_RE.test(message) && DS_MEASURE_RE.test(message)) || DS_GENERIC_RE.test(message);
}

// Tools that establish a data source in context. If the conversation already
// ran any of these, the model has a real datasourceLuid to work from — asking
// again (and then blocking its id) would be wrong and annoying.
const DS_ESTABLISHING_TOOLS = new Set([
  "list_datasources",
  "list_workbook_datasources",
  "get_datasource_metadata",
  "query_datasource",
  "get_field_values",
  "get_datasource_glossary",
  "get_field_usage",
  "compare_periods",
  "explain_change",
  "anomaly_detection",
  "forecast_metric",
  "get_data_quality_warnings",
  "get_field_lineage",
  "cross_datasource_query",
  "rank_categories",
  "pivot_cross_tab",
  "rollup_time_series",
  "correlation_analysis",
  "field_statistics",
  "bucketize_metric",
  "share_of_total",
  "get_summary_table",
  "get_metric_history",
]);

function conversationEstablishedDatasource(priorMessages: Array<{ toolCalls?: string | null }>): boolean {
  for (const m of priorMessages) {
    if (!m.toolCalls) continue;
    try {
      const calls = JSON.parse(m.toolCalls);
      if (Array.isArray(calls) && calls.some((c) => c?.name && DS_ESTABLISHING_TOOLS.has(c.name))) return true;
    } catch {
      // malformed stored tool-call metadata — ignore the row
    }
  }
  return false;
}

/**
 * Builds the "which data source?" menu for a message that looks like a data
 * aggregation/analytical request but names no data source or workbook. Returns
 * null when the gate shouldn't fire (not an aggregation request, a content
 * target is named, a data source is already established, the user is
 * answering an earlier menu, or there are no data sources on the site) —
 * letting the normal LLM pipeline handle it.
 */
async function maybeBuildDatasourceMenu(
  client: TableauClient,
  message: string,
  priorMessages: Array<{ role?: string | null; content?: string | null; toolCalls?: string | null }>,
): Promise<{ reply: string; toolCalls: [{ type: "menu"; options: { label: string; value: string }[] }] } | null> {
  if (!isDataAggregationRequest(message)) return null;
  // Don't re-ask when the previous assistant message was already this menu and
  // the user is replying to it ("3", "Sales", ...).
  const lastAssistant = [...priorMessages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant?.content?.includes(DS_MENU_MARKER)) return null;
  if (conversationEstablishedDatasource(priorMessages)) return null;

  // list_datasources is cached (ds_list namespace), so this is one fast call —
  // never an LLM round.
  const dsResult = await executeTool(client, "list_datasources", { limit: 10 });
  if (!dsResult || typeof dsResult !== "object" || dsResult.error) return null;
  const datasources: Array<{ name?: string }> = Array.isArray(dsResult.datasources) ? dsResult.datasources : [];
  const totalDs = Number(dsResult.total ?? datasources.length);
  if (!datasources.length) return null;

  const lines = [DS_MENU_MARKER, ""];
  datasources.forEach((ds, i) => lines.push(`${i + 1}. ${ds.name ?? `Data source ${i + 1}`}`));
  lines.push(
    "",
    `Reply with the number or name above — or name a specific workbook and I'll use its own data source.` +
      (totalDs > datasources.length ? ` (${totalDs - datasources.length} more data sources are available — say "more" if needed.)` : ""),
  );

  return {
    reply: lines.join("\n"),
    toolCalls: [
      {
        type: "menu",
        options: datasources.map((ds) => ({ label: ds.name ?? "Data source", value: ds.name ?? "" })),
      },
    ],
  };
}

// Deterministic safety gate for content-mutating tools — seen in practice: a
// weak/hallucinating model asked a plain read-only question ("count of total
// workbooks") went on to call add_tags/remove_tags with fabricated values on
// an unrelated real workbook, unprompted. System-prompt wording alone has
// already proven unreliable for steering weak models all session (same
// lesson as the overview-menu gate above); for tools that WRITE to the
// user's real Tableau content, that risk is unacceptable, so it's enforced
// here in code instead of trusted to the model's judgment. Each write tool
// only proceeds if the CURRENT user message plausibly asked for that kind of
// action — a false block (the model correctly inferred intent from earlier
// conversation context, but this message alone doesn't mention it) is a far
// smaller cost than a hallucinated mutation succeeding silently.
const WRITE_TOOL_INTENT_PATTERNS: Record<string, RegExp> = {
  add_tags: /\btag/i,
  remove_tags: /\b(un)?tag/i,
  add_favorite: /favorit/i,
  remove_favorite: /(un)?favorit/i,
};

function isWriteActionExplicitlyRequested(toolName: string, userMessage: string): boolean {
  const pattern = WRITE_TOOL_INTENT_PATTERNS[toolName];
  return !pattern || pattern.test(userMessage);
}

chatRouter.post("/:conversationId/message", async (req: AuthedRequest, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "message is required" });
  }
  const userId = req.userId!;

  // Every lookup below is scoped to this request's authenticated userId —
  // there is no path from here to another user's connection or conversation.
  const { data: convRow, error: convErr } = await supabase
    .from(Tables.conversations)
    .select("*")
    .eq("id", req.params.conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  logSupabaseError("load conversation", convErr);
  const conversation = mapConversation(convRow);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  // Prompting the model to "ask A/B/C before fetching" proved unreliable in
  // practice — weaker/free-tier models repeatedly called get_dashboard_summary
  // (or get_view_image) immediately anyway, no matter how the system prompt
  // rules were worded (the same lesson already learned for scope enforcement:
  // see executeScopedTool). So for a view-scoped conversation, enforce the
  // ask deterministically in code instead of relying on the LLM to follow
  // it — this bypasses the LLM/tool loop entirely for a bare overview
  // request, guaranteeing the menu is what the user sees.
  if (conversation.scopeViewId && isGenericOverviewRequest(parsed.data.message)) {
    const { data: lastAssistantRow, error: lastErr } = await supabase
      .from(Tables.messages)
      .select("*")
      .eq("conversation_id", conversation.id)
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    logSupabaseError("load last assistant message", lastErr);
    const lastAssistantMessage = mapMessage(lastAssistantRow);
    const menuWasJustAsked = lastAssistantMessage?.content.includes(OVERVIEW_MENU_MARKER) ?? false;

    if (!menuWasJustAsked) {
      const { data: anyMsgRow } = await supabase
        .from(Tables.messages)
        .select("id")
        .eq("conversation_id", conversation.id)
        .limit(1)
        .maybeSingle();
      const isFirstMessage = !anyMsgRow;
      await supabase.from(Tables.messages).insert({
        conversation_id: conversation.id,
        role: "user",
        content: parsed.data.message,
      });
      const menu = buildOverviewMenu(conversation.scopeViewName ?? "this", conversation.scopeViewLink);
      const menuOptions = buildOverviewMenuOptions(conversation.scopeViewLink);
      await supabase.from(Tables.messages).insert({
        conversation_id: conversation.id,
        role: "assistant",
        content: menu,
        tool_calls: JSON.stringify(menuOptions),
      });
      const menuTitle = isFirstMessage ? deriveConversationTitle(parsed.data.message) : undefined;
      if (menuTitle) {
        await supabase.from(Tables.conversations).update({ title: menuTitle }).eq("id", conversation.id);
      }
      return res.json({ reply: menu, toolCalls: menuOptions, ...(menuTitle ? { title: menuTitle } : {}) });
    }
  }

  const [tableauClient, llmConn] = await Promise.all([
    getTableauClientForUser(userId),
    loadLlmConnectionForUser(userId),
  ]);
  if (!tableauClient) {
    return res.status(400).json({ error: "No Tableau connection configured for this account" });
  }
  if (!llmConn) {
    return res.status(400).json({ error: "No LLM connection configured for this account" });
  }

  // The rest of this handler streams NDJSON progress events to the browser so
  // the UI can show live tool activity instead of a static spinner. Content-
  // type tells the frontend to parse this as a stream (the overview-menu path
  // above still returns plain JSON). Headers are flushed immediately so the
  // first events reach the browser before the first slow Tableau call.
  res.type("application/x-ndjson");
  res.set("Cache-Control", "no-cache");
  res.flushHeaders();
  const send = (obj: object) => res.write(JSON.stringify(obj) + "\n");
  send({ type: "progress", label: "Lumen is thinking…" });

  // Track client aborts (Stop button). If the user cancels mid-flight, the
  // connection closes with res.writableEnded false — skip persisting the
  // finished answer so a stopped request doesn't ghost a message later.
  let aborted = false;
  res.on("close", () => {
    if (!res.writableEnded) aborted = true;
  });

  const apiKey = decryptSecret(llmConn.encrypted_api_key);
  const llm = createLlmAdapter(llmConn.provider as LlmProviderName, apiKey, llmConn.model);

  // FAST PATH: try to answer simple questions without an LLM call.
  // This handles common queries (counts, lists, help) in <100ms instead of
  // waiting for the full LLM pipeline (which can take 30-120s).
  // Skipped entirely in a scoped chat: its answers are site-wide (e.g. "how
  // many workbooks" → the whole-site total), which would contradict the
  // conversation's locked project/workbook/view scope.
  if (!conversation.scopeViewId && !conversation.scopeWorkbookId && !conversation.scopeProjectId) {
    try {
      const fastResult = await tryFastPath(parsed.data.message, tableauClient);
      if (fastResult && !aborted) {
        // Persist the exchange
        await supabase.from(Tables.messages).insert({
          conversation_id: conversation.id,
          role: "user",
          content: parsed.data.message,
        });
        await supabase.from(Tables.messages).insert({
          conversation_id: conversation.id,
          role: "assistant",
          content: fastResult.response,
          tool_calls: fastResult.toolCalls.length ? JSON.stringify(fastResult.toolCalls) : null,
        });
        send({ type: "result", reply: fastResult.response, toolCalls: fastResult.toolCalls });
        return res.end();
      }
    } catch (fastErr: any) {
      console.warn(`[chat] Fast path error: ${fastErr?.message ?? fastErr} — falling back to LLM`);
    }
  }

  // Cap how much history gets replayed to the model. An unbounded
  // conversation eventually blows a small/free-tier provider's per-request
  // token budget on its own — before this message's own tool calls even run
  // — since every prior get_dashboard_summary/get_view_data CSV preview and
  // every prior turn's text stays in the payload forever otherwise. Fetch
  // the most recent MAX_HISTORY_MESSAGES (newest-first, then put back in
  // chronological order) rather than the whole conversation.
  const MAX_HISTORY_MESSAGES = 16;
  const { data: historyRows, error: historyErr } = await supabase
    .from(Tables.messages)
    .select("*")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY_MESSAGES);
  logSupabaseError("load history", historyErr);
  const priorMessages = (historyRows ?? [])
    .map(mapMessage)
    .filter((m): m is NonNullable<ReturnType<typeof mapMessage>> => m !== null)
    .reverse();

  // Ids (workbookId, viewId, datasourceLuid, ...) legitimately discovered so
  // far in this conversation, seeded from every previous tool call's result.
  // Used below to reject a tool call that references an id the model never
  // actually saw — see findUnknownId in idTracking.ts for why prompting
  // alone ("never invent an id") isn't relied on for this.
  const knownIds = new Set<string>();
  for (const m of priorMessages) {
    if (!m.toolCalls) continue;
    const parsed: any[] = JSON.parse(m.toolCalls);
    if (Array.isArray(parsed)) {
      for (const c of parsed) collectIds(c?.result, knownIds);
    }
  }

  const history: ChatMessage[] = [];
  for (const m of priorMessages) {
    const parsedCalls = m.toolCalls ? JSON.parse(m.toolCalls) : undefined;
    // The overview A/B/C menu (buildOverviewMenuOptions) is stored in this
    // same column for the frontend's button rendering, but it was never a
    // real tool call — replaying it as one hands the provider a
    // tool_calls entry with no name/id/arguments (those come out
    // `undefined` and get silently dropped by JSON.stringify), which
    // surfaces as a confusing "missing field `name`" 400 from the
    // provider. Strip it back out to plain text-only history here.
    const isMenu = Array.isArray(parsedCalls) && parsedCalls.length === 1 && parsedCalls[0]?.type === "menu";
    const toolCalls = isMenu ? undefined : Array.isArray(parsedCalls) ? parsedCalls : undefined;
    history.push({ role: m.role as ChatMessage["role"], content: m.content, toolCalls });

    // REHYDRATE TOOL RESULTS. Tool results are never stored as their own DB
    // rows — they only live inside the assistant row's tool_calls JSON (the
    // `result` field of each call). If we replay the assistant's tool_calls
    // without the matching tool-result messages that must follow them, the
    // provider request contains tool_calls with NO responses — strict
    // backends (NVIDIA/OpenRouter) reject that with a 400, which is exactly
    // why the same question worked in a NEW chat but errored in an EXISTING
    // one. Rebuild each tool result from the persisted call metadata.
    // Images are deliberately NOT replayed (the original design choice: the
    // model already saw the image when the call first ran; re-sending base64
    // on every future turn would bloat the request and re-trigger 413s).
    if (toolCalls && toolCalls.length) {
      for (const c of toolCalls) {
        if (!c?.id) continue;
        const raw = c.result;
        const content = typeof raw === "string" ? raw : raw == null ? "{}" : JSON.stringify(raw);
        history.push({ role: "tool", content, toolCallId: c.id, toolName: c.name ?? "tool" });
      }
    }
  }
  history.unshift({ role: "system", content: SYSTEM_PROMPT + scopeSystemPromptAddendum(conversation) });
  history.push({ role: "user", content: parsed.data.message });

  // Don't just block scoped-out tools at execution time — don't even offer
  // their schemas to the model. Full tool definitions (name + description +
  // JSON schema) are real fixed token overhead on every single request; a
  // scoped conversation typically has no legitimate use for ~8 of the 42
  // tools anyway (see getBlockedToolNames), so cutting them here reduces
  // cost/rate-limit pressure on every message, not just image ones.
  const blockedToolNames = getBlockedToolNames(conversation);
  let availableToolDefinitions = blockedToolNames.size
    ? toolDefinitions.filter((t) => !blockedToolNames.has(t.name))
    : toolDefinitions;

  // A pure site-search question must be answered with search_content/list
  // tools — under NO circumstances with a datasource query. Withhold the
  // data-query/analytical tools for this request so a weak model physically
  // can't call query_datasource/get_datasource_metadata/get_field_values on
  // a "search for anything named X" message (seen in practice before this
  // guard existed). Only applies to THIS turn; the next message is a normal
  // request again.
  if (SEARCH_INTENT_RE.test(parsed.data.message)) {
    availableToolDefinitions = availableToolDefinitions.filter((t) => !DATASOURCE_QUERY_TOOLS.includes(t.name));
  }

  await supabase.from(Tables.messages).insert({
    conversation_id: conversation.id,
    role: "user",
    content: parsed.data.message,
  });

  // Deterministic "which data source/workbook?" gate — runs BEFORE any LLM
  // turn. If the request aggregates/analyzes data without naming a data source
  // or workbook (and none is established yet in this conversation), ask the
  // user to pick instead of letting the model guess one (unscoped chats only —
  // a view/workbook/project-scoped chat already has its content locked in).
  if (!conversation.scopeViewId && !conversation.scopeWorkbookId && !conversation.scopeProjectId) {
    const dsMenu = await maybeBuildDatasourceMenu(tableauClient, parsed.data.message, priorMessages);
    if (dsMenu && !aborted) {
      await supabase.from(Tables.messages).insert({
        conversation_id: conversation.id,
        role: "assistant",
        content: dsMenu.reply,
        tool_calls: JSON.stringify(dsMenu.toolCalls),
      });
      // Auto-title a brand-new conversation from its first message, exactly
      // like the overview-menu gate and the main LLM path do.
      const dsMenuTitle =
        priorMessages.length === 0 && (!conversation.title || conversation.title === "New chat")
          ? deriveConversationTitle(parsed.data.message)
          : undefined;
      if (dsMenuTitle) {
        await supabase.from(Tables.conversations).update({ title: dsMenuTitle }).eq("id", conversation.id);
      }
      send({ type: "result", reply: dsMenu.reply, toolCalls: dsMenu.toolCalls, ...(dsMenuTitle ? { title: dsMenuTitle } : {}) });
      return res.end();
    }
  }

  // Auto-title the conversation from its first message, the same way
  // ChatGPT-style UIs do — otherwise every sidebar entry is stuck showing
  // the generic "New chat" placeholder it was created with, which makes a
  // history of more than a couple of chats unusable to tell apart.
  let updatedTitle: string | undefined;
  if (priorMessages.length === 0 && (!conversation.title || conversation.title === "New chat")) {
    updatedTitle = deriveConversationTitle(parsed.data.message);
    await supabase.from(Tables.conversations).update({ title: updatedTitle }).eq("id", conversation.id);
  }

  let finalAnswer = "";
  let toolCallLog: any[] = [];
  // Separate from toolCallLog: this is what actually goes back in the HTTP
  // response for THIS turn (never persisted to DB, never fed back into the
  // model) so the browser can render an image inline, e.g. from
  // get_view_image. toolCallLog stays redacted for storage/history to avoid
  // bloating the DB row and the reconstructed-history payload sent to the
  // model on the next turn.
  let responseToolCalls: any[] = [];

  // Everything from here on makes a network call to a third-party LLM/Tableau
  // API — a provider error must never crash the process. Catch it, log a
  // safe (secret-free) summary server-side, persist a visible error message
  // in the conversation, and return 502 to the client.
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const turn = await sendTurnWithImageFallback(llm, history, availableToolDefinitions as any);

      // Meter every LLM turn (usage metering/monetization). Fire-and-forget:
      // recordLlmUsage swallows its own failures so a metering hiccup can
      // never break the conversation.
      if (turn.usage) {
        await recordLlmUsage({
          userId,
          provider: llmConn.provider,
          model: llmConn.model,
          promptTokens: turn.usage.promptTokens,
          completionTokens: turn.usage.completionTokens,
        });
      }

      if (turn.type === "final_answer") {
        // Weak models sometimes dump a tool result's raw JSON straight into
        // the reply instead of interpreting it (seen in practice: the user
        // asked "how many workbooks" and got {"total":0,...} verbatim).
        // Deterministically reformatting that case here guarantees the user
        // always sees a human-readable answer, whatever the model does.
        const cleaned = sanitizeFinalAnswer(turn.text);
        finalAnswer = finalAnswer ? `${finalAnswer}${cleaned}` : cleaned;
        history.push({ role: "assistant", content: cleaned });
        if (turn.finishReason === "length" && round < MAX_TOOL_ROUNDS - 1) {
          // The completion hit the output-token limit mid-answer. Ask the
          // model to continue exactly where it stopped instead of delivering
          // a silently truncated reply as if it were complete (seen in
          // practice: verbatim workbook descriptions cut off at the
          // provider's ~1024-token default when max_tokens was omitted).
          history.push({
            role: "user",
            content:
              "Your previous reply was cut off by the output length limit before it was complete. Continue EXACTLY where you stopped — do not repeat anything you already wrote, do not call any tools, and finish the complete answer.",
          });
          continue;
        }
        break;
      }

      // turn.type === "tool_calls"
      history.push({ role: "assistant", content: turn.assistantText ?? "", toolCalls: turn.calls });

      for (const call of turn.calls) {
        send({ type: "tool", name: call.name, label: toolLabel(call.name) });
        // Scoped conversations (view/workbook/project) already force their
        // id argument to the real scoped id in executeScopedTool, so a
        // hallucinated UUID id there is harmless — it gets overwritten
        // before it ever reaches Tableau — AND scoped ids legitimately come
        // from the system prompt (the UI scope dropdown), not from any tool
        // result, so the unknown_uuid check would false-positive on them.
        // Scoped conversations therefore only get the shape/placeholder
        // checks; unscoped conversations get all three.
        const isScopedConv = !!(conversation.scopeViewId || conversation.scopeWorkbookId || conversation.scopeProjectId);
        const foundInvalid = findInvalidIdArg(call.input, knownIds);
        const invalidArg =
          foundInvalid && isScopedConv && foundInvalid.reason === "unknown_uuid" ? null : foundInvalid;
        const invalidIdError = invalidArg && {
          not_uuid_shape: `The "${invalidArg.arg}" argument was set to "${invalidArg.value}", which is not a real Tableau id — it looks like placeholder text, not an id. Real ids are UUIDs returned by earlier discovery tools in this conversation. Call the matching discovery tool first (e.g. list_workbooks, list_workbook_views, list_datasources, search_content) and copy the id EXACTLY from its result — never write an id from memory.`,
          unknown_uuid: `The id "${invalidArg.value}" hasn't been discovered in this conversation — it wasn't returned by any earlier tool call, so it looks invented rather than real. Call the matching discovery tool first (e.g. list_workbooks, list_workbook_views, list_datasources, search_content) to get a real id from its result, then retry with that id.`,
          placeholder: `The "${invalidArg.arg}" argument was set to "${invalidArg.value}" — a conversational phrase, not a real value. Either use a concrete value that appeared in an earlier tool result, or omit this optional filter entirely (call the tool with no filter arguments to search the whole site).`,
        }[invalidArg.reason];
        const result =
          call.name in WRITE_TOOL_INTENT_PATTERNS && !isWriteActionExplicitlyRequested(call.name, parsed.data.message)
            ? {
                error:
                  "This action modifies your Tableau content (tags/favorites) and your message didn't explicitly ask for it, so it was blocked for safety. If you want this done, ask for it directly — e.g. \"add the tag 'finance' to this workbook\".",
              }
            : invalidArg
              ? { error: invalidIdError! }
              : await executeScopedTool(conversation, tableauClient, call.name, call.input);
        if (result) collectIds(result, knownIds);

        // get_view_image (and any future image-producing tool) returns raw
        // base64 in the result. Route the actual bytes to the model via
        // ChatMessage.image (each adapter delivers it appropriately — see
        // AnthropicAdapter/OpenAiAdapter) instead of dumping a huge base64
        // string into the tool-result text, which no model meaningfully
        // reads as an image and which would bloat conversation history,
        // the DB row, and the toolCalls payload sent back to the frontend.
        // Only image/* mediaTypes go to the model: get_view_pdf returns
        // bytes with mediaType "application/pdf", which is a document for
        // the user, not an image the model can read — those are persisted
        // for the frontend (embed/download) but never attached to the tool
        // message the adapters see.
        let image: { mediaType: string; base64: string } | undefined;
        let pdf: { mediaType: string; base64: string } | undefined;
        let loggedResult = result;
        if (result && typeof result.imageBase64 === "string") {
          const mediaType = result.mediaType || "image/png";
          if (mediaType.startsWith("image/")) {
            image = { mediaType, base64: result.imageBase64 };
          }
          const { imageBase64, ...rest } = result;
          loggedResult = { ...rest, imageBase64: `[omitted from log — ${Math.round(imageBase64.length / 1024)}KB]` };
        } else if (result && typeof result.pdfBase64 === "string") {
          const mediaType = result.mediaType || "application/pdf";
          pdf = { mediaType, base64: result.pdfBase64 };
          const { pdfBase64, ...rest } = result;
          loggedResult = { ...rest, pdfBase64: `[omitted from log — ${Math.round(pdfBase64.length / 1024)}KB, delivered to the frontend as a document]` };
        }

        // id must be included — this same array is persisted to the DB and,
        // on the NEXT chat message in this conversation, JSON.parse'd back
        // into ChatMessage.toolCalls to rebuild history for the LLM. Without
        // id here, that reconstructed tool call silently loses it (dropped
        // by JSON.stringify on undefined), producing a malformed tool_use/
        // tool_calls entry on the follow-up request — surfaces as "missing
        // field `id`" on strict backends (NVIDIA/OpenRouter), and would
        // equally break Anthropic's tool_use id requirement.
        // image is persisted here too (not just in responseToolCalls) so a
        // page refresh — which reloads messages from the DB rather than
        // replaying this in-memory turn — still has the bytes to render the
        // thumbnail/toggle/lightbox. It's never replayed back to the LLM: on
        // the next turn, history is rebuilt from these DB rows as
        // user/assistant text + toolCalls metadata only (see priorMessages
        // mapping above) — no "tool" role messages are reconstructed from
        // storage, so this base64 never re-enters a provider request.
        // thoughtSignature (Gemini 3 thinking models) is persisted alongside
        // the call so a later turn that replays this history can echo it back
        // on the functionCall part — Gemini 400s without it. Other providers
        // ignore the field.
        toolCallLog.push({
          id: call.id,
          name: call.name,
          input: call.input,
          result: loggedResult,
          ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
          ...(image ? { image } : {}),
          ...(pdf ? { pdf } : {}),
        });
        responseToolCalls.push({
          id: call.id,
          name: call.name,
          input: call.input,
          result: loggedResult,
          ...(image ? { image } : {}),
          ...(pdf ? { pdf } : {}),
        });
        history.push({
          role: "tool",
          content: JSON.stringify(loggedResult),
          toolCallId: call.id,
          toolName: call.name,
          image,
        });
        send({ type: "tool", name: call.name, done: true });
      }

      if (round === MAX_TOOL_ROUNDS - 1) {
        // Preserve any answer content already generated (e.g. partial
        // continuation rounds) rather than discarding it wholesale.
        finalAnswer = finalAnswer
          ? `${finalAnswer}\n\n_(The reply was cut off before it could be fully completed — ask me to continue.)_`
          : "I made several tool calls but couldn't finish within the allotted turns. Please rephrase or narrow your question.";
      }
    }
  } catch (err: any) {
    // Log the full nested provider payload server-side — OpenRouter/NIM wrap
    // the actual failure reason inside error.metadata.raw, which err.message
    // alone doesn't show.
    console.error(
      `LLM turn failed (provider=${llmConn.provider}, model=${llmConn.model}):`,
      JSON.stringify(
        {
          // status/error cover a normal API error response; ctorName/message
          // cover the other common case — a connection-level failure (DNS,
          // TLS, timeout, or an invalid model routing to nothing) that never
          // got a structured API response to begin with. Logging only the
          // first pair produces an unhelpful "{}" for exactly that case.
          status: err?.status,
          error: err?.error,
          ctorName: err?.constructor?.name,
          message: err?.message,
        },
        null,
        2,
      ),
    );
    const friendly = describeProviderError(err);
    if (!aborted) {
      await supabase.from(Tables.messages).insert({
        conversation_id: conversation.id,
        role: "assistant",
        content: friendly,
      });
    }
    res.status(502);
    send({ type: "error", message: friendly });
    return res.end();
  }

  if (aborted) {
    res.end();
    return;
  }

  await supabase.from(Tables.messages).insert({
    conversation_id: conversation.id,
    role: "assistant",
    content: finalAnswer,
    tool_calls: toolCallLog.length ? JSON.stringify(toolCallLog) : null,
  });

  send({ type: "result", reply: finalAnswer, toolCalls: responseToolCalls, ...(updatedTitle ? { title: updatedTitle } : {}) });
  res.end();
});

/** First line of the user's opening message, trimmed to a short sidebar-friendly title. */
function deriveConversationTitle(message: string): string {
  const firstLine = message.split("\n")[0].trim();
  if (!firstLine) return "New chat";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

// ---------------------------------------------------------------------------
// Final-answer sanitation lives in src/lib/answerFormat.ts (sanitizeFinalAnswer)
// so it stays unit-testable outside the route.
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  list_projects: "Scanning your projects…",
  list_workbooks: "Scanning your workbooks…",
  list_flows: "Scanning your flows…",
  list_virtual_connections: "Scanning virtual connections…",
  list_datasources: "Scanning your datasources…",
  list_site_views: "Scanning dashboards on your site…",
  search_content: "Searching your Tableau site…",
  search_fields: "Searching for fields…",
  list_pulse_metrics: "Scanning Pulse metrics…",
  list_users: "Scanning site users…",
  list_workbook_views: "Finding views in this workbook…",
  get_view_data: "Pulling view data…",
  get_view_image: "Fetching dashboard snapshot…",
  get_view_pdf: "Preparing the PDF…",
  get_dashboard_summary: "Summarizing dashboard…",
  get_dashboard_insights: "Computing dashboard insights…",
  list_workbook_datasources: "Finding this workbook's datasources…",
  get_datasource_metadata: "Loading datasource metadata…",
  get_datasource_glossary: "Loading field glossary…",
  get_field_usage: "Checking where this field is used…",
  query_datasource: "Querying your datasource…",
  get_field_values: "Fetching field values…",
  get_metric_definition: "Loading metric definition…",
  check_permissions: "Checking permissions…",
  refresh_extract_status: "Checking extract status…",
  recommend_visualization: "Recommending a chart type…",
  compare_periods: "Comparing periods…",
  explain_change: "Explaining what drove the change…",
  anomaly_detection: "Scanning for anomalies…",
  forecast_metric: "Running a forecast…",
  get_metric_history: "Loading metric history…",
  get_data_quality_warnings: "Checking data quality…",
  get_field_lineage: "Tracing field lineage…",
  cross_datasource_query: "Querying across datasources…",
  rank_categories: "Ranking categories…",
  pivot_cross_tab: "Building cross-tab…",
  rollup_time_series: "Rolling up the time series…",
  correlation_analysis: "Analyzing correlation…",
  field_statistics: "Profiling field statistics…",
  bucketize_metric: "Bucketing metric values…",
  share_of_total: "Computing share of total…",
  get_summary_table: "Building the summary table…",
  get_workbook_details: "Loading workbook details…",
  get_workbook_thumbnail: "Fetching workbook thumbnail…",
  list_workbook_revisions: "Listing workbook revisions…",
  list_tags: "Loading tags…",
  add_tags: "Adding tags…",
  remove_tags: "Removing tags…",
  list_favorites: "Loading favorites…",
  add_favorite: "Adding to favorites…",
  remove_favorite: "Removing from favorites…",
  list_custom_views: "Loading custom views…",
  get_custom_view_image: "Fetching custom view image…",
  get_data_quality_warning: "Checking data quality flags…",
  query_workbook_permissions: "Checking workbook permissions…",
  query_view_permissions: "Checking view permissions…",
  query_datasource_permissions: "Checking datasource permissions…",
  list_subscriptions: "Loading subscriptions…",
  list_data_driven_alerts: "Loading data-driven alerts…",
  list_schedules: "Loading schedules…",
  list_groups: "Loading groups…",
  get_group_members: "Loading group members…",
  get_server_info: "Fetching server info…",
};

/** Human-friendly label for a tool call, streamed to the chat UI as live progress. */
function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `Working with ${name}…`;
}

/**
 * Turns a raw SDK/provider error into a message a non-technical user can
 * actually understand — no status codes, error class names, or raw
 * upstream JSON here. The full technical detail is still logged server-side
 * via console.error just above every call site, for debugging. Never
 * includes the API key.
 */
function describeProviderError(err: any): string {
  const status = err?.status;
  const providerMessage = err?.error?.message || err?.message;

  // OpenRouter (and some other gateways) wrap the real upstream failure as a
  // JSON string in error.metadata.raw.
  let upstreamDetail: string | undefined;
  const raw = err?.error?.metadata?.raw;
  if (typeof raw === "string") {
    try {
      upstreamDetail = JSON.parse(raw)?.error?.message;
    } catch {
      upstreamDetail = raw;
    }
  }

  const combinedMessage = String(providerMessage) + String(upstreamDetail ?? "");

  // Connection-level failure (DNS, TLS, firewall, offline, invalid host) — the
  // request never got an HTTP response at all, so there's no status code. The
  // OpenAI SDK throws this as APIConnectionError with message "Connection error."
  // Handle this FIRST, before the status-code checks below, since `status` is
  // undefined for this case and it would otherwise fall through to the generic
  // "something went wrong" message — which is misleading because the key itself
  // is fine, the problem is purely network connectivity.
  const looksLikeConnectionError = !status && (/connect|network|dns|tls|ssl|timeout|econnrefused|enotfound|unreachable|getaddrinfo/i.test(combinedMessage) || /connection error/i.test(combinedMessage));
  if (looksLikeConnectionError) {
    return "We couldn't connect to your AI provider. Please check your internet connection, then try again. If the problem persists, the provider's servers may be temporarily down.";
  }

  // The model's own inference server (NIM/vLLM) can advertise tool-calling
  // while still being deployed without vision support — e.g. get_view_image
  // sent it an image and the server rejects it. This is a deployment config
  // issue on the provider's side, not something fixable by retrying.
  if (/multimodal/i.test(combinedMessage)) {
    return (
      "This AI model can't look at images. Try asking for the underlying numbers instead " +
      "(for example, \"show me the data for this dashboard\"), or pick a different model that supports images " +
      "in your AI connection settings."
    );
  }

  const looksLikeToolIncompatibility = status === 400 && /tool|function|missing field/i.test(combinedMessage);

  if (looksLikeToolIncompatibility) {
    return "This AI model doesn't support the kind of requests this app needs to send it. Please pick a different model in your AI connection settings.";
  }
  if (status === 401 || status === 403) {
    return "Your AI provider rejected this API key. Please check it in your AI connection settings.";
  }
  if (status === 429) {
    return "Your AI provider is temporarily limiting requests on this key. Please wait a moment and try again.";
  }
  if (status === 503) {
    return "This model is currently experiencing high demand. Spikes in demand are usually temporary — please try again in a moment.";
  }
  if (status === 413) {
    return "That request was too big for this AI model to handle. Try asking a narrower question, or picking a different model in your AI connection settings.";
  }
  return "Something went wrong talking to your connected AI provider. Please try again in a moment.";
}
