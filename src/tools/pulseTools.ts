import { z } from "zod";
import { TableauClient } from "../tableau/client.js";

export const AGGREGATION_MAP: Record<string, "SUM" | "AVG" | "COUNT" | "MIN" | "MAX" | "MEDIAN"> = {
  AGGREGATION_SUM: "SUM",
  AGGREGATION_AVERAGE: "AVG",
  AGGREGATION_COUNT: "COUNT",
  AGGREGATION_MIN: "MIN",
  AGGREGATION_MAX: "MAX",
  AGGREGATION_MEDIAN: "MEDIAN",
};

// ---- Tool definitions ----

export const pulseToolDefinitions = [
  {
    name: "list_pulse_metrics",
    description:
      "List Tableau Pulse metric definitions on the site (requires Pulse to be enabled for the site), optionally filtered by name. Result includes an authoritative `count` field.",
    input_schema: {
      type: "object",
      properties: {
        nameFilter: { type: "string", description: "Optional substring to filter metric names" },
      },
    },
  },
  {
    name: "get_pulse_metric_insight",
    description: "Get the current value of a specific Pulse metric definition.",
    input_schema: {
      type: "object",
      properties: {
        definitionId: { type: "string", description: "Pulse metric definition id (from list_pulse_metrics)" },
      },
      required: ["definitionId"],
    },
  },
] as const;

// ---- Zod validators ----

const schemas = {
  list_pulse_metrics: z.object({ nameFilter: z.string().optional() }),
  get_pulse_metric_insight: z.object({ definitionId: z.string() }),
};

// ---- Shared Pulse helpers (reused by semanticTools and analyticalTools) ----

/** Fetches a Pulse definition by id, normalising the response wrapper. */
export async function fetchPulseDefinition(client: TableauClient, definitionId: string): Promise<any> {
  const def = await client.restRequestUnversioned<any>("GET", `/api/-/pulse/definitions/${definitionId}`);
  return def?.definition ?? def;
}

export interface PulseSpec {
  name: string;
  measureField: string | null;
  aggregation: string | null;
  aggregationMapped: "SUM" | "AVG" | "COUNT" | "MIN" | "MAX" | "MEDIAN";
  datasourceLuid: string | null;
  timeDimensionField: string | null;
  granularity: string | null;
  filter: any;
  isBasic: boolean;
}

/** Extracts a normalised basic_specification from a raw Pulse definition. */
export function resolvePulseSpec(definition: any): PulseSpec {
  const name = definition?.metadata?.name ?? definition?.id ?? null;
  const spec = definition?.specification;
  const basic = spec?.basic_specification;
  const measure = basic?.measure;
  const timeDimension = basic?.time_dimension ?? basic?.timeDimension;
  const mapped = (AGGREGATION_MAP[measure?.aggregation] ?? "SUM") as PulseSpec["aggregationMapped"];
  return {
    name,
    measureField: measure?.field ?? null,
    aggregation: measure?.aggregation ?? null,
    aggregationMapped: mapped,
    datasourceLuid: spec?.datasource?.id ?? null,
    timeDimensionField: timeDimension?.field ?? null,
    granularity: timeDimension?.granularity ?? null,
    filter: basic?.filter ?? null,
    isBasic: Boolean(measure?.field && spec?.datasource?.id),
  };
}

// ---- Handlers ----

async function listPulseMetrics(client: TableauClient, args: z.infer<typeof schemas.list_pulse_metrics>) {
  try {
    const all: any[] = [];
    let pageToken = "";
    while (true) {
      const data = await client.restRequestUnversioned<any>(
        "GET",
        "/api/-/pulse/definitions",
        pageToken ? { params: { page_token: pageToken } } : {},
      );
      all.push(...(data?.definitions ?? []));
      pageToken = data?.next_page_token ?? "";
      if (!pageToken) break;
    }

    const filtered = args.nameFilter
      ? all.filter((d) => d.metadata?.name?.toLowerCase().includes(args.nameFilter!.toLowerCase()))
      : all;

    return {
      enabled: true,
      count: filtered.length,
      metrics: filtered.map((d: any) => ({
        id: d.metadata?.id,
        name: d.metadata?.name,
        measureField: d.specification?.basic_specification?.measure?.field ?? null,
      })),
    };
  } catch (err: any) {
    if (String(err?.message).includes("404")) {
      return { enabled: false, count: 0, metrics: [], note: "Pulse is not enabled on this site, or this API version doesn't support it." };
    }
    throw err;
  }
}

async function getPulseMetricInsight(client: TableauClient, args: z.infer<typeof schemas.get_pulse_metric_insight>) {
  const definition = await fetchPulseDefinition(client, args.definitionId);
  const spec = resolvePulseSpec(definition);
  const { name, measureField, aggregationMapped, datasourceLuid } = spec;

  if (!measureField || !datasourceLuid) {
    return {
      name,
      value: null,
      note: "This is a custom visualization-based Pulse metric (no basic aggregation spec), so its current value can't be read directly by this tool.",
    };
  }

  // Pulse stores the field's internal name, which can differ from the
  // caption VDS expects — resolve the real caption via the Metadata API first.
  const metaData = await client.metadataQuery<any>(
    `query GetFields($luid: String!) { publishedDatasources(filter: { luid: $luid }) { fields { name } } }`,
    { luid: datasourceLuid },
  );
  const fieldNames: string[] = metaData?.publishedDatasources?.[0]?.fields?.map((f: any) => f.name) ?? [];
  const normalize = (s: string) => s.toLowerCase().replace(/[\s_]/g, "");
  const fieldCaption = fieldNames.find((n) => normalize(n) === normalize(measureField)) ?? measureField;

  const data = await client.vdsRequest<any>("/query-datasource", {
    datasource: { datasourceLuid },
    query: { fields: [{ fieldCaption, function: aggregationMapped }] },
  });

  const row = data?.data?.[0] ?? {};
  const key = Object.keys(row)[0];
  const value = key ? row[key] : undefined;

  return { name, value: value ?? null, note: value === undefined ? "No value returned for this metric." : undefined };
}

// ---- Registry ----

export const pulseHandlers: Record<string, (client: TableauClient, args: any) => Promise<any>> = {
  list_pulse_metrics: (c, a) => listPulseMetrics(c, schemas.list_pulse_metrics.parse(a ?? {})),
  get_pulse_metric_insight: (c, a) => getPulseMetricInsight(c, schemas.get_pulse_metric_insight.parse(a ?? {})),
};
