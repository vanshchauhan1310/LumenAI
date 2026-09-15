import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authRouter } from "./routes/auth.js";
import { connectionsRouter } from "./routes/connections.js";
import { chatRouter } from "./routes/chat.js";
import { conversationsRouter } from "./routes/conversations.js";
import { tableauBrowseRouter } from "./routes/tableauBrowse.js";
import { usageRouter } from "./routes/usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.PORT) || 3000;

const requiredEnv = ["JWT_SECRET", "ENCRYPTION_KEY"];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}. Check .env (see .env.example).`);
    process.exit(1);
  }
}

// Defense-in-depth: Express 4 does not catch rejected promises thrown from
// async route handlers, so an unhandled one otherwise crashes the entire
// process (taking down every user's session, not just the failing request).
// Each route should still catch its own async errors (see chat.ts), but this
// is the backstop if one is missed.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server kept running):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server kept running):", err);
});

function fatal(err: NodeJS.ErrnoException) {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use — stop the other process (or set PORT in .env) and retry.`);
  } else {
    console.error("Fatal startup error:", err);
  }
  process.exit(1);
}

const app = express();

// Render (and most PaaS hosts) put the app behind a reverse proxy — without
// this, req.secure/req.ip reflect the proxy hop, not the real client.
app.set("trust proxy", 1);

// Bound request bodies: unauthenticated JSON parsing of an unbounded body is
// a cheap memory-exhaustion vector once this is reachable on the open
// internet, not just localhost. 1mb comfortably covers a chat message or
// scope-update payload — no route legitimately needs more (images/large
// tool results flow server-to-provider, never arrive as a client request body).
app.use(express.json({ limit: "1mb" }));

// Render's health check hits this on every deploy/restart to decide when
// the new instance is ready to receive traffic — must not require auth or
// touch the DB/Tableau/LLM, so it stays fast and meaningful even if a
// downstream dependency is degraded.
app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));

app.use("/auth", authRouter);
app.use("/connections", connectionsRouter);
app.use("/chat", chatRouter);
app.use("/conversations", conversationsRouter);
app.use("/tableau", tableauBrowseRouter);
app.use("/usage", usageRouter);

// Minimal static frontend. Set to revalidate-on-every-request (no-cache)
// so app.js/styles.css changes are never stuck behind an aggressive browser
// cache — dev iterates on these files constantly, and a stale JS bundle is
// a classic source of "the new feature isn't showing up" reports.
app.use(
  express.static(path.join(__dirname, "..", "..", "public"), {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  }),
);

// Never leak stack traces / raw error messages that might contain secrets.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err?.message ?? err);
  res.status(500).json({ error: "Internal server error" });
});

const httpServer = app.listen(port, () => {
  console.log(`BYOK analytics platform listening on http://localhost:${port}`);
});
httpServer.on("error", fatal);

// Render sends SIGTERM before stopping/replacing an instance (deploys,
// scaling, restarts). Without handling it, in-flight requests get cut off
// mid-response instead of finishing — stop accepting new connections but let
// existing ones complete, then exit. Node's default SIGTERM behavior is an
// immediate exit, so this must be handled explicitly.
function gracefulShutdown(signal: string) {
  console.log(`${signal} received — closing server gracefully.`);
  httpServer.close(() => {
    console.log("Server closed, no more in-flight requests.");
    process.exit(0);
  });
  // Don't hang forever if a connection never closes on its own.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
