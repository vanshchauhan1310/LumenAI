-- ============================================================================
-- Lumen MCP + Supabase Database Schema
--
-- Run this in: Supabase Dashboard -> SQL Editor -> New Query -> Paste & Run
--
-- After creating tables, get credentials:
--   Supabase Dashboard -> Project Settings -> API
--     - Project URL  -> SUPABASE_URL
--     - service_role key (secret) -> SUPABASE_SERVICE_ROLE_KEY
-- ============================================================================

-- 1. USERS TABLE (custom auth, not Supabase Auth)
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. TABLEAU CONNECTIONS (one active per user)
CREATE TABLE IF NOT EXISTS public.tableau_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  site_url TEXT NOT NULL,
  site_content_url TEXT NOT NULL,
  encrypted_pat TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tableau_connections_user_id ON public.tableau_connections(user_id);

-- 3. LLM CONNECTIONS (one active per user)
CREATE TABLE IF NOT EXISTS public.llm_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_llm_connections_user_id ON public.llm_connections(user_id);

-- 4. CONVERSATIONS (with optional drill-down scope)
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scope_project_id TEXT,
  scope_project_name TEXT,
  scope_workbook_id TEXT,
  scope_workbook_name TEXT,
  scope_workbook_link TEXT,
  scope_view_id TEXT,
  scope_view_name TEXT,
  scope_view_link TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON public.conversations(user_id);

-- 5. MESSAGES
CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON public.messages(conversation_id);

-- 6. LLM USAGE (metering)
CREATE TABLE IF NOT EXISTS public.llm_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_id_created_at ON public.llm_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_provider ON public.llm_usage(provider);

-- 7. TOOL USAGE (metering)
CREATE TABLE IF NOT EXISTS public.tool_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_args TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tool_usage_user_id_created_at ON public.tool_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_usage_tool_name ON public.tool_usage(tool_name);

-- Note: Row Level Security (RLS) is NOT enabled.
-- The service_role key bypasses RLS automatically.
-- Enable RLS + policies only if you add client-side (anon key) access later.

