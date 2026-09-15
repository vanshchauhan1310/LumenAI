/**
 * Supabase client singleton.
 *
 * Migrated from Prisma to Supabase for:
 * - Managed PostgreSQL (no migration scripts to run)
 * - Built-in connection pooling
 * - REST API + realtime capabilities
 * - Dashboard for data inspection
 *
 * Environment variables required:
 *   SUPABASE_URL — your Supabase project URL (https://xxxx.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY — service_role key (NOT anon key — this server
 *     bypasses RLS via the service role; RLS is still enforced for any
 *     client-side anon access if you add it later)
 *
 * To find these: Supabase Dashboard -> Project Settings -> API
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.error("Missing required env var: SUPABASE_URL. Check .env (see .env.example).");
  process.exit(1);
}
if (!supabaseServiceKey) {
  console.error("Missing required env var: SUPABASE_SERVICE_ROLE_KEY. Check .env (see .env.example).");
  process.exit(1);
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    // Server-side client: no session persistence needed
    persistSession: false,
    autoRefreshToken: false,
  },
  db: {
    // Schema name — change if you use a custom schema
    schema: "public",
  },
});

/**
 * Table names — centralized so every file references the same constants.
 * If you rename a table in Supabase, change it here and it updates everywhere.
 */
export const Tables = {
  users: "users",
  tableauConnections: "tableau_connections",
  llmConnections: "llm_connections",
  conversations: "conversations",
  messages: "messages",
  llmUsage: "llm_usage",
  toolUsage: "tool_usage",
} as const;

/**
 * Row mappers — Supabase returns snake_case columns, but the rest of the
 * codebase (scope.ts, chat.ts) was built against Prisma's camelCase models.
 * These keep that interface stable so only the DB layer changes.
 */

export type ConversationRow = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  scope_project_id: string | null;
  scope_project_name: string | null;
  scope_workbook_id: string | null;
  scope_workbook_name: string | null;
  scope_workbook_link: string | null;
  scope_view_id: string | null;
  scope_view_name: string | null;
  scope_view_link: string | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  created_at: string;
};

export function mapConversation(row: ConversationRow | null | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: new Date(row.created_at),
    scopeProjectId: row.scope_project_id ?? null,
    scopeProjectName: row.scope_project_name ?? null,
    scopeWorkbookId: row.scope_workbook_id ?? null,
    scopeWorkbookName: row.scope_workbook_name ?? null,
    scopeWorkbookLink: row.scope_workbook_link ?? null,
    scopeViewId: row.scope_view_id ?? null,
    scopeViewName: row.scope_view_name ?? null,
    scopeViewLink: row.scope_view_link ?? null,
  };
}

export function mapMessage(row: MessageRow | null | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls ?? null,
    createdAt: new Date(row.created_at),
  };
}

/**
 * Standard error handling for a Supabase query: logs once server-side and
 * returns null so callers can use `??`/`maybeSingle()` semantics like they
 * did with Prisma's nullable findFirst results.
 */
export function logSupabaseError(context: string, error: { message: string } | null): void {
  if (error) console.error(`[supabase] ${context}: ${error.message}`);
}

