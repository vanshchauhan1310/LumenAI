import { Router } from "express";
import { z } from "zod";
import { supabase, Tables, mapConversation, logSupabaseError } from "../lib/db.js";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth.js";

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

conversationsRouter.get("/", async (req: AuthedRequest, res) => {
  const { data, error } = await supabase
    .from(Tables.conversations)
    .select("*")
    .eq("user_id", req.userId!)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to fetch conversations:", error.message);
    return res.status(500).json({ error: "Failed to fetch conversations" });
  }
  res.json(data ?? []);
});

conversationsRouter.post("/", async (req: AuthedRequest, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title : "New conversation";
  const { data, error } = await supabase
    .from(Tables.conversations)
    .insert({ user_id: req.userId!, title })
    .select("*")
    .single();

  if (error || !data) {
    console.error("Failed to create conversation:", error?.message);
    return res.status(500).json({ error: "Failed to create conversation" });
  }
  res.status(201).json(data);
});

conversationsRouter.get("/:id", async (req: AuthedRequest, res) => {
  // Scoped to user_id so one user can never read another user's conversation
  const { data: conv, error: convErr } = await supabase
    .from(Tables.conversations)
    .select("*")
    .eq("id", req.params.id)
    .eq("user_id", req.userId!)
    .maybeSingle();

  if (convErr) {
    console.error("Failed to fetch conversation:", convErr.message);
    return res.status(500).json({ error: "Failed to fetch conversation" });
  }
  if (!conv) return res.status(404).json({ error: "Conversation not found" });

  // Fetch messages separately (no join in Supabase JS SDK like Prisma's include)
  const { data: messages, error: msgErr } = await supabase
    .from(Tables.messages)
    .select("*")
    .eq("conversation_id", req.params.id)
    .order("created_at", { ascending: true });

  if (msgErr) {
    console.error("Failed to fetch messages:", msgErr.message);
    return res.status(500).json({ error: "Failed to fetch messages" });
  }

  res.json({ ...conv, messages: messages ?? [] });
});

const scopeSchema = z.object({
  projectId: z.string().nullable().optional(),
  projectName: z.string().nullable().optional(),
  workbookId: z.string().nullable().optional(),
  workbookName: z.string().nullable().optional(),
  workbookLink: z.string().nullable().optional(),
  viewId: z.string().nullable().optional(),
  viewName: z.string().nullable().optional(),
  viewLink: z.string().nullable().optional(),
});

/**
 * Sets or clears this conversation's drill-down scope (Project -> Workbook
 * -> View), enforced by chat.ts on every future message. A level can only
 * be set if every level above it is also set — e.g. a workbook without a
 * project doesn't mean anything — so we null out anything inconsistent
 * rather than trust the client to always send a fully-formed triple.
 */
conversationsRouter.patch("/:id/scope", async (req: AuthedRequest, res) => {
  const parsed = scopeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid scope body" });
  }

  const { data: existingRow, error: existingErr } = await supabase
    .from(Tables.conversations)
    .select("id")
    .eq("id", req.params.id)
    .eq("user_id", req.userId!)
    .maybeSingle();
  logSupabaseError("find conversation for scope", existingErr);
  if (!existingRow) return res.status(404).json({ error: "Conversation not found" });

  const projectId = parsed.data.projectId ?? null;
  const workbookId = projectId ? (parsed.data.workbookId ?? null) : null;
  const viewId = workbookId ? (parsed.data.viewId ?? null) : null;

  const { data: updatedRow, error: updateErr } = await supabase
    .from(Tables.conversations)
    .update({
      scope_project_id: projectId,
      scope_project_name: projectId ? (parsed.data.projectName ?? null) : null,
      scope_workbook_id: workbookId,
      scope_workbook_name: workbookId ? (parsed.data.workbookName ?? null) : null,
      scope_workbook_link: workbookId ? (parsed.data.workbookLink ?? null) : null,
      scope_view_id: viewId,
      scope_view_name: viewId ? (parsed.data.viewName ?? null) : null,
      scope_view_link: viewId ? (parsed.data.viewLink ?? null) : null,
    })
    .eq("id", existingRow.id)
    .select("*")
    .single();

  if (updateErr || !updatedRow) {
    console.error("Failed to update scope:", updateErr?.message);
    return res.status(500).json({ error: "Failed to update scope" });
  }
  res.json(mapConversation(updatedRow));
});
