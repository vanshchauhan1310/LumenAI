import { LlmAdapter } from "./types.js";
import { AnthropicAdapter } from "./anthropicAdapter.js";
import { OpenAiAdapter } from "./openaiAdapter.js";
import { NvidiaAdapter } from "./nvidiaAdapter.js";
import { OpenRouterAdapter } from "./openrouterAdapter.js";
import { GroqAdapter } from "./groqAdapter.js";
import { GeminiAdapter } from "./geminiAdapter.js";
import { MistralAdapter } from "./mistralAdapter.js";
import { DeepseekAdapter } from "./deepseekAdapter.js";

export type LlmProviderName = "anthropic" | "openai" | "nvidia" | "openrouter" | "groq" | "gemini" | "mistral" | "deepseek";

/**
 * Adding another provider: implement LlmAdapter in a new file, add one case
 * here. Nothing else in the codebase needs to change.
 */
export function createLlmAdapter(provider: LlmProviderName, apiKey: string, model: string): LlmAdapter {
  switch (provider) {
    case "anthropic":
      return new AnthropicAdapter(apiKey, model);
    case "openai":
      return new OpenAiAdapter(apiKey, model);
    case "nvidia":
      return new NvidiaAdapter(apiKey, model);
    case "openrouter":
      return new OpenRouterAdapter(apiKey, model);
    case "groq":
      return new GroqAdapter(apiKey, model);
    case "gemini":
      return new GeminiAdapter(apiKey, model);
    case "mistral":
      return new MistralAdapter(apiKey, model);
    case "deepseek":
      return new DeepseekAdapter(apiKey, model);
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}
