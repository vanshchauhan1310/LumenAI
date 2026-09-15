import OpenAI from "openai";
import { ChatMessage, LlmAdapter, LlmTurnResult, ToolCallRequest, ToolDefinition } from "./types.js";

export class OpenAiAdapter implements LlmAdapter {
  protected client: OpenAI;

  constructor(
    apiKey: string,
    protected model: string,
    baseURL?: string,
  ) {
    // A bounded client-wide timeout means a genuinely stuck provider still
    // fails with a clear error instead of hanging on the SDK's ~10 min
    // default — but it needs to be generous enough to survive real
    // cold-start latency on hosted inference (NIM/OpenRouter community
    // models, especially 70B+ ones, can take 30-60s on first invocation).
    this.client = new OpenAI({ apiKey, timeout: 60_000, ...(baseURL ? { baseURL } : {}) });
  }

  async validateKey(): Promise<void> {
    await this.client.models.list();
  }

  async listModels(): Promise<string[]> {
    const page = await this.client.models.list();
    return page.data.map((m) => m.id).sort((a, b) => a.localeCompare(b));
  }

  async sendTurn(history: ChatMessage[], tools: ToolDefinition[]): Promise<LlmTurnResult> {
    const messages = toOpenAiMessages(history);

    // When max_tokens is omitted, NVIDIA NIM defaults to ~1024 completion
    // tokens — a final answer quoting several full workbook descriptions
    // exceeds that and gets SILENTLY CUT OFF (finish_reason: "length",
    // which nothing checked). Pin a generous ceiling so long verbatim
    // answers always fit; the model stops on its own well before this.
    // 8192 is under the output limit of every model this platform exposes;
    // a few NIM deployments still reject a very high max_tokens for a
    // specific model, so sendTurn falls back to 4096 once (see catch below).
    // The orchestration loop's finishReason === "length" continue-rounds
    // carry any answer longer than whatever budget ultimately sticks.
    const create = (maxTokens: number) =>
      this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: maxTokens,
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
        // Several community-hosted models (seen on NVIDIA NIM and OpenRouter)
        // have chat templates that reject a response containing more than one
        // tool_use block at once ("This model only supports single tool-calls
        // at once!"). Forcing one call per turn avoids that entirely — the
        // orchestration loop already handles multiple rounds fine, so this
        // just costs an extra round trip, never correctness.
        parallel_tool_calls: false,
      });

    let response: Awaited<ReturnType<typeof create>>;
    try {
      response = await create(8192);
    } catch (err: any) {
      const msgText = String(err?.error?.message) + String(err?.message ?? "");
      if (err?.status === 400 && /max[_\- ]?tokens?|maximum (output|context|sequence)|context length|output length|sequence length/i.test(msgText)) {
        console.warn(`[llm] max_tokens=8192 rejected by provider (${msgText.slice(0, 140)}) — retrying once at 4096`);
        response = await create(4096);
      } else {
        // Retry connection-level errors once — DNS blips, socket hang-ups, etc.
        const errName = err?.constructor?.name ?? err?.name ?? "";
        const isConnectionErr = errName === "APIConnectionError" || /connection\s*error|econnrefused|econnreset|etimedout|enotfound|getaddrinfo|socket hang up/i.test(msgText + String(err?.message ?? ""));
        if (isConnectionErr) {
          console.warn(`[llm] Connection error on first attempt (${err?.message ?? err}) — retrying once`);
          response = await create(8192);
        } else {
          throw err;
        }
      }
    }

    const choice = response.choices[0];
    const msg = choice.message;

    // All OpenAI-compatible backends (OpenAI, Groq, NIM, OpenRouter) put token
    // usage on the top-level response.usage object — pass it through so the
    // orchestration loop can meter/cost it. Subclass adapters inherit this.
    const usage =
      response.usage?.prompt_tokens !== undefined
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens ?? 0,
          }
        : undefined;

    if (msg.tool_calls?.length) {
      const calls: ToolCallRequest[] = msg.tool_calls.map((tc, i) => ({
        // Some OpenAI-compatible backends (community-hosted models via NIM/
        // vLLM function-calling emulation, seen on NVIDIA + OpenRouter) don't
        // reliably populate tool_calls[].id. If we pass that undefined value
        // straight into the next round's request, JSON.stringify silently
        // drops the key — producing a tool_calls entry with NO id field,
        // which strict backends then reject with "missing field `id`".
        // Generate a stable fallback so that can never happen.
        id: tc.id || `call_${Date.now()}_${i}`,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || "{}"),
      }));
      return { type: "tool_calls", calls, assistantText: msg.content || undefined, usage };
    }

    return {
      type: "final_answer",
      text: msg.content ?? "",
      usage,
      // "length" means the completion hit max_tokens mid-answer — the loop
      // in chat.ts uses this to ask the model to continue instead of
      // delivering a cut-off answer as if it were complete.
      finishReason: choice.finish_reason ?? undefined,
    };
  }
}

function pushToolResult(messages: OpenAI.Chat.ChatCompletionMessageParam[], m: ChatMessage) {
  messages.push({ role: "tool", tool_call_id: m.toolCallId!, content: m.content });
  // The Chat Completions API doesn't support images on tool-role messages at
  // all (only user/assistant content parts do). Deliver the image via an
  // immediate follow-up user message instead, so a vision-capable model
  // still actually sees it.
  if (m.image) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `Here is the image from the "${m.toolName ?? "tool"}" call above:` },
        { type: "image_url", image_url: { url: `data:${m.image.mediaType};base64,${m.image.base64}` } },
      ],
    });
  }
}

function toOpenAiMessages(history: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  let i = 0;
  while (i < history.length) {
    const m = history[i];

    if (m.role === "system") {
      messages.push({ role: "system", content: m.content });
      i++;
    } else if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
      i++;
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      // Some backends (NVIDIA NIM, OpenRouter community models) reject ANY
      // request — including replayed history — where a single assistant
      // message carries more than one tool_calls entry. Rather than only
      // preventing new multi-call responses (parallel_tool_calls: false
      // above handles that), also split any multi-call assistant turn —
      // old or new — into one assistant message per call, each immediately
      // followed by its own tool result. This keeps old conversations that
      // predate that setting (or that hit a provider that ignored it)
      // working on every future turn, not just the one that created them.
      const followingToolMsgs = history.slice(i + 1, i + 1 + m.toolCalls.length).filter((t) => t.role === "tool");
      m.toolCalls.forEach((call, idx) => {
        messages.push({
          role: "assistant",
          content: idx === 0 ? m.content || null : null,
          tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }],
        });
        const result = followingToolMsgs.find((t) => t.toolCallId === call.id) ?? followingToolMsgs[idx];
        if (result) pushToolResult(messages, result);
      });
      i += 1 + followingToolMsgs.length;
    } else if (m.role === "assistant") {
      messages.push({ role: "assistant", content: m.content });
      i++;
    } else if (m.role === "tool") {
      // Orphan tool message not preceded by its assistant call in this scan
      // (shouldn't normally happen, but don't drop it silently).
      pushToolResult(messages, m);
      i++;
    } else {
      i++;
    }
  }
  return messages;
}
