# GoldenSpaceAI — sidebar & instructions UI polish (2026-10-01)

- **Chats sidebar:** clearer spacing/typography, refined chat rows, stronger plan strip, polished search and footer.
- **Custom Instructions:** labeled Global / This chat sections, clearer hints, Save + Cancel actions (same localStorage + per-chat prompt persistence; no payment/OMT/admin changes).
- **Mobile:** opening chats/sidebar (including instructions) is a full-screen cover; composer bar is hidden underneath. Desktop stays a side drawer.
- Service worker cache `goldenspaceai2-v20`. App version `2.2.4`.

---

# GoldenSpaceAI — upgrade light theme contrast (2026-09-30)

- **Bug:** in `html.light`, the final Upgrade step “Send payment via OMT Pay” kept a hardcoded dark `.pay-box` (`#12100a`) while labels/values switched to dark muted/text — Send to / From / Plan / numbered steps were nearly invisible (Amount gold stayed readable).
- **Fix:** light-mode overrides for `.pay-box`, `.pay-row`, `.pay-steps`, plus the Accept-policies `.check` card and related step chrome (panel / plan-card / step-dot / password field). Dark theme unchanged.
- Service worker cache `goldenspaceai2-v19`. App version `2.2.3`.

---

# GoldenSpaceAI — live plan usage + themes (2026-09-30)

- **Root cause (usage stuck at 0):** the chats footer called `GET /api/plan-status` only once at startup and never again after a send, and those GETs were cacheable (`ETag`, no `Cache-Control`). Counters in `data/plans.json` were also written on a 50ms debounce and incremented when the request *started*, including failed model calls, so the footer and `/my-plan` did not show a successful Fast / Thinking / Expert question.
- **Fix:** reserve one unit for the cap, keep it only after a non-empty successful reply (roll back on error, empty reply, or disconnect), flush `plans.json` immediately, send `Cache-Control: no-store` on `/api/plan`, `/api/plan-status`, and `/api/my-plan`, and reload the footer (and `/my-plan`) after each reply. Same `X-Client-Id` as chat history. Auto chat-title calls are not metered.
- **Upgrade:** confirm OMT number is a password field (masked). The first number stays visible.
- **Theme:** `/upgrade`, `/my-plan`, `/terms`, `/privacy`, `/refund`, and `/admin-page` share the chat `html.light` theme via `goldenspaceai2_theme` in localStorage, with a Light/Dark toggle.
- Service worker cache `goldenspaceai2-v18`.

---

# GoldenSpaceAI — polish plan UI, upgrade & legal + my-plan status (2026-09-30)

- **In-app plan status** (chats footer): current plan name, used/limit + % progress bars (Free: Fast daily; Paid: Fast + Thinking + Expert4 + Expert16 if included). Links to `/my-plan` and `/upgrade`.
- **API:** `GET /api/plan-status` (quotas + %), `GET /api/my-plan` (plan + quotas + payment requests Waiting/Approved/Declined for this device). Same `X-Client-Id` as chats. Caps/OMT/admin auth unchanged.
- **`/my-plan`** (alias `/plan-status` → redirect): user-facing page for current plan, expiry, usage %, and payment request status/history. Linked from index footer, upgrade, and legal nav.
- **`/upgrade`:** SaaS-style pricing cards (featured Pro), exact prices & feature bullets matching caps, polished accept → phone verify → OMT steps. Dark/gold aesthetic.
- **`/terms`, `/privacy`, `/refund`:** professional legal layout (sticky nav, max-width, hierarchy, ToC). Legal text unchanged.
- SW cache bumped to `goldenspaceai2-v17`.

---

# GoldenSpaceAI — payment / plans system (2026-09-30)

- **Plans & hard caps** (server-side, device id = same `X-Client-Id` as chat history):
  - Free: Fast 50/day; no Thinking / Expert 4 / Expert 16
  - Plus $5: Fast 120/day; Thinking 40/mo; Expert 4 15/mo; no Expert 16
  - Pro $10: Fast 200/day; Thinking 80/mo; Expert 4 40/mo; Expert 16 8/mo
  - Max $15: Fast 300/day; Thinking 120/mo; Expert 4 60/mo; Expert 16 15/mo
- Daily Fast resets at **UTC midnight** (documented in `/api/plan` + upgrade UI). Thinking/Expert are per **30-day paid period** from admin confirm.
- Cap enforcement runs **before** model calls on `/api/chat` and `/api/chat/stream`. Limit responses are JSON/SSE with `upgradeUrl: /upgrade`.
- When Fast is served via **OpenAI→Grok fallback**, that UTC day uses a **halved** Fast budget (`markFastHalved`).
- Persist subscriptions, usage, and payment requests in `data/plans.json` (JSON store under `DATA_DIR`).
- **Legal:** `/terms`, `/privacy`, `/refund` (full ToS as provided; matching Privacy + Refund).
- **`/upgrade`:** choose plan → accept policies → OMT number twice → send exact $ to **81056987** → Amount sent → Waiting.
- **`/admin-page`:** locked with env **`ADMIN_PASSKEY`**; list/approve/decline requests; approve starts 30-day plan bound to phone + device (one OMT number = one active paid plan).
- Chats panel footer: Upgrade · Terms · Privacy · Refund. SW cache `goldenspaceai2-v16`. App version `2.2.0`.
- Env: `ADMIN_PASSKEY` (already set on Render). Optional existing: `DATA_DIR`, `GROK_API_KEY`, `OPENAI_API_KEY`, `FAST_PROVIDER`.

---

# GoldenSpaceAI — fix: Install App one-press only (2026-09-30)

- **Change:** Install App is **one press → native `beforeinstallprompt.prompt()`** only. No teaching modal, no how-to steps, no navigate to `/app-install.html` from the Install button.
- Capture `beforeinstallprompt` early; **show the Install button only while a deferred prompt exists** (hidden when standalone or prompt unavailable).
- If the user somehow clicks with no deferred event: silent no-op (no toast/modal).
- Service worker cache bumped to `goldenspaceai2-v15`.
- **Note (PR only):** iOS Safari cannot one-press install via JS; the Install button stays hidden there until/unless a browser fires `beforeinstallprompt` (it does not on iOS Safari).
- Target HTTPS host: `www.goldenspaceai.space`.

---

# GoldenSpaceAI — fix: Install App stays in-app (2026-09-30)

- **Root cause:** After PR #11, Install App still hard-navigated to `/app-install.html` whenever `beforeinstallprompt` had not fired yet (common on iOS Safari, Firefox, early clicks before Chrome engagement heuristics, or after a dismissed prompt). Users experienced a bounce away from chat even though the live SW was already `v13` and the manifest was installable.
- **Fix:** Keep capturing `beforeinstallprompt` early and call `prompt()` when deferred. If no deferred event, show an **in-app modal** with platform-specific Add to Home Screen / Install steps instead of forcing navigation. Optional “More install help” link opens `/app-install.html` only when the user chooses it.
- Service worker cache bumped to `goldenspaceai2-v14` so clients drop stale shells.
- Target HTTPS host: `www.goldenspaceai.space`.

---

# GoldenSpaceAI — fix: real PWA install prompt (2026-09-30)

- **Bug:** Install App in the chats panel footer always fell through to `/app-install.html` after (or instead of) the native prompt — including when the user dismissed `beforeinstallprompt`.
- **Fix:** Call deferred `beforeinstallprompt.prompt()` when available; navigate to `/app-install.html` **only** if no deferred event was captured.
- Hardened `manifest.json` for installability after GoldenSpaceAI rename: `id`, `scope: "/"`, `start_url: "/"`, `display: "standalone"`, separate `any` + `maskable` icons (`/logo.png`).
- Service worker remains registered from `index.html`; cache bumped to `goldenspaceai2-v13`.
- Target HTTPS host: `www.goldenspaceai.space`.

---

# GoldenSpaceAI — branding update (2026-09-30)

- Renamed user-visible app branding from GoldenSpaceAI2 to GoldenSpaceAI across the chat UI, install/offline pages, PWA manifest, health response, and logo.
- Added a welcoming “Welcome to GoldenSpaceAI” empty state.
- Bumped the service worker cache to `goldenspaceai2-v12`.

---

# GoldenSpaceAI2 — hotfix: chat thinking UX + speak cleanup

## Root cause (premature Fast badge / actions)
On `/api/chat/stream`, as soon as response headers arrived the client removed the typing dots and called `renderMessage()` on an **empty** AI placeholder. That always injected the mode badge plus Copy/Share/Listen/Regen — so finished-message chrome appeared while the bubble was still empty.

## Fix
- Keep a real **thinking** state (dots + status line) until the first reply text arrives (or the reply completes)
- Only then render the AI message with mode badge + action buttons
- Honest stream status from server SSE (`thinking` / `searching` / `researching` / `generating` / `listening`) — no fake chain-of-thought
- If the provider streams real `reasoning` / `reasoning_content` deltas, show them tastefully in a small trace under the thinking row
- **Listen**: `textForSpeech()` strips emojis + markdown noise before `speechSynthesis` (no spoken emoji names)
- Service worker cache `goldenspaceai2-v11`
- No regression intended for mobile layout, Install App footer, voice overlay, error Retry, or `HISTORY_WINDOW` 40

---

# GoldenSpaceAI2 — hotfix: Fast connection error

## Root cause
After PR #7, default **Fast** mode always called OpenAI. On Render those calls failed with the OpenAI SDK `Connection error.` (while Thinking/Grok still worked), so every Fast reply looked like a connection failure.

## Fix
- **Fast defaults back to Grok** `grok-4.3` so chat works without waiting on a broken OpenAI path
- Opt in to OpenAI Fast with Render env `FAST_PROVIDER=openai` (still falls back to Grok on connection/auth failure)
- Pin OpenAI `baseURL` to `https://api.openai.com/v1` (ignore stray `OPENAI_BASE_URL`)
- Clearer mapping for SDK `Connection error.`; client keeps friendly server messages instead of remapping to a generic network error
- Service worker cache `goldenspaceai2-v10`

---

# GoldenSpaceAI2 — improvement round

## Voice · errors · Fast(OpenAI) · context · image preview

- Professional **Listening…** overlay (waveform pulse; Done / Cancel / Esc / tap backdrop)
- Human-readable API/network errors + **Retry** on failed assistant turns
- **Fast** mode → OpenAI `gpt-4o-mini` (vision) via `OPENAI_API_KEY` / optional `OPENAI_FAST_MODEL`
- Thinking (Grok 4.3) and Expert (multi-agent) unchanged — no silent Fast→Grok fallback
- Recent history window **~40** messages (client + server)
- ChatGPT-style image/file preview **above** composer with remove (X); paste image supported
- Service worker cache `goldenspaceai2-v9`

**Render env (required for Fast):** `OPENAI_API_KEY`  
**Optional:** `OPENAI_FAST_MODEL` (default `gpt-4o-mini`)  
Thinking/Expert still need `GROK_API_KEY`.

---

# GoldenSpaceAI2 v2.1.0

Professional chat upgrades (no rewrite of core branding/modes).

## Added / improved

### Streaming + stop/regenerate
- `POST /api/chat/stream` — SSE chunks for normal/smart (OpenAI SDK `stream: true`); expert falls back to Responses API as one chunk
- Frontend consumes stream and updates the AI bubble live
- Send button becomes **Stop** (aborts fetch); **Regenerate** on last AI message
- Legacy `POST /api/chat` kept for compatibility (auto-title, etc.)

### Persistence (Render-friendly)
- JSON store at `DATA_DIR` (default `./data`) + `/chats.json`
- `GET/POST /api/chats`, `GET/PUT/DELETE /api/chats/:id`
- Anonymous `X-Client-Id` header (device id in localStorage)
- localStorage remains cache/offline fallback; sync when online

### Conversation UX
- Edit last user message + resend (with confirm)
- Rename chat (sidebar pencil)
- Search chats (sidebar filter)
- Export current chat as `.md`
- Confirm before delete

### Message quality
- Fenced code blocks with Copy button
- KaTeX CDN for `$$...$$` and `$...$` (server uses soft latex clean; keeps delimiters)
- Attach `.txt` / `.md` as text; PDF notes unsupported client-side

### Backend hardening
- `CORS_ORIGIN` env (unset/`*` = allow all for backward compat; comma-list = allowlist)
- DIY in-memory rate limit: 30 req/min/IP on `/api/chat*`
- ~60s upstream timeout (`UPSTREAM_TIMEOUT_MS`)
- Logs mode/model/length only — not API keys or full bodies

### Product polish
- Light/dark theme toggle (persisted; defaults from `prefers-color-scheme`)
- Richer empty state
- Global instructions + optional per-chat system prompt

## Files touched
- `server.js`
- `public/index.html`
- `public/sw.js` (cache `goldenspaceai2-v3`)
- `package.json` (version `2.1.0`)
- `data/.gitkeep`
- `CHANGELOG.md`

## How to test
1. `npm install && GROK_API_KEY=... npm start`
2. Open app → send a message → text should stream; click Stop mid-stream
3. Use Regenerate on last AI reply; Edit on last user message
4. Theme toggle; Search chats; Export; rename/delete with confirm
5. Attach a `.txt`/`.md`; check code-block Copy; math with `$x^2$`
6. `curl -H 'X-Client-Id: demo' http://localhost:3000/api/chats`
7. `node --check server.js`
