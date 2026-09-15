# Architecture

## Tenant isolation

Every Tableau call goes through a `TableauClient` constructed with a specific
`userId` plus that user's own decrypted credentials (`src/tableau/client.ts`).
The in-memory `TableauAuthRegistry` (`src/tableau/authManager.ts`) caches
sign-in sessions keyed by `userId`, never globally — there is no code path
that can hand user A's cached token to a request made on behalf of user B.
See `tests/tenantIsolation.test.ts` for a concurrency-level proof.

## Secrets

Tableau PATs and LLM API keys are encrypted at rest with AES-256-GCM
(`src/lib/crypto.ts`), keyed by `ENCRYPTION_KEY` from the environment. Errors
thrown from the Tableau client never include the PAT or auth token in the
message. `GET /connections` never returns raw secrets.

**Swapping in a real KMS later:** replace the body of `encryptSecret` /
`decryptSecret` with calls to your KMS client (e.g. AWS KMS `Encrypt`/`Decrypt`,
or envelope encryption with a KMS-managed data key). Every caller only depends
on the two function signatures in `src/lib/crypto.ts`, so this is a
single-file change.

## Provider abstraction

`src/llm/types.ts` defines `LlmAdapter` — one method to send a turn (history +
tool definitions) and get back either a final answer or pending tool calls,
plus a `validateKey()` used at connection-save time. `AnthropicAdapter` and
`OpenAiAdapter` implement it; `src/llm/factory.ts` is the only place that
switches on provider name. Adding a third provider = one new adapter file +
one new `case` in the factory.

## Orchestration loop

`src/routes/chat.ts`: load the user's `LlmConnection` + `TableauConnection` →
build tool definitions → call the LLM adapter → if it requests tool calls,
execute them against the user's own `TableauClient`, feed results back, repeat
(capped at 5 rounds) → persist user + assistant messages → return the reply.

## What's stubbed for this MVP (vs. production)

| Area | MVP | Production |
|---|---|---|
| Tableau auth | Pasted Personal Access Token | Full Tableau OAuth (Connected App) flow |
 | DB | Supabase (managed Postgres) | Create a project at supabase.com, run supabase_schema.sql, set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env |
| Tableau session cache | In-memory `Map` per process | Redis (or similar), so it survives restarts and works across multiple server instances |
| Secrets encryption | AES-256-GCM with an env-configured key | KMS-backed envelope encryption |
| Platform auth | Email + password, JWT session | SSO / OIDC |
| Tools exposed | All 16 tools from the original single-tenant MCP server | Fine-grained per-user tool enablement (e.g. hide admin tools from non-admin accounts) |
| Rate limiting / billing | None | Per-user rate limits, usage metering for BYOK cost visibility |
| Data retention | Tool results are not persisted beyond the message log needed for conversation history | Explicit retention policy / row-level data never stored long-term |
