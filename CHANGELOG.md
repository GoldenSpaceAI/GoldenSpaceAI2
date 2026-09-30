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
