/**
 * Approximate per-1M-token USD pricing for the providers/models this app
 * supports (BYOK). These are published list prices as of mid-2026 and are
 * intentionally approximate — used only to estimate a cost for usage
 * metering, never for billing/ledgers. Returns null when a provider/model has
 * no known rate (the caller shows "unknown cost" then).
 *
 * Pure + deterministic: unit-tested in tests/pricing.test.ts.
 */

export interface Rate {
  promptPer1M: number;
  completionPer1M: number;
}

interface RateRule {
  /** Provider names this rule applies to (lowercase). Empty = any provider. */
  providers?: string[];
  /** Regex against the lowercase model name. */
  pattern: RegExp;
  rate: Rate;
}

const OPENAI_DEFAULT: Rate = { promptPer1M: 2.5, completionPer1M: 10 };

// Ordered: first match wins. More specific patterns come before their broad
// family fallbacks (e.g. gpt-4o-mini before gpt-4o).
const RULES: RateRule[] = [
  // ---- OpenAI ----
  { providers: ["openai"], pattern: /gpt-4o-mini/, rate: { promptPer1M: 0.15, completionPer1M: 0.6 } },
  { providers: ["openai"], pattern: /gpt-4\.1?-(mini|nano)?/, rate: { promptPer1M: 0.4, completionPer1M: 1.6 } },
  { providers: ["openai"], pattern: /gpt-4o/, rate: { promptPer1M: 2.5, completionPer1M: 10 } },
  { providers: ["openai"], pattern: /gpt-4(?!\.)/, rate: { promptPer1M: 30, completionPer1M: 60 } },
  { providers: ["openai"], pattern: /gpt-3\.5-turbo/, rate: { promptPer1M: 0.5, completionPer1M: 1.5 } },
  { providers: ["openai"], pattern: /o(1|3|4)-?mini/, rate: { promptPer1M: 1.1, completionPer1M: 4.4 } },
  { providers: ["openai"], pattern: /o(1|3|4)/, rate: { promptPer1M: 2.5, completionPer1M: 10 } },

  // ---- Anthropic ----
  { providers: ["anthropic"], pattern: /claude.*haiku/, rate: { promptPer1M: 0.8, completionPer1M: 4 } },
  { providers: ["anthropic"], pattern: /claude.*sonnet/, rate: { promptPer1M: 3, completionPer1M: 15 } },
  { providers: ["anthropic"], pattern: /claude.*opus/, rate: { promptPer1M: 15, completionPer1M: 75 } },

  // ---- Google Gemini ----
  // flash family (incl. gemini-3-flash thinking variants) is the cheap tier;
  // pro is the premium tier.
  { providers: ["gemini"], pattern: /flash/, rate: { promptPer1M: 0.3, completionPer1M: 2.5 } },
  { providers: ["gemini"], pattern: /pro/, rate: { promptPer1M: 1.25, completionPer1M: 10 } },

  // ---- Groq (Llama/Open models, roughly $/1M from Groq's hosted pricing) ----
  { providers: ["groq"], pattern: /llama-3-?3.*70b/, rate: { promptPer1M: 0.59, completionPer1M: 0.79 } },
  { providers: ["groq"], pattern: /llama-3-?3.*8b/, rate: { promptPer1M: 0.05, completionPer1M: 0.08 } },
  { providers: ["groq"], pattern: /llama/, rate: { promptPer1M: 0.2, completionPer1M: 0.3 } },

  // ---- NVIDIA NIM hosted ----
  { providers: ["nvidia"], pattern: /nemotron/, rate: { promptPer1M: 0.5, completionPer1M: 0.5 } },
  { providers: ["nvidia"], pattern: /llama/, rate: { promptPer1M: 0.5, completionPer1M: 0.5 } },
  { providers: ["nvidia"], pattern: /deepseek/, rate: { promptPer1M: 0.25, completionPer1M: 1.25 } },

  // ---- OpenRouter ----
  // OpenRouter routes hundreds of models at wildly different prices; use a
  // coarse median of a few USD/1M when we can't match a specific one below.
  { providers: ["openrouter"], pattern: /:free/, rate: { promptPer1M: 0, completionPer1M: 0 } },
  { providers: ["openrouter"], pattern: /claude/, rate: { promptPer1M: 3, completionPer1M: 15 } },
  { providers: ["openrouter"], pattern: /gpt/, rate: { promptPer1M: 2.5, completionPer1M: 10 } },

  // ---- Mistral (published per-1M rates) ----
  { providers: ["mistral"], pattern: /large/, rate: { promptPer1M: 2, completionPer1M: 6 } },
  { providers: ["mistral"], pattern: /small/, rate: { promptPer1M: 0.2, completionPer1M: 0.6 } },
  { providers: ["mistral"], pattern: /codestral/, rate: { promptPer1M: 0.3, completionPer1M: 0.9 } },
  { providers: ["mistral"], pattern: /ministral|8b|3b/, rate: { promptPer1M: 0.1, completionPer1M: 0.1 } },

  // ---- DeepSeek (published per-1M rates, cache-miss/standard tier) ----
  { providers: ["deepseek"], pattern: /reasoner/, rate: { promptPer1M: 0.55, completionPer1M: 2.19 } },
  { providers: ["deepseek"], pattern: /chat|v3/, rate: { promptPer1M: 0.27, completionPer1M: 1.1 } },
];

const GENERIC: Rate = { promptPer1M: 1, completionPer1M: 3 };

export function lookupRate(provider: string, model: string): Rate | null {
  const p = provider.toLowerCase();
  const m = model.toLowerCase();
  for (const rule of RULES) {
    if (rule.providers && rule.providers.length > 0 && !rule.providers.includes(p)) continue;
    if (rule.pattern.test(m)) return rule.rate;
  }
  // Any well-known provider we recognize but have no rule for gets a generic
  // estimate; unknown providers (shouldn't happen) return null.
  const knownProviders = ["anthropic", "openai", "nvidia", "openrouter", "groq", "gemini", "mistral", "deepseek"];
  return knownProviders.includes(p) ? GENERIC : null;
}

/** Estimated USD for a turn, or null when no rate applies. */
export function estimateCostUsd(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const rate = lookupRate(provider, model);
  if (!rate) return null;
  const cost = (promptTokens / 1_000_000) * rate.promptPer1M + (completionTokens / 1_000_000) * rate.completionPer1M;
  // Round to 6 decimals — anything finer than a fraction of a cent is noise.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
