import { test } from "node:test";
import assert from "node:assert/strict";
import { TableauClient } from "../src/tableau/client.js";
import { tryFastPath } from "../src/lib/queryRouter.js";
import { findInvalidIdArg } from "../src/lib/idTracking.js";
import { cacheInvalidateNamespace } from "../src/lib/cache.js";

// ---- Fakes ----

const WORKBOOKS = [
  { id: "wb1", name: "Sales Overview", project: { name: "Finance" }, description: "Monthly sales by region with a rolling forecast." },
  { id: "wb2", name: "Marketing Funnel", description: "Leads, MQLs and opportunities across the marketing funnel." },
  { id: "wb3", name: "Ops Metrics", description: null },
];

const DATASOURCES = [
  { id: "58a2528c-6e9e-4a2b-9f51-cf9a89a1d2e1", name: "Sales Data" },
  { id: "c9b14e73-2a9d-4d63-8c01-4f6b7d28a91c", name: "Marketing Data" },
];

function fakeClient(fakes: {
  total?: number;
  datasourceDescriptions?: Record<string, string | undefined>;
  includeDescription?: boolean;
} = {}): TableauClient {
  return {
    getUserId: () => "test-user",
    restRequest: async (method: string, path: string) => {
      if (path === "/sites/{siteId}/workbooks" || path === "/sites/{siteId}/datasources" || path === "/sites/{siteId}/users" || path === "/sites/{siteId}/views") {
        return { pagination: { totalAvailable: fakes.total ?? 1 } };
      }
      if (path.startsWith("/sites/{siteId}/datasources/")) {
        const id = path.slice("/sites/{siteId}/datasources/".length);
        return { datasource: { description: fakes.datasourceDescriptions?.[id] } };
      }
      if (path === "/sites/{siteId}/workbooks/wb1") {
        return { workbook: { description: "Monthly sales by region with a rolling forecast." } };
      }
      return {};
    },
    restRequestAllPages: async (path: string) => {
      if (path === "/sites/{siteId}/workbooks") {
        return WORKBOOKS;
      }
      if (path === "/sites/{siteId}/datasources") return DATASOURCES;
      return [];
    },
  } as unknown as TableauClient;
}

// ---- Count vs List distinction ----

test("strict count: 'how many data sources do I have' returns the number only", async () => {
  const client = fakeClient({ total: 4 });
  const out = await tryFastPath("how many data sources do I have?", client);
  assert.ok(out, "fast path should answer");
  assert.match(out.response, /\*\*4\*\*/);
  assert.match(out.response, /data sources/);
  assert.equal(out.tool, "list_datasources");
});

test("loose count: 'what is the total number of workbooks' returns the number only", async () => {
  const client = fakeClient({ total: 3 });
  const out = await tryFastPath("what is the total number of workbooks", client);
  assert.ok(out, "fast path should answer");
  assert.match(out.response, /\*\*3\*\*/);
  // A count answer must NOT be a numbered list of names.
  assert.ok(!out.response.includes("1. **"), "a count answer must not enumerate items");
});

test("loose count: 'workbook count' suffix phrasing works", async () => {
  const client = fakeClient({ total: 3 });
  const out = await tryFastPath("workbook count", client);
  assert.ok(out, "fast path should answer");
  assert.match(out.response, /\*\*3\*\*/);
});

test("loose count: 'total number of data sources in total' works", async () => {
  const client = fakeClient({ total: 4 });
  const out = await tryFastPath("total number of data sources in total", client);
  assert.ok(out, "fast path should answer");
  assert.match(out.response, /\*\*4\*\*/);
});

test("list: 'show me all workbooks' returns every name, not just a count", async () => {
  const client = fakeClient();
  const out = await tryFastPath("show me all workbooks", client);
  assert.ok(out, "fast path should answer");
  assert.ok(out.response.includes("Sales Overview"), "list must include item names");
  assert.ok(out.response.includes("Marketing Funnel"));
  assert.ok(out.response.includes("Ops Metrics"));
  assert.match(out.response, /\(3 total\)/);
});

test("list: 'what workbooks do I have' is treated as a list", async () => {
  const client = fakeClient();
  const out = await tryFastPath("What workbooks do I have?", client);
  assert.ok(out, "fast path should answer");
  assert.ok(out.response.includes("Sales Overview"), "list must include item names");
});

test("search intent is NOT short-circuited into a count/list", async () => {
  const client = fakeClient({ total: 4 });
  const out = await tryFastPath("Search for anything named Revenue on my site", client);
  assert.equal(out, null, "a search question must fall through to the LLM/search_content");
});

// ---- Full-phrasing counts ("how many X are on the site") ----
// These phrasings used to slip past every count pattern and land on the LLM,
// which would answer a LIST instead of a number. They must all be counts.

test("count: 'how many workbooks are on the site' returns a number, not a list", async () => {
  await cacheInvalidateNamespace("wb_list"); // clear totals cached by earlier tests
  const client = fakeClient({ total: 5 });
  const out = await tryFastPath("how many workbooks are on the site", client);
  assert.ok(out, "fast path should answer");
  assert.match(out.response, /\*\*5\*\*/);
  assert.ok(!out.response.includes("1. **"), "a count answer must not enumerate items");
});

test("count: 'how many workbooks do we have on the site' works", async () => {
  await cacheInvalidateNamespace("wb_list");
  const client = fakeClient({ total: 7 });
  const out = await tryFastPath("how many workbooks do we have on the site?", client);
  assert.ok(out, "fast path should answer");
  assert.match(out.response, /\*\*7\*\*/);
  assert.ok(!out.response.includes("1. **"), "a count answer must not enumerate items");
});

test("count: 'how many dashboards are there on the site' works", async () => {
  await cacheInvalidateNamespace("views_list");
  const client = fakeClient({ total: 4 });
  const out = await tryFastPath("how many dashboards are there on the site", client);
  assert.ok(out, "fast path should answer");
  assert.match(out.response, /\*\*4\*\*/);
  assert.ok(!out.response.includes("1. **"), "a count answer must not enumerate items");
});

test("count: 'how many workbooks are published' works", async () => {
  await cacheInvalidateNamespace("wb_list");
  const client = fakeClient({ total: 3 });
  const out = await tryFastPath("how many workbooks are published", client);
  assert.ok(out, "fast path should answer");
  assert.match(out.response, /\*\*3\*\*/);
});

test("count: 'what's the count of users on the site' works", async () => {
  await cacheInvalidateNamespace("users_list");
  const client = fakeClient({ total: 9 });
  const out = await tryFastPath("what's the count of users on the site", client);
  assert.ok(out, "fast path should answer");
  assert.match(out.response, /\*\*9\*\*/);
  assert.ok(!out.response.includes("1. **"), "a count answer must not enumerate items");
});

// ---- Pagination ----
// A list with more items than one page returns the first page plus a
// "say more" prompt, and a follow-up "more" advances to the next page.

function manyWorkbooksClient(count: number): TableauClient {
  const many = Array.from({ length: count }, (_, i) => ({ id: `wb${i + 1}`, name: `Workbook ${i + 1}` }));
  return {
    getUserId: () => "test-user",
    restRequest: async () => ({ pagination: { totalAvailable: count } }),
    restRequestAllPages: async (path: string) => (path === "/sites/{siteId}/workbooks" ? many : []),
  } as unknown as TableauClient;
}

test("pagination: 'list workbooks' shows the first page and offers more", async () => {
  await cacheInvalidateNamespace("wb_list"); // drop any cached item list from earlier tests
  const client = manyWorkbooksClient(25);
  const out = await tryFastPath("list workbooks", client);
  assert.ok(out, "fast path should answer");
  assert.match(out.response, /\(25 total\)/);
  assert.ok(out.response.includes("1. **Workbook 1**"), "first page starts at item 1");
  assert.ok(out.response.includes("20. **Workbook 20**"), "first page shows up to item 20");
  assert.ok(!out.response.includes("21. **"), "first page must NOT include item 21");
  assert.ok(out.response.includes("Say **more**"), "should offer the next page");
});

test("pagination: 'more' returns the next page and then signals the end", async () => {
  await cacheInvalidateNamespace("wb_list");
  const client = manyWorkbooksClient(25);
  const first = await tryFastPath("list workbooks", client);
  assert.ok(first, "first list should answer");
  assert.match(first.response, /Say \*\*more\*\*/);

  const page2 = await tryFastPath("more", client);
  assert.ok(page2, "'more' should answer");
  assert.ok(page2.response.includes("21. **Workbook 21**"), "second page starts at item 21");
  assert.ok(page2.response.includes("25. **Workbook 25**"), "second page shows the final items");
  assert.ok(page2.response.includes("That's all 25 workbooks"), "last page says the list is complete");
});

// ---- Descriptions (deterministic, never truncated) ----

test("descriptions: 'list all workbooks and their descriptions' is complete and verbatim", async () => {
  const client = fakeClient();
  const out = await tryFastPath("list all workbooks and their descriptions", client);
  assert.ok(out, "fast path should answer");
  assert.ok(out.response.includes("Sales Overview"));
  assert.ok(out.response.includes("Monthly sales by region with a rolling forecast."), "description must be verbatim");
  assert.ok(out.response.includes("Marketing Funnel"));
  assert.ok(out.response.includes("Leads, MQLs and opportunities across the marketing funnel."));
  assert.ok(out.response.includes("Ops Metrics"));
  assert.ok(out.response.includes("No description set."), "null description must say so explicitly");
});

test("descriptions: 'extract every workbook description' works", async () => {
  const client = fakeClient();
  const out = await tryFastPath("extract every workbook description", client);
  assert.ok(out, "fast path should answer");
  assert.ok(out.response.includes("Monthly sales by region with a rolling forecast."));
});

test("descriptions: data source descriptions are enriched", async () => {
  const client = fakeClient({ datasourceDescriptions: { "58a2528c-6e9e-4a2b-9f51-cf9a89a1d2e1": "Primary ERP source" } });
  const out = await tryFastPath("list all data sources and their descriptions", client);
  assert.ok(out, "fast path should answer");
  assert.ok(out.response.includes("Sales Data"));
  assert.ok(out.response.includes("Primary ERP source"));
  // The one without a description says so instead of inventing one.
  assert.ok(out.response.includes("No description set."));
});

// ---- datasourceLuid validation (search-query hole) ----

test("idTracking blocks an invented datasourceLuid", () => {
  const invented = "e4b9677c-c7d7-4a71-b407-124709078d7a";
  const bad = findInvalidIdArg({ datasourceLuid: invented }, new Set());
  assert.ok(bad, "unseen datasourceLuid must be rejected");
  assert.equal(bad.reason, "unknown_uuid");
});

test("idTracking accepts a datasourceLuid seen in a prior tool result", () => {
  const luid = "e4b9677c-c7d7-4a71-b407-124709078d7a";
  const ok = findInvalidIdArg({ datasourceLuid: luid }, new Set([luid]));
  assert.equal(ok, null, "a discovered datasourceLuid must pass");
});

test("idTracking rejects non-UUID datasourceLuid shapes", () => {
  const bad = findInvalidIdArg({ datasourceLuid: "datasource123" }, new Set());
  assert.ok(bad);
  assert.equal(bad.reason, "not_uuid_shape");
});