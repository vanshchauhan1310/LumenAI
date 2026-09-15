import { Router } from "express";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth.js";
import { getTableauClientForUser } from "../tableau/forUser.js";
import { executeTool } from "../tools/index.js";

/**
 * Read-only content-browsing endpoints for the drill-down dropdown UI.
 * These call the exact same tool handlers the LLM uses (via executeTool),
 * just invoked directly by the frontend instead of by a model — so the
 * dropdown's data shape and pagination behavior always match what the chat
 * tools themselves see. Every call builds the TableauClient from the
 * requesting user's own stored connection (getTableauClientForUser), so
 * there is no path to browsing another user's Tableau content.
 */
export const tableauBrowseRouter = Router();
tableauBrowseRouter.use(requireAuth);

tableauBrowseRouter.get("/projects", async (req: AuthedRequest, res) => {
  const client = await getTableauClientForUser(req.userId!);
  if (!client) return res.status(400).json({ error: "No Tableau connection configured for this account" });

  const result = await executeTool(client, "list_projects", { limit: 500 });
  if (result?.error) return res.status(502).json({ error: result.error });
  res.json(result);
});

tableauBrowseRouter.get("/workbooks", async (req: AuthedRequest, res) => {
  const client = await getTableauClientForUser(req.userId!);
  if (!client) return res.status(400).json({ error: "No Tableau connection configured for this account" });

  const projectName = typeof req.query.projectName === "string" ? req.query.projectName : undefined;
  const result = await executeTool(client, "list_workbooks", { projectName, limit: 500 });
  if (result?.error) return res.status(502).json({ error: result.error });
  res.json(result);
});

tableauBrowseRouter.get("/views", async (req: AuthedRequest, res) => {
  const client = await getTableauClientForUser(req.userId!);
  if (!client) return res.status(400).json({ error: "No Tableau connection configured for this account" });

  const workbookId = typeof req.query.workbookId === "string" ? req.query.workbookId : "";
  if (!workbookId) return res.status(400).json({ error: "workbookId query param is required" });

  const result = await executeTool(client, "list_workbook_views", { workbookId });
  if (result?.error) return res.status(502).json({ error: result.error });
  res.json(result);
});
