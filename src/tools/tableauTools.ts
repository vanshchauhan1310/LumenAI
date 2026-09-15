import { z } from "zod";
import { TableauClient } from "../tableau/client.js";
import { clampedLimit } from "../lib/zodHelpers.js";
import { cacheGet, cacheSet } from "../lib/cache.js";

// ---- Schemas (JSON Schema, hand-written to keep this dependency-free) ----
//
// This file covers datasource/query tools only. Content, Pulse, and admin
// tools live in contentTools.ts / pulseTools.ts / adminTools.ts — all four
// are combined into one registry in index.ts, which is what chat.ts imports.

export const datasourceToolDefinitions = [
  {
    name: "list_datasources",
    description:
      "List published Tableau data sources on the site, optionally filtered by name. The result includes an authoritative `total` field — always use that number when reporting how many datasources exist; do not count the `datasources` array entries yourself. Sites can have hundreds+ of datasources, so results are paginated (`hasMore` in the response) — narrow with `nameFilter` first if possible, otherwise page with `offset`.",
    input_schema: {
      type: "object",
      properties: {
        nameFilter: { type: "string", description: "Optional substring to filter datasource names" },
        offset: { type: "integer", minimum: 0, default: 0, description: "Skip this many results (for paging through more than `limit`)" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Max results to return in this call" },
      },
    },
  },
  {
    name: "list_workbook_datasources",
    description:
      "Find the datasource(s) a specific workbook is actually built on, by id. Use this when get_dashboard_summary/get_view_data can't give a full text breakdown of a dashboard's charts (because they aren't separately published views) — a legitimate datasourceLuid found here can then be used with get_datasource_metadata/query_datasource to reconstruct each chart's numbers directly (e.g. group by Country, by Channel, by Device) instead of guessing or inventing a datasourceLuid. Only datasources with a `queryable: true` LUID can actually be used with get_datasource_metadata/query_datasource — others are embedded/live connections not reachable that way.",
    input_schema: {
      type: "object",
      properties: {
        workbookId: { type: "string", description: "Workbook id (from list_workbooks, search_content, or already known from the current scope)" },
      },
      required: ["workbookId"],
    },
  },
  {
    name: "get_datasource_metadata",
    description:
      "Get the fields (dimensions/measures) available in a datasource, with exact captions and types. Call this before query_datasource.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID (from list_datasources)" },
      },
      required: ["datasourceLuid"],
    },
  },
  {
    name: "query_datasource",
    description:
      "Run an analytical query against a Tableau datasource: select fields, aggregate measures, filter, sort, and get back rows.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID to query" },
        fields: {
          type: "array",
          description: "Fields to select, with optional aggregation",
          items: {
            type: "object",
            properties: {
              fieldCaption: { type: "string" },
              function: { type: "string", enum: ["SUM", "AVG", "COUNT", "COUNTD", "MIN", "MAX", "MEDIAN"] },
              sortDirection: { type: "string", enum: ["ASC", "DESC"] },
            },
            required: ["fieldCaption"],
          },
        },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fieldCaption: { type: "string" },
              filterType: {
                type: "string",
                enum: ["SET", "QUANTITATIVE_DATE", "QUANTITATIVE_NUMERICAL", "DATE_RANGE"],
              },
              values: { type: "array", items: { type: ["string", "number"] } },
              min: { type: ["string", "number"] },
              max: { type: ["string", "number"] },
              exclude: { type: "boolean" },
            },
            required: ["fieldCaption", "filterType"],
          },
        },
        limit: { type: "integer", minimum: 1, maximum: 10000 },
      },
      required: ["datasourceLuid", "fields"],
    },
  },
  {
    name: "get_field_values",
    description: "Get distinct sample values for a dimension field, useful before building filters.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string" },
        fieldCaption: { type: "string", description: "Exact field caption, e.g. 'Region'" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
      },
      required: ["datasourceLuid", "fieldCaption"],
    },
  },
] as const;

// ---- Zod validators (defense-in-depth on top of the JSON schema above) ----

/** Parses a value back into real JSON if the model handed us a stringified array/object instead. */
function parseIfJsonString(val: unknown): unknown {
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val);
  } catch {
    return val; // let the schema below produce a clear validation error instead
  }
}

const schemas = {
  // z.coerce.number() (not z.number()) because models — especially
  // small/free-tier ones — routinely emit numeric tool arguments as JSON
  // strings (e.g. {"limit": "100"}). z.number() rejects that outright,
  // costing a full wasted round trip while the model self-corrects.
  list_datasources: z.object({
    nameFilter: z.string().optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: clampedLimit(500, 100),
  }),
  list_workbook_datasources: z.object({ workbookId: z.string() }),
  get_datasource_metadata: z.object({ datasourceLuid: z.string() }),
  // Models — especially small/free-tier ones — sometimes JSON.stringify an
  // array/object argument instead of emitting real nested JSON (e.g.
  // {"filters": "[{\"fieldCaption\":...}]"} instead of an actual array).
  // z.preprocess parses that back into real JSON before validation runs, the
  // same fix already applied to numeric args via z.coerce.number().
  query_datasource: z.object({
    datasourceLuid: z.string(),
    fields: z.preprocess(
      parseIfJsonString,
      z
        .array(
          z.object({
            fieldCaption: z.string(),
            function: z.enum(["SUM", "AVG", "COUNT", "COUNTD", "MIN", "MAX", "MEDIAN"]).optional(),
            sortDirection: z.enum(["ASC", "DESC"]).optional(),
          }),
        )
        .min(1),
    ),
    filters: z.preprocess(
      parseIfJsonString,
      z
        .array(
          z.object({
            fieldCaption: z.string(),
            filterType: z.enum(["SET", "QUANTITATIVE_DATE", "QUANTITATIVE_NUMERICAL", "DATE_RANGE"]),
            values: z.array(z.union([z.string(), z.number()])).optional(),
            min: z.union([z.string(), z.number()]).optional(),
            max: z.union([z.string(), z.number()]).optional(),
            exclude: z.boolean().optional(),
          }),
        )
        .optional(),
    ),
    limit: z.coerce.number().int().min(1).optional().transform((v) => (v === undefined ? v : Math.min(v, 10000))),
  }),
  get_field_values: z.object({
    datasourceLuid: z.string(),
    fieldCaption: z.string(),
    limit: clampedLimit(500, 50),
  }),
};

// ---- Handlers ----

async function listDatasources(client: TableauClient, args: z.infer<typeof schemas.list_datasources>) {
  // Cache the full datasource list (changes rarely) keyed by userId for per-tenant isolation
  const userId = client.getUserId();
  let all = await cacheGet<any[]>("ds_list", `all_${userId}`);
  if (!all) {
    all = await client.restRequestAllPages<any>("/sites/{siteId}/datasources", (page) => {
      const list = page?.datasources?.datasource ?? [];
      return Array.isArray(list) ? list : [list];
    });
    await cacheSet("ds_list", `all_${userId}`, all);
  }
  const filtered = args.nameFilter
    ? all.filter((ds) => ds.name?.toLowerCase().includes(args.nameFilter!.toLowerCase()))
    : all;
  // Report the authoritative total explicitly rather than making the model
  // count array entries itself — with dozens+ of items (especially on a
  // smaller/free-tier model with a limited context window), models reliably
  // miscount or silently work from a truncated view of a bare array. Also
  // paginate: a large site can return enough datasources to blow the
  // model's context window in a single unpaginated call.
  const page = filtered.slice(args.offset, args.offset + args.limit);
  return {
    total: filtered.length,
    hasMore: args.offset + page.length < filtered.length,
    offset: args.offset,
    datasources: page.map((ds: any) => ({
      id: ds.id,
      name: ds.name,
      project: ds.project?.name,
      owner: ds.owner?.name,
      isCertified: ds.isCertified,
      hasExtracts: ds.hasExtracts,
    })),
  };
}

async function listWorkbookDatasources(client: TableauClient, args: z.infer<typeof schemas.list_workbook_datasources>) {
  const data = await client.restRequest<any>("GET", `/sites/{siteId}/workbooks/${args.workbookId}/connections`);
  const raw = data?.connections?.connection ?? [];
  const connections = Array.isArray(raw) ? raw : [raw];
  return {
    datasources: connections.map((c: any) => ({
      // Only present when this connection is to a published (not embedded/
      // live-only) datasource — that's the only kind get_datasource_metadata
      // (Metadata API) and query_datasource (VizQL Data Service) can reach.
      datasourceLuid: c.datasource?.id ?? null,
      datasourceName: c.datasource?.name ?? null,
      connectionType: c.type,
      serverAddress: c.serverAddress,
      queryable: Boolean(c.datasource?.id),
    })),
    note: "Only entries with queryable: true have a datasourceLuid usable with get_datasource_metadata/query_datasource — the rest are embedded or live connections not reachable that way. Never invent a datasourceLuid; if none here are queryable, say so plainly.",
  };
}

const FIELDS_QUERY = `
query GetDatasourceFields($luid: String!) {
  publishedDatasources(filter: { luid: $luid }) {
    name
    fields {
      name
      description
      ... on ColumnField { dataType role }
      ... on CalculatedField { dataType role formula }
    }
  }
}`;

async function getDatasourceMetadata(
  client: TableauClient,
  args: z.infer<typeof schemas.get_datasource_metadata>,
) {
  // Metadata rarely changes (only on republish) — cache for 30 min
  const cacheId = `luid_${args.datasourceLuid}`;
  const cached = await cacheGet<any>("ds_metadata", cacheId);
  if (cached) return cached;

  const data = await client.metadataQuery<any>(FIELDS_QUERY, { luid: args.datasourceLuid });
  const ds = data?.publishedDatasources?.[0];
  if (!ds) {
    return { error: `Datasource ${args.datasourceLuid} not found or not accessible.` };
  }
  const result = {
    name: ds.name,
    fields: (ds.fields ?? []).map((f: any) => ({
      name: f.name,
      kind: f.role === "measure" ? "measure" : "dimension",
      dataType: f.dataType,
      formula: f.formula,
    })),
  };
  await cacheSet("ds_metadata", cacheId, result);
  return result;
}

async function queryDatasource(client: TableauClient, args: z.infer<typeof schemas.query_datasource>) {
  const body: any = {
    datasource: { datasourceLuid: args.datasourceLuid },
    query: {
      fields: args.fields.map((f) => ({
        fieldCaption: f.fieldCaption,
        ...(f.function ? { function: f.function } : {}),
        ...(f.sortDirection ? { sortDirection: f.sortDirection, sortPriority: 1 } : {}),
      })),
      ...(args.filters?.length
        ? {
            filters: args.filters.map((f) => ({
              field: { fieldCaption: f.fieldCaption },
              filterType: f.filterType,
              ...(f.values ? { values: f.values } : {}),
              ...(f.min !== undefined ? { min: f.min } : {}),
              ...(f.max !== undefined ? { max: f.max } : {}),
              ...(f.exclude !== undefined ? { exclude: f.exclude } : {}),
            })),
          }
        : {}),
    },
    options: { returnFormat: "OBJECTS", ...(args.limit ? { rowLimit: args.limit } : {}) },
  };
  const data = await client.vdsRequest<any>("/query-datasource", body);
  const rows: any[] = data?.data ?? [];
  return { rowCount: rows.length, rows: rows.slice(0, 200) };
}

async function getFieldValues(client: TableauClient, args: z.infer<typeof schemas.get_field_values>) {
  const body = {
    datasource: { datasourceLuid: args.datasourceLuid },
    query: { fields: [{ fieldCaption: args.fieldCaption }] },
    options: { returnFormat: "OBJECTS" },
  };
  const data = await client.vdsRequest<any>("/query-datasource", body);
  const rows: any[] = data?.data ?? [];
  const values = Array.from(new Set(rows.map((r) => r[args.fieldCaption]))).slice(0, args.limit);
  return { field: args.fieldCaption, values };
}

export const datasourceHandlers: Record<string, (client: TableauClient, args: any) => Promise<any>> = {
  list_datasources: (c, a) => listDatasources(c, schemas.list_datasources.parse(a ?? {})),
  list_workbook_datasources: (c, a) => listWorkbookDatasources(c, schemas.list_workbook_datasources.parse(a ?? {})),
  get_datasource_metadata: (c, a) => getDatasourceMetadata(c, schemas.get_datasource_metadata.parse(a ?? {})),
  query_datasource: (c, a) => queryDatasource(c, schemas.query_datasource.parse(a ?? {})),
  get_field_values: (c, a) => getFieldValues(c, schemas.get_field_values.parse(a ?? {})),
};
