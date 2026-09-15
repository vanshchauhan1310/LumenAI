import { OpenAiAdapter } from "./openaiAdapter.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

/**
 * DeepSeek exposes an OpenAI-compatible /v1/chat/completions endpoint, so
 * this adapter is just the OpenAI adapter pointed at DeepSeek's base URL —
 * same shape as nvidiaAdapter.ts / openrouterAdapter.ts / groqAdapter.ts.
 * DeepSeek's /v1/models requires a valid key, so the inherited default
 * validateKey() (a plain models.list() call) is a cheap, sufficient check —
 * no override needed, same reasoning as GroqAdapter/MistralAdapter.
 */
export class DeepseekAdapter extends OpenAiAdapter {
  constructor(apiKey: string, model: string) {
    super(apiKey, model, DEEPSEEK_BASE_URL);
  }
}
