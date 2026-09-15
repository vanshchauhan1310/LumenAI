import { z } from "zod";
import { TableauClient } from "../tableau/client.js";
import { clampedLimit } from "../lib/zodHelpers.js";
import {
  buildDateFilter,
  buildPivotMatrix,
  correlationLabel,
  detectAnomalies,
  diffAcrossPeriods,
  extractNumericValue,
  forecastLinear,
  histogram,
  pearson,
  percentile,
  rankSeries,
  readNumericCell,
  shareOfTotal,
  spearman,
} from "../lib/analytics.js";
import { fetchPulseDefinition, resolvePulseSpec } from "./pulseTools.js";

/**
 * Tier-1 analytical depth tools — the "multibillion-dollar" workhorse layer.
 * Everything here composes the existing query_datasource / Metadata / Pulse
 * primitives with pure math from src/lib/analytics.ts:
 *
 *   compare_periods        diff two date windows (overall + per-dimension)
 *   explain_change         compare_periods + top "drivers" of the change
 *   anomaly_detection      z-score outliers in a bucketed time series
 *   forecast_metric        least-squares linear forecast + confidence band
 *   get_metric_history     a Pulse metric's value over time (from its spec)
 *   get_data_quality_warnings  data-quality warnings on a datasource
 *   get_field_lineage      a field's upstream columns + downstream sheets
 *   search_fields          site-wide field-name search (Metadata API)
 *   cross_datasource_query one measure across several datasources, merged
 *   rank_categories        top/bottom N members by measure, with % of total
 *   pivot_cross_tab        rows x columns cross-tab for a measure
 *   rollup_time_series     aggregate a metric to day/week/month/quarter grain
 *   correlation_analysis   Pearson/Spearman between two measures
 *   field_statistics       min/max/avg/median + sampled null%/cardinality/percentiles
 *   bucketize_metric       client-side histogram bins for a measure
 *   share_of_total         each member's share + cumulative %, delta vs baseline
 *   get_summary_table      one-call insights digest (total/avg/trend/top member)
 *
 * All read-only. Registry wiring in index.ts; scoping in lib/scope.ts.
 */

// ---- Tool definitions ----

const AGGREGATION_ENUM = ["SUM", "AVG", "COUNT", "MIN", "MAX", "MEDIAN"] as const;
const GRANULARITY_ENUM = ["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"] as const;

export const analyticalToolDefinitions = [
  {
    name: "compare_periods",
    description:
      "Compare one measure between two date windows (current vs previous period) — overall total and per-dimension change with % change and contribution. Call this for 'how did X compare this month vs last', 'vs same period last year', 'MoM/QoQ/YoY'. Returns both an `overall` row and `segments` sorted by absolute change.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID (from list_datasources or list_workbook_datasources)" },
        measure: { type: "string", description: "Measure field caption, e.g. 'Revenue' (see get_datasource_glossary for exact captions)" },
        dateField: { type: "string", description: "Date field caption used for the period windows, e.g. 'Order Date'" },
        currentStart: { type: "string", description: "Current period start, ISO date YYYY-MM-DD (inclusive)" },
        currentEnd: { type: "string", description: "Current period end, ISO date YYYY-MM-DD (inclusive)" },
        previousStart: { type: "string", description: "Previous period start, ISO date YYYY-MM-DD (inclusive)" },
        previousEnd: { type: "string", description: "Previous period end, ISO date YYYY-MM-DD (inclusive)" },
        dimension: { type: "string", description: "Optional dimension field caption to break the comparison down by (e.g. 'Region', 'Product')" },
        aggregation: { type: "string", enum: [...AGGREGATION_ENUM], default: "SUM", description: "Aggregation to apply to the measure" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Max segments to return (sorted by absolute change, most moved first)" },
      },
      required: ["datasourceLuid", "measure", "dateField", "currentStart", "currentEnd", "previousStart", "previousEnd"],
    },
  },
  {
    name: "explain_change",
    description:
      "Explain WHY a metric changed between two periods: like compare_periods, but adds a `drivers` list ranking each dimension value by its contribution to the overall change (share of total absolute movement) with an up/down direction. Call this for 'why did revenue go up/down?', 'what drove the change in X?'. Needs a `dimension` to attribute the change to.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        measure: { type: "string", description: "Measure field caption being explained" },
        dateField: { type: "string", description: "Date field caption used for the period windows" },
        currentStart: { type: "string", description: "Current period start, ISO date YYYY-MM-DD (inclusive)" },
        currentEnd: { type: "string", description: "Current period end, ISO date YYYY-MM-DD (inclusive)" },
        previousStart: { type: "string", description: "Previous period start, ISO date YYYY-MM-DD (inclusive)" },
        previousEnd: { type: "string", description: "Previous period end, ISO date YYYY-MM-DD (inclusive)" },
        dimension: { type: "string", description: "Dimension field caption to attribute the change to (e.g. 'Region', 'Product Category')" },
        aggregation: { type: "string", enum: [...AGGREGATION_ENUM], default: "SUM", description: "Aggregation to apply to the measure" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Max driver segments to return" },
      },
      required: ["datasourceLuid", "measure", "dateField", "currentStart", "currentEnd", "previousStart", "previousEnd", "dimension"],
    },
  },
  {
    name: "anomaly_detection",
    description:
      "Detect unusual spikes/dips in a measure over time using z-scores (|z| > threshold = anomaly). Buckets the date range by granularity (day/week/month/quarter/year). Call this for 'were there any abnormal days/months for X', 'when did X spike'. Returns the flagged points with z-scores and deviations.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        measure: { type: "string", description: "Measure field caption to scan" },
        dateField: { type: "string", description: "Date field caption to bucket over time" },
        start: { type: "string", description: "Range start, ISO date YYYY-MM-DD (inclusive)" },
        end: { type: "string", description: "Range end, ISO date YYYY-MM-DD (inclusive)" },
        granularity: { type: "string", enum: [...GRANULARITY_ENUM], default: "MONTH", description: "Time bucket size" },
        dimension: { type: "string", description: "Optional dimension to segment — anomalies are detected separately per segment" },
        aggregation: { type: "string", enum: [...AGGREGATION_ENUM], default: "SUM", description: "Aggregation to apply to the measure" },
        threshold: { type: "number", default: 2.5, description: "Z-score threshold; higher = fewer, more confident anomalies (2.5 is the default)" },
      },
      required: ["datasourceLuid", "measure", "dateField", "start", "end"],
    },
  },
  {
    name: "forecast_metric",
    description:
      "Forecast a measure forward from historical time buckets using a least-squares linear trend, with a ±1 residual-stddev confidence band. Call this for 'predict next quarter's X', 'where is X trending'. The forecast is a simple statistical estimate (not a tuned product) — say so when you present it. Returns historical + forecast points with lower/upper bounds.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        measure: { type: "string", description: "Measure field caption to forecast" },
        dateField: { type: "string", description: "Date field caption for the historical series" },
        start: { type: "string", description: "History start, ISO date YYYY-MM-DD (inclusive)" },
        end: { type: "string", description: "History end, ISO date YYYY-MM-DD (inclusive)" },
        periods: { type: "integer", minimum: 1, maximum: 12, default: 6, description: "Number of future buckets to project" },
        granularity: { type: "string", enum: [...GRANULARITY_ENUM], default: "MONTH", description: "Time bucket size (must match how you bucket the history)" },
        aggregation: { type: "string", enum: [...AGGREGATION_ENUM], default: "SUM", description: "Aggregation to apply to the measure" },
      },
      required: ["datasourceLuid", "measure", "dateField", "start", "end"],
    },
  },
  {
    name: "get_metric_history",
    description:
      "A Pulse metric's value over time, resolved from its own definition (measure, aggregation, time dimension/granularity, source datasource). Call this for 'show me the trend/history of <Pulse metric>'. Granularity defaults to the metric's own; you may override the range. Unlike get_pulse_metric_insight (single current value) this returns a full series.",
    input_schema: {
      type: "object",
      properties: {
        definitionId: { type: "string", description: "Pulse metric definition id (from list_pulse_metrics)" },
        start: { type: "string", description: "Optional range start, ISO date YYYY-MM-DD; defaults to the last ~12 buckets" },
        end: { type: "string", description: "Optional range end, ISO date YYYY-MM-DD; defaults to today" },
        granularity: { type: "string", enum: [...GRANULARITY_ENUM], description: "Optional override for the metric's own time granularity" },
      },
      required: ["definitionId"],
    },
  },
  {
    name: "get_data_quality_warnings",
    description:
      "Return Tableau's data-quality warnings on a datasource and its fields (e.g. data is stale, inconsistent, deprecated). Call this when the user asks 'can I trust this data', 'is this datasource stale/broken'. Includes a summary health check.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
      },
      required: ["datasourceLuid"],
    },
  },
  {
    name: "get_field_lineage",
    description:
      "Trace a field's lineage within a datasource: its upstream source columns (for calculated fields) and every downstream sheet that uses it. Call this for 'where does this field come from', 'what feeds this metric', 'what uses this field downstream'. Deeper than get_field_usage, which only lists downstream usage.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        fieldName: { type: "string", description: "Optional exact field caption to trace; omit for all fields" },
      },
      required: ["datasourceLuid"],
    },
  },
  {
    name: "search_fields",
    description:
      "Search every field across the whole site by name (Metadata API searchFields). Call this when the user references a field by name you haven't seen yet ('the profit margin field') — find its real caption, type, role and owning datasource. Returns the best-matching fields; follow up with get_datasource_metadata/query_datasource on the owning datasourceLuid.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Field name substring to search, e.g. 'profit'" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25, description: "Max results to return" },
        role: { type: "string", enum: ["dimension", "measure"], description: "Optional filter by field role" },
      },
      required: ["query"],
    },
  },
  {
    name: "cross_datasource_query",
    description:
      "Query the SAME measure across several datasources and merge the results (e.g. 'compare Revenue in sales vs marketing'). Runs one VDS query per datasource and returns each datasource's rows + a grand total, with per-datasource totals you can rank. Kept to a handful of datasources at a time.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuids: {
          type: "array",
          description: "2-5 datasource LUIDS to query",
          items: { type: "string" },
        },
        measure: { type: "string", description: "Measure field caption present in each datasource" },
        aggregation: { type: "string", enum: [...AGGREGATION_ENUM], default: "SUM", description: "Aggregation to apply to the measure" },
        dimension: { type: "string", description: "Optional dimension field caption (must exist in each datasource) to break results down by" },
        filters: {
          type: "array",
          description: "Optional filters applied to every datasource query",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "Field caption to filter on" },
              filterType: { type: "string", enum: ["QUANTITATIVE_DATE", "EQUAL", "IN_LIST"], description: "Filter type" },
              min: { type: "string", description: "For QUANTITATIVE_DATE: range start (ISO date)" },
              max: { type: "string", description: "For QUANTITATIVE_DATE: range end (ISO date)" },
              value: { type: "string", description: "For EQUAL: the value to match" },
              values: { type: "array", items: { type: "string" }, description: "For IN_LIST: values to match" },
            },
            required: ["field", "filterType"],
          },
        },
      },
      required: ["datasourceLuids", "measure"],
    },
  },
  {
    name: "rank_categories",
    description:
      "Rank a dimension's members by a measure and return top/bottom N with each member's share of the total (%) and the running cumulative share. Call this for 'top 10 products by revenue', 'which regions perform worst', 'best/worst performing X'. Sorted by the measure, with rank, pctOfTotal and cumulativePct so the model can say 'the top 3 are 62% of revenue'.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        dimension: { type: "string", description: "Dimension field caption to rank (e.g. 'Product', 'Region', 'Country')" },
        measure: { type: "string", description: "Measure field caption to rank by, e.g. 'Revenue'" },
        aggregation: { type: "string", enum: [...AGGREGATION_ENUM], default: "SUM", description: "Aggregation to apply to the measure" },
        direction: { type: "string", enum: ["top", "bottom"], default: "top", description: "Rank from the top (largest first) or bottom (smallest first)" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "How many members to return" },
        dateField: { type: "string", description: "Optional date field caption for a window filter" },
        start: { type: "string", description: "Optional window start, ISO date YYYY-MM-DD (inclusive)" },
        end: { type: "string", description: "Optional window end, ISO date YYYY-MM-DD (inclusive)" },
      },
      required: ["datasourceLuid", "dimension", "measure"],
    },
  },
  {
    name: "pivot_cross_tab",
    description:
      "Build a cross-tabulation: one dimension's members as rows, another field's values (optionally a date truncated to a granularity) as columns, with the measure aggregated in each cell plus row/column totals. Call this for 'revenue by region, one column per month', 'a matrix of X by Y'. Returns ordered `columns`, a `rows` array (rowKey, rowTotal, cells), `columnTotals` and `grandTotal`.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        measure: { type: "string", description: "Measure field caption for the cell values" },
        rowField: { type: "string", description: "Dimension field caption to use as rows (e.g. 'Region')" },
        columnField: { type: "string", description: "Field to use as columns — a dimension (e.g. 'Category') or a date field" },
        columnGranularity: { type: "string", enum: [...GRANULARITY_ENUM], description: "Required if columnField is a date field: how to bucket it into columns (e.g. MONTH, QUARTER)" },
        aggregation: { type: "string", enum: [...AGGREGATION_ENUM], default: "SUM", description: "Aggregation to apply to the measure" },
        dateField: { type: "string", description: "Optional date field caption for a window filter" },
        start: { type: "string", description: "Optional window start, ISO date YYYY-MM-DD (inclusive)" },
        end: { type: "string", description: "Optional window end, ISO date YYYY-MM-DD (inclusive)" },
      },
      required: ["datasourceLuid", "measure", "rowField", "columnField"],
    },
  },
  {
    name: "rollup_time_series",
    description:
      "Roll one measure up into a time series at a chosen granularity (day/week/month/quarter/year) over a date range, using VDS date truncation. Call this for 'show revenue by month', 'daily/weekly/quarterly trend of X'. Returns the bucketed series sorted chronologically plus totals. Simpler than query_datasource for pure time aggregation and always sorts the buckets.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        measure: { type: "string", description: "Measure field caption to aggregate" },
        dateField: { type: "string", description: "Date field caption to bucket over time" },
        start: { type: "string", description: "Range start, ISO date YYYY-MM-DD (inclusive)" },
        end: { type: "string", description: "Range end, ISO date YYYY-MM-DD (inclusive)" },
        granularity: { type: "string", enum: [...GRANULARITY_ENUM], default: "MONTH", description: "Time bucket size" },
        aggregation: { type: "string", enum: [...AGGREGATION_ENUM], default: "SUM", description: "Aggregation to apply to the measure" },
        dimension: { type: "string", description: "Optional dimension field caption to break the series down by (returns one series per member)" },
      },
      required: ["datasourceLuid", "measure", "dateField", "start", "end"],
    },
  },
  {
    name: "correlation_analysis",
    description:
      "Measure how two metrics move together using Pearson (linear) and Spearman (rank) correlation. Groups both measures by a dimension (or a date field truncated to a granularity) so each group is one paired point. Call this for 'do revenue and ad spend correlate', 'is higher price associated with higher profit'. Returns the coefficients, sample size, and a strength/direction label. Correlation is association, not causation — say so.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        measureX: { type: "string", description: "First measure field caption" },
        measureY: { type: "string", description: "Second measure field caption" },
        groupBy: { type: "string", description: "Dimension or date field to group the paired points by (e.g. 'Month', 'Region', 'Product')" },
        granularity: { type: "string", enum: [...GRANULARITY_ENUM], description: "Required if groupBy is a date field: bucket size for the paired points" },
        aggregation: { type: "string", enum: [...AGGREGATION_ENUM], default: "SUM", description: "Aggregation applied to both measures" },
        dateField: { type: "string", description: "Optional date field caption for a window filter" },
        start: { type: "string", description: "Optional window start, ISO date YYYY-MM-DD (inclusive)" },
        end: { type: "string", description: "Optional window end, ISO date YYYY-MM-DD (inclusive)" },
      },
      required: ["datasourceLuid", "measureX", "measureY", "groupBy"],
    },
  },
  {
    name: "field_statistics",
    description:
      "Statistical profile of one field in a datasource: min, max, average and median from VDS aggregates plus a count. With sampleLimit > 0 it also queries raw rows (capped) to ESTIMATE null %, distinct values (cardinality) and numeric percentiles (p25/p50/p75) — those three are sample-based, not exact. Call this for 'describe the Revenue field', 'what's the distribution of X', 'is this field sparse or mostly empty'.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        field: { type: "string", description: "Field caption to profile (measure or dimension)" },
        sampleLimit: { type: "integer", minimum: 0, maximum: 5000, default: 500, description: "How many raw rows to sample for null%/cardinality/percentile estimates; 0 disables the sample query" },
      },
      required: ["datasourceLuid", "field"],
    },
  },
  {
    name: "bucketize_metric",
    description:
      "Histogram of a measure's values: bins the raw rows into equal-width buckets and counts how many fall in each, with each bin's % share. Call this for 'how is order value distributed', 'what does the price/order-size histogram look like'. Computed client-side over the rows the datasource returns (capped by sampleLimit), so it's a distribution of the sampled rows — say that when you present it.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        measure: { type: "string", description: "Numeric measure field caption to bucket (raw values, not aggregated)" },
        bucketCount: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Number of equal-width bins" },
        sampleLimit: { type: "integer", minimum: 1, maximum: 5000, default: 1000, description: "Max raw rows to sample for the histogram" },
        min: { type: "number", description: "Optional explicit bin floor (defaults to the sample minimum)" },
        max: { type: "number", description: "Optional explicit bin ceiling (defaults to the sample maximum)" },
        dateField: { type: "string", description: "Optional date field caption for a window filter" },
        start: { type: "string", description: "Optional window start, ISO date YYYY-MM-DD (inclusive)" },
        end: { type: "string", description: "Optional window end, ISO date YYYY-MM-DD (inclusive)" },
      },
      required: ["datasourceLuid", "measure"],
    },
  },
  {
    name: "share_of_total",
    description:
      "Each dimension member's share of a measure's total (%) and running cumulative share, ranked largest-first. With a baseline date window it also compares each member's share against the baseline period and reports the percentage-point change (shareDeltaPts) plus value change. Call this for 'what % of revenue is each region', 'how has each product's share changed vs last quarter'.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        measure: { type: "string", description: "Measure field caption" },
        dimension: { type: "string", description: "Dimension field caption whose members are the shares (e.g. 'Product')" },
        aggregation: { type: "string", enum: [...AGGREGATION_ENUM], default: "SUM", description: "Aggregation to apply to the measure" },
        dateField: { type: "string", description: "Date field caption for the current window and (if given) the baseline window" },
        start: { type: "string", description: "Current window start, ISO date YYYY-MM-DD (inclusive)" },
        end: { type: "string", description: "Current window end, ISO date YYYY-MM-DD (inclusive)" },
        baselineStart: { type: "string", description: "Optional baseline window start, ISO date YYYY-MM-DD (inclusive) — enables share delta vs baseline" },
        baselineEnd: { type: "string", description: "Optional baseline window end, ISO date YYYY-MM-DD (inclusive)" },
      },
      required: ["datasourceLuid", "measure", "dimension"],
    },
  },
  {
    name: "get_summary_table",
    description:
      "One-call 'insights digest' for a measure over a date range: total, average, row count, a MONTHLY trend (first/last bucket, change, direction), and the top contributing member with its share. Call this INSTEAD of composing several query_datasource calls for 'give me the key numbers / summary / headline stats for X'. Optionally break the top contributor down by a dimension.",
    input_schema: {
      type: "object",
      properties: {
        datasourceLuid: { type: "string", description: "The datasource LUID" },
        measure: { type: "string", description: "Measure field caption to summarize" },
        dateField: { type: "string", description: "Date field caption for the range and trend" },
        start: { type: "string", description: "Range start, ISO date YYYY-MM-DD (inclusive)" },
        end: { type: "string", description: "Range end, ISO date YYYY-MM-DD (inclusive)" },
        aggregation: { type: "string", enum: [...AGGREGATION_ENUM], default: "SUM", description: "Aggregation for the total" },
        dimension: { type: "string", description: "Optional dimension field caption for the top-contributor breakdown (e.g. 'Region')" },
      },
      required: ["datasourceLuid", "measure", "dateField", "start", "end"],
    },
  },
] as const;

// ---- Zod validators ----

const periodSchema = z.object({
  datasourceLuid: z.string(),
  measure: z.string(),
  dateField: z.string(),
  currentStart: z.string(),
  currentEnd: z.string(),
  previousStart: z.string(),
  previousEnd: z.string(),
  aggregation: z.enum(AGGREGATION_ENUM).default("SUM"),
  limit: clampedLimit(100, 20),
});

const schemas = {
  compare_periods: periodSchema.extend({ dimension: z.string().optional() }),
  explain_change: periodSchema.extend({ dimension: z.string() }),
  anomaly_detection: z.object({
    datasourceLuid: z.string(),
    measure: z.string(),
    dateField: z.string(),
    start: z.string(),
    end: z.string(),
    granularity: z.enum(GRANULARITY_ENUM).default("MONTH"),
    dimension: z.string().optional(),
    aggregation: z.enum(AGGREGATION_ENUM).default("SUM"),
    threshold: z.coerce.number().positive().default(2.5),
  }),
  forecast_metric: z.object({
    datasourceLuid: z.string(),
    measure: z.string(),
    dateField: z.string(),
    start: z.string(),
    end: z.string(),
    periods: clampedLimit(12, 6),
    granularity: z.enum(GRANULARITY_ENUM).default("MONTH"),
    aggregation: z.enum(AGGREGATION_ENUM).default("SUM"),
  }),
  get_metric_history: z.object({
    definitionId: z.string(),
    start: z.string().optional(),
    end: z.string().optional(),
    granularity: z.enum(GRANULARITY_ENUM).optional(),
  }),
  get_data_quality_warnings: z.object({ datasourceLuid: z.string() }),
  get_field_lineage: z.object({ datasourceLuid: z.string(), fieldName: z.string().optional() }),
  search_fields: z.object({
    query: z.string().min(1),
    limit: clampedLimit(100, 25),
    role: z.enum(["dimension", "measure"]).optional(),
  }),
  cross_datasource_query: z.object({
    datasourceLuids: z.array(z.string()).min(2).max(5),
    measure: z.string(),
    aggregation: z.enum(AGGREGATION_ENUM).default("SUM"),
    dimension: z.string().optional(),
    filters: z
      .array(
        z.object({
          field: z.string(),
          filterType: z.enum(["QUANTITATIVE_DATE", "EQUAL", "IN_LIST"]),
          min: z.string().optional(),
          max: z.string().optional(),
          value: z.string().optional(),
          values: z.array(z.string()).optional(),
        }),
      )
      .optional(),
  }),
  rank_categories: z.object({
    datasourceLuid: z.string(),
    dimension: z.string(),
    measure: z.string(),
    aggregation: z.enum(AGGREGATION_ENUM).default("SUM"),
    direction: z.enum(["top", "bottom"]).default("top"),
    limit: clampedLimit(100, 20),
    dateField: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
  }),
  pivot_cross_tab: z.object({
    datasourceLuid: z.string(),
    measure: z.string(),
    rowField: z.string(),
    columnField: z.string(),
    columnGranularity: z.enum(GRANULARITY_ENUM).optional(),
    aggregation: z.enum(AGGREGATION_ENUM).default("SUM"),
    dateField: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
  }),
  rollup_time_series: z.object({
    datasourceLuid: z.string(),
    measure: z.string(),
    dateField: z.string(),
    start: z.string(),
    end: z.string(),
    granularity: z.enum(GRANULARITY_ENUM).default("MONTH"),
    aggregation: z.enum(AGGREGATION_ENUM).default("SUM"),
    dimension: z.string().optional(),
  }),
  correlation_analysis: z.object({
    datasourceLuid: z.string(),
    measureX: z.string(),
    measureY: z.string(),
    groupBy: z.string(),
    granularity: z.enum(GRANULARITY_ENUM).optional(),
    aggregation: z.enum(AGGREGATION_ENUM).default("SUM"),
    dateField: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
  }),
  field_statistics: z.object({
    datasourceLuid: z.string(),
    field: z.string(),
    sampleLimit: z.coerce.number().int().min(0).max(5000).default(500),
  }),
  bucketize_metric: z.object({
    datasourceLuid: z.string(),
    measure: z.string(),
    bucketCount: clampedLimit(20, 5),
    sampleLimit: clampedLimit(5000, 1000),
    min: z.coerce.number().optional(),
    max: z.coerce.number().optional(),
    dateField: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
  }),
  share_of_total: z.object({
    datasourceLuid: z.string(),
    measure: z.string(),
    dimension: z.string(),
    aggregation: z.enum(AGGREGATION_ENUM).default("SUM"),
    dateField: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    baselineStart: z.string().optional(),
    baselineEnd: z.string().optional(),
  }),
  get_summary_table: z.object({
    datasourceLuid: z.string(),
    measure: z.string(),
    dateField: z.string(),
    start: z.string(),
    end: z.string(),
    aggregation: z.enum(AGGREGATION_ENUM).default("SUM"),
    dimension: z.string().optional(),
  }),
};

// ---- Helpers ----

type TableauClientLike = TableauClient;

/** Runs a VDS /query-datasource with explicit fields + filters, returns rows. */
async function vdsQuery(
  client: TableauClientLike,
  datasourceLuid: string,
  fields: Record<string, any>[],
  filters: Record<string, any>[],
  options?: Record<string, any>,
): Promise<any[]> {
  const data = await client.vdsRequest<any>("/query-datasource", {
    datasource: { datasourceLuid },
    query: { fields, filters },
    ...(options ? { options } : {}),
  });
  return data?.data ?? [];
}

/** Measures only: fields = [{ fieldCaption, function }], plus an optional date window. */
function measureOnlyQuery(measure: string, aggregation: string, start?: string, end?: string, dateField?: string) {
  const filters = dateField && start && end ? [buildDateFilter(dateField, start, end)] : [];
  return { fields: [{ fieldCaption: measure, function: aggregation }], filters };
}

/** Measures + one dimension, with an optional date window. */
function dimensionQuery(
  measure: string,
  aggregation: string,
  dimension: string | undefined,
  start?: string,
  end?: string,
  dateField?: string,
) {
  const fields = dimension
    ? [{ fieldCaption: dimension }, { fieldCaption: measure, function: aggregation }]
    : [{ fieldCaption: measure, function: aggregation }];
  const filters = dateField && start && end ? [buildDateFilter(dateField, start, end)] : [];
  return { fields, filters };
}

/**
 * Translates VDS rows into { key, value } series. With a dimension, the key is
 * the dimension caption's value; without one, the key is "__total__".
 */
function rowsToSeries(rows: any[], dimension?: string): { key: string; value: number }[] {
  return rows.map((row) => {
    const dimVal = dimension ? row[dimension] : undefined;
    const value = extractNumericValue(row);
    return {
      key: dimVal !== undefined && dimVal !== null ? String(dimVal) : "__total__",
      value: value ?? 0,
    };
  });
}

/** Adds `amount` granularity periods to an ISO date string (best-effort). */
function addPeriodToIso(dateStr: string, granularity: string, amount: number): string {
  const base = dateStr.length >= 10 ? dateStr.slice(0, 10) : dateStr;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return dateStr;
  const g = granularity.toUpperCase();
  if (g === "DAY") d.setDate(d.getDate() + amount);
  else if (g === "WEEK") d.setDate(d.getDate() + 7 * amount);
  else if (g === "QUARTER") d.setMonth(d.getMonth() + 3 * amount);
  else if (g === "YEAR") d.setFullYear(d.getFullYear() + amount);
  else d.setMonth(d.getMonth() + amount);
  return d.toISOString().slice(0, 10);
}

/** Time-bucketed query: date field truncated to `granularity` + measure (+ optional dimension). */
function timeSeriesQuery(
  measure: string,
  aggregation: string,
  dateField: string,
  granularity: string,
  start: string,
  end: string,
  dimension?: string,
) {
  const fields: Record<string, any>[] = [
    { fieldCaption: dateField, dateTruncation: granularity },
    { fieldCaption: measure, function: aggregation },
  ];
  if (dimension) fields.unshift({ fieldCaption: dimension });
  return { fields, filters: [buildDateFilter(dateField, start, end)] };
}

/** Sorts series rows by their (date) label so bucket ordering is correct. */
function sortByLabel(rows: { key: string; value: number }[]): { key: string; value: number }[] {
  return [...rows].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Reads a row's string label for the given caption — prefers that caption's
 * own value, falling back to the first non-empty string in the row (VDS can
 * relabel truncated date buckets, so the caption key may not always carry it).
 */
function rowString(row: Record<string, any>, caption?: string): string {
  const own = caption ? row?.[caption] : undefined;
  if (typeof own === "string" && own.trim() !== "") return own;
  const fallback = Object.values(row ?? {}).find((v) => typeof v === "string" && v.trim() !== "");
  return fallback !== undefined ? String(fallback) : "";
}

/** Reads a named aggregate out of a VDS row, matching the function name anywhere in the key. */
function readAgg(row: Record<string, any>, fn: string): number | null {
  if (!row || typeof row !== "object") return null;
  const fnKey = fn.toLowerCase();
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase().includes(fnKey)) {
      const n = readNumericCell({ [k]: v }, k);
      if (n !== null) return n;
    }
  }
  return null;
}

/** Builds the VDS filter array for an optional date window. */
function windowFilter(dateField?: string, start?: string, end?: string): Record<string, any>[] {
  return dateField && start && end ? [buildDateFilter(dateField, start, end)] : [];
}

// ---- Handlers ----

async function comparePeriods(client: TableauClient, args: z.infer<typeof schemas.compare_periods>) {
  const { dimension, aggregation } = args;
  const [curData, prevData] = await Promise.all([
    vdsQuery(
      client,
      args.datasourceLuid,
      dimensionQuery(args.measure, aggregation, dimension, args.currentStart, args.currentEnd, args.dateField).fields,
      dimensionQuery(args.measure, aggregation, dimension, args.currentStart, args.currentEnd, args.dateField).filters,
    ),
    vdsQuery(
      client,
      args.datasourceLuid,
      dimensionQuery(args.measure, aggregation, dimension, args.previousStart, args.previousEnd, args.dateField).fields,
      dimensionQuery(args.measure, aggregation, dimension, args.previousStart, args.previousEnd, args.dateField).filters,
    ),
  ]);

  const diff = diffAcrossPeriods(rowsToSeries(curData, dimension), rowsToSeries(prevData, dimension));
  return {
    measure: args.measure,
    dimension: dimension ?? null,
    aggregation,
    currentPeriod: { start: args.currentStart, end: args.currentEnd },
    previousPeriod: { start: args.previousStart, end: args.previousEnd },
    overall: diff.overall,
    segments: diff.segments.slice(0, args.limit),
  };
}

async function explainChange(client: TableauClient, args: z.infer<typeof schemas.explain_change>) {
  const result = await comparePeriods(client, {
    ...args,
    dimension: args.dimension,
  });
  const drivers = (result.segments ?? [])
    .filter((s) => s.key !== "__total__")
    .map((s) => ({
      key: s.key,
      current: s.current,
      previous: s.previous,
      absChange: s.absChange,
      pctChange: s.pctChange,
      contribution: s.contribution,
      direction: s.absChange > 0 ? "up" : s.absChange < 0 ? "down" : "flat",
    }));
  return { ...result, drivers };
}

async function anomalyDetection(client: TableauClient, args: z.infer<typeof schemas.anomaly_detection>) {
  const rows = await vdsQuery(
    client,
    args.datasourceLuid,
    timeSeriesQuery(args.measure, args.aggregation, args.dateField, args.granularity, args.start, args.end, args.dimension).fields,
    timeSeriesQuery(args.measure, args.aggregation, args.dateField, args.granularity, args.start, args.end, args.dimension).filters,
  );

  // VDS rows carry the date bucket + dimension value + numeric measure.
  const bySegment = new Map<string, { key: string; value: number }[]>();
  for (const row of rows) {
    const dimVal = args.dimension ? row[args.dimension] : undefined;
    const segment = dimVal !== undefined && dimVal !== null ? String(dimVal) : "__overall__";
    const value = extractNumericValue(row);
    if (value === null) continue;
    const bucket = Object.values(row).find((v) => typeof v === "string") ?? "";
    if (!bySegment.has(segment)) bySegment.set(segment, []);
    bySegment.get(segment)!.push({ key: String(bucket), value });
  }

  const groups = [...bySegment.entries()].map(([segment, series]) => {
    const sorted = sortByLabel(series);
    const res = detectAnomalies(sorted, args.threshold);
    return {
      segment,
      mean: res.mean,
      stddev: res.stddev,
      anomalyCount: res.anomalies.length,
      anomalies: res.anomalies.map((a) => ({ label: a.label, value: a.value, zScore: a.zScore, deviation: a.deviation })),
      points: res.points.map((p) => ({ label: p.label, value: p.value, isAnomaly: p.isAnomaly, zScore: p.zScore })),
    };
  });

  return {
    measure: args.measure,
    granularity: args.granularity,
    threshold: args.threshold,
    range: { start: args.start, end: args.end },
    groups,
    summary: groups.flatMap((g) =>
      g.anomalies.map((a) => ({
        segment: g.segment,
        label: a.label,
        value: a.value,
        zScore: a.zScore,
      })),
    ),
  };
}

async function forecastMetric(client: TableauClient, args: z.infer<typeof schemas.forecast_metric>) {
  const rows = await vdsQuery(
    client,
    args.datasourceLuid,
    timeSeriesQuery(args.measure, args.aggregation, args.dateField, args.granularity, args.start, args.end).fields,
    timeSeriesQuery(args.measure, args.aggregation, args.dateField, args.granularity, args.start, args.end).filters,
  );

  const series = sortByLabel(
    rows
      .map((row) => {
        const value = extractNumericValue(row);
        if (value === null) return null;
        const bucket = Object.values(row).find((v) => typeof v === "string") ?? "";
        return { key: String(bucket), value };
      })
      .filter((r): r is { key: string; value: number } => r !== null),
  );

  const result = forecastLinear(series, args.periods, (nextIdx) => {
    const lastLabel = series[series.length - 1]?.key;
    return lastLabel ? addPeriodToIso(lastLabel, args.granularity, nextIdx - (series.length - 1)) : `t+${nextIdx}`;
  });

  return {
    measure: args.measure,
    granularity: args.granularity,
    range: { start: args.start, end: args.end },
    fit: {
      slope: result.slope,
      r2: result.r2,
      residualStddev: result.residualStddev,
    },
    caveat: "Linear-trend statistical estimate, not a tuned forecast product — present it as an approximation.",
    historicalCount: result.points.filter((p) => !p.forecast).length,
    points: result.points.map((p) => ({
      label: p.label,
      value: p.value,
      forecast: p.forecast,
      lower: p.lower,
      upper: p.upper,
    })),
  };
}

async function getMetricHistory(client: TableauClient, args: z.infer<typeof schemas.get_metric_history>) {
  const definition = await fetchPulseDefinition(client, args.definitionId);
  const spec = resolvePulseSpec(definition);
  if (!spec.isBasic || !spec.measureField || !spec.datasourceLuid || !spec.timeDimensionField) {
    return {
      name: spec.name,
      error:
        "This Pulse metric has no resolvable time-based basic spec (no measure, datasource, or time dimension), so its history can't be reconstructed.",
    };
  }

  const granularity = args.granularity ?? spec.granularity ?? "MONTH";
  const end = args.end ?? new Date().toISOString().slice(0, 10);
  const start = args.start ?? addPeriodToIso(end, granularity, -12);

  // Resolve the metric's internal field names to VDS captions.
  const metaData = await client.metadataQuery<any>(
    `query GetFields($luid: String!) { publishedDatasources(filter: { luid: $luid }) { fields { name } } }`,
    { luid: spec.datasourceLuid },
  );
  const fieldNames: string[] = metaData?.publishedDatasources?.[0]?.fields?.map((f: any) => f.name) ?? [];
  const normalize = (s: string) => s.toLowerCase().replace(/[\s_]/g, "");
  const caption = (name: string) => fieldNames.find((n) => normalize(n) === normalize(name)) ?? name;

  const rows = await vdsQuery(
    client,
    spec.datasourceLuid,
    timeSeriesQuery(caption(spec.measureField), spec.aggregationMapped, caption(spec.timeDimensionField), granularity, start, end).fields,
    timeSeriesQuery(caption(spec.measureField), spec.aggregationMapped, caption(spec.timeDimensionField), granularity, start, end).filters,
  );

  const series = sortByLabel(
    rows
      .map((row) => {
        const value = extractNumericValue(row);
        if (value === null) return null;
        const bucket = Object.values(row).find((v) => typeof v === "string") ?? "";
        return { key: String(bucket), value };
      })
      .filter((r): r is { key: string; value: number } => r !== null),
  );

  return {
    name: spec.name,
    formula: `${spec.aggregationMapped}(${spec.measureField})`,
    datasourceLuid: spec.datasourceLuid,
    granularity,
    range: { start, end },
    pointCount: series.length,
    points: series.map((p) => ({ label: p.key, value: p.value })),
  };
}

async function getDataQualityWarnings(client: TableauClient, args: z.infer<typeof schemas.get_data_quality_warnings>) {
  const data = await client.metadataQuery<any>(
    `query DataQuality($luid: String!) {
      publishedDatasources(filter: { luid: $luid }) {
        name
        dataQualityWarnings { warningType message }
        fields {
          name
          dataQualityWarnings { warningType message }
        }
      }
    }`,
    { luid: args.datasourceLuid },
  );
  const ds = data?.publishedDatasources?.[0];
  if (!ds) return { error: `Datasource ${args.datasourceLuid} not found or not accessible.` };

  const dsWarnings = (ds.dataQualityWarnings ?? []).map((w: any) => ({ warningType: w.warningType, message: w.message }));
  const fieldWarnings = (ds.fields ?? [])
    .map((f: any) => ({
      field: f.name,
      warnings: (f.dataQualityWarnings ?? []).map((w: any) => ({ warningType: w.warningType, message: w.message })),
    }))
    .filter((f: any) => f.warnings.length > 0);

  const total = dsWarnings.length + fieldWarnings.reduce((sum: number, f: any) => sum + f.warnings.length, 0);
  return {
    datasourceName: ds.name,
    health: total === 0 ? "healthy" : "attention-needed",
    warningCount: total,
    datasourceWarnings: dsWarnings,
    fieldWarnings,
  };
}

async function getFieldLineage(client: TableauClient, args: z.infer<typeof schemas.get_field_lineage>) {
  const data = await client.metadataQuery<any>(
    `query FieldLineage($luid: String!) {
      publishedDatasources(filter: { luid: $luid }) {
        name
        fields {
          name
          upstreamColumns { name }
          downstreamSheets {
            name
            workbook { name }
          }
        }
      }
    }`,
    { luid: args.datasourceLuid },
  );
  const ds = data?.publishedDatasources?.[0];
  if (!ds) return { error: `Datasource ${args.datasourceLuid} not found or not accessible.` };

  const allFields: any[] = ds.fields ?? [];
  const filter = args.fieldName?.toLowerCase();
  const fields = filter ? allFields.filter((f) => f.name?.toLowerCase() === filter) : allFields;

  return {
    datasourceName: ds.name,
    fieldCount: fields.length,
    fields: fields.map((f: any) => ({
      name: f.name,
      upstreamColumns: (f.upstreamColumns ?? []).map((c: any) => c.name),
      downstreamSheets: (f.downstreamSheets ?? []).map((s: any) => ({
        sheetName: s.name,
        workbookName: s.workbook?.name ?? null,
      })),
    })),
  };
}

async function searchFields(client: TableauClient, args: z.infer<typeof schemas.search_fields>) {
  const data = await client.metadataQuery<any>(
    `query SearchFields($name: String!, $limit: Int) {
      searchFields(fieldName: $name, limit: $limit) {
        name
        ... on ColumnField { dataType role datasource { name luid } }
        ... on CalculatedField { dataType role datasource { name luid } }
      }
    }`,
    { name: args.query, limit: args.limit },
  );

  const raw = data?.searchFields ?? [];
  const fields = raw
    .map((f: any) => ({
      name: f.name,
      dataType: f.dataType ?? null,
      role: f.role ?? null,
      datasourceName: f.datasource?.name ?? null,
      datasourceLuid: f.datasource?.luid ?? null,
    }))
    .filter((f: any) => (args.role ? f.role === args.role : true));

  return {
    query: args.query,
    count: fields.length,
    fields,
  };
}

async function crossDatasourceQuery(client: TableauClient, args: z.infer<typeof schemas.cross_datasource_query>) {
  const results: { datasourceLuid: string; total: number; rows: { key: string; value: number }[] }[] = [];
  const { dimension, aggregation, filters } = args;

  for (const luid of args.datasourceLuids) {
    const q = dimensionQuery(args.measure, aggregation, dimension);
    const rows = await vdsQuery(client, luid, q.fields, filters ?? q.filters);
    const series = rowsToSeries(rows, dimension);
    results.push({
      datasourceLuid: luid,
      total: series.reduce((sum, r) => sum + r.value, 0),
      rows: series,
    });
  }

  const grandTotal = results.reduce((sum, r) => sum + r.total, 0);
  return {
    measure: args.measure,
    aggregation,
    datasourceCount: results.length,
    grandTotal: Math.round(grandTotal * 100) / 100,
    results,
  };
}

async function rankCategories(client: TableauClient, args: z.infer<typeof schemas.rank_categories>) {
  const q = dimensionQuery(args.measure, args.aggregation, args.dimension, args.start, args.end, args.dateField);
  const rows = await vdsQuery(client, args.datasourceLuid, q.fields, q.filters);
  const { total, rows: ranked } = rankSeries(rowsToSeries(rows, args.dimension), {
    direction: args.direction,
    limit: args.limit,
  });
  return {
    measure: args.measure,
    dimension: args.dimension,
    aggregation: args.aggregation,
    direction: args.direction,
    window: args.dateField && args.start && args.end ? { start: args.start, end: args.end } : null,
    total,
    count: ranked.length,
    rows: ranked,
  };
}

async function pivotCrossTab(client: TableauClient, args: z.infer<typeof schemas.pivot_cross_tab>) {
  const fields: Record<string, any>[] = [
    { fieldCaption: args.rowField },
    { fieldCaption: args.columnField, ...(args.columnGranularity ? { dateTruncation: args.columnGranularity } : {}) },
    { fieldCaption: args.measure, function: args.aggregation },
  ];
  const rows = await vdsQuery(client, args.datasourceLuid, fields, windowFilter(args.dateField, args.start, args.end));
  const triplets: { rowKey: string; colKey: string; value: number }[] = [];
  for (const row of rows) {
    const rowKey = row[args.rowField];
    const colKey = rowString(row, args.columnField);
    const value = readNumericCell(row, args.measure);
    if (rowKey === undefined || rowKey === null || rowKey === "" || !colKey || value === null) continue;
    triplets.push({ rowKey: String(rowKey), colKey, value });
  }
  const matrix = buildPivotMatrix(triplets);
  return {
    measure: args.measure,
    aggregation: args.aggregation,
    rowField: args.rowField,
    columnField: args.columnField,
    columnGranularity: args.columnGranularity ?? null,
    columns: matrix.columns,
    grandTotal: matrix.grandTotal,
    columnTotals: matrix.columnTotals,
    rows: matrix.rows,
  };
}

async function rollupTimeSeries(client: TableauClient, args: z.infer<typeof schemas.rollup_time_series>) {
  const q = timeSeriesQuery(args.measure, args.aggregation, args.dateField, args.granularity, args.start, args.end, args.dimension);
  const rows = await vdsQuery(client, args.datasourceLuid, q.fields, q.filters);
  const series = sortByLabel(
    rows
      .map((row) => {
        const value = extractNumericValue(row);
        if (value === null) return null;
        return { key: rowString(row, args.dateField), value };
      })
      .filter((r): r is { key: string; value: number } => r !== null && r.key !== ""),
  );
  const values = series.map((s) => s.value);
  const totals = {
    total: values.reduce((a, b) => a + b, 0),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
  };
  return {
    measure: args.measure,
    aggregation: args.aggregation,
    dateField: args.dateField,
    granularity: args.granularity,
    dimension: args.dimension ?? null,
    range: { start: args.start, end: args.end },
    pointCount: series.length,
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v !== null ? Math.round(v * 100) / 100 : null])),
    points: series.map((p) => ({ label: p.key, value: Math.round(p.value * 100) / 100 })),
  };
}

async function correlationAnalysis(client: TableauClient, args: z.infer<typeof schemas.correlation_analysis>) {
  const fields: Record<string, any>[] = [
    args.granularity ? { fieldCaption: args.groupBy, dateTruncation: args.granularity } : { fieldCaption: args.groupBy },
    { fieldCaption: args.measureX, function: args.aggregation },
    { fieldCaption: args.measureY, function: args.aggregation },
  ];
  const rows = await vdsQuery(client, args.datasourceLuid, fields, windowFilter(args.dateField, args.start, args.end));
  const points: { x: number; y: number }[] = [];
  for (const row of rows) {
    const x = readNumericCell(row, args.measureX);
    const y = readNumericCell(row, args.measureY);
    if (x === null || y === null) continue;
    points.push({ x, y });
  }
  const r = pearson(points);
  const rho = spearman(points);
  return {
    measureX: args.measureX,
    measureY: args.measureY,
    aggregation: args.aggregation,
    groupBy: args.groupBy,
    granularity: args.granularity ?? null,
    n: points.length,
    pearson: r,
    spearman: rho,
    interpretation:
      r !== null ? { strength: correlationLabel(r), direction: r >= 0 ? "positive" : "negative", r } : null,
    caveat: "Correlation measures association, not causation. Computed over points grouped by groupBy (one point per group).",
  };
}

async function fieldStatistics(client: TableauClient, args: z.infer<typeof schemas.field_statistics>) {
  const aggFields = ["MIN", "MAX", "AVG", "MEDIAN", "COUNT"].map((fn) => ({
    fieldCaption: args.field,
    function: fn,
  }));
  const aggRows = await vdsQuery(client, args.datasourceLuid, aggFields, []);
  const aggRow = aggRows[0] ?? {};
  const stats = {
    min: readAgg(aggRow, "MIN"),
    max: readAgg(aggRow, "MAX"),
    avg: readAgg(aggRow, "AVG"),
    median: readAgg(aggRow, "MEDIAN"),
    count: readAgg(aggRow, "COUNT"),
  };

  let sample = null;
  if (args.sampleLimit > 0) {
    try {
      const raw = await vdsQuery(
        client,
        args.datasourceLuid,
        [{ fieldCaption: args.field }],
        [],
        { returnFormat: "OBJECTS", rowLimit: args.sampleLimit },
      );
      if (raw.length > 0) {
        const nulls = raw.filter((r) => r[args.field] == null || r[args.field] === "");
        const distinct = new Set(raw.map((r) => r[args.field]).filter((v) => v != null && v !== ""));
        const numeric = raw
          .map((r) => readNumericCell(r, args.field))
          .filter((v): v is number => v !== null)
          .sort((a, b) => a - b);
        sample = {
          sampledRows: raw.length,
          capped: raw.length >= args.sampleLimit,
          nullPercent: Math.round((nulls.length / raw.length) * 1000) / 10,
          cardinalityEstimate: distinct.size,
          numeric: numeric.length > 0,
          percentiles:
            numeric.length > 0
              ? { p25: percentile(numeric, 25), p50: percentile(numeric, 50), p75: percentile(numeric, 75) }
              : null,
        };
      }
    } catch {
      sample = { note: "Sample query failed — null%/cardinality/percentile estimates unavailable." };
    }
  }

  return {
    field: args.field,
    stats,
    sample,
    note: "min/max/avg/median/count come from VDS aggregates (exact). When a sample was taken, null%, distinct-count and percentiles are ESTIMATES from the sampled rows only.",
  };
}

async function bucketizeMetric(client: TableauClient, args: z.infer<typeof schemas.bucketize_metric>) {
  const rows = await vdsQuery(
    client,
    args.datasourceLuid,
    [{ fieldCaption: args.measure }],
    windowFilter(args.dateField, args.start, args.end),
    { returnFormat: "OBJECTS", rowLimit: args.sampleLimit },
  );
  const values: number[] = [];
  for (const row of rows) {
    const v = readNumericCell(row, args.measure);
    if (v !== null) values.push(v);
  }
  const hist = histogram(values.slice(0, args.sampleLimit), {
    bucketCount: args.bucketCount,
    min: args.min,
    max: args.max,
  });
  return {
    measure: args.measure,
    bucketCount: args.bucketCount,
    sampledRows: values.length,
    min: hist.min,
    max: hist.max,
    binWidth: hist.binWidth,
    bins: hist.bins,
    note: "Distribution of the sampled rows, bucketed client-side — not an exact distribution of the full table.",
  };
}

async function shareOfTotalHandler(client: TableauClient, args: z.infer<typeof schemas.share_of_total>) {
  const currentQ = dimensionQuery(args.measure, args.aggregation, args.dimension, args.start, args.end, args.dateField);
  const [curRows, prevRows] = await Promise.all([
    vdsQuery(client, args.datasourceLuid, currentQ.fields, currentQ.filters),
    args.baselineStart && args.baselineEnd
      ? vdsQuery(
          client,
          args.datasourceLuid,
          dimensionQuery(args.measure, args.aggregation, args.dimension, args.baselineStart, args.baselineEnd, args.dateField).fields,
          dimensionQuery(args.measure, args.aggregation, args.dimension, args.baselineStart, args.baselineEnd, args.dateField).filters,
        )
      : Promise.resolve([]),
  ]);

  const baselineSeries = prevRows.length ? rowsToSeries(prevRows, args.dimension) : undefined;
  const result = shareOfTotal(rowsToSeries(curRows, args.dimension), baselineSeries);

  return {
    measure: args.measure,
    dimension: args.dimension,
    aggregation: args.aggregation,
    window: args.dateField && args.start && args.end ? { start: args.start, end: args.end } : null,
    baselineWindow:
      args.dateField && args.baselineStart && args.baselineEnd ? { start: args.baselineStart, end: args.baselineEnd } : null,
    total: result.total,
    baselineTotal: result.baselineTotal,
    hasBaseline: Boolean(baselineSeries),
    rows: result.rows,
  };
}

async function getSummaryTable(client: TableauClient, args: z.infer<typeof schemas.get_summary_table>) {
  const rangeFilter = windowFilter(args.dateField, args.start, args.end);

  const [aggRows, trendRows, dimRows] = await Promise.all([
    vdsQuery(client, args.datasourceLuid, measureOnlyQuery(args.measure, args.aggregation, args.start, args.end, args.dateField).fields, rangeFilter),
    vdsQuery(
      client,
      args.datasourceLuid,
      timeSeriesQuery(args.measure, args.aggregation, args.dateField, "MONTH", args.start, args.end).fields,
      rangeFilter,
    ),
    args.dimension
      ? vdsQuery(client, args.datasourceLuid, dimensionQuery(args.measure, args.aggregation, args.dimension, args.start, args.end, args.dateField).fields, rangeFilter)
      : Promise.resolve([]),
  ]);

  const aggRow = aggRows[0] ?? {};
  const total = extractNumericValue(aggRow);

  const trend = sortByLabel(
    trendRows
      .map((row) => {
        const value = extractNumericValue(row);
        if (value === null) return null;
        return { key: rowString(row, args.dateField), value };
      })
      .filter((r): r is { key: string; value: number } => r !== null && r.key !== ""),
  );

  let topContributor = null;
  if (dimRows.length > 0) {
    const ranked = rankSeries(rowsToSeries(dimRows, args.dimension), { direction: "top", limit: 1 });
    const top = ranked.rows[0];
    if (top) {
      topContributor = { key: top.key, value: top.value, pctOfTotal: top.pctOfTotal };
    }
  }

  const first = trend[0]?.value;
  const last = trend[trend.length - 1]?.value;
  const prev = trend[trend.length - 2]?.value;

  return {
    measure: args.measure,
    aggregation: args.aggregation,
    range: { start: args.start, end: args.end },
    total: total !== null ? Math.round(total * 100) / 100 : null,
    bucketCount: trend.length,
    trend: {
      granularity: "MONTH",
      firstBucket: trend[0] ? { label: trend[0].key, value: Math.round(trend[0].value * 100) / 100 } : null,
      lastBucket: trend[trend.length - 1] ? { label: trend[trend.length - 1].key, value: Math.round(last! * 100) / 100 } : null,
      changeOverall:
        first !== undefined && last !== undefined ? Math.round((last - first) * 100) / 100 : null,
      pctChangeOverall:
        first !== undefined && last !== undefined && first !== 0
          ? Math.round(((last - first) / Math.abs(first)) * 1000) / 10
          : null,
      lastVsPrevious:
        prev !== undefined && last !== undefined ? Math.round((last - prev) * 100) / 100 : null,
      direction: last !== undefined && first !== undefined ? (last > first ? "up" : last < first ? "down" : "flat") : "flat",
    },
    topContributor,
  };
}

// ---- Registry ----

export const analyticalHandlers: Record<string, (client: TableauClient, args: any) => Promise<any>> = {
  compare_periods: (c, a) => comparePeriods(c, schemas.compare_periods.parse(a ?? {})),
  explain_change: (c, a) => explainChange(c, schemas.explain_change.parse(a ?? {})),
  anomaly_detection: (c, a) => anomalyDetection(c, schemas.anomaly_detection.parse(a ?? {})),
  forecast_metric: (c, a) => forecastMetric(c, schemas.forecast_metric.parse(a ?? {})),
  get_metric_history: (c, a) => getMetricHistory(c, schemas.get_metric_history.parse(a ?? {})),
  get_data_quality_warnings: (c, a) => getDataQualityWarnings(c, schemas.get_data_quality_warnings.parse(a ?? {})),
  get_field_lineage: (c, a) => getFieldLineage(c, schemas.get_field_lineage.parse(a ?? {})),
  search_fields: (c, a) => searchFields(c, schemas.search_fields.parse(a ?? {})),
  cross_datasource_query: (c, a) => crossDatasourceQuery(c, schemas.cross_datasource_query.parse(a ?? {})),
  rank_categories: (c, a) => rankCategories(c, schemas.rank_categories.parse(a ?? {})),
  pivot_cross_tab: (c, a) => pivotCrossTab(c, schemas.pivot_cross_tab.parse(a ?? {})),
  rollup_time_series: (c, a) => rollupTimeSeries(c, schemas.rollup_time_series.parse(a ?? {})),
  correlation_analysis: (c, a) => correlationAnalysis(c, schemas.correlation_analysis.parse(a ?? {})),
  field_statistics: (c, a) => fieldStatistics(c, schemas.field_statistics.parse(a ?? {})),
  bucketize_metric: (c, a) => bucketizeMetric(c, schemas.bucketize_metric.parse(a ?? {})),
  share_of_total: (c, a) => shareOfTotalHandler(c, schemas.share_of_total.parse(a ?? {})),
  get_summary_table: (c, a) => getSummaryTable(c, schemas.get_summary_table.parse(a ?? {})),
};
