/**
 * Auth: email magic-link + Google OAuth + signed session cookies.
 * Requires DATABASE_URL + SESSION_SECRET for sessions/users.
 * Google/magic-link stay disabled until their keys are set (see AUTH_ENV.md).
 */
const crypto = require('crypto');
const { Pool } = require('pg');

const SESSION_COOKIE = 'gsa_session';
const SESSION_DAYS = 30;
const MAGIC_TTL_MS = 20 * 60 * 1000;

function env(name) {
    const v = process.env[name];
    return v == null ? '' : String(v).trim();
}

function boolConfigured(name) {
    return !!env(name);
}

function authStatus() {
    const database = boolConfigured('DATABASE_URL');
    const sessionSecret = boolConfigured('SESSION_SECRET');
    const google = boolConfigured('GOOGLE_CLIENT_ID') && boolConfigured('GOOGLE_CLIENT_SECRET');
    const resend = boolConfigured('RESEND_API_KEY');
    const smtp = boolConfigured('SMTP_HOST') && boolConfigured('SMTP_FROM');
    const email = resend || smtp;
    return {
        database,
        sessionSecret,
        googleOAuth: google,
        magicLink: email,
        emailTransport: resend ? 'resend' : (smtp ? 'smtp' : null),
        ready: database && sessionSecret,
        liveLoginBlockedBy: [
            !database && 'DATABASE_URL',
            !sessionSecret && 'SESSION_SECRET',
            !google && !email && 'GOOGLE_CLIENT_ID+GOOGLE_CLIENT_SECRET or RESEND_API_KEY/SMTP_*'
        ].filter(Boolean)
    };
}

function getPublicBaseUrl(req) {
    const fromEnv = env('APP_BASE_URL') || env('PUBLIC_URL');
    if (fromEnv) return fromEnv.replace(/\/$/, '');
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
    if (host) return `${proto}://${host}`;
    return 'https://www.goldenspaceai.space';
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64url');
}

function signSession(payload, secret) {
    const body = b64url(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function verifySession(token, secret) {
    if (!token || !secret) return null;
    const parts = String(token).split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload || !payload.uid || !payload.exp) return null;
        if (Date.now() > Number(payload.exp)) return null;
        return payload;
    } catch (_) {
        return null;
    }
}

function createAuth(options = {}) {
    const getChatOwnerKey = options.getChatOwnerKey; // (req) => device or user key — injected later
    let pool = null;
    let schemaReady = false;
    let schemaPromise = null;

    function getPool() {
        const url = env('DATABASE_URL');
        if (!url) return null;
        if (!pool) {
            pool = new Pool({
                connectionString: url,
                ssl: url.includes('localhost') || url.includes('127.0.0.1')
                    ? false
                    : { rejectUnauthorized: false },
                max: 5,
                idleTimeoutMillis: 30000
            });
            pool.on('error', (err) => console.error('Postgres pool error:', err.message));
        }
        return pool;
    }

    async function ensureSchema() {
        const p = getPool();
        if (!p) return false;
        if (schemaReady) return true;
        if (schemaPromise) return schemaPromise;
        schemaPromise = (async () => {
            const client = await p.connect();
            try {
                try { await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto'); } catch (_) {}
                await client.query(`
                    CREATE TABLE IF NOT EXISTS users (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        email TEXT UNIQUE,
                        google_id TEXT UNIQUE,
                        name TEXT,
                        picture TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS magic_links (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        email TEXT NOT NULL,
                        token_hash TEXT NOT NULL UNIQUE,
                        device_id TEXT,
                        expires_at TIMESTAMPTZ NOT NULL,
                        used_at TIMESTAMPTZ,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS device_links (
                        device_id TEXT PRIMARY KEY,
                        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS chats (
                        owner_key TEXT NOT NULL,
                        chat_id TEXT NOT NULL,
                        name TEXT NOT NULL DEFAULT 'New Chat',
                        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
                        created_at TIMESTAMPTZ,
                        updated_at TIMESTAMPTZ,
                        named BOOLEAN NOT NULL DEFAULT FALSE,
                        custom_instructions TEXT DEFAULT '',
                        system_prompt TEXT DEFAULT '',
                        PRIMARY KEY (owner_key, chat_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_chats_owner_updated ON chats (owner_key, updated_at DESC);
                    CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links (email);
                `);
                schemaReady = true;
                console.log('Auth/Postgres schema ready');
                return true;
            } catch (e) {
                console.error('Auth schema error:', e.message);
                schemaReady = false;
                return false;
            } finally {
                client.release();
                schemaPromise = null;
            }
        })();
        return schemaPromise;
    }

    function sessionSecret() {
        return env('SESSION_SECRET');
    }

    function readUserFromReq(req) {
        const secret = sessionSecret();
        if (!secret) return null;
        const token = req.cookies && req.cookies[SESSION_COOKIE];
        const payload = verifySession(token, secret);
        if (!payload) return null;
        return { id: payload.uid, email: payload.email || null, name: payload.name || null };
    }

    function setSessionCookie(res, user, req) {
        const secret = sessionSecret();
        if (!secret || !user || !user.id) return;
        const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
        const token = signSession({
            uid: user.id,
            email: user.email || null,
            name: user.name || null,
            exp
        }, secret);
        const secure = (req && (req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https'))) || process.env.NODE_ENV === 'production';
        res.cookie(SESSION_COOKIE, token, {
            httpOnly: true,
            secure: !!secure,
            sameSite: 'lax',
            path: '/',
            maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
        });
    }

    function clearSessionCookie(res) {
        res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax' });
    }

    async function upsertUserByEmail(email, extra = {}) {
        const p = getPool();
        await ensureSchema();
        const norm = String(email || '').trim().toLowerCase();
        if (!norm) throw new Error('Email required');
        const r = await p.query(
            `INSERT INTO users (email, name, picture, google_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (email) DO UPDATE SET
               name = COALESCE(EXCLUDED.name, users.name),
               picture = COALESCE(EXCLUDED.picture, users.picture),
               google_id = COALESCE(EXCLUDED.google_id, users.google_id),
               updated_at = NOW()
             RETURNING id, email, name, picture, google_id`,
            [norm, extra.name || null, extra.picture || null, extra.google_id || null]
        );
        return r.rows[0];
    }

    async function upsertUserByGoogle({ google_id, email, name, picture }) {
        const p = getPool();
        await ensureSchema();
        if (!google_id) throw new Error('google_id required');
        // Prefer match by google_id; else by email
        let r = await p.query('SELECT * FROM users WHERE google_id = $1 LIMIT 1', [google_id]);
        if (r.rows[0]) {
            const u = r.rows[0];
            const upd = await p.query(
                `UPDATE users SET email = COALESCE($2, email), name = COALESCE($3, name),
                  picture = COALESCE($4, picture), updated_at = NOW()
                 WHERE id = $1 RETURNING id, email, name, picture, google_id`,
                [u.id, email ? String(email).toLowerCase() : null, name || null, picture || null]
            );
            return upd.rows[0];
        }
        if (email) {
            return upsertUserByEmail(email, { name, picture, google_id });
        }
        r = await p.query(
            `INSERT INTO users (google_id, name, picture) VALUES ($1, $2, $3)
             RETURNING id, email, name, picture, google_id`,
            [google_id, name || null, picture || null]
        );
        return r.rows[0];
    }

    async function linkDevice(userId, deviceId) {
        if (!userId || !deviceId) return;
        const p = getPool();
        await ensureSchema();
        await p.query(
            `INSERT INTO device_links (device_id, user_id) VALUES ($1, $2)
             ON CONFLICT (device_id) DO UPDATE SET user_id = EXCLUDED.user_id, linked_at = NOW()`,
            [deviceId, userId]
        );
    }

    /**
     * Merge guest/device chats into the logged-in user owner key.
     * Keeps the newer updated_at when both exist.
     */
    async function mergeDeviceChatsToUser(deviceId, userId) {
        if (!deviceId || !userId) return { merged: 0 };
        const p = getPool();
        await ensureSchema();
        const userKey = 'u_' + userId;
        const client = await p.connect();
        let merged = 0;
        try {
            await client.query('BEGIN');
            const deviceRows = await client.query('SELECT * FROM chats WHERE owner_key = $1', [deviceId]);
            for (const row of deviceRows.rows) {
                const existing = await client.query(
                    'SELECT chat_id, updated_at FROM chats WHERE owner_key = $1 AND chat_id = $2',
                    [userKey, row.chat_id]
                );
                if (!existing.rows[0]) {
                    await client.query(
                        `INSERT INTO chats (owner_key, chat_id, name, messages, created_at, updated_at, named, custom_instructions, system_prompt)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                        [userKey, row.chat_id, row.name, row.messages, row.created_at, row.updated_at, row.named, row.custom_instructions, row.system_prompt]
                    );
                    merged += 1;
                } else {
                    const remoteTs = String(row.updated_at || '');
                    const localTs = String(existing.rows[0].updated_at || '');
                    if (remoteTs > localTs) {
                        await client.query(
                            `UPDATE chats SET name=$3, messages=$4, created_at=$5, updated_at=$6, named=$7,
                              custom_instructions=$8, system_prompt=$9
                             WHERE owner_key=$1 AND chat_id=$2`,
                            [userKey, row.chat_id, row.name, row.messages, row.created_at, row.updated_at, row.named, row.custom_instructions, row.system_prompt]
                        );
                        merged += 1;
                    }
                }
            }
            await client.query('DELETE FROM chats WHERE owner_key = $1', [deviceId]);
            await client.query('COMMIT');
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            console.error('mergeDeviceChatsToUser:', e.message);
            throw e;
        } finally {
            client.release();
        }
        return { merged };
    }

    async function afterLogin(user, deviceId, res, req) {
        if (deviceId) {
            try { await linkDevice(user.id, deviceId); } catch (e) { console.error('linkDevice:', e.message); }
            try { await mergeDeviceChatsToUser(deviceId, user.id); } catch (e) { console.error('merge chats:', e.message); }
            // Also merge JSON file store if present (legacy / fallback)
            if (typeof options.mergeJsonDeviceToUser === 'function') {
                try { options.mergeJsonDeviceToUser(deviceId, 'u_' + user.id); } catch (e) { console.error('merge json:', e.message); }
            }
        }
        setSessionCookie(res, user, req);
        return user;
    }

    async function sendMagicEmail(to, link) {
        const status = authStatus();
        if (!status.magicLink) {
            return { ok: false, error: 'Magic link email is not configured. Set RESEND_API_KEY (or SMTP_HOST + SMTP_FROM).' };
        }
        const subject = 'Your GoldenSpaceAI login link';
        const text = `Sign in to GoldenSpaceAI:\n\n${link}\n\nThis link expires in 20 minutes. If you did not request it, ignore this email.`;
        const html = `<p>Sign in to GoldenSpaceAI:</p><p><a href="${link}">${link}</a></p><p>This link expires in 20 minutes. If you did not request it, ignore this email.</p>`;

        if (env('RESEND_API_KEY')) {
            const from = env('MAGIC_LINK_FROM') || env('SMTP_FROM') || 'GoldenSpaceAI <onboarding@resend.dev>';
            const resp = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + env('RESEND_API_KEY'),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ from, to: [to], subject, html, text })
            });
            if (!resp.ok) {
                const body = await resp.text().catch(() => '');
                console.error('Resend error:', resp.status, body);
                return { ok: false, error: 'Failed to send email via Resend.' };
            }
            return { ok: true };
        }

        // Minimal SMTP via nodemailer is NOT a dependency — use raw net only if SMTP_* set with RESEND preferred.
        // Without nodemailer, document SMTP; try simple HTTPS Relays only if RESEND missing.
        return { ok: false, error: 'SMTP is documented but Resend is preferred. Set RESEND_API_KEY, or add nodemailer + SMTP_* later.' };
    }

    async function createMagicLink({ email, deviceId, req }) {
        const status = authStatus();
        if (!status.ready) {
            return { ok: false, error: 'Auth storage not ready. Set DATABASE_URL and SESSION_SECRET.', status };
        }
        if (!status.magicLink) {
            return { ok: false, error: 'Magic link disabled until RESEND_API_KEY (or SMTP_HOST + SMTP_FROM) is set.', status };
        }
        const norm = String(email || '').trim().toLowerCase();
        if (!norm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) {
            return { ok: false, error: 'Valid email required.' };
        }
        const p = getPool();
        await ensureSchema();
        const raw = crypto.randomBytes(32).toString('base64url');
        const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
        const expires = new Date(Date.now() + MAGIC_TTL_MS);
        await p.query(
            `INSERT INTO magic_links (email, token_hash, device_id, expires_at) VALUES ($1,$2,$3,$4)`,
            [norm, tokenHash, deviceId || null, expires.toISOString()]
        );
        const base = getPublicBaseUrl(req);
        const link = `${base}/api/auth/magic/consume?token=${encodeURIComponent(raw)}`;
        const sent = await sendMagicEmail(norm, link);
        if (!sent.ok) return { ok: false, error: sent.error, status };
        return { ok: true, message: 'Check your email for a login link.', status };
    }

    async function consumeMagicLink(rawToken, res, req) {
        const status = authStatus();
        if (!status.ready) return { ok: false, error: 'Auth not configured.', status };
        const p = getPool();
        await ensureSchema();
        const tokenHash = crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
        const r = await p.query(
            `SELECT * FROM magic_links WHERE token_hash = $1 LIMIT 1`,
            [tokenHash]
        );
        const row = r.rows[0];
        if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
            return { ok: false, error: 'Invalid or expired login link.' };
        }
        await p.query('UPDATE magic_links SET used_at = NOW() WHERE id = $1', [row.id]);
        const user = await upsertUserByEmail(row.email);
        await afterLogin(user, row.device_id, res, req);
        return { ok: true, user: { id: user.id, email: user.email, name: user.name } };
    }

    function googleConfigured() {
        return authStatus().googleOAuth;
    }

    function googleAuthUrl(req, state) {
        const clientId = env('GOOGLE_CLIENT_ID');
        const redirect = env('GOOGLE_REDIRECT_URI') || `${getPublicBaseUrl(req)}/api/auth/google/callback`;
        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirect,
            response_type: 'code',
            scope: 'openid email profile',
            access_type: 'online',
            prompt: 'select_account',
            state: state || ''
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    async function exchangeGoogleCode(code, req) {
        const clientId = env('GOOGLE_CLIENT_ID');
        const clientSecret = env('GOOGLE_CLIENT_SECRET');
        const redirect = env('GOOGLE_REDIRECT_URI') || `${getPublicBaseUrl(req)}/api/auth/google/callback`;
        const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirect,
                grant_type: 'authorization_code'
            })
        });
        if (!tokenResp.ok) {
            const t = await tokenResp.text().catch(() => '');
            throw new Error('Google token exchange failed: ' + t);
        }
        const tokens = await tokenResp.json();
        const uiResp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
            headers: { Authorization: 'Bearer ' + tokens.access_token }
        });
        if (!uiResp.ok) throw new Error('Google userinfo failed');
        const profile = await uiResp.json();
        return {
            google_id: profile.sub,
            email: profile.email,
            name: profile.name || profile.given_name || null,
            picture: profile.picture || null
        };
    }

    async function completeGoogleLogin(code, deviceId, res, req) {
        const status = authStatus();
        if (!status.ready) return { ok: false, error: 'Auth not configured (DATABASE_URL / SESSION_SECRET).', status };
        if (!status.googleOAuth) return { ok: false, error: 'Google OAuth disabled until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.', status };
        const profile = await exchangeGoogleCode(code, req);
        const user = await upsertUserByGoogle(profile);
        await afterLogin(user, deviceId, res, req);
        return { ok: true, user: { id: user.id, email: user.email, name: user.name, picture: user.picture } };
    }

    // -------- Postgres chat CRUD (owner_key = deviceId or u_<userId>) --------
    async function listChats(ownerKey) {
        const p = getPool();
        if (!p || !(await ensureSchema())) return null; // signal fallback
        const r = await p.query(
            `SELECT chat_id AS id, name, created_at AS "createdAt", updated_at AS "updatedAt",
                    named, jsonb_array_length(messages) AS "messageCount"
             FROM chats WHERE owner_key = $1
             ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST`,
            [ownerKey]
        );
        return r.rows.map((row) => ({
            id: row.id,
            name: row.name || 'New Chat',
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            named: !!row.named,
            messageCount: Number(row.messageCount) || 0
        }));
    }

    async function getChat(ownerKey, chatId) {
        const p = getPool();
        if (!p || !(await ensureSchema())) return null;
        const r = await p.query(
            `SELECT chat_id AS id, name, messages, created_at AS "createdAt", updated_at AS "updatedAt",
                    named, custom_instructions AS "customInstructions", system_prompt AS "systemPrompt"
             FROM chats WHERE owner_key = $1 AND chat_id = $2`,
            [ownerKey, chatId]
        );
        if (!r.rows[0]) return undefined; // not found but pg ok
        const row = r.rows[0];
        return {
            id: row.id,
            name: row.name || 'New Chat',
            messages: Array.isArray(row.messages) ? row.messages : [],
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            named: !!row.named,
            customInstructions: row.customInstructions || '',
            systemPrompt: row.systemPrompt || ''
        };
    }

    async function upsertChat(ownerKey, chatId, chat) {
        const p = getPool();
        if (!p || !(await ensureSchema())) return false;
        await p.query(
            `INSERT INTO chats (owner_key, chat_id, name, messages, created_at, updated_at, named, custom_instructions, system_prompt)
             VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)
             ON CONFLICT (owner_key, chat_id) DO UPDATE SET
               name = EXCLUDED.name,
               messages = EXCLUDED.messages,
               updated_at = EXCLUDED.updated_at,
               named = EXCLUDED.named,
               custom_instructions = EXCLUDED.custom_instructions,
               system_prompt = EXCLUDED.system_prompt,
               created_at = COALESCE(chats.created_at, EXCLUDED.created_at)`,
            [
                ownerKey,
                chatId,
                chat.name || 'New Chat',
                JSON.stringify(Array.isArray(chat.messages) ? chat.messages : []),
                chat.createdAt || new Date().toISOString(),
                chat.updatedAt || new Date().toISOString(),
                !!chat.named,
                chat.customInstructions || '',
                chat.systemPrompt || ''
            ]
        );
        return true;
    }

    async function deleteChat(ownerKey, chatId) {
        const p = getPool();
        if (!p || !(await ensureSchema())) return false;
        await p.query('DELETE FROM chats WHERE owner_key = $1 AND chat_id = $2', [ownerKey, chatId]);
        return true;
    }

    function ownerKeyForRequest(req, deviceId) {
        const user = readUserFromReq(req);
        if (user && user.id) return 'u_' + user.id;
        return deviceId || null;
    }

    return {
        SESSION_COOKIE,
        authStatus,
        getPool,
        ensureSchema,
        readUserFromReq,
        setSessionCookie,
        clearSessionCookie,
        createMagicLink,
        consumeMagicLink,
        googleConfigured,
        googleAuthUrl,
        completeGoogleLogin,
        afterLogin,
        mergeDeviceChatsToUser,
        linkDevice,
        listChats,
        getChat,
        upsertChat,
        deleteChat,
        ownerKeyForRequest,
        getPublicBaseUrl
    };
}

module.exports = { createAuth, authStatus, SESSION_COOKIE };
