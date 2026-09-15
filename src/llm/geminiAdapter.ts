import axios, { AxiosInstance } from "axios";
import { ChatMessage, LlmAdapter, LlmTurnResult, ToolCallRequest, ToolDefinition } from "./types.js";

/**
 * Gemini (Google AI Studio / AIza... keys) speaks its own REST protocol — it
 * is NOT OpenAI-compatible, so unlike nvidiaAdapter/groqAdapter/openrouterAdapter
 * this adapter can't just subclass OpenAiAdapter. We talk to the v1beta
 * generateContent endpoint directly with axios (already a dependency):
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *         ?key={apiKey}
 *
 * Mapping from this app's provider-agnostic ChatMessage to Gemini:
 * - system role  -> top-level `systemInstruction`
 * - user role    -> contents entry with role "user"
 * - assistant    -> contents entry with role "model" (text + functionCall parts)
 * - tool result  -> contents entry with role "user" carrying a functionResponse
 *   part. Gemini 3 always stamps every functionCall with a unique `id`, and
 *   requires the matching functionResponse to echo that exact `id` alongside
 *   `name` — we always send both (older 2.x models accept the extra id).
 * - tool result that is an image (get_view_image) -> Gemini doesn't support
 *   images on a functionResponse, so like OpenAiAdapter we deliver the pixels
 *   via an immediate follow-up user content with an inlineData part, which
 *   every multimodal Gemini model accepts.
 */
export class GeminiAdapter implements LlmAdapter {
  private http: AxiosInstance;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    // Model names arrive as the bare form (e.g. "gemini-3.5-flash"), but some
    // users paste them with a "models/" prefix from the docs. Strip it so the
    // URL always reads /models/{name}:generateContent exactly once.
    this.model = model.replace(/^models\//, "");

    // generateContent authenticates via the ?key= query parameter (or the
    // x-goog-api-key header). A bounded timeout means a stuck request fails
    // with a clear error instead of hanging — generous because Gemini 3
    // thinking models can take a while on first invocation.
    this.http = axios.create({
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      params: { key: apiKey },
      timeout: 90_000,
    });
  }

  async validateKey(): Promise<void> {
    // The cheapest call that authenticates the key AND proves the typed model
    // name exists. (A wrong model name 404s here; a bad key 400s with "API key
    // not valid" — normalized to 401 below so the UI can say "key rejected".)
    // Gemini's free-tier models routinely 503 ("high demand") for a few
    // seconds; retry a couple of times before surfacing it to the user.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.http.post(`/models/${this.model}:generateContent`, {
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 1 },
        });
        return;
      } catch (err) {
        const normalized = normalizeError(err);
        if (attempt < 3 && normalized?.status === 503) {
          await new Promise((r) => setTimeout(r, attempt * 1500));
          continue;
        }
        throw normalized;
      }
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await this.http.get("/models");
      const models: Array<{ name: string; supportedGenerationMethods?: string[] }> = res.data?.models ?? [];
      return models
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""))
        .sort((a, b) => a.localeCompare(b));
    } catch (err) {
      throw normalizeError(err);
    }
  }

  async sendTurn(history: ChatMessage[], tools: ToolDefinition[]): Promise<LlmTurnResult> {
    const system = history.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");

    const body: Record<string, any> = { contents: toGeminiContents(history) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            // Gemini's function-declaration schema is a strict subset of
            // OpenAPI 3.0 — a full JSON-Schema (like query_datasource's
            // `type: ["string", "number"]` unions) makes the whole request
            // 400 with "Unknown name type ... cannot start list". Sanitize
            // here so the other providers keep the richer shared schemas.
            parameters: sanitizeGeminiSchema(t.input_schema),
          })),
        },
      ];
    }
    body.generationConfig = { maxOutputTokens: 4096 };

    try {
      const res = await this.http.post(`/models/${this.model}:generateContent`, body);
      const data = res.data;

      const candidate = data?.candidates?.[0];
      if (!candidate?.content) {
        // Safety filters (and friends) block the whole response with no
        // candidate — surface it rather than pretending we got an answer.
        const blocked = data?.promptFeedback?.blockReason;
        if (blocked) throw { status: 400, error: { message: `The model refused to respond (${blocked}).` } };
        throw { status: 500, error: { message: "The AI provider returned an empty response." } };
      }

      const parts: any[] = candidate.content.parts ?? [];
      const text = parts.filter((p) => p.text).map((p) => p.text).join("");
      const calls: ToolCallRequest[] = [];
      parts.forEach((p, i) => {
        if (p.functionCall) {
          calls.push({
            // Gemini 3 always returns an id; older models may omit it — fall
            // back like the OpenAI adapter does so a missing id can never
            // produce a malformed request on the next turn.
            id: p.functionCall.id || `call_${Date.now()}_${i}`,
            name: p.functionCall.name,
            input: p.functionCall.args ?? {},
            // Gemini 3 thinking models put a sibling `thoughtSignature` on the
            // functionCall part and REQUIRE it back when the call is replayed
            // (else "missing a thought_signature" 400). Preserve it so
            // toGeminiContents can echo it on the next round.
            thoughtSignature: p.thoughtSignature,
          });
        }
      });

      // Gemini reports token usage on the response's usageMetadata object
      // (promptTokenCount for input, candidatesTokenCount for output).
      const usage =
        data?.usageMetadata?.promptTokenCount !== undefined
          ? {
              promptTokens: data.usageMetadata.promptTokenCount,
              completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
            }
          : undefined;

      if (calls.length > 0) {
        return { type: "tool_calls", calls, assistantText: text || undefined, usage };
      }
      return { type: "final_answer", text, usage };
    } catch (err) {
      throw normalizeError(err);
    }
  }
}

/**
 * ChatMessage history -> Gemini `contents` array. Each message becomes its own
 * content entry; a tool result with an image gets an extra follow-up user
 * content carrying the image as inlineData (the OpenAI-adapter approach —
 * Gemini, like OpenAI, can't put an image inside the functionResponse itself).
 */
export function toGeminiContents(history: ChatMessage[]): any[] {
  const contents: any[] = [];
  for (const m of history) {
    if (m.role === "system") continue; // pulled out into systemInstruction

    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      if (m.toolCalls?.length) {
        for (const call of m.toolCalls) {
          parts.push({
            functionCall: { name: call.name, args: call.input, ...(call.id ? { id: call.id } : {}) },
            // Echo the thought_signature back exactly as Gemini gave it — the
            // model message on replay MUST carry it or the API 400s.
            ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
          });
        }
      }
      contents.push({ role: "model", parts });

      // Replayed assistant messages (rebuilt from the DB) carry each call's
      // result inline on the call object (call.result) rather than as separate
      // tool-role messages — emit the matching functionResponse parts so Gemini
      // never sees a functionCall with no response following it (Gemini 3 is
      // strict about call/response pairing). Live in-memory turns handle their
      // tool results separately below and don't hit this branch.
      if (m.toolCalls?.length) {
        const responses: any[] = [];
        let hasResponse = false;
        for (const call of m.toolCalls) {
          const result = (call as any).result;
          if (result === undefined) continue;
          hasResponse = true;
          responses.push({
            functionResponse: {
              name: call.name,
              response: parseToolResponse(result),
              ...(call.id ? { id: call.id } : {}),
            },
          });
        }
        if (hasResponse) contents.push({ role: "user", parts: responses });
      }
    } else if (m.role === "tool") {
      const response = parseToolResponse(m.content);
      const functionResponse: any = { name: m.toolName!, response };
      if (m.toolCallId) functionResponse.id = m.toolCallId;
      contents.push({ role: "user", parts: [{ functionResponse }] });
      if (m.image) {
        contents.push({
          role: "user",
          parts: [{ inlineData: { mimeType: m.image.mediaType, data: m.image.base64 } }],
        });
      }
    }
  }
  return contents;
}

/**
 * Gemini's functionResponse.response must be a JSON object, but tool results
 * here arrive as arbitrary JSON strings (live turns) or already-parsed objects
 * (replayed results). Pass objects through as-is so the model sees the real
 * structure; parse JSON strings and wrap anything else in { result: ... }.
 */
function parseToolResponse(content: any): any {
  if (content && typeof content === "object" && !Array.isArray(content)) return content;
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return { result: content };
}

// The exact set of schema keywords Gemini's function-declaration Schema
// accepts (from the generateContent API reference). Anything else in the
// shared tool schemas is dropped. `default`/`minimum`/`maximum`/`enum` are
// on the list — those already appear in the tool schemas and pass through
// fine; it's the union types that were breaking the whole request.
const GEMINI_SCHEMA_KEYWORDS = new Set([
  "anyOf",
  "default",
  "description",
  "enum",
  "example",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "nullable",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
]);

/**
 * Recursively normalizes one JSON-Schema node down to Gemini's supported
 * subset, returning a deep copy (the shared toolDefinitions are never
 * mutated). The only in-place change to schema shape is union types —
 * JSON-Schema's `type: ["string", "number"]` (used by query_datasource's
 * filter values/min/max) has no equivalent in Gemini's OpenAPI-3.0 subset
 * and 400s the entire request with "Proto field is not repeating, cannot
 * start list". Prefer the "string" branch when present (the server-side zod
 * validator accepts strings for those args regardless), otherwise the first
 * listed type. Everything else is allowlisted through as-is.
 */
export function sanitizeGeminiSchema(node: any): any {
  if (Array.isArray(node)) return node.map(sanitizeGeminiSchema);
  if (!node || typeof node !== "object") return node;

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!GEMINI_SCHEMA_KEYWORDS.has(key)) continue;

    if (key === "type") {
      out.type = Array.isArray(value)
        ? value.includes("string")
          ? "string"
          : value[0]
        : value;
    } else if (key === "properties" && value && typeof value === "object") {
      // `properties` is a map of property-name -> schema, so the property
      // NAMES must not be run through the keyword allowlist — only each
      // property's own schema is.
      const props: Record<string, any> = {};
      for (const [name, sub] of Object.entries(value)) {
        props[name] = sanitizeGeminiSchema(sub);
      }
      out.properties = props;
    } else if ((key === "items" || key === "anyOf") && value && typeof value === "object") {
      out[key] = Array.isArray(value) ? value.map(sanitizeGeminiSchema) : sanitizeGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Turns axios/Gemini failures into the { status, error: { message } } shape
 * the rest of the app already understands (connections.ts's
 * summarizeValidationError and chat.ts's describeProviderError both read
 * err.status and err.error.message). Also normalizes Gemini's invalid-key
 * response — HTTP 400 with "API key not valid" — to a 401 so those helpers
 * classify it as a rejected key instead of a generic failure.
 */
function normalizeError(err: any): any {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const apiMessage = err.response?.data?.error?.message ?? err.message;

    let finalStatus = status ?? 500;
    if (status === 400 && /api key not valid/i.test(String(apiMessage))) {
      finalStatus = 401;
    }

    return {
      status: finalStatus,
      error: { message: apiMessage },
    };
  }
  return err;
}
