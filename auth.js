/**
 * Auth: email 6-digit OTP (Resend) + Google OAuth + signed session cookies.
 * Requires DATABASE_URL + SESSION_SECRET for sessions/users.
 * Google stays disabled until GOOGLE_* keys; email OTP soft-disabled until RESEND_API_KEY (see AUTH_ENV.md).
 */
const crypto = require('crypto');
const { Pool } = require('pg');
const webpush = require('web-push');
const { renderBrandedEmail } = require('./mail');

const SESSION_COOKIE = 'gsa_session';
const SESSION_DAYS = 30;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

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
    // Soft-disable email OTP until Resend is configured (SMTP reserved/docs only).
    const resend = boolConfigured('RESEND_API_KEY');
    const emailOtp = resend;
    return {
        database,
        sessionSecret,
        googleOAuth: google,
        emailOtp,
        magicLink: false, // legacy field; email auth is OTP-only now
        emailTransport: resend ? 'resend' : null,
        ready: database && sessionSecret,
        liveLoginBlockedBy: [
            !database && 'DATABASE_URL',
            !sessionSecret && 'SESSION_SECRET',
            !google && !emailOtp && 'GOOGLE_CLIENT_ID+GOOGLE_CLIENT_SECRET or RESEND_API_KEY'
        ].filter(Boolean)
    };
}

async function authStatusWithHealth(getPool) {
    const status = authStatus();
    if (!status.database) {
        status.databaseAvailable = null;
        status.ready = false;
        return status;
    }
    try {
        const p = getPool();
        if (!p) throw new Error('Database connection is not configured');
        await p.query('SELECT 1');
        status.databaseAvailable = true;
    } catch (e) {
        status.databaseAvailable = false;
        status.ready = false;
        if (!status.liveLoginBlockedBy.includes('DATABASE_UNAVAILABLE')) {
            status.liveLoginBlockedBy.push('DATABASE_UNAVAILABLE');
        }
        console.error('Auth database health check failed:', e.message);
    }
    return status;
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
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 5000
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
                    CREATE TABLE IF NOT EXISTS email_otps (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        email TEXT NOT NULL,
                        code_hash TEXT NOT NULL,
                        device_id TEXT,
                        expires_at TIMESTAMPTZ NOT NULL,
                        used_at TIMESTAMPTZ,
                        attempts INT NOT NULL DEFAULT 0,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS device_links (
                        device_id TEXT PRIMARY KEY,
                        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS user_notifications (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        title TEXT NOT NULL,
                        message TEXT NOT NULL,
                        category TEXT NOT NULL DEFAULT 'announcement',
                        dedupe_key TEXT NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        read_at TIMESTAMPTZ,
                        UNIQUE(user_id, dedupe_key)
                    );
                    CREATE INDEX IF NOT EXISTS user_notifications_recent_idx
                        ON user_notifications(user_id, created_at DESC);
                    CREATE TABLE IF NOT EXISTS user_notification_preferences (
                        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                        email_announcements BOOLEAN NOT NULL DEFAULT FALSE,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS user_push_subscriptions (
                        id BIGSERIAL PRIMARY KEY,
                        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        endpoint TEXT NOT NULL UNIQUE,
                        subscription JSONB NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE INDEX IF NOT EXISTS user_push_subscriptions_user_idx ON user_push_subscriptions(user_id);
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
                        rolling_summary TEXT DEFAULT '',
                        summary_message_count INT NOT NULL DEFAULT 0,
                        project_id TEXT DEFAULT NULL,
                        PRIMARY KEY (owner_key, chat_id)
                    );
                    CREATE TABLE IF NOT EXISTS user_projects (
                        owner_key TEXT NOT NULL,
                        project_id TEXT NOT NULL,
                        name TEXT NOT NULL,
                        instructions TEXT NOT NULL DEFAULT '',
                        color TEXT NOT NULL DEFAULT '#d4af37',
                        icon TEXT NOT NULL DEFAULT '📁',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (owner_key, project_id)
                    );
                    CREATE TABLE IF NOT EXISTS studio_projects (
                        owner_key TEXT NOT NULL,
                        project_id TEXT NOT NULL,
                        name TEXT NOT NULL,
                        instructions TEXT NOT NULL DEFAULT '',
                        color TEXT NOT NULL DEFAULT '#d4af37',
                        icon TEXT NOT NULL DEFAULT '📁',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (owner_key, project_id)
                    );
                    CREATE TABLE IF NOT EXISTS studio_project_chats (
                        owner_key TEXT NOT NULL,
                        project_id TEXT NOT NULL,
                        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
                        pending JSONB DEFAULT NULL,
                        artifact JSONB DEFAULT NULL,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (owner_key, project_id),
                        CONSTRAINT studio_project_chats_project_fk
                            FOREIGN KEY (owner_key, project_id)
                            REFERENCES studio_projects(owner_key, project_id) ON DELETE CASCADE
                    );
                    CREATE TABLE IF NOT EXISTS studio_project_threads (
                        owner_key TEXT NOT NULL,
                        project_id TEXT NOT NULL,
                        chat_id TEXT NOT NULL,
                        title TEXT NOT NULL DEFAULT 'New Studio chat',
                        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
                        pending JSONB DEFAULT NULL,
                        artifact JSONB DEFAULT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (owner_key, project_id, chat_id),
                        CONSTRAINT studio_project_threads_project_fk
                            FOREIGN KEY (owner_key, project_id)
                            REFERENCES studio_projects(owner_key, project_id) ON DELETE CASCADE
                    );
                    CREATE INDEX IF NOT EXISTS studio_project_threads_updated_idx
                        ON studio_project_threads(owner_key, project_id, updated_at DESC);
                    CREATE TABLE IF NOT EXISTS user_memory (
                        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                        facts JSONB NOT NULL DEFAULT '{}'::jsonb,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE INDEX IF NOT EXISTS idx_chats_owner_updated ON chats (owner_key, updated_at DESC);
                    CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links (email);
                    CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps (email);
                `);
                // Additive migrations for existing DBs
                try { await client.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS rolling_summary TEXT DEFAULT ''`); } catch (_) {}
                try { await client.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS summary_message_count INT NOT NULL DEFAULT 0`); } catch (_) {}
                try { await client.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS project_id TEXT DEFAULT NULL`); } catch (_) {}
                try { await client.query(`ALTER TABLE user_projects ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#d4af37'`); } catch (_) {}
                try { await client.query(`ALTER TABLE user_projects ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT '📁'`); } catch (_) {}
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

    /**
     * Same normalized email always maps to one user row (OTP + Google merge).
     * Google login with an email that already used OTP reuses that account (and chats under u_<id>).
     */
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
    /** Ensure jsonb bind params are valid JSON text (node-pg objects can become invalid input). */
    function jsonbParam(value) {
        if (value == null) return '[]';
        if (typeof value === 'string') {
            try {
                JSON.parse(value);
                return value;
            } catch (_) {
                return JSON.stringify([]);
            }
        }
        try {
            return JSON.stringify(value);
        } catch (_) {
            return '[]';
        }
    }

    function tsIso(value) {
        if (!value) return null;
        try {
            const d = value instanceof Date ? value : new Date(value);
            if (Number.isNaN(d.getTime())) return typeof value === 'string' ? value : null;
            return d.toISOString();
        } catch (_) {
            return typeof value === 'string' ? value : null;
        }
    }

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
                const messagesJson = jsonbParam(row.messages);
                const existing = await client.query(
                    'SELECT chat_id, updated_at FROM chats WHERE owner_key = $1 AND chat_id = $2',
                    [userKey, row.chat_id]
                );
                if (!existing.rows[0]) {
                    await client.query(
                        `INSERT INTO chats (owner_key, chat_id, name, messages, created_at, updated_at, named, custom_instructions, system_prompt, rolling_summary, summary_message_count)
                         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)`,
                        [userKey, row.chat_id, row.name, messagesJson, row.created_at, row.updated_at, row.named, row.custom_instructions, row.system_prompt, row.rolling_summary || '', Number(row.summary_message_count) || 0]
                    );
                    merged += 1;
                } else {
                    const remoteTs = String(row.updated_at || '');
                    const localTs = String(existing.rows[0].updated_at || '');
                    if (remoteTs > localTs) {
                        await client.query(
                            `UPDATE chats SET name=$3, messages=$4::jsonb, created_at=$5, updated_at=$6, named=$7,
                              custom_instructions=$8, system_prompt=$9, rolling_summary=$10, summary_message_count=$11
                             WHERE owner_key=$1 AND chat_id=$2`,
                            [userKey, row.chat_id, row.name, messagesJson, row.created_at, row.updated_at, row.named, row.custom_instructions, row.system_prompt, row.rolling_summary || '', Number(row.summary_message_count) || 0]
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

    /** Recover chats stuck under any device_id previously linked to this account. */
    async function mergeAllLinkedDeviceChats(userId) {
        if (!userId) return { merged: 0, devices: 0 };
        const p = getPool();
        if (!p || !(await ensureSchema())) return { merged: 0, devices: 0 };
        const links = await p.query('SELECT device_id FROM device_links WHERE user_id = $1', [userId]);
        let merged = 0;
        for (const row of links.rows) {
            try {
                const r = await mergeDeviceChatsToUser(row.device_id, userId);
                merged += Number(r && r.merged) || 0;
            } catch (e) {
                console.error('mergeAllLinkedDeviceChats:', e.message);
            }
        }
        return { merged, devices: links.rows.length };
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
        // Repair: pull any chats still stuck under previously linked device keys.
        try { await mergeAllLinkedDeviceChats(user.id); } catch (e) { console.error('merge linked:', e.message); }
        setSessionCookie(res, user, req);
        // Separate login alert (not OTP). Never blocks session creation.
        const alertEmail = user && user.email ? String(user.email).trim().toLowerCase() : '';
        if (alertEmail) {
            sendLoginAlertEmail(alertEmail).catch((e) => console.error('login alert email:', e.message));
        }
        return user;
    }

    function generateOtpCode() {
        return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    }

    function hashOtpCode(email, code) {
        const norm = String(email || '').trim().toLowerCase();
        return crypto.createHash('sha256').update(`${norm}:${String(code || '').trim()}`).digest('hex');
    }

    async function sendOtpEmail(to, code) {
        const status = authStatus();
        if (!status.emailOtp) {
            return { ok: false, error: 'Email login is not configured. Set RESEND_API_KEY.' };
        }
        const subject = 'GoldenSpaceAI login code';
        const text = `Your GoldenSpaceAI sign-in code is: ${code}\n\nThis code expires in 10 minutes. Never share it with anyone. If you did not request it, you can ignore this email.\n\nGoldenSpaceAI Support`;
        const html = renderBrandedEmail({
            preheader: 'Your secure sign-in code is ready.',
            title: 'Sign in to GoldenSpaceAI',
            paragraphs: ['Enter this code on the sign-in page to continue.', 'It expires in 10 minutes. Never share it with anyone, including GoldenSpaceAI staff. If you did not request it, you can ignore this email.'],
            status: { label: 'Sign-in verification', tone: 'neutral' },
            details: [{ label: 'Your sign-in code', value: code, kind: 'code' }],
            footer: 'This one-time code can only be used once.'
        });

        const from = emailFromAddress();
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

    function emailFromAddress() {
        return env('EMAIL_FROM') || env('MAGIC_LINK_FROM') || env('SMTP_FROM') || 'GoldenSpaceAI <onboarding@resend.dev>';
    }

    /**
     * Separate new-login alert via Resend (not the OTP code email).
     * Only when RESEND_API_KEY is set and recipient has an email.
     */
    async function sendLoginAlertEmail(to) {
        if (!env('RESEND_API_KEY')) {
            return { ok: false, skipped: true, error: 'RESEND_API_KEY not set' };
        }
        const norm = String(to || '').trim().toLowerCase();
        if (!norm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) {
            return { ok: false, skipped: true, error: 'No email' };
        }
        const when = new Intl.DateTimeFormat('en-US', {
            dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Beirut'
        }).format(new Date()) + ' Beirut time';
        const subject = 'New sign-in to your GoldenSpaceAI account';
        const text =
            `A new sign-in to your GoldenSpaceAI account was detected.\n\n` +
            `Time: ${when}\n\n` +
            `If this was you, no action is needed. If you do not recognize this sign-in, secure your email account and contact support.\n\n` +
            `GoldenSpaceAI Support`;
        const html = renderBrandedEmail({
            preheader: 'A new sign-in to your account was detected.',
            title: 'New sign-in to your account',
            paragraphs: ['A new sign-in to your GoldenSpaceAI account was detected.', 'If this was you, no action is needed. If you do not recognize this sign-in, secure your email account and contact support.'],
            status: { label: 'Account security notice', tone: 'warning' },
            details: [{ label: 'Time', value: when }],
            action: { label: 'Open GoldenSpaceAI', url: 'https://www.goldenspaceai.space/' },
            footer: 'This security notice is sent when a new sign-in is detected.'
        });
        const from = emailFromAddress();
        const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + env('RESEND_API_KEY'),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ from, to: [norm], subject, html, text })
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.error('Resend login-alert error:', resp.status, body);
            return { ok: false, error: 'Failed to send login alert via Resend.' };
        }
        return { ok: true };
    }

    async function requestEmailOtp({ email, deviceId }) {
        const status = authStatus();
        if (!status.ready) {
            return { ok: false, error: 'Auth storage not ready. Set DATABASE_URL and SESSION_SECRET.', status };
        }
        if (!status.emailOtp) {
            return { ok: false, error: 'Email login disabled until RESEND_API_KEY is set.', status };
        }
        const norm = String(email || '').trim().toLowerCase();
        if (!norm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) {
            return { ok: false, error: 'Valid email required.' };
        }
        const p = getPool();
        await ensureSchema();
        const code = generateOtpCode();
        const codeHash = hashOtpCode(norm, code);
        const expires = new Date(Date.now() + OTP_TTL_MS);
        // Invalidate prior unused codes for this email
        await p.query(
            `UPDATE email_otps SET used_at = NOW() WHERE email = $1 AND used_at IS NULL`,
            [norm]
        );
        await p.query(
            `INSERT INTO email_otps (email, code_hash, device_id, expires_at) VALUES ($1,$2,$3,$4)`,
            [norm, codeHash, deviceId || null, expires.toISOString()]
        );
        const sent = await sendOtpEmail(norm, code);
        if (!sent.ok) return { ok: false, error: sent.error, status };
        return { ok: true, message: 'Check your email for a 6-digit code.', status };
    }

    async function verifyEmailOtp({ email, code, deviceId, res, req }) {
        const status = authStatus();
        if (!status.ready) return { ok: false, error: 'Auth not configured.', status };
        if (!status.emailOtp) {
            return { ok: false, error: 'Email login disabled until RESEND_API_KEY is set.', status };
        }
        const norm = String(email || '').trim().toLowerCase();
        const rawCode = String(code || '').trim().replace(/\s+/g, '');
        if (!norm || !/^\d{6}$/.test(rawCode)) {
            return { ok: false, error: 'Enter your email and the 6-digit code.' };
        }
        const p = getPool();
        await ensureSchema();
        const r = await p.query(
            `SELECT * FROM email_otps
             WHERE email = $1 AND used_at IS NULL
             ORDER BY created_at DESC LIMIT 1`,
            [norm]
        );
        const row = r.rows[0];
        if (!row || new Date(row.expires_at).getTime() < Date.now()) {
            return { ok: false, error: 'Invalid or expired code. Request a new one.' };
        }
        if (Number(row.attempts) >= OTP_MAX_ATTEMPTS) {
            await p.query('UPDATE email_otps SET used_at = NOW() WHERE id = $1', [row.id]);
            return { ok: false, error: 'Too many attempts. Request a new code.' };
        }
        const expected = hashOtpCode(norm, rawCode);
        const a = Buffer.from(String(row.code_hash));
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            await p.query('UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1', [row.id]);
            return { ok: false, error: 'Incorrect code.' };
        }
        await p.query('UPDATE email_otps SET used_at = NOW() WHERE id = $1', [row.id]);
        const user = await upsertUserByEmail(norm);
        const useDevice = deviceId || row.device_id;
        await afterLogin(user, useDevice, res, req);
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
                    named, project_id AS "projectId", jsonb_array_length(messages) AS "messageCount"
             FROM chats WHERE owner_key = $1
             ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST`,
            [ownerKey]
        );
        return r.rows.map((row) => ({
            id: row.id,
            name: row.name || 'New Chat',
            createdAt: tsIso(row.createdAt),
            updatedAt: tsIso(row.updatedAt),
            named: !!row.named,
            projectId: row.projectId || null,
            messageCount: Number(row.messageCount) || 0
        }));
    }

    async function getChat(ownerKey, chatId) {
        const p = getPool();
        if (!p || !(await ensureSchema())) return null;
        const r = await p.query(
            `SELECT chat_id AS id, name, messages, created_at AS "createdAt", updated_at AS "updatedAt",
                    named, custom_instructions AS "customInstructions", system_prompt AS "systemPrompt",
                    rolling_summary AS "rollingSummary", summary_message_count AS "summaryMessageCount", project_id AS "projectId"
             FROM chats WHERE owner_key = $1 AND chat_id = $2`,
            [ownerKey, chatId]
        );
        if (!r.rows[0]) return undefined; // not found but pg ok
        const row = r.rows[0];
        return {
            id: row.id,
            name: row.name || 'New Chat',
            messages: Array.isArray(row.messages) ? row.messages : [],
            createdAt: tsIso(row.createdAt),
            updatedAt: tsIso(row.updatedAt),
            named: !!row.named,
            customInstructions: row.customInstructions || '',
            systemPrompt: row.systemPrompt || '',
            rollingSummary: row.rollingSummary || '',
            summaryMessageCount: Number(row.summaryMessageCount) || 0,
            projectId: row.projectId || null
        };
    }

    async function upsertChat(ownerKey, chatId, chat) {
        const p = getPool();
        if (!p || !(await ensureSchema())) return false;
        const rollingSummary = chat.rollingSummary != null ? String(chat.rollingSummary) : '';
        const summaryMessageCount = Math.max(0, Number(chat.summaryMessageCount) || 0);
        await p.query(
            `INSERT INTO chats (owner_key, chat_id, name, messages, created_at, updated_at, named, custom_instructions, system_prompt, rolling_summary, summary_message_count, project_id)
             VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (owner_key, chat_id) DO UPDATE SET
               name = EXCLUDED.name,
               messages = EXCLUDED.messages,
               updated_at = EXCLUDED.updated_at,
               named = EXCLUDED.named,
               custom_instructions = EXCLUDED.custom_instructions,
               system_prompt = EXCLUDED.system_prompt,
               rolling_summary = EXCLUDED.rolling_summary,
               summary_message_count = EXCLUDED.summary_message_count,
               project_id = EXCLUDED.project_id,
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
                chat.systemPrompt || '',
                rollingSummary,
                summaryMessageCount,
                chat.projectId || null
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


    async function getUserMemory(userId) {
        const p = getPool();
        if (!p || !userId || !(await ensureSchema())) return { facts: {}, updatedAt: null };
        const r = await p.query(
            `SELECT facts, updated_at AS "updatedAt" FROM user_memory WHERE user_id = $1`,
            [userId]
        );
        if (!r.rows[0]) return { facts: {}, updatedAt: null };
        const facts = r.rows[0].facts && typeof r.rows[0].facts === 'object' && !Array.isArray(r.rows[0].facts)
            ? r.rows[0].facts
            : {};
        return { facts, updatedAt: tsIso(r.rows[0].updatedAt) };
    }

    async function setUserMemory(userId, facts) {
        const p = getPool();
        if (!p || !userId || !(await ensureSchema())) return false;
        const clean = facts && typeof facts === 'object' && !Array.isArray(facts) ? facts : {};
        await p.query(
            `INSERT INTO user_memory (user_id, facts, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (user_id) DO UPDATE SET facts = EXCLUDED.facts, updated_at = NOW()`,
            [userId, JSON.stringify(clean)]
        );
        return true;
    }

    async function clearUserMemory(userId) {
        const p = getPool();
        if (!p || !userId || !(await ensureSchema())) return false;
        await p.query('DELETE FROM user_memory WHERE user_id = $1', [userId]);
        return true;
    }

    async function patchUserMemory(userId, patch) {
        const current = await getUserMemory(userId);
        const facts = Object.assign({}, current.facts || {});
        if (patch && typeof patch === 'object') {
            for (const [k, v] of Object.entries(patch)) {
                const key = String(k || '').trim().slice(0, 64);
                if (!key) continue;
                if (v == null || v === '') delete facts[key];
                else facts[key] = String(v).trim().slice(0, 160);
            }
        }
        await setUserMemory(userId, facts);
        return { facts };
    }

    async function updateChatSummary(ownerKey, chatId, summary, summarizedCount) {
        const p = getPool();
        if (!p || !ownerKey || !chatId || !(await ensureSchema())) return false;
        await p.query(
            `UPDATE chats SET rolling_summary = $3, summary_message_count = $4, updated_at = COALESCE(updated_at, NOW())
             WHERE owner_key = $1 AND chat_id = $2`,
            [ownerKey, chatId, String(summary || ''), Math.max(0, Number(summarizedCount) || 0)]
        );
        return true;
    }

    /**
     * Admin read-only: accounts + linked devices from Postgres.
     * No last-login IP/UA is stored on users today.
     */
    function pushConfigured() {
        return !!(env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY'));
    }

    function configureWebPush() {
        if (!pushConfigured()) return false;
        try {
            webpush.setVapidDetails(env('VAPID_SUBJECT') || 'mailto:support@goldenspaceai.space', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
            return true;
        } catch (error) {
            console.error('Web push configuration failed:', error.message);
            return false;
        }
    }

    async function savePushSubscription(userId, subscription) {
        const p = getPool();
        const sub = subscription || {};
        if (!userId || !p || !(await ensureSchema())) return { ok: false, error: 'Push notifications are unavailable.' };
        if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { ok: false, error: 'Invalid device subscription.' };
        await p.query(
            `INSERT INTO user_push_subscriptions (user_id, endpoint, subscription)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, subscription = EXCLUDED.subscription, updated_at = NOW()`,
            [String(userId), String(sub.endpoint), JSON.stringify(sub)]
        );
        return { ok: true };
    }

    async function removePushSubscription(userId, endpoint) {
        const p = getPool();
        if (!userId || !p || !endpoint || !(await ensureSchema())) return { ok: false };
        await p.query('DELETE FROM user_push_subscriptions WHERE user_id = $1 AND endpoint = $2', [String(userId), String(endpoint)]);
        return { ok: true };
    }

    async function sendPushToUser(userId, title, message, url) {
        const p = getPool();
        if (!pushConfigured() || !configureWebPush() || !p || !(await ensureSchema())) return { ok: false, sent: 0 };
        const rows = await p.query('SELECT id, endpoint, subscription FROM user_push_subscriptions WHERE user_id = $1', [String(userId)]);
        let sent = 0;
        for (const row of rows.rows) {
            try {
                await webpush.sendNotification(row.subscription, JSON.stringify({ title: String(title).slice(0, 120), body: String(message).slice(0, 220), url: String(url || '/') }), { TTL: 86400 });
                sent++;
            } catch (error) {
                if (error.statusCode === 404 || error.statusCode === 410) await p.query('DELETE FROM user_push_subscriptions WHERE id = $1', [row.id]);
                else console.error('Web push delivery failed:', error.statusCode || error.message);
            }
        }
        return { ok: true, sent };
    }

    const PROJECT_COLORS = ['#d4af37', '#f97362', '#ec4899', '#a78bfa', '#6688ff', '#22b8a5', '#f0a340', '#8b9a7a'];
    const PROJECT_ICONS = ['📁', '🚀', '💡', '📚', '🎨', '🧪', '🌿', '⭐', '🎧', '📝'];
    function projectColor(value) {
        const color = String(value || '').trim().toLowerCase();
        return PROJECT_COLORS.includes(color) ? color : PROJECT_COLORS[0];
    }
    function projectIcon(value) {
        const icon = String(value || '').trim();
        return PROJECT_ICONS.includes(icon) ? icon : PROJECT_ICONS[0];
    }

    async function listProjects(ownerKey) {
        const p = getPool();
        if (!ownerKey || !p || !(await ensureSchema())) return [];
        const r = await p.query(
            `SELECT project_id AS id, name, instructions, color, icon, created_at AS "createdAt", updated_at AS "updatedAt"
             FROM user_projects WHERE owner_key = $1 ORDER BY updated_at DESC`,
            [String(ownerKey)]
        );
        return r.rows.map(row => ({ id: row.id, name: row.name, instructions: row.instructions || '', color: projectColor(row.color), icon: projectIcon(row.icon), createdAt: tsIso(row.createdAt), updatedAt: tsIso(row.updatedAt) }));
    }

    async function createProject(ownerKey, project) {
        const p = getPool();
        if (!ownerKey || !p || !(await ensureSchema())) return { ok: false, error: 'Projects are unavailable.' };
        const item = project || {};
        const id = String(item.id || ('project_' + crypto.randomUUID())).slice(0, 100);
        const name = String(item.name || '').trim().slice(0, 100);
        const instructions = String(item.instructions || '').trim().slice(0, 8000);
        const color = projectColor(item.color);
        const icon = projectIcon(item.icon);
        if (!name) return { ok: false, error: 'Add a project name.' };
        const r = await p.query(
            `INSERT INTO user_projects (owner_key, project_id, name, instructions, color, icon)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING project_id AS id, name, instructions, color, icon, created_at AS "createdAt", updated_at AS "updatedAt"`,
            [String(ownerKey), id, name, instructions, color, icon]
        );
        const row = r.rows[0];
        return { ok: true, project: { id: row.id, name: row.name, instructions: row.instructions || '', color: projectColor(row.color), icon: projectIcon(row.icon), createdAt: tsIso(row.createdAt), updatedAt: tsIso(row.updatedAt) } };
    }

    async function updateProject(ownerKey, projectId, project) {
        const p = getPool();
        if (!ownerKey || !p || !(await ensureSchema())) return { ok: false, error: 'Projects are unavailable.' };
        const item = project || {};
        const name = String(item.name || '').trim().slice(0, 100);
        const instructions = String(item.instructions || '').trim().slice(0, 8000);
        const color = projectColor(item.color);
        const icon = projectIcon(item.icon);
        if (!name) return { ok: false, error: 'Add a project name.' };
        const r = await p.query(
            `UPDATE user_projects SET name=$3, instructions=$4, color=$5, icon=$6, updated_at=NOW()
             WHERE owner_key=$1 AND project_id=$2
             RETURNING project_id AS id, name, instructions, color, icon, created_at AS "createdAt", updated_at AS "updatedAt"`,
            [String(ownerKey), String(projectId), name, instructions, color, icon]
        );
        if (!r.rows[0]) return { ok: false, error: 'Project not found.' };
        const row = r.rows[0];
        return { ok: true, project: { id: row.id, name: row.name, instructions: row.instructions || '', color: projectColor(row.color), icon: projectIcon(row.icon), createdAt: tsIso(row.createdAt), updatedAt: tsIso(row.updatedAt) } };
    }

    async function deleteProject(ownerKey, projectId) {
        const p = getPool();
        if (!ownerKey || !p || !(await ensureSchema())) return { ok: false, error: 'Projects are unavailable.' };
        const client = await p.connect();
        try {
            await client.query('BEGIN');
            await client.query('UPDATE chats SET project_id = NULL WHERE owner_key=$1 AND project_id=$2', [String(ownerKey), String(projectId)]);
            const r = await client.query('DELETE FROM user_projects WHERE owner_key=$1 AND project_id=$2', [String(ownerKey), String(projectId)]);
            await client.query('COMMIT');
            return { ok: true, deleted: r.rowCount > 0 };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally { client.release(); }
    }

    async function listStudioProjects(ownerKey) {
        const p = getPool();
        if (!ownerKey || !p || !(await ensureSchema())) return [];
        const r = await p.query(
            `SELECT project_id AS id, name, instructions, color, icon, created_at AS "createdAt", updated_at AS "updatedAt"
             FROM studio_projects WHERE owner_key = $1 ORDER BY updated_at DESC`,
            [String(ownerKey)]
        );
        return r.rows.map(row => ({ id: row.id, name: row.name, instructions: row.instructions || '', color: projectColor(row.color), icon: projectIcon(row.icon), createdAt: tsIso(row.createdAt), updatedAt: tsIso(row.updatedAt) }));
    }

    async function createStudioProject(ownerKey, project) {
        const p = getPool();
        if (!ownerKey || !p || !(await ensureSchema())) return { ok: false, error: 'Studio projects are unavailable.' };
        const item = project || {};
        const id = String(item.id || ('studio_project_' + crypto.randomUUID())).slice(0, 100);
        const name = String(item.name || '').trim().slice(0, 100);
        const instructions = String(item.instructions || '').trim().slice(0, 8000);
        const color = projectColor(item.color);
        const icon = projectIcon(item.icon);
        if (!name) return { ok: false, error: 'Add a project name.' };
        const r = await p.query(
            `INSERT INTO studio_projects (owner_key, project_id, name, instructions, color, icon)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING project_id AS id, name, instructions, color, icon, created_at AS "createdAt", updated_at AS "updatedAt"`,
            [String(ownerKey), id, name, instructions, color, icon]
        );
        const row = r.rows[0];
        return { ok: true, project: { id: row.id, name: row.name, instructions: row.instructions || '', color: projectColor(row.color), icon: projectIcon(row.icon), createdAt: tsIso(row.createdAt), updatedAt: tsIso(row.updatedAt) } };
    }

    async function updateStudioProject(ownerKey, projectId, project) {
        const p = getPool();
        if (!ownerKey || !p || !(await ensureSchema())) return { ok: false, error: 'Studio projects are unavailable.' };
        const item = project || {};
        const name = String(item.name || '').trim().slice(0, 100);
        const instructions = String(item.instructions || '').trim().slice(0, 8000);
        const color = projectColor(item.color);
        const icon = projectIcon(item.icon);
        if (!name) return { ok: false, error: 'Add a project name.' };
        const r = await p.query(
            `UPDATE studio_projects SET name=$3, instructions=$4, color=$5, icon=$6, updated_at=NOW()
             WHERE owner_key=$1 AND project_id=$2
             RETURNING project_id AS id, name, instructions, color, icon, created_at AS "createdAt", updated_at AS "updatedAt"`,
            [String(ownerKey), String(projectId), name, instructions, color, icon]
        );
        if (!r.rows[0]) return { ok: false, error: 'Studio project not found.' };
        const row = r.rows[0];
        return { ok: true, project: { id: row.id, name: row.name, instructions: row.instructions || '', color: projectColor(row.color), icon: projectIcon(row.icon), createdAt: tsIso(row.createdAt), updatedAt: tsIso(row.updatedAt) } };
    }

    async function deleteStudioProject(ownerKey, projectId) {
        const p = getPool();
        if (!ownerKey || !p || !(await ensureSchema())) return { ok: false, error: 'Studio projects are unavailable.' };
        const r = await p.query('DELETE FROM studio_projects WHERE owner_key=$1 AND project_id=$2', [String(ownerKey), String(projectId)]);
        return { ok: true, deleted: r.rowCount > 0 };
    }

    async function listStudioProjectChats(ownerKey, projectId) {
        const p=getPool(); if(!ownerKey||!projectId||!p||!(await ensureSchema())) return [];
        const r=await p.query(`SELECT chat_id AS id,title,created_at AS "createdAt",updated_at AS "updatedAt"
          FROM studio_project_threads WHERE owner_key=$1 AND project_id=$2 ORDER BY updated_at DESC`,[String(ownerKey),String(projectId)]);
        return r.rows.map(x=>({id:x.id,title:x.title||'New Studio chat',createdAt:tsIso(x.createdAt),updatedAt:tsIso(x.updatedAt)}));
    }
    async function createStudioProjectChat(ownerKey, projectId, item) {
        const p=getPool(); if(!ownerKey||!projectId||!p||!(await ensureSchema())) return {ok:false,error:'Studio chat storage is unavailable.'};
        const project=await p.query('SELECT 1 FROM studio_projects WHERE owner_key=$1 AND project_id=$2',[String(ownerKey),String(projectId)]);
        if(!project.rowCount) return {ok:false,error:'Studio project not found.'};
        const count=await p.query('SELECT COUNT(*)::int AS n FROM studio_project_threads WHERE owner_key=$1 AND project_id=$2',[String(ownerKey),String(projectId)]);
        if(Number(count.rows[0]?.n||0)>=10) return {ok:false,error:'Each Studio project can contain up to 10 chats.'};
        const chatId=String(item?.id||('studio_chat_'+crypto.randomUUID())).slice(0,100);
        const title=String(item?.title||'New Studio chat').trim().slice(0,100)||'New Studio chat';
        const r=await p.query(`INSERT INTO studio_project_threads(owner_key,project_id,chat_id,title)
          VALUES($1,$2,$3,$4) RETURNING chat_id AS id,title,created_at AS "createdAt",updated_at AS "updatedAt"`,[String(ownerKey),String(projectId),chatId,title]);
        const x=r.rows[0]; return {ok:true,chat:{id:x.id,title:x.title,createdAt:tsIso(x.createdAt),updatedAt:tsIso(x.updatedAt)}};
    }
    async function getStudioProjectChat(ownerKey, projectId, chatId) {
        const p=getPool(); if(!ownerKey||!projectId||!p||!(await ensureSchema())) return null;
        if(chatId){
          const r=await p.query(`SELECT messages,pending,artifact,updated_at AS "updatedAt" FROM studio_project_threads WHERE owner_key=$1 AND project_id=$2 AND chat_id=$3`,[String(ownerKey),String(projectId),String(chatId)]);
          if(!r.rows[0]) return null; const x=r.rows[0]; return {messages:Array.isArray(x.messages)?x.messages:[],pending:x.pending||null,currentArtifact:x.artifact||null,updatedAt:tsIso(x.updatedAt)};
        }
        const legacy=await p.query(`SELECT messages,pending,artifact,updated_at AS "updatedAt" FROM studio_project_chats WHERE owner_key=$1 AND project_id=$2`,[String(ownerKey),String(projectId)]);
        if(!legacy.rows[0]) return null; const x=legacy.rows[0]; return {messages:Array.isArray(x.messages)?x.messages:[],pending:x.pending||null,currentArtifact:x.artifact||null,updatedAt:tsIso(x.updatedAt)};
    }
    async function saveStudioProjectChat(ownerKey, projectId, chat, chatId) {
        const p=getPool(); if(!ownerKey||!projectId||!p||!(await ensureSchema())) return {ok:false,error:'Studio chat storage is unavailable.'};
        const item=chat||{}, messages=Array.isArray(item.messages)?item.messages.slice(-120):[], pending=item.pending||null, artifact=item.currentArtifact||null;
        const project=await p.query('SELECT 1 FROM studio_projects WHERE owner_key=$1 AND project_id=$2',[String(ownerKey),String(projectId)]);
        if(!project.rowCount) return {ok:false,error:'Studio project not found.'};
        if(!chatId) { const legacy=await p.query(`INSERT INTO studio_project_chats(owner_key,project_id,messages,pending,artifact,updated_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,NOW()) ON CONFLICT(owner_key,project_id) DO UPDATE SET messages=EXCLUDED.messages,pending=EXCLUDED.pending,artifact=EXCLUDED.artifact,updated_at=NOW() RETURNING updated_at AS "updatedAt"`,[String(ownerKey),String(projectId),JSON.stringify(messages),JSON.stringify(pending),JSON.stringify(artifact)]); return {ok:true,updatedAt:tsIso(legacy.rows[0]?.updatedAt)}; }
        const r=await p.query(`UPDATE studio_project_threads SET messages=$4::jsonb,pending=$5::jsonb,artifact=$6::jsonb,updated_at=NOW() WHERE owner_key=$1 AND project_id=$2 AND chat_id=$3 RETURNING updated_at AS "updatedAt"`,[String(ownerKey),String(projectId),String(chatId),JSON.stringify(messages),JSON.stringify(pending),JSON.stringify(artifact)]);
        return r.rows[0]?{ok:true,updatedAt:tsIso(r.rows[0].updatedAt)}:{ok:false,error:'Studio chat not found.'};
    }

    async function createNotification(userId, item) {
        const p = getPool();
        if (!userId || !p || !(await ensureSchema())) return { ok: false, error: 'Notifications are unavailable.' };
        const v = item || {};
        const title = String(v.title || 'GoldenSpaceAI update').trim().slice(0, 120);
        const message = String(v.message || '').trim().slice(0, 4000);
        const category = String(v.category || 'announcement').slice(0, 40);
        const dedupeKey = String(v.dedupeKey || crypto.randomUUID()).slice(0, 180);
        const result = await p.query(
            `INSERT INTO user_notifications (user_id, title, message, category, dedupe_key)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, dedupe_key) DO NOTHING
             RETURNING id, title, message, category, created_at, read_at`,
            [String(userId), title, message, category, dedupeKey]
        );
        if (result.rowCount > 0) {
            sendPushToUser(userId, title, message, '/').catch(error => console.error('Web push send:', error.message));
        }
        return { ok: true, created: result.rowCount > 0, notification: result.rows[0] || null };
    }

    async function listNotifications(userId, limit) {
        const p = getPool();
        if (!userId || !p || !(await ensureSchema())) return { ok: false, notifications: [] };
        const n = Math.max(1, Math.min(50, Number(limit) || 30));
        const result = await p.query(
            `SELECT id, title, message, category, created_at, read_at
             FROM user_notifications WHERE user_id = $1
             ORDER BY created_at DESC LIMIT $2`,
            [String(userId), n]
        );
        const notifications = result.rows.map(row => ({
            id: String(row.id), title: row.title, message: row.message, category: row.category,
            createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
            readAt: row.read_at ? new Date(row.read_at).toISOString() : null
        }));
        return { ok: true, notifications, unread: notifications.filter(x => !x.readAt).length };
    }

    async function markNotificationsRead(userId, ids) {
        const p = getPool();
        if (!userId || !p || !(await ensureSchema())) return { ok: false };
        const list = Array.isArray(ids) ? ids.map(String).slice(0, 50) : [];
        if (list.length) {
            await p.query(
                'UPDATE user_notifications SET read_at = NOW() WHERE user_id = $1 AND id = ANY($2::uuid[])',
                [String(userId), list]
            );
        } else {
            await p.query('UPDATE user_notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [String(userId)]);
        }
        return { ok: true };
    }

    async function getEmailAnnouncements(userId) {
        const p = getPool();
        if (!userId || !p || !(await ensureSchema())) return { ok: false, enabled: false };
        const result = await p.query('SELECT email_announcements FROM user_notification_preferences WHERE user_id = $1', [String(userId)]);
        return { ok: true, enabled: !!result.rows[0]?.email_announcements };
    }

    async function setEmailAnnouncements(userId, enabled) {
        const p = getPool();
        if (!userId || !p || !(await ensureSchema())) return { ok: false };
        await p.query(
            `INSERT INTO user_notification_preferences (user_id, email_announcements, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (user_id) DO UPDATE SET email_announcements = EXCLUDED.email_announcements, updated_at = NOW()`,
            [String(userId), !!enabled]
        );
        return { ok: true, enabled: !!enabled };
    }

    async function sendAccountNoticeEmail(userId, title, message, baseUrl) {
        if (!env('RESEND_API_KEY')) return { ok: false, skipped: true };
        const p = getPool();
        if (!userId || !p || !(await ensureSchema())) return { ok: false, skipped: true };
        const result = await p.query(`
            SELECT u.email FROM users u
            INNER JOIN user_notification_preferences pref ON pref.user_id = u.id AND pref.email_announcements = TRUE
            WHERE u.id = $1 AND u.email IS NOT NULL
            LIMIT 1
        `, [String(userId)]);
        const email = result.rows[0]?.email;
        if (!email) return { ok: true, skipped: true };
        const base = String(baseUrl || 'https://www.goldenspaceai.space').replace(/\/$/, '');
        const token = emailUnsubscribeToken(String(userId));
        const url = base + '/api/email/unsubscribe?uid=' + encodeURIComponent(String(userId)) + '&token=' + encodeURIComponent(token);
        const safe = text => String(text || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
        const safeTitle = String(title || 'GoldenSpaceAI usage update').slice(0, 120);
        const safeMessage = String(message || '').slice(0, 4000);
        const html = renderBrandedEmail({
            preheader: safeTitle,
            title: safeTitle,
            paragraphs: [safeMessage],
            status: { label: 'Account update', tone: 'neutral' },
            action: { label: 'Open GoldenSpaceAI', url: base + '/' },
            footer: 'This account notice was also saved in your GoldenSpaceAI notifications.',
            footerLink: { label: 'Unsubscribe from announcement emails', url: url }
        });
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + env('RESEND_API_KEY'), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: emailFromAddress(), to: [email], subject: safeTitle, html,
                text: safeTitle + '\n\n' + safeMessage + '\n\nUnsubscribe: ' + url,
                headers: { 'List-Unsubscribe': '<' + url + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
            }),
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) {
            console.error('Resend limit email failed:', response.status, await response.text().catch(() => ''));
            return { ok: false };
        }
        return { ok: true, skipped: false };
    }

    async function broadcastNotification(title, message, category) {
        const p = getPool();
        if (!p || !(await ensureSchema())) return { ok: false, sent: 0, error: 'Notifications are unavailable.' };
        const users = await p.query('SELECT id FROM users');
        const ids = users.rows.map(row => String(row.id));
        const dedupe = 'broadcast:' + crypto.randomUUID();
        let sent = 0;
        for (let i = 0; i < ids.length; i += 250) {
            const batch = ids.slice(i, i + 250);
            const result = await p.query(
                `INSERT INTO user_notifications (user_id, title, message, category, dedupe_key)
                 SELECT uid, $2, $3, $4, $5 FROM unnest($1::uuid[]) AS ids(uid)
                 ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
                [batch, String(title).slice(0, 120), String(message).slice(0, 4000), String(category || 'announcement'), dedupe]
            );
            sent += result.rowCount || 0;
        }
        if (sent) await Promise.all(ids.map(id => sendPushToUser(id, title, message, '/').catch(() => null)));
        return { ok: true, sent, recipients: ids.length };
    }

    function emailUnsubscribeToken(userId) {
        const secret = env('SESSION_SECRET');
        if (!secret || !userId) return '';
        return crypto.createHmac('sha256', secret).update('email-announcements:' + String(userId)).digest('hex');
    }

    async function unsubscribeEmailAnnouncements(userId, token) {
        const expected = emailUnsubscribeToken(userId);
        const supplied = String(token || '');
        if (!expected || !supplied || supplied.length !== expected.length ||
            !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return { ok: false };
        const result = await setEmailAnnouncements(userId, false);
        return { ok: !!result.ok };
    }

    async function sendAnnouncementEmails(title, message, baseUrl) {
        if (!env('RESEND_API_KEY')) return { ok: false, error: 'Email delivery is not configured (RESEND_API_KEY).' };
        const p = getPool();
        if (!p || !(await ensureSchema())) return { ok: false, error: 'Email recipients are unavailable.' };
        const users = await p.query(`
            SELECT u.id, u.email FROM users u
            INNER JOIN user_notification_preferences pref ON pref.user_id = u.id AND pref.email_announcements = TRUE
            WHERE u.email IS NOT NULL AND btrim(u.email) <> ''
            ORDER BY u.created_at
        `);
        const recipients = users.rows;
        const from = emailFromAddress();
        const base = String(baseUrl || 'https://www.goldenspaceai.space').replace(/\/$/, '');
        const safe = text => String(text || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
        const safeTitle = String(title || '').slice(0, 120);
        const safeMessage = String(message || '').slice(0, 4000);
        const htmlMessage = safe(safeMessage).replace(/\r?\n/g, '<br>');
        let sent = 0, failed = 0;
        for (let i = 0; i < recipients.length; i += 100) {
            const batch = recipients.slice(i, i + 100).map(user => {
                const uid = String(user.id);
                const token = emailUnsubscribeToken(uid);
                const url = base + '/api/email/unsubscribe?uid=' + encodeURIComponent(uid) + '&token=' + encodeURIComponent(token);
                return {
                    from, to: [user.email], subject: safeTitle,
                    html: renderBrandedEmail({
                        preheader: safeTitle,
                        title: safeTitle,
                        paragraphs: [safeMessage],
                        footer: 'You are receiving this account announcement because email announcements are enabled in your preferences.',
                        footerLink: { label: 'Unsubscribe from announcement emails', url: url }
                    }),
                    text: safeTitle + '\n\n' + safeMessage + '\n\nUnsubscribe: ' + url,
                    headers: { 'List-Unsubscribe': '<' + url + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
                };
            });
            try {
                const response = await fetch('https://api.resend.com/emails/batch', {
                    method: 'POST',
                    headers: { Authorization: 'Bearer ' + env('RESEND_API_KEY'), 'Content-Type': 'application/json' },
                    body: JSON.stringify(batch),
                    signal: AbortSignal.timeout(20000)
                });
                if (response.ok) sent += batch.length;
                else {
                    failed += batch.length;
                    console.error('Resend broadcast batch failed:', response.status, await response.text().catch(() => ''));
                }
            } catch (error) {
                failed += batch.length;
                console.error('Resend broadcast batch error:', error.message);
            }
        }
        return { ok: failed === 0, sent, failed, recipients: recipients.length };
    }

    async function listUsersForAdmin() {
        const p = getPool();
        if (!p || !(await ensureSchema())) {
            return { ok: false, users: [], error: 'Auth database unavailable' };
        }
        const usersRes = await p.query(`
            SELECT u.id, u.email, u.name, u.google_id, u.created_at, u.updated_at,
                   COALESCE(pref.email_announcements, FALSE) AS email_announcements
            FROM users u
            LEFT JOIN user_notification_preferences pref ON pref.user_id = u.id
            ORDER BY COALESCE(u.updated_at, u.created_at) DESC NULLS LAST
        `);
        const linksRes = await p.query(`
            SELECT device_id, user_id, linked_at
            FROM device_links
            ORDER BY linked_at DESC NULLS LAST
        `);
        const devicesByUser = new Map();
        for (const row of linksRes.rows) {
            const uid = String(row.user_id);
            if (!devicesByUser.has(uid)) devicesByUser.set(uid, []);
            devicesByUser.get(uid).push({
                deviceId: row.device_id,
                linkedAt: row.linked_at ? new Date(row.linked_at).toISOString() : null
            });
        }
        const users = usersRes.rows.map((row) => {
            const id = String(row.id);
            return {
                id,
                email: row.email || null,
                name: row.name || null,
                googleId: row.google_id || null,
                emailAnnouncements: !!row.email_announcements,
                createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
                updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
                devices: devicesByUser.get(id) || []
            };
        });
        return { ok: true, users };
    }

    return {
        SESSION_COOKIE,
        authStatus,
        authStatusWithHealth: () => authStatusWithHealth(getPool),
        getPool,
        ensureSchema,
        readUserFromReq,
        setSessionCookie,
        clearSessionCookie,
        requestEmailOtp,
        verifyEmailOtp,
        googleConfigured,
        googleAuthUrl,
        completeGoogleLogin,
        afterLogin,
        mergeDeviceChatsToUser,
        mergeAllLinkedDeviceChats,
        linkDevice,
        listChats,
        getChat,
        upsertChat,
        deleteChat,
        updateChatSummary,
        getUserMemory,
        setUserMemory,
        clearUserMemory,
        patchUserMemory,
        ownerKeyForRequest,
        getPublicBaseUrl,
        listUsersForAdmin,
        createNotification,
        listProjects,
        createProject,
        updateProject,
        deleteProject,
        listStudioProjects,
        createStudioProject,
        updateStudioProject,
        deleteStudioProject,
        listStudioProjectChats,
        createStudioProjectChat,
        getStudioProjectChat,
        saveStudioProjectChat,
        savePushSubscription,
        removePushSubscription,
        sendPushToUser,
        pushNotificationsConfigured: pushConfigured,
        listNotifications,
        markNotificationsRead,
        getEmailAnnouncements,
        setEmailAnnouncements,
        broadcastNotification,
        sendAccountNoticeEmail,
        sendAnnouncementEmails,
        unsubscribeEmailAnnouncements
    };
}

module.exports = { createAuth, authStatus, SESSION_COOKIE };
