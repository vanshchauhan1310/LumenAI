/**
 * Fast-path query router.
 *
 * Many user questions are simple enough to answer directly from cached
 * discovery results without invoking the LLM at all. This module pattern-
 * matches the user's message against known intents and, when it can answer
 * immediately, returns a structured response that the chat route can stream
 * back to the client with zero LLM latency.
 *
 * Patterns are deliberately conservative -- when in doubt, return null and
 * let the full LLM pipeline handle it. A false negative costs one extra
 * LLM call; a false positive returns wrong data.
 */

import { TableauClient } from "../tableau/client.js";
import { cacheGet, cacheSet } from "./cache.js";

// Number of items per page when listing content. Kept small enough that a full
// page of names never approaches a model's output-token limit, while still
// being large enough that most sites fit on one page.
const LIST_PAGE_SIZE = 20;

// In-memory pagination state per user — maps userId → the last list they
// requested (with all items cached) so "more"/"next" can advance through it.
// Entries are short-lived: a fresh list_* call overwrites them, and they're
// scoped to a single user so there's no cross-user leakage.
type PaginationKind = "workbooks" | "datasources" | "views" | "users" | "projects" | "flows";
interface PaginationState {
  kind: PaginationKind;
  items: Array<{ name: string; id: string }>;
  page: number;
}
const paginationState = new Map<string, PaginationState>();

export interface FastPathResult {
  tool: string;
  input: Record<string, any>;
  response: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, any>; result: any }>;
}

interface Pattern {
  regex: RegExp;
  handler: (match: RegExpMatchArray, client: TableauClient) => Promise<FastPathResult | null>;
}

const patterns: Pattern[] = [];

function addPattern(regex: RegExp, handler: Pattern["handler"]): void {
  patterns.push({ regex, handler });
}

// ---- Count queries ----
// All count patterns include "in total" and other natural phrasings.
// Registered BEFORE list patterns so a count question can never be answered by a list handler.

addPattern(
  /^(how\s+many|count|number\s+of|total\s+(number\s+of\s+)?)\s+data\s*sources?\s*(do\s+(i|we)\s+have|are\s+there|on\s+(the\s+)?site|in\s+total)?\s*[?.]?$/i,
  async (_m, client) => {
    const cached = await cacheGet<{ total: number }>("ds_list", "count_all");
    let total = cached?.total;
    if (total === undefined) {
      const result = await client.restRequest<any>("GET", "/sites/{siteId}/datasources", {
        params: { pageSize: "1", pageNumber: "1" },
      });
      total = Number(result?.pagination?.totalAvailable ?? 0);
      await cacheSet("ds_list", "count_all", { total });
    }
    return {
      tool: "list_datasources", input: {},
      response: "There " + (total === 1 ? "is" : "are") + " **" + total + "** data source" + (total === 1 ? "" : "s") + " on your Tableau site.",
      toolCalls: [{ id: "fast_path", name: "list_datasources", input: {}, result: { total } }],
    };
  },
);

addPattern(
  /^(how\s+many|count|number\s+of|total\s+(number\s+of\s+)?)\s+workbooks?\s*(do\s+(i|we)\s+have|are\s+there|on\s+(the\s+)?site|in\s+total)?\s*[?.]?$/i,
  async (_m, client) => {
    const cached = await cacheGet<{ total: number }>("wb_list", "count_all");
    let total = cached?.total;
    if (total === undefined) {
      const result = await client.restRequest<any>("GET", "/sites/{siteId}/workbooks", {
        params: { pageSize: "1", pageNumber: "1" },
      });
      total = Number(result?.pagination?.totalAvailable ?? 0);
      await cacheSet("wb_list", "count_all", { total });
    }
    return {
      tool: "list_workbooks", input: {},
      response: "There " + (total === 1 ? "is" : "are") + " **" + total + "** workbook" + (total === 1 ? "" : "s") + " on your Tableau site.",
      toolCalls: [{ id: "fast_path", name: "list_workbooks", input: {}, result: { total } }],
    };
  },
);

addPattern(
  /^(how\s+many|count|number\s+of|total\s+(number\s+of\s+)?)\s+users?\s*(do\s+(i|we)\s+have|are\s+there|on\s+(the\s+)?site|in\s+total)?\s*[?.]?$/i,
  async (_m, client) => {
    const cached = await cacheGet<{ total: number }>("users_list", "count_all");
    let total = cached?.total;
    if (total === undefined) {
      const result = await client.restRequest<any>("GET", "/sites/{siteId}/users", {
        params: { pageSize: "1", pageNumber: "1" },
      });
      total = Number(result?.pagination?.totalAvailable ?? 0);
      await cacheSet("users_list", "count_all", { total });
    }
    return {
      tool: "list_users", input: {},
      response: "There " + (total === 1 ? "is" : "are") + " **" + total + "** user" + (total === 1 ? "" : "s") + " on your Tableau site.",
      toolCalls: [{ id: "fast_path", name: "list_users", input: {}, result: { total } }],
    };
  },
);

addPattern(
  /^(how\s+many|count|number\s+of|total\s+(number\s+of\s+)?)\s+dashboards?\s*(do\s+(i|we)\s+have|are\s+there|on\s+(the\s+)?site|in\s+total)?\s*[?.]?$/i,
  async (_m, client) => {
    const cached = await cacheGet<{ total: number }>("views_list", "count_all");
    let total = cached?.total;
    if (total === undefined) {
      const result = await client.restRequest<any>("GET", "/sites/{siteId}/views", {
        params: { pageSize: "1", pageNumber: "1" },
      });
      total = Number(result?.pagination?.totalAvailable ?? 0);
      await cacheSet("views_list", "count_all", { total });
    }
    return {
      tool: "list_site_views", input: {},
      response: "There " + (total === 1 ? "is" : "are") + " **" + total + "** dashboards/views on your Tableau site.",
      toolCalls: [{ id: "fast_path", name: "list_site_views", input: {}, result: { total } }],
    };
  },
);

addPattern(
  /^(how\s+many|count|number\s+of|total\s+(number\s+of\s+)?)\s+projects?\s*(do\s+(i|we)\s+have|are\s+there|on\s+(the\s+)?site|in\s+total)?\s*[?.]?$/i,
  async (_m, client) => {
    const cached = await cacheGet<{ total: number }>("projects_list", "count_all");
    let total = cached?.total;
    if (total === undefined) {
      const result = await client.restRequest<any>("GET", "/sites/{siteId}/projects", {
        params: { pageSize: "1", pageNumber: "1" },
      });
      total = Number(result?.pagination?.totalAvailable ?? 0);
      await cacheSet("projects_list", "count_all", { total });
    }
    return {
      tool: "list_projects", input: {},
      response: "There " + (total === 1 ? "is" : "are") + " **" + total + "** project" + (total === 1 ? "" : "s") + " on your Tableau site.",
      toolCalls: [{ id: "fast_path", name: "list_projects", input: {}, result: { total } }],
    };
  },
);

addPattern(
  /^(how\s+many|count|number\s+of|total\s+(number\s+of\s+)?)\s+flows?\s*(do\s+(i|we)\s+have|are\s+there|on\s+(the\s+)?site|in\s+total)?\s*[?.]?$/i,
  async (_m, client) => {
    const cached = await cacheGet<{ total: number }>("flows_list", "count_all");
    let total = cached?.total;
    if (total === undefined) {
      const result = await client.restRequest<any>("GET", "/sites/{siteId}/flows", {
        params: { pageSize: "1", pageNumber: "1" },
      });
      total = Number(result?.pagination?.totalAvailable ?? 0);
      await cacheSet("flows_list", "count_all", { total });
    }
    return {
      tool: "list_flows", input: {},
      response: "There " + (total === 1 ? "is" : "are") + " **" + total + "** flow" + (total === 1 ? "" : "s") + " on your Tableau site.",
      toolCalls: [{ id: "fast_path", name: "list_flows", input: {}, result: { total } }],
    };
  },
);

// ---- Loose count phrasings + more content types ----
// The strict patterns above cover "how many / count / number of / total".
// These catch natural re-phrasings ("what's the total number of X", "X
// count", "count of X", "give me the number of X") for the same collections
// plus projects/flows, all answered from the same cached pagination totals.
// Registered BEFORE every list pattern so a count question can never be
// answered by a list handler.

function addLooseCount(
  nouns: string[],
  singularLabel: string,
  pluralLabel: string,
  endpoint: string,
  cacheNs: string,
  toolName: string,
): void {
  const noun = "(?:" + nouns.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
  addPattern(
    new RegExp(
      // Standard count phrasings
      "^(what('s|\\s+is)\\s+the\\s+(total\\s+)?(number|count|total)\\s+of|total\\s+number\\s+of)\\s+" +
        noun +
        "\\s*(in\\s+total|do\\s+(i|we)\\s+have|are\\s+there)?[?.]?$" +
        // "X count" suffix
        "|^(" + noun + ")\\s+count\\s*[?.]?$" +
        // "count of X" / "give me the number of X" / "give me the count of X"
        "|^(give\\s+me\\s+(the\\s+)?(number|count)\\s+of|count\\s+of)\\s+" +
        noun +
        "\\s*(in\\s+total|do\\s+(i|we)\\s+have|are\\s+there)?[?.]?$" +
        // "what number of X" / "do we have any X"
        "|^(what\\s+number\\s+of|do\\s+(i|we)\\s+have\\s+any|are\\s+there\\s+any)\\s+" +
        noun +
        "\\s*[?.]?$",
      "i",
    ),
    async (_m, client) => {
      const cached = await cacheGet<{ total: number }>(cacheNs, "count_all");
      let total = cached?.total;
      if (total === undefined) {
        const result = await client.restRequest<any>("GET", endpoint, { params: { pageSize: "1", pageNumber: "1" } });
        total = Number(result?.pagination?.totalAvailable ?? 0);
        await cacheSet(cacheNs, "count_all", { total });
      }
      const label = total === 1 ? singularLabel : pluralLabel;
      return {
        tool: toolName,
        input: {},
        response: "There " + (total === 1 ? "is" : "are") + " **" + total + "** " + label + " on your Tableau site.",
        toolCalls: [{ id: "fast_path", name: toolName, input: {}, result: { total } }],
      };
    },
  );
}

addLooseCount(["data sources", "data source", "datasources", "datasource"], "data source", "data sources", "/sites/{siteId}/datasources", "ds_list", "list_datasources");
addLooseCount(["workbooks", "workbook"], "workbook", "workbooks", "/sites/{siteId}/workbooks", "wb_list", "list_workbooks");
addLooseCount(["users", "user"], "user", "users", "/sites/{siteId}/users", "users_list", "list_users");
addLooseCount(["dashboards", "dashboard", "views", "view"], "dashboard/view", "dashboards/views", "/sites/{siteId}/views", "views_list", "list_site_views");
addLooseCount(["projects", "project"], "project", "projects", "/sites/{siteId}/projects", "projects_list", "list_projects");
addLooseCount(["flows", "flow"], "flow", "flows", "/sites/{siteId}/flows", "flows_list", "list_flows");
// ---- Full-phrasing count coverage ----
// The strict ("how many X") and loose ("what's the total number of X")
// patterns above both miss common phrasings that chain a verb AND a place
// after the noun: "how many workbooks are on the site", "how many
// workbooks do we have on the site", "how many dashboards are there on the
// site". Before this block those fell through to the LLM — and a weak or
// oversubscribed model would answer them with a LIST instead of a number
// (the exact "how many vs list" confusion this file exists to prevent).
// This trailing group accepts: [verb]? [site-qualifier]?, so all of
// "on the site", "are on the site", "are there on the site", "do we have
// on the site", "are published", "exist here" count correctly. Registered
// AFTER the simpler count patterns (they're more specific) but BEFORE every
// list pattern, so a count question can never be answered by a list handler.

const COUNT_TRAILING =
  "\\s*(?:(?:do\\s+(?:i|we)\\s+have|are\\s+there|are(?:\\s+(?:present|published|available|listed|registered))?|exist|can\\s+(?:i|we)\\s+see)?\\s*(?:on\\s+(?:the\\s+|my\\s+)?site|in\\s+total|at\\s+(?:the\\s+|my\\s+)?site)?)?[?.]?$";

function addFullCount(
  nouns: string[],
  singularLabel: string,
  pluralLabel: string,
  endpoint: string,
  cacheNs: string,
  toolName: string,
): void {
  const noun = "(?:" + nouns.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
  addPattern(
    new RegExp(
      "^(?:how\\s+many|count|number\\s+of|total\\s+(?:number\\s+of\\s+)?|what('s|\\s+is)\\s+the\\s+count\\s+of)\\s+" +
        noun +
        COUNT_TRAILING,
      "i",
    ),
    async (_m, client) => {
      const cached = await cacheGet<{ total: number }>(cacheNs, "count_all");
      let total = cached?.total;
      if (total === undefined) {
        const result = await client.restRequest<any>("GET", endpoint, { params: { pageSize: "1", pageNumber: "1" } });
        total = Number(result?.pagination?.totalAvailable ?? 0);
        await cacheSet(cacheNs, "count_all", { total });
      }
      const label = total === 1 ? singularLabel : pluralLabel;
      return {
        tool: toolName,
        input: {},
        response: "There " + (total === 1 ? "is" : "are") + " **" + total + "** " + label + " on your Tableau site.",
        toolCalls: [{ id: "fast_path", name: toolName, input: {}, result: { total } }],
      };
    },
  );
}

addFullCount(["data sources", "data source", "datasources", "datasource"], "data source", "data sources", "/sites/{siteId}/datasources", "ds_list", "list_datasources");
addFullCount(["workbooks", "workbook"], "workbook", "workbooks", "/sites/{siteId}/workbooks", "wb_list", "list_workbooks");
addFullCount(["users", "user"], "user", "users", "/sites/{siteId}/users", "users_list", "list_users");
addFullCount(["dashboards", "dashboard", "views", "view"], "dashboard/view", "dashboards/views", "/sites/{siteId}/views", "views_list", "list_site_views");
addFullCount(["projects", "project"], "project", "projects", "/sites/{siteId}/projects", "projects_list", "list_projects");
addFullCount(["flows", "flow"], "flow", "flows", "/sites/{siteId}/flows", "flows_list", "list_flows");

// ---- Loose list phrasings + more content types ----
// Same principle on the list side: "show me all X", "what X do I have",
// "name every X", "give me a list of X", "all my X" → full numbered list.
// The trailing group is deliberately strict so a message that names a
// specific item ("show me the Sales dashboard") can never match — anchored
// regexes mean that falls through to the LLM instead of returning the whole
// site's worth of content.
//
// Pagination: when there are many items, show first 20 with a "show more"
// prompt. The user can say "more" or "next" to see the next page.

interface LooseListSpec {
  nouns: string[];
  singularLabel: string;
  pluralLabel: string;
  endpoint: string;
  cacheNs: string;
  toolName: string;
  accessor: (page: any) => any[];
}

function addLooseList(spec: LooseListSpec): void {
  const noun = "(?:" + spec.nouns.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
  addPattern(
    new RegExp(
      "^(list|show|name|enumerate|display|give|fetch|get|see)\\s+(me\\s+)?(a\\s+list\\s+of\\s+)?(all\\s+|the\\s+|every\\s+|each\\s+|out\\s+|down\\s+)*" +
        noun +
        "\\s*(on\\s+(the\\s+|my\\s+)?site|in\\s+total|we\\s+have)?[?.]?$|" +
        "^what\\s+" + noun + "\\s+(do\\s+(i|we)\\s+have|are\\s+(there|available))[?.]?$|" +
        "^all\\s+(my\\s+|the\\s+)?" + noun + "\\s*(on\\s+(the\\s+|my\\s+)?site)?[?.]?$",
      "i",
    ),
    async (_m, client) => {
      const userId = client.getUserId();
      const cached = await cacheGet<{ items: Array<{ name: string; id: string }> }>(spec.cacheNs, "all_names_" + userId);
      let items = cached?.items;
      if (!items) {
        const all: any[] = await client.restRequestAllPages(spec.endpoint, (page) => {
          const list = spec.accessor(page);
          return Array.isArray(list) ? list : [list];
        });
        items = all.map((it: any) => ({ name: it.name, id: it.id }));
        await cacheSet(spec.cacheNs, "all_names_" + userId, { items });
      }
      if (!items.length) {
        return {
          tool: spec.toolName,
          input: {},
          response: "There are no " + spec.pluralLabel + " on your site.",
          toolCalls: [{ id: "fast_path", name: spec.toolName, input: {}, result: { total: 0 } }],
        };
      }
      // Paginate: show first LIST_PAGE_SIZE items, with "show more" if there are more
      const page = 1;
      const startIdx = (page - 1) * LIST_PAGE_SIZE;
      const endIdx = Math.min(startIdx + LIST_PAGE_SIZE, items.length);
      const pageItems = items.slice(startIdx, endIdx);
      const lines: string[] = [];
      for (let i = 0; i < pageItems.length; i++) lines.push((startIdx + i + 1) + ". **" + pageItems[i].name + "**");
      let response = "Here are your " + spec.pluralLabel + " (" + items.length + " total):\n\n" + lines.join("\n");
      if (items.length > LIST_PAGE_SIZE) {
        response += "\n\nShowing " + (startIdx + 1) + "–" + endIdx + " of " + items.length + ". Say **more** to see the next page.";
        // Remember full item list so "more" / "next" can paginate through it
        paginationState.set(userId, { kind: spec.toolName.replace("list_", "").replace("site_views", "views") as PaginationState["kind"], items, page });
      }
      return {
        tool: spec.toolName,
        input: { page, limit: LIST_PAGE_SIZE },
        response,
        toolCalls: [{ id: "fast_path", name: spec.toolName, input: { page, limit: LIST_PAGE_SIZE }, result: { total: items.length, items: pageItems } }],
      };
    },
  );
}

addLooseList({ nouns: ["data sources", "data source", "datasources", "datasource"], singularLabel: "data source", pluralLabel: "data sources", endpoint: "/sites/{siteId}/datasources", cacheNs: "ds_list", toolName: "list_datasources", accessor: (p) => p?.datasources?.datasource ?? [] });
addLooseList({ nouns: ["workbooks", "workbook"], singularLabel: "workbook", pluralLabel: "workbooks", endpoint: "/sites/{siteId}/workbooks", cacheNs: "wb_list", toolName: "list_workbooks", accessor: (p) => p?.workbooks?.workbook ?? [] });
addLooseList({ nouns: ["dashboards", "dashboard", "views", "view"], singularLabel: "dashboard/view", pluralLabel: "dashboards/views", endpoint: "/sites/{siteId}/views", cacheNs: "views_list", toolName: "list_site_views", accessor: (p) => p?.views?.view ?? [] });
addLooseList({ nouns: ["users", "user"], singularLabel: "user", pluralLabel: "users", endpoint: "/sites/{siteId}/users", cacheNs: "users_list", toolName: "list_users", accessor: (p) => p?.users?.user ?? [] });
addLooseList({ nouns: ["projects", "project"], singularLabel: "project", pluralLabel: "projects", endpoint: "/sites/{siteId}/projects", cacheNs: "projects_list", toolName: "list_projects", accessor: (p) => p?.projects?.project ?? [] });
addLooseList({ nouns: ["flows", "flow"], singularLabel: "flow", pluralLabel: "flows", endpoint: "/sites/{siteId}/flows", cacheNs: "flows_list", toolName: "list_flows", accessor: (p) => p?.flows?.flow ?? [] });

// ---- Descriptions (deterministic; always complete) ----
// "List/extract all workbook (or data source) descriptions" is answered
// directly from the server-side enriched results — no LLM in the loop — so
// the reply can NEVER be truncated, paraphrased, or dropped by an output
// token cap (the exact failure the user kept seeing with the model path).
// list_workbooks enriches missing descriptions from each workbook's own
// REST record (contentTools.ts); datasource descriptions are fetched the
// same way here, in small parallel batches.

// list_workbooks in contentTools enriches missing descriptions from each
// workbook's own REST record; this duplicates that enrichment locally (same
// batching) so the fast path stays self-contained — no dependency on the
// tool registry / DB layer, which is exactly what the other handlers here
// avoid too.

async function answerWorkbookDescriptions(client: TableauClient): Promise<FastPathResult | null> {
  const all = await client.restRequestAllPages<any>("/sites/{siteId}/workbooks", (page) => {
    const list = page?.workbooks?.workbook ?? [];
    return Array.isArray(list) ? list : [list];
  });
  const workbooks = all.slice(0, 100);
  if (workbooks.length === 0) {
    return {
      tool: "list_workbooks",
      input: {},
      response: "There are no published workbooks on your site.",
      toolCalls: [{ id: "fast_path", name: "list_workbooks", input: {}, result: { total: 0, workbooks: [] } }],
    };
  }
  // Tableau's LIST workbooks endpoint can omit `description` — fill those in
  // from each workbook's own record (small parallel batches) so the reply is
  // complete and verbatim rather than "description unknown" for some items.
  const missing = workbooks.filter((w: any) => w.description == null);
  for (let i = 0; i < missing.length; i += 10) {
    await Promise.all(
      missing.slice(i, i + 10).map(async (w: any) => {
        try {
          const d = await client.restRequest<any>("GET", `/sites/{siteId}/workbooks/${w.id}`);
          const desc = d?.workbook?.description;
          if (typeof desc === "string" && desc.trim()) w.description = desc.trim();
        } catch {
          // leave description null → "No description set." below
        }
      }),
    );
  }
  const blocks: string[] = [];
  for (let i = 0; i < workbooks.length; i++) {
    const w: any = workbooks[i];
    const desc = typeof w.description === "string" && w.description.trim() ? w.description.trim() : null;
    blocks.push((i + 1) + ". **" + (w.name ?? "(unnamed)") + "**\n   " + (desc ?? "No description set."));
  }
  return {
    tool: "list_workbooks",
    input: {},
    response: "Here are the descriptions of all **" + workbooks.length + "** published workbooks:\n\n" + blocks.join("\n\n"),
    toolCalls: [
      {
        id: "fast_path",
        name: "list_workbooks",
        input: { limit: 100 },
        result: {
          total: workbooks.length,
          workbooks: workbooks.map((w: any) => ({ name: w.name, hasDescription: typeof w.description === "string" && !!w.description.trim() })),
        },
      },
    ],
  };
}

// The LIST datasources API doesn't carry descriptions — pull each one's own
// record in small parallel batches so every description is complete.
async function answerDatasourceDescriptions(client: TableauClient): Promise<FastPathResult | null> {
  const all = await client.restRequestAllPages<any>("/sites/{siteId}/datasources", (page) => {
    const list = page?.datasources?.datasource ?? [];
    return Array.isArray(list) ? list : [list];
  });
  const datasources = all.slice(0, 25);
  if (datasources.length === 0) {
    return {
      tool: "list_datasources",
      input: {},
      response: "There are no published data sources on your site.",
      toolCalls: [{ id: "fast_path", name: "list_datasources", input: {}, result: { total: 0, datasources: [] } }],
    };
  }
  for (let i = 0; i < datasources.length; i += 10) {
    await Promise.all(
      datasources.slice(i, i + 10).map(async (ds: any) => {
        try {
          const meta = await client.restRequest<any>("GET", `/sites/{siteId}/datasources/${ds.id}`);
          const desc = meta?.datasource?.description;
          if (typeof desc === "string" && desc.trim()) ds.description = desc.trim();
        } catch {
          // leave description null → "No description set." below
        }
      }),
    );
  }
  const blocks: string[] = [];
  for (let i = 0; i < datasources.length; i++) {
    const d: any = datasources[i];
    const desc = typeof d.description === "string" && d.description.trim() ? d.description.trim() : null;
    blocks.push((i + 1) + ". **" + (d.name ?? "(unnamed)") + "**\n   " + (desc ?? "No description set."));
  }
  return {
    tool: "list_datasources",
    input: {},
    response: "Here are the descriptions of your data sources (" + datasources.length + " shown):\n\n" + blocks.join("\n\n"),
    toolCalls: [
      {
        id: "fast_path",
        name: "list_datasources",
        input: {},
        result: {
          total: datasources.length,
          datasources: datasources.map((d: any) => ({ name: d.name, hasDescription: typeof d.description === "string" && !!d.description.trim() })),
        },
      },
    ],
  };
}

addPattern(
  /^(?:what\s+descriptions?\s+(?:do|does)\s+(?:all\s+|the\s+|my\s+|every\s+|each\s+)?workbooks?\s+(?:have|contain)|(?:list|show|give|extract|get|fetch|tell|print)\s+(?:me\s+)?(?:all\s+|the\s+|every\s+|each\s+)?workbooks?\s+(?:and\s+their\s+)?descriptions?|(?:list|show|give|extract|get|fetch|tell)\s+(?:me\s+)?(?:all\s+|the\s+|every\s+|each\s+)?descriptions?\s+(?:of|for|from)\s+(?:all\s+|the\s+|every\s+|each\s+)?workbooks?)\s*(?:on\s+(?:the\s+|my\s+)?site)?[?.]?$/i,
  async (_m, client) => answerWorkbookDescriptions(client),
);

addPattern(
  /^(?:what\s+descriptions?\s+(?:do|does)\s+(?:all\s+|the\s+|my\s+|every\s+|each\s+)?(?:data\s*sources?|datasources?)\s+(?:have|contain)|(?:list|show|give|extract|get|fetch|tell|print)\s+(?:me\s+)?(?:all\s+|the\s+|every\s+|each\s+)?(?:data\s*sources?|datasources?)\s+(?:and\s+their\s+)?descriptions?|(?:list|show|give|extract|get|fetch|tell)\s+(?:me\s+)?(?:all\s+|the\s+|every\s+|each\s+)?descriptions?\s+(?:of|for|from)\s+(?:all\s+|the\s+|every\s+|each\s+)?(?:data\s*sources?|datasources?))\s*(?:on\s+(?:the\s+|my\s+)?site)?[?.]?$/i,
  async (_m, client) => answerDatasourceDescriptions(client),
);

// ---- List all queries ----

addPattern(
  /^list\s+(all\s+)?data\s*sources?\s*[?.]?$/i,
  async (_m, client) => {
    const userId = client.getUserId();
    const cached = await cacheGet<{ datasources: Array<{ name: string; id: string }> }>("ds_list", "all_names_" + userId);
    let datasources = cached?.datasources;
    if (!datasources) {
      const all: any[] = await client.restRequestAllPages(
        "/sites/{siteId}/datasources",
        (page) => {
          const list = page?.datasources?.datasource ?? [];
          return Array.isArray(list) ? list : [list];
        },
      );
      datasources = all.map((d: any) => ({ name: d.name, id: d.id }));
      await cacheSet("ds_list", "all_names_" + userId, { datasources });
    }
    if (datasources.length === 0) {
      return {
        tool: "list_datasources", input: {},
        response: "There are no published data sources on your site.",
        toolCalls: [{ id: "fast_path", name: "list_datasources", input: {}, result: { datasources: [] } }],
      };
    }
    // Paginate: show first LIST_PAGE_SIZE items, with "show more" if there are more
    const page = 1;
    const startIdx = (page - 1) * LIST_PAGE_SIZE;
    const endIdx = Math.min(startIdx + LIST_PAGE_SIZE, datasources.length);
    const pageItems = datasources.slice(startIdx, endIdx);
    const lines: string[] = [];
    for (let i = 0; i < pageItems.length; i++) lines.push((startIdx + i + 1) + ". **" + pageItems[i].name + "**");
    let response = "Here are your published data sources (" + datasources.length + " total):\n\n" + lines.join("\n");
    if (datasources.length > LIST_PAGE_SIZE) {
      response += "\n\nShowing " + (startIdx + 1) + "–" + endIdx + " of " + datasources.length + ". Say **more** to see the next page.";
      paginationState.set(userId, { kind: "datasources", items: datasources, page });
    }
    return {
      tool: "list_datasources", input: { page, limit: LIST_PAGE_SIZE },
      response,
      toolCalls: [{ id: "fast_path", name: "list_datasources", input: { page, limit: LIST_PAGE_SIZE }, result: { total: datasources.length, items: pageItems } }],
    };
  },
);

// ---- "More" pagination continuation ----
// When a previous list_* response ended with "Say more to see the next page",
// a bare "more"/"next"/"continue" from the user should return the next page
// of the same content type. We remember the last list result per user in a
// lightweight in-memory map (fast path is stateless otherwise).

function addMoreHandler(
  kind: PaginationState["kind"],
  cacheNs: string,
  toolName: string,
  pluralLabel: string,
): void {
  addPattern(
    /^(more|next|continue|show\s+more|next\s+page|keep\s+going)\s*[?.]?$/i,
    async (_m, client) => {
      const userId = client.getUserId();
      const state = paginationState.get(userId);
      if (!state || state.kind !== kind) return null; // not a continuation of this list type

      const nextPage = state.page + 1;
      // 0-based index of this page's first item: page 2 → index 20 (item 21).
      const startIdx = (nextPage - 1) * LIST_PAGE_SIZE;
      if (startIdx >= state.items.length) {
        return {
          tool: toolName, input: {},
          response: "That's all of them — you've seen every " + pluralLabel + " on your site.",
          toolCalls: [{ id: "fast_path", name: toolName, input: { page: nextPage }, result: { total: state.items.length, items: [] } }],
        };
      }
      const endIdx = Math.min(startIdx + LIST_PAGE_SIZE, state.items.length);
      const pageItems = state.items.slice(startIdx, endIdx);
      const lines: string[] = [];
      for (let i = 0; i < pageItems.length; i++) lines.push((startIdx + i + 1) + ". **" + pageItems[i].name + "**");
      let response = pluralLabel.charAt(0).toUpperCase() + pluralLabel.slice(1) + " (continued):\n\n" + lines.join("\n");
      if (endIdx < state.items.length) {
        response += "\n\nShowing " + (startIdx + 1) + "–" + endIdx + " of " + state.items.length + ". Say **more** for the next page.";
      } else {
        response += "\n\nThat's all " + state.items.length + " " + pluralLabel + ".";
      }
      state.page = nextPage;
      return {
        tool: toolName, input: { page: nextPage, limit: LIST_PAGE_SIZE },
        response,
        toolCalls: [{ id: "fast_path", name: toolName, input: { page: nextPage, limit: LIST_PAGE_SIZE }, result: { total: state.items.length, items: pageItems } }],
      };
    },
  );
}

addMoreHandler("workbooks", "wb_list", "list_workbooks", "workbooks");
addMoreHandler("datasources", "ds_list", "list_datasources", "data sources");
addMoreHandler("views", "views_list", "list_site_views", "dashboards/views");
addMoreHandler("users", "users_list", "list_users", "users");
addMoreHandler("projects", "projects_list", "list_projects", "projects");
addMoreHandler("flows", "flows_list", "list_flows", "flows");

addPattern(
  /^list\s+(all\s+)?workbooks?\s*[?.]?$/i,
  async (_m, client) => {
    const userId = client.getUserId();
    const cached = await cacheGet<{ workbooks: Array<{ name: string; id: string }> }>("wb_list", "all_names_" + userId);
    let workbooks = cached?.workbooks;
    if (!workbooks) {
      const all: any[] = await client.restRequestAllPages(
        "/sites/{siteId}/workbooks",
        (page) => {
          const list = page?.workbooks?.workbook ?? [];
          return Array.isArray(list) ? list : [list];
        },
      );
      workbooks = all.map((w: any) => ({ name: w.name, id: w.id }));
      await cacheSet("wb_list", "all_names_" + userId, { workbooks });
    }
    if (workbooks.length === 0) {
      return {
        tool: "list_workbooks", input: {},
        response: "There are no published workbooks on your site.",
        toolCalls: [{ id: "fast_path", name: "list_workbooks", input: {}, result: { workbooks: [] } }],
      };
    }
    // Paginate: show first LIST_PAGE_SIZE items, with "show more" if there are more
    const page = 1;
    const startIdx = (page - 1) * LIST_PAGE_SIZE;
    const endIdx = Math.min(startIdx + LIST_PAGE_SIZE, workbooks.length);
    const pageItems = workbooks.slice(startIdx, endIdx);
    const lines: string[] = [];
    for (let i = 0; i < pageItems.length; i++) lines.push((startIdx + i + 1) + ". **" + pageItems[i].name + "**");
    let response = "Here are your published workbooks (" + workbooks.length + " total):\n\n" + lines.join("\n");
    if (workbooks.length > LIST_PAGE_SIZE) {
      response += "\n\nShowing " + (startIdx + 1) + "–" + endIdx + " of " + workbooks.length + ". Say **more** to see the next page.";
      paginationState.set(userId, { kind: "workbooks", items: workbooks, page });
    }
    return {
      tool: "list_workbooks", input: { page, limit: LIST_PAGE_SIZE },
      response,
      toolCalls: [{ id: "fast_path", name: "list_workbooks", input: { page, limit: LIST_PAGE_SIZE }, result: { total: workbooks.length, items: pageItems } }],
    };
  },
);

// ---- Server info ----

addPattern(
  /^(what('s|\s+is)\s+my\s+)?tableau\s+(server|site)\s+(version|info|details)\s*[?.]?$/i,
  async (_m, client) => {
    const cached = await cacheGet<any>("server_info", "info");
    let info = cached;
    if (!info) {
      const raw = await client.restRequest<any>("GET", "/serverinfo");
      const si = raw?.serverInfo ?? {};
      info = {
        productName: si.productName,
        productVersion: si.productVersion,
        buildNumber: si.buildNumber,
        restApiVersion: si.restApiVersion,
      };
      await cacheSet("server_info", "info", info);
    }
    const resp = [
      "Your Tableau server info:",
      "- **Product**: " + info.productName,
      "- **Version**: " + info.productVersion,
      "- **Build**: " + info.buildNumber,
      "- **REST API Version**: " + info.restApiVersion,
    ].join("\n");
    return {
      tool: "get_server_info", input: {},
      response: resp,
      toolCalls: [{ id: "fast_path", name: "get_server_info", input: {}, result: info }],
    };
  },
);

// ---- Help ----

addPattern(
  /^(what\s+can\s+you\s+do|help|capabilities|what\s+are\s+your\s+features)\s*[?.]?$/i,
  async (_m) => {
    const resp = [
      "I'm **Lumen**, your conversational analytics assistant for Tableau.",
      "Here's what I can help with:",
      "",
      "**Data Exploration**",
      "- List/count data sources, workbooks, dashboards, users, projects, flows",
      "- Search for content by name | Show server info",
      "",
      "**Data Analysis**",
      "- Query any datasource (aggregations, filters, sorting)",
      "- Compare metrics (MoM, QoQ, YoY) | Forecast | Anomaly detection",
      "- Rank, cross-tab, correlation, share of total",
      "",
      "**Dashboards**",
      "- Pull data from any dashboard | Export as PDF/image",
      "- Get computed insights from dashboards",
      "",
      "**Pulse Metrics** | **Administration**",
      "- List/explain Pulse metrics | List users, groups, schedules",
      "- Check permissions | View extract refresh status",
      "",
      "Try: \"How many data sources?\" | \"Total sales by region\" | \"List all workbooks\"",
    ].join("\n");
    return { tool: "help", input: {}, response: resp, toolCalls: [] };
  },
);

// ---- Public API ----

export async function tryFastPath(message: string, client: TableauClient): Promise<FastPathResult | null> {
  const trimmed = message.trim();
  for (const pattern of patterns) {
    const match = trimmed.match(pattern.regex);
    if (match) {
      try {
        const result = await pattern.handler(match, client);
        if (result) return result;
      } catch (err: any) {
        console.warn("[queryRouter] Fast path error: " + (err?.message ?? err) + " -- falling back to LLM");
      }
    }
  }
  return null;
}

/** Records the full item list + current page so "more" can paginate through it. */
export function recordPaginationState(userId: string, state: PaginationState): void {
  paginationState.set(userId, state);
}
