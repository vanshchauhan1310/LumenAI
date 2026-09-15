const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Recursively walks a tool call's arguments or result payload and collects
 * every id it finds into `into`:
 *  - every UUID-shaped string anywhere in the structure (Tableau ids are
 *    UUIDs: workbookId, viewId, projectId, ...), and
 *  - every value stored under a key whose name ends in "luid" (case-
 *    insensitive), since Tableau datasourceLuids are long opaque strings —
 *    NOT dash-UUIDs — so the UUID walk above never sees them.
 * Walking the whole structure rather than matching specific keys means this
 * stays correct without having to track every tool's result shape by hand.
 */
export function collectIds(value: unknown, into: Set<string>, key?: string): void {
  if (key && /luid$/i.test(key) && typeof value === "string" && value.trim()) {
    into.add(value.trim().toLowerCase());
    return;
  }
  if (isUuidLike(value)) {
    into.add(value.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, into, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectIds(v, into, k);
  }
}

// Tool-argument keys that must hold a Tableau UUID. Unlike the generic
// placeholder scan below, these get the strict treatment: the value must be
// UUID-shaped AND one this conversation has actually seen, because a model
// that "recalled" an id from its training data can hit a REAL, unrelated
// workbook — the most dangerous failure mode.
const UUID_ID_ARGS = new Set([
  "workbookId",
  "viewId",
  "projectId",
  "flowId",
  "virtualConnectionId",
  "userId",
  "groupId",
  "definitionId",
  "metricId",
  "customViewId",
  "datasourceId",
  // Tableau datasource luids ARE UUIDs (they come straight out of the
  // `id`/`luid` field of /datasources, list_workbook_datasources, search
  // results, etc.), so `datasourceLuid` gets the same strict "UUID-shaped
  // AND discovered in this conversation" treatment. Seen in practice: a
  // search question ("find anything named Revenue") triggered
  // query_datasource with a datasourceLuid the model recalled/stale-guessed
  // — the key wasn't validated so the wrong-query executed. Now a luid that
  // never appeared in a tool result is rejected and the model is forced
  // back to list_datasources/list_workbook_datasources first.
  "datasourceLuid",
  "subscriptionId",
  "scheduleId",
  "insightId",
]);

// Phrases a weak model copies from its own plan/conversation instead of a
// real argument value ("this project", "workbookId from the previous
// response", "the datasource found above", ...). Deliberately specific — a
// genuine filter value like "the Marketing project" contains none of these
// markers, so the false-positive surface stays tiny.
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\bfrom (the |)(previous|last|prior|earlier|above|before)\b/i,
  /\b(previous|last|prior|earlier|above) (response|result|output|message|turn|step|tool ?call|answer|reply)\b/i,
  /\b(this|that|the current|the same|the above|the scoped|the selected|the given|the specified|the provided|the mentioned|the discovered|the found) (project|workbook|view|datasource|dashboard|metric|user|group|flow|id|one|luid|connection)\b/i,
  /\b(as (shown|returned|seen|found|listed) (above|before|earlier))\b/i,
  /\bid (from|of|in) (the |)(previous|last|prior|earlier|response|result|output|above)\b/i,
  /^(workbookid|viewid|projectid|datasourceluid|datasourceid|definitionid|metricid|userid|groupid)$/i,
];

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

export interface InvalidIdArg {
  arg: string;
  value: string;
  reason: "not_uuid_shape" | "unknown_uuid" | "placeholder";
}

/**
 * Validates a tool call's arguments against the set of ids legitimately
 * discovered so far in this conversation (via list_workbooks,
 * list_workbook_views, list_datasources, etc). Returns the first invalid
 * argument, or null if everything checks out:
 *  - UUID-id args (workbookId, viewId, ...) must be UUID-shaped AND already
 *    discovered — catches both "workbookId: \"workbookId from the previous
 *    response\"" (wrong shape; findUnknownId's UUID-only walk sailed right
 *    past it and executed the garbage against Tableau) and a wholly invented
 *    but well-formed UUID costing a real 404 round trip.
 *  - Every other string arg is scanned for conversational placeholder
 *    phrases — catches projectName: "this project", which the exact-match
 *    project filter then silently turned into total: 0.
 *
 * This exists because prompting alone ("never invent an id") doesn't
 * reliably stop weaker models — seen in practice. Catching it here turns a
 * guaranteed-wrong Tableau call into an immediate, cheap, actionable error
 * the model can recover from in the next turn.
 */
export function findInvalidIdArg(input: unknown, knownIds: ReadonlySet<string>): InvalidIdArg | null {
  if (!input || typeof input !== "object") return null;
  for (const [arg, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (UUID_ID_ARGS.has(arg)) {
      if (!isUuidLike(value)) {
        return { arg, value, reason: "not_uuid_shape" };
      }
      if (!knownIds.has(value.toLowerCase())) {
        return { arg, value, reason: "unknown_uuid" };
      }
      continue;
    }
    if (looksLikePlaceholder(value)) {
      return { arg, value, reason: "placeholder" };
    }
  }
  return null;
}

/**
 * Back-compat wrapper for the original UUID-only check (still used in one
 * place); returns the offending value or null.
 */
export function findUnknownId(input: unknown, knownIds: ReadonlySet<string>): string | null {
  const found = findInvalidIdArg(input, knownIds);
  return found && found.reason !== "placeholder" ? found.value : null;
}
