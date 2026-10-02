# GoldenSpaceAI — plan limits + Talk minutes (2026-10-02)

- **Plan $ budgets (internal):** Plus Fast $1.30 / Thinking $0.60 / Kept $3; Pro Fast $3.80 / Thinking+Expert4 $3 shared / Kept $3; Max Fast $5.60 / Thinking+Expert4 $3 shared / Expert16 $3 / Kept $3. Free Fast $0.05/UTC day unchanged. Hard-stop, no borrow. Users still see **% only**.
- **Talk minutes** (Live / speak-aloud TTS voice time): Free **1 min/UTC week**; Plus **5** / Pro **10** / Max **20** min per 30-day period. Wired into `/api/tts` with hard-stop (no browser bypass when exhausted).
- **Terms §3 / Upgrade** offer copy updated (Talk + modes + images + docs). Plan list prices OK; no internal cost/$ budgets shown to users.
- Service worker cache `goldenspaceai2-v66`. App `2.3.40`.

---

# GoldenSpaceAI — Live TTS seamless + calmer Live UI (2026-10-02)

- **TTS gap fix:** Live sentence queue prefetches the next OpenAI TTS chunk while the current one plays, so playback handoff has no network wait between sentences.
- **Live UI:** Cleaner, less flashy `/live` — quieter background, flatter controls, subtler orb/phase states, refined typography and transcript.
- Service worker cache `goldenspaceai2-v65`. App `2.3.39`.

---

# GoldenSpaceAI — Live e2e latency cut (2026-10-02)

- **Faster Live loop:** Silence before auto-send ~650ms (was ~1.1s); shorter waits for STT flush, enter, and re-listen so the stream starts sooner.
- **Chunk TTS:** Live starts speaking on the first complete sentence while the reply still streams; remaining text flushes on done (queued sentence playback).
- **TTS speed:** OpenAI + browser speak-aloud at **1.25** (was 1.15). Short Live replies kept (system prompt + 256 token cap); prompt leads with the answer.
- Service worker cache `goldenspaceai2-v64`. App `2.3.38`.

---

# GoldenSpaceAI — Live UI pro + short Fast + faster TTS (2026-10-02)

- **Live UI:** Full-screen `/live` restyled for a more professional voice experience (brand mark, phase pills, glass transcript, refined orb/rings, cleaner controls).
- **Live Fast short only:** Live turns send `live: true` with a short-reply system prompt (client + server) and `maxTokens` capped at 256 so spoken answers stay brief.
- **TTS:** Speak-aloud slightly faster — OpenAI `speed: 1.15` (default) and browser speech rate `1.15`.
- Service worker cache `goldenspaceai2-v63`. App `2.3.37`.

---

# GoldenSpaceAI — Live voice dedicated page (2026-10-02)

- **Dedicated Live page:** Empty-composer **Live** opens a full-screen Grok-like `/live` page (not a chat overlay). Exit / Escape / browser back returns to chat with turns saved.
- **Auto-send on silence:** Mic listens continuously; when speech pauses (~1.1s), the turn sends automatically as **Fast only** (`mode: normal`, normal Fast billing). Mute pauses the loop; tap Listening to force-send.
- **Instant text + audio:** User and AI transcripts appear on the Live page immediately (AI streams live); TTS plays as soon as audio is ready, then listening resumes.
- Service worker cache `goldenspaceai2-v62`. App `2.3.36`.

---

# GoldenSpaceAI — Live voice chat (2026-10-02)

- **Live chat:** When the composer is empty, Send becomes a Grok-like **Live** button. With text (or an attachment), Send stays as now.
- **Live loop:** Controllable mic (open/close). Speech→text reuses Dictate STT. On listen stop, message sends as **Fast only** (`mode: normal`) and bills tokens/$ like normal Fast. Reply is spoken with existing TTS. Loop until Exit (or Escape).
- **Normal chat:** Dictate, modes, typing, and Send behavior unchanged outside Live.
- Service worker cache `goldenspaceai2-v61`. App `2.3.35`.

---

# GoldenSpaceAI — speed, landing, upgrade cards, dictate UX (2026-10-02)

- **Speed:** Stream SSE opens + status before context-pack cold path; skip `getChat` when client already sent rolling summary; gpt-5 empty-stream goes straight to minimal-reasoning retry (skip slow high-effort round-trip); leaner empty-retry token bump; client skips redundant `/api/chat` when stream already `done`. Timing logs: `sse_open`, `pack_ready`, `stream_open`, `first_delta`, `empty_*`, total ms.
- **Empty chat / landing:** Professional first screen — logo, “How can I help?”, starter chips, quieter CTA; modes + plan hint retained.
- **Upgrade:** Offer cards aligned with Terms §3 (modes, image caps, unlimited docs, % usage). Free reference strip. Mode pills on cards. No internal $ budgets.
- **Mic UX:** Composer control labeled **Dictate** with clear press/listening states; overlay copy separates dictate from speak-aloud TTS.
- **Ops:** Verify Render deploy of latest `main` after merge. `support@goldenspaceai.space` is mailto only — inbound forwarding is user-side DNS/mail.
- Service worker cache `goldenspaceai2-v60`. App `2.3.34`.

---

# GoldenSpaceAI — plan copy: offers only, no cost internals (2026-10-02)

- **Terms §3** rewritten so users see what each plan **offers** only (modes, image caps, unlimited docs). Removed model-cost USD budgets, retained/margin $, bucket dollar amounts, and provider model pricing language. List prices $5/$10/$15, 30-day period, OMT, % usage, hard-stop, no mode borrowing kept.
- **Upgrade / My Plan / chat settings** copy cleaned: no gpt/grok model ids, no “bucket/$” allotment language; stacking & footnotes say mode allowances.
- Public API notes (`timezoneNote`, stacking rules, quota notes) no longer mention retained $ or Fast $ spend.
- Service worker cache `goldenspaceai2-v59`. App `2.3.33`.

---

# GoldenSpaceAI — contact help + Thinking disclosure (2026-10-02)

- **Need help / Contact us:** `mailto:support@goldenspaceai.space` on upgrade, login, terms, privacy, refund, my-plan, and updating (not main chat; admin skipped).
- Legal Contact sections and footers now point at support@goldenspaceai.space.
- **Chat Thinking / activity panel:** removed golden card/pill. Collapsed summary is plain muted text with a › disclosure; expanded body is a clean left-border Grok-style reveal (no gold box).
- Service worker cache `goldenspaceai2-v58`. App `2.3.32`.

---

# GoldenSpaceAI — professional mode selector (2026-10-02)

- **Mode selector redesign:** Fast / Thinking / Expert dropdown looks like ChatGPT/Claude product UI — clean trigger + chevron, quiet panel, stacked name/description, checkmark for selected, muted Upgrade hint — not arcade pills or NEW/BEST badges.
- Light/dark theme tokens preserved (gold line, soft surfaces, Inter).
- Service worker cache `goldenspaceai2-v57`. App `2.3.31`.

---

# GoldenSpaceAI — OpenAI empty content extract + KaTeX softClean (2026-10-02)

- **Cause:** Fast `gpt-5-nano` (and other gpt-5 chat models) are reasoning models. Visible reply text is not always in `choices[0].message.content` as a plain string — it can be a **content-parts array**, `refusal`, or other fields. Streaming deltas can use the same shapes. Separately, reasoning can consume the entire `max_completion_tokens` budget so `content` is genuinely empty (`finish_reason=length`).
- **Fix:** Shared extractors for chat Completions **stream + non-stream** (`extractChatCompletionText` / `extractChatDeltaText` / `extractChatMessageText`) so real text is pulled from string or parts. Empty OpenAI gpt-5 replies get **one retry** with `reasoning_effort: minimal` and a higher `max_completion_tokens`.
- **KaTeX en-dash:** softClean always runs on stream chunks, fallbacks, and `done.full`; client prefers cleaned `full` and also normalizes en/em/minus dashes before render.
- Service worker cache `goldenspaceai2-v56`. App `2.3.30`.

---

# GoldenSpaceAI — OpenAI gpt-5 temperature + KaTeX dash (2026-10-02)

- **Fix OpenAI 400** on Fast (`gpt-5-nano` / gpt-5 family): omit `temperature` (API only allows default `1`). Configured `0.7` was rejected.
- Helper `chatTemperatureParams` on non-stream, stream, and non-stream fallback chat/completions paths. Grok/xAI and non–gpt-5 OpenAI models still send configured temperature.
- **KaTeX:** soft-clean normalizes unicode en/em dashes (`–`/`—`) to ASCII `-` so math renders more reliably.
- Service worker cache `goldenspaceai2-v55`. App `2.3.29`.

---

# GoldenSpaceAI — OpenAI max_completion_tokens for gpt-5-nano (2026-10-02)

- **Fix OpenAI 400** on Fast (`gpt-5-nano` / newer chat completions): send `max_completion_tokens` instead of deprecated `max_tokens`.
- Applies to non-stream, stream, and non-stream fallback chat/completions paths when provider is OpenAI.
- **Grok/xAI unchanged:** still use `max_tokens` (and Responses `max_output_tokens` for Expert).
- Service worker cache `goldenspaceai2-v54`. App `2.3.28`.

---

# GoldenSpaceAI — cost-bucket plan policy + daily image caps (2026-10-02)

- **Budgets by estimated API $ cost** (not message count). Users see **% only** — never $ or tokens in public UI.
- **Hard-stop per bucket; no borrowing** across buckets. Retained $ on paid plans is margin (not usable).
- **Models:** Fast = `gpt-5-nano`; Thinking = `grok-4.3`; Expert 4/16 = `grok-4.20-multi-agent-0309` (4 / 16 agents).
- **Buckets**
  - **Free:** Fast $0.05/day UTC midnight · no Thinking/Expert · **5 images/day**
  - **Plus $5 / 30d:** Fast $2 · Thinking $1 · no Expert · retained $2 · **10 images/day**
  - **Pro $10 / 30d:** Fast $4 · Thinking+Expert4 **shared $3** · no Expert16 · retained $3 · **20 images/day**
  - **Max $15 / 30d:** Fast $6 · Thinking+Expert4 **shared $3** · Expert16 **$3 alone** · retained $3 · **30 images/day**
- Images count toward Fast $ **and** the daily image count hard-stop. Document/file uploads (text path) are **unlimited**.
- Paid starts on **admin approve**, 30 days, **no auto-renew**, OMT wallet-to-wallet. Decline still requires a visible reason.
- Context pack unchanged: person memory + chat summary + last few messages (no full history).
- UI: plan cards, Terms, mode menu locks by plan, quota bars for Fast / ThinkShare / Expert16 / Images.
- Service worker cache `goldenspaceai2-v53`. App `2.3.27`.

---

# GoldenSpaceAI — admin provider spend split (2026-10-02)

- **`/admin-users`:** per-user spend split by provider — **$ Grok** and **$ OpenAI** for **today** (UTC) and **total** (all-time). Summary cards show Grok vs OpenAI under $ today / $ total.
- **Usage tracking:** `recordSpend` stores provider (`openai` | `grok`) with each token-cost commit; daily + lifetime counters `todayGrokSpendUsd` / `todayOpenaiSpendUsd` / `totalGrokSpendUsd` / `totalOpenaiSpendUsd`. Provider inferred from model when omitted.
- Historical rows may show $0 for provider splits until new usage is recorded (overall today/total unchanged).
- Service worker cache `goldenspaceai2-v52`. App `2.3.26`.

---

# GoldenSpaceAI — ChatGPT-style context packing + account memory (2026-10-02)

- **Context pack (token savings):** model prompts now use last **10** raw messages + optional **rolling summary** of older turns + **account memory** — not the full ~40 history every request. Plan usage / spend still meters the **actual tokens of this smaller pack**.
- **Account memory (logged-in only):** sticky facts (name, prefs, stable personal details) in Postgres `user_memory`, injected into every chat’s system pack. Guests: no cross-chat memory.
- **Per-chat rolling summary:** stored on `chats.rolling_summary` / `summary_message_count`; refreshed as history ages out of the recent window.
- **Extraction:** durable facts pulled heuristically from user turns (e.g. “My name is …”); ephemeral task details are not stored across chats.
- **API:** `GET/PUT/PATCH/DELETE /api/memory` (auth required). Settings → **Remembered about you** to view / clear.
- **Pack structure (exact order):**
  1. `system` — custom instructions (if any)
  2. `system` — account memory block (logged-in, if facts exist)
  3. `system` — rolling summary of earlier turns (if any)
  4. recent raw user/assistant messages (last `RECENT_WINDOW`, default 10)
- Service worker cache `goldenspaceai2-v51`. App `2.3.25`.

# GoldenSpaceAI — admin users dashboard polish (2026-10-02)

- **`/admin-users` redesign:** clearer header, summary stat cards (user count, paid/free, tokens/$ today + total), email/name search + plan filter, sortable columns with sticky header, plan badges, muted empty states, responsive layout. Same ADMIN_PASSKEY auth and columns (email, plan, device, location, tokens/$ today + total). Nav link to `/admin-page`.
- Service worker cache `goldenspaceai2-v50`. App `2.3.24`.

---

# GoldenSpaceAI — Free Fast daily $0.05 (2026-10-02)

- **Free Fast daily budget:** lowered from **$0.25** to **$0.05** (5 cents) model-cost USD per UTC calendar day. Free Other remains **$0**.
- **Copy:** Terms Free plan Fast pool updated to USD 0.05/day.
- Paid allotments unchanged (Plus/Pro/Max).
- Service worker cache `goldenspaceai2-v49`. App `2.3.23`.

---

# GoldenSpaceAI — percent usage UI + admin spend (2026-10-02)

- **User-facing usage:** plan strip, Settings, My Plan, upgrade hints, and chat limit messages show **% used / % left only** — no dollar amounts or token counts for end users. Real $ budgets still enforced server-side.
- **APIs:** `GET /api/plan-status` / `GET /api/my-plan` quota displays are percent-only; `GET /api/plan` returns a public payload without $ spend / token counters.
- **Limit replies:** “Plan used — please upgrade” includes percent used (not `$used / $cap`).
- **/admin-users:** each user shows **tokens spent** and **dollars spent** for **today** (UTC) and **total** (all-time), persisted on every `recordSpend`.
- Service worker cache `goldenspaceai2-v48`. App `2.3.22`.

---

# GoldenSpaceAI — token $ spend budgets (2026-10-02)

- **Budgets are real model-cost USD** (not message counts / not plan list price).
- **Pools:** Fast (Fast/normal only) vs Other (Thinking + Expert 4/16 / multi-AI share one pool).
- **Allotments:** Plus Fast $2 / Other $1 · Pro Fast $5 / Other $3 · Max Fast $8 / Other $4 · Free Fast $0.25/day (UTC), Other $0.
- **Pricing table in code** (`pricing.js`): gpt-4o-mini $0.15/$0.60 per 1M; grok-4.3 & multi-agent $1.25/$2.50 (<200k prompt), $2.50/$5.00 (≥200k). Spend = prompt+completion tokens × rates.
- **Exhaustion:** mode blocked with “Plan used — please upgrade”; when both paid pools are used → demote to Free.
- **Stacking:** Free→paid full budgets; same-plan / upgrade stacking adds Fast/Other $ allotments (persisted in Postgres `plans_store`).
- **UI:** plan strip + settings + My Plan + Upgrade show $ left (Fast vs Other).
- Service worker cache `goldenspaceai2-v47`. App `2.3.21`.

---

# GoldenSpaceAI — premium speak-aloud TTS (2026-10-01)

- **Speak aloud:** each assistant reply has a speaker button that reads the answer aloud.
- **Provider:** OpenAI TTS (`tts-1-hd`) via existing `OPENAI_API_KEY` when configured; otherwise graceful browser `speechSynthesis` fallback (no fake ElevenLabs).
- **Voices:** Nova (default, warm), Alloy, Shimmer, Echo, Fable, Onyx — picker in Settings → Voice.
- **Auto-read:** optional Settings toggle to automatically speak new assistant replies.
- **Playback:** starting a new speak stops the previous one; the button shows playing/stop state (and the stop control).
- **Input mic/STT unchanged** — this is output voice only.
- **API:** `GET /api/tts/status`, `POST /api/tts` (mp3). Rate-limited.
- Service worker cache `goldenspaceai2-v46`. App `2.3.20`.

---

# GoldenSpaceAI — search / thinking activity panel (2026-10-01)

- **Searching panel:** during Expert web search (and when the provider emits tool events), the assistant message shows a collapsible **Searching…** panel with real site/domain URLs as SSE `site` / `sites` events arrive — never faked.
- **Thinking:** reasoning/thinking snippets from the backend (`reasoning` SSE, Responses reasoning fields) appear in the same panel.
- **Post-answer preview:** when the reply finishes, the panel stays on the message (collapsed by default: “Searched N sites · Thinking”) and can be expanded to review sources and thinking.
- **Server:** Expert Responses API prefers streaming and forwards web_search / citation / reasoning events; non-stream fallback still extracts `citations`, `url_citation` annotations, and `web_search_call` URLs.
- Service worker cache `goldenspaceai2-v45`. App `2.3.19`.

---

# GoldenSpaceAI — landing, plan funnel, chat reliability, settings (2026-10-01)

- **Landing / empty chat:** professional first screen with short value line, clear Start CTA (focuses composer), mode pills, and soft plan hint linking to `/upgrade`.
- **Plan strip + upgrade funnel:** sidebar plan strip shows usage left, progress, next-tier benefit, and one primary CTA to `/upgrade` (renew/stack on Max). Footer legal keeps Terms/Privacy/Refund; duplicate Upgrade/My Plan links removed from the bar to avoid dead ends (still in Settings).
- **Chat reliability:** clearer thinking/streaming status (mode pill + Streaming…), stronger sticky scroll on mobile (larger near-bottom threshold, double-rAF, visualViewport), regenerate always available on the last AI turn (inject if missing), stop/regenerate paths hardened; leftover table/math overflow safety on mobile.
- **Settings polish:** Appearance (theme), Custom instructions (global + this chat), Plan usage, and Plan requests live cleanly in the settings modal. Guests can open Settings for theme/instructions/usage; Log in CTA when signed out.
- **Sign out:** removed from chat bar/footer; logout remains **only** in Settings. Auth footer: email · plan · gear · Install (guests: Log in · gear · Install).
- Service worker cache `goldenspaceai2-v44`. App `2.3.18`.

---

# GoldenSpaceAI — hide document extract in chat bubble (2026-10-01)

- **Document uploads:** extracted Word/PDF/txt/etc. text is no longer pasted into the user message bubble.
- **UI:** bubble shows typed text (if any) plus an attachment chip with the filename; composer file chip unchanged.
- **Model context:** extract is stored on the message as `attachedFile` (`name`, `note`, `text`) and expanded into the model payload server-side (`expandUserContentForModel` in `buildConversationMessages`). Images and plain text messages unchanged.
- Service worker cache `goldenspaceai2-v43`. App `2.3.17`.

---

# GoldenSpaceAI — admin users directory (2026-10-01)

- **Admin `/admin-users`:** read-only users table (email, plan, device, location) behind the same **ADMIN_PASSKEY** / `gsa_admin` cookie as `/admin-page`.
- **API:** `GET /api/admin/users` (admin session required). No approve/decline/pause actions on this page.
- **Data:** Postgres `users` + `device_links`; plan from plans subscriptions (`u_<userId>`); location/device fallbacks from last payment request IP geo / deviceId when login metadata is not stored.
- Pause-exempt so the page stays reachable while the site is paused. Link from `/admin-page` ↔ `/admin-users`.
- Service worker cache `goldenspaceai2-v42`. App `2.3.16`.

---

# GoldenSpaceAI — pause / unpause site (2026-10-01)

- **Admin Pause:** `/admin-page` control to Pause / Unpause GoldenSpaceAI.
- **When paused:** chat and all non-admin pages show a full-page message: “Updating GoldenSpaceAI. Please wait and come back later.”
- **Admin stays up:** `/admin-page` and `/api/admin/*` remain reachable so you can unpause.
- **Persistence:** `settings.paused` stored in the plans Postgres/`plans.json` store (same durable path as payments).
- Service worker cache `goldenspaceai2-v41`. App `2.3.15`.

---

# GoldenSpaceAI — admin decline reason in email (2026-10-01)

- **Admin Decline:** clicking Decline opens a dialog to type a non-empty reason; Cancel aborts; OK sends the reason to the decline API.
- **Storage:** `declineReason` saved on the payment with `decidedAt`.
- **Declined email:** includes `Reason: {admin text}` (HTML + plain text) while keeping the refund wording from PR #38.
- Service worker cache `goldenspaceai2-v40`. App `2.3.14`.

---

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
