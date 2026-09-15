import { test } from "node:test";
import assert from "node:assert/strict";
import { TableauClient } from "../src/tableau/client.js";
import { contentHandlers } from "../src/tools/contentTools.js";
import { adminHandlers } from "../src/tools/adminTools.js";

// Valid 1x1 PNG so Jimp (resizeAndCompress) can actually decode it.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

type Calls = { method: string; path: string; body?: any; params?: Record<string, string> }[];

type Fakes = {
  rest?: (method: string, path: string, opts?: any) => any;
  binary?: (path: string, params?: Record<string, string>) => Buffer;
  userId?: string;
};

function fakeClient(fakes: Fakes): TableauClient {
  return {
    getTableauUserId: async () => fakes.userId ?? "user-1",
    restRequest: async (method: string, path: string, opts?: any) =>
      fakes.rest ? fakes.rest(method, path, opts) : {},
    restRequestBinary: async (path: string, params?: Record<string, string>) =>
      fakes.binary ? fakes.binary(path, params) : TINY_PNG,
  } as unknown as TableauClient;
}

const content = (name: string, client: TableauClient, args: any) => contentHandlers[name](client, args);
const admin = (name: string, client: TableauClient, args: any) => adminHandlers[name](client, args);

// ---- get_workbook_details ----

test("get_workbook_details maps workbook metadata and normalizes tags", async () => {
  const client = fakeClient({
    rest: (m, p) => {
      assert.equal(m, "GET");
      assert.equal(p, "/sites/{siteId}/workbooks/wb1");
      return {
        workbook: {
          id: "wb1",
          name: "Sales",
          description: "desc",
          project: { name: "Finance" },
          owner: { name: "Alice" },
          size: 1234,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-02-01T00:00:00Z",
          tags: { tag: [{ label: "core" }, { label: "priority" }] },
          webpageUrl: "https://tab.example/sales",
        },
      };
    },
  });
  const out = await content("get_workbook_details", client, { workbookId: "wb1" });
  assert.equal(out.name, "Sales");
  assert.deepEqual(out.tags, ["core", "priority"]);
  assert.equal(out.project, "Finance");
  assert.equal(out.link, "https://tab.example/sales");
});

test("get_workbook_details falls back to getContentUrl when webpageUrl is missing", async () => {
  const client = fakeClient({
    rest: () => ({ workbook: { id: "wb1", name: "Sales", contentUrl: "sales" } }),
  } as any);
  // getContentUrl isn't present on the fake — only reachable if webpageUrl missing,
  // so this asserts the handler builds the link via the fallback path.
  (client as any).getContentUrl = () => "https://tab.example/sales";
  const out = await content("get_workbook_details", client, { workbookId: "wb1" });
  assert.equal(out.id, "wb1");
  assert.equal(out.link, "https://tab.example/sales");
  assert.equal(out.tags.length, 0);
});

// ---- thumbnail / pdf / custom-view image ----

test("get_workbook_thumbnail fetches binary and returns compressed jpeg base64", async () => {
  let pathHit = "";
  const client = fakeClient({
    binary: (p) => {
      pathHit = p;
      return TINY_PNG;
    },
  });
  const out = await content("get_workbook_thumbnail", client, { workbookId: "wb1" });
  assert.equal(pathHit, "/sites/{siteId}/workbooks/wb1/previewImage");
  assert.equal(out.mediaType, "image/jpeg");
  assert.ok(out.imageBase64.startsWith("/9j/"));
});

test("get_view_pdf returns pdf mediaType and base64 without routing to image", async () => {
  let pathHit = "";
  const client = fakeClient({
    binary: (p) => {
      pathHit = p;
      return Buffer.from("%PDF-1.4 fake");
    },
  });
  const out = await content("get_view_pdf", client, { viewId: "v1" });
  assert.equal(pathHit, "/sites/{siteId}/views/v1/pdf");
  assert.equal(out.mediaType, "application/pdf");
  assert.equal(out.pdfBase64, Buffer.from("%PDF-1.4 fake").toString("base64"));
  assert.equal(out.imageBase64, undefined);
});

test("get_view_pdf returns an error for an empty PDF instead of a falsy pdfBase64", async () => {
  const client = fakeClient({
    binary: () => Buffer.alloc(0),
  });
  const out = await content("get_view_pdf", client, { viewId: "v1" });
  assert.ok(out.error, "expected an error result");
  assert.equal(out.pdfBase64, undefined);
});

test("get_custom_view_image returns compressed jpeg base64", async () => {
  let pathHit = "";
  const client = fakeClient({
    binary: (p) => {
      pathHit = p;
      return TINY_PNG;
    },
  });
  const out = await content("get_custom_view_image", client, { customViewId: "cv1" });
  assert.equal(pathHit, "/sites/{siteId}/customViews/cv1/previewImage");
  assert.equal(out.mediaType, "image/jpeg");
  assert.ok(out.imageBase64.startsWith("/9j/"));
});

// ---- revisions, tags ----

test("list_workbook_revisions returns mapped revision history", async () => {
  const client = fakeClient({
    rest: () => ({
      revisions: {
        revision: [
          { revisionNumber: 3, publishedAt: "2024-02-01T00:00:00Z", user: { name: "Bob" } },
          { revisionNumber: 2, publishedAt: "2024-01-15T00:00:00Z", user: { name: "Bob" } },
        ],
      },
    }),
  });
  const out = await content("list_workbook_revisions", client, { workbookId: "wb1" });
  assert.equal(out.count, 2);
  assert.equal(out.revisions[0].revisionNumber, 3);
  assert.equal(out.revisions[0].publishedBy, "Bob");
});

test("list_tags and add_tags hit the tags endpoint with right method/body", async () => {
  const calls: Calls = [];
  const client = fakeClient({
    rest: (m, p, o) => {
      calls.push({ method: m, path: p, body: o?.body });
      return m === "GET" ? { tags: { tag: [{ label: "core" }] } } : { tags: { tag: [{ label: "core" }, { label: "new" }] } };
    },
  });
  const listed = await content("list_tags", client, { workbookId: "wb1" });
  assert.deepEqual(listed.tags, ["core"]);

  const added = await content("add_tags", client, { workbookId: "wb1", tags: ["new"] });
  assert.equal(calls[1].method, "PUT");
  assert.equal(calls[1].path, "/sites/{siteId}/workbooks/wb1/tags");
  assert.deepEqual(calls[1].body, { tags: { tag: [{ label: "new" }] } });
  assert.deepEqual(added.tags, ["core", "new"]);
});

test("remove_tags issues DELETE with the tag in the path", async () => {
  let hit: any = null;
  const client = fakeClient({
    rest: (m, p, o) => {
      hit = { m, p, o };
      return {};
    },
  });
  const out = await content("remove_tags", client, { workbookId: "wb1", tag: "legacy" });
  assert.equal(hit.m, "DELETE");
  assert.equal(hit.p, "/sites/{siteId}/workbooks/wb1/tags/legacy");
  assert.deepEqual(out, { removed: "legacy" });
});

// ---- favorites ----

test("list_favorites uses getTableauUserId default and groups by type", async () => {
  const client = fakeClient({
    rest: (m, p) => {
      assert.equal(m, "GET");
      assert.equal(p, "/sites/{siteId}/favorites/user-1");
      return {
        favorites: {
          workbook: [{ id: "wb1", name: "Sales" }],
          view: [{ id: "v1", name: "Top" }],
        },
      };
    },
  });
  const out = await content("list_favorites", client, {});
  assert.equal(out.userId, "user-1");
  assert.equal(out.count, 2);
  const workbooks = out.favorites.find((g: any) => g.type === "workbooks");
  assert.equal(workbooks.items[0].name, "Sales");
});

test("add_favorite PUTs the singular content type under favorites", async () => {
  let hit: any = null;
  const client = fakeClient({
    rest: (m, p, o) => {
      hit = { m, p, o };
      return {};
    },
  });
  const out = await content("add_favorite", client, { contentType: "views", contentId: "v1" });
  assert.equal(hit.m, "PUT");
  assert.equal(hit.p, "/sites/{siteId}/favorites/user-1");
  assert.deepEqual(hit.o.body, { favorites: { view: { id: "v1" } } });
  assert.deepEqual(out.favorited, { contentType: "views", contentId: "v1" });
});

test("remove_favorite DELETEs with the singular id param", async () => {
  let hit: any = null;
  const client = fakeClient({
    rest: (m, p, o) => {
      hit = { m, p, o };
      return {};
    },
  });
  await content("remove_favorite", client, { contentType: "workbooks", contentId: "wb1" });
  assert.equal(hit.m, "DELETE");
  assert.equal(hit.p, "/sites/{siteId}/favorites/user-1");
  assert.deepEqual(hit.o.params, { workbookId: "wb1" });
});

// ---- custom views, data quality ----

test("list_custom_views applies the workbook filter and maps entries", async () => {
  let hit: any = null;
  const client = fakeClient({
    rest: (m, p, o) => {
      hit = { p, o };
      return {
        customViews: {
          customView: [
            { id: "cv1", name: "Q1", view: { name: "Top", workbook: { name: "Sales" } }, creator: { name: "Bob" } },
          ],
        },
      };
    },
  });
  const out = await content("list_custom_views", client, { workbookId: "wb1" });
  assert.equal(hit.p, "/sites/{siteId}/customViews");
  assert.equal(hit.o.params.filter, "workbook.id:eq:wb1");
  assert.equal(out.customViews[0].viewName, "Top");
});

test("get_data_quality_warning maps warnings and marks isActive", async () => {
  const client = fakeClient({
    rest: () => ({
      dataQualityWarnings: {
        dataQualityWarning: [{ warningType: "STALE", message: "older than 90 days", creator: { name: "Alice" } }],
      },
    }),
  });
  const out = await content("get_data_quality_warning", client, { contentType: "workbooks", contentId: "wb1" });
  assert.equal(out.count, 1);
  assert.equal(out.warnings[0].warningType, "STALE");
  assert.equal(out.warnings[0].isActive, true);
});

// ---- permissions (shared helper + generalized check_permissions) ----

test("query_workbook_permissions / query_view_permissions / query_datasource_permissions hit their endpoints", async () => {
  const paths: string[] = [];
  const perms = {
    permissions: {
      granteeCapabilities: [
        {
          user: { name: "Alice" },
          capabilities: { capability: [{ name: "Read", mode: "Allow" }, { name: "Filter", mode: "Allow" }] },
        },
        { group: { name: "Exec" }, capabilities: { capability: [{ name: "Read", mode: "Deny" }] } },
      ],
    },
  };
  const client = fakeClient({
    rest: (m, p) => {
      paths.push(p);
      return perms;
    },
  });
  const wb = await admin("query_workbook_permissions", client, { workbookId: "wb1" });
  const vw = await admin("query_view_permissions", client, { viewId: "v1" });
  const ds = await admin("query_datasource_permissions", client, { datasourceId: "ds1" });

  assert.deepEqual(paths, [
    "/sites/{siteId}/workbooks/wb1/permissions",
    "/sites/{siteId}/views/v1/permissions",
    "/sites/{siteId}/datasources/ds1/permissions",
  ]);
  assert.equal(wb.count, 2);
  assert.equal(wb.permissions[0].grantee.type, "user");
  assert.equal(wb.permissions[0].grantee.name, "Alice");
  assert.equal(wb.permissions[0].capabilities.length, 2);
  assert.equal(wb.permissions[1].grantee.type, "group");
  assert.equal(vw.contentType, "views");
  assert.equal(ds.contentType, "datasources");
});

test("check_permissions now accepts views contentType", async () => {
  let hit: any = null;
  const client = fakeClient({
    rest: (m, p) => {
      hit = p;
      return { permissions: {} };
    },
  });
  await admin("check_permissions", client, { contentType: "views", contentId: "v9" });
  assert.equal(hit, "/sites/{siteId}/views/v9/permissions");
});

// ---- subscriptions / alerts / schedules / groups / server info ----

test("list_subscriptions maps subscriptions", async () => {
  const client = fakeClient({
    rest: (m, p, o) => {
      assert.equal(p, "/sites/{siteId}/subscriptions");
      assert.equal(o.params.pageSize, "100");
      return {
        subscriptions: {
          subscription: [
            { id: "s1", subject: "Daily", schedule: { name: "Daily 6am" }, content: { name: "Sales", type: "Workbook" }, user: { name: "Alice" } },
          ],
        },
      };
    },
  });
  const out = await admin("list_subscriptions", client, {});
  assert.equal(out.count, 1);
  assert.equal(out.subscriptions[0].scheduleName, "Daily 6am");
  assert.equal(out.subscriptions[0].user, "Alice");
});

test("list_data_driven_alerts maps alert fields", async () => {
  const client = fakeClient({
    rest: () => ({
      dataAlerts: {
        dataAlert: [{ id: "a1", name: "Revenue drop", creator: { name: "Bob" }, subject: "sum(Revenue)", datasource: { name: "Orders" } }],
      },
    }),
  });
  const out = await admin("list_data_driven_alerts", client, {});
  assert.equal(out.alerts[0].datasourceName, "Orders");
  assert.equal(out.alerts[0].subject, "sum(Revenue)");
});

test("list_schedules maps schedule frequency", async () => {
  const client = fakeClient({
    rest: () => ({
      schedules: {
        schedule: [{ id: "sch1", name: "Nightly", type: "ExtractRefresh", state: "Active", frequencyDetails: { description: "Daily at 2:00 AM" } }],
      },
    }),
  });
  const out = await admin("list_schedules", client, {});
  assert.equal(out.schedules[0].type, "ExtractRefresh");
  assert.equal(out.schedules[0].frequency, "Daily at 2:00 AM");
});

test("list_groups filters by nameFilter", async () => {
  const client = fakeClient({
    rest: () => ({
      groups: {
        group: [
          { id: "g1", name: "Sales Team", minimumSiteRole: "Explorer" },
          { id: "g2", name: "Marketing", minimumSiteRole: "Viewer" },
        ],
      },
    }),
  });
  const out = await admin("list_groups", client, { nameFilter: "sales" });
  assert.equal(out.count, 1);
  assert.equal(out.groups[0].name, "Sales Team");
});

test("get_group_members maps users and hits the group path", async () => {
  let hit = "";
  const client = fakeClient({
    rest: (m, p) => {
      hit = p;
      return { users: { user: [{ id: "u1", name: "Alice", siteRole: "Explorer" }] } };
    },
  });
  const out = await admin("get_group_members", client, { groupId: "g1" });
  assert.equal(hit, "/sites/{siteId}/groups/g1/users");
  assert.equal(out.users[0].name, "Alice");
});

test("get_server_info maps serverInfo fields", async () => {
  let hit = "";
  const client = fakeClient({
    rest: (m, p) => {
      hit = p;
      return { serverInfo: { productVersion: "2024.1", buildNumber: "20241.24.0508", restApiVersion: "3.19", productName: "Tableau Cloud" } };
    },
  });
  const out = await admin("get_server_info", client, {});
  assert.equal(hit, "/serverinfo");
  assert.equal(out.productVersion, "2024.1");
  assert.equal(out.restApiVersion, "3.19");
});
