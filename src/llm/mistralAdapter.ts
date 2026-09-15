import { OpenAiAdapter } from "./openaiAdapter.js";

const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

/**
 * Mistral exposes an OpenAI-compatible /v1/chat/completions endpoint, so
 * this adapter is just the OpenAI adapter pointed at Mistral's base URL —
 * same shape as nvidiaAdapter.ts / openrouterAdapter.ts / groqAdapter.ts.
 * Mistral's /v1/models requires a valid key (unlike NVIDIA's, which doesn't
 * check auth at all), so the inherited default validateKey() (a plain
 * models.list() call) is a cheap, sufficient check — no override needed,
 * same reasoning as GroqAdapter.
 */
export class MistralAdapter extends OpenAiAdapter {
  constructor(apiKey: string, model: string) {
    super(apiKey, model, MISTRAL_BASE_URL);
  }
}
