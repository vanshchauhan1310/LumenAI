/**
 * Provider-agnostic chat message and tool-calling shapes. Every adapter
 * (Anthropic, OpenAI, ...) translates to/from these types, so the
 * orchestration loop never touches a provider SDK directly.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ToolCallRequest[];
  /** Present on tool-result messages fed back to the model. */
  toolCallId?: string;
  toolName?: string;
  /**
   * Present on a "tool" message whose result is an image (e.g. get_view_image)
   * that the model should actually see, not just read a description of.
   * Each adapter decides how to deliver it — Anthropic can embed an image
   * block directly in the tool_result; OpenAI-compatible chat APIs don't
   * support images on tool-role messages at all, so those adapters inject a
   * follow-up user message carrying the image instead.
   */
  image?: { mediaType: string; base64: string };
}

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, any>;
  /**
   * Gemini 3 thinking models stamp every functionCall part with an opaque
   * `thoughtSignature` that MUST be echoed back on the model message when the
   * call is replayed on a later turn — omitting it 400s with "Function call is
   * missing a thought_signature". Only the Gemini adapter reads/writes this;
   * other providers ignore it entirely.
   */
  thoughtSignature?: string;
}

export type LlmTurnResult =
  | {
      type: "final_answer";
      text: string;
      usage?: LlmUsageMetrics;
      /**
       * Provider finish_reason, passed through so the orchestration loop can
       * detect a length-truncated answer ("length") and continue generation
       * instead of delivering a silently incomplete reply to the user.
       */
      finishReason?: string;
    }
  | { type: "tool_calls"; calls: ToolCallRequest[]; assistantText?: string; usage?: LlmUsageMetrics };

/** Provider-agnostic token counts for one turn, reported by the adapter. */
export interface LlmUsageMetrics {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmAdapter {
  /** One round trip: send history + tools, get back a final answer or pending tool calls. */
  sendTurn(history: ChatMessage[], tools: ToolDefinition[]): Promise<LlmTurnResult>;
  /** Cheap call used to validate a BYOK key before saving it. Throws on invalid key. */
  validateKey(): Promise<void>;
  /**
   * Lists model IDs this key can access, for the "Load models" dropdown in
   * the Connect LLM UI. Optional: not every provider's listing endpoint is
   * trustworthy (see NvidiaAdapter) or exists at all — omitting this method
   * (or throwing) just means the UI falls back to manual model entry, never
   * a hard failure.
   */
  listModels?(): Promise<string[]>;
}
