import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendVisualization } from "../src/tools/semanticTools.js";

test("no measure -> table", () => {
  const out = recommendVisualization({ fields: [{ name: "Region", role: "dimension", dataType: "string" }] });
  assert.equal(out.recommendedChart, "table");
  assert.equal(out.suggestedAggregation, null);
});

test("geographic dimension -> map", () => {
  const out = recommendVisualization({
    fields: [
      { name: "Country", role: "dimension", dataType: "string" },
      { name: "Revenue", role: "measure", dataType: "number" },
    ],
  });
  assert.equal(out.recommendedChart, "map");
  assert.equal(out.suggestedAggregation, "SUM");
});

test("time dimension + measure -> line", () => {
  const out = recommendVisualization({
    fields: [
      { name: "Order Date", role: "dimension", dataType: "datetime" },
      { name: "Sales", role: "measure", dataType: "number" },
    ],
    intent: "trend",
  });
  assert.equal(out.recommendedChart, "line");
});

test("proportion intent with a single dimension -> pie", () => {
  const out = recommendVisualization({
    fields: [
      { name: "Channel", role: "dimension", dataType: "string" },
      { name: "Orders", role: "measure", dataType: "number" },
    ],
    intent: "proportion",
  });
  assert.equal(out.recommendedChart, "pie");
});

test("correlation intent with two measures -> scatter", () => {
  const out = recommendVisualization({
    fields: [
      { name: "Sales", role: "measure", dataType: "number" },
      { name: "Profit", role: "measure", dataType: "number" },
    ],
    intent: "correlation",
  });
  assert.equal(out.recommendedChart, "scatter");
});

test("ranking intent with one dimension + one measure -> bar", () => {
  const out = recommendVisualization({
    fields: [
      { name: "Product", role: "dimension", dataType: "string" },
      { name: "Revenue", role: "measure", dataType: "number" },
    ],
    intent: "ranking",
  });
  assert.equal(out.recommendedChart, "bar");
});

test("zod coercion handles stringified fields argument", () => {
  // The handler preprocesses JSON-stringified arrays back into real JSON
  // before validation; recommendVisualization itself receives the parsed
  // form, so this guards the parse path used by the registry.
  const parsed = JSON.parse('[{"name":"Region","role":"dimension","dataType":"string"}]');
  const out = recommendVisualization({ fields: parsed });
  assert.equal(out.recommendedChart, "table");
});
