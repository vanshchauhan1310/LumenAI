# BYOK Conversational Analytics Platform (Phase 1 MVP)

Multi-tenant chat UI where each user connects their own Tableau Cloud site
(via a pasted Personal Access Token) and brings their own LLM API key
(Anthropic or OpenAI). Messages go to the user's chosen LLM with a set of
Tableau tool definitions; the backend executes any tool calls against that
specific user's Tableau site, using their own stored token.

## Running locally

```sh
npm install
cp .env.example .env
# Edit .env: set JWT_SECRET and ENCRYPTION_KEY, e.g.
#   openssl rand -base64 32
# Create tables in Supabase (free at https://supabase.com):
#   Dashboard -> SQL Editor -> paste & run supabase_schema.sql (once)
# Then fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env
#   (Supabase Dashboard -> Project Settings -> API)

# Optional: Redis for multi-tier caching (highly recommended for production)
# docker run -d --name lumen-redis -p 6379:6379 redis:7-alpine
# Add to .env: REDIS_URL=redis://localhost:6379

npm run dev
```

The server listens on `http://localhost:3000` and serves a minimal chat UI
at `/`. Sign up, connect a Tableau Cloud site (Personal Access Token) and an
LLM API key, then chat.

## Running tests

```sh
npm run build
npm test
```

`tests/tenantIsolation.test.ts` proves user A's queries can never execute
with user B's Tableau token, even under concurrent sign-in.

## API

- `POST /auth/signup`, `POST /auth/login`
- `POST /connections/tableau` — `{ siteUrl, siteContentUrl, patName, patValue }`
- `POST /connections/llm` — `{ provider: "anthropic"|"openai"|"gemini"|"nvidia"|"openrouter"|"groq", apiKey, model }`
  - Gemini = Google AI Studio key (AIza...), e.g. `gemini-3.5-flash` or `gemini-2.5-pro-preview`
  - NVIDIA = NIM-hosted models like Nemotron, e.g. `nvidia/llama-3.1-nemotron-70b-instruct`, key from build.nvidia.com
  - Groq = key from console.groq.com, e.g. `llama-3.2-90b-vision-preview` — some Groq-hosted models support vision, which works automatically with `get_view_image` (image delivery is implemented generically for all OpenAI-compatible providers, not per-provider)
- `GET /connections` — list current user's connections (secrets never returned)
- `POST /conversations`, `GET /conversations`, `GET /conversations/:id`
- `PATCH /conversations/:id/scope` — `{ projectId?, projectName?, workbookId?, workbookName?, viewId?, viewName? }` sets/clears a conversation's drill-down scope (see below). Pass `projectId: null` to clear entirely.
- `POST /chat/:conversationId/message` — `{ message }` → runs the full
  LLM ⇄ tool-call ⇄ Tableau loop and returns the assistant's reply
- `GET /tableau/projects`, `GET /tableau/workbooks?projectName=`, `GET /tableau/views?workbookId=` — read-only content browsing for the drill-down dropdown UI, backed by the same tool handlers the LLM uses
- `GET /usage`, `GET /usage/summary` — usage metering for the current user: recent LLM turns + tool calls, and aggregates (totals, per-day, per-provider, per-tool, success/error rate) with estimated cost
- `POST /chat/:conversationId/message` is rate-limited per user (token bucket); `POST /connections/llm` is likewise rate-limited so one account can't hammer the provider's validate call

## Conversation drill-down scope

Each chat can optionally be locked to a Project, a Workbook within a project, or a single View within a workbook, via the three cascading dropdowns above the chat window. This is enforced **server-side** (`src/lib/scope.ts`), not just via prompting:

- Scoped to a **view**: `get_view_data`/`get_view_image` are silently redirected to that view regardless of what id the model requests, `list_workbook_views` is pinned to the scoped workbook, and every site-wide browsing tool (`list_projects`, `list_workbooks`, `list_site_views`, `search_content`, `search_fields`, `list_flows`, `list_virtual_connections`) is rejected outright before it reaches Tableau.
- Scoped to a **workbook**: `list_workbook_views` is pinned to it; the same broader browsing tools are rejected.
- Scoped to a **project**: `list_workbooks` is pinned to it; `list_projects`/`list_site_views`/`search_content`/`search_fields` are rejected.
- No scope: unrestricted, whole-site behavior (the original default).

Datasource-query, Pulse, and admin tools aren't part of the project/workbook/view hierarchy in the Tableau API, so they're deliberately left unscoped at every level — the system-prompt addendum asks the model to stay on-topic for those instead. Tools that take a `datasourceLuid` (query/metadata/glossary/usage/lineage and the analytical tools) are allowed at every scope only because the id must come from a legitimate discovery call (`list_workbook_datasources` or `list_datasources` unscoped) — the model has no excuse to invent one.

## Tools exposed to the LLM

Ported from an existing single-tenant Tableau MCP server, now parameterized
per-user. 64 tools across 6 modules in `src/tools/*.ts`, combined in
`src/tools/index.ts`:

- **Datasources/query** (`tableauTools.ts`): `list_datasources`, `get_datasource_metadata`, `query_datasource`, `get_field_values`
- **Content** (`contentTools.ts`): `list_projects`, `list_workbooks`, `list_flows`, `list_virtual_connections`, `search_content`, `list_workbook_views` (views inside one named workbook), `list_site_views` (every view across the whole site in one call — the answer to "list all my dashboards"), `get_view_data`, `get_view_image` — the last one renders a dashboard as a PNG and delivers it to the model as an actual image (Anthropic: embedded in the tool result; OpenAI-compatible providers: a follow-up image message, since their tool-role messages can't carry images), so a vision-capable model can reason about layout/trends/colors, not just raw query rows; plus `get_dashboard_summary` (combines every sheet in a dashboard's workbook into one text overview), `get_workbook_details` (metadata + tags + link), `get_workbook_thumbnail` (preview image), `get_view_pdf` (PDF export — rendered/downloaded in the chat, never sent to the model), `list_workbook_revisions`, `list_tags`/`add_tags`/`remove_tags`, `list_favorites`/`add_favorite`/`remove_favorite` (the platform's first write tools), `list_custom_views`/`get_custom_view_image`, and `get_data_quality_warning`
- **Pulse** (`pulseTools.ts`): `list_pulse_metrics`, `get_pulse_metric_insight`
- **Semantic layer** (`semanticTools.ts`): `get_datasource_glossary` (what a datasource's fields mean), `get_field_usage` (which sheets/workbooks use a field), `get_metric_definition` (resolves a Pulse metric's formula), `get_dashboard_insights` (computed stats over a dashboard's data), `recommend_visualization` (chart-type advice from field roles — pure logic, no Tableau call)
- **Analytical layer** (`analyticalTools.ts`, math in `lib/analytics.ts`): `compare_periods` (diff a measure between two date windows), `explain_change` (same, plus ranked drivers of the change), `anomaly_detection` (z-score outliers in a time-bucketed series), `forecast_metric` (least-squares forward projection with a confidence band), `get_metric_history` (a Pulse metric's trend, resolved from its own spec), `get_data_quality_warnings` (stale/inconsistent data flags), `get_field_lineage` (upstream source columns + downstream sheets), `search_fields` (site-wide field-name search), `cross_datasource_query` (one measure across several datasources, merged), `rank_categories` (top/bottom N members with % of total + cumulative share), `pivot_cross_tab` (rows x columns matrix with totals), `rollup_time_series` (a measure bucketed to day/week/month/quarter/year), `correlation_analysis` (Pearson + Spearman between two measures), `field_statistics` (min/max/avg/median + sampled null%/cardinality/percentiles), `bucketize_metric` (client-side histogram bins), `share_of_total` (each member's share + cumulative %, with a baseline share delta), `get_summary_table` (one-call insights digest: total, monthly trend, top contributor)
- **Admin** (`adminTools.ts`): `list_users`, `check_permissions` (now also accepts views), `refresh_extract_status`, `query_workbook_permissions`, `query_view_permissions`, `query_datasource_permissions` (per-user/group capabilities on a piece of content), `list_subscriptions`, `list_data_driven_alerts`, `list_schedules`, `list_groups`, `get_group_members`, `get_server_info` (cheap version/capability diagnostic) — several of these require the connected Tableau account to be a Site/Server Admin; a non-admin PAT will get a normal tool-level permission error, which is expected (see `ARCHITECTURE.md`)

Usage metering (`lib/usage.ts`) records one row per LLM turn (`LlmUsage`, with estimated cost from `lib/pricing.ts`) and one per tool call (`ToolUsage`, with truncated args) — surfaced in the "Usage & cost" sidebar modal (frontend + `GET /usage` endpoints).

See `ARCHITECTURE.md` for what's stubbed for this MVP vs. production.

## Performance & Accuracy Improvements

### Fast Path Router (`src/lib/queryRouter.ts`)
Simple queries (counts, lists, help) bypass the LLM entirely and answer directly from cached Tableau results in <100ms:
- "How many data sources do I have?" → instant count
- "List all workbooks" → instant list
- "What can you do?" → instant help

### Multi-Tier Caching (`src/lib/cache.ts`)
- **Tier 1**: In-memory LRU cache (sub-millisecond, per-process)
- **Tier 2**: Redis cache (shared across processes, ~1-5ms)
- **Per-user isolation**: All caches keyed by userId (no cross-tenant leakage)
- **TTL by data type**: Datasource lists (5 min), metadata (30 min), Pulse metrics (1 min), server info (60 min)

### Optimized System Prompt
- Reduced from ~2000 tokens to ~500 tokens (less context = less confusion for NVIDIA models)
- Explicit "CRITICAL RULES" section prevents common failure modes
- Direct intent→tool mapping eliminates tool confusion (e.g., "data sources" always → `list_datasources`)

### NVIDIA Adapter Tuning (`src/lib/nvidiaAdapter.ts`)
- 120s timeout (handles cold-start on 70B+ models)
- 3 retries with backoff (handles transient 503s)

### Expected Performance
| Query Type | Before | After |
|-----------|--------|-------|
| Count queries | 30-120s | <100ms |
| List queries | 30-120s | <100ms |
| Repeat queries | 30-120s each | <500ms (cache hit) |
| Accuracy (basic) | 20-30% | 60-75% |
| Accuracy (fast path) | N/A | ~100% |

See `QUERY_EXAMPLES.md` for 50+ example queries with expected responses.
