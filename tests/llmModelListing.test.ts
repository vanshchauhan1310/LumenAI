import { test, mock } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { OpenAiAdapter } from "../src/llm/openaiAdapter.js";
import { NvidiaAdapter } from "../src/llm/nvidiaAdapter.js";
import { AnthropicAdapter } from "../src/llm/anthropicAdapter.js";
import { GeminiAdapter } from "../src/llm/geminiAdapter.js";

/**
 * Covers listModels() on each adapter family — the "Load models" dropdown's
 * data source. Each provider talks to a different underlying transport
 * (OpenAI SDK client, a hand-rolled static list, or raw axios), so each gets
 * its own mocking approach rather than one shared harness.
 */

test("OpenAiAdapter.listModels sorts ids alphabetically (shared base for openai/openrouter/groq/mistral/deepseek)", async () => {
  const adapter = new OpenAiAdapter("fake-key", "gpt-4o");
  mock.method((adapter as any).client.models, "list", async () => ({
    data: [{ id: "gpt-4o" }, { id: "gpt-3.5-turbo" }, { id: "o1-mini" }],
  }));

  const models = await adapter.listModels!();
  assert.deepEqual(models, ["gpt-3.5-turbo", "gpt-4o", "o1-mini"]);
});

test("NvidiaAdapter.listModels returns the curated static list (NIM's own /v1/models isn't trustworthy)", async () => {
  const adapter = new NvidiaAdapter("fake-key", "meta/llama-3.1-8b-instruct");
  const models = await adapter.listModels!();

  assert.ok(models.length > 0);
  assert.ok(models.includes("meta/llama-3.1-8b-instruct"));
});

test("AnthropicAdapter.listModels calls the REST endpoint directly (installed SDK predates models.list())", async () => {
  let calledUrl = "";
  let calledHeaders: any = {};
  mock.method(axios, "get", async (url: string, config: any) => {
    calledUrl = url;
    calledHeaders = config?.headers;
    return { data: { data: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5" }] } };
  });

  const adapter = new AnthropicAdapter("fake-key", "claude-sonnet-5");
  const models = await adapter.listModels!();

  assert.equal(calledUrl, "https://api.anthropic.com/v1/models");
  assert.equal(calledHeaders["x-api-key"], "fake-key");
  assert.equal(calledHeaders["anthropic-version"], "2023-06-01");
  assert.deepEqual(models, ["claude-haiku-4-5", "claude-sonnet-5"]);
});

test("GeminiAdapter.listModels filters to models supporting generateContent and strips the models/ prefix", async () => {
  const adapter = new GeminiAdapter("fake-key", "gemini-3.5-flash");
  mock.method((adapter as any).http, "get", async (path: string) => {
    assert.equal(path, "/models");
    return {
      data: {
        models: [
          { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-3-pro", supportedGenerationMethods: ["generateContent", "countTokens"] },
        ],
      },
    };
  });

  const models = await adapter.listModels!();
  assert.deepEqual(models, ["gemini-3-pro", "gemini-3.5-flash"]);
});
