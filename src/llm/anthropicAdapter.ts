import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import { ChatMessage, LlmAdapter, LlmTurnResult, ToolCallRequest, ToolDefinition } from "./types.js";

export class AnthropicAdapter implements LlmAdapter {
  private client: Anthropic;

  constructor(
    private apiKey: string,
    private model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async validateKey(): Promise<void> {
    // Cheapest possible call that still authenticates the key. A short
    // per-call timeout means a stalled/misbehaving key fails fast with a
    // clear error instead of hanging the UI on the SDK's ~10 min default.
    await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      },
      { timeout: 20_000 },
    );
  }

  // The installed @anthropic-ai/sdk (0.32.1) predates its models.list()
  // helper, so this calls Anthropic's REST endpoint directly with axios
  // (already a project dependency) rather than bumping the SDK version —
  // same "talk to the REST API directly" approach as GeminiAdapter uses
  // throughout. anthropic-version matches what the SDK itself sends
  // (see node_modules/@anthropic-ai/sdk/index.js).
  async listModels(): Promise<string[]> {
    const res = await axios.get("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      timeout: 20_000,
    });
    const data: Array<{ id: string }> = res.data?.data ?? [];
    return data.map((m) => m.id).sort((a, b) => a.localeCompare(b));
  }

  async sendTurn(history: ChatMessage[], tools: ToolDefinition[]): Promise<LlmTurnResult> {
    // Anthropic takes the system prompt as a separate top-level field, not a
    // message in the array — pull any "system" role entries out.
    const system = history.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = toAnthropicMessages(history.filter((m) => m.role !== "system"));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      ...(system ? { system } : {}),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as any,
      })),
      messages,
    });

    const toolCalls: ToolCallRequest[] = [];
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: block.input as any });
      }
    }

    const usage =
      response.usage?.input_tokens !== undefined
        ? {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens ?? 0,
          }
        : undefined;

    if (toolCalls.length > 0) {
      return { type: "tool_calls", calls: toolCalls, assistantText: text || undefined, usage };
    }
    return { type: "final_answer", text, usage };
  }
}

function toAnthropicMessages(history: ChatMessage[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const m of history) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.toolCalls?.length) {
        const content: any[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const call of m.toolCalls) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
        }
        messages.push({ role: "assistant", content });
      } else {
        messages.push({ role: "assistant", content: m.content });
      }
    } else if (m.role === "tool") {
      // Anthropic supports an image block directly inside tool_result
      // content — the model actually sees the pixels, not just a
      // description of them.
      const toolResultContent: any = m.image
        ? [
            { type: "text", text: m.content },
            { type: "image", source: { type: "base64", media_type: m.image.mediaType, data: m.image.base64 } },
          ]
        : m.content;
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId!,
            content: toolResultContent,
          },
        ],
      });
    }
  }
  return messages;
}
