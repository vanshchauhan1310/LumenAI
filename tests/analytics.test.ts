import { test } from "node:test";
import assert from "node:assert/strict";
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
} from "../src/lib/analytics.js";

// ---- extractNumericValue ----

test("extractNumericValue picks the first finite numeric value from a row", () => {
  assert.equal(extractNumericValue({ Region: "East", Revenue: 200 }), 200);
  assert.equal(extractNumericValue({ Region: "East" }), null);
  assert.equal(extractNumericValue({ a: "not-a-number", b: "42" }), 42);
  assert.equal(extractNumericValue({}), null);
});

// ---- diffAcrossPeriods ----

test("diffAcrossPeriods computes overall and per-segment change", () => {
  const { overall, segments } = diffAcrossPeriods(
    [
      { key: "East", value: 200 },
      { key: "West", value: 100 },
    ],
    [
      { key: "East", value: 100 },
      { key: "West", value: 200 },
    ],
  );
  assert.equal(overall.current, 300);
  assert.equal(overall.previous, 300);
  assert.equal(overall.absChange, 0);
  assert.equal(overall.pctChange, 0);
  assert.equal(overall.contribution, null);

  assert.equal(segments[0].key, "East");
  assert.equal(segments[0].current, 200);
  assert.equal(segments[0].previous, 100);
  assert.equal(segments[0].absChange, 100);
  assert.equal(segments[0].pctChange, 100);

  assert.equal(segments[1].key, "West");
  assert.equal(segments[1].pctChange, -50);
});

test("diffAcrossPeriods sorts segments by absolute change (most moved first)", () => {
  const { segments } = diffAcrossPeriods(
    [
      { key: "A", value: 60 },
      { key: "B", value: 15 },
      { key: "C", value: 200 },
    ],
    [
      { key: "A", value: 10 },
      { key: "B", value: 12 },
      { key: "C", value: 100 },
    ],
  );
  assert.deepEqual(segments.map((s) => s.key), ["C", "A", "B"]);
});

test("diffAcrossPeriods yields null pctChange when previous is 0", () => {
  const { segments } = diffAcrossPeriods([{ key: "X", value: 50 }], [{ key: "X", value: 0 }]);
  assert.equal(segments[0].pctChange, null);
  assert.equal(segments[0].absChange, 50);
});

test("diffAcrossPeriods computes contribution shares summing to ~100", () => {
  const { segments } = diffAcrossPeriods(
    [
      { key: "A", value: 30 },
      { key: "B", value: 90 },
    ],
    [
      { key: "A", value: 10 },
      { key: "B", value: 20 },
    ],
  );
  const total = segments.reduce((sum, s) => sum + (s.contribution ?? 0), 0);
  assert.ok(total >= 99.9 && total <= 100.1);
  assert.ok(segments[0].key === "B");
});

test("diffAcrossPeriods handles segments present in only one period", () => {
  const { segments, overall } = diffAcrossPeriods(
    [{ key: "New", value: 500 }],
    [{ key: "Old", value: 100 }],
  );
  assert.equal(segments.length, 2);
  const newSeg = segments.find((s) => s.key === "New")!;
  const oldSeg = segments.find((s) => s.key === "Old")!;
  assert.equal(newSeg.previous, 0);
  assert.equal(newSeg.pctChange, null);
  assert.equal(oldSeg.current, 0);
  assert.equal(overall.current, 500);
  assert.equal(overall.previous, 100);
});

// ---- detectAnomalies ----

test("detectAnomalies flags a clear outlier above the threshold", () => {
  const result = detectAnomalies(
    [
      { key: "Jan", value: 10 },
      { key: "Feb", value: 10 },
      { key: "Mar", value: 10 },
      { key: "Apr", value: 100 },
      { key: "May", value: 10 },
    ],
    1.5,
  );
  assert.ok(result.anomalies.length >= 1);
  assert.equal(result.anomalies[0].label, "Apr");
  assert.ok(result.points.find((p) => p.label === "Apr")!.isAnomaly);
  assert.ok(result.points.find((p) => p.label === "Jan")!.zScore !== null);
});

test("detectAnomalies flags nothing for a flat series at any sane threshold", () => {
  const result = detectAnomalies(
    [
      { key: "Jan", value: 5 },
      { key: "Feb", value: 5 },
      { key: "Mar", value: 5 },
    ],
    2.5,
  );
  assert.equal(result.stddev, 0);
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.points[0].zScore, null);
});

// ---- forecastLinear ----

test("forecastLinear projects a perfect linear trend exactly", () => {
  const result = forecastLinear(
    [
      { key: "Jan", value: 10 },
      { key: "Feb", value: 20 },
      { key: "Mar", value: 30 },
      { key: "Apr", value: 40 },
    ],
    2,
  );
  assert.equal(result.slope, 10);
  assert.equal(result.intercept, 10);
  assert.ok(Math.abs(result.r2! - 1) < 0.0001);

  const historical = result.points.filter((p) => !p.forecast);
  assert.equal(historical.length, 4);

  const forecast = result.points.filter((p) => p.forecast);
  assert.equal(forecast.length, 2);
  assert.equal(forecast[0].value, 50);
  assert.equal(forecast[1].value, 60);
  assert.ok(forecast[0].lower !== null && forecast[0].upper !== null);
});

test("forecastLinear returns empty points for fewer than 2 history points", () => {
  const result = forecastLinear([{ key: "Jan", value: 10 }], 3);
  assert.equal(result.slope, null);
  assert.equal(result.points.length, 0);
});

// ---- buildDateFilter ----

test("buildDateFilter produces a VDS QUANTITATIVE_DATE filter", () => {
  const f = buildDateFilter("Order Date", "2024-01-01", "2024-12-31");
  assert.deepEqual(f, {
    field: { fieldCaption: "Order Date" },
    filterType: "QUANTITATIVE_DATE",
    min: "2024-01-01",
    max: "2024-12-31",
  });
});

// ---- readNumericCell ----

test("readNumericCell reads one named cell, ignoring unrelated values", () => {
  assert.equal(readNumericCell({ Region: "East", Revenue: 200 }, "Revenue"), 200);
  assert.equal(readNumericCell({ Revenue: "42" }, "Revenue"), 42);
  assert.equal(readNumericCell({ Region: "East" }, "Revenue"), null);
  assert.equal(readNumericCell({}, "Revenue"), null);
});

// ---- rankSeries ----

test("rankSeries ranks top N with % of total and cumulative share", () => {
  const { total, rows } = rankSeries(
    [
      { key: "East", value: 200 },
      { key: "West", value: 100 },
      { key: "North", value: 50 },
    ],
    { direction: "top", limit: 2 },
  );
  assert.equal(total, 350);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, "East");
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].pctOfTotal, 57.14);
  assert.equal(rows[0].cumulativePct, 57.14);
  assert.equal(rows[1].key, "West");
  assert.equal(rows[1].cumulativePct, 85.71);
});

test("rankSeries bottom direction ranks smallest first", () => {
  const { rows } = rankSeries(
    [
      { key: "East", value: 200 },
      { key: "West", value: 100 },
    ],
    { direction: "bottom", limit: 5 },
  );
  assert.equal(rows[0].key, "West");
  assert.equal(rows[1].key, "East");
});

test("rankSeries yields null shares when total is 0", () => {
  const { rows } = rankSeries([{ key: "A", value: 0 }], { limit: 5 });
  assert.equal(rows[0].pctOfTotal, null);
  assert.equal(rows[0].cumulativePct, null);
});

// ---- buildPivotMatrix ----

test("buildPivotMatrix assembles rows x columns with totals", () => {
  const matrix = buildPivotMatrix([
    { rowKey: "East", colKey: "2024-01", value: 100 },
    { rowKey: "East", colKey: "2024-02", value: 200 },
    { rowKey: "West", colKey: "2024-01", value: 50 },
    { rowKey: "West", colKey: "2024-02", value: 150 },
  ]);
  assert.deepEqual(matrix.columns, ["2024-01", "2024-02"]);
  assert.equal(matrix.rows.length, 2);
  const east = matrix.rows.find((r) => r.rowKey === "East")!;
  assert.deepEqual(east.cells, { "2024-01": 100, "2024-02": 200 });
  assert.equal(east.rowTotal, 300);
  assert.deepEqual(matrix.columnTotals, { "2024-01": 150, "2024-02": 350 });
  assert.equal(matrix.grandTotal, 500);
});

test("buildPivotMatrix aggregates duplicate row/col pairs", () => {
  const matrix = buildPivotMatrix([
    { rowKey: "A", colKey: "X", value: 10 },
    { rowKey: "A", colKey: "X", value: 5 },
    { rowKey: "A", colKey: "Y", value: 7 },
  ]);
  const a = matrix.rows.find((r) => r.rowKey === "A")!;
  assert.equal(a.cells["X"], 15);
  assert.equal(a.rowTotal, 22);
  assert.equal(matrix.grandTotal, 22);
});

// ---- pearson / spearman ----

test("pearson returns 1 for a perfect positive linear relationship", () => {
  assert.equal(
    pearson([
      { x: 1, y: 2 },
      { x: 2, y: 4 },
      { x: 3, y: 6 },
    ]),
    1,
  );
});

test("pearson returns -1 for a perfect negative linear relationship", () => {
  assert.equal(
    pearson([
      { x: 1, y: 6 },
      { x: 2, y: 4 },
      { x: 3, y: 2 },
    ]),
    -1,
  );
});

test("pearson returns null for constant input or too few points", () => {
  assert.equal(
    pearson([
      { x: 5, y: 1 },
      { x: 5, y: 2 },
    ]),
    null,
  );
  assert.equal(pearson([{ x: 1, y: 2 }]), null);
});

test("spearman handles ties via average ranks", () => {
  const rho = spearman([
    { x: 1, y: 2 },
    { x: 1, y: 3 },
    { x: 2, y: 4 },
  ]);
  assert.ok(rho !== null && Math.abs(rho - 0.866) < 0.01);
});

test("correlationLabel buckets |r| coarsely", () => {
  assert.equal(correlationLabel(0.9), "strong");
  assert.equal(correlationLabel(0.6), "moderate");
  assert.equal(correlationLabel(0.3), "weak");
  assert.equal(correlationLabel(0.05), "negligible");
  assert.equal(correlationLabel(-0.85), "strong");
});

// ---- percentile / histogram ----

test("percentile interpolates between sorted values", () => {
  assert.equal(percentile([10, 20, 30], 50), 20);
  assert.equal(percentile([10, 20, 30], 25), 15);
  assert.equal(percentile([10, 20, 30], 75), 25);
  assert.equal(percentile([], 50), null);
});

test("histogram distributes values into equal-width bins", () => {
  const hist = histogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { bucketCount: 5 });
  assert.equal(hist.total, 10);
  assert.equal(hist.min, 1);
  assert.equal(hist.max, 10);
  assert.equal(hist.bins.length, 5);
  assert.deepEqual(hist.bins.map((b) => b.count), [2, 2, 2, 2, 2]);
  assert.equal(hist.bins[0].pct, 20);
});

test("histogram puts a single distinct value in the first bin", () => {
  const hist = histogram([5, 5, 5], { bucketCount: 4 });
  assert.equal(hist.bins.length, 4);
  assert.equal(hist.bins[0].count, 3);
});

test("histogram is empty for no numeric input", () => {
  const hist = histogram([], { bucketCount: 5 });
  assert.equal(hist.bins.length, 0);
  assert.equal(hist.total, 0);
});

// ---- shareOfTotal ----

test("shareOfTotal computes shares, cumulative %, and baseline delta", () => {
  const result = shareOfTotal(
    [
      { key: "A", value: 60 },
      { key: "B", value: 30 },
      { key: "C", value: 10 },
    ],
    [
      { key: "A", value: 30 },
      { key: "B", value: 50 },
      { key: "C", value: 20 },
    ],
  );
  assert.equal(result.total, 100);
  assert.equal(result.baselineTotal, 100);
  assert.deepEqual(result.rows.map((r) => r.key), ["A", "B", "C"]);

  const a = result.rows[0];
  assert.equal(a.pctOfTotal, 60);
  assert.equal(a.cumulativePct, 60);
  assert.equal(a.baselinePct, 30);
  assert.equal(a.shareDeltaPts, 30);
  assert.equal(a.valueChange, 30);

  const b = result.rows[1];
  assert.equal(b.cumulativePct, 90);
  assert.equal(b.shareDeltaPts, -20);
});

test("shareOfTotal without baseline leaves baseline fields null", () => {
  const result = shareOfTotal([{ key: "A", value: 100 }]);
  assert.equal(result.baselineTotal, null);
  assert.equal(result.rows[0].baselineValue, null);
  assert.equal(result.rows[0].shareDeltaPts, null);
});
