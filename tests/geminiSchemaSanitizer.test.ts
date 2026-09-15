import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeGeminiSchema, toGeminiContents } from "../src/llm/geminiAdapter.js";

/**
 * Guards the Gemini function-calling schema sanitizer against the real-world
 * failure it was written for: the shared tool definitions use JSON-Schema
 * union types (type: ["string", "number"] in query_datasource's filter
 * values/min/max), which Gemini's OpenAPI-3.0 subset rejects with "Proto
 * field is not repeating, cannot start list" — 400ing the entire request
 * before any tool runs.
 */

test("converts union-type arrays to a single string type (the query_datasource case)", () => {
  const out = sanitizeGeminiSchema({
    type: "object",
    properties: {
      filters: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fieldCaption: { type: "string" },
            filterType: { type: "string", enum: ["SET", "DATE_RANGE"] },
            values: { type: "array", items: { type: ["string", "number"] } },
            min: { type: ["string", "number"] },
            max: { type: ["string", "number"] },
          },
          required: ["fieldCaption", "filterType"],
        },
      },
    },
  });

  assert.deepEqual(out, {
    type: "object",
    properties: {
      filters: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fieldCaption: { type: "string" },
            filterType: { type: "string", enum: ["SET", "DATE_RANGE"] },
            values: { type: "array", items: { type: "string" } },
            min: { type: "string" },
            max: { type: "string" },
          },
          required: ["fieldCaption", "filterType"],
        },
      },
    },
  });
});

test("prefers string over number when both are in the union", () => {
  const out = sanitizeGeminiSchema({ type: ["number", "string"] });
  assert.equal(out.type, "string");
});

test("falls back to the first listed type when string is absent", () => {
  const out = sanitizeGeminiSchema({ type: ["number", "boolean"] });
  assert.equal(out.type, "number");
});

test("keeps the supported keywords (default, minimum, maximum, enum) intact", () => {
  const out = sanitizeGeminiSchema({
    type: "integer",
    minimum: 1,
    maximum: 500,
    default: 100,
    description: "Max results",
  });
  assert.deepEqual(out, {
    type: "integer",
    minimum: 1,
    maximum: 500,
    default: 100,
    description: "Max results",
  });
});

test("drops unsupported keywords and does not mutate the input schema", () => {
  const input = {
    type: "object",
    properties: { x: { type: "string" } },
    additionalProperties: false,
    $defs: { anything: {} },
  };
  const out = sanitizeGeminiSchema(input);

  assert.deepEqual(out, { type: "object", properties: { x: { type: "string" } } });
  assert.ok("additionalProperties" in input, "input must not be mutated");
});

// ---- thought_signature (Gemini 3 thinking models) ----

test("echoes the thoughtSignature back on a replayed functionCall part", () => {
  const contents = toGeminiContents([
    { role: "system", content: "sys" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "fc_1", name: "get_view_image", input: { viewId: "v1" }, thoughtSignature: "sig-abc" }],
    },
    { role: "tool", content: '{"ok":true}', toolCallId: "fc_1", toolName: "get_view_image" },
  ]);

  assert.equal(contents[0].role, "model");
  assert.equal(contents[0].parts[0].functionCall.name, "get_view_image");
  assert.equal(contents[0].parts[0].thoughtSignature, "sig-abc");
});

test("omits thoughtSignature when the call has none (non-thinking models)", () => {
  const contents = toGeminiContents([
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "fc_1", name: "list_projects", input: {} }],
    },
    { role: "tool", content: '{"total":0}', toolCallId: "fc_1", toolName: "list_projects" },
  ]);

  assert.equal("thoughtSignature" in contents[0].parts[0], false);
});

test("replays embedded tool results as functionResponse parts so no functionCall dangles", () => {
  // Reconstructed history from the DB: the final assistant message carries its
  // whole turn's call log, each call with its result inline (no separate
  // tool-role messages). Gemini needs a functionResponse to follow each
  // functionCall.
  const contents = toGeminiContents([
    { role: "system", content: "sys" },
    { role: "user", content: "sales by region?" },
    {
      role: "assistant",
      content: "Here are the numbers...",
      // Reconstructed from the DB, where the persisted call log (JSON) carries
      // `result` alongside the ToolCallRequest fields — hence the any cast.
      toolCalls: [
        {
          id: "fc_1",
          name: "query_datasource",
          input: { datasourceLuid: "L1" },
          thoughtSignature: "sig-1",
          result: { rows: [{ Region: "East", Sales: 100 }], rowCount: 1 },
        },
      ] as any,
    },
  ]);

  const modelContent = contents.find((c) => c.role === "model");
  const callPart = modelContent.parts.find((p: any) => p.functionCall);
  assert.equal(callPart.functionCall.name, "query_datasource");
  assert.equal(callPart.thoughtSignature, "sig-1");

  const responseContent = contents.find((c) => c.role === "user" && c.parts[0]?.functionResponse);
  assert.equal(responseContent.parts[0].functionResponse.name, "query_datasource");
  assert.equal(responseContent.parts[0].functionResponse.id, "fc_1");
  assert.deepEqual(responseContent.parts[0].functionResponse.response, {
    rows: [{ Region: "East", Sales: 100 }],
    rowCount: 1,
  });
});
