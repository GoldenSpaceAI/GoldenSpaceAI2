# Auth environment checklist (GoldenSpaceAI2)

Login (email **6-digit OTP** via Resend + Google OAuth) and cross-device chat sync are implemented in code.
**Live login stays disabled until the keys below are set.** Guest chat, plans, OMT, admin, and caps are unchanged and keep using the device `X-Client-Id`.

## Required for sessions + sync storage

| Name | Purpose | Status notes |
|------|---------|--------------|
| `DATABASE_URL` | Postgres connection (Render Internal DB URL) | Create DB `GoldenSpaceAI2-db`, then **Link** it to each web service (or paste Internal Database URL). |
| `SESSION_SECRET` | Signs `gsa_session` cookie | Set on Oregon + Frankfurt (random 32+ bytes hex). |

Without these, `/api/auth/*` reports `ready: false`. Chats still work as guest via device id (JSON fallback; Postgres chats when `DATABASE_URL` is linked).

## Google OAuth (optional until you have a Cloud project)

| Name | Purpose |
|------|---------|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Web client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 Web client secret |
| `GOOGLE_REDIRECT_URI` | Optional. Default: `{APP_BASE_URL}/api/auth/google/callback` |

Authorized redirect URIs to add in Google Cloud Console:

- `https://www.goldenspaceai.space/api/auth/google/callback`
- `https://goldenspaceai2.onrender.com/api/auth/google/callback`
- `https://goldenspaceai2-frankfurt.onrender.com/api/auth/google/callback` (if used)

## Email 6-digit OTP (soft-disabled until Resend)

Email login is **soft-disabled** until `RESEND_API_KEY` is set. The UI shows “Send code” / verify disabled; Google can still work independently once its keys + DB/session are ready.

UI: primary login is `/login` (chats panel footer links there). Flow: user enters email on step 1 → we email a 6-digit code via Resend → dedicated step 2 with six digit boxes (2-minute resend cooldown) → Sign in → session cookie → redirect to chat.

| Name | Purpose |
|------|---------|
| `RESEND_API_KEY` | Resend API key (**required** to enable email OTP) |
| `EMAIL_FROM` | Optional From header, e.g. `GoldenSpaceAI <login@yourdomain.com>` (falls back to `MAGIC_LINK_FROM` / `SMTP_FROM` / Resend onboarding address) |

**SMTP alternative (documented only; not wired for OTP send)**

| Name | Purpose |
|------|---------|
| `SMTP_HOST` | SMTP hostname |
| `SMTP_PORT` | Optional (default provider-specific) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | From address |

> Shipping note: OTP **send** uses **Resend** only when `RESEND_API_KEY` is set. SMTP names are reserved/documented; full nodemailer SMTP can be added later without API changes.

## Public URL (OAuth redirect)

| Name | Purpose |
|------|---------|
| `APP_BASE_URL` or `PUBLIC_URL` | Canonical site origin, e.g. `https://www.goldenspaceai.space` |

## What blocks live login today

Until keys exist, UI shows providers as disabled. `/api/auth/status` and `/health` → `auth.liveLoginBlockedBy` list missing pieces. Status also exposes `emailOtp: true/false`.

Typical first enable order:

1. Link `DATABASE_URL` from Render Postgres `GoldenSpaceAI2-db` to **GoldenSpaceAI2** (Oregon) and **GoldenSpaceAI2-frankfurt**.
2. Confirm `SESSION_SECRET` is set (already applied via MCP if deploy succeeded).
3. Add `APP_BASE_URL=https://www.goldenspaceai.space`.
4. Add Google and/or `RESEND_API_KEY` when ready — no code change required.

## Behavior

- **Guest:** no cloud chat memory (session-only on the client). Plans still use device `X-Client-Id`.
- **Logged in:** chats keyed by `u_<userId>`; list/messages sync across devices via Postgres (JSON merged/migrated as fallback).
- **On login:** linked device chats + JSON fallback merge into the user; client re-hydrates from GET `/api/chats`.
- **Plans / OMT / admin / caps:** still device-scoped; not broken by login.
- **Email OTP:** codes expire in 10 minutes; max 5 verify attempts per code.
- **Login alert:** after successful OTP verify or Google OAuth, a separate Resend email (“New login to your GoldenSpaceAI account”) is sent when the user has an email and `RESEND_API_KEY` is set. Reuses `EMAIL_FROM`. Does not change the OTP code email.

## Chat memory rules

1. **Guests:** no cloud chat persistence. Client keeps chats in `sessionStorage` only (this tab / session). Refresh does **not** restore guest history from the server. Clearing the tab ends guest chats.
2. **Logged-in users:** chats sync under Postgres/JSON owner key `u_<userId>`. Same email (OTP or Google) maps to the same user row so chats follow the account.
3. **Login:** load that user’s chats; optional one-shot adopt of in-session guest chats into the account, then clear guest session storage.
4. **Logout:** clear account `localStorage` chat keys and guest session state so account chats never leak into guest mode. Plans/quotas still use `X-Client-Id` (device), not chat owner keys.



## Plan status emails (Resend)

When `RESEND_API_KEY` is set, GoldenSpaceAI sends:

1. **Upgrade request received** — after POST `/api/upgrade/request` creates a Waiting payment (or first attaches an email to an existing Waiting request).
2. **Plan approved** — after admin POST `/api/admin/payments/:id/approve`.
3. **Plan declined** — after admin POST `/api/admin/payments/:id/decline`.

Recipient: optional `email` on the upgrade form, else the signed-in account email (session cookie). Stored on the payment record for approve/decline. Missing email or Resend key → skip send; request still succeeds. Uses `EMAIL_FROM` like OTP / login-alert mail.
