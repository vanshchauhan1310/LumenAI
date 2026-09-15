import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, lookupRate } from "../src/lib/pricing.js";

test("gpt-4o-mini prices tokens at the mini rate", () => {
  // 1M prompt + 1M completion tokens == 0.15 + 0.60 = 0.75
  assert.equal(estimateCostUsd("openai", "gpt-4o-mini", 1_000_000, 1_000_000), 0.75);
});

test("gpt-4o (broad) matches before the gpt-4 legacy rate", () => {
  // prompt $2.5/M, completion $10/M -> 100k prompt + 50k completion = 0.25 + 0.5 = 0.75
  assert.equal(estimateCostUsd("openai", "gpt-4o-2024-08-06", 100_000, 50_000), 0.75);
});

test("claude sonnet family", () => {
  // $3/M prompt + $15/M completion -> 100k/20k = 0.3 + 0.3 = 0.6
  assert.equal(estimateCostUsd("anthropic", "claude-sonnet-4-20250514", 100_000, 20_000), 0.6);
});

test("gemini flash vs pro tiering", () => {
  assert.ok(estimateCostUsd("gemini", "gemini-2.5-flash", 1_000_000, 0)! < estimateCostUsd("gemini", "gemini-3-pro", 1_000_000, 0)!);
});

test("openrouter :free models cost nothing", () => {
  assert.equal(estimateCostUsd("openrouter", "meta-llama/llama-3.3-70b-instruct:free", 1_000_000, 1_000_000), 0);
});

test("unknown provider returns null (no rate)", () => {
  assert.equal(estimateCostUsd("mystery-provider", "some-model", 1000, 1000), null);
});

test("recognized provider with unmatched model gets a generic estimate", () => {
  assert.ok(lookupRate("openai", "weird-custom-model") !== null);
  assert.equal(estimateCostUsd("openai", "weird-custom-model", 1_000_000, 1_000_000), 4);
});

test("zero tokens costs nothing", () => {
  assert.equal(estimateCostUsd("openai", "gpt-4o-mini", 0, 0), 0);
});
