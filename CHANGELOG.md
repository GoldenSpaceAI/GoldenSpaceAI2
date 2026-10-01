# GoldenSpaceAI — declined plan email refund notice (2026-10-01)

- **Declined upgrade email:** clearly states that all money sent will be refunded; if fees apply, the refund is the amount sent minus those fees.
- Service worker cache `goldenspaceai2-v39`. App `2.3.13`.

---

# GoldenSpaceAI — plan stacking on approve/upgrade (2026-10-01)

- **Stacking on admin approve:** when a payment is approved, quotas stack instead of merely replacing the plan tier.
  1. **Free → any paid:** grant that plan’s full base limits (Fast / Thinking / Expert 4 / Expert 16).
  2. **Upgrade to a higher plan** (Plus→Pro, Pro→Max, Plus→Max): keep current effective caps and **ADD** `(newBase − oldBase)` per quota.
  3. **Same plan again** (e.g. Max→Max): **ADD** another full base allotment (doubles from a single allotment; further buys keep adding).
- Effective caps stored on the subscription as `caps` and used for Fast/Thinking/4-AI/16-AI enforcement.
- **`/upgrade`:** when the user already has a paid plan, show a clear stacking notice plus a live preview of resulting caps for the selected plan.
- Admin payment records include `stackMode`, `capsBefore` / `capsDelta` / `capsAfter`. App `2.3.12`. SW `goldenspaceai2-v38`.

# GoldenSpaceAI — professional admin + upgrade geo (2026-10-01)

- **Admin `/admin-page`:** professional request cards with clear **Request ID**, email, phone, current plan → requested plan, amount, device/client id, request IP, and estimated location.
- **IP geo:** store client IP at upgrade submit time; resolve location via free `ipwho.is` API; cache results in plans store (`geoCache`) and on each payment.
- **Approve/Decline** and **ADMIN_PASSKEY** login unchanged.
- **Upgrade request email:** security note — do not share Request ID / request code with anyone.
- Service worker cache `goldenspaceai2-v37`. App `2.3.11`.

---

# GoldenSpaceAI — persist plans/payments across Render deploys (2026-10-01)

- **Root cause:** plan usage, subscriptions, and OMT payment history lived in `data/plans.json` on the Render ephemeral filesystem, so every deploy/restart wiped daily limits and Waiting/Approved/Declined history.
- **Fix:** store the plans blob in Postgres table `plans_store` (same `DATABASE_URL` / `GoldenSpaceAI2-db` Oregon). Boot loads Postgres first; if empty, migrates existing JSON → PG; JSON remains a local mirror/fallback when DB is unavailable.
- Upgrade request / admin approve & decline await a durable Postgres flush. Service worker `goldenspaceai2-v36`. App `2.3.10`.

---

# GoldenSpaceAI — chat page SaaS visual polish (2026-10-01)

- **Chat page only** major visual polish for a more professional SaaS look (mobile + desktop). Plans/caps/OMT/admin/auth/PWA behavior unchanged.
- **Spacing & type:** Inter/system font stack, tighter letter-spacing, antialiased text, clearer hierarchy across header, messages, composer, and sidebar.
- **Chrome:** frosted top bar refinements, brand mark, pill actions; sidebar gradient surface, rounded new-chat control, hoverable chat rows, stronger search focus ring, cleaner account/install/legal footer.
- **Messages & empty:** softer bubbles, denser readable AI column, branded empty state with mode pill; tables/modes/web toggle/instructions/settings modal kept.
- **Composer:** elevated shell, focus ring, refined mode/web/attach/mic/send controls; mobile full-width, desktop centered **~760px** chat column with ~300px sidebar.
- Service worker cache `goldenspaceai2-v35`. App `2.3.9`.

---

# GoldenSpaceAI — account-scoped plan/payment history (2026-10-01)

- **Cross-device plan history:** upgrade requests (Waiting / Approved / Declined), amounts, plan, status, and dates persist under the **logged-in account** (`userId` + email), not only `X-Client-Id`. Settings, `/my-plan`, and `/upgrade` load the same history on every device.
- **Subscriptions / usage:** approved plans bind to `u_<userId>` so paid status follows the account; guests stay device-local.
- **Upgrade flow:** login required; removed the email input — notifications always use the signed-in account email. `/login?next=/upgrade` returns users to the upgrade page after OTP (and Google via `gsa_post_login`).
- Service worker cache `goldenspaceai2-v34`. App `2.3.8`.

---

# GoldenSpaceAI — cross-device chat sync + plan status emails (2026-10-01)

- **Cross-device sync root cause:** device→user chat merge failed with `invalid input syntax for type json` (jsonb bind), so chats stayed under device keys; GET preferred empty Postgres over JSON fallback (Oregon split-brain); login client could keep an empty local cache ahead of cloud.
- **Fix:** serialize jsonb on merge; merge all linked device chats on login/list; union + migrate JSON→Postgres on GET `/api/chats`; client `hydrateAccountChatsFromServer` treats cloud as source of truth after login.
- **Plan emails (Resend):** notify when an upgrade request is submitted (Waiting), when admin approves, and when admin declines. Optional email on `/upgrade` (prefilled from signed-in account). Soft-skip if `RESEND_API_KEY` or email missing — never blocks the API.

# GoldenSpaceAI — guest ephemeral chats + account sync rules (2026-10-01)

- **Guests:** no server chat memory. `/api/chats` list returns empty for guests; write/get-by-id require login. Client stores guest chats in `sessionStorage` only (not durable `localStorage`, not cloud).
- **Logged-in:** chats still sync under `u_<userId>` (Postgres + JSON fallback). Email OTP and Google continue to merge on the same email → same user.
- **Login:** load account chats; adopt any in-tab guest session chats into the account once, then clear guest session keys.
- **Logout:** wipe account chat `localStorage` + guest session state and start a fresh empty guest chat (no leak of account history).
- Docs: `AUTH_ENV.md` chat memory rules. SW `goldenspaceai2-v32`. App `2.3.6`.

---

# GoldenSpaceAI — new-login email alert (2026-10-01)

- **Auth:** after a successful email OTP verify **or** Google OAuth callback, send a separate Resend email (subject: “New login to your GoldenSpaceAI account”) with UTC time and an ignore-if-it-was-you note.
- **Not** the OTP code email — OTP copy/send path unchanged.
- Only when the user has an email and `RESEND_API_KEY` is set; reuses `EMAIL_FROM` / Resend. Failures are logged and never block the session.

---

# GoldenSpaceAI — stepped email OTP login UX (2026-10-01)

- **/login:** email OTP is a **two-step** flow — enter email → dedicated code step (not cramped on the same form).
- **OTP boxes:** six separate digit inputs with auto-advance, paste support, and backspace to previous box.
- **Sign in** verifies the code; wrong code clears the boxes, shows an error, and allows retype.
- **Resend:** available only after a **2-minute** countdown; then Resend code is enabled.
- Google Continue unchanged. Same professional /login look (light/dark).
- Service worker cache `goldenspaceai2-v31`. App `2.3.5`.

---

# GoldenSpaceAI — centered settings modal + plain AI bubbles (2026-10-01)

- **Settings:** gear opens a **centered modal** (overlay backdrop) instead of a side drawer; close via **X**, backdrop click, or **Escape**. Keeps email, username, plan usage, plan requests, upgrade, and sign out.
- **Assistant messages:** removed golden left border / soft gold glow gradient on AI bubbles — clean plain text block.
- Service worker cache `goldenspaceai2-v30`. App `2.3.4`.

---

# GoldenSpaceAI — readable chat tables + bottom-bar auth polish (2026-10-01)

- **Chat tables:** clearer header/zebra/borders/padding; cells wrap sensibly (`min-width` + `max-width`) so text stays readable; wide tables still scroll horizontally inside the wrap (touch-friendly, no page overflow). Mobile-tuned cell sizes.
- **Chats footer auth:** while signed in, **Log in is fully hidden** (fixed `display` overriding `[hidden]`); shows **email · plan · Sign out · gear**. Log in only when logged out.
- **Footer layout:** cleaner account row (identity + actions), Install App, then legal links with subtle separators.
- Service worker cache `goldenspaceai2-v29`. App `2.3.3`.

---

# GoldenSpaceAI — account in bottom bar + scrollable chat tables (2026-10-01)

- **Top bar:** removed account strip; top stays clean (menu, brand, title, export, theme).
- **Chats footer:** Log in → `/login` when guest; when signed in shows **email**, **plan badge**, and **gear** → settings drawer. Instructions + Install App stay as before.
- **Install App:** unchanged one-press `beforeinstallprompt` only (hidden when unavailable / Safari-Mac / standalone; no force to `/app-install.html`).
- **Chat tables:** Markdown/HTML tables use `overflow-x: auto` wrappers (`width: max-content`), touch-friendly pan, no page-wide horizontal scroll.
- Keeps dedicated `/login` page and settings panel from 2.3.0.
- Service worker cache `goldenspaceai2-v28`. App `2.3.2`.

---

# GoldenSpaceAI — dedicated login page + account strip + settings (2026-10-01)

- **Login page:** new polished `/login` route (`public/login.html`) with logo/branding, Google + email OTP, Terms/Privacy links, light/dark.
- **Chat chrome:** removed bulky sidebar auth card + plan status block. Top bar shows **Log in** (→ `/login`) when guest; when signed in shows **email**, **plan badge**, and **gear**.
- **Settings panel:** gear opens a drawer with email, username, plan usage counters, plan/payment requests, upgrade + logout. Reuses `/api/auth/status`, `/api/plan-status`, `/api/my-plan`.
- Auth APIs unchanged; Google still returns to `/?auth=ok`. Guest chat still works.
- Service worker cache `goldenspaceai2-v26`. App `2.3.0`.

---

# GoldenSpaceAI — email 6-digit OTP (Resend) replaces magic link (2026-10-01)

- **Auth:** email login is now OTP: `POST /api/auth/otp/request` → Resend emails a 6-digit code → `POST /api/auth/otp/verify` sets session. Magic-link routes removed.
- **Soft-disable:** email UI/API stay off until `RESEND_API_KEY`; Google OAuth unchanged.
- **Postgres:** `email_otps` table (hashed codes, attempts, expiry).
- **UI:** login modal Send code → enter code → Verify; disabled cleanly without Resend.
- **Docs:** `AUTH_ENV.md` updated for OTP + soft-disable.
- Service worker cache `goldenspaceai2-v25`. App `2.2.9`.

---

# GoldenSpaceAI — email magic-link + Google OAuth + cross-device chat sync (2026-10-01)

- **Auth:** `/api/auth/status`, `/api/auth/me`, magic-link request/consume, Google OAuth start/callback, logout, `POST /api/auth/merge-device`.
- **Sessions:** signed HttpOnly cookie `gsa_session` via `SESSION_SECRET`.
- **Postgres:** users, magic_links, device_links, chats tables when `DATABASE_URL` is set; JSON `chats.json` remains guest/fallback.
- **Chats:** logged-in owner key `u_<userId>`; guest keeps device id. Login merges device → user. Guest still works.
- **UI:** Account card in chats footer + login modal (email / Google). Providers disable cleanly until keys exist (`AUTH_ENV.md`).
- **Unchanged:** plans, OMT upgrade, admin, Fast/Thinking/Expert caps (still `X-Client-Id` device scoped).
- Env checklist: `AUTH_ENV.md`. SW `goldenspaceai2-v24`. App `2.2.8`.

---

# GoldenSpaceAI — chat page pro polish (2026-10-01)

- **Chat page only** visual/UX step-up beyond PR #19 (index.html CSS/JS). Plans/caps/OMT/admin/math fix untouched.
- **Header:** brand mark, editable title + live mode subtitle, frosted top bar, pill Export/Theme actions.
- **Messages:** denser readable rhythm, gold-accent AI column, refined user bubbles, hover actions, timestamps (incl. user) on hover/long-press.
- **Markdown:** stronger code blocks (header/copy), tables, KaTeX block/inline spacing — stash/render path unchanged.
- **Composer:** elevated shell, SVG attach/mic/send/stop, focus ring, mobile mode row preserved (no starter-prompt chips).
- **Empty / thinking / toasts:** branded empty state, status pill + shimmer, dismissible glass toasts; light/dark tokens aligned; subtle motion with reduced-motion respect.
- Service worker cache `goldenspaceai2-v23`. App version `2.2.7`.

---

# GoldenSpaceAI — fix chat math/number scrambling (2026-10-01)

- **Bug:** `softCleanLatex` turned `\boxed{…}` into `$$1$` (JS replacement `$$$$1$$` eats the capture), and `formatMarkdown` did not stash `\( \)` / `\[ \]` before list normalization, so expressions like `-4 - 2^2 - 3 \cdot 1 - 5` became bullet lists / garbled digits.
- **Fix:** replacer-function boxed → `$$…$$`; stash `$$`, `\[ \]`, `\( \)`, and `$…$` (HTML-escaped) before markdown list/heading rewrites so KaTeX auto-render gets intact exponents / `\cdot`.
- Mental check: `-4 - 2^2 - 3 · 1 - 5 = -16`.
- Service worker cache `goldenspaceai2-v22`. App version `2.2.6`.

---

# GoldenSpaceAI — chatting polish + Office/PDF file extract (2026-10-01)

- **Composer:** attach / mic / send / Stop polish, stronger iPhone safe-area inset, mobile mode picker on its own less-cramped row (no starter prompt chips).
- **Messages:** bubble polish, code/math copy, timestamp on hover / long-press.
- **Streaming:** RAF-batched typing with caret; clearer Thinking status labels.
- **Scroll:** stick-to-bottom on new replies; jump-to-latest when scrolled up.
- **Header:** inline chat title edit; mobile mode menu spacing.
- **Toasts:** copy, limit hit, file extract / upgrade hard-stops.
- **Files:** upload Word (.doc/.docx), PowerPoint (.ppt/.pptx), PDF, txt/md (+ images as before). Server extract via `/api/extract-file` (mammoth / pptx XML / pdf-parse). Extracted text enters chat context. **Does not burn plan caps.**
- **Mode routing:** prefer Fast for images + extracted text; escalate to Thinking when Fast cannot handle; Free users who need Thinking get an upgrade hard-stop (no Thinking burn).
- Service worker cache `goldenspaceai2-v21`. App version `2.2.5`.

---

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
