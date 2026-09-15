import { test } from "node:test";
import assert from "node:assert/strict";
import { TableauClient } from "../src/tableau/client.js";
import { analyticalHandlers } from "../src/tools/analyticalTools.js";

type Fakes = {
  vds?: (path: string, body: any) => any;
  meta?: (query: string, vars?: any) => any;
  rest?: (method: string, path: string, opts?: any) => any;
};

function fakeClient(fakes: Fakes): TableauClient {
  return {
    getUserId: () => "test-user",
    vdsRequest: async (path: string, body: any) => (fakes.vds ? fakes.vds(path, body) : { data: [] }),
    metadataQuery: async (query: string, vars?: any) => (fakes.meta ? fakes.meta(query, vars) : {}),
    restRequestUnversioned: async (method: string, path: string, opts?: any) =>
      fakes.rest ? fakes.rest(method, path, opts) : {},
  } as unknown as TableauClient;
}

const call = (name: string, client: TableauClient, args: any) => analyticalHandlers[name](client, args);

// ---- compare_periods ----

test("compare_periods returns overall + sorted segments from two period queries", async () => {
  const client = fakeClient({
    vds: (path, body) => {
      const min = body.query.filters[0].min;
      const rows =
        min === "2024-06-01"
          ? [
              { Region: "East", Revenue: 200 },
              { Region: "West", Revenue: 100 },
            ]
          : [
              { Region: "East", Revenue: 100 },
              { Region: "West", Revenue: 300 },
            ];
      return { data: rows };
    },
  });

  const out = await call(
    "compare_periods",
    client,
    {
      datasourceLuid: "ds1",
      measure: "Revenue",
      dateField: "Order Date",
      currentStart: "2024-06-01",
      currentEnd: "2024-06-30",
      previousStart: "2024-05-01",
      previousEnd: "2024-05-31",
      dimension: "Region",
    },
  );

  assert.equal(out.overall.current, 300);
  assert.equal(out.overall.previous, 400);
  assert.equal(out.overall.absChange, -100);
  // sorted by |absChange|: West moved -200, East +100
  assert.equal(out.segments[0].key, "West");
  assert.equal(out.segments[0].absChange, -200);
  assert.equal(out.segments[1].key, "East");
  assert.equal(out.segments[1].absChange, 100);
});

// ---- explain_change ----

test("explain_change adds direction-tagged drivers", async () => {
  const client = fakeClient({
    vds: (path, body) => {
      const min = body.query.filters[0].min;
      const rows =
        min === "2024-06-01"
          ? [
              { Region: "East", Revenue: 120 },
              { Region: "West", Revenue: 80 },
            ]
          : [
              { Region: "East", Revenue: 60 },
              { Region: "West", Revenue: 120 },
            ];
      return { data: rows };
    },
  });

  const out = await call(
    "explain_change",
    client,
    {
      datasourceLuid: "ds1",
      measure: "Revenue",
      dateField: "Order Date",
      currentStart: "2024-06-01",
      currentEnd: "2024-06-30",
      previousStart: "2024-05-01",
      previousEnd: "2024-05-31",
      dimension: "Region",
    },
  );

  assert.equal(out.drivers.length, 2);
  const east = out.drivers.find((d: any) => d.key === "East");
  assert.equal(east.direction, "up");
  assert.equal(east.absChange, 60);
});

// ---- anomaly_detection ----

test("anomaly_detection flags a spike bucket", async () => {
  const client = fakeClient({
    vds: () => ({
      data: [
        { "Order Date": "2024-01-01", Revenue: 10 },
        { "Order Date": "2024-02-01", Revenue: 10 },
        { "Order Date": "2024-03-01", Revenue: 10 },
        { "Order Date": "2024-04-01", Revenue: 100 },
        { "Order Date": "2024-05-01", Revenue: 10 },
      ],
    }),
  });

  const out = await call(
    "anomaly_detection",
    client,
    {
      datasourceLuid: "ds1",
      measure: "Revenue",
      dateField: "Order Date",
      start: "2024-01-01",
      end: "2024-05-31",
      granularity: "MONTH",
      threshold: 1.5,
    },
  );

  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].segment, "__overall__");
  assert.ok(out.summary.length >= 1);
  assert.equal(out.summary[0].label, "2024-04-01");
  assert.ok(out.summary[0].value === 100);
});

test("anomaly_detection segments per dimension value", async () => {
  const client = fakeClient({
    vds: () => ({
      data: [
        { Region: "A", "Order Date": "2024-01-01", Revenue: 10 },
        { Region: "A", "Order Date": "2024-02-01", Revenue: 10 },
        { Region: "B", "Order Date": "2024-01-01", Revenue: 5 },
        { Region: "B", "Order Date": "2024-02-01", Revenue: 5 },
      ],
    }),
  });

  const out = await call(
    "anomaly_detection",
    client,
    {
      datasourceLuid: "ds1",
      measure: "Revenue",
      dateField: "Order Date",
      start: "2024-01-01",
      end: "2024-02-28",
      granularity: "MONTH",
      dimension: "Region",
    },
  );

  assert.equal(out.groups.length, 2);
  assert.deepEqual(out.groups.map((g: any) => g.segment).sort(), ["A", "B"]);
});

// ---- forecast_metric ----

test("forecast_metric projects forward with forecast flags", async () => {
  const client = fakeClient({
    vds: () => ({
      data: [
        { "Order Date": "2024-01-01", Revenue: 10 },
        { "Order Date": "2024-02-01", Revenue: 20 },
        { "Order Date": "2024-03-01", Revenue: 30 },
        { "Order Date": "2024-04-01", Revenue: 40 },
      ],
    }),
  });

  const out = await call(
    "forecast_metric",
    client,
    {
      datasourceLuid: "ds1",
      measure: "Revenue",
      dateField: "Order Date",
      start: "2024-01-01",
      end: "2024-04-30",
      periods: 2,
      granularity: "MONTH",
    },
  );

  assert.equal(out.historicalCount, 4);
  const forecast = out.points.filter((p: any) => p.forecast);
  assert.equal(forecast.length, 2);
  assert.equal(forecast[0].value, 50);
  assert.ok(out.caveat.includes("estimate"));
});

// ---- get_metric_history ----

test("get_metric_history resolves the metric's own spec and returns a series", async () => {
  const client = fakeClient({
    rest: () => ({
      definition: {
        metadata: { id: "m1", name: "Monthly Revenue" },
        specification: {
          datasource: { id: "ds1" },
          basic_specification: {
            measure: { field: "revenue_field", aggregation: "AGGREGATION_SUM" },
            time_dimension: { field: "order_date_field", granularity: "MONTH" },
          },
        },
      },
    }),
    meta: () => ({
      publishedDatasources: [{ fields: [{ name: "revenue_field" }, { name: "order_date_field" }] }],
    }),
    vds: () => ({
      data: [
        { "Order Date": "2024-01-01", Revenue: 10 },
        { "Order Date": "2024-02-01", Revenue: 20 },
      ],
    }),
  });

  const out = await call("get_metric_history", client, { definitionId: "m1", start: "2024-01-01", end: "2024-02-28" });

  assert.equal(out.name, "Monthly Revenue");
  assert.equal(out.formula, "SUM(revenue_field)");
  assert.equal(out.granularity, "MONTH");
  assert.equal(out.pointCount, 2);
  assert.equal(out.points[0].value, 10);
});

// ---- get_data_quality_warnings ----

test("get_data_quality_warnings reports healthy when no warnings exist", async () => {
  const client = fakeClient({
    meta: () => ({ publishedDatasources: [{ name: "Sales", dataQualityWarnings: [], fields: [{ name: "Revenue", dataQualityWarnings: [] }] }] }),
  });
  const out = await call("get_data_quality_warnings", client, { datasourceLuid: "ds1" });
  assert.equal(out.health, "healthy");
  assert.equal(out.warningCount, 0);
});

test("get_data_quality_warnings aggregates field-level warnings", async () => {
  const client = fakeClient({
    meta: () => ({
      publishedDatasources: [
        {
          name: "Sales",
          dataQualityWarnings: [{ warningType: "MISMATCH", message: "schema changed" }],
          fields: [
            { name: "Revenue", dataQualityWarnings: [{ warningType: "STALE", message: "2 days old" }] },
            { name: "Region", dataQualityWarnings: [] },
          ],
        },
      ],
    }),
  });
  const out = await call("get_data_quality_warnings", client, { datasourceLuid: "ds1" });
  assert.equal(out.health, "attention-needed");
  assert.equal(out.warningCount, 2);
  assert.equal(out.fieldWarnings.length, 1);
  assert.equal(out.fieldWarnings[0].field, "Revenue");
});

// ---- get_field_lineage ----

test("get_field_lineage returns upstream columns and downstream sheets", async () => {
  const client = fakeClient({
    meta: () => ({
      publishedDatasources: [
        {
          name: "Sales",
          fields: [
            {
              name: "Profit",
              upstreamColumns: [{ name: "revenue" }, { name: "cost" }],
              downstreamSheets: [{ name: "Profit Board", workbook: { name: "Exec" } }],
            },
          ],
        },
      ],
    }),
  });
  const out = await call("get_field_lineage", client, { datasourceLuid: "ds1", fieldName: "Profit" });
  assert.deepEqual(out.fields[0].upstreamColumns, ["revenue", "cost"]);
  assert.equal(out.fields[0].downstreamSheets[0].sheetName, "Profit Board");
});

// ---- search_fields ----

test("search_fields maps Metadata API results and applies role filter", async () => {
  const client = fakeClient({
    meta: (query) => {
      assert.ok(query.includes("searchFields"));
      return {
        searchFields: [
          { name: "Profit Margin", dataType: "number", role: "measure", datasource: { name: "Sales", luid: "ds1" } },
          { name: "Margin Note", dataType: "string", role: "dimension", datasource: { name: "Notes", luid: "ds2" } },
        ],
      };
    },
  });
  const out = await call("search_fields", client, { query: "margin", role: "measure" });
  assert.equal(out.count, 1);
  assert.equal(out.fields[0].name, "Profit Margin");
  assert.equal(out.fields[0].datasourceLuid, "ds1");
});

// ---- cross_datasource_query ----

test("cross_datasource_query merges per-datasource totals into a grand total", async () => {
  const client = fakeClient({
    vds: (path, body) => {
      const luid = body.datasource.datasourceLuid;
      return luid === "ds1" ? { data: [{ Revenue: 100 }] } : { data: [{ Revenue: 250 }] };
    },
  });

  const out = await call("cross_datasource_query", client, {
    datasourceLuids: ["ds1", "ds2"],
    measure: "Revenue",
  });

  assert.equal(out.datasourceCount, 2);
  assert.equal(out.results[0].total, 100);
  assert.equal(out.results[1].total, 250);
  assert.equal(out.grandTotal, 350);
});

// ---- rank_categories ----

test("rank_categories ranks top N with % of total and cumulative share", async () => {
  const client = fakeClient({
    vds: () => ({
      data: [
        { Region: "East", Revenue: 200 },
        { Region: "West", Revenue: 100 },
        { Region: "North", Revenue: 50 },
      ],
    }),
  });

  const out = await call("rank_categories", client, {
    datasourceLuid: "ds1",
    dimension: "Region",
    measure: "Revenue",
    limit: 2,
  });

  assert.equal(out.total, 350);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].key, "East");
  assert.equal(out.rows[0].pctOfTotal, 57.14);
  assert.equal(out.rows[1].key, "West");
  assert.equal(out.rows[1].cumulativePct, 85.71);
});

// ---- pivot_cross_tab ----

test("pivot_cross_tab builds rows x columns with totals", async () => {
  const client = fakeClient({
    vds: () => ({
      data: [
        { Region: "East", "Order Date": "2024-01-01", Revenue: 100 },
        { Region: "East", "Order Date": "2024-02-01", Revenue: 200 },
        { Region: "West", "Order Date": "2024-01-01", Revenue: 50 },
        { Region: "West", "Order Date": "2024-02-01", Revenue: 150 },
      ],
    }),
  });

  const out = await call("pivot_cross_tab", client, {
    datasourceLuid: "ds1",
    measure: "Revenue",
    rowField: "Region",
    columnField: "Order Date",
    columnGranularity: "MONTH",
  });

  assert.deepEqual(out.columns, ["2024-01-01", "2024-02-01"]);
  assert.equal(out.rows.length, 2);
  const east = out.rows.find((r: any) => r.rowKey === "East");
  assert.equal(east.rowTotal, 300);
  assert.equal(east.cells["2024-02-01"], 200);
  assert.deepEqual(out.columnTotals, { "2024-01-01": 150, "2024-02-01": 350 });
  assert.equal(out.grandTotal, 500);
});

// ---- rollup_time_series ----

test("rollup_time_series returns a sorted bucketed series with totals", async () => {
  const client = fakeClient({
    vds: () => ({
      data: [
        { "Order Date": "2024-01-01", Revenue: 10 },
        { "Order Date": "2024-02-01", Revenue: 20 },
        { "Order Date": "2024-03-01", Revenue: 30 },
      ],
    }),
  });

  const out = await call("rollup_time_series", client, {
    datasourceLuid: "ds1",
    measure: "Revenue",
    dateField: "Order Date",
    start: "2024-01-01",
    end: "2024-03-31",
    granularity: "MONTH",
  });

  assert.equal(out.pointCount, 3);
  assert.equal(out.points[0].label, "2024-01-01");
  assert.equal(out.points[0].value, 10);
  assert.equal(out.totals.total, 60);
  assert.equal(out.totals.avg, 20);
});

// ---- correlation_analysis ----

test("correlation_analysis returns Pearson/Spearman over grouped points", async () => {
  const client = fakeClient({
    vds: () => ({
      data: [
        { Group: "A", "Ad Spend": 1, Revenue: 2 },
        { Group: "B", "Ad Spend": 2, Revenue: 4 },
        { Group: "C", "Ad Spend": 3, Revenue: 6 },
      ],
    }),
  });

  const out = await call("correlation_analysis", client, {
    datasourceLuid: "ds1",
    measureX: "Ad Spend",
    measureY: "Revenue",
    groupBy: "Group",
  });

  assert.equal(out.n, 3);
  assert.equal(out.pearson, 1);
  assert.equal(out.spearman, 1);
  assert.equal(out.interpretation.strength, "strong");
  assert.equal(out.interpretation.direction, "positive");
  assert.ok(out.caveat.includes("not causation"));
});

// ---- field_statistics ----

test("field_statistics reads aggregates and sample-based estimates", async () => {
  const client = fakeClient({
    vds: (path, body) => {
      const isAgg = body.query.fields.length > 1;
      return isAgg
        ? { data: [{ "Revenue:MIN": 10, "Revenue:MAX": 100, "Revenue:AVG": 50, "Revenue:MEDIAN": 45, "Revenue:COUNT": 100 }] }
        : { data: [{ Revenue: 10 }, { Revenue: 20 }, { Revenue: null }, { Revenue: null }, { Revenue: 30 }] };
    },
  });

  const out = await call("field_statistics", client, { datasourceLuid: "ds1", field: "Revenue", sampleLimit: 500 });

  assert.equal(out.stats.min, 10);
  assert.equal(out.stats.max, 100);
  assert.equal(out.stats.avg, 50);
  assert.equal(out.stats.median, 45);
  assert.equal(out.stats.count, 100);
  assert.equal(out.sample.nullPercent, 40);
  assert.equal(out.sample.cardinalityEstimate, 3);
  assert.equal(out.sample.percentiles.p50, 20);
});

test("field_statistics skips the sample when sampleLimit is 0", async () => {
  const client = fakeClient({
    vds: () => ({ data: [{ "Revenue:MIN": 1 }] }),
  });
  const out = await call("field_statistics", client, { datasourceLuid: "ds1", field: "Revenue", sampleLimit: 0 });
  assert.equal(out.stats.min, 1);
  assert.equal(out.sample, null);
});

// ---- bucketize_metric ----

test("bucketize_metric returns equal-width histogram bins", async () => {
  const client = fakeClient({
    vds: () => ({
      data: Array.from({ length: 10 }, (_, i) => ({ Revenue: i + 1 })),
    }),
  });

  const out = await call("bucketize_metric", client, {
    datasourceLuid: "ds1",
    measure: "Revenue",
    bucketCount: 5,
  });

  assert.equal(out.sampledRows, 10);
  assert.equal(out.min, 1);
  assert.equal(out.max, 10);
  assert.equal(out.bins.length, 5);
  assert.deepEqual(out.bins.map((b: any) => b.count), [2, 2, 2, 2, 2]);
});

// ---- share_of_total ----

test("share_of_total reports shares and baseline share delta", async () => {
  const client = fakeClient({
    vds: (path, body) => {
      const min = body.query.filters[0].min;
      return min === "2024-06-01"
        ? { data: [
            { Product: "A", Revenue: 60 },
            { Product: "B", Revenue: 30 },
            { Product: "C", Revenue: 10 },
          ] }
        : { data: [
            { Product: "A", Revenue: 30 },
            { Product: "B", Revenue: 50 },
            { Product: "C", Revenue: 20 },
          ] };
    },
  });

  const out = await call("share_of_total", client, {
    datasourceLuid: "ds1",
    measure: "Revenue",
    dimension: "Product",
    dateField: "Order Date",
    start: "2024-06-01",
    end: "2024-06-30",
    baselineStart: "2024-05-01",
    baselineEnd: "2024-05-31",
  });

  assert.equal(out.total, 100);
  assert.equal(out.hasBaseline, true);
  const a = out.rows[0];
  assert.equal(a.key, "A");
  assert.equal(a.pctOfTotal, 60);
  assert.equal(a.shareDeltaPts, 30);
  assert.equal(a.valueChange, 30);
  assert.equal(out.rows[1].shareDeltaPts, -20);
});

// ---- get_summary_table ----

test("get_summary_table digests total, trend and top contributor in one call", async () => {
  const client = fakeClient({
    vds: (path, body) => {
      const fields = body.query.fields;
      if (fields.length === 1) return { data: [{ Revenue: 5000 }] };
      if (fields[0].dateTruncation) {
        return {
          data: [
            { "Order Date": "2024-01-01", Revenue: 1000 },
            { "Order Date": "2024-02-01", Revenue: 1500 },
            { "Order Date": "2024-03-01", Revenue: 2500 },
          ],
        };
      }
      return {
        data: [
          { Region: "East", Revenue: 2500 },
          { Region: "West", Revenue: 1500 },
          { Region: "North", Revenue: 1000 },
        ],
      };
    },
  });

  const out = await call("get_summary_table", client, {
    datasourceLuid: "ds1",
    measure: "Revenue",
    dateField: "Order Date",
    start: "2024-01-01",
    end: "2024-03-31",
    dimension: "Region",
  });

  assert.equal(out.total, 5000);
  assert.equal(out.bucketCount, 3);
  assert.equal(out.trend.firstBucket.value, 1000);
  assert.equal(out.trend.lastBucket.value, 2500);
  assert.equal(out.trend.changeOverall, 1500);
  assert.equal(out.trend.pctChangeOverall, 150);
  assert.equal(out.trend.lastVsPrevious, 1000);
  assert.equal(out.trend.direction, "up");
  assert.equal(out.topContributor.key, "East");
  assert.equal(out.topContributor.pctOfTotal, 50);
});
