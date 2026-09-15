import { TableauClient } from "../tableau/client.js";
import { executeTool } from "../tools/index.js";

export interface ConversationScope {
  scopeProjectId: string | null;
  scopeProjectName: string | null;
  scopeWorkbookId: string | null;
  scopeWorkbookName: string | null;
  scopeWorkbookLink: string | null;
  scopeViewId: string | null;
  scopeViewName: string | null;
  scopeViewLink: string | null;
}

const DISCOVERY_TOOLS = ["list_projects", "list_workbooks", "list_flows", "list_virtual_connections", "list_site_views", "search_content", "search_fields"];

// list_datasources browses EVERY datasource on the whole site — there's
// never a legitimate reason for a scoped conversation to need that, so it
// stays blocked at every scope level, same as the other site-wide discovery
// tools above.
const SITE_WIDE_DATASOURCE_TOOLS = ["list_datasources"];

// get_datasource_metadata/query_datasource/get_field_values used to be
// blocked unconditionally under any scope, because there was no legitimate
// way to discover "the datasource behind this scoped view/workbook" without
// the browsing tools already disabled — a model that wanted one would just
// invent a datasourceLuid (seen in practice). list_workbook_datasources (see
// tableauTools.ts) now closes that gap: it reads the scoped workbook's own
// connections and returns any datasourceLuid actually published/queryable
// there. So these are safe to allow once a workbook is pinned (view or
// workbook scope) or once the model has legitimately discovered a workbookId
// via list_workbooks (project scope) — the model just has no excuse to
// invent an id anymore, whatever the scope.
//
// The Tier-1 analytical tools that take a datasourceLuid (compare_periods,
// explain_change, anomaly_detection, forecast_metric, data-quality, lineage,
// cross_datasource_query, rank_categories, pivot_cross_tab,
// rollup_time_series, correlation_analysis, field_statistics,
// bucketize_metric, share_of_total, get_summary_table) are the same
// category — they only read whatever datasource the model has legitimately
// discovered, so they follow the same rule. search_fields (site-wide field
// search) and search_content stay blocked at every scope. get_metric_history
// takes a Pulse definitionId (no forgeable datasourceLuid) so it's left
// unrestricted like the other Pulse tools.
export const DATASOURCE_QUERY_TOOLS = [
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
];

// Content tools that read/write a specific workbook's metadata — pinned the
// same way as the view/workbook browsing tools, since the argument is
// forceable to the scoped id and there's no reason for a scoped conversation
// to touch a different workbook.
const WORKBOOK_CONTENT_TOOLS = [
  "get_workbook_details",
  "get_workbook_thumbnail",
  "list_workbook_revisions",
  "list_tags",
  "add_tags",
  "remove_tags",
  "query_workbook_permissions",
];

// Content tools pinned to a specific view. list_custom_views is left
// unrestricted (it only takes an optional workbookId filter), and the
// favorites/admin tools are site-level so they fall through to the
// default executeTool path below.
const VIEW_CONTENT_TOOLS = ["get_view_pdf", "query_view_permissions"];

/**
 * Names of tools that should not even be OFFERED to the model for a scoped
 * conversation — mirrors executeScopedTool's exact blocking conditions below
 * (same constants, so the two can't drift apart). Filtering these out of the
 * `tools` array sent to the LLM (done in chat.ts) isn't just a safety
 * belt-and-suspenders measure: it also meaningfully shrinks the fixed
 * per-request token overhead — full tool schemas for 8 of the 42 tools
 * (view/workbook scope) or 5 (project scope) add up, and every scoped
 * conversation pays that cost on every single message regardless of whether
 * an image is involved.
 */
export function getBlockedToolNames(scope: ConversationScope): Set<string> {
  if (scope.scopeViewId || scope.scopeWorkbookId) {
    return new Set([...DISCOVERY_TOOLS, ...SITE_WIDE_DATASOURCE_TOOLS]);
  }
  if (scope.scopeProjectId) {
    return new Set(["list_projects", "list_site_views", "search_content", "search_fields", ...SITE_WIDE_DATASOURCE_TOOLS]);
  }
  return new Set();
}

/**
 * Enforces a conversation's drill-down scope (Project -> Workbook -> View)
 * at the tool-execution boundary — not just via prompting. We've already
 * seen prompting alone doesn't reliably stop a model from calling the wrong
 * tool or inventing an id, so scope has to be a hard server-side rule:
 * either the argument is forced to the scoped id (view/workbook browsing
 * tools), or the call is rejected outright before it ever reaches Tableau
 * (broader discovery tools, and datasource tools, once scoped).
 *
 * Pulse and admin tools aren't part of the project/workbook/view hierarchy
 * either, but unlike datasource tools they don't take an id that could be
 * forged from scope context, so they're left unrestricted — the system
 * prompt addendum tells the model to stay on-topic for those instead.
 */
export async function executeScopedTool(
  scope: ConversationScope,
  client: TableauClient,
  name: string,
  args: any,
): Promise<any> {
  if (scope.scopeViewId) {
    if (name === "get_view_data" || name === "get_view_image" || name === "get_dashboard_insights") {
      return executeTool(client, name, { ...args, viewId: scope.scopeViewId });
    }
    if (name === "get_dashboard_summary") {
      return executeTool(client, name, { ...args, viewId: scope.scopeViewId, workbookId: scope.scopeWorkbookId });
    }
    if (name === "list_workbook_views" || name === "list_workbook_datasources") {
      return executeTool(client, name, { ...args, workbookId: scope.scopeWorkbookId });
    }
    if (DATASOURCE_QUERY_TOOLS.includes(name)) {
      return executeTool(client, name, args);
    }
    if (VIEW_CONTENT_TOOLS.includes(name)) {
      return executeTool(client, name, { ...args, viewId: scope.scopeViewId });
    }
    if (WORKBOOK_CONTENT_TOOLS.includes(name)) {
      return executeTool(client, name, { ...args, workbookId: scope.scopeWorkbookId });
    }
    if (DISCOVERY_TOOLS.includes(name) || SITE_WIDE_DATASOURCE_TOOLS.includes(name)) {
      return {
        error: `This chat is scoped to the view "${scope.scopeViewName}" — browsing other content and listing site-wide datasources are both disabled here. Use get_view_data (or get_view_image for visual questions) to answer from this view's own data, or list_workbook_datasources to find this workbook's own datasource for a deeper query. Clear the drill-down (or start a new chat) to browse/query elsewhere.`,
      };
    }
    return executeTool(client, name, args);
  }

  if (scope.scopeWorkbookId) {
    if (name === "list_workbook_views" || name === "get_dashboard_summary" || name === "list_workbook_datasources") {
      return executeTool(client, name, { ...args, workbookId: scope.scopeWorkbookId });
    }
    if (DATASOURCE_QUERY_TOOLS.includes(name)) {
      return executeTool(client, name, args);
    }
    if (WORKBOOK_CONTENT_TOOLS.includes(name)) {
      return executeTool(client, name, { ...args, workbookId: scope.scopeWorkbookId });
    }
    if (DISCOVERY_TOOLS.includes(name) || SITE_WIDE_DATASOURCE_TOOLS.includes(name)) {
      return {
        error: `This chat is scoped to the workbook "${scope.scopeWorkbookName}" — browsing other workbooks/projects and listing site-wide datasources are both disabled here. Use list_workbook_views to find a view, then get_view_data/get_view_image to answer from it, or list_workbook_datasources for a deeper query against this workbook's own datasource. Clear the drill-down (or start a new chat) to browse/query elsewhere.`,
      };
    }
    return executeTool(client, name, args);
  }

  if (scope.scopeProjectId) {
    if (name === "list_workbooks") {
      return executeTool(client, name, { ...args, projectName: scope.scopeProjectName });
    }
    if (name === "list_projects" || name === "list_site_views" || name === "search_content" || name === "search_fields" || SITE_WIDE_DATASOURCE_TOOLS.includes(name)) {
      return {
        error: `This chat is scoped to the project "${scope.scopeProjectName}" — browsing other projects, site-wide field search, and listing site-wide datasources are all disabled here. Use list_workbooks, then list_workbook_views and get_view_data/get_view_image to answer from a specific view. Clear the drill-down (or start a new chat) to browse/query elsewhere.`,
      };
    }
    return executeTool(client, name, args);
  }

  return executeTool(client, name, args);
}

/** Appended to the base system prompt when a conversation has a drill-down scope set. */
export function scopeSystemPromptAddendum(scope: ConversationScope): string {
  if (scope.scopeViewId) {
    const linkLine = scope.scopeViewLink
      ? `\n- LINK-FIRST RULE: before calling get_view_data, get_dashboard_summary, or get_view_image for an "overview"/"summary"/"snapshot" style request (not a narrow single-metric question), ask the user to pick exactly ONE of three options as a short lettered list: "A) Text summary  B) Image  C) Direct link: ${scope.scopeViewLink}". End your turn there (a deliberate exception to the "always act" rule above). Once they reply, act on exactly what they picked — A → get_dashboard_summary (or get_view_data for one specific metric), B → get_view_image, C → nothing further, just confirm. Then proceed immediately without asking again for the rest of this conversation about this same view. Skip the ask only if the user already picked one earlier in this same conversation, or if their request names one specific already-known number/metric (e.g. "what's the total revenue" still just gets answered directly).`
      : "";
    return `\n\nSCOPE (overrides the general tool-selection rules above): This conversation is locked to a single view — "${scope.scopeViewName}" (id ${scope.scopeViewId}) in workbook "${scope.scopeWorkbookName}". You already have this view's id — you do not need to discover or browse anything to answer about the dashboard as a whole.
- CRITICAL LIMITATION: get_view_data on this dashboard's own id returns only ONE underlying worksheet's data per call — Tableau's API has no way to return a combined summary of every KPI/chart on a multi-chart dashboard in one call. If the user asks for a general text "overview"/"summary"/"complete breakdown" of the dashboard, do NOT call get_view_data alone and present whatever single sheet it happens to return as "the overview" — call get_dashboard_summary({viewId: "${scope.scopeViewId}", workbookId: "${scope.scopeWorkbookId}"}) instead, which combines every sheet in this dashboard's workbook into one response. Per the LINK-FIRST RULE below, still ask the user to pick text/image/link before calling get_dashboard_summary/get_view_image — once they pick "text", call get_dashboard_summary; once they pick "image", call get_view_image.
- For a narrower question that names one specific known metric/chart, call get_view_data({viewId: "${scope.scopeViewId}"}) directly — the app renders a chart client-side from the returned rows automatically, so this satisfies "show me a chart of X" requests too.${linkLine}
- If "${scope.scopeViewName}" is a dashboard made of multiple titled charts/worksheets and the user asks about a SPECIFIC chart by its on-screen title (e.g. a question mirroring a chart heading like "What Country has the Most Revenue?"), that chart MAY be its own separately-indexed view in Tableau. First call list_workbook_views({workbookId: "${scope.scopeWorkbookId}"}) — this is allowed and pinned to this same workbook — find the entry whose name matches that chart's title, and call get_view_data with THAT view's id instead. Do not call get_view_data twice on the same id expecting a different chart's data to appear the second time.
- IMPORTANT: some dashboards are built from several titled chart regions that are NOT separately published views at all — they're just visual regions inside ONE combined worksheet, all reading the same underlying datasource grouped differently (e.g. by country, by channel, by device). If list_workbook_views/get_dashboard_summary don't turn up a per-chart breakdown that matches what's on screen, this is almost certainly the case. In that situation, call list_workbook_datasources({workbookId: "${scope.scopeWorkbookId}"}) to find this workbook's own datasource; if it returns a queryable: true entry, use its datasourceLuid with get_datasource_metadata (to see available fields) then query_datasource (grouping/aggregating by the dimension matching each chart, e.g. group by Country, sum Revenue) to reconstruct each chart's numbers directly — this is the legitimate way to get a "complete text breakdown of every chart" when the charts aren't individually queryable views. Only list_datasources (the site-wide list) stays off-limits here; list_workbook_datasources/get_datasource_metadata/query_datasource/get_field_values are all allowed in this scope. Never invent a datasourceLuid — only use one list_workbook_datasources actually returned.
- Only call get_view_image if the user specifically asks how the dashboard actually looks in Tableau (visual design/layout/colors) — not for a data chart request, which get_view_data/query_datasource already cover.
- get_view_pdf({viewId: "${scope.scopeViewId}"}) exports this view as a PDF document for the user (rendered/downloaded in the chat, not readable by you), get_workbook_thumbnail({workbookId: "${scope.scopeWorkbookId}"}) and list_tags/add_tags/remove_tags on this workbook are all pinned to this same content and allowed.
- Do not discuss other dashboards, workbooks, or projects, and do not attempt to browse the wider site — those tools are disabled here. If the user asks about something outside this workbook, tell them plainly that this chat is scoped to "${scope.scopeViewName}" and they should clear the drill-down or start a new chat to ask about other content.`;
  }
  if (scope.scopeWorkbookId) {
    const linkLine = scope.scopeWorkbookLink
      ? ` This workbook's direct link is ${scope.scopeWorkbookLink} — you can offer it to the user if they just want to browse rather than see a specific view's data pulled into chat.`
      : "";
    return `\n\nSCOPE (overrides the general tool-selection rules above): This conversation is locked to a single workbook — "${scope.scopeWorkbookName}" (id ${scope.scopeWorkbookId}).${linkLine} Use list_workbook_views to find a view within it — before calling get_view_data/get_view_image on a specific view the user names, first offer that view's own \`link\` (from the list_workbook_views result) and ask if they want it pulled into chat, per the general link-first rule below; skip that ask for clearly analytical questions. For a full text breakdown of a multi-chart dashboard whose charts aren't individually queryable views, call list_workbook_datasources({workbookId: "${scope.scopeWorkbookId}"}) to find this workbook's own datasource, then get_datasource_metadata/query_datasource with its datasourceLuid — never invent one. Only list_datasources (the site-wide list) stays off-limits here. Do not discuss other workbooks or projects — browsing tools for those are disabled for this conversation. If the user asks about something outside this workbook, tell them plainly and suggest they clear the drill-down or start a new chat.`;
  }
  if (scope.scopeProjectId) {
    return `\n\nSCOPE (overrides the general tool-selection rules above): This conversation is locked to a single project — "${scope.scopeProjectName}" (id ${scope.scopeProjectId}). Use list_workbooks to find a workbook, list_workbook_views to find a view within it — before calling get_view_data/get_view_image on a specific view the user names, first offer that view's own \`link\` and ask if they want it pulled into chat, per the general link-first rule below; skip that ask for clearly analytical questions. For a deeper query, call list_workbook_datasources(workbookId) with a workbookId you've legitimately discovered via list_workbooks, then get_datasource_metadata/query_datasource with its datasourceLuid — never invent one. Only list_datasources (the site-wide list) stays off-limits here. Do not discuss content in other projects — browsing tools for those are disabled for this conversation. If the user asks about something outside this project, tell them plainly and suggest they clear the drill-down or start a new chat.`;
  }
  return "";
}
