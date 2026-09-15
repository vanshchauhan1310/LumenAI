import { z } from "zod";
import { TableauClient } from "../tableau/client.js";
import { clampedLimit } from "../lib/zodHelpers.js";

// Note: these endpoints require the connected Tableau user to be a Site or
// Server Administrator. A non-admin PAT will get a 403 from Tableau — that's
// expected and surfaces as a normal tool error, not a bug (see the tool
// descriptions below, and the site-wide validation fix in connections.ts
// which deliberately does NOT require admin just to connect an account).

// ---- Tool definitions ----

export const adminToolDefinitions = [
  {
    name: "list_users",
    description:
      "List all users on the site with their roles. Requires the connected Tableau account to be a Site or Server Administrator — if it isn't, this call will fail with a permissions error.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_permissions",
    description:
      "Check which users/groups have access to a datasource, workbook, or view, and their capabilities. May require the connected account to be a Site Administrator or the content owner.",
    input_schema: {
      type: "object",
      properties: {
        contentType: { type: "string", enum: ["datasources", "workbooks", "views"] },
        contentId: { type: "string" },
      },
      required: ["contentType", "contentId"],
    },
  },
  {
    name: "refresh_extract_status",
    description:
      "Check the scheduled extract-refresh info for a datasource. Requires the connected account to be a Site or Server Administrator.",
    input_schema: {
      type: "object",
      properties: {
        datasourceId: { type: "string", description: "Datasource id to check extract status for" },
      },
      required: ["datasourceId"],
    },
  },
  {
    name: "query_workbook_permissions",
    description:
      "Who can see a workbook, and with what capabilities (view/filter/download etc.), listed per user/group. Call this for 'who has access to workbook X', 'can the Sales team edit X'. May require admin or content-owner rights.",
    input_schema: {
      type: "object",
      properties: {
        workbookId: { type: "string", description: "Workbook id (from list_workbooks or search_content)" },
      },
      required: ["workbookId"],
    },
  },
  {
    name: "query_view_permissions",
    description:
      "Who can see a specific view/dashboard, and with what capabilities, listed per user/group. Call this for 'who can see dashboard X', 'can the Exec team view Y'. May require admin or content-owner rights.",
    input_schema: {
      type: "object",
      properties: {
        viewId: { type: "string", description: "View id (from list_workbook_views or list_site_views)" },
      },
      required: ["viewId"],
    },
  },
  {
    name: "query_datasource_permissions",
    description:
      "Who can see a datasource, and with what capabilities, listed per user/group. Call this for 'who has access to datasource X'. May require admin or content-owner rights.",
    input_schema: {
      type: "object",
      properties: {
        datasourceId: { type: "string", description: "Datasource id (from list_datasources or list_workbook_datasources)" },
      },
      required: ["datasourceId"],
    },
  },
  {
    name: "list_subscriptions",
    description:
      "List email subscriptions on the site: who is subscribed, to what content, on which schedule. Call this for 'what am I subscribed to', 'who's subscribed to these scheduled reports'. Visibility depends on the account's rights.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Max results to return" },
      },
    },
  },
  {
    name: "list_data_driven_alerts",
    description:
      "List data-driven alerts on the site: what metric each alert watches, its creator and subject. Call this for 'what alerts do I have on this metric', 'who set up alerts on X'. Visibility depends on the account's rights.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Max results to return" },
      },
    },
  },
  {
    name: "list_schedules",
    description:
      "List extract-refresh and subscription schedules on the site with their frequency details and next run. Call this for 'when does this extract refresh', 'what schedules exist'. Requires the connected account to be a Site or Server Administrator.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Max results to return" },
      },
    },
  },
  {
    name: "list_groups",
    description:
      "List the groups on the site with their default role. Call this for 'what groups exist', 'how is my org structured in Tableau'. Requires the connected account to be a Site or Server Administrator.",
    input_schema: {
      type: "object",
      properties: {
        nameFilter: { type: "string", description: "Optional substring to filter group names" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Max results to return" },
      },
    },
  },
  {
    name: "get_group_members",
    description:
      "List the users in a specific group. Call this for 'who's in the Sales group', 'which users are in group X'. Requires the connected account to be a Site or Server Administrator.",
    input_schema: {
      type: "object",
      properties: {
        groupId: { type: "string", description: "Group id (from list_groups)" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Max results to return" },
      },
      required: ["groupId"],
    },
  },
  {
    name: "get_server_info",
    description:
      "Cheap capability/version check: Tableau product, version, build, and REST API version of the connected server. Call this for 'what version of Tableau is this', or as a first diagnostic when other calls behave unexpectedly. No admin rights needed.",
    input_schema: { type: "object", properties: {} },
  },
] as const;

// ---- Zod validators ----

const schemas = {
  list_users: z.object({}),
  check_permissions: z.object({ contentType: z.enum(["datasources", "workbooks", "views"]), contentId: z.string() }),
  refresh_extract_status: z.object({ datasourceId: z.string() }),
  query_workbook_permissions: z.object({ workbookId: z.string() }),
  query_view_permissions: z.object({ viewId: z.string() }),
  query_datasource_permissions: z.object({ datasourceId: z.string() }),
  list_subscriptions: z.object({ limit: clampedLimit(500, 100) }),
  list_data_driven_alerts: z.object({ limit: clampedLimit(500, 100) }),
  list_schedules: z.object({ limit: clampedLimit(500, 100) }),
  list_groups: z.object({ nameFilter: z.string().optional(), limit: clampedLimit(500, 100) }),
  get_group_members: z.object({ groupId: z.string(), limit: clampedLimit(500, 100) }),
  get_server_info: z.object({}),
};

// ---- Handlers ----

async function listUsers(client: TableauClient) {
  const data = await client.restRequest<any>("GET", "/sites/{siteId}/users");
  const users = data?.users?.user ?? [];
  const list = Array.isArray(users) ? users : [users];
  return { count: list.length, users: list.map((u: any) => ({ name: u.name, siteRole: u.siteRole })) };
}

async function refreshExtractStatus(client: TableauClient, args: z.infer<typeof schemas.refresh_extract_status>) {
  const data = await client.restRequest<any>("GET", "/sites/{siteId}/tasks/extractRefreshes");
  const tasks = data?.tasks?.task ?? [];
  const list = Array.isArray(tasks) ? tasks : [tasks];
  const match = list.find((t: any) => t.extractRefresh?.datasource?.id === args.datasourceId);

  if (!match) {
    return { found: false, note: "No scheduled extract refresh task found for this datasource." };
  }
  return {
    found: true,
    scheduleType: match.extractRefresh.type,
    note: "The exact last-run timestamp isn't exposed by this endpoint — cross-check Tableau Cloud's Tasks admin page for that.",
  };
}

async function permissionsFor(
  client: TableauClient,
  contentType: "datasources" | "workbooks" | "views",
  contentId: string,
) {
  const data = await client.restRequest<any>("GET", `/sites/{siteId}/${contentType}/${contentId}/permissions`);
  const capabilities = data?.permissions?.granteeCapabilities ?? [];
  const list = Array.isArray(capabilities) ? capabilities : [capabilities];

  const entries = list.map((gc: any) => {
    const grantee = gc.user ? { type: "user", name: gc.user.name } : { type: "group", name: gc.group?.name };
    const caps = (Array.isArray(gc.capabilities?.capability) ? gc.capabilities.capability : [gc.capabilities?.capability])
      .filter(Boolean)
      .map((c: any) => ({ name: c.name, mode: c.mode }));
    return { grantee, capabilities: caps };
  });

  return { contentType, contentId, count: entries.length, permissions: entries };
}

async function checkPermissions(client: TableauClient, args: z.infer<typeof schemas.check_permissions>) {
  return permissionsFor(client, args.contentType, args.contentId);
}

async function queryWorkbookPermissions(client: TableauClient, args: z.infer<typeof schemas.query_workbook_permissions>) {
  return permissionsFor(client, "workbooks", args.workbookId);
}

async function queryViewPermissions(client: TableauClient, args: z.infer<typeof schemas.query_view_permissions>) {
  return permissionsFor(client, "views", args.viewId);
}

async function queryDatasourcePermissions(client: TableauClient, args: z.infer<typeof schemas.query_datasource_permissions>) {
  return permissionsFor(client, "datasources", args.datasourceId);
}

async function listSubscriptions(client: TableauClient, args: z.infer<typeof schemas.list_subscriptions>) {
  const data = await client.restRequest<any>("GET", "/sites/{siteId}/subscriptions", {
    params: { pageSize: String(args.limit) },
  });
  const raw = data?.subscriptions?.subscription ?? [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return {
    count: list.length,
    subscriptions: list.map((s: any) => ({
      id: s.id,
      subject: s.subject,
      scheduleName: s.schedule?.name ?? null,
      contentName: s.content?.name ?? null,
      contentType: s.content?.type ?? null,
      user: s.user?.name ?? null,
    })),
  };
}

async function listDataDrivenAlerts(client: TableauClient, args: z.infer<typeof schemas.list_data_driven_alerts>) {
  const data = await client.restRequest<any>("GET", "/sites/{siteId}/dataAlerts", {
    params: { pageSize: String(args.limit) },
  });
  const raw = data?.dataAlerts?.dataAlert ?? [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return {
    count: list.length,
    alerts: list.map((a: any) => ({
      id: a.id,
      name: a.name,
      creator: a.creator?.name ?? null,
      subject: a.subject ?? null,
      datasourceName: a.datasource?.name ?? null,
      workbookName: a.workbook?.name ?? null,
    })),
  };
}

async function listSchedules(client: TableauClient, args: z.infer<typeof schemas.list_schedules>) {
  const data = await client.restRequest<any>("GET", "/sites/{siteId}/schedules", {
    params: { pageSize: String(args.limit) },
  });
  const raw = data?.schedules?.schedule ?? [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return {
    count: list.length,
    schedules: list.map((s: any) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      state: s.state ?? null,
      nextRunAt: s.nextRunAt ?? null,
      frequency: s.frequencyDetails?.description ?? s.frequencyDetails?.type ?? null,
    })),
  };
}

async function listGroups(client: TableauClient, args: z.infer<typeof schemas.list_groups>) {
  const data = await client.restRequest<any>("GET", "/sites/{siteId}/groups", {
    params: { pageSize: String(args.limit) },
  });
  const raw = data?.groups?.group ?? [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const filtered = args.nameFilter ? list.filter((g: any) => g.name.toLowerCase().includes(args.nameFilter!.toLowerCase())) : list;
  return { count: filtered.length, groups: filtered.map((g: any) => ({ id: g.id, name: g.name, minimumSiteRole: g.minimumSiteRole })) };
}

async function getGroupMembers(client: TableauClient, args: z.infer<typeof schemas.get_group_members>) {
  const data = await client.restRequest<any>("GET", `/sites/{siteId}/groups/${args.groupId}/users`, {
    params: { pageSize: String(args.limit) },
  });
  const raw = data?.users?.user ?? [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return { count: list.length, users: list.map((u: any) => ({ id: u.id, name: u.name, siteRole: u.siteRole })) };
}

async function getServerInfo(client: TableauClient) {
  const data = await client.restRequest<any>("GET", "/serverinfo");
  const si = data?.serverInfo ?? {};
  return {
    productName: si.productName,
    productVersion: si.productVersion,
    buildNumber: si.buildNumber,
    restApiVersion: si.restApiVersion,
    supportsTableauServer: si.supportsTableauServer ?? null,
  };
}

// ---- Registry ----

export const adminHandlers: Record<string, (client: TableauClient, args: any) => Promise<any>> = {
  list_users: (c) => listUsers(c),
  check_permissions: (c, a) => checkPermissions(c, schemas.check_permissions.parse(a ?? {})),
  refresh_extract_status: (c, a) => refreshExtractStatus(c, schemas.refresh_extract_status.parse(a ?? {})),
  query_workbook_permissions: (c, a) => queryWorkbookPermissions(c, schemas.query_workbook_permissions.parse(a ?? {})),
  query_view_permissions: (c, a) => queryViewPermissions(c, schemas.query_view_permissions.parse(a ?? {})),
  query_datasource_permissions: (c, a) => queryDatasourcePermissions(c, schemas.query_datasource_permissions.parse(a ?? {})),
  list_subscriptions: (c, a) => listSubscriptions(c, schemas.list_subscriptions.parse(a ?? {})),
  list_data_driven_alerts: (c, a) => listDataDrivenAlerts(c, schemas.list_data_driven_alerts.parse(a ?? {})),
  list_schedules: (c, a) => listSchedules(c, schemas.list_schedules.parse(a ?? {})),
  list_groups: (c, a) => listGroups(c, schemas.list_groups.parse(a ?? {})),
  get_group_members: (c, a) => getGroupMembers(c, schemas.get_group_members.parse(a ?? {})),
  get_server_info: (c) => getServerInfo(c),
};
