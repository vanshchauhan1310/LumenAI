import { OpenAiAdapter } from "./openaiAdapter.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * Groq exposes an OpenAI-compatible /v1/chat/completions endpoint, so this
 * adapter is just the OpenAI adapter pointed at Groq's base URL — same
 * shape as nvidiaAdapter.ts / openrouterAdapter.ts. Some Groq-hosted models
 * (e.g. Llama vision variants) support image inputs; that works "for free"
 * here since image delivery (get_view_image results -> follow-up user
 * message with image_url) is already implemented generically in
 * OpenAiAdapter, not per-provider.
 *
 * Unlike NVIDIA (whose /v1/models endpoint doesn't check auth at all), Groq's
 * /v1/models does require a valid key, so the inherited default validateKey()
 * (a plain models.list() call) is a cheap, sufficient check — no need to
 * override with a real chat completion like the NVIDIA/OpenRouter adapters do.
 */
export class GroqAdapter extends OpenAiAdapter {
  constructor(apiKey: string, model: string) {
    super(apiKey, model, GROQ_BASE_URL);
  }
}
