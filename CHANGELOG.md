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
