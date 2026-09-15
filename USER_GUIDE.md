# Lumen — User Guide

Lumen is a chat assistant for your Tableau data. Instead of clicking through dashboards, you ask questions in plain English and Lumen fetches the real answer — data, a chart, an image of the dashboard, or a direct link — from your own Tableau site.

This guide walks through everything you need to get started and use it well.

---

## 1. What you'll need before you start

Lumen is **BYOK** ("Bring Your Own Key") — it doesn't come with its own Tableau access or AI subscription. You connect your own:

1. **A Tableau Personal Access Token (PAT)** — proves who you are to Tableau. Not your Tableau password.
2. **An API key from an AI provider** — powers the chat itself (Anthropic, OpenAI, Google Gemini, NVIDIA, OpenRouter, or Groq).

Both are stored encrypted and are only ever used on your behalf — nobody else on the platform can see or use them.

### Getting a Tableau Personal Access Token

1. Log into your Tableau site in a browser.
2. Go to **My Account Settings**.
3. Scroll to **Personal Access Tokens** → **Create new token**.
4. Give it a name (e.g. `lumen-access`) and copy the token value **immediately** — Tableau only shows it once.

### Getting an AI provider API key

Pick one provider to start (you can add more later, or switch anytime):

| Provider | Where to get a key | Notes |
|---|---|---|
| **Anthropic (Claude)** | console.anthropic.com | Recommended — most reliable, supports images, generous rate limits on a paid plan |
| **OpenAI (GPT)** | platform.openai.com | Also reliable, supports images |
| **Google Gemini** | aistudio.google.com | Supports images, often has a usable free tier |
| **NVIDIA NIM** | build.nvidia.com | Free tier available, text-only for most models |
| **OpenRouter** | openrouter.ai | Aggregates many models, some free |
| **Groq** | console.groq.com | Very fast, but its **free tier has a low rate limit** — large requests (e.g. asking for a dashboard image) can fail on the free tier. Use a paid key, or a different provider, if you plan to use images often. |
| **Mistral** | console.mistral.ai | Text-only (no image support) |
| **DeepSeek** | platform.deepseek.com | Text-only (no image support), inexpensive |

---

## 2. Signing up and logging in

1. Open the platform in your browser.
2. Click **Sign up**, enter your email and a password (minimum 8 characters), and submit.
3. Next time, use **Log in** with the same email/password.

Your login session lasts a while, so you won't need to log in every single visit — but if you're ever logged out unexpectedly, just log back in.

---

## 3. Connecting your accounts

Once logged in, you'll see the sidebar with two connection rows near the bottom: **Connect Tableau** and **Connect LLM**. Both need to be connected (green dot) before you can chat.

### Connect Tableau
Click the **Connect Tableau** row and fill in:
- **Site URL** — e.g. `https://your-pod.online.tableau.com` (no trailing slash, no `/#/site/...` part)
- **Site Content URL** — the short name after `/site/` in your Tableau web address. Leave this **blank** if you're on the Default site.
- **Token name** and **Token value** — from the PAT you created above.

If something's wrong (bad token, wrong site URL), you'll get a plain-English error explaining what to check — fix it and try again.

### Connect LLM
Click the **Connect LLM** row, pick a provider tab, paste your API key, and optionally type a specific model name (a sensible default is pre-filled as a placeholder if you leave it blank).

Once both rows show a green dot, you're ready to chat.

**Note:** connecting a new Tableau or LLM account replaces your previous one — you can only have one of each connected at a time.

---

## 4. Starting a conversation

Click **+ New chat** in the sidebar. Type a question and press Enter (or click send).

Your first message automatically becomes that conversation's title in the sidebar — no need to name chats yourself.

### Good first questions to try
- "What datasources do I have access to?"
- "What dashboards do I have?"
- "Show me the fields in my top datasource"
- "What were total sales by region last quarter?"

Lumen will look things up as needed (projects → workbooks → dashboards → data) and answer using **your own real Tableau data** — it never makes numbers up.

---

## 5. Narrowing a conversation to one dashboard (Scope)

At the top of a conversation is a **SCOPE** bar with three dropdowns: **Project → Workbook → Dashboard**, plus a **Clear** button.

Use this when you want a conversation locked to one specific place — e.g. you're only interested in "Marketing" dashboards and don't want Lumen wandering off into unrelated data:

1. Pick a **Project** — the conversation is now limited to that project's workbooks.
2. Optionally pick a **Workbook** — limited further to that workbook's dashboards.
3. Optionally pick a specific **Dashboard** — limited to just that one dashboard.
4. Click **Clear** anytime to go back to asking about your whole site.

Scope is per-conversation — start a new chat to ask about something else without affecting this one.

---

## 6. Getting an overview of a dashboard

When you're scoped to a specific dashboard and ask something like *"give me an overview"* or *"summarize this dashboard"*, Lumen doesn't guess what you want — it asks you to pick, with three clickable buttons:

- **📝 Text summary** — key numbers and breakdowns as text
- **🖼️ Image** — a picture of the dashboard exactly as it looks in Tableau
- **🔗 Direct link** — a link to open it yourself in Tableau, if you'd rather just look

Just click the one you want. This also saves you cost/time when you're happy to just open the link yourself instead of pulling everything into the chat.

**Why it asks**: some dashboards are built from several chart panels that aren't individually retrievable through Tableau's API — Lumen is upfront about this instead of quietly showing you incomplete data. If a text summary comes back thin (e.g. "only 1 sheet found"), that's a real Tableau publishing detail, not a bug — Lumen will usually try querying the underlying data directly as a fallback, and will tell you plainly if a specific chart genuinely can't be reconstructed.

---

## 7. Reading the results

- **Charts** — when data has numeric values, Lumen renders a chart automatically. Click **📊 Chart** on a result to expand it.
- **Images** — dashboard screenshots appear inline behind an **🖼️ Image** toggle. Click the image itself to open a full-screen, zoomable view (click to zoom in/out, or use the +/− buttons; click outside or press Esc to close).
- **Links** — any Tableau link Lumen gives you is clickable and opens the real dashboard in a new context.

---

## 8. Tracking usage and cost

Click **Usage & cost** in the sidebar to see:
- Totals: LLM turns, tokens used, estimated cost, tool calls made, and error rate
- A daily activity chart
- Three tabs: **By provider**, **Tools called**, and **History** (a plain-English activity log — e.g. "Sent a message to anthropic... read 1,200 tokens, wrote 340 back")

Costs shown are **estimates** based on your provider's published rates — not an actual bill. Check your provider's own dashboard (e.g. console.anthropic.com) for real billing.

---

## 9. Tips for better answers

- **Be specific about the dashboard/chart name** if you know it — e.g. "What does the Revenue by Region chart show?" rather than just "show me revenue."
- **Ask for one thing at a time.** A focused question gets a faster, more accurate answer than a big compound one.
- **If an answer seems wrong or mismatched**, say so — e.g. "that doesn't look like country data" — Lumen will look for a better match rather than repeat the same wrong call.
- **Use Scope** for any dashboard you'll be asking about more than once in a session — it keeps answers on-topic and is cheaper/faster.
- **For a genuinely complete numeric breakdown of every chart on a dashboard**, ask explicitly, e.g. "query the underlying data and break this down by [country/channel/device]" — this is more reliable than a general "overview" for dashboards with many chart panels.

---

## 10. Troubleshooting

| What you see | What it means |
|---|---|
| "No Tableau connection configured" / "No LLM connection configured" | Go connect that account in the sidebar (see Section 3). |
| "This access token was rejected" | Your Tableau token is wrong, expired, or revoked — check it, or generate a new one. |
| "This API key was rejected" | Your AI provider key is wrong/expired — check it in your provider's own dashboard. |
| "That request was too big for this AI model to handle" | Usually a free-tier rate limit (common on Groq's free tier) — try again, ask a narrower question, or switch to a different provider/paid key. |
| "This AI model can't look at images" | The connected model doesn't support images — ask for the underlying data/text instead, or switch to a vision-capable model (Anthropic, OpenAI, and Gemini all support images). |
| Any other error | It's written in plain English on purpose — it'll tell you what to check or try next. If it's still unclear, reach out to whoever manages the platform. |

---

## 11. Privacy and data

- Your Tableau token and AI provider key are encrypted before being stored — nobody else can see or use them.
- Every request Lumen makes to Tableau uses **your own** credentials against **your own** Tableau site — Lumen never has broader access than you already do.
- Conversation history is stored so you can come back to old chats — clear a conversation's scope or start a new chat anytime for a clean slate.
