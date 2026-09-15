import { z } from "zod";
import { TableauClient } from "../tableau/client.js";
import { resizeAndCompress } from "../lib/image.js";
import { clampedLimit } from "../lib/zodHelpers.js";
import { cacheGet, cacheSet } from "../lib/cache.js";

// A site can easily have thousands of workbooks/views — returning all of
// them unpaginated risks blowing the model's context window in one shot
// (seen in practice: a bare list_site_views call once produced a request
// over the model's 131K-token limit). Every list_* tool below returns a
// bounded page plus `total`/`hasMore` so the model can page through more
// with offset, or (better) narrow with nameFilter first.
const paginationProps = {
  offset: { type: "integer", minimum: 0, default: 0, description: "Skip this many results (for paging through more than `limit`)" },
  limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Max results to return in this call" },
} as const;

// ---- Tool definitions ----

export const contentToolDefinitions = [
  {
    name: "list_projects",
    description:
      "List projects (folders) on the site, optionally filtered by name. Top level for drilling down into content. Result includes an authoritative `total` field (the full matching count, which may be larger than the page returned) — use it directly, don't count array entries yourself. If `hasMore` is true, narrow with `nameFilter` or page further with `offset`.",
    input_schema: {
      type: "object",
      properties: {
        nameFilter: { type: "string", description: "Optional substring to filter project names" },
        ...paginationProps,
      },
    },
  },
  {
    name: "list_workbooks",
    description:
      "List published workbooks on the site, optionally filtered by name and/or exact project name. Each workbook includes its `description`, project, owner, and a direct `link`; the result also carries an authoritative `total` field. If `hasMore` is true, narrow with `nameFilter`/`projectName` or page further with `offset`.",
    input_schema: {
      type: "object",
      properties: {
        nameFilter: { type: "string", description: "Optional substring to filter workbook names" },
        projectName: { type: "string", description: "Optional exact project name to filter by" },
        ...paginationProps,
      },
    },
  },
  {
    name: "list_flows",
    description:
      "List published Tableau Prep flows on the site, optionally filtered by name. Result includes an authoritative `total` field. If `hasMore` is true, narrow with `nameFilter` or page further with `offset`.",
    input_schema: {
      type: "object",
      properties: {
        nameFilter: { type: "string", description: "Optional substring to filter flow names" },
        ...paginationProps,
      },
    },
  },
  {
    name: "list_virtual_connections",
    description:
      "List virtual connections on the site, optionally filtered by name. Result includes an authoritative `total` field. If `hasMore` is true, narrow with `nameFilter` or page further with `offset`.",
    input_schema: {
      type: "object",
      properties: {
        nameFilter: { type: "string", description: "Optional substring to filter virtual connection names" },
        ...paginationProps,
      },
    },
  },
  {
    name: "search_content",
    description:
      "Search workbooks, data sources, flows, and projects by name in one call. Each category in the result includes its own authoritative `count` field; workbook entries include a `link` to open directly in Tableau.",
    input_schema: {
      type: "object",
      properties: {
        term: { type: "string", description: "Search term to match against workbook/datasource/flow/project names" },
      },
      required: ["term"],
    },
  },
  {
    name: "list_workbook_views",
    description:
      "List the views (sheets/dashboards) inside ONE specific workbook. Scoped to that workbook only — if the user is asking about all dashboards/views across their whole site (not one named workbook), use list_site_views instead; do not call this once per workbook to try to enumerate everything. Each view includes a `link` to open it directly in Tableau.",
    input_schema: {
      type: "object",
      properties: {
        workbookId: { type: "string", description: "Workbook id (from list_workbooks or search_content)" },
      },
      required: ["workbookId"],
    },
  },
  {
    name: "list_site_views",
    description:
      "List every view (sheet/dashboard) across the ENTIRE site in one call, each tagged with its owning workbook id/name and a `link` to open it directly in Tableau. Use this whenever the user asks for 'all dashboards', 'all my views', or similar site-wide questions — it is the single-call alternative to looping list_workbook_views over every workbook. Sites can have thousands of views, so results are paginated (`total`/`hasMore` in the response) — narrow with `nameFilter` first if possible, otherwise page with `offset`. Do not assume the returned page is everything if `hasMore` is true.",
    input_schema: {
      type: "object",
      properties: {
        nameFilter: { type: "string", description: "Optional substring to filter view names" },
        ...paginationProps,
      },
    },
  },
  {
    name: "get_view_data",
    description:
      "Get the underlying data of a published view as CSV — use this to read data from an existing dashboard instead of building a new query.",
    input_schema: {
      type: "object",
      properties: {
        viewId: { type: "string", description: "View id (from list_workbook_views)" },
        maxLines: { type: "integer", minimum: 1, maximum: 300, default: 50, description: "Max CSV lines to return, including the header row. Kept well under 1000: a large CSV preview alone can exceed a small/free-tier model's whole per-request token budget." },
      },
      required: ["viewId"],
    },
  },
  {
    name: "get_view_image",
    description:
      "Render a published Tableau view/dashboard as an image and see it directly. Use ONLY when the user explicitly asks about visual layout, trend shape, colors, or something that specifically requires looking at the dashboard's appearance. For general requests like 'give me an overview' or 'summarize this', prefer get_view_data instead — many connected models don't support image inputs at all and will error on this call, whereas get_view_data always works.",
    input_schema: {
      type: "object",
      properties: {
        viewId: { type: "string", description: "View id (from list_workbook_views)" },
        resolution: {
          type: "string",
          enum: ["standard", "high"],
          default: "standard",
          description: "Use 'standard' by default — 'high' produces a much larger image and can exceed smaller/free-tier models' per-request token limits. Only use 'high' if the user needs fine detail (small text, dense tables) and standard wasn't enough.",
        },
      },
      required: ["viewId"],
    },
  },
  {
    name: "get_dashboard_summary",
    description:
      "Get a COMBINED text overview of an entire multi-chart dashboard in one call — use this whenever the user wants a text 'overview'/'summary'/'complete breakdown' of a dashboard, instead of get_view_data (which only returns one sheet at a time). It fetches every other sheet published in the same workbook and returns each one's data together, labeled by sheet name. This is Tableau's own API limitation being worked around, not a bug: there is no endpoint that returns a dashboard's combined data directly, so this tool approximates it by combining each of the workbook's individual sheets. If the workbook contains multiple unrelated dashboards rather than one dashboard plus its own per-chart sheets, unrelated sheets may be included too — the response's `note` field always states this caveat, pass it along to the user if relevant.",
    input_schema: {
      type: "object",
      properties: {
        viewId: { type: "string", description: "The dashboard's own view id (from list_workbook_views or list_site_views)" },
        workbookId: { type: "string", description: "The id of the workbook that contains this dashboard (from list_workbooks/search_content/list_site_views)" },
        maxLinesPerSheet: { type: "integer", minimum: 1, maximum: 30, default: 20, description: "Max CSV lines returned per sheet, including its header row — kept small since results from up to 6 sheets are combined into ONE response; a high value here multiplied across sheets can alone exceed a small/free-tier model's per-request token budget." },
      },
      required: ["viewId", "workbookId"],
    },
  },
  {
    name: "get_workbook_details",
    description:
      "Full metadata for one published workbook: owner, project, tags, size, created/updated timestamps, description and its direct link. Richer than the page-level fields on list_workbooks. Call this for 'who owns X', 'when was X last changed', 'how big is X', 'what are X's tags'.",
    input_schema: {
      type: "object",
      properties: {
        workbookId: { type: "string", description: "Workbook id (from list_workbooks or search_content)" },
      },
      required: ["workbookId"],
    },
  },
  {
    name: "get_workbook_thumbnail",
    description:
      "A small preview image of a published workbook (its first sheet, rendered by Tableau) — cheap and fast, useful to quickly see what a workbook looks like before committing to the heavier get_view_image. Same image semantics as get_view_image: the app renders it in the chat.",
    input_schema: {
      type: "object",
      properties: {
        workbookId: { type: "string", description: "Workbook id (from list_workbooks or search_content)" },
      },
      required: ["workbookId"],
    },
  },
  {
    name: "get_view_pdf",
    description:
      "Export a published view/dashboard as a PDF document and give the user a download/embed in the chat. Use this when the user explicitly asks for a PDF export of a view ('export this as a PDF'). The PDF is a deliverable for the user to open/download — you can't read its contents, so describe what it contains from the view context you already have.",
    input_schema: {
      type: "object",
      properties: {
        viewId: { type: "string", description: "View id (from list_workbook_views or list_site_views)" },
      },
      required: ["viewId"],
    },
  },
  {
    name: "list_workbook_revisions",
    description:
      "List the revision history of a workbook: who published each revision and when. Call this for 'when was this last changed / by whom', 'who edited this workbook recently'. Returns the most recent revisions with timestamps.",
    input_schema: {
      type: "object",
      properties: {
        workbookId: { type: "string", description: "Workbook id (from list_workbooks or search_content)" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Max revisions to return" },
      },
      required: ["workbookId"],
    },
  },
  {
    name: "list_tags",
    description:
      "List the tags on a published workbook. Call this for 'what tags does X have', 'how is this organized'. Returns an array of tag labels.",
    input_schema: {
      type: "object",
      properties: {
        workbookId: { type: "string", description: "Workbook id (from list_workbooks or search_content)" },
      },
      required: ["workbookId"],
    },
  },
  {
    name: "add_tags",
    description:
      "Add one or more tags to a published workbook. Call this when the user asks to tag/untag-organize content ('add a 'priority' tag to X'). State what was added after running. Reversible via remove_tags.",
    input_schema: {
      type: "object",
      properties: {
        workbookId: { type: "string", description: "Workbook id (from list_workbooks or search_content)" },
        tags: { type: "array", description: "Tag labels to add", items: { type: "string" } },
      },
      required: ["workbookId", "tags"],
    },
  },
  {
    name: "remove_tags",
    description:
      "Remove a single tag from a published workbook. Call this when the user asks to remove a tag ('take the 'draft' tag off X'). State what was removed after running. Reversible via add_tags.",
    input_schema: {
      type: "object",
      properties: {
        workbookId: { type: "string", description: "Workbook id (from list_workbooks or search_content)" },
        tag: { type: "string", description: "The exact tag label to remove" },
      },
      required: ["workbookId", "tag"],
    },
  },
  {
    name: "list_favorites",
    description:
      "List the connected user's favorited content (workbooks, views, datasources, flows), grouped by type. Call this for 'what are my favorited dashboards', 'show me my favorites'. Defaults to the connected account's own favorites.",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Optional Tableau user id to list favorites for; defaults to the connected account's own id" },
      },
    },
  },
  {
    name: "add_favorite",
    description:
      "Add a piece of content to the connected user's favorites. Call this when the user asks to 'favorite this', 'star this dashboard for me'. State what was favorited after running. Reversible via remove_favorite.",
    input_schema: {
      type: "object",
      properties: {
        contentType: { type: "string", enum: ["workbooks", "views", "datasources", "flows"], description: "The kind of content to favorite" },
        contentId: { type: "string", description: "The content's id (from the relevant list_* tool)" },
      },
      required: ["contentType", "contentId"],
    },
  },
  {
    name: "remove_favorite",
    description:
      "Remove a piece of content from the connected user's favorites. Call this when the user asks to 'unfavorite this', 'remove this from my favorites'. State what was removed after running. Reversible via add_favorite.",
    input_schema: {
      type: "object",
      properties: {
        contentType: { type: "string", enum: ["workbooks", "views", "datasources", "flows"], description: "The kind of content to unfavorite" },
        contentId: { type: "string", description: "The content's id (from the relevant list_* tool)" },
      },
      required: ["contentType", "contentId"],
    },
  },
  {
    name: "list_custom_views",
    description:
      "List custom views (per-user/team saved filter states) on the site, optionally filtered to one workbook. Call this for 'what saved views exist', 'show me the custom views on X'. Returns each custom view's id, name, owning view and creator.",
    input_schema: {
      type: "object",
      properties: {
        workbookId: { type: "string", description: "Optional workbook id to restrict the listing to" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Max results to return" },
      },
    },
  },
  {
    name: "get_custom_view_image",
    description:
      "Render a saved custom view as an image so it can be seen directly in the chat. Call this when the user wants to see a specific custom view (a saved filter state) rather than the default view. Same image semantics as get_view_image.",
    input_schema: {
      type: "object",
      properties: {
        customViewId: { type: "string", description: "Custom view id (from list_custom_views)" },
      },
      required: ["customViewId"],
    },
  },
  {
    name: "get_data_quality_warning",
    description:
      "Read the data-quality warnings Tableau has flagged on a specific piece of content (datasource, workbook, view or flow) — e.g. 'stale', 'inconsistent', 'deprecated'. Call this for 'is THIS view/workbook flagged', complementing get_data_quality_warnings (which covers datasources with field-level detail and a health summary).",
    input_schema: {
      type: "object",
      properties: {
        contentType: { type: "string", enum: ["datasources", "workbooks", "views", "flows"], description: "The kind of content to check" },
        contentId: { type: "string", description: "The content's id (from the relevant list_* tool)" },
      },
      required: ["contentType", "contentId"],
    },
  },
] as const;

// ---- Zod validators ----

// z.coerce.number() (not z.number()) because models — especially
// small/free-tier ones — routinely emit numeric tool arguments as JSON
// strings (e.g. {"limit": "100"}). z.number() rejects that outright,
// costing a full wasted round trip while the model self-corrects.
const paginationSchema = { offset: z.coerce.number().int().min(0).default(0), limit: clampedLimit(500, 100) };

const schemas = {
  list_projects: z.object({ nameFilter: z.string().optional(), ...paginationSchema }),
  list_workbooks: z.object({ nameFilter: z.string().optional(), projectName: z.string().optional(), ...paginationSchema }),
  list_flows: z.object({ nameFilter: z.string().optional(), ...paginationSchema }),
  list_virtual_connections: z.object({ nameFilter: z.string().optional(), ...paginationSchema }),
  search_content: z.object({ term: z.string().min(1) }),
  list_workbook_views: z.object({ workbookId: z.string() }),
  list_site_views: z.object({ nameFilter: z.string().optional(), ...paginationSchema }),
  get_view_data: z.object({ viewId: z.string(), maxLines: clampedLimit(300, 50) }),
  get_view_image: z.object({ viewId: z.string(), resolution: z.enum(["standard", "high"]).default("standard") }),
  get_dashboard_summary: z.object({
    viewId: z.string(),
    workbookId: z.string(),
    maxLinesPerSheet: clampedLimit(30, 20),
  }),
  get_workbook_details: z.object({ workbookId: z.string() }),
  get_workbook_thumbnail: z.object({ workbookId: z.string() }),
  get_view_pdf: z.object({ viewId: z.string() }),
  list_workbook_revisions: z.object({
    workbookId: z.string(),
    limit: clampedLimit(100, 20),
  }),
  list_tags: z.object({ workbookId: z.string() }),
  add_tags: z.object({ workbookId: z.string(), tags: z.array(z.string().min(1)).min(1).max(20) }),
  remove_tags: z.object({ workbookId: z.string(), tag: z.string().min(1) }),
  list_favorites: z.object({ userId: z.string().optional() }),
  add_favorite: z.object({ contentType: z.enum(["workbooks", "views", "datasources", "flows"]), contentId: z.string() }),
  remove_favorite: z.object({ contentType: z.enum(["workbooks", "views", "datasources", "flows"]), contentId: z.string() }),
  list_custom_views: z.object({
    workbookId: z.string().optional(),
    limit: clampedLimit(500, 100),
  }),
  get_custom_view_image: z.object({ customViewId: z.string() }),
  get_data_quality_warning: z.object({
    contentType: z.enum(["datasources", "workbooks", "views", "flows"]),
    contentId: z.string(),
  }),
};

// ---- Helpers ----

async function fetchAll(client: TableauClient, path: string, key: string) {
  return client.restRequestAllPages<any>(path, (page) => {
    const list = page?.[key.split(".")[0]]?.[key.split(".")[1]] ?? [];
    return Array.isArray(list) ? list : [list];
  });
}

const nameIncludes = (term: string) => (item: any) => item.name?.toLowerCase().includes(term.toLowerCase());

function paginate<T>(items: T[], offset: number, limit: number) {
  const total = items.length;
  const page = items.slice(offset, offset + limit);
  return { total, offset, limit, hasMore: offset + page.length < total, page };
}

// ---- Handlers ----

async function listProjects(client: TableauClient, args: z.infer<typeof schemas.list_projects>) {
  const all = await fetchAll(client, "/sites/{siteId}/projects", "projects.project");
  const filtered = args.nameFilter ? all.filter(nameIncludes(args.nameFilter)) : all;
  const { total, hasMore, page } = paginate(filtered, args.offset, args.limit);
  return {
    total,
    hasMore,
    offset: args.offset,
    projects: page.map((p: any) => ({ id: p.id, name: p.name, parentProjectId: p.parentProjectId })),
  };
}

async function listWorkbooks(client: TableauClient, args: z.infer<typeof schemas.list_workbooks>) {
  const userId = client.getUserId();
  let all = await cacheGet<any[]>("wb_list", `all_${userId}`);
  if (!all) {
    all = await fetchAll(client, "/sites/{siteId}/workbooks", "workbooks.workbook");
    await cacheSet("wb_list", `all_${userId}`, all);
  }
  let filtered = all;
  if (args.nameFilter) filtered = filtered.filter(nameIncludes(args.nameFilter));
  let projectNote: string | undefined;
  if (args.projectName) {
    const term = args.projectName.toLowerCase();
    const exact = filtered.filter((w: any) => w.project?.name?.toLowerCase() === term);
    if (exact.length) {
      filtered = exact;
    } else {
      // Exact match failed. A weak model also sometimes passes a
      // conversational phrase ("this project") as projectName, and a human
      // may pass a partial name ("Sales" for "Sales Dashboard 2024") —
      // either way, silently returning total: 0 produced a wrong answer
      // downstream. Fall back to substring, then to no filter at all, and
      // say what happened via `note` so the model reports it honestly.
      const partial = filtered.filter((w: any) => w.project?.name?.toLowerCase().includes(term));
      if (partial.length) {
        filtered = partial;
        projectNote = `No project is named exactly "${args.projectName}"; showing workbooks whose project name contains it.`;
      } else {
        projectNote = `No project matching "${args.projectName}" exists on this site — showing ALL workbooks instead. Call list_projects to see the actual project names.`;
      }
    }
  }
  const { total, hasMore, page } = paginate(filtered, args.offset, args.limit);

  // Some Tableau REST API versions omit the `description` attribute from the
  // LIST workbooks response even though the single-workbook GET returns it.
  // When any workbook on this page has no description, fetch it server-side
  // (small parallel batches) from /workbooks/{id} and fill it in — so this
  // single tool result always carries the COMPLETE real description and the
  // model can quote it verbatim instead of paraphrasing or inventing one.
  const missingDesc = page.filter((w: any) => w.description == null && !w._descChecked);
  for (let i = 0; i < missingDesc.length; i += 10) {
    await Promise.all(
      missingDesc.slice(i, i + 10).map(async (w: any) => {
        w._descChecked = true; // don't re-fetch on every call when it stays null
        try {
          const d = await client.restRequest<any>("GET", `/sites/{siteId}/workbooks/${w.id}`);
          const desc = d?.workbook?.description;
          if (typeof desc === "string" && desc.length) w.description = desc;
        } catch {
          // leave description null — the null value + prompt rule make the
          // model say "no description" rather than fabricate one
        }
      }),
    );
  }
  // The workbook list is cached by userId — store the enriched descriptions
  // back so a follow-up "list every description" (in this conversation or a
  // new one within the cache TTL) never re-pays these per-workbook calls.
  if (missingDesc.length > 0) await cacheSet("wb_list", `all_${userId}`, all);

  return {
    total,
    hasMore,
    offset: args.offset,
    ...(projectNote ? { note: projectNote } : {}),
    // Prefer Tableau's own webpageUrl when the REST response includes it
    // (some API versions return it directly); otherwise build the URL from
    // the workbook's own contentUrl (its human-readable repository URL
    // segment) — NOT its internal UUID id, which produces a 404.
    workbooks: page.map((w: any) => ({
      id: w.id,
      name: w.name,
      // Tableau's REST workbook payload carries the description directly —
      // surfacing it here means "descriptions of all workbooks in this
      // project" is answerable with THIS single call, instead of the model
      // burning one round per workbook on get_workbook_details (which ran
      // out of turns in practice). Only fetch details per-workbook for info
      // this list genuinely lacks (revisions, tags, permissions).
      description: w.description ?? null,
      project: w.project?.name,
      owner: w.owner?.name,
      link: w.webpageUrl || client.getContentUrl("workbooks", w.contentUrl),
    })),
  };
}

async function listFlows(client: TableauClient, args: z.infer<typeof schemas.list_flows>) {
  const all = await fetchAll(client, "/sites/{siteId}/flows", "flows.flow");
  const filtered = args.nameFilter ? all.filter(nameIncludes(args.nameFilter)) : all;
  const { total, hasMore, page } = paginate(filtered, args.offset, args.limit);
  return {
    total,
    hasMore,
    offset: args.offset,
    flows: page.map((f: any) => ({ id: f.id, name: f.name, project: f.project?.name, owner: f.owner?.name })),
  };
}

async function listVirtualConnections(client: TableauClient, args: z.infer<typeof schemas.list_virtual_connections>) {
  const all = await fetchAll(client, "/sites/{siteId}/virtualconnections", "virtualConnections.virtualConnection");
  const filtered = args.nameFilter ? all.filter(nameIncludes(args.nameFilter)) : all;
  const { total, hasMore, page } = paginate(filtered, args.offset, args.limit);
  return {
    total,
    hasMore,
    offset: args.offset,
    virtualConnections: page.map((v: any) => ({ id: v.id, name: v.name })),
  };
}

// search_content results are capped per-category to keep the combined
// response bounded even when a term matches broadly across a large site.
const SEARCH_CATEGORY_LIMIT = 25;

async function searchContent(client: TableauClient, args: z.infer<typeof schemas.search_content>) {
  const term = args.term.toLowerCase();
  const [wbAll, dsAll, flowAll, projAll] = await Promise.all([
    fetchAll(client, "/sites/{siteId}/workbooks", "workbooks.workbook"),
    fetchAll(client, "/sites/{siteId}/datasources", "datasources.datasource"),
    fetchAll(client, "/sites/{siteId}/flows", "flows.flow"),
    fetchAll(client, "/sites/{siteId}/projects", "projects.project"),
  ]);
  const wb = wbAll.filter(nameIncludes(term));
  const ds = dsAll.filter(nameIncludes(term));
  const flow = flowAll.filter(nameIncludes(term));
  const proj = projAll.filter(nameIncludes(term));

  return {
    workbooks: {
      total: wb.length,
      hasMore: wb.length > SEARCH_CATEGORY_LIMIT,
      items: wb
        .slice(0, SEARCH_CATEGORY_LIMIT)
        .map((w: any) => ({ id: w.id, name: w.name, project: w.project?.name, link: w.webpageUrl || client.getContentUrl("workbooks", w.contentUrl) })),
    },
    datasources: {
      total: ds.length,
      hasMore: ds.length > SEARCH_CATEGORY_LIMIT,
      items: ds.slice(0, SEARCH_CATEGORY_LIMIT).map((d: any) => ({ id: d.id, name: d.name, project: d.project?.name })),
    },
    flows: {
      total: flow.length,
      hasMore: flow.length > SEARCH_CATEGORY_LIMIT,
      items: flow.slice(0, SEARCH_CATEGORY_LIMIT).map((f: any) => ({ id: f.id, name: f.name, project: f.project?.name })),
    },
    projects: {
      total: proj.length,
      hasMore: proj.length > SEARCH_CATEGORY_LIMIT,
      items: proj.slice(0, SEARCH_CATEGORY_LIMIT).map((p: any) => ({ id: p.id, name: p.name })),
    },
  };
}

async function listWorkbookViews(client: TableauClient, args: z.infer<typeof schemas.list_workbook_views>) {
  const data = await client.restRequest<any>("GET", `/sites/{siteId}/workbooks/${args.workbookId}/views`);
  const views = data?.views?.view ?? [];
  const list = Array.isArray(views) ? views : [views];
  return {
    count: list.length,
    views: list.map((v: any) => ({ id: v.id, name: v.name, link: client.getContentUrl("views", v.contentUrl) })),
  };
}

async function listSiteViews(client: TableauClient, args: z.infer<typeof schemas.list_site_views>) {
  // Single site-wide endpoint — the deliberate alternative to looping
  // list_workbook_views once per workbook, which is both slow (N+1 calls)
  // and something models unreliably do correctly/completely on their own.
  const all = await fetchAll(client, "/sites/{siteId}/views", "views.view");
  const filtered = args.nameFilter ? all.filter(nameIncludes(args.nameFilter)) : all;
  const { total, hasMore, page } = paginate(filtered, args.offset, args.limit);
  return {
    total,
    hasMore,
    offset: args.offset,
    views: page.map((v: any) => ({
      id: v.id,
      name: v.name,
      workbookId: v.workbook?.id,
      link: client.getContentUrl("views", v.contentUrl),
    })),
  };
}

async function getViewData(client: TableauClient, args: z.infer<typeof schemas.get_view_data>) {
  // This endpoint returns CSV as raw text, not JSON.
  const csv = await client.restRequest<string>("GET", `/sites/{siteId}/views/${args.viewId}/data`);
  const allLines = typeof csv === "string" ? csv.split("\n") : [String(csv)];
  const preview = allLines.slice(0, args.maxLines).join("\n");
  return {
    totalLines: allLines.length,
    truncated: allLines.length > args.maxLines,
    csvPreview: preview,
  };
}

// Tableau's own "standard" vs "high" resolution option isn't enough on its
// own — even "standard" dashboard PNGs routinely blow past small providers'
// per-request token limits (seen in practice: Groq's 8000 TPM free tier)
// once combined with the system prompt and tool schemas. Re-encode to a
// capped width + compressed JPEG server-side so every provider gets a
// consistently small image regardless of the source dashboard's actual
// resolution or the account's own rate-limit tier.
// Lower than our first attempt (900px/q70) — even that combined with the
// system prompt + full tool schemas still blew Groq's 8000 TPM tier on a
// scoped conversation with some history. This is the new normal default;
// chat.ts additionally retries at an even smaller size if a provider still
// rejects it as too large for its specific tier.
const MAX_IMAGE_WIDTH = 700;
const JPEG_QUALITY = 55;

async function getViewImage(client: TableauClient, args: z.infer<typeof schemas.get_view_image>) {
  let png: Buffer;
  try {
    png = await client.restRequestBinary(`/sites/{siteId}/views/${args.viewId}/image`, {
      resolution: args.resolution,
    });
  } catch (err: any) {
    // Some Tableau pods/versions only accept resolution="high" and reject
    // "standard" outright (seen in practice: "Invalid value 'standard' for
    // request parameter 'resolution'. Valid values: 'high'."). Rather than
    // surfacing that as a dead end and relying on the model to notice and
    // retry with a different argument itself (unreliable in practice), just
    // retry once with "high" transparently when this specific error shows up.
    const invalidResolution = args.resolution !== "high" && /invalid value .* for request parameter 'resolution'/i.test(String(err?.message));
    if (!invalidResolution) throw err;
    png = await client.restRequestBinary(`/sites/{siteId}/views/${args.viewId}/image`, { resolution: "high" });
  }
  const jpeg = await resizeAndCompress(png, MAX_IMAGE_WIDTH, JPEG_QUALITY);

  // Special result shape: chat.ts recognizes `imageBase64` and routes the
  // actual bytes to the model as an image (via the adapter — see
  // AnthropicAdapter/OpenAiAdapter), instead of dumping base64 into the
  // tool-result text where no model would meaningfully interpret it.
  return {
    mediaType: "image/jpeg",
    imageBase64: jpeg.toString("base64"),
    sizeBytes: jpeg.length,
    note: "Image captured from the published view (resized/compressed to fit typical model context limits).",
  };
}

// Tableau's REST API has no endpoint that returns a dashboard's combined
// data in one shot — get_view_data on a dashboard's own id only ever
// returns its primary/default sheet. The pragmatic workaround, matching how
// these dashboards are actually built in practice (one dashboard view plus
// its own dedicated per-chart sibling views in the same workbook — see
// list_workbook_views), is to pull every OTHER view in the same workbook and
// present them together as the dashboard's constituent charts. Capped so a
// workbook with many unrelated views can't blow the response size/token
// budget in one call.
const MAX_DASHBOARD_SHEETS = 6;

async function getDashboardSummary(client: TableauClient, args: z.infer<typeof schemas.get_dashboard_summary>) {
  const data = await client.restRequest<any>("GET", `/sites/{siteId}/workbooks/${args.workbookId}/views`);
  const viewsRaw = data?.views?.view ?? [];
  const views = (Array.isArray(viewsRaw) ? viewsRaw : [viewsRaw]).map((v: any) => ({ id: v.id, name: v.name }));

  const dashboard = views.find((v) => v.id === args.viewId);
  const siblingSheets = views.filter((v) => v.id !== args.viewId).slice(0, MAX_DASHBOARD_SHEETS);
  const omittedCount = Math.max(0, views.length - 1 - siblingSheets.length);

  const sections: any[] = [];
  for (const sheet of siblingSheets) {
    try {
      const csv = await client.restRequest<string>("GET", `/sites/{siteId}/views/${sheet.id}/data`);
      const lines = typeof csv === "string" ? csv.split("\n") : [String(csv)];
      sections.push({
        viewName: sheet.name,
        csvPreview: lines.slice(0, args.maxLinesPerSheet).join("\n"),
        truncated: lines.length > args.maxLinesPerSheet,
      });
    } catch (err: any) {
      // One sheet failing (e.g. a chart type this endpoint can't export)
      // shouldn't drop the whole combined summary — report it inline instead.
      sections.push({ viewName: sheet.name, error: `Could not retrieve data for this sheet: ${err?.message ?? "unknown error"}` });
    }
  }

  const fewOtherSheets = sections.length <= 1;
  return {
    dashboardName: dashboard?.name ?? args.viewId,
    sheetsIncluded: sections.length,
    sheetsOmitted: omittedCount,
    sections,
    note: fewOtherSheets
      ? "This workbook has few or no other published sheets besides the dashboard itself, so this is NOT a complete breakdown of every chart on the dashboard — its chart regions (e.g. by country/channel/device) are most likely titled areas inside one worksheet rather than separately queryable views. Call list_workbook_datasources(workbookId) to find this workbook's own datasource, then get_datasource_metadata + query_datasource (grouped per chart, e.g. by Country, by Channel) to reconstruct the real per-chart numbers instead."
      : "Combined from every other view published in this dashboard's workbook, since Tableau's API has no single endpoint that returns a dashboard's full combined data. If this workbook holds multiple unrelated dashboards (rather than one dashboard plus its own per-chart sheets), unrelated sheets may be included here too.",
  };
}

// ---- Workbook/view metadata, tags, favorites, custom views, PDF export ----

async function getWorkbookDetails(client: TableauClient, args: z.infer<typeof schemas.get_workbook_details>) {
  const data = await client.restRequest<any>("GET", `/sites/{siteId}/workbooks/${args.workbookId}`);
  const wb = data?.workbook;
  if (!wb) return { error: `Workbook ${args.workbookId} not found or not accessible.` };
  const tags = (Array.isArray(wb.tags?.tag) ? wb.tags.tag : wb.tags?.tag ? [wb.tags.tag] : []).map((t: any) => t.label);
  return {
    id: wb.id,
    name: wb.name,
    description: wb.description ?? null,
    project: wb.project?.name ?? null,
    owner: wb.owner?.name ?? null,
    sizeBytes: wb.size ?? null,
    createdAt: wb.createdAt ?? null,
    updatedAt: wb.updatedAt ?? null,
    tags,
    link: wb.webpageUrl || client.getContentUrl("workbooks", wb.contentUrl),
  };
}

async function getWorkbookThumbnail(client: TableauClient, args: z.infer<typeof schemas.get_workbook_thumbnail>) {
  const png = await client.restRequestBinary(`/sites/{siteId}/workbooks/${args.workbookId}/previewImage`);
  const jpeg = await resizeAndCompress(png, MAX_IMAGE_WIDTH, JPEG_QUALITY);
  return {
    mediaType: "image/jpeg",
    imageBase64: jpeg.toString("base64"),
    sizeBytes: jpeg.length,
    note: "Workbook thumbnail (resized/compressed). Same delivery path as get_view_image.",
  };
}

async function getViewPdf(client: TableauClient, args: z.infer<typeof schemas.get_view_pdf>) {
  const buf = await client.restRequestBinary(`/sites/{siteId}/views/${args.viewId}/pdf`);
  // An empty body means Tableau returned no PDF bytes at all — deliver an
  // explicit error rather than a falsy pdfBase64 (""), which the frontend's
  // `if (call.pdf?.base64)` would silently skip, leaving no toggle/link and
  // looking like "the PDF just didn't render".
  if (!buf || buf.length === 0) {
    return { error: `Tableau returned an empty PDF for view ${args.viewId} — the view may not have an exportable layout, or the account lacks download permission. Ask the user to try from the Tableau UI or check the view's Download permission.` };
  }
  return {
    mediaType: "application/pdf",
    pdfBase64: buf.toString("base64"),
    sizeBytes: buf.length,
    note: "PDF export of the published view. Delivered as a downloadable/embeddable document in the chat — it is NOT readable by the model, so answer from the view context you already have.",
  };
}

async function listWorkbookRevisions(client: TableauClient, args: z.infer<typeof schemas.list_workbook_revisions>) {
  const data = await client.restRequest<any>("GET", `/sites/{siteId}/workbooks/${args.workbookId}/revisions`);
  const raw = data?.revisions?.revision ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  return {
    count: list.length,
    revisions: list.slice(0, args.limit).map((r: any) => ({
      revisionNumber: r.revisionNumber ?? null,
      publishedAt: r.publishedAt ?? null,
      publishedBy: r.user?.name ?? null,
    })),
  };
}

async function listTags(client: TableauClient, args: z.infer<typeof schemas.list_tags>) {
  const data = await client.restRequest<any>("GET", `/sites/{siteId}/workbooks/${args.workbookId}/tags`);
  const raw = data?.tags?.tag ?? [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return { count: list.length, tags: list.map((t: any) => t.label) };
}

async function addTags(client: TableauClient, args: z.infer<typeof schemas.add_tags>) {
  const data = await client.restRequest<any>("PUT", `/sites/{siteId}/workbooks/${args.workbookId}/tags`, {
    body: { tags: { tag: args.tags.map((label) => ({ label })) } },
  });
  const raw = data?.tags?.tag ?? [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return { added: args.tags, tags: list.map((t: any) => t.label) };
}

async function removeTags(client: TableauClient, args: z.infer<typeof schemas.remove_tags>) {
  await client.restRequest("DELETE", `/sites/{siteId}/workbooks/${args.workbookId}/tags/${encodeURIComponent(args.tag)}`);
  return { removed: args.tag };
}

const FAVORITE_TYPES: Record<string, { singular: string }> = {
  workbooks: { singular: "workbook" },
  views: { singular: "view" },
  datasources: { singular: "datasource" },
  flows: { singular: "flow" },
};

async function listFavorites(client: TableauClient, args: z.infer<typeof schemas.list_favorites>) {
  const userId = args.userId ?? (await client.getTableauUserId());
  const data = await client.restRequest<any>("GET", `/sites/{siteId}/favorites/${userId}`);
  const favs = data?.favorites ?? {};
  const groups = ["workbook", "view", "datasource", "flow"].map((kind) => {
    const raw = favs[kind] ?? [];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return { type: `${kind}s`, items: list.map((f: any) => ({ id: f.id, name: f.name })) };
  });
  return {
    userId,
    count: groups.reduce((sum, g) => sum + g.items.length, 0),
    favorites: groups,
  };
}

async function addFavorite(client: TableauClient, args: z.infer<typeof schemas.add_favorite>) {
  const userId = await client.getTableauUserId();
  const { singular } = FAVORITE_TYPES[args.contentType];
  await client.restRequest("PUT", `/sites/{siteId}/favorites/${userId}`, {
    body: { favorites: { [singular]: { id: args.contentId } } },
  });
  return { favorited: { contentType: args.contentType, contentId: args.contentId } };
}

async function removeFavorite(client: TableauClient, args: z.infer<typeof schemas.remove_favorite>) {
  const userId = await client.getTableauUserId();
  const { singular } = FAVORITE_TYPES[args.contentType];
  await client.restRequest("DELETE", `/sites/{siteId}/favorites/${userId}`, {
    params: { [`${singular}Id`]: args.contentId },
  });
  return { unfavorited: { contentType: args.contentType, contentId: args.contentId } };
}

async function listCustomViews(client: TableauClient, args: z.infer<typeof schemas.list_custom_views>) {
  const params: Record<string, string> = { pageSize: String(args.limit) };
  if (args.workbookId) params.filter = `workbook.id:eq:${args.workbookId}`;
  const data = await client.restRequest<any>("GET", "/sites/{siteId}/customViews", { params });
  const raw = data?.customViews?.customView ?? [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return {
    count: list.length,
    customViews: list.map((cv: any) => ({
      id: cv.id,
      name: cv.name,
      viewName: cv.view?.name ?? null,
      workbookName: cv.view?.workbook?.name ?? null,
      creator: cv.creator?.name ?? null,
    })),
  };
}

async function getCustomViewImage(client: TableauClient, args: z.infer<typeof schemas.get_custom_view_image>) {
  const png = await client.restRequestBinary(`/sites/{siteId}/customViews/${args.customViewId}/previewImage`);
  const jpeg = await resizeAndCompress(png, MAX_IMAGE_WIDTH, JPEG_QUALITY);
  return {
    mediaType: "image/jpeg",
    imageBase64: jpeg.toString("base64"),
    sizeBytes: jpeg.length,
    note: "Custom view preview image (resized/compressed). Same delivery path as get_view_image.",
  };
}

async function getDataQualityWarning(client: TableauClient, args: z.infer<typeof schemas.get_data_quality_warning>) {
  const data = await client.restRequest<any>(
    "GET",
    `/sites/{siteId}/dataQualityWarnings/${args.contentType}/${args.contentId}`,
  );
  const raw = data?.dataQualityWarnings?.dataQualityWarning ?? [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return {
    contentType: args.contentType,
    contentId: args.contentId,
    count: list.length,
    warnings: list.map((w: any) => ({
      id: w.id ?? null,
      warningType: w.warningType ?? null,
      message: w.message ?? null,
      createdAt: w.createdAt ?? null,
      isActive: w.isActive ?? true,
      creator: w.creator?.name ?? null,
    })),
  };
}

// ---- Registry ----

export const contentHandlers: Record<string, (client: TableauClient, args: any) => Promise<any>> = {
  list_projects: (c, a) => listProjects(c, schemas.list_projects.parse(a ?? {})),
  list_workbooks: (c, a) => listWorkbooks(c, schemas.list_workbooks.parse(a ?? {})),
  list_flows: (c, a) => listFlows(c, schemas.list_flows.parse(a ?? {})),
  list_virtual_connections: (c, a) => listVirtualConnections(c, schemas.list_virtual_connections.parse(a ?? {})),
  search_content: (c, a) => searchContent(c, schemas.search_content.parse(a ?? {})),
  list_workbook_views: (c, a) => listWorkbookViews(c, schemas.list_workbook_views.parse(a ?? {})),
  list_site_views: (c, a) => listSiteViews(c, schemas.list_site_views.parse(a ?? {})),
  get_view_data: (c, a) => getViewData(c, schemas.get_view_data.parse(a ?? {})),
  get_view_image: (c, a) => getViewImage(c, schemas.get_view_image.parse(a ?? {})),
  get_dashboard_summary: (c, a) => getDashboardSummary(c, schemas.get_dashboard_summary.parse(a ?? {})),
  get_workbook_details: (c, a) => getWorkbookDetails(c, schemas.get_workbook_details.parse(a ?? {})),
  get_workbook_thumbnail: (c, a) => getWorkbookThumbnail(c, schemas.get_workbook_thumbnail.parse(a ?? {})),
  get_view_pdf: (c, a) => getViewPdf(c, schemas.get_view_pdf.parse(a ?? {})),
  list_workbook_revisions: (c, a) => listWorkbookRevisions(c, schemas.list_workbook_revisions.parse(a ?? {})),
  list_tags: (c, a) => listTags(c, schemas.list_tags.parse(a ?? {})),
  add_tags: (c, a) => addTags(c, schemas.add_tags.parse(a ?? {})),
  remove_tags: (c, a) => removeTags(c, schemas.remove_tags.parse(a ?? {})),
  list_favorites: (c, a) => listFavorites(c, schemas.list_favorites.parse(a ?? {})),
  add_favorite: (c, a) => addFavorite(c, schemas.add_favorite.parse(a ?? {})),
  remove_favorite: (c, a) => removeFavorite(c, schemas.remove_favorite.parse(a ?? {})),
  list_custom_views: (c, a) => listCustomViews(c, schemas.list_custom_views.parse(a ?? {})),
  get_custom_view_image: (c, a) => getCustomViewImage(c, schemas.get_custom_view_image.parse(a ?? {})),
  get_data_quality_warning: (c, a) => getDataQualityWarning(c, schemas.get_data_quality_warning.parse(a ?? {})),
};
