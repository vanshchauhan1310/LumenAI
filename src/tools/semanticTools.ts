import { z } from "zod";
import { TableauClient } from "../tableau/client.js";
import { clampedLimit } from "../lib/zodHelpers.js";
import { fetchPulseDefinition, resolvePulseSpec } from "./pulseTools.js";

/**
 * The "semantic layer" — tools that give the model meaning about the site's
 * content rather than more raw rows: a field glossary, where fields are used,
 * what a Pulse metric actually measures, computed dashboard stats, and
 * chart-type advice. All read-only. Registry wiring in index.ts.
 */

// ---- Tool definitions ----

export const semanticToolDefinitions = [
  {
    name: "get_datasource_glossary",
    description:
      "Get a business glossary of a datasource: every field with its exact caption, type, role (dimension/measure), any stored description, and formula for calculated fields. Call this to learn what a field MEANS (e.g. is 'Profit' a calculated field, and how) before building a query_datasource.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID (from list_datasources or list_workbook_datasources)" },
      },
      required: ["datasourceLuid"],
    },
  },
  {
    name: "get_field_usage",
    description:
      "Find which published sheets/workbooks actually use a field (or every field) in a datasource. Useful to answer 'where is this metric/dimension used on my site' or to locate the dashboard(s) that surface a given number.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID (from list_datasources or list_workbook_datasources)" },
        fieldName: { type: "string", description: "Optional exact field caption to filter to one field; omit to get usage for every field" },
      },
      required: ["datasourceLuid"],
    },
  },
  {
    name: "get_metric_definition",
    description:
      "Resolve what a Tableau Pulse metric actually measures: its formula (e.g. 'SUM(Revenue)'), the underlying measure field, aggregation, time dimension/granularity, filter, and source datasource. Call this when the user asks what a metric IS, how it's calculated, or what 'the Revenue metric' means on this site.",
    input_schema: {
      type: "object",
      properties: {
        definitionId: { type: "string", description: "Pulse metric definition id (from list_pulse_metrics)" },
      },
      required: ["definitionId"],
    },
  },
  {
    name: "get_dashboard_insights",
    description:
      "Compute summary statistics from a dashboard's underlying data in ONE call: for each column, whether it's numeric, its min/max/avg/sum, distinct count, and the most frequent values. Call this for 'what does this dashboard show / what stands out' instead of dumping raw get_view_data rows and reasoning over them yourself.",
    input_schema: {
      type: "object",
      properties: {
        viewId: { type: "string", description: "View id (from list_workbook_views or list_site_views)" },
        maxLines: { type: "integer", minimum: 1, maximum: 1000, default: 200, description: "Max data rows to analyze (beyond this, stats are computed over the first maxLines rows only and `truncated` is set)" },
      },
      required: ["viewId"],
    },
  },
  {
    name: "recommend_visualization",
    description:
      "Pure-logic chart recommendation (no data is fetched): given the fields the user wants to visualize and their roles/types, recommend a chart type (bar, line, pie, scatter, map, histogram, table) with reasoning and a suggested aggregation. Call this when the user asks 'how should I visualize X' or 'what chart type makes sense for these fields', then follow up with query_datasource to get the data.",
    input_schema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          description: "The fields to visualize, with their role and type",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Field caption, e.g. 'Revenue'" },
              role: { type: "string", enum: ["dimension", "measure"], description: "dimension = categorical/date field, measure = numeric field being aggregated" },
              dataType: { type: "string", enum: ["string", "number", "date", "datetime", "boolean", "geospatial"], description: "Field data type" },
            },
            required: ["name", "role"],
          },
        },
        intent: {
          type: "string",
          enum: ["trend", "comparison", "proportion", "correlation", "distribution", "geographic", "ranking"],
          description: "Optional analytical intent inferred from the user's question",
        },
      },
      required: ["fields"],
    },
  },
] as const;

// ---- Zod validators ----

/** Parses a value back into real JSON if the model handed us a stringified array/object instead. */
function parseIfJsonString(val: unknown): unknown {
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

const fieldSchema = z.object({
  name: z.string(),
  role: z.enum(["dimension", "measure"]),
  dataType: z.enum(["string", "number", "date", "datetime", "boolean", "geospatial"]).optional(),
});

const schemas = {
  get_datasource_glossary: z.object({ datasourceLuid: z.string() }),
  get_field_usage: z.object({ datasourceLuid: z.string(), fieldName: z.string().optional() }),
  get_metric_definition: z.object({ definitionId: z.string() }),
  get_dashboard_insights: z.object({
    viewId: z.string(),
    maxLines: clampedLimit(1000, 200),
  }),
  recommend_visualization: z.object({
    fields: z.preprocess(parseIfJsonString, z.array(fieldSchema).min(1)),
    intent: z.enum(["trend", "comparison", "proportion", "correlation", "distribution", "geographic", "ranking"]).optional(),
  }),
};

// ---- Helpers ----

const GLOSSARY_QUERY = `
query GetDatasourceGlossary($luid: String!) {
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

const FIELD_USAGE_QUERY = `
query GetFieldUsage($luid: String!) {
  publishedDatasources(filter: { luid: $luid }) {
    name
    fields {
      name
      downstreamSheets {
        name
        workbook { name }
      }
    }
  }
}`;

// Hand-rolled CSV splitter sufficient for Tableau's view-data exports, which
// are simple comma-separated text with optional double-quoted fields. The
// exported text is always small (bounded by the endpoint's own limits), so a
// pragmatic parser is fine here.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

function looksNumeric(value: string): boolean {
  return value.trim() !== "" && !Number.isNaN(Number(value));
}

// ---- Handlers ----

async function getDatasourceGlossary(client: TableauClient, args: z.infer<typeof schemas.get_datasource_glossary>) {
  const data = await client.metadataQuery<any>(GLOSSARY_QUERY, { luid: args.datasourceLuid });
  const ds = data?.publishedDatasources?.[0];
  if (!ds) {
    return { error: `Datasource ${args.datasourceLuid} not found or not accessible.` };
  }
  return {
    name: ds.name,
    fieldCount: (ds.fields ?? []).length,
    fields: (ds.fields ?? []).map((f: any) => ({
      name: f.name,
      kind: f.role === "measure" ? "measure" : "dimension",
      dataType: f.dataType ?? null,
      description: f.description ?? null,
      formula: f.formula ?? null,
    })),
  };
}

async function getFieldUsage(client: TableauClient, args: z.infer<typeof schemas.get_field_usage>) {
  const data = await client.metadataQuery<any>(FIELD_USAGE_QUERY, { luid: args.datasourceLuid });
  const ds = data?.publishedDatasources?.[0];
  if (!ds) {
    return { error: `Datasource ${args.datasourceLuid} not found or not accessible.` };
  }

  const allFields: any[] = ds.fields ?? [];
  const filter = args.fieldName?.toLowerCase();
  const fields = filter ? allFields.filter((f) => f.name?.toLowerCase() === filter) : allFields;

  return {
    datasourceName: ds.name,
    fieldCount: fields.length,
    fields: fields.map((f: any) => {
      const sheetsRaw = f.downstreamSheets ?? [];
      const sheets = Array.isArray(sheetsRaw) ? sheetsRaw : [sheetsRaw];
      return {
        name: f.name,
        usedInSheetCount: sheets.length,
        usedIn: sheets.map((s: any) => ({
          sheetName: s.name,
          workbookName: s.workbook?.name ?? null,
        })),
      };
    }),
    note: "Empty usedIn lists mean the field is not referenced by any published view the Metadata API can see (e.g. unused fields, or usage the API doesn't index).",
  };
}

async function getMetricDefinition(client: TableauClient, args: z.infer<typeof schemas.get_metric_definition>) {
  const definition = await fetchPulseDefinition(client, args.definitionId);
  const spec = resolvePulseSpec(definition);
  const { name, measureField, aggregation, aggregationMapped, datasourceLuid, timeDimensionField, granularity, filter, isBasic } = spec;

  if (!isBasic) {
    return {
      name,
      formula: null,
      note: "This is a custom visualization-based Pulse metric (no basic aggregation spec), so its formula can't be resolved directly.",
    };
  }

  return {
    name,
    formula: `${aggregationMapped}(${measureField})`,
    measureField,
    aggregation,
    aggregationMapped,
    datasourceLuid,
    timeDimensionField,
    granularity,
    filter,
  };
}

const round = (n: number, digits = 2) => {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
};

async function getDashboardInsights(client: TableauClient, args: z.infer<typeof schemas.get_dashboard_insights>) {
  const csv = await client.restRequest<string>("GET", `/sites/{siteId}/views/${args.viewId}/data`);
  const text = typeof csv === "string" ? csv : String(csv);
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { viewId: args.viewId, rowCount: 0, columns: [], note: "No data returned for this view." };
  }

  const header = rows[0];
  const dataRows = rows.slice(1);
  const truncated = dataRows.length > args.maxLines;
  const analyzed = dataRows.slice(0, args.maxLines);

  const columns = header.map((name, colIdx) => {
    const values = analyzed.map((r) => r[colIdx] ?? "").filter((v) => v !== "");
    const numericValues = values.filter(looksNumeric).map(Number);
    const isNumeric = numericValues.length > 0 && numericValues.length / Math.max(1, values.length) >= 0.8;

    if (isNumeric) {
      const sum = numericValues.reduce((a, b) => a + b, 0);
      return {
        name,
        type: "numeric",
        nonEmpty: values.length,
        min: round(Math.min(...numericValues)),
        max: round(Math.max(...numericValues)),
        avg: round(sum / numericValues.length),
        sum: round(sum),
        distinct: new Set(values).size,
      };
    }

    const freq = new Map<string, number>();
    for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return {
      name,
      type: "categorical",
      nonEmpty: values.length,
      distinct: freq.size,
      topValues: top.map(([value, count]) => ({ value, count })),
    };
  });

  return {
    viewId: args.viewId,
    rowCount: analyzed.length,
    truncated,
    note: truncated
      ? `Analyzed the first ${args.maxLines} rows only (the view has more). Narrow with filters or use get_view_data for the full export.`
      : undefined,
    columns,
  };
}

// Pure heuristic chart recommendation — no API calls, deterministic, unit-tested.
// Exported for the tests.
export function recommendVisualization(
  args: z.infer<typeof schemas.recommend_visualization>,
): {
  recommendedChart: string;
  intent: string | null;
  reasoning: string;
  suggestedAggregation: string | null;
  chartsToAvoid: string[];
} {
  const { fields, intent } = args;
  const dimensions = fields.filter((f) => f.role === "dimension");
  const measures = fields.filter((f) => f.role === "measure");
  const geoDimension = dimensions.find(
    (d) => d.dataType === "geospatial" || /country|region|state|city|zip|postal|geo|latitude|longitude/i.test(d.name),
  );
  const dateDimension = dimensions.find(
    (d) => d.dataType === "date" || d.dataType === "datetime" || /date|month|year|quarter|week|day|period|time/i.test(d.name),
  );

  const chartsToAvoid: string[] = [];
  let recommendedChart = "table";
  let reasoning = "";
  let suggestedAggregation: string | null = null;

  if (measures.length === 0) {
    recommendedChart = "table";
    reasoning = "No measure (numeric) field selected — without an aggregated number, only a table/crosstab of the dimensions makes sense.";
  } else if (geoDimension) {
    recommendedChart = "map";
    reasoning = `A geographic dimension (${geoDimension.name}) with ${measures.length} measure(s) maps well — e.g. shaded/bubble map by ${measures[0].name}.`;
    suggestedAggregation = "SUM";
    chartsToAvoid.push("pie", "scatter");
  } else if (dateDimension && (intent === "trend" || dimensions.length === 1 || intent === "distribution")) {
    recommendedChart = "line";
    reasoning = `A time dimension (${dateDimension.name}) with ${measures[0].name} reads best as a line/area chart to show the trend over time.`;
    suggestedAggregation = measures[0].name && intent !== "distribution" ? "SUM" : null;
    chartsToAvoid.push("pie");
  } else if (intent === "proportion" && dimensions.length === 1) {
    recommendedChart = "pie";
    reasoning = `A single dimension (${dimensions[0].name}) broken down by ${measures[0].name} is a natural proportion/slice-of-the-whole view.`;
    suggestedAggregation = "SUM";
    chartsToAvoid.push("scatter");
  } else if (intent === "correlation" && measures.length >= 2) {
    recommendedChart = "scatter";
    reasoning = `Two or more measures (${measures.map((m) => m.name).join(", ")}) with no meaningful category — a scatter plot shows their relationship directly.`;
    suggestedAggregation = "SUM";
    chartsToAvoid.push("pie");
  } else if (intent === "ranking" || (dimensions.length === 1 && intent !== "comparison" && measures.length >= 1)) {
    recommendedChart = "bar";
    reasoning = `${dimensions[0].name} vs ${measures[0].name} — a bar chart makes the ranking/comparison between categories immediately readable.`;
    suggestedAggregation = "SUM";
    chartsToAvoid.push("scatter");
  } else if (measures.length >= 1 && dimensions.length === 0) {
    recommendedChart = "bar";
    reasoning = `One or more measures (${measures.map((m) => m.name).join(", ")}) with no dimension — a bar chart of the totals, or a scatter if you want to compare them against each other.`;
    suggestedAggregation = "SUM";
  } else {
    recommendedChart = "bar";
    reasoning = `${dimensions[0]?.name ?? "The dimension"} broken down by ${measures[0].name} is clearest as a bar chart; add intent=proportion/trend/correlation for a more specific recommendation.`;
    suggestedAggregation = "SUM";
  }

  return { recommendedChart, intent: intent ?? null, reasoning, suggestedAggregation, chartsToAvoid };
}

// ---- Registry ----

export const semanticHandlers: Record<string, (client: TableauClient, args: any) => Promise<any>> = {
  get_datasource_glossary: (c, a) => getDatasourceGlossary(c, schemas.get_datasource_glossary.parse(a ?? {})),
  get_field_usage: (c, a) => getFieldUsage(c, schemas.get_field_usage.parse(a ?? {})),
  get_metric_definition: (c, a) => getMetricDefinition(c, schemas.get_metric_definition.parse(a ?? {})),
  get_dashboard_insights: (c, a) => getDashboardInsights(c, schemas.get_dashboard_insights.parse(a ?? {})),
  recommend_visualization: (_c, a) => Promise.resolve(recommendVisualization(schemas.recommend_visualization.parse(a ?? {}))),
};
