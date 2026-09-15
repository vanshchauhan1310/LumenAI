import { OpenAiAdapter } from "./openaiAdapter.js";
import { ChatMessage, LlmTurnResult, ToolDefinition } from "./types.js";
import { lookup } from "node:dns/promises";
import { URL } from "node:url";

const NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

/**
 * NVIDIA NIM (build.nvidia.com) exposes Nemotron and other hosted models
 * behind an OpenAI-compatible /v1/chat/completions endpoint. Tool calling and
 * message shapes are identical; only auth host and validation differ.
 *
 * Production tuning vs base OpenAiAdapter:
 * - Longer timeout (120s) for cold-start on hosted 70B+ models
 * - Higher max_retries with backoff for transient 503s under load
 * - Manual retry wrapper for APIConnectionError (DNS/network blips that the
 *   SDK's built-in retry doesn't always catch)
 * - DNS pre-check to fail fast on unresolvable hostnames
 *
 * If the primary endpoint is unreachable, set NVIDIA_BASE_URL in .env to
 * any OpenAI-compatible mirror that serves the same model. No code change
 * required.
 */
export class NvidiaAdapter extends OpenAiAdapter {
  private resolvedBaseUrl: string;

  constructor(apiKey: string, model: string) {
    const baseUrl = process.env.NVIDIA_BASE_URL || NVIDIA_NIM_BASE_URL;
    super(apiKey, model, baseUrl);
    this.resolvedBaseUrl = baseUrl;
    // Override the client with NVIDIA-optimized settings
    this.client = new (this.client.constructor as any)({
      apiKey,
      baseURL: baseUrl,
      timeout: 120_000, // 120s — handles cold-start on large models
      maxRetries: 3,    // Retry on transient failures
    });
  }

  /**
   * Resolves the hostname from a URL string. Returns null if the URL is
   * invalid or unresolvable — used by sendTurn to fail fast with a clear
   * message instead of burning through retries on a dead hostname.
   */
  private async checkDns(baseUrl: string): Promise<string | null> {
    try {
      const url = new URL(baseUrl);
      const hostname = url.hostname;
      await lookup(hostname);
      return null; // DNS resolved OK
    } catch (dnsErr: any) {
      return `DNS lookup failed: ${dnsErr?.message ?? dnsErr}`;
    }
  }

  /**
   * Wraps the parent sendTurn with an additional manual retry layer for
   * connection-level failures (APIConnectionError). The OpenAI SDK's built-in
   * retry handles most 5xx errors, but low-level connection errors (DNS,
   * socket hang-up, TLS) sometimes propagate immediately without retry.
   *
   * Exponential backoff: 2s → 4s → 8s, then give up.
   *
   * DNS pre-check: before the first attempt, a quick lookup confirms the
   * host resolves — if it doesn't, we fail immediately with a clear message
   * instead of burning through all retries on an unresolvable hostname.
   */
  async sendTurn(history: ChatMessage[], tools: ToolDefinition[]): Promise<LlmTurnResult> {
    const maxAttempts = 3;
    let lastError: any;

    // DNS pre-check: fail fast if hostname doesn't resolve
    const dnsError = await this.checkDns(this.resolvedBaseUrl);
    if (dnsError) {
      throw new Error(
        `NVIDIA NIM endpoint is unreachable (${this.resolvedBaseUrl}). ${dnsError}. ` +
        `Please check your internet connection and firewall settings. ` +
        `If this persists, set NVIDIA_BASE_URL in .env to a working OpenAI-compatible mirror.`,
      );
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await super.sendTurn(history, tools);
      } catch (err: any) {
        lastError = err;
        // Check multiple ways the error might identify itself — SDK throws
        // APIConnectionError, but serialization or wrapping can leave only the
        // message string or a ctorName field (as seen in the wild).
        const errName = err?.constructor?.name ?? err?.name ?? err?.ctorName ?? "";
        const errText = String(err?.message ?? err ?? "");
        const isConnectionError =
          errName === "APIConnectionError" ||
          /connection\s*error|econnrefused|econnreset|etimedout|enotfound|getaddrinfo|eai_again|socket hang up|network|dns/i.test(errText);

        if (!isConnectionError) {
          throw err;
        }

        if (attempt === maxAttempts) {
          // On the final attempt, rethrow with a more helpful message that
          // includes the base URL and actionable troubleshooting steps.
          const base = (this.client as any).baseURL || "unknown";
          const originalMsg = err?.message ?? errText;
          throw new Error(
            `NVIDIA NIM connection failed after ${maxAttempts} attempts (endpoint: ${base}). ` +
            `Original error: ${originalMsg}. ` +
            `Troubleshooting: 1) Check your internet connection and firewall/proxy settings. ` +
            `2) Verify the NVIDIA API is status-green at status.nvidia.com. ` +
            `3) If behind a corporate proxy, set NVIDIA_BASE_URL in .env to a working OpenAI-compatible mirror.`,
          );
        }

        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 8000);
        console.warn(
          `[nvidia] Connection error on attempt ${attempt}/${maxAttempts} (${errName || errText.slice(0, 80)}) — retrying in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  async validateKey(): Promise<void> {
    await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
  }

  async listModels(): Promise<string[]> {
    return [
      "meta/llama-3.1-8b-instruct",
      "meta/llama-3.1-70b-instruct",
      "meta/llama-3.1-405b-instruct",
      "meta/llama-3.3-70b-instruct",
      "nvidia/llama-3.1-nemotron-70b-instruct",
      "mistralai/mixtral-8x22b-instruct-v0.1",
      "deepseek-ai/deepseek-r1",
      "nvidia/neva-22b",
      "meta/llama-3.2-11b-vision-instruct",
      "meta/llama-3.2-90b-vision-instruct",
    ];
  }
}
