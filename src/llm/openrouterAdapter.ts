import { OpenAiAdapter } from "./openaiAdapter.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter is a separate gateway from NVIDIA NIM — different host, different
 * key format (sk-or-v1-...) — even when routing to the same underlying model
 * (e.g. "nvidia/nemotron-...:free"). It exposes an OpenAI-compatible
 * /v1/chat/completions endpoint, so this is the OpenAI adapter pointed at
 * OpenRouter's base URL.
 */
export class OpenRouterAdapter extends OpenAiAdapter {
  constructor(apiKey: string, model: string) {
    super(apiKey, model, OPENROUTER_BASE_URL);
  }

  async validateKey(): Promise<void> {
    await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
  }
}
