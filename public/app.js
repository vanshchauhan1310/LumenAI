// ---------- State ----------
let token = localStorage.getItem("lumen_token") || null;
let currentUser = null;
let conversations = [];
let activeConversationId = null;
let authMode = "login";
let providerTab = "anthropic";
let sending = false;
let currentTableauConnectionId = null;
let currentLlmConnectionId = null;
let chartIdCounter = 0;
let typingCycleTimer = null;      // cycles the generic "thinking" label while no live tool is running
let typingToolLabel = null;       // set to the active tool's label so cycling pauses during a real tool call
let currentAbortController = null; // lets the Stop button cancel an in-flight chat request
const activeCharts = new Map(); // chartId -> Chart.js instance, so re-toggling doesn't leak instances
let usageChartInstance = null;

// ---------- Image lightbox ----------
// Single reusable overlay for zooming tool-result images (get_view_image
// snapshots) full-screen. Click the thumbnail to open; click the image to
// step through zoom levels; +/- buttons for the same; click the dark
// backdrop, the close button, or Escape to dismiss.
const ZOOM_LEVELS = [1, 1.5, 2, 3];
let lightboxZoomIndex = 0;
let lightboxEls = null;

function ensureLightbox() {
  if (lightboxEls) return lightboxEls;

  const overlay = document.createElement("div");
  overlay.className = "image-lightbox-overlay hidden";

  const toolbar = document.createElement("div");
  toolbar.className = "image-lightbox-toolbar hidden";

  const zoomInBtn = document.createElement("button");
  zoomInBtn.className = "image-lightbox-btn";
  zoomInBtn.textContent = "+";
  zoomInBtn.title = "Zoom in";
  zoomInBtn.onclick = (e) => { e.stopPropagation(); stepZoom(1); };

  const zoomOutBtn = document.createElement("button");
  zoomOutBtn.className = "image-lightbox-btn";
  zoomOutBtn.textContent = "−";
  zoomOutBtn.title = "Zoom out";
  zoomOutBtn.onclick = (e) => { e.stopPropagation(); stepZoom(-1); };

  const closeBtn = document.createElement("button");
  closeBtn.className = "image-lightbox-btn";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close";
  closeBtn.onclick = (e) => { e.stopPropagation(); closeImageLightbox(); };

  toolbar.appendChild(zoomInBtn);
  toolbar.appendChild(zoomOutBtn);
  toolbar.appendChild(closeBtn);

  const img = document.createElement("img");
  img.className = "image-lightbox-img";
  img.onclick = (e) => {
    e.stopPropagation();
    stepZoom(1, /* wrap */ true);
  };

  overlay.appendChild(img);
  overlay.onclick = () => closeImageLightbox();
  document.body.appendChild(overlay);
  document.body.appendChild(toolbar);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) closeImageLightbox();
  });

  lightboxEls = { overlay, img, toolbar };
  return lightboxEls;
}

function applyLightboxZoom() {
  const { img } = lightboxEls;
  const scale = ZOOM_LEVELS[lightboxZoomIndex];
  img.style.transform = `scale(${scale})`;
  img.classList.toggle("zoomed", scale > 1);
}

function stepZoom(direction, wrap) {
  const next = lightboxZoomIndex + direction;
  if (next < 0 || next >= ZOOM_LEVELS.length) {
    if (wrap) lightboxZoomIndex = 0; // clicking past max zoom resets to fit
    else return;
  } else {
    lightboxZoomIndex = next;
  }
  applyLightboxZoom();
}

function openImageLightbox(src) {
  const { overlay, img, toolbar } = ensureLightbox();
  img.src = src;
  lightboxZoomIndex = 0;
  applyLightboxZoom();
  overlay.classList.remove("hidden");
  toolbar.classList.remove("hidden");
}

function closeImageLightbox() {
  if (!lightboxEls) return;
  lightboxEls.overlay.classList.add("hidden");
  lightboxEls.toolbar.classList.add("hidden");
}

const modelPlaceholders = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
  gemini: "gemini-3.5-flash",
  nvidia: "nvidia/llama-3.1-nemotron-70b-instruct",
  openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free",
  groq: "qwen/qwen3.6-27b",
  mistral: "mistral-large-latest",
  deepseek: "deepseek-chat",
};

const apiKeyHints = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  gemini: "AIza...  (from aistudio.google.com)",
  nvidia: "nvapi-...  (from build.nvidia.com)",
  openrouter: "sk-or-v1-...  (from openrouter.ai)",
  groq: "gsk_...  (from console.groq.com)",
  mistral: "...  (from console.mistral.ai)",
  deepseek: "sk-...  (from platform.deepseek.com)",
};

// ---------- API helper ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- Auth screen ----------
function setAuthTab(mode) {
  authMode = mode;
  document.getElementById("tabLogin").classList.toggle("active", mode === "login");
  document.getElementById("tabSignup").classList.toggle("active", mode === "signup");
  document.getElementById("authSubmitBtn").textContent = mode === "login" ? "Log in" : "Create account";
  document.getElementById("authError").textContent = "";
}

async function submitAuth() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const errEl = document.getElementById("authError");
  const btn = document.getElementById("authSubmitBtn");
  errEl.textContent = "";
  if (!email || !password) {
    errEl.textContent = "Enter an email and password.";
    return;
  }
  btn.disabled = true;
  try {
    const data = await api(`/auth/${authMode === "login" ? "login" : "signup"}`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem("lumen_token", token);
    localStorage.setItem("lumen_user", JSON.stringify(data.user));
    await bootApp();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem("lumen_token");
  localStorage.removeItem("lumen_user");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("authScreen").classList.remove("hidden");
}

// ---------- Boot ----------
async function bootApp() {
  document.getElementById("authScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");

  if (currentUser) {
    document.getElementById("userEmail").textContent = currentUser.email;
    document.getElementById("userAvatar").textContent = currentUser.email[0].toUpperCase();
  }

  await refreshConnectionStatus();
  await refreshConversations();

  if (conversations.length > 0) {
    selectConversation(conversations[0].id);
  } else {
    renderMessages([]);
  }
}

async function refreshConnectionStatus() {
  try {
    const data = await api("/connections");
    const hasTableau = data.tableau.length > 0;
    const hasLlm = data.llm.length > 0;

    document.getElementById("tableauDot").classList.toggle("on", hasTableau);
    const tableauRow = document.getElementById("tableauDot").closest(".status-row");
    const tableauTitle = document.getElementById("tableauTitle");
    const tableauSub = document.getElementById("tableauSub");
    if (hasTableau) {
      const hostname = new URL(data.tableau[0].siteUrl).hostname;
      tableauTitle.textContent = "Tableau connected";
      tableauSub.textContent = hostname;
      tableauSub.classList.remove("hidden");
      tableauRow.title = hostname;
      currentTableauConnectionId = data.tableau[0].id;
    } else {
      tableauTitle.textContent = "Connect Tableau";
      tableauSub.classList.add("hidden");
      tableauRow.title = "";
      currentTableauConnectionId = null;
    }
    document.getElementById("tableauDisconnectBtn").classList.toggle("hidden", !hasTableau);

    document.getElementById("llmDot").classList.toggle("on", hasLlm);
    const llmRow = document.getElementById("llmDot").closest(".status-row");
    const llmTitle = document.getElementById("llmTitle");
    const llmSub = document.getElementById("llmSub");
    if (hasLlm) {
      const providerName = data.llm[0].provider[0].toUpperCase() + data.llm[0].provider.slice(1);
      llmTitle.textContent = providerName;
      llmSub.textContent = data.llm[0].model;
      llmSub.classList.remove("hidden");
      llmRow.title = `${providerName} · ${data.llm[0].model}`;
      currentLlmConnectionId = data.llm[0].id;
    } else {
      llmTitle.textContent = "Connect LLM";
      llmSub.classList.add("hidden");
      llmRow.title = "";
      currentLlmConnectionId = null;
    }
    document.getElementById("llmDisconnectBtn").classList.toggle("hidden", !hasLlm);

    const badge = document.getElementById("modelBadge");
    if (hasLlm) {
      badge.innerHTML = `<span class="dot"></span><span>${data.llm[0].model}</span>`;
    } else {
      badge.innerHTML = `<span class="dot"></span><span>Not connected</span>`;
    }

    updateComposerState();
  } catch {
    // non-fatal — sidebar just shows disconnected state
  }
}

function updateComposerState() {
  const dotsOn =
    document.getElementById("tableauDot").classList.contains("on") &&
    document.getElementById("llmDot").classList.contains("on");
  document.getElementById("sendBtn").disabled = sending || !dotsOn || !document.getElementById("chatInput").value.trim();
}

// ---------- Conversations ----------
async function refreshConversations() {
  conversations = await api("/conversations");
  renderConversationList();
}

function renderConversationList() {
  const list = document.getElementById("conversationList");
  list.innerHTML = "";
  for (const c of conversations) {
    const el = document.createElement("div");
    el.className = "conv-item" + (c.id === activeConversationId ? " active" : "");
    el.title = c.title || "New chat"; // native tooltip for a truncated title

    const icon = document.createElement("span");
    icon.className = "conv-item-icon";
    icon.textContent = "💬";

    const label = document.createElement("span");
    label.className = "conv-item-label";
    label.textContent = c.title || "New chat";

    el.appendChild(icon);
    el.appendChild(label);
    el.onclick = () => selectConversation(c.id);
    list.appendChild(el);
  }
}

async function newConversation() {
  const conv = await api("/conversations", { method: "POST", body: JSON.stringify({ title: "New chat" }) });
  conversations.unshift(conv);
  renderConversationList();
  selectConversation(conv.id);
}

async function selectConversation(id) {
  activeConversationId = id;
  renderConversationList();
  const conv = await api(`/conversations/${id}`);
  document.getElementById("convTitle").textContent = conv.title || "New chat";
  renderMessages(conv.messages || []);
  await applyConversationScopeUI(conv);
}

// ---------- Drill-down scope (Project -> Workbook -> View) ----------
let scopeProjectsCache = null;

// linkFn is optional — when given, each option's Tableau URL is stashed in
// its dataset so the scope-change handlers can send it along with the
// PATCH /scope call (used by the "link-first" system prompt behavior).
function populateSelect(selectEl, items, valueFn, labelFn, placeholder, linkFn) {
  selectEl.innerHTML = `<option value="">${placeholder}</option>`;
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = valueFn(item);
    opt.textContent = labelFn(item);
    if (linkFn) opt.dataset.link = linkFn(item) || "";
    selectEl.appendChild(opt);
  }
}

async function loadScopeProjectsOnce() {
  const hasTableau = document.getElementById("tableauDot").classList.contains("on");
  const projectSelect = document.getElementById("scopeProject");
  if (!hasTableau) {
    projectSelect.disabled = true;
    return;
  }
  projectSelect.disabled = false;
  if (scopeProjectsCache) return;
  try {
    const data = await api("/tableau/projects");
    scopeProjectsCache = data.projects || [];
    populateSelect(projectSelect, scopeProjectsCache, (p) => p.id, (p) => p.name, "All projects");
  } catch {
    // Scope bar is a convenience — leave it at "All projects" if this fails.
  }
}

/** Reflects a conversation's stored scope into the three <select> elements, fetching child options as needed. */
async function applyConversationScopeUI(conv) {
  await loadScopeProjectsOnce();

  const projectSelect = document.getElementById("scopeProject");
  const workbookSelect = document.getElementById("scopeWorkbook");
  const viewSelect = document.getElementById("scopeView");

  projectSelect.value = conv.scopeProjectId || "";

  if (conv.scopeProjectId) {
    workbookSelect.disabled = false;
    try {
      const data = await api(`/tableau/workbooks?projectName=${encodeURIComponent(conv.scopeProjectName || "")}`);
      populateSelect(workbookSelect, data.workbooks || [], (w) => w.id, (w) => w.name, "All workbooks", (w) => w.link);
    } catch {
      populateSelect(workbookSelect, [], () => "", () => "", "All workbooks");
    }
    workbookSelect.value = conv.scopeWorkbookId || "";
  } else {
    workbookSelect.disabled = true;
    populateSelect(workbookSelect, [], () => "", () => "", "All workbooks");
  }

  if (conv.scopeWorkbookId) {
    viewSelect.disabled = false;
    try {
      const data = await api(`/tableau/views?workbookId=${encodeURIComponent(conv.scopeWorkbookId)}`);
      populateSelect(viewSelect, data.views || [], (v) => v.id, (v) => v.name, "All dashboards", (v) => v.link);
    } catch {
      populateSelect(viewSelect, [], () => "", () => "", "All dashboards");
    }
    viewSelect.value = conv.scopeViewId || "";
  } else {
    viewSelect.disabled = true;
    populateSelect(viewSelect, [], () => "", () => "", "All dashboards");
  }

  document.getElementById("scopeClearBtn").classList.toggle("hidden", !conv.scopeProjectId);
}

async function patchScope(body) {
  if (!activeConversationId) return;
  const conv = await api(`/conversations/${activeConversationId}/scope`, { method: "PATCH", body: JSON.stringify(body) });
  document.getElementById("scopeClearBtn").classList.toggle("hidden", !conv.scopeProjectId);
  return conv;
}

async function onScopeProjectChange() {
  const projectSelect = document.getElementById("scopeProject");
  const projectId = projectSelect.value;
  const projectName = projectId ? projectSelect.options[projectSelect.selectedIndex].textContent : "";

  if (!projectId) {
    await clearScope();
    return;
  }

  await patchScope({ projectId, projectName });

  const workbookSelect = document.getElementById("scopeWorkbook");
  const viewSelect = document.getElementById("scopeView");
  workbookSelect.disabled = false;
  viewSelect.disabled = true;
  populateSelect(viewSelect, [], () => "", () => "", "All dashboards");
  try {
    const data = await api(`/tableau/workbooks?projectName=${encodeURIComponent(projectName)}`);
    populateSelect(workbookSelect, data.workbooks || [], (w) => w.id, (w) => w.name, "All workbooks", (w) => w.link);
  } catch {
    populateSelect(workbookSelect, [], () => "", () => "", "All workbooks");
  }
}

async function onScopeWorkbookChange() {
  const projectSelect = document.getElementById("scopeProject");
  const workbookSelect = document.getElementById("scopeWorkbook");
  const workbookId = workbookSelect.value;
  const selectedWorkbookOpt = workbookSelect.options[workbookSelect.selectedIndex];
  const workbookName = workbookId ? selectedWorkbookOpt.textContent : "";
  const workbookLink = workbookId ? selectedWorkbookOpt.dataset.link : null;
  const projectId = projectSelect.value;
  const projectName = projectId ? projectSelect.options[projectSelect.selectedIndex].textContent : "";

  await patchScope({
    projectId,
    projectName,
    workbookId: workbookId || null,
    workbookName: workbookId ? workbookName : null,
    workbookLink: workbookId ? workbookLink : null,
  });

  const viewSelect = document.getElementById("scopeView");
  if (!workbookId) {
    viewSelect.disabled = true;
    populateSelect(viewSelect, [], () => "", () => "", "All dashboards");
    return;
  }
  viewSelect.disabled = false;
  try {
    const data = await api(`/tableau/views?workbookId=${encodeURIComponent(workbookId)}`);
    populateSelect(viewSelect, data.views || [], (v) => v.id, (v) => v.name, "All dashboards", (v) => v.link);
  } catch {
    populateSelect(viewSelect, [], () => "", () => "", "All dashboards");
  }
}

async function onScopeViewChange() {
  const projectSelect = document.getElementById("scopeProject");
  const workbookSelect = document.getElementById("scopeWorkbook");
  const viewSelect = document.getElementById("scopeView");
  const viewId = viewSelect.value;
  const selectedViewOpt = viewSelect.options[viewSelect.selectedIndex];
  const viewName = viewId ? selectedViewOpt.textContent : "";
  const viewLink = viewId ? selectedViewOpt.dataset.link : null;
  const selectedWorkbookOpt = workbookSelect.options[workbookSelect.selectedIndex];

  await patchScope({
    projectId: projectSelect.value,
    projectName: projectSelect.options[projectSelect.selectedIndex].textContent,
    workbookId: workbookSelect.value,
    workbookName: selectedWorkbookOpt.textContent,
    workbookLink: selectedWorkbookOpt.dataset.link || null,
    viewId: viewId || null,
    viewName: viewId ? viewName : null,
    viewLink: viewId ? viewLink : null,
  });
}

async function clearScope() {
  await patchScope({ projectId: null });
  document.getElementById("scopeProject").value = "";
  const workbookSelect = document.getElementById("scopeWorkbook");
  const viewSelect = document.getElementById("scopeView");
  workbookSelect.disabled = true;
  viewSelect.disabled = true;
  populateSelect(workbookSelect, [], () => "", () => "", "All workbooks");
  populateSelect(viewSelect, [], () => "", () => "", "All dashboards");
  document.getElementById("scopeClearBtn").classList.add("hidden");
}

// ---------- Message rendering ----------
function renderMessages(messages) {
  const inner = document.getElementById("chatInner");
  inner.innerHTML = "";
  if (messages.length === 0) {
    inner.appendChild(buildEmptyState());
    return;
  }
  messages.forEach((m, i) => {
    inner.appendChild(buildMessageEl(m, { disableMenu: i !== messages.length - 1 }));
  });
  scrollToBottom();
}

function buildEmptyState() {
  const div = document.createElement("div");
  div.className = "empty-state";
  div.innerHTML = `
    <div class="empty-mark"></div>
    <h2>Ask anything about your Tableau data</h2>
    <p>Lumen turns natural-language questions into live Tableau queries — using your own site and your own model, end to end.</p>
    <div class="suggestion-row">
      <button class="suggestion-chip" onclick="fillAndSend('What datasources do I have access to?')">What datasources do I have?</button>
      <button class="suggestion-chip" onclick="fillAndSend('Show me the fields in my top datasource')">Explore a datasource's fields</button>
      <button class="suggestion-chip" onclick="fillAndSend('What were total sales by region last quarter?')">Ask an analytical question</button>
    </div>`;
  return div;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Minimal, dependency-free markdown -> HTML for assistant replies. Covers
 * what LLMs actually produce for these summaries: headings, bold/italic,
 * inline code, fenced code blocks, links, unordered/ordered lists, block
 * quotes, pipe tables, and horizontal rules. Input is escaped before any HTML
 * is built, so this is safe against a model emitting literal "<script>" etc.
 */
function renderMarkdown(raw) {
  // 1. Pull fenced code blocks out into single-line placeholder tokens so
  //    later escaping/line-splitting can't see their internal newlines.
  const codeBlocks = [];
  let text = raw.replace(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code.replace(/\n$/, ""));
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  // Pipe-table parser. Groups consecutive "| a | b |" rows, treats the first
  // row (after an optional "|---|---|" separator) as the header, and emits a
  // real <table> so tabular tool results render as tables instead of raw pipes.
  const parseTable = (lines) => {
    const rows = lines.map((l) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim())
    );
    const sepIdx = rows.findIndex(
      (r) => r.length >= 1 && r.every((c) => /^:?-+:?$/.test(c))
    );
    return {
      header: rows[0] || [],
      body: sepIdx >= 0 ? rows.slice(sepIdx + 1) : rows.slice(1),
    };
  };

  function renderInline(s) {
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // Models don't always use [text](url) markdown syntax — e.g. a Tableau
    // link handed back plainly in prose. Auto-linkify any remaining bare
    // URL so it's still clickable. The negative lookbehind skips URLs
    // already inside an href="..." from the pass above (otherwise this
    // would double-wrap them and produce nested/invalid <a> tags).
    s = s.replace(/(?<!href=")(https?:\/\/[^\s<>"']+)/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
    return s;
  }

  const lines = text.split("\n");
  const out = [];
  let listType = null; // "ul" | "ol" | null
  let listItems = [];
  let para = [];
  let tableLines = [];

  const flushTable = () => {
    if (tableLines.length < 2) return;
    const { header, body } = parseTable(tableLines);
    if (!body.length) return;
    const thead = `<thead><tr>${header.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${body
      .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
      .join("")}</tbody>`;
    out.push(`<table>${thead}${tbody}</table>`);
    tableLines = [];
  };

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${renderInline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listItems.length) {
      out.push(`<${listType}>${listItems.map((li) => `<li>${renderInline(li)}</li>`).join("")}</${listType}>`);
      listItems = [];
      listType = null;
    }
  };

  for (const line of lines) {
    const placeholder = line.match(/^ CODEBLOCK(\d+) $/);
    if (placeholder) {
      flushTable();
      flushPara();
      flushList();
      out.push(placeholder[0]); // restored to <pre> after the loop
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushTable();
      flushPara();
      flushList();
      out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (line.match(/^\s*\|.*\|\s*$/)) {
      flushPara();
      flushList();
      tableLines.push(line);
      continue;
    }
    if (tableLines.length) flushTable();
    if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
      flushPara();
      flushList();
      out.push("<hr/>");
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (listType && listType !== kind) flushList();
      listType = kind;
      listItems.push((ul || ol)[1]);
      continue;
    }
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    para.push(line);
  }
  flushTable();
  flushPara();
  flushList();

  return out
    .join("\n")
    .replace(/ CODEBLOCK(\d+) /g, (_, i) => `<pre><code>${escapeHtml(codeBlocks[Number(i)])}</code></pre>`);
}

// ---------- Charting (Chart.js, loaded via CDN — see index.html) ----------
// Renders a bar/line chart straight from a tool call's own result data
// (get_view_data's CSV, query_datasource's rows) — this works with every
// connected model, unlike get_view_image, which needs vision support the
// model's own deployment may not have enabled.

const CHART_COLORS = ["#7c6cf6", "#6ee7d8", "#f4685f", "#f6c343", "#4fb0f6", "#a06cf6"];

/** Very small CSV parser — good enough for Tableau's export format (handles simple quoted fields). */
function parseCsvPreview(csv) {
  const lines = csv.split("\n").filter((l) => l.length > 0);
  if (lines.length < 2) return null;

  const parseLine = (line) => {
    const cells = [];
    let cur = "";
    let inQuotes = false;
    for (const c of line) {
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === "," && !inQuotes) {
        cells.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    cells.push(cur);
    return cells;
  };

  return { header: parseLine(lines[0]), rows: lines.slice(1).map(parseLine) };
}

/** query_datasource returns rows as objects (OBJECTS returnFormat) — normalize to header+rows shape. */
function rowsFromObjects(objRows) {
  if (!Array.isArray(objRows) || objRows.length === 0) return null;
  const header = Object.keys(objRows[0]);
  return { header, rows: objRows.map((r) => header.map((h) => r[h])) };
}

/** Extracts {header, rows} from a tool call if its result is chartable, else null. */
function getChartableRows(call) {
  const result = call.result;
  if (!result) return null;
  if (call.name === "query_datasource" && Array.isArray(result.rows)) {
    return rowsFromObjects(result.rows);
  }
  if (call.name === "get_view_data" && typeof result.csvPreview === "string") {
    return parseCsvPreview(result.csvPreview);
  }
  return null;
}

const DATE_LIKE = /^\d{4}(-\d{2}){0,2}$|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const MAX_CHART_ROWS = 60;

/**
 * Tableau CSV/query exports commonly format numbers as "$1,234.56", "12%",
 * or "(1,234.56)" for negatives (accounting format) — none of which
 * JS's Number() parses. Strip that formatting before testing/parsing so
 * real numeric columns (e.g. currency-formatted Sales) aren't mistaken for
 * text and left out of the chart entirely.
 */
function parseNumericLike(v) {
  if (v === "" || v == null) return null;
  let s = String(v).trim();
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$€£¥,%\s]/g, "");
  if (s === "" || isNaN(Number(s))) return null;
  const n = Number(s);
  return negative ? -n : n;
}

/** Builds a Chart.js config from {header, rows} — first non-numeric column as labels, numeric columns as series. */
function buildChartConfig(source) {
  const { header, rows } = source;
  if (!header?.length || !rows?.length) return null;

  const isNumeric = (v) => parseNumericLike(v) !== null;
  const numericCols = header.map((_, c) => c).filter((c) => rows.every((r) => isNumeric(r[c])));
  if (numericCols.length === 0) return null;

  let labelCol = header.findIndex((_, c) => !numericCols.includes(c));
  if (labelCol === -1) labelCol = 0; // every column numeric — fall back to first as the label axis

  const limited = rows.slice(0, MAX_CHART_ROWS);
  const labels = limited.map((r) => r[labelCol]);
  const seriesCols = numericCols.filter((c) => c !== labelCol);
  if (seriesCols.length === 0) return null;

  const datasets = seriesCols.map((c, i) => ({
    label: header[c],
    data: limited.map((r) => parseNumericLike(r[c])),
    backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
    borderColor: CHART_COLORS[i % CHART_COLORS.length],
    tension: 0.3,
  }));

  const type = DATE_LIKE.test(String(labels[0] ?? "")) ? "line" : "bar";

  return {
    type,
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#9a9ba5" } } },
      scales: {
        x: { ticks: { color: "#9a9ba5" }, grid: { color: "#23252e" } },
        y: { ticks: { color: "#9a9ba5" }, grid: { color: "#23252e" } },
      },
    },
  };
}

// ---------- Semantic-layer result rendering ----------
// The semantic tools (glossary, dashboard insights, metric definition, field
// usage, visualization recommendation) return structured data that reads far
// better as a small table/card than as a raw JSON chip. Each helper builds a
// DOM node, or returns null when the result isn't the shape that tool returns.

function semanticGlossaryView(result) {
  if (!result || !Array.isArray(result.fields)) return null;
  const panel = document.createElement("div");
  panel.className = "semantic-panel";
  panel.innerHTML = `<div class="semantic-panel-title">Field glossary — ${escapeHtml(result.name ?? "datasource")} (${result.fieldCount ?? result.fields.length} fields)</div>`;
  const table = document.createElement("table");
  table.className = "semantic-table";
  table.innerHTML = "<thead><tr><th>Field</th><th>Kind</th><th>Type</th><th>Description</th><th>Formula</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const f of result.fields) {
    const tr = document.createElement("tr");
    const cells = [
      f.name,
      f.kind,
      f.dataType,
      f.description || "",
      f.formula || "",
    ].map((c) => `<td>${escapeHtml(c == null ? "" : c)}</td>`).join("");
    tr.innerHTML = cells;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  panel.appendChild(table);
  return panel;
}

function semanticInsightsView(result) {
  if (!result || !Array.isArray(result.columns)) return null;
  const panel = document.createElement("div");
  panel.className = "semantic-panel";
  panel.innerHTML = `<div class="semantic-panel-title">Dashboard insights — ${result.rowCount ?? 0} rows${result.truncated ? " (first rows only)" : ""}</div>`;
  const table = document.createElement("table");
  table.className = "semantic-table";
  table.innerHTML = "<thead><tr><th>Column</th><th>Type</th><th>Non-empty</th><th>Distinct</th><th>Min</th><th>Max</th><th>Avg</th><th>Sum</th><th>Top values</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const col of result.columns) {
    const topValues = Array.isArray(col.topValues)
      ? col.topValues.map((t) => `${escapeHtml(t.value)} (${t.count})`).join(", ")
      : "";
    const tr = document.createElement("tr");
    const cells = [
      col.name,
      col.type,
      col.nonEmpty,
      col.distinct,
      col.min,
      col.max,
      col.avg,
      col.sum,
      topValues,
    ].map((c) => `<td>${escapeHtml(c == null ? "" : c)}</td>`).join("");
    tr.innerHTML = cells;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  panel.appendChild(table);
  return panel;
}

function semanticMetricDefinitionView(result) {
  if (!result || typeof result !== "object") return null;
  const panel = document.createElement("div");
  panel.className = "semantic-panel";
  const rows = [
    ["Metric", result.name],
    ["Formula", result.formula],
    ["Aggregation", result.aggregationMapped],
    ["Measure field", result.measureField],
    ["Time dimension", result.timeDimensionField ? `${result.timeDimensionField} (${result.granularity ?? ""})` : ""],
    ["Datasource LUID", result.datasourceLuid],
  ];
  panel.innerHTML =
    `<div class="semantic-panel-title">Metric definition — ${escapeHtml(result.name ?? "")}</div>` +
    `<div class="semantic-def-rows">` +
    rows
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `<div class="semantic-def-row"><span class="semantic-def-key">${escapeHtml(k)}</span><span class="semantic-def-val">${escapeHtml(v)}</span></div>`)
      .join("") +
    `</div>`;
  return panel;
}

function semanticFieldUsageView(result) {
  if (!result || !Array.isArray(result.fields)) return null;
  const panel = document.createElement("div");
  panel.className = "semantic-panel";
  panel.innerHTML = `<div class="semantic-panel-title">Field usage — ${escapeHtml(result.datasourceName ?? "datasource")} (${result.fieldCount ?? result.fields.length} fields)</div>`;
  const list = document.createElement("div");
  list.className = "semantic-usage-list";
  for (const f of result.fields) {
    const item = document.createElement("div");
    item.className = "semantic-usage-item";
    const usages = (f.usedIn || [])
      .map((u) => escapeHtml(u.workbookName ? `${u.sheetName} (${u.workbookName})` : u.sheetName))
      .join(", ");
    item.innerHTML = `<span class="semantic-usage-field">${escapeHtml(f.name)}</span> <span class="semantic-usage-count">${f.usedInSheetCount ?? 0}</span>${usages ? `<div class="semantic-usage-sheets">${usages}</div>` : ""}`;
    list.appendChild(item);
  }
  panel.appendChild(list);
  return panel;
}

function semanticVizRecView(result) {
  if (!result || typeof result !== "object") return null;
  const panel = document.createElement("div");
  panel.className = "semantic-panel";
  const avoid = Array.isArray(result.chartsToAvoid) && result.chartsToAvoid.length
    ? `<div class="semantic-def-row"><span class="semantic-def-key">Avoid</span><span class="semantic-def-val">${escapeHtml(result.chartsToAvoid.join(", "))}</span></div>`
    : "";
  panel.innerHTML = `
    <div class="semantic-panel-title">Visualization recommendation${result.intent ? ` — ${escapeHtml(result.intent)}` : ""}</div>
    <div class="semantic-viz-chart">${escapeHtml(result.recommendedChart)}</div>
    <div class="semantic-viz-reason">${escapeHtml(result.reasoning ?? "")}</div>
    <div class="semantic-def-rows">
      <div class="semantic-def-row"><span class="semantic-def-key">Suggested aggregation</span><span class="semantic-def-val">${escapeHtml(result.suggestedAggregation ?? "")}</span></div>
      ${avoid}
    </div>`;
  return panel;
}

/** Returns a DOM node rendering a semantic tool's result, or null if the call isn't one of those tools / lacks a result. */
function getSemanticResultView(call) {
  const result = call?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  switch (call.name) {
    case "get_datasource_glossary": return semanticGlossaryView(result);
    case "get_dashboard_insights": return semanticInsightsView(result);
    case "get_metric_definition": return semanticMetricDefinitionView(result);
    case "get_field_usage": return semanticFieldUsageView(result);
    case "recommend_visualization": return semanticVizRecView(result);
    default: return null;
  }
}

function buildMessageEl(m, { toolCalls, disableMenu } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${m.role}`;
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = m.role === "user" ? (currentUser?.email[0].toUpperCase() || "U") : "L";
  wrap.appendChild(avatar);

  const body = document.createElement("div");
  body.className = "msg-body";

  const roleEl = document.createElement("div");
  roleEl.className = "msg-role";
  roleEl.textContent = m.role === "user" ? "You" : "Lumen";
  body.appendChild(roleEl);

  const calls = toolCalls || (m.toolCalls ? JSON.parse(m.toolCalls) : null);

  // The dashboard overview A/B/C choice (see buildOverviewMenuOptions in
  // chat.ts) renders as real clickable buttons instead of the user having to
  // type a reply. disableMenu is set by the caller for every message except
  // the most recent one, so a menu from earlier in the conversation (e.g.
  // after a page reload, already superseded by a later reply) renders inert
  // instead of letting a stale choice be clicked again mid-conversation.
  if (calls?.length === 1 && calls[0].type === "menu") {
    const questionLine = m.content.split("\n")[0];
    const contentEl = document.createElement("div");
    contentEl.className = "msg-content";
    contentEl.textContent = questionLine;
    body.appendChild(contentEl);

    const menuRow = document.createElement("div");
    menuRow.className = "overview-menu-row";
    for (const opt of calls[0].options) {
      const btn = document.createElement("button");
      btn.className = "overview-menu-btn";
      btn.textContent = opt.label;
      btn.disabled = Boolean(disableMenu);
      btn.onclick = () => {
        menuRow.querySelectorAll("button").forEach((b) => (b.disabled = true));
        btn.classList.add("chosen");
        fillAndSend(opt.value);
      };
      menuRow.appendChild(btn);
    }
    body.appendChild(menuRow);
    wrap.appendChild(body);
    return wrap;
  }

  if (calls?.length) {
    const row = document.createElement("div");
    row.className = "tool-chip-row";
    for (const call of calls) {
      const chip = document.createElement("div");
      chip.className = "tool-chip";
      chip.innerHTML = `<span class="tool-icon">⌁</span><span class="tool-name">${escapeHtml(call.name)}</span><span class="tool-args">${escapeHtml(JSON.stringify(call.input))}</span>`;

      if (call.pdf) {
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "chart-toggle-btn";
        toggleBtn.textContent = "📄 PDF";
        chip.appendChild(toggleBtn);

        const pdfWrap = document.createElement("div");
        pdfWrap.className = "chart-canvas-wrap hidden";

        // PDFs can't go through <img> or the chart pipeline, and data: URIs
        // are unreliable for <iframe>/download across browsers — decode to a
        // Blob and use an object URL instead so both the embed and the
        // download link resolve on every browser.
        let pdfUrl = "";
        if (call.pdf.base64) {
          try {
            const bin = atob(call.pdf.base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: call.pdf.mediaType || "application/pdf" });
            pdfUrl = URL.createObjectURL(blob);
          } catch (err) {
            pdfUrl = "";
          }
        }

        if (pdfUrl) {
          const frame = document.createElement("iframe");
          frame.className = "tool-result-pdf";
          frame.title = `${call.name} result`;
          frame.src = pdfUrl;

          const link = document.createElement("a");
          link.className = "tool-result-pdf-link";
          link.href = pdfUrl;
          link.download = `${call.name}.pdf`;
          link.textContent = "⬇ Download PDF";

          pdfWrap.appendChild(frame);
          pdfWrap.appendChild(link);
        } else {
          const msg = document.createElement("div");
          msg.className = "chart-empty";
          msg.textContent = call.pdf.base64
            ? "PDF could not be decoded in the browser — the returned bytes may be corrupted."
            : "Tableau returned an empty PDF for this view — no document was delivered to download.";
          pdfWrap.appendChild(msg);
        }

        toggleBtn.onclick = () => pdfWrap.classList.toggle("hidden");

        row.appendChild(chip);
        row.appendChild(pdfWrap);
        continue;
      }

      if (call.image?.base64) {
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "chart-toggle-btn";
        toggleBtn.textContent = "🖼️ Image";
        chip.appendChild(toggleBtn);

        const imgWrap = document.createElement("div");
        imgWrap.className = "chart-canvas-wrap hidden";

        // Built via DOM APIs (not innerHTML/template-literal string building)
        // so a multi-hundred-KB base64 payload can't run into any string-
        // interpolation edge case, and so a genuine load failure is visible
        // instead of silently rendering nothing.
        const img = document.createElement("img");
        img.className = "tool-result-image";
        img.alt = `${call.name} result`;
        img.src = `data:${call.image.mediaType || "image/png"};base64,${call.image.base64}`;
        img.onclick = () => openImageLightbox(img.src);
        img.onerror = () => {
          const kb = Math.round(call.image.base64.length / 1024);
          imgWrap.innerHTML = "";
          const msg = document.createElement("div");
          msg.className = "chart-empty";
          msg.textContent = `Image failed to load in the browser (received ${kb}KB of ${call.image.mediaType || "image/png"} data, but the browser couldn't render it — it may be corrupted or an unsupported format).`;
          imgWrap.appendChild(msg);
        };
        imgWrap.appendChild(img);

        toggleBtn.onclick = () => imgWrap.classList.toggle("hidden");

        row.appendChild(chip);
        row.appendChild(imgWrap);
        continue;
      }

      const chartSource = getChartableRows(call);
      if (chartSource) {
        const chartId = `chart_${++chartIdCounter}`;
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "chart-toggle-btn";
        toggleBtn.textContent = "📊 Chart";
        chip.appendChild(toggleBtn);

        const canvasWrap = document.createElement("div");
        canvasWrap.className = "chart-canvas-wrap hidden";
        canvasWrap.innerHTML = `<canvas id="${chartId}"></canvas>`;

        toggleBtn.onclick = () => {
          const isHidden = canvasWrap.classList.contains("hidden");
          if (isHidden) {
            canvasWrap.classList.remove("hidden");
            if (!activeCharts.has(chartId)) {
              const config = buildChartConfig(chartSource);
              if (config) {
                activeCharts.set(chartId, new Chart(document.getElementById(chartId), config));
              } else {
                canvasWrap.innerHTML = `<div class="chart-empty">Couldn't find chartable numeric columns in this result.</div>`;
              }
            }
          } else {
            canvasWrap.classList.add("hidden");
          }
        };

        row.appendChild(chip);
        row.appendChild(canvasWrap);
        continue;
      }

      // Semantic-layer tools return structured data (glossary/insights/
      // metric-definition/field-usage/viz-recommendation) that renders far
      // better as a small collapsible table/card than as a raw JSON chip —
      // same toggle pattern as the chart/image results above.
      const semanticView = getSemanticResultView(call);
      if (semanticView) {
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "chart-toggle-btn";
        toggleBtn.textContent = "📋 Details";
        chip.appendChild(toggleBtn);

        const panelWrap = document.createElement("div");
        panelWrap.className = "chart-canvas-wrap hidden";
        panelWrap.appendChild(semanticView);

        toggleBtn.onclick = () => panelWrap.classList.toggle("hidden");

        row.appendChild(chip);
        row.appendChild(panelWrap);
        continue;
      }

      row.appendChild(chip);
    }
    body.appendChild(row);
  }

  const contentEl = document.createElement("div");
  contentEl.className = "msg-content";
  if (m.role === "assistant") {
    contentEl.innerHTML = renderMarkdown(m.content);
  } else {
    contentEl.textContent = m.content;
  }
  body.appendChild(contentEl);

  wrap.appendChild(body);
  return wrap;
}

const THINKING_LABELS = [
  "Lumen is thinking…",
  "Checking your Tableau site…",
  "Querying your data…",
  "Crafting your answer…",
];

function buildTypingEl() {
  if (typingCycleTimer) {
    clearInterval(typingCycleTimer);
    typingCycleTimer = null;
  }
  typingToolLabel = null;

  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  wrap.id = "typingIndicator";
  wrap.innerHTML = `
    <div class="msg-avatar thinking">L</div>
    <div class="msg-body">
      <div class="msg-role">Lumen</div>
      <div class="thinking-label">Lumen is thinking…</div>
      <div class="status-feed" id="statusFeed"></div>
      <div class="thinking-skeleton"><span></span><span></span><span></span></div>
    </div>`;

  // Generic cycling text gives the bubble life while the model works; as soon
  // as a real tool event arrives (Tier 2 stream) the label shows the actual
  // activity and cycling pauses until that tool completes.
  let idx = 0;
  typingCycleTimer = setInterval(() => {
    if (typingToolLabel) return;
    idx = (idx + 1) % THINKING_LABELS.length;
    const label = wrap.querySelector(".thinking-label");
    if (label) label.textContent = THINKING_LABELS[idx];
  }, 2800);
  return wrap;
}

function removeTypingIndicator() {
  if (typingCycleTimer) {
    clearInterval(typingCycleTimer);
    typingCycleTimer = null;
  }
  typingToolLabel = null;
  document.getElementById("typingIndicator")?.remove();
}

function setTypingLabel(text) {
  const el = document.getElementById("typingIndicator")?.querySelector(".thinking-label");
  if (el) el.textContent = text;
}

function addStatusChip(name, label, done) {
  const feed = document.getElementById("statusFeed");
  if (!feed) return;
  let chip = feed.querySelector(`[data-tool="${CSS.escape(name)}"]`);
  if (!chip) {
    chip = document.createElement("div");
    chip.className = "status-chip";
    chip.dataset.tool = name;
    chip.innerHTML = `<span class="status-chip-spinner"></span><span class="status-chip-label">${escapeHtml(label || name)}</span>`;
    feed.appendChild(chip);
  }
  if (done) chip.classList.add("done");
  scrollToBottom();
}

function scrollToBottom() {
  const scroller = document.getElementById("chatScroll");
  scroller.scrollTop = scroller.scrollHeight;
}

// ---------- Composer ----------
function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
  updateComposerState();
}

function handleComposerKey(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function fillAndSend(text) {
  document.getElementById("chatInput").value = text;
  updateComposerState();
  sendMessage();
}

function setSendingState(on) {
  document.getElementById("composer").classList.toggle("sending", on);
  document.getElementById("stopBtn").classList.toggle("hidden", !on);
  updateComposerState();
}

function stopGenerating() {
  currentAbortController?.abort();
}

function handleChatResult(data) {
  const inner = document.getElementById("chatInner");
  removeTypingIndicator();
  inner.appendChild(buildMessageEl({ role: "assistant", content: data.reply }, { toolCalls: data.toolCalls }));

  // The server auto-titles a conversation from its first message (see
  // deriveConversationTitle in chat.ts) and returns the new title here —
  // apply it in place rather than a full refetch of the whole list.
  if (data.title) {
    const conv = conversations.find((c) => c.id === activeConversationId);
    if (conv) conv.title = data.title;
    document.getElementById("convTitle").textContent = data.title;
    renderConversationList();
  }
}

// Returns false when the caller should stop parsing the stream (a terminal
// event arrived), true otherwise.
function handleChatEvent(event) {
  if (event.type === "progress") {
    setTypingLabel(event.label);
    return true;
  }
  if (event.type === "tool") {
    if (event.done) {
      addStatusChip(event.name, event.label, true);
      typingToolLabel = null; // resume generic label cycling
    } else {
      addStatusChip(event.name, event.label, false);
      typingToolLabel = event.label;
      setTypingLabel(event.label);
    }
    return true;
  }
  if (event.type === "result") {
    handleChatResult(event);
    return false;
  }
  if (event.type === "error") {
    const inner = document.getElementById("chatInner");
    removeTypingIndicator();
    inner.appendChild(buildMessageEl({ role: "assistant", content: `Error: ${event.message}` }));
    return false;
  }
  return true;
}

async function sendMessage() {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();
  if (!message || sending) return;

  if (!activeConversationId) {
    const conv = await api("/conversations", { method: "POST", body: JSON.stringify({ title: message.slice(0, 40) }) });
    conversations.unshift(conv);
    activeConversationId = conv.id;
    renderConversationList();
    document.getElementById("convTitle").textContent = conv.title;
  }

  const inner = document.getElementById("chatInner");
  if (inner.querySelector(".empty-state")) inner.innerHTML = "";

  inner.appendChild(buildMessageEl({ role: "user", content: message }));
  input.value = "";
  autoGrow(input);
  scrollToBottom();

  sending = true;
  inner.appendChild(buildTypingEl());
  setSendingState(true);
  scrollToBottom();

  const controller = new AbortController();
  currentAbortController = controller;

  try {
    const res = await fetch(`/chat/${activeConversationId}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });

    const isNdjson = (res.headers.get("content-type") || "").includes("ndjson");

    // Plain JSON — the overview A/B/C menu path (and any error before the
    // streaming handler starts). Handle it exactly like the old response.
    if (!isNdjson) {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      handleChatResult(data);
      return;
    }

    if (!res.body) throw new Error("Streaming isn't supported by this browser");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let gotTerminal = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!handleChatEvent(event)) {
          gotTerminal = true;
          break;
        }
      }
      if (gotTerminal) break;
    }

    // Stream ended without a result or error event (e.g. connection reset) —
    // surface a generic failure rather than silently showing nothing.
    if (!gotTerminal) {
      removeTypingIndicator();
      inner.appendChild(buildMessageEl({ role: "assistant", content: "Error: The connection was interrupted before Lumen finished. Please try again." }));
    }
  } catch (e) {
    if (e.name === "AbortError") {
      removeTypingIndicator();
    } else {
      removeTypingIndicator();
      inner.appendChild(buildMessageEl({ role: "assistant", content: `Error: ${e.message}` }));
    }
  } finally {
    sending = false;
    currentAbortController = null;
    setSendingState(false);
    scrollToBottom();
  }
}

document.getElementById("chatInput").addEventListener("input", updateComposerState);

// ---------- Connection modals ----------
function openConnModal(kind) {
  document.getElementById(kind === "tableau" ? "tableauModal" : "llmModal").classList.remove("hidden");
  if (kind === "llm") setProviderTab(providerTab);
}
function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}
document.querySelectorAll(".modal-overlay").forEach((el) => {
  el.addEventListener("click", (e) => {
    if (e.target === el) el.classList.add("hidden");
  });
});

// ---------- Usage & cost modal ----------
function setUsageTab(tab) {
  for (const name of ["provider", "tools", "history"]) {
    document.getElementById(`usageTab${name[0].toUpperCase()}${name.slice(1)}`).classList.toggle("active", name === tab);
    document.getElementById(`usagePanel${name[0].toUpperCase()}${name.slice(1)}`).classList.toggle("hidden", name !== tab);
  }
}

async function openUsageModal() {
  document.getElementById("usageModal").classList.remove("hidden");
  setUsageTab("provider");
  const status = document.getElementById("usageStatus");
  status.className = "modal-status";
  status.textContent = "Loading usage...";
  try {
    const [summary, recent] = await Promise.all([api("/usage/summary"), api("/usage")]);
    renderUsageSummary(summary);
    renderUsageRecent(recent);
    const sub = document.getElementById("usageSub");
    sub.textContent = `$${summary.totals.estimatedCostUsd.toFixed(4)} total`;
    sub.classList.remove("hidden");
    status.className = "modal-status ok";
    status.textContent = summary.totals.llmTurns === 0 ? "No usage recorded yet — send a message to get started." : "Updated just now.";
  } catch (e) {
    status.className = "modal-status err";
    status.textContent = e.message;
  }
}

function setUsageStat(index, value) {
  const stats = document.querySelectorAll("#usageTotals .usage-stat-value");
  if (stats[index]) stats[index].textContent = value;
}

function renderUsageSummary(s) {
  const t = s.totals;
  setUsageStat(0, String(t.llmTurns));
  setUsageStat(1, t.totalTokens.toLocaleString());
  setUsageStat(2, `$${t.estimatedCostUsd.toFixed(4)}`);
  setUsageStat(3, String(t.toolCalls));
  setUsageStat(4, `${(t.toolErrorRate * 100).toFixed(1)}%`);

  // Per-provider table
  const providerBody = document.querySelector("#usageProviders tbody");
  providerBody.innerHTML = s.providers.length
    ? s.providers
        .map(
          (p) =>
            `<tr><td>${escapeHtml(p.provider)}</td><td>${p.llmTurns}</td><td>${(p.promptTokens + p.completionTokens).toLocaleString()}</td><td>$${p.estimatedCostUsd.toFixed(4)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="usage-muted">No activity yet</td></tr>`;

  // Most-used tools table
  const toolBody = document.querySelector("#usageTools tbody");
  toolBody.innerHTML = s.tools.length
    ? s.tools
        .slice(0, 12)
        .map((tool) => `<tr><td>${escapeHtml(tool.toolName)}</td><td>${tool.calls}</td></tr>`)
        .join("")
    : `<tr><td colspan="2" class="usage-muted">No tool calls yet</td></tr>`;

  renderUsageChart(s.days);
}

function renderUsageChart(days) {
  const empty = document.getElementById("usageChartEmpty");
  const wrap = document.querySelector(".usage-chart-wrap");
  if (!days || days.length === 0) {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  wrap.classList.remove("hidden");

  const ctx = document.getElementById("usageChart");
  if (usageChartInstance) {
    usageChartInstance.destroy();
    usageChartInstance = null;
  }
  usageChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: days.map((d) => d.date),
      datasets: [
        {
          label: "Est. cost ($)",
          data: days.map((d) => d.estimatedCostUsd),
          backgroundColor: "rgba(94, 129, 255, 0.65)",
          yAxisID: "yCost",
          order: 1,
        },
        {
          label: "Tokens",
          type: "line",
          data: days.map((d) => d.promptTokens + d.completionTokens),
          borderColor: "#7c5cff",
          backgroundColor: "transparent",
          yAxisID: "yTokens",
          tension: 0.3,
          order: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#b9c2d4" } } },
      scales: {
        x: { ticks: { color: "#8b95ab" }, grid: { color: "rgba(255,255,255,0.05)" } },
        yCost: { position: "left", ticks: { color: "#8b95ab" }, grid: { color: "rgba(255,255,255,0.05)" }, beginAtZero: true },
        yTokens: { position: "right", ticks: { color: "#8b95ab" }, grid: { drawOnChartArea: false }, beginAtZero: true },
      },
    },
  });
}

// Plain-English relative time ("2 min ago") with the exact timestamp
// available on hover — reads faster than a raw date string in a history list.
function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatDuration(ms) {
  if (!ms) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// Each row is written as a plain sentence a non-technical user can read
// without needing to know what "prompt/completion tokens" or a tool name
// means — that's the actual content, not a label/value pair to decode.
function renderUsageRecent(recent) {
  const body = document.querySelector("#usageRecent tbody");
  const rows = [];
  for (const r of recent.llm) {
    rows.push({
      time: r.createdAt,
      icon: "🤖",
      kindClass: "llm",
      text: `Sent a message to <strong>${escapeHtml(r.provider)}</strong> (${escapeHtml(r.model)}) — read ${r.promptTokens.toLocaleString()} tokens, wrote ${r.completionTokens.toLocaleString()} back`,
    });
  }
  for (const r of recent.tools) {
    const ok = r.status !== "error" && r.status !== "failed";
    rows.push({
      time: r.createdAt,
      icon: ok ? "🔧" : "⚠️",
      kindClass: ok ? "tool" : "tool-error",
      text: ok
        ? `Looked up data from Tableau using <strong>${escapeHtml(r.toolName)}</strong> — done in ${formatDuration(r.durationMs)}`
        : `Tried to use <strong>${escapeHtml(r.toolName)}</strong> but it failed${r.durationMs ? ` after ${formatDuration(r.durationMs)}` : ""}`,
    });
  }
  rows.sort((a, b) => (a.time < b.time ? 1 : -1));
  body.innerHTML = rows.length
    ? rows
        .slice(0, 25)
        .map(
          (r) =>
            `<tr><td class="usage-history-time" title="${new Date(r.time).toLocaleString()}">${relativeTime(r.time)}</td>` +
            `<td><span class="usage-kind ${r.kindClass}">${r.icon}</span> ${r.text}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="2" class="usage-muted">No activity yet — send a message to get started.</td></tr>`;
}

function setProviderTab(p) {
  const changedProvider = p !== providerTab;
  providerTab = p;
  document.getElementById("providerSelect").value = p;
  document.getElementById("model").placeholder = modelPlaceholders[p];
  document.getElementById("apiKey").placeholder = apiKeyHints[p];
  // A model name typed for one provider is never valid for another — clear
  // it on switch instead of silently sending a stale value with the wrong
  // provider (that's what caused a confusing "Could not validate" error).
  // Same reasoning for a previously-loaded model list: OpenAI's models mean
  // nothing once you've switched to Groq.
  if (changedProvider) {
    document.getElementById("model").value = "";
    const select = document.getElementById("modelSelect");
    select.innerHTML = "";
    select.classList.add("hidden");
    const hint = document.getElementById("modelLoadStatus");
    hint.classList.add("hidden");
    hint.textContent = "";
  }
}

async function loadModels() {
  const btn = document.getElementById("loadModelsBtn");
  const select = document.getElementById("modelSelect");
  const hint = document.getElementById("modelLoadStatus");
  const apiKey = document.getElementById("apiKey").value.trim();

  if (!apiKey) {
    hint.className = "field-hint err";
    hint.textContent = "Enter your API key first.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Loading...";
  hint.className = "field-hint";
  hint.textContent = "";
  select.classList.add("hidden");

  try {
    const data = await api("/connections/llm/models", {
      method: "POST",
      body: JSON.stringify({ provider: providerTab, apiKey }),
    });
    if (data.models && data.models.length > 0) {
      select.innerHTML = data.models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
      select.classList.remove("hidden");
      // Pick the first entry into the underlying free-text field connectLlm()
      // reads, but leave it editable — the dropdown is a convenience, not a lock.
      document.getElementById("model").value = data.models[0];
      hint.className = "field-hint ok";
      hint.textContent = `${data.models.length} model${data.models.length === 1 ? "" : "s"} found — pick one, or edit the field above manually.`;
    } else {
      hint.className = "field-hint";
      hint.textContent = "This provider doesn't support listing models — type the model name manually.";
    }
  } catch (e) {
    hint.className = "field-hint err";
    hint.textContent = e.message;
  } finally {
    hint.classList.remove("hidden");
    btn.disabled = false;
    btn.textContent = "Load models";
  }
}

async function connectTableau() {
  const btn = document.getElementById("tableauSubmitBtn");
  const status = document.getElementById("tableauStatus");
  status.className = "modal-status";
  status.textContent = "Signing in to verify...";
  btn.disabled = true;
  try {
    await api("/connections/tableau", {
      method: "POST",
      body: JSON.stringify({
        siteUrl: document.getElementById("siteUrl").value.trim(),
        siteContentUrl: document.getElementById("siteContentUrl").value.trim(),
        patName: document.getElementById("patName").value.trim(),
        patValue: document.getElementById("patValue").value,
      }),
    });
    status.className = "modal-status ok";
    status.textContent = "Connected.";
    await refreshConnectionStatus();
    scopeProjectsCache = null;
    await loadScopeProjectsOnce();
    setTimeout(() => closeModal("tableauModal"), 700);
  } catch (e) {
    status.className = "modal-status err";
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function connectLlm() {
  const btn = document.getElementById("llmSubmitBtn");
  const status = document.getElementById("llmStatus");
  status.className = "modal-status";
  status.textContent = "Validating key... (can take up to a minute on first use for some hosted models)";
  btn.disabled = true;
  try {
    await api("/connections/llm", {
      method: "POST",
      body: JSON.stringify({
        provider: providerTab,
        apiKey: document.getElementById("apiKey").value,
        model: document.getElementById("model").value.trim() || modelPlaceholders[providerTab],
      }),
    });
    status.className = "modal-status ok";
    status.textContent = "Connected.";
    await refreshConnectionStatus();
    setTimeout(() => closeModal("llmModal"), 700);
  } catch (e) {
    status.className = "modal-status err";
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function disconnectTableau() {
  if (!currentTableauConnectionId) return;
  if (!confirm("Disconnect this Tableau site? You'll need to re-enter the PAT to reconnect.")) return;
  const status = document.getElementById("tableauStatus");
  try {
    await api(`/connections/tableau/${currentTableauConnectionId}`, { method: "DELETE" });
    document.getElementById("siteUrl").value = "";
    document.getElementById("siteContentUrl").value = "";
    document.getElementById("patName").value = "";
    document.getElementById("patValue").value = "";
    status.className = "modal-status ok";
    status.textContent = "Disconnected.";
    await refreshConnectionStatus();
    scopeProjectsCache = null;
    document.getElementById("scopeProject").disabled = true;
  } catch (e) {
    status.className = "modal-status err";
    status.textContent = e.message;
  }
}

async function disconnectLlm() {
  if (!currentLlmConnectionId) return;
  if (!confirm("Disconnect this LLM? You'll need to re-enter the API key to reconnect.")) return;
  const status = document.getElementById("llmStatus");
  try {
    await api(`/connections/llm/${currentLlmConnectionId}`, { method: "DELETE" });
    document.getElementById("apiKey").value = "";
    document.getElementById("model").value = "";
    status.className = "modal-status ok";
    status.textContent = "Disconnected.";
    await refreshConnectionStatus();
  } catch (e) {
    status.className = "modal-status err";
    status.textContent = e.message;
  }
}

// ---------- Init ----------
(async function init() {
  setAuthTab("login");
  if (token) {
    try {
      currentUser = JSON.parse(localStorage.getItem("lumen_user") || "null");
      await api("/connections"); // cheap auth check — 401s if the token is stale/invalid
      await bootApp();
    } catch {
      logout();
    }
  }
})();
