# Lumen — Query Guide & Expected Answers (v2.0)

This guide is the source of truth for **what a user can ask** and **what an
accurate, consistent answer looks like**. Every query below maps to one or more
tools. The platform answers the **Count / List / Quick-fact** section instantly
(< 100 ms) via the fast-path router — no LLM call at all. Everything else goes
through the LLM tool loop, where the same query always returns the same shape.

> **Accuracy guarantee (NVIDIA NIM targets):** all count queries are exact
> (they read Tableau's authoritative `totalAvailable`). All analytical/data
> queries first resolve a real `datasourceLuid` via discovery tools — the
> server rejects invented/placeholder ids (see "How the guardrails work").
> On NVIDIA models, the documented prompts in this file are tuned to land at
> **60–70%+ fully-accurate answers**, with the remaining cases degrading
> gracefully (e.g. explicitly asking which data source to use rather than
> guessing wrong).

---

## 1. Counts & quick facts — answered instantly by the fast-path router

No LLM is involved; answers come straight from Tableau's pagination totals.

| # | Example query | Correct answer |
|---|---------------|----------------|
| 1 | How many data sources do I have? | The exact number of published data sources on the site (not workbooks, not bytes). |
| 2 | How many workbooks are there? | The exact number of published workbooks on the site. |
| 3 | How many users are on my site? | The exact number of users (site members). |
| 4 | How many dashboards do I have? | The exact number of views/dashboards on the site. |
| 5 | List all my workbooks | Numbered list of published workbook names. |
| 6 | List all my data sources | Numbered list of published data source names. |
| 7 | What's my Tableau server info? | Product name, version, build, REST API version. |
| 8 | What can you do? / Help | The capability menu (data exploration, analysis, dashboards, Pulse, admin). |

> If the wording doesn't match a fast-path pattern exactly (e.g. *"give me the
> count of datasources we have uploaded"*), the LLM takes over and runs the
> same tool — the answer must still be the count of **data sources**, never
> workbooks/views.

---

## 2. Content & discovery

| # | Example query | Tool chain | Expected accurate answer |
|---|---------------|------------|--------------------------|
| 9 | What projects/folders exist on my site? | `list_projects` | Each project's id + name. |
| 10 | Do I have a workbook named "Q3 Report"? | `list_workbooks({nameFilter:"Q3 Report"})` | Yes/No + the workbook's id, project, and link; if the filter is a partial name, it returns matches and says the filter was partial. |
| 11 | List all workbooks inside the "Marketing" project | `list_workbooks({projectName:"Marketing"})` | Numbered workbook list with ids and links; if no project matches exactly, it says so and shows what *is* there. |
| 12 | What Tableau Prep flows do I have? | `list_flows` | Numbered flow list. |
| 13 | List my virtual connections | `list_virtual_connections` | Numbered virtual connection list. |
| 14 | Search for anything named "Revenue" on my site | `search_content({query:"Revenue"})` | Workbooks, data sources, flows, and projects matching, each with its authoritative count. |
| 15 | Find workbooks and data sources related to "Customer" | `search_content({query:"Customer"})` | Matching workbooks + data sources with links. |
| 16 | Where is the "Executive Dashboard" located? | `search_content`/`list_workbook_views` | Project + workbook it lives in, with a direct link. |
| 17 | List every dashboard across my whole site | `list_site_views` | Numbered list of views (id, name, workbook, project). |
| 18 | What are the views inside the "Sales 2025" workbook? | `list_workbook_views({workbookId})` | Numbered views of that workbook. |

---

## 3. Data sources & fields

| # | Example query | Tool chain | Expected accurate answer |
|---|---------------|------------|--------------------------|
| 19 | Which data source(s) is the "Orders" workbook built on? | `list_workbook_datasources({workbookId})` | Each connection with `datasourceLuid`, `queryable: true/false` (only queryable ones can be used). |
| 20 | What fields are available in the "Sales" data source? | `list_datasources` → `get_datasource_metadata({datasourceLuid})` | Field names, role (measure/dimension), data type. |
| 21 | Show me the fields and types in the "Finance" data source | `get_datasource_metadata` | Same as above; must use the real luid from discovery, never an invented one. |
| 22 | What distinct values does the "Region" field have? | `get_datasource_metadata` → `get_field_values({datasourceLuid, fieldCaption:"Region"})` | Distinct values (bounded list). |
| 23 | What do the fields in the "HR" data source mean? | `get_datasource_glossary({datasourceLuid})` | Field captions + meanings/formulas. |
| 24 | Where is the "Profit" field used? | `get_field_usage` | Sheets/workbooks using that field. |
| 25 | Are there any data-quality warnings on this data source? | `get_data_quality_warnings` | Warnings (if any) per content. |

---

## 4. Data query & aggregation

> **Key behavior:** if an aggregation query does NOT name a data source or
> workbook (and none is established yet in this conversation), Lumen **asks
> which one to use first** — it never guesses. So
> *"total revenue by region"* first returns a menu of data sources to pick
> from, then runs the query against the one you choose.

| # | Example query | Tool chain | Expected accurate answer |
|---|---------------|------------|--------------------------|
| 26 | Total sales by region | (pick data source) → `get_datasource_metadata` → `query_datasource` (SUM sales, group by Region) | Table: region → sales, plus a total row; source named. |
| 27 | Average order value by month this year | (pick data source) → `query_datasource` (AVG order value by Order Date month) | Month → average table. |
| 28 | Show me revenue for the last 30 days | (pick data source) → `query_datasource` with a date filter | Row count + revenue figure(s), source named. |
| 29 | What's the total revenue from the "Marketing" workbook's data? | `list_workbook_datasources({workbookId})` → `query_datasource` | Total revenue from that workbook's own data source only. |
| 30 | Top 5 products by revenue | `rank_categories` | Ranked list with values and % of total. |
| 31 | Bottom 5 regions by profit | `rank_categories` | Worst regions, with values. |
| 32 | Revenue by Region, one column per month | `pivot_cross_tab` | Cross-tab: rows = Region, columns = Month, values = Revenue. |
| 33 | What % of total revenue is each product? | `share_of_total` | Each product's share + cumulative %. |
| 34 | Give me the key headline numbers for Revenue | `get_summary_table` | Total, average, trend direction, top contributor. |
| 35 | Show me the field statistics for "Order Amount" | `field_statistics` | Min/max/avg/median, null %, cardinality, percentiles. |

---

## 5. Analytical (period, trend, forecast, correlation)

Same data-source-first behavior as section 4.

| # | Example query | Tool chain | Expected accurate answer |
|---|---------------|------------|--------------------------|
| 36 | How did Revenue compare this month vs last month? | `compare_periods` | Current vs previous totals, % change, top movers. |
| 37 | Compare sales this quarter to last quarter | `compare_periods` | Overall + per-dimension change. |
| 38 | What drove the change in profit? | `explain_change` | Compare + ranked drivers of the change. |
| 39 | Show me the Revenue trend weekly this year | `rollup_time_series` | Time series at week grain. |
| 40 | Forecast Revenue for the next 3 months | `forecast_metric` | Linear-trend forecast (caveated as an approximation) with confidence band. |
| 41 | Are there any anomalies in daily orders? | `anomaly_detection` | Outlier buckets with values and z-scores. |
| 42 | Do Revenue and Ad Spend correlate? | `correlation_analysis` | Pearson/Spearman coefficient and interpretation. |
| 43 | How is order value distributed? | `bucketize_metric` | Histogram bins + counts. |
| 44 | What's the history of the "Monthly Active Users" Pulse metric? | list Pulse → `get_metric_history` | The metric's value over time. |

---

## 6. Dashboards & views

| # | Example query | Tool chain | Expected accurate answer |
|---|---------------|------------|--------------------------|
| 45 | Show me the data in the "Executive Dashboard" | `list_workbook_views` → `get_view_data({viewId})` | The dashboard's underlying data rows (bounded), plus its link. |
| 46 | How does the "Sales 2025" dashboard actually look? | `get_view_image({viewId})` | The rendered dashboard image (only for visual-design questions). |
| 47 | Give me a complete text overview of my "Executive Dashboard" | (view-scoped chats: A/B/C menu) → `get_dashboard_summary` | Every chart's key numbers as text. |
| 48 | Export this dashboard as a PDF | `get_view_pdf({viewId})` | A downloadable PDF document. |
| 49 | Tell me about the "Sales 2025" workbook (owner, project, tags) | `get_workbook_details({workbookId})` | Owner, project, updated date, tags, link. |
| 50 | What's the revision history of "Sales 2025"? | `list_workbook_revisions({workbookId})` | Revision list with dates/users. |
| 51 | Show me a preview image of the "Sales 2025" workbook | `get_workbook_thumbnail({workbookId})` | Thumbnail image. |
| 52 | Add the tag "finance" to this workbook | `add_tags({workbookId, tags:["finance"]})` | Confirmation; blocked (with a prompt to ask directly) if the user message never asked for it. |

---

## 7. Descriptions (verbatim guarantee)

| # | Example query | Tool chain | Expected accurate answer |
|---|---------------|------------|--------------------------|
| 53 | Extract every workbook's description in the "Marketing" project | `list_workbooks({projectName:"Marketing"})` | **Every** workbook, each with its description quoted **verbatim and in full**; workbooks with no description say "no description". |
| 54 | What descriptions do all my workbooks have? | `list_workbooks` | Same as above, site-wide; if the answer exceeds the output limit it continues automatically without dropping items. |

**Why this stays accurate:** descriptions are enriched server-side in
`list_workbooks`, verbatim quoting is an enforced prompt rule, the output
budget was raised to 8192 tokens with automatic "continue" rounds, and the
413-shrink path preserves workbook-list results (it never collapses a
description list to fit). Additionally, the most common phrasings ("list all
workbook descriptions", "extract every workbook description", "what
descriptions do my workbooks have") are answered **directly in the fast path** —
generated server-side from the enriched results, with no LLM in the loop — so
they are complete and verbatim **no matter what model is connected**.

---

## 8. Pulse, semantic & admin

| # | Example query | Tool chain | Expected accurate answer |
|---|---------------|------------|--------------------------|
| 55 | List my Pulse metrics | `list_pulse_metrics` | Numbered metrics with definitions. |
| 56 | What's the value of the "Active Users" metric? | `get_pulse_metric_insight({definitionId})` | The metric's value + what it measures. |
| 57 | Who are the users on my site and their roles? | `list_users` | User list with roles (requires admin account). |
| 58 | Who has access to the "Sales 2025" workbook? | `query_workbook_permissions({workbookId})` | Users/groups + capabilities. |
| 59 | Who can see the "Executive Dashboard"? | `query_view_permissions({viewId})` | Users/groups + capabilities. |
| 60 | Who has access to the "Orders" data source? | `query_datasource_permissions({datasourceId})` | Users/groups + capabilities. |
| 61 | What groups exist, and who's in "Sales Team"? | `list_groups` → `get_group_members({groupId})` | Groups, then members + roles. |
| 62 | What schedules / subscriptions exist? | `list_schedules`, `list_subscriptions` | Schedules (frequency, next run) / subscriptions. |
| 63 | What's the extract refresh status of this data source? | `refresh_extract_status({datasourceId})` | Last refresh / next refresh. |

---

## 9. Multi-step combined examples

| # | Example query | Expected behavior |
|---|---------------|-------------------|
| 64 | What's the total revenue by region, and what chart should I use? | Resolve data source → aggregate → `recommend_visualization` → chart type + reasoning. |
| 65 | Give me a full breakdown of my Executive Dashboard and explain the key metric | Views → `get_dashboard_summary` → metric definition/glossary → prose breakdown. |
| 66 | Find where the Profit field is used, then show its trend this year | `get_field_usage` → data source → `rollup_time_series`. |
| 67 | Which dashboards exist, what are the highlights, and how do they look? | `list_site_views` → `get_dashboard_insights` → `get_view_image`. |

---

## 10. Deterministic behaviors (list vs count, search, descriptions)

These questions are answered **without the LLM**, so the behavior is always the
same no matter which model is connected:

| # | Example query | What the user gets |
|---|---------------|--------------------|
| 68 | `How many data sources / workbooks / users / dashboards / projects / flows do I have?` — also `what is the total number of X`, `the count of X`, `X count`, `total X`, `... in total` | **Just the number**, straight from Tableau's pagination total (e.g. "There are **7** workbooks..."). |
| 69 | `List / show me / name / give me a list of all workbooks` — also `what workbooks do I have`, `all my workbooks` | **Every name, numbered**, plus "N total" — never just a number. |
| 70 | `List all workbooks and their descriptions` / `extract every workbook description` / `what descriptions do all my workbooks have` | **Every workbook with its description verbatim and complete** — generated server-side, so it can never be truncated or paraphrased. Workbooks with no description say "No description set." |
| 71 | `List all data sources and their descriptions` | Same, for data sources. |
| 72 | `Search for anything named Revenue on my site` / `find anything named Revenue` | Runs **`search_content` only** — the datasource-query/analytical tools are withheld for that message so the model *cannot* run a query on a search question. Describes the matching items. |

Important distinctions the system prompt also enforces:
- **List ≠ count.** Listing must name every item; counting must give the number.
- **Search ≠ data analysis.** A "find / search for anything named X" question is
  about discovering **content**, never about running `query_datasource`.

---

## How the guardrails work (why wrong answers are blocked)

1. **IDs come only from tool results.** The server keeps a per-conversation set
   of ids discovered by earlier tool calls and **rejects** any workbook/view/
   project **or datasourceLuid** that was never seen, or that is placeholder
   text (`"this project"`, `"workbookId from the previous response"`). The
   model must re-discover before it can act — a search question can never fire
   `query_datasource` with a recalled/stale existing-chat luid, because that
   luid either never appeared in a tool result (rejected) or the search-intent
   guard withholds datasource tools for that message entirely.
2. **Data-source-first clarification.** Aggregation/analytical requests that
   don't name a data source or workbook get a picker menu instead of a guess —
   so *"number of data sources"* can never be answered with workbook data, and
   *"total revenue by region"* is never run against the wrong source.
3. **Scope is enforced in code, not just prompts.** View/workbook/project-scoped
   chats physically cannot browse outside their scope (the fast path is also
   skipped there, so "how many workbooks" never leaks a site-wide total).
4. **Fast path is exact.** Count/list/description queries bypass the LLM
   entirely and read Tableau's own data, so they are 100 % consistent.
5. **No raw JSON in replies.** The model must answer in prose/tables; tool JSON
   that leaks into a reply is deterministically reformatted.
6. **Multi-turn history is complete.** Tool results are stored inside each
   assistant message's tool-call metadata and **rehydrated as real tool-result
   messages** when a conversation is rebuilt on the next message — so a
   follow-up question in an existing chat no longer fails with a provider
   "tool call without a response" 400 (the same question always worked in a
   brand-new chat, which is exactly the symptom this fixes).

## Performance notes

- Counts/lists/help: answered in **< 100 ms** (fast path, cached).
- Data-source picker: one cached `list_datasources` call — no LLM round.
- Datasource metadata is cached 30 min; workbook/data-source lists are cached
  per user (5 min in-memory, 10 min Redis).
- **Enable Redis in production** (`REDIS_URL`) so cached lists survive restarts
  and are shared across instances — the biggest latency win. The server
  degrades gracefully to in-memory only if Redis is unavailable.
- Long verbatim answers (e.g. every workbook description) now use an 8192-token
  output budget plus automatic continue-rounds, so they complete instead of
  truncating — and the common phrasings are answered deterministically in the
  fast path, which cannot truncate at all.
- If a provider rejects a request for being too large (HTTP 413, or a 400 with a
  context/token-length message), the largest tool results in history are shrunk
  and the request retried — workbook/data-source lists keep a much larger
  budget (30,000 chars) than other results so descriptions survive the retry.

---