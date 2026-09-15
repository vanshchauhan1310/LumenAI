/**
 * Final-answer sanitation for chat replies (see chat.ts usage).
 *
 * Last-resort guard against raw tool-result JSON reaching the user verbatim.
 * If the model's final answer is (or contains a fenced block of) the tool
 * result JSON it was just handed, this reformats it into plain prose —
 * total+items → "Found N <things>:" + a numbered list, flat objects →
 * key/value lines. Anything it can't confidently parse is returned
 * unchanged, so a legitimately code-formatted answer is never mangled.
 */

/** Extracts a parseable JSON payload from a reply, if one is present at all. */
function tryParseJsonPayload(text: string): { data: any; raw: string } | null {
  // ```json fenced block first, then a bare message that IS a JSON object/array.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter((c): c is string => typeof c === "string");
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      return { data: JSON.parse(trimmed), raw: trimmed };
    } catch {
      // not parseable — try the next candidate
    }
  }
  return null;
}

const ITEM_LABELS: Record<string, string> = {
  workbooks: "workbook",
  datasources: "data source",
  views: "view",
  dashboards: "dashboard",
  projects: "project",
  flows: "flow",
  users: "user",
  groups: "group",
  metrics: "metric",
  items: "item",
  results: "result",
};

const MAX_LISTED_ITEMS = 15;

/** Renders one list item as a short "name — extra" line. */
function itemToLine(item: any, index: number): string {
  if (item == null || typeof item !== "object") return `${index + 1}. ${String(item)}`;
  const name = item.name ?? item.title ?? item.label ?? item.caption ?? item.userName ?? item.login ?? item.contentUrl;
  const extraKeys = ["project", "owner", "siteRole", "type", "fieldName", "luid", "datasourceLuid"];
  const extras = extraKeys
    .map((k) => (item[k] != null && typeof item[k] !== "object" ? `${k}: ${item[k]}` : null))
    .filter(Boolean);
  return `${index + 1}. ${name ?? "(unnamed)"}${extras.length ? ` — ${extras.join(", ")}` : ""}`;
}

/** Deterministically converts a tool-result-shaped JSON value into prose. */
function jsonToProse(data: any, depth = 0): string | null {
  if (depth > 2 || data == null) return null;
  if (Array.isArray(data)) {
    if (!data.length) return "No results were found.";
    const lines = data.slice(0, MAX_LISTED_ITEMS).map((item, i) => itemToLine(item, i));
    if (data.length > MAX_LISTED_ITEMS) lines.push(`…and ${data.length - MAX_LISTED_ITEMS} more.`);
    return lines.join("\n");
  }
  if (typeof data !== "object") return String(data);

  if (typeof data.error === "string" && Object.keys(data).length <= 3) {
    return `The tool reported an error: ${data.error}`;
  }

  // Canonical list-result shape: { total, <arrayField>: [...], ... }
  const arrayKey = Object.keys(data).find((k) => Array.isArray(data[k]));
  if (arrayKey) {
    const items = data[arrayKey];
    const noun = ITEM_LABELS[arrayKey.toLowerCase()] ?? arrayKey.replace(/s$/, "");
    const count = typeof data.total === "number" ? data.total : items.length;
    if (!items.length || count === 0) {
      return `No ${noun}s were found${data.query || data.nameFilter ? ` for "${data.query ?? data.nameFilter}"` : ""}.`;
    }
    const header = `Found **${count}** ${noun}${count === 1 ? "" : "s"}:`;
    const listed = jsonToProse(items, depth + 1) ?? "";
    const extras = Object.entries(data)
      .filter(([k, v]) => k !== arrayKey && k !== "total" && k !== "hasMore" && k !== "offset" && k !== "note" && v != null)
      .map(([k, v]) => (typeof v !== "object" ? `${k}: ${v}` : null))
      .filter(Boolean);
    return [header, listed, ...(extras.length ? ["", ...extras] : [])].join("\n");
  }

  // Flat object → "key: value" lines (small summaries like get_server_info).
  const entries = Object.entries(data).filter(([, v]) => typeof v !== "object" || v == null);
  if (entries.length && entries.length === Object.keys(data).length) {
    return entries.map(([k, v]) => `**${k}**: ${String(v)}`).join("\n");
  }
  return null;
}

export function sanitizeFinalAnswer(text: string): string {
  if (!text || !text.includes("{")) return text;
  const parsed = tryParseJsonPayload(text);
  if (!parsed) return text;
  // Only intervene when the JSON dominates the reply (it IS the reply, or
  // sits alone in a fenced block) — not when the model merely quoted a
  // snippet inside an otherwise-prose answer.
  const dominates =
    parsed.raw.length >= text.replace(/```(?:json)?|```/gi, "").length * 0.9 &&
    parsed.raw.length > 40;
  if (!dominates) return text;
  const prose = jsonToProse(parsed.data);
  return prose ?? text;
}