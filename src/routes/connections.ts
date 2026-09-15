import { Router } from "express";
import { z } from "zod";
import { supabase, Tables } from "../lib/db.js";
import { encryptSecret } from "../lib/crypto.js";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { TableauClient } from "../tableau/client.js";
import { createLlmAdapter } from "../llm/factory.js";

export const connectionsRouter = Router();
connectionsRouter.use(requireAuth);
// Saving an LLM key calls the provider's API to validate it — a cheap real
// cost per attempt, so limit attempts per user.
connectionsRouter.use(rateLimit({ refillPerMinute: 10, burst: 5 }));

const tableauSchema = z.object({
  siteUrl: z.string().url(),
  siteContentUrl: z.string(),
  patName: z.string().min(1),
  patValue: z.string().min(1),
});

connectionsRouter.post("/tableau", async (req: AuthedRequest, res) => {
  const parsed = tableauSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  const { siteUrl, siteContentUrl, patName, patValue } = parsed.data;
  const apiVersion = process.env.TABLEAU_API_VERSION || "3.24";

  // Validate by signing in before persisting anything.
  const probeClient = new TableauClient(`probe:${req.userId}`, {
    siteUrl,
    siteContentUrl,
    patName,
    patValue,
    apiVersion,
  });
  try {
    await probeClient.verifySignIn();
  } catch (err: any) {
    // TableauClient's error message already excludes the PAT (it only wraps
    // Tableau's own JSON response body), so it's safe to log and to derive
    // the user-facing message from — no separate redaction needed here.
    console.error(`Tableau sign-in failed for user ${req.userId}:`, err?.message ?? err);
    return res.status(400).json({ error: summarizeTableauError(err) });
  }

  // One active Tableau connection per user. Delete old, insert new.
  // Supabase doesn't have multi-statement transactions in JS SDK,
  // but delete + insert is fine for this use case.
  const { error: delErr } = await supabase
    .from(Tables.tableauConnections)
    .delete()
    .eq("user_id", req.userId!);

  if (delErr) {
    console.error("Failed to clear old Tableau connections:", delErr.message);
    return res.status(500).json({ error: "Failed to save connection" });
  }

  const { data: connection, error: insErr } = await supabase
    .from(Tables.tableauConnections)
    .insert({
      user_id: req.userId!,
      site_url: siteUrl,
      site_content_url: siteContentUrl,
      encrypted_pat: encryptSecret(JSON.stringify({ patName, patValue })),
    })
    .select("id, site_url, site_content_url")
    .single();

  if (insErr || !connection) {
    console.error("Tableau connection insert failed:", insErr?.message);
    return res.status(500).json({ error: "Failed to save connection" });
  }

  res.status(201).json({ id: connection.id, siteUrl: connection.site_url, siteContentUrl: connection.site_content_url });
});

const providerEnum = z.enum(["anthropic", "openai", "nvidia", "openrouter", "groq", "gemini", "mistral", "deepseek"]);

const llmSchema = z.object({
  provider: providerEnum,
  apiKey: z.string().min(1),
  model: z.string().min(1),
});

const listModelsSchema = z.object({
  provider: providerEnum,
  apiKey: z.string().min(1),
});

// Powers the "Load models" dropdown in the Connect LLM UI — lets a user pick
// from what their key can actually access instead of typing a model ID
// blind. The key is only ever used in-memory for this one listing call,
// never persisted (same as the validate-on-save flow below). Not every
// adapter implements listModels() (see LlmAdapter.listModels' docstring) —
// that's not an error, the UI just falls back to manual entry.
connectionsRouter.post("/llm/models", async (req: AuthedRequest, res) => {
  const parsed = listModelsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  const { provider, apiKey } = parsed.data;

  try {
    // Model is unused for listing — any non-empty placeholder satisfies the
    // adapter constructors, none of which validate it at construction time.
    const adapter = createLlmAdapter(provider, apiKey, "placeholder");
    const models = (await adapter.listModels?.()) ?? [];
    return res.json({ models });
  } catch (err: any) {
    console.error(
      `Listing models failed (provider=${provider}):`,
      JSON.stringify({ status: err?.status, message: err?.message, error: err?.error }, null, 2),
    );
    return res.status(400).json({ error: summarizeValidationError(err) });
  }
});

connectionsRouter.post("/llm", async (req: AuthedRequest, res) => {
  const parsed = llmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  const { provider, apiKey, model } = parsed.data;

  try {
    const adapter = createLlmAdapter(provider, apiKey, model);
    await adapter.validateKey();
  } catch (err: any) {
    // Log the real reason server-side (never the key) so validation failures
    // are actually diagnosable instead of a single opaque 400 for every cause.
    console.error(
      `LLM validation failed (provider=${provider}, model=${model}):`,
      JSON.stringify({ status: err?.status, message: err?.message, error: err?.error }, null, 2),
    );
    return res.status(400).json({ error: summarizeValidationError(err) });
  }

  // One active LLM connection per user. Delete old, insert new.
  const { error: delErr } = await supabase
    .from(Tables.llmConnections)
    .delete()
    .eq("user_id", req.userId!);

  if (delErr) {
    console.error("Failed to clear old LLM connections:", delErr.message);
    return res.status(500).json({ error: "Failed to save connection" });
  }

  const { data: connection, error: insErr } = await supabase
    .from(Tables.llmConnections)
    .insert({
      user_id: req.userId!,
      provider,
      model,
      encrypted_api_key: encryptSecret(apiKey),
    })
    .select("id, provider, model")
    .single();

  if (insErr || !connection) {
    console.error("LLM connection insert failed:", insErr?.message);
    return res.status(500).json({ error: "Failed to save connection" });
  }

  res.status(201).json({ id: connection.id, provider: connection.provider, model: connection.model });
});

connectionsRouter.delete("/tableau/:id", async (req: AuthedRequest, res) => {
  // Scoped to user_id so one user can't delete another's connection
  const { error, count } = await supabase
    .from(Tables.tableauConnections)
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.userId!);

  if (error) {
    console.error("Delete Tableau connection error:", error.message);
    return res.status(500).json({ error: "Failed to delete connection" });
  }
  // Supabase delete doesn't return count in JS SDK; check if row existed
  const { data: check } = await supabase
    .from(Tables.tableauConnections)
    .select("id")
    .eq("id", req.params.id)
    .maybeSingle();
  if (check) return res.status(404).json({ error: "Connection not found" });
  res.status(204).send();
});

connectionsRouter.delete("/llm/:id", async (req: AuthedRequest, res) => {
  const { error } = await supabase
    .from(Tables.llmConnections)
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.userId!);

  if (error) {
    console.error("Delete LLM connection error:", error.message);
    return res.status(500).json({ error: "Failed to delete connection" });
  }
  const { data: check } = await supabase
    .from(Tables.llmConnections)
    .select("id")
    .eq("id", req.params.id)
    .maybeSingle();
  if (check) return res.status(404).json({ error: "Connection not found" });
  res.status(204).send();
});

connectionsRouter.get("/", async (req: AuthedRequest, res) => {
  const [{ data: tableau }, { data: llm }] = await Promise.all([
    supabase
      .from(Tables.tableauConnections)
      .select("id, site_url, site_content_url, created_at")
      .eq("user_id", req.userId!)
      .order("created_at", { ascending: false }),
    supabase
      .from(Tables.llmConnections)
      .select("id, provider, model, created_at")
      .eq("user_id", req.userId!)
      .order("created_at", { ascending: false }),
  ]);

  res.json({
    tableau: (tableau ?? []).map((t: any) => ({
      id: t.id,
      siteUrl: t.site_url,
      siteContentUrl: t.site_content_url,
      createdAt: t.created_at,
    })),
    llm: (llm ?? []).map((l: any) => ({
      id: l.id,
      provider: l.provider,
      model: l.model,
      createdAt: l.created_at,
    })),
  });
});

/**
 * Short, plain-English summary of why a BYOK key/model failed validation —
 * written for a non-technical user, so no status codes, error class names,
 * or raw provider JSON ever appear here (those still go to console.error
 * server-side for debugging). Never includes the API key.
 */
function summarizeValidationError(err: any): string {
  const ctorName = err?.constructor?.name;

  if (ctorName === "APIConnectionTimeoutError" || /timeout/i.test(String(err?.message))) {
    return "This took too long to respond. The AI provider may be busy right now — please try again in a moment.";
  }
  // The OpenAI SDK throws this when the request never got an HTTP response at
  // all (DNS failure, firewall/proxy blocking the host, TLS error, offline).
  if (ctorName === "APIConnectionError") {
    return "We couldn't connect to this AI provider at all. Please check your internet connection and try again.";
  }

  const status = err?.status;
  if (status === 401 || status === 403) return "This API key was rejected. Please double-check you copied it correctly, or generate a new one from the provider's website.";
  if (status === 404) return "We couldn't find a model with that exact name. Please check the model name and try again.";
  if (status === 429) return "This provider is temporarily limiting requests on this key. Please wait a minute and try again.";
  if (status === 503) return "This model is currently experiencing high demand. Spikes in demand are usually temporary — please try again in a moment.";
  return "Something went wrong while checking this connection. Please try again, or try a different API key or model.";
}

/**
 * Turns TableauClient's wrapped sign-in error into a plain-English message
 * for a non-technical user — no status codes or raw Tableau error JSON here
 * (that detail is still logged server-side via console.error above, for
 * debugging). TableauClient's underlying message never contains the PAT.
 */
function summarizeTableauError(err: any): string {
  const message = String(err?.message ?? err);
  const match = message.match(/Tableau API error \((\d+)\): ([\s\S]*)/);

  if (!match) {
    // No HTTP response at all — DNS/network/firewall, or a wrong protocol/host.
    return "We couldn't reach that Tableau site at all. Please double-check the Site URL is typed correctly and is reachable from the internet.";
  }

  const status = Number(match[1]);

  if (status === 401) {
    return (
      "Tableau rejected this access token — it may be incorrect, expired, or has been revoked. " +
      "Please double-check you copied it correctly, or generate a new one from Tableau " +
      "(My Account Settings → Personal Access Tokens)."
    );
  }
  if (status === 404) {
    return "We couldn't find that Tableau site. Please double-check the Site Content URL matches exactly what appears after \"/site/\" in your Tableau web address (leave it blank only if you use the Default site).";
  }
  if (status === 403) {
    return "Tableau didn't allow access with this token. The account it belongs to may not have permission, or access tokens may be turned off for this site — please check with your Tableau administrator.";
  }
  return "We couldn't sign in to Tableau with these details. Please double-check the Site URL, Site Content URL, and access token, then try again.";
}
