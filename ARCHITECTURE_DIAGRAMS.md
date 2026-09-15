# Lumen — Platform Architecture (Stakeholder Reference)

BYOK (Bring Your Own Key) multi-tenant conversational analytics platform for
Tableau. Users connect their own Tableau Cloud site (via a Personal Access
Token) and their own LLM provider API key, then chat in natural language;
the LLM answers by calling tools scoped strictly to that user's own Tableau
data. Every diagram below reflects the current implementation, not a future
plan — file paths are included so any claim here can be checked against the
code directly.

---

## 1. System overview

```mermaid
flowchart TB
    subgraph Browser["Browser (no build step — vanilla JS)"]
        UI["public/index.html + app.js<br/>Chat UI, drill-down scope picker,<br/>Chart.js charts, image lightbox"]
    end

    subgraph Server["Node/Express server (src/server.ts)"]
        AUTH["Auth routes<br/>src/routes/auth.ts<br/>email+password → JWT"]
        CONN["Connections routes<br/>src/routes/connections.ts<br/>save/validate Tableau PAT + LLM key"]
        CONV["Conversations routes<br/>src/routes/conversations.ts<br/>create/list/scope a conversation"]
        BROWSE["tableauBrowse routes<br/>src/routes/tableauBrowse.ts<br/>powers the scope dropdown UI"]
        CHAT["Chat route (the core)<br/>src/routes/chat.ts<br/>tool-calling orchestration loop"]

        subgraph Core["Shared core"]
            SCOPE["Scope enforcement<br/>src/lib/scope.ts"]
            CRYPTO["Secrets<br/>src/lib/crypto.ts<br/>AES-256-GCM at rest"]
            IMG["Image pipeline<br/>src/lib/image.ts<br/>Jimp resize/compress"]
            JWTLIB["JWT<br/>src/lib/jwt.ts"]
        end

        subgraph LLMLayer["LLM provider abstraction (src/llm/)"]
            FACTORY["factory.ts<br/>createLlmAdapter(provider)"]
            ANTH["anthropicAdapter.ts"]
            OAI["openaiAdapter.ts<br/>(base class)"]
            NVIDIA["nvidiaAdapter.ts extends OpenAiAdapter"]
            OR["openrouterAdapter.ts extends OpenAiAdapter"]
            GROQ["groqAdapter.ts extends OpenAiAdapter"]
        end

        subgraph ToolLayer["Tool registry (src/tools/index.ts)"]
            TTOOLS["tableauTools.ts<br/>datasource query tools"]
            CTOOLS["contentTools.ts<br/>content browsing + view/dashboard tools"]
            PTOOLS["pulseTools.ts<br/>Pulse metrics"]
            STOOLS["semanticTools.ts<br/>glossary / usage / insights"]
            ANTOOLS["analyticalTools.ts<br/>periods / forecast / anomalies / ranking / correlation / shares"]
            ATOOLS["adminTools.ts<br/>users/permissions/extracts"]
        end

        subgraph TableauLayer["Tableau access (src/tableau/)"]
            TCLIENT["TableauClient<br/>client.ts — per-user REST/VDS/GraphQL client"]
            AUTHMGR["TableauAuthRegistry<br/>authManager.ts — in-memory session cache, keyed by userId"]
            FORUSER["forUser.ts<br/>getTableauClientForUser(userId)"]
        end
    end

    DB[("SQLite via Prisma<br/>prisma/schema.prisma<br/>(swap to Postgres = 1 line)")]

    TABLEAU[("User's own Tableau Cloud/Server site<br/>REST API v3 + VizQL Data Service + GraphQL Metadata API")]
    LLMPROVIDER[("User's own LLM provider<br/>Anthropic / OpenAI / NVIDIA NIM / OpenRouter / Groq / Gemini")]

    UI -->|"JWT bearer token"| AUTH
    UI --> CONN
    UI --> CONV
    UI --> BROWSE
    UI -->|"POST /chat/:id/message"| CHAT

    AUTH --> JWTLIB
    AUTH --> DB
    CONN --> CRYPTO
    CONN --> DB
    CONV --> DB
    BROWSE --> FORUSER

    CHAT --> SCOPE
    CHAT --> FACTORY
    CHAT --> IMG
    CHAT --> DB
    CHAT --> FORUSER

    FACTORY --> ANTH
    FACTORY --> OAI
    OAI --> NVIDIA
    OAI --> OR
    OAI --> GROQ

    SCOPE --> ToolLayer
    CHAT --> ToolLayer
    ToolLayer --> TCLIENT

    TCLIENT --> AUTHMGR
    FORUSER --> TCLIENT
    FORUSER --> CRYPTO

    ANTH -.->|"HTTPS, user's own API key"| LLMPROVIDER
    OAI -.->|"HTTPS, user's own API key"| LLMPROVIDER
    TCLIENT -.->|"HTTPS, user's own PAT"| TABLEAU
```

**Read this as:** nothing about a user's Tableau data or LLM key is shared
infrastructure — every arrow into Tableau or an LLM provider carries that
specific user's own credentials, constructed fresh per-request from
`forUser.ts`.

---

## 2. Tenant isolation (the non-negotiable guarantee)

```mermaid
sequenceDiagram
    participant UserA as User A (browser)
    participant UserB as User B (browser)
    participant Server
    participant Registry as TableauAuthRegistry<br/>(in-memory Map, src/tableau/authManager.ts)
    participant TabA as Tableau site A
    participant TabB as Tableau site B

    UserA->>Server: POST /chat (JWT: userId=A)
    Server->>Server: getTableauClientForUser("A")<br/>loads A's own encrypted PAT from DB, decrypts it
    Server->>Registry: getSession(userId="A", credsA)
    Registry-->>Server: session A (cached under key "A")
    Server->>TabA: REST call with session A's token
    TabA-->>Server: A's data only

    UserB->>Server: POST /chat (JWT: userId=B)
    Server->>Server: getTableauClientForUser("B")<br/>loads B's own encrypted PAT from DB, decrypts it
    Server->>Registry: getSession(userId="B", credsB)
    Registry-->>Server: session B (cached under key "B" — never A's)
    Server->>TabB: REST call with session B's token
    TabB-->>Server: B's data only

    Note over Registry: Sessions are keyed by userId.<br/>There is no code path where A's cached<br/>session can be handed to a request for B —<br/>proven under concurrency by<br/>tests/tenantIsolation.test.ts (runs on every change).
```

Additional isolation guarantees enforced at the data layer:
- Every Prisma query for connections/conversations/messages is scoped with
  `where: { userId }` — confirmed in `connections.ts`, `conversations.ts`,
  `chat.ts`.
- Secrets (`TableauConnection.encryptedPat`, `LlmConnection.encryptedApiKey`)
  are AES-256-GCM encrypted at rest (`src/lib/crypto.ts`) and only decrypted
  in-memory, per-request, for that row's own owning user.

---

## 3. Chat message lifecycle (the orchestration loop)

```mermaid
flowchart TD
    START(["User sends a message<br/>POST /chat/:conversationId/message"]) --> LOAD["Load user's TableauConnection + LlmConnection<br/>(decrypt secrets, build TableauClient + LlmAdapter)"]
    LOAD --> HIST["Rebuild conversation history from DB<br/>(system prompt + scope addendum + prior messages)"]
    HIST --> FILTER["Filter tool schemas by conversation scope<br/>(getBlockedToolNames — src/lib/scope.ts)<br/>fewer tools offered = lower fixed token cost"]
    FILTER --> LOOP{"Tool round<br/>(max 8)"}

    LOOP -->|"send history + tools"| LLM["LLM provider<br/>(Anthropic / OpenAI-compatible)"]
    LLM -->|"413 too large"| SHRINK["sendTurnWithImageFallback:<br/>shrink last image in history,<br/>retry ONCE"]
    SHRINK --> LLM
    LLM -->|"final answer"| ANSWER["Persist assistant message<br/>Return reply to browser"]
    LLM -->|"tool call(s)"| EXEC["executeScopedTool()<br/>src/lib/scope.ts"]

    EXEC --> SCOPECHECK{"Scope active?"}
    SCOPECHECK -->|"view/workbook/project scoped"| ENFORCE["Force/override id args to scope,<br/>or reject the call outright<br/>(hard server-side rule, not just prompting)"]
    SCOPECHECK -->|"no scope"| PASS["Pass through unchanged"]
    ENFORCE --> RUN["executeTool() — src/tools/index.ts<br/>runs against the user's own TableauClient"]
    PASS --> RUN

    RUN -->|"result has imageBase64?"| IMGROUTE["Route bytes via ChatMessage.image<br/>(per-adapter delivery — see §5)<br/>redact base64 from the logged/text copy"]
    RUN -->|"normal JSON/CSV result"| TEXTROUTE["Feed back as tool-role message content"]
    IMGROUTE --> LOOP
    TEXTROUTE --> LOOP

    ANSWER --> END(["Persist tool-call log + image (for reload)<br/>in Message.toolCalls (DB)"])
```

Key correctness properties:
- **Max 8 rounds** — bounds cost and prevents infinite tool-call loops.
- **One tool call per round** on OpenAI-compatible providers
  (`parallel_tool_calls: false`) — several free-tier models reject
  multi-call responses outright.
- **Scope enforcement is server-side**, not just prompted — a scoped
  conversation cannot reach another view/workbook/project's data even if the
  model tries, because `executeScopedTool` rewrites or rejects the call
  before it reaches Tableau.
- A provider error (network, 429, 413, 401…) is caught, logged safely
  (no secrets), turned into a friendly message, and returns HTTP 502 — it
  never crashes the Node process.

---

## 4. Drill-down scope (Project → Workbook → View)

```mermaid
flowchart LR
    NONE(["No scope<br/>(whole site)"]) -->|"user picks a project"| PROJ["Project scope"]
    PROJ -->|"user picks a workbook"| WB["Workbook scope"]
    WB -->|"user picks a view/dashboard"| VIEW["View scope"]
    VIEW -->|"Clear"| NONE
    WB -->|"Clear"| NONE
    PROJ -->|"Clear"| NONE

    subgraph Blocked at each level
      direction TB
      B0["No scope: nothing blocked"]
      B1["Project scope: blocks list_projects,<br/>list_site_views, search_content,<br/>list_datasources (site-wide only)"]
      B2["Workbook/View scope: blocks ALL<br/>site/project discovery tools +<br/>list_datasources (site-wide only)"]
    end

    NONE -.-> B0
    PROJ -.-> B1
    WB -.-> B2
    VIEW -.-> B2
```

Stored on the `Conversation` row (`prisma/schema.prisma`):
`scopeProjectId/Name`, `scopeWorkbookId/Name/Link`,
`scopeViewId/Name/Link` — nullable, cascading (clearing a workbook clears
its view too). The `...Link` fields cache the direct Tableau URL at
selection time so the "offer the link first" behavior (§6) never needs an
extra lookup.

---

## 5. Image pipeline (`get_view_image` / `get_dashboard_summary` fallback)

```mermaid
sequenceDiagram
    participant Model as LLM
    participant Chat as chat.ts
    participant Tool as contentTools.ts
    participant Tableau as Tableau REST API
    participant Jimp as image.ts (Jimp)
    participant Browser

    Model->>Chat: tool_call get_view_image(viewId)
    Chat->>Tool: executeScopedTool → getViewImage()
    Tool->>Tableau: GET /views/{viewId}/image?resolution=...
    Tableau-->>Tool: raw PNG (full dashboard composite)
    Tool->>Jimp: resizeAndCompress(png, 700px, quality 55)
    Jimp-->>Tool: compressed JPEG buffer
    Tool-->>Chat: { mediaType, imageBase64, sizeBytes }

    Chat->>Chat: extract imageBase64 into ChatMessage.image;<br/>redact it from the text copy sent back to the model as a tool result
    Chat->>Model: image delivered per-adapter:<br/>Anthropic → tool_result content block<br/>OpenAI-compatible → follow-up user message w/ image_url

    alt Provider rejects as 413 (too large)
        Chat->>Jimp: resizeAndCompress(same image, 450px, quality 35)
        Chat->>Model: retry ONCE with smaller image
    end

    Chat->>Browser: responseToolCalls (with image) + persisted to DB<br/>(Message.toolCalls JSON — survives page reload)
    Browser->>Browser: render <img> behind "🖼️ Image" toggle;<br/>click to open zoomable lightbox (1x→1.5x→2x→3x)
```

**Why the image is compressed so aggressively:** some BYOK providers (seen
in practice: Groq's free tier) enforce an ~8000 tokens-per-minute limit that
a raw dashboard PNG blows through instantly once combined with system
prompt + tool schemas. The compression pipeline plus the 413 auto-retry
exist specifically to keep image-based questions working within that
constraint without the user needing to know about it.

---

## 6. The three ways a user can inspect one dashboard

```mermaid
flowchart TD
    ASK(["User asks about a specific<br/>project/workbook/view"]) --> LINKFIRST["LINK-FIRST RULE:<br/>assistant gives the direct Tableau link first,<br/>asks whether to pull data/image into chat<br/>(saves the user LLM tokens if they'd rather just look)"]

    LINKFIRST -->|"user confirms"| CHOICE{"What do they want?"}
    LINKFIRST -->|"user opens the link themselves"| DONE1(["Done — no further LLM cost"])

    CHOICE -->|"'show me the picture'"| IMAGE["get_view_image<br/>→ real dashboard screenshot<br/>rendered inline + zoomable"]
    CHOICE -->|"'give me one specific number/chart'"| SINGLE["get_view_data(viewId)<br/>→ one sheet's CSV,<br/>auto-rendered as a Chart.js chart"]
    CHOICE -->|"'give me a complete text overview'"| SUMMARY["get_dashboard_summary(viewId, workbookId)<br/>→ combines every OTHER published sheet<br/>in the same workbook into one response"]

    SUMMARY -->|"few/no other published sheets found<br/>(charts are just titled regions in ONE sheet,<br/>not separate views)"| DSFALLBACK["list_workbook_datasources(workbookId)<br/>→ finds the workbook's own datasource"]
    DSFALLBACK -->|"queryable: true"| QUERY["get_datasource_metadata + query_datasource<br/>grouped per chart (e.g. by Country, by Channel)<br/>→ real reconstructed numbers per chart"]
    DSFALLBACK -->|"not independently published<br/>(embedded-only datasource)"| VISUALFALLBACK["Explicit last-resort fallback:<br/>get_view_image + caveated visual reading<br/>('approximately, read from image — not exact')"]

    IMAGE --> RENDER(["Rendered in browser<br/>public/app.js — Chart.js / <img> + lightbox"])
    SINGLE --> RENDER
    QUERY --> RENDER
    VISUALFALLBACK --> RENDER
```

This chain exists because of a genuine Tableau REST API limitation: there is
**no endpoint that returns a whole dashboard's combined data in one call**.
Each fallback step is a progressively-less-precise workaround for that gap,
and the system prompt (`src/routes/chat.ts`) instructs the model to try them
in this exact order rather than giving up after the first miss.

---

## 7. LLM provider abstraction

```mermaid
classDiagram
    class LlmAdapter {
        <<interface>>
        +sendTurn(history, tools) LlmTurnResult
        +validateKey(apiKey) boolean
    }
    class AnthropicAdapter {
        +sendTurn()
        +validateKey()
        images: embedded in tool_result content block
    }
    class OpenAiAdapter {
        +sendTurn()
        +validateKey()
        +toOpenAiMessages() splits multi-tool-call turns
        parallel_tool_calls: false
        images: follow-up user message w/ image_url
        baseURL: api.openai.com
    }
    class NvidiaAdapter {
        baseURL: integrate.api.nvidia.com
    }
    class OpenRouterAdapter {
        baseURL: openrouter.ai/api
    }
    class GroqAdapter {
        baseURL: api.groq.com
        vision-capable models supported
    }

    LlmAdapter <|.. AnthropicAdapter
    LlmAdapter <|.. OpenAiAdapter
    OpenAiAdapter <|-- NvidiaAdapter
    OpenAiAdapter <|-- OpenRouterAdapter
    OpenAiAdapter <|-- GroqAdapter

    class Factory {
        +createLlmAdapter(provider, apiKey, model) LlmAdapter
    }
    Factory ..> LlmAdapter : creates
```

**Adding a 6th provider is a small, contained change:** one new adapter file
(often just a `baseURL` override on `OpenAiAdapter`, as NVIDIA/OpenRouter/Groq
already are) plus one new `case` in `src/llm/factory.ts`. Nothing else in the
codebase needs to know a new provider exists.

---

## 8. Data model

```mermaid
erDiagram
    User ||--o{ TableauConnection : owns
    User ||--o{ LlmConnection : owns
    User ||--o{ Conversation : owns
    Conversation ||--o{ Message : contains

    User {
        string id PK
        string email UK
        string passwordHash
        datetime createdAt
    }
    TableauConnection {
        string id PK
        string userId FK
        string siteUrl
        string siteContentUrl
        string encryptedPat "AES-256-GCM"
        datetime createdAt
    }
    LlmConnection {
        string id PK
        string userId FK
        string provider "anthropic|openai|nvidia|openrouter|groq"
        string encryptedApiKey "AES-256-GCM"
        string model
        datetime createdAt
    }
    Conversation {
        string id PK
        string userId FK
        string title
        string scopeProjectId "nullable"
        string scopeWorkbookId "nullable"
        string scopeViewId "nullable"
        string scopeWorkbookLink "nullable, cached URL"
        string scopeViewLink "nullable, cached URL"
        datetime createdAt
    }
    Message {
        string id PK
        string conversationId FK
        string role "user|assistant"
        string content
        string toolCalls "JSON, incl. images — for chip UI + reload"
        datetime createdAt
    }
```

`POST /connections/tableau` and `/connections/llm` replace (delete +
create, in one transaction) rather than accumulate, so exactly one
connection of each type exists per user at any time — this closed a real bug
where stale duplicate connections were silently reused.

---

## 9. Full tool catalog (64 tools, 6 modules)

```mermaid
flowchart LR
    subgraph Discovery["Discovery — no id required"]
        d1[list_projects]
        d2[list_workbooks]
        d3[list_flows]
        d4[list_virtual_connections]
        d5[list_site_views]
        d6[search_content]
        d7[list_datasources]
        d8[list_pulse_metrics]
        d9[list_users]
        d10[search_fields]
    end

    subgraph Detail["Detail — requires a real id from Discovery"]
        v1["list_workbook_views(workbookId)"]
        v2["get_view_data(viewId)"]
        v3["get_view_image(viewId)"]
        v4["get_dashboard_summary(viewId, workbookId)"]
        v5["list_workbook_datasources(workbookId)"]
        v6["get_datasource_metadata(datasourceLuid)"]
        v7["query_datasource(datasourceLuid)"]
        v8["get_field_values(datasourceLuid)"]
        v9["get_pulse_metric_insight(definitionId)"]
        v10["check_permissions(contentId)"]
        v11["refresh_extract_status(datasourceId)"]
        v12["get_dashboard_insights(viewId)"]
        v13["get_datasource_glossary(datasourceLuid)"]
        v14["get_field_usage(datasourceLuid)"]
        v15["get_metric_definition(definitionId)"]
    end

    subgraph Analytical["Analytical — datasourceLuid, resolved from the above"]
        a1["compare_periods(datasourceLuid)"]
        a2["explain_change(datasourceLuid)"]
        a3["anomaly_detection(datasourceLuid)"]
        a4["forecast_metric(datasourceLuid)"]
        a5["get_metric_history(definitionId)"]
        a6["get_data_quality_warnings(datasourceLuid)"]
        a7["get_field_lineage(datasourceLuid)"]
        a8["cross_datasource_query(datasourceLuids)"]
        a9["rank_categories(datasourceLuid)"]
        a10["pivot_cross_tab(datasourceLuid)"]
        a11["rollup_time_series(datasourceLuid)"]
        a12["correlation_analysis(datasourceLuid)"]
        a13["field_statistics(datasourceLuid)"]
        a14["bucketize_metric(datasourceLuid)"]
        a15["share_of_total(datasourceLuid)"]
        a16["get_summary_table(datasourceLuid)"]
    end

    subgraph ContentAdmin["Content & admin — REST, ids from Discovery/Detail"]
        c1["get_workbook_details(workbookId)"]
        c2["get_workbook_thumbnail(workbookId)"]
        c3["get_view_pdf(viewId)"]
        c4["list_workbook_revisions(workbookId)"]
        c5["list_tags(workbookId)"]
        c6["add_tags(workbookId, tags)"]
        c7["remove_tags(workbookId, tag)"]
        c8["list_favorites(userId?)"]
        c9["add_favorite(contentType, contentId)"]
        c10["remove_favorite(contentType, contentId)"]
        c11["list_custom_views(workbookId?)"]
        c12["get_custom_view_image(customViewId)"]
        c13["get_data_quality_warning(contentType, contentId)"]
        c14["query_workbook_permissions(workbookId)"]
        c15["query_view_permissions(viewId)"]
        c16["query_datasource_permissions(datasourceId)"]
        c17["list_subscriptions"]
        c18["list_data_driven_alerts"]
        c19["list_schedules"]
        c20["list_groups"]
        c21["get_group_members(groupId)"]
        c22["get_server_info"]
    end

    d1 --> v1
    d2 --> v1
    d6 --> v1
    d7 --> v6
    d5 --> v4
    v1 --> v2
    v1 --> v3
    v2 --> v4
    v5 --> v6
    v6 --> v7
    v7 --> v8
    v6 --> a1
    v6 --> a3
    v6 --> a4
    v6 --> a6
    v6 --> a7
    v6 --> a9
    v6 --> a10
    v6 --> a11
    v6 --> a12
    v6 --> a13
    v6 --> a14
    v6 --> a15
    v6 --> a16
    d10 --> v6
    a8 --> v6
    d2 --> c1
    d2 --> c2
    d2 --> c4
    d2 --> c5
    d2 --> c6
    d2 --> c7
    d2 --> c14
    v1 --> c3
    v1 --> c15
    v1 --> c11
    c11 --> c12
    d7 --> c16
    d1 --> c20
    c20 --> c21
```

| Tool | Module | Purpose |
|---|---|---|
| `list_projects` | contentTools.ts | List projects (folders), paginated |
| `list_workbooks` | contentTools.ts | List workbooks, filterable by project/name |
| `list_flows` | contentTools.ts | List Tableau Prep flows |
| `list_virtual_connections` | contentTools.ts | List virtual connections |
| `search_content` | contentTools.ts | One-call search across workbooks/datasources/flows/projects |
| `list_workbook_views` | contentTools.ts | Views (sheets/dashboards) inside one workbook |
| `list_site_views` | contentTools.ts | Every view site-wide in one call (avoids N+1 looping) |
| `get_view_data` | contentTools.ts | One view's underlying data as CSV |
| `get_view_image` | contentTools.ts | Rendered dashboard screenshot (resized/compressed JPEG) |
| `get_dashboard_summary` | contentTools.ts | Combines every other sheet in a dashboard's workbook into one text overview |
| `list_datasources` | tableauTools.ts | Site-wide published datasources |
| `list_workbook_datasources` | tableauTools.ts | The specific datasource(s) behind one workbook |
| `get_datasource_metadata` | tableauTools.ts | Fields/types available in a datasource (GraphQL Metadata API) |
| `query_datasource` | tableauTools.ts | Aggregate/filter/sort query against a datasource (VizQL Data Service) |
| `get_field_values` | tableauTools.ts | Distinct values for one field |
| `list_pulse_metrics` | pulseTools.ts | Tableau Pulse metrics |
| `get_pulse_metric_insight` | pulseTools.ts | Insight detail for one Pulse metric |
| `get_datasource_glossary` | semanticTools.ts | Field glossary — captions, types, roles, descriptions, formulas |
| `get_field_usage` | semanticTools.ts | Which sheets/workbooks reference a field |
| `get_metric_definition` | semanticTools.ts | Resolves a Pulse metric's formula (e.g. SUM(Revenue)) |
| `get_dashboard_insights` | semanticTools.ts | Computed stats (min/max/avg/sum, top values) from a view's data |
| `recommend_visualization` | semanticTools.ts | Chart-type advice from field roles (pure logic, no Tableau call) |
| `compare_periods` | analyticalTools.ts | Diff a measure between two date windows (overall + per-dimension, % change) |
| `explain_change` | analyticalTools.ts | compare_periods + ranked "drivers" of the change (attribution) |
| `anomaly_detection` | analyticalTools.ts | Z-score outliers in a time-bucketed series |
| `forecast_metric` | analyticalTools.ts | Least-squares linear forecast with ±1σ confidence band |
| `get_metric_history` | analyticalTools.ts | A Pulse metric's value over time (resolved from its own spec) |
| `get_data_quality_warnings` | analyticalTools.ts | Data-quality warnings on a datasource + fields |
| `get_field_lineage` | analyticalTools.ts | Upstream source columns + downstream sheets for a field |
| `search_fields` | analyticalTools.ts | Site-wide field-name search (Metadata API searchFields) |
| `cross_datasource_query` | analyticalTools.ts | One measure across several datasources, merged with a grand total |
| `rank_categories` | analyticalTools.ts | Top/bottom N members by measure, with % of total + cumulative share |
| `pivot_cross_tab` | analyticalTools.ts | Rows x columns matrix for a measure with row/column totals |
| `rollup_time_series` | analyticalTools.ts | A measure bucketed to day/week/month/quarter/year, sorted |
| `correlation_analysis` | analyticalTools.ts | Pearson + Spearman correlation between two measures |
| `field_statistics` | analyticalTools.ts | min/max/avg/median from VDS + sampled null%/cardinality/percentiles |
| `bucketize_metric` | analyticalTools.ts | Client-side equal-width histogram bins for a measure |
| `share_of_total` | analyticalTools.ts | Each member's share + cumulative %, with a baseline share delta |
| `get_summary_table` | analyticalTools.ts | One-call insights digest: total, monthly trend, top contributor |
| `list_users` | adminTools.ts | Site users (admin-gated by Tableau itself) |
| `check_permissions` | adminTools.ts | Permission check for a datasource, workbook, or view |
| `refresh_extract_status` | adminTools.ts | Extract refresh status for a datasource |
| `get_workbook_details` | contentTools.ts | Workbook metadata — description, project, owner, size, tags, link |
| `get_workbook_thumbnail` | contentTools.ts | Workbook preview image (resized/compressed JPEG) |
| `get_view_pdf` | contentTools.ts | PDF export of a view — embed + download in the chat, never routed to the model |
| `list_workbook_revisions` | contentTools.ts | Revision history for a workbook (number, time, author) |
| `list_tags` | contentTools.ts | Tags on a workbook |
| `add_tags` | contentTools.ts | PUT tags onto a workbook (write tool — executes immediately) |
| `remove_tags` | contentTools.ts | DELETE a tag from a workbook (write tool) |
| `list_favorites` | contentTools.ts | A user's favorites grouped by type (defaults to the signed-in user) |
| `add_favorite` | contentTools.ts | Favorite a workbook/view/datasource/flow (write tool) |
| `remove_favorite` | contentTools.ts | Un-favorite a workbook/view/datasource/flow (write tool) |
| `list_custom_views` | contentTools.ts | Custom views site-wide, optionally filtered by workbook |
| `get_custom_view_image` | contentTools.ts | A custom view's preview image (resized/compressed JPEG) |
| `get_data_quality_warning` | contentTools.ts | Data-quality warnings on a workbook/datasource/flow |
| `query_workbook_permissions` | adminTools.ts | Per-user/group capabilities on a workbook |
| `query_view_permissions` | adminTools.ts | Per-user/group capabilities on a view |
| `query_datasource_permissions` | adminTools.ts | Per-user/group capabilities on a datasource |
| `list_subscriptions` | adminTools.ts | Email subscriptions on the site (subject, schedule, content, user) |
| `list_data_driven_alerts` | adminTools.ts | Data-driven alerts on the site (metric, creator, subject) |
| `list_schedules` | adminTools.ts | Extract-refresh/subscription schedules with frequency + next run |
| `list_groups` | adminTools.ts | Groups on the site with their default role |
| `get_group_members` | adminTools.ts | Users in a specific group |
| `get_server_info` | adminTools.ts | Tableau product/version/build/REST API version (cheap diagnostic) |

---

## 10. Frontend rendering (no build step)

```mermaid
flowchart LR
    RESP["Chat API response<br/>{ reply, toolCalls[] }"] --> RENDER["buildMessageEl() — public/app.js"]
    RENDER --> CHIP["Tool-call chip<br/>(name + args, collapsible)"]
    RENDER --> CHART{"result has<br/>chartable rows?"}
    RENDER --> IMG{"result has<br/>image.base64?"}
    RENDER --> PDF{"result has<br/>pdf.base64?"}

    CHART -->|yes| CHARTJS["Chart.js bar/line chart<br/>(CDN script tag, no bundler)"]
    IMG -->|yes| IMGEL["<img> data: URI<br/>behind '🖼️ Image' toggle"]
    IMGEL --> LIGHTBOX["Click → full-screen lightbox<br/>zoom 1x/1.5x/2x/3x, Esc/backdrop to close"]
    PDF -->|yes| PDFEL["<iframe> object URL<br/>behind '📄 PDF' toggle + download link"]

    RENDER --> MD["renderMarkdown()<br/>bare URLs auto-linkified,<br/>markdown links preserved"]
```

Deliberate constraint: **no React, no bundler.** Every interactive piece
(charts, image toggle, lightbox, scope dropdowns) is built with plain DOM
APIs in `public/app.js`, loaded directly via `<script>` tags in
`index.html`.

---

## 11. What's stubbed for this MVP vs. production

| Area | MVP (today) | Production path |
|---|---|---|
| Tableau auth | Pasted Personal Access Token | Full Tableau OAuth (Connected App) flow |
| Database | SQLite | Postgres — one line in `schema.prisma` |
| Tableau session cache | In-memory `Map` per process | Redis (survives restarts, works across instances) |
| Secrets encryption | AES-256-GCM, env-configured key | KMS-backed envelope encryption (`crypto.ts` is a 1-file swap point) |
| Platform auth | Email + password, JWT session | SSO / OIDC |
| Tool access control | All 64 tools available to every connected account | Fine-grained per-user tool enablement (e.g. hide admin tools from non-admins) |
| Rate limiting / billing | In-memory per-user token-bucket limits (`rateLimit.ts`) on `/chat` + `/connections/llm`; `ToolUsage`/`LlmUsage` metering (truncated args, estimated cost) + `GET /usage` + `GET /usage/summary` + frontend usage modal | Redis-backed limits, real billing/quotas tied to metered usage |
| Data retention | Tool results persisted only as long as conversation history needs them | Explicit retention policy |

---

*Generated from the codebase as of the current state of `src/`, `prisma/schema.prisma`, and `public/`. Re-generate after significant architecture changes (new provider, new tool, new scope level) to keep this accurate.*
