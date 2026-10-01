const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');
const https = require('https');
const fs = require('fs');
const {
    createPlansStore,
    adminTokenFromPasskey,
    isAdminAuthed,
    OMT_DESTINATION
} = require('./plans');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { extractUploadedFile, MAX_FILE_BYTES } = require('./fileExtract');
const { createAuth } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 60000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
const plansStore = createPlansStore(DATA_DIR);
const ADMIN_PASSKEY = process.env.ADMIN_PASSKEY || '';

// Auth + Postgres chat store (email OTP / Google). Live login needs keys — see AUTH_ENV.md.
let auth = null;

// ==================== CORS ====================
const corsOriginEnv = process.env.CORS_ORIGIN;
let corsOptions;
if (corsOriginEnv === undefined || corsOriginEnv === '') {
    // Backward compatible: allow all when unset
    corsOptions = { origin: true };
} else if (corsOriginEnv === '*') {
    corsOptions = { origin: true };
} else {
    const allowed = corsOriginEnv.split(',').map(s => s.trim()).filter(Boolean);
    corsOptions = {
        origin: function (origin, cb) {
            if (!origin || allowed.includes(origin)) return cb(null, true);
            return cb(null, false);
        }
    };
}
if (corsOptions && typeof corsOptions === 'object') {
    corsOptions.credentials = true;
}
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== DIY RATE LIMIT (/api/chat*) ====================
const rateBuckets = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;

function chatRateLimit(req, res, next) {
    if (!req.path.startsWith('/api/chat')) return next();
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
        bucket = { start: now, count: 0 };
        rateBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > RATE_LIMIT) {
        return res.status(429).json({ reply: '⏳ Too many requests. Please wait a minute.', model: 'Error' });
    }
    next();
}
app.use(chatRateLimit);

// Periodic cleanup of rate buckets
setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateBuckets) {
        if (now - bucket.start >= RATE_WINDOW_MS * 2) rateBuckets.delete(ip);
    }
}, 120000).unref?.();

let grok;
try {
    grok = new OpenAI({
        apiKey: process.env.GROK_API_KEY || 'missing-key',
        baseURL: 'https://api.x.ai/v1',
        timeout: UPSTREAM_TIMEOUT_MS,
    });
} catch (e) {
    console.error('Failed to initialize Grok client:', e.message);
}

let openaiClient = null;
if (process.env.OPENAI_API_KEY) {
    try {
        // Pin baseURL so a stray OPENAI_BASE_URL env cannot break Fast.
        openaiClient = new OpenAI({
            apiKey: String(process.env.OPENAI_API_KEY).trim(),
            baseURL: 'https://api.openai.com/v1',
            timeout: UPSTREAM_TIMEOUT_MS,
        });
    } catch (e) {
        console.error('Failed to initialize OpenAI client:', e.message);
    }
}

const HISTORY_WINDOW = 40;
const OPENAI_FAST_MODEL = process.env.OPENAI_FAST_MODEL || 'gpt-4o-mini';
const GROK_FAST_MODEL = 'grok-4.3';
// Fast defaults to Grok. Set FAST_PROVIDER=openai to try OpenAI first (Grok fallback on connection/auth failure).
// Set FAST_PROVIDER=openai and we still fall back to Grok unless you also need hard-fail — fallback stays on for openai pref.
const FAST_PROVIDER_PREF = String(process.env.FAST_PROVIDER || '').trim().toLowerCase();

const MODELS = {
    // Fast prefers OpenAI gpt-4o-mini when reachable; otherwise Grok. Thinking/expert stay on Grok.
    normal: { model: OPENAI_FAST_MODEL, maxTokens: 2048, temperature: 0.7, provider: 'openai' },
    fast: { model: OPENAI_FAST_MODEL, maxTokens: 2048, temperature: 0.7, provider: 'openai' },
    smart: { model: 'grok-4.3', maxTokens: 4096, temperature: 0.3, provider: 'grok' },
    expert: { model: 'grok-4.20-multi-agent-0309', maxTokens: 4096, temperature: 0.5, provider: 'grok' }
};

function resolveMode(mode) {
    const key = mode === 'fast' ? 'normal' : (mode || 'normal');
    const safeMode = MODELS[key] ? key : 'normal';
    return { safeMode, config: MODELS[safeMode] };
}

function isOpenAIConnectionFailure(error) {
    const raw = String(error?.message || error || '');
    const cause = String(error?.cause?.code || error?.cause?.message || error?.cause || '');
    const blob = raw + ' ' + cause;
    if (error?.name === 'APIConnectionError') return true;
    if (/Connection error|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|network|socket/i.test(blob)) return true;
    // OpenAI SDK connection errors often have no HTTP status
    if (!error?.status && /connection|fetch failed|network/i.test(blob)) return true;
    return false;
}

function shouldFallbackOpenAIToGrok(error) {
    if (!process.env.GROK_API_KEY || !grok) return false;
    if (isOpenAIConnectionFailure(error)) return true;
    if (error?.status === 401 || error?.status === 403) return true;
    if (error?.code === 'invalid_api_key' || error?.code === 'missing_openai_key') return true;
    return false;
}

function resolveChatTarget(mode) {
    const { safeMode, config } = resolveMode(mode);
    if (config.provider !== 'openai') {
        if (!process.env.GROK_API_KEY) {
            const err = new Error('GROK_API_KEY missing');
            err.code = 'missing_grok_key';
            err.status = 401;
            throw err;
        }
        return {
            safeMode,
            config,
            client: grok,
            provider: 'grok',
            allowGrokFallback: false
        };
    }

    // Fast path: default to Grok (reliable on Render). Opt in with FAST_PROVIDER=openai.
    const useOpenAI = FAST_PROVIDER_PREF === 'openai' && !!openaiClient && !!process.env.OPENAI_API_KEY;
    if (!useOpenAI) {
        if (!process.env.GROK_API_KEY || !grok) {
            if (!process.env.OPENAI_API_KEY || !openaiClient) {
                const err = new Error('OPENAI_API_KEY missing');
                err.code = 'missing_openai_key';
                err.status = 401;
                throw err;
            }
            // OpenAI only available
            return {
                safeMode,
                config,
                client: openaiClient,
                provider: 'openai',
                allowGrokFallback: false
            };
        }
        const grokConfig = {
            ...config,
            model: GROK_FAST_MODEL,
            provider: 'grok'
        };
        return {
            safeMode,
            config: grokConfig,
            client: grok,
            provider: 'grok',
            allowGrokFallback: false
        };
    }

    return {
        safeMode,
        config,
        client: openaiClient,
        provider: 'openai',
        allowGrokFallback: !!process.env.GROK_API_KEY && !!grok
    };
}

async function runWithProviderFallback(target, runFn) {
    try {
        const result = await runFn(target.client, target.config, target.provider);
        if (result && typeof result === 'object' && result.usedGrokFallback === undefined) {
            result.usedGrokFallback = false;
        }
        return result;
    } catch (err) {
        if (target.provider === 'openai' && target.allowGrokFallback && shouldFallbackOpenAIToGrok(err)) {
            const cause = err?.cause?.code || err?.cause?.message || '';
            console.warn(`OpenAI Fast failed (${err.message}${cause ? '; ' + cause : ''}) — falling back to Grok ${GROK_FAST_MODEL}`);
            const grokConfig = { ...target.config, model: GROK_FAST_MODEL, provider: 'grok' };
            const result = await runFn(grok, grokConfig, 'grok');
            if (result && typeof result === 'object') result.usedGrokFallback = true;
            return result;
        }
        throw err;
    }
}

function sendPlanLimitJson(res, limitError) {
    const status = limitError.status || 429;
    return res.status(status).json({
        error: limitError.code || 'limit_reached',
        code: limitError.code || 'limit_reached',
        reply: limitError.reply,
        upgradeUrl: limitError.upgradeUrl || '/upgrade',
        limit: limitError.limit || null,
        model: 'Error'
    });
}

function sendPlanLimitSse(res, sendSse, limitError) {
    if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
    }
    sendSse({
        error: limitError.reply,
        code: limitError.code || 'limit_reached',
        upgradeUrl: limitError.upgradeUrl || '/upgrade',
        limit: limitError.limit || null
    });
    sendSse({ done: true });
    return res.end();
}

function enforceChatCaps(req, res, { sse = false, sendSse = null } = {}) {
    const deviceId = getClientId(req);
    const mode = req.body?.mode;
    const agents = req.body?.agents;
    const check = plansStore.checkChatAllowed(deviceId, mode, agents);
    if (check.ok) {
        return { ok: true, deviceId, kind: check.kind, plan: check.plan };
    }
    if (sse) {
        sendPlanLimitSse(res, sendSse, check.error);
        return { ok: false };
    }
    sendPlanLimitJson(res, check.error);
    return { ok: false };
}

/** Hidden chat-title call. Must not spend the user's Fast/Thinking/Expert quota. */
function isAutoTitleRequest(body) {
    const msgs = body && Array.isArray(body.messages) ? body.messages : null;
    if (!msgs || msgs.length !== 1) return false;
    const content = msgs[0] && msgs[0].content;
    const text = typeof content === 'string' ? content : '';
    return text.startsWith('Reply with ONLY two words.');
}

/**
 * Reserve one unit immediately (blocks parallel over-cap), then keep it only
 * when the handler marks the reply successful. Otherwise roll it back.
 */
function holdUsage(deviceId, kind) {
    let held = false;
    if (deviceId && kind) {
        plansStore.recordUsage(deviceId, kind, { usedGrokFallback: false });
        held = true;
    }
    return {
        rollback() {
            if (!held) return;
            held = false;
            try { plansStore.releaseUsage(deviceId, kind); } catch (e) {
                console.error('releaseUsage failed:', e.message);
            }
        }
    };
}

function sendFreshJson(res, body) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    return res.json(body);
}

// ==================== MATH CLEANER ====================
// Soft clean: keep $ / $$ for KaTeX on the client; strip noisy wrappers only lightly.
function softCleanLatex(text) {
    if (!text) return text;
    return text
        // Replacer fn required: string '$$$$1$$' is parsed as $$ + literal 1 + $ (drops capture/digits).
        .replace(/\\boxed\{([^}]+)\}/g, function (_, inner) { return '$$' + inner + '$$'; })
        .replace(/\\displaystyle\b/g, '')
        .replace(/\\left\b/g, '')
        .replace(/\\right\b/g, '');
}

function cleanLatex(text) {
    if (!text) return text;
    return text
        .replace(/\\boxed\{([^}]+)\}/g, '$1')
        .replace(/\\alpha\b/g, 'α').replace(/\\beta\b/g, 'β').replace(/\\gamma\b/g, 'γ')
        .replace(/\\delta\b/g, 'δ').replace(/\\epsilon\b/g, 'ε').replace(/\\zeta\b/g, 'ζ')
        .replace(/\\eta\b/g, 'η').replace(/\\theta\b/g, 'θ').replace(/\\iota\b/g, 'ι')
        .replace(/\\kappa\b/g, 'κ').replace(/\\lambda\b/g, 'λ').replace(/\\mu\b/g, 'μ')
        .replace(/\\nu\b/g, 'ν').replace(/\\xi\b/g, 'ξ').replace(/\\pi\b/g, 'π')
        .replace(/\\rho\b/g, 'ρ').replace(/\\sigma\b/g, 'σ').replace(/\\tau\b/g, 'τ')
        .replace(/\\upsilon\b/g, 'υ').replace(/\\phi\b/g, 'φ').replace(/\\chi\b/g, 'χ')
        .replace(/\\psi\b/g, 'ψ').replace(/\\omega\b/g, 'ω')
        .replace(/\\Gamma\b/g, 'Γ').replace(/\\Delta\b/g, 'Δ').replace(/\\Theta\b/g, 'Θ')
        .replace(/\\Lambda\b/g, 'Λ').replace(/\\Pi\b/g, 'Π').replace(/\\Sigma\b/g, 'Σ')
        .replace(/\\Phi\b/g, 'Φ').replace(/\\Psi\b/g, 'Ψ').replace(/\\Omega\b/g, 'Ω')
        .replace(/\\pm\b/g, '±').replace(/\\mp\b/g, '∓').replace(/\\times\b/g, '×')
        .replace(/\\div\b/g, '÷').replace(/\\cdot\b/g, '·').replace(/\\circ\b/g, '°')
        .replace(/\\leq\b/g, '≤').replace(/\\geq\b/g, '≥').replace(/\\neq\b/g, '≠')
        .replace(/\\approx\b/g, '≈').replace(/\\equiv\b/g, '≡').replace(/\\sim\b/g, '∼')
        .replace(/\\propto\b/g, '∝').replace(/\\infty\b/g, '∞')
        .replace(/\\rightarrow\b/g, '→').replace(/\\leftarrow\b/g, '←')
        .replace(/\\Rightarrow\b/g, '⇒').replace(/\\Leftarrow\b/g, '⇐')
        .replace(/\\to\b/g, '→').replace(/\\in\b/g, '∈').replace(/\\notin\b/g, '∉')
        .replace(/\\subset\b/g, '⊂').replace(/\\subseteq\b/g, '⊆')
        .replace(/\\cup\b/g, '∪').replace(/\\cap\b/g, '∩').replace(/\\emptyset\b/g, '∅')
        .replace(/\\forall\b/g, '∀').replace(/\\exists\b/g, '∃')
        .replace(/\\int\b/g, '∫').replace(/\\sum\b/g, 'Σ').replace(/\\prod\b/g, '∏')
        .replace(/\\partial\b/g, '∂').replace(/\\nabla\b/g, '∇')
        .replace(/\\angle\b/g, '∠').replace(/\\triangle\b/g, '△')
        .replace(/\\sin\b/g, 'sin').replace(/\\cos\b/g, 'cos').replace(/\\tan\b/g, 'tan')
        .replace(/\\log\b/g, 'log').replace(/\\ln\b/g, 'ln')
        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1)/($2)')
        .replace(/\\sqrt\{([^}]+)\}/g, '√($1)')
        .replace(/\^\{([^}]+)\}/g, '^($1)').replace(/\_\{([^}]+)\}/g, '_($1)')
        .replace(/\\text\{([^}]+)\}/g, '$1').replace(/\\textbf\{([^}]+)\}/g, '**$1**')
        .replace(/\\textit\{([^}]+)\}/g, '*$1*')
        .replace(/\\displaystyle\b/g, '').replace(/\\left\b/g, '').replace(/\\right\b/g, '')
        .replace(/\$\$/g, '').replace(/\$/g, '').replace(/\\[a-zA-Z]+\b/g, '')
        .replace(/\s+/g, ' ').trim();
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject({ message: (label || 'Request') + ' timed out', status: 504 }), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ==================== RESPONSES API CALL ====================
function callResponsesAPI(conversationMessages, config, useWebSearch) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.GROK_API_KEY;

        const input = conversationMessages
            .filter(m => m.role !== 'system')
            .map(m => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: typeof m.content === 'string' ? m.content :
                    (Array.isArray(m.content) ? m.content.map(c =>
                        c.type === 'text' ? c.text : ''
                    ).join(' ') : '')
            }));

        const systemMsg = conversationMessages.find(m => m.role === 'system');
        if (systemMsg && input.length > 0) {
            input[0].content = systemMsg.content + '\n\n' + input[0].content;
        }

        const tools = useWebSearch ? [{ type: 'web_search' }] : [];

        const payload = JSON.stringify({
            model: config.model,
            input: input,
            tools: tools,
            max_output_tokens: config.maxTokens,
            temperature: config.temperature
        });

        const options = {
            hostname: 'api.x.ai',
            path: '/v1/responses',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: UPSTREAM_TIMEOUT_MS
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        reject({ status: res.statusCode, message: json.error?.message || json.detail || 'Unknown error' });
                    } else {
                        resolve(json);
                    }
                } catch (e) {
                    reject({ status: res.statusCode, message: 'Failed to parse response' });
                }
            });
        });

        req.on('error', (e) => reject({ message: e.message }));
        req.on('timeout', () => {
            req.destroy();
            reject({ message: 'Request timed out', status: 504 });
        });
        req.setTimeout(UPSTREAM_TIMEOUT_MS);
        req.write(payload);
        req.end();
    });
}

function buildConversationMessages(body) {
    const { messages, customInstructions, image } = body || {};
    const conversationMessages = [];

    if (customInstructions && customInstructions.trim()) {
        conversationMessages.push({
            role: 'system',
            content: customInstructions.trim()
        });
    }

    const recentMessages = Array.isArray(messages)
        ? messages.slice(-HISTORY_WINDOW)
        : [];

    if (recentMessages.length) {
        recentMessages.forEach(msg => {
            if (!msg || !msg.role) return;

            if (msg.role === 'user') {
                const content = [];
                if (msg.content && msg.content.trim()) {
                    content.push({ type: 'text', text: msg.content.trim() });
                }
                if (msg.image && !msg.imageTooBig) {
                    content.push({
                        type: 'image_url',
                        image_url: { url: msg.image, detail: 'auto' }
                    });
                }
                if (content.length > 0) {
                    conversationMessages.push({
                        role: 'user',
                        content: content.length === 1 && content[0].type === 'text'
                            ? content[0].text
                            : content
                    });
                }
            } else if (msg.role === 'ai' || msg.role === 'assistant') {
                if (msg.content && msg.content.trim()) {
                    conversationMessages.push({
                        role: 'assistant',
                        content: msg.content.trim()
                    });
                }
            }
        });
    }

    if (image && !messages?.some(m => m.image === image)) {
        const lastMsg = conversationMessages[conversationMessages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
            if (typeof lastMsg.content === 'string') {
                lastMsg.content = [
                    { type: 'text', text: lastMsg.content },
                    { type: 'image_url', image_url: { url: image, detail: 'auto' } }
                ];
            } else if (Array.isArray(lastMsg.content)) {
                lastMsg.content.push({ type: 'image_url', image_url: { url: image, detail: 'auto' } });
            }
        } else {
            conversationMessages.push({
                role: 'user',
                content: [{ type: 'image_url', image_url: { url: image, detail: 'auto' } }]
            });
        }
    }

    if (conversationMessages.length === 0) {
        conversationMessages.push({ role: 'user', content: 'Hello' });
    }

    return conversationMessages;
}

function mapApiError(error, provider) {
    const cause = String(error?.cause?.code || error?.cause?.message || '');
    const raw = String(error?.message || error || '') + (cause ? ' ' + cause : '');
    const clean = String(error?.message || error || '').split('\n')[0].replace(/\s+at\s+.*/g, '').substring(0, 160);
    const who = provider === 'openai' ? 'OpenAI' : 'Grok';

    if (error?.code === 'missing_openai_key') {
        return '🔑 Fast mode needs OPENAI_API_KEY (or a working GROK_API_KEY fallback). Set it in Render environment variables, then redeploy.';
    }
    if (error?.code === 'missing_grok_key') {
        return '🔑 Grok API key not configured. Set GROK_API_KEY on Render.';
    }
    if (error?.status === 401 || /invalid.?api.?key|incorrect api key|authentication/i.test(raw)) {
        return '🔑 Invalid or missing ' + who + ' API key. Check Render environment variables.';
    }
    if (error?.status === 429 || /rate.?limit|too many requests/i.test(raw)) {
        return '⏳ Rate limited. Please wait a minute and try again.';
    }
    if (error?.status === 402 || /insufficient.?quota|billing|out of credits/i.test(raw)) {
        return '💰 Out of credits or quota for ' + who + '.';
    }
    if (error?.status === 422) return '⚠️ Invalid request. Try a different mode or shorter message.';
    if (error?.status === 503) return '🔧 ' + who + ' service unavailable. Try again shortly.';
    if (error?.status === 504 || /timeout|timed out/i.test(raw)) {
        return '⏰ Request timed out. Tap Retry.';
    }
    if (/Connection error|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|network|socket/i.test(raw) || error?.name === 'APIConnectionError') {
        return '⚠️ Could not reach ' + who + '. Tap Retry or switch mode.';
    }
    if (/empty reply|no response/i.test(raw)) {
        return '⚠️ The model returned an empty reply. Tap Retry or switch mode.';
    }
    if (clean) return '⚠️ ' + clean;
    return '⚠️ Something went wrong. Please try again.';
}

// ==================== FILE EXTRACT (chat attachments; does NOT burn plan caps) ====================
const uploadMemory = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1 }
});

app.post('/api/extract-file', (req, res) => {
    uploadMemory.single('file')(req, res, async (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'File too large (max ~12MB).'
                : (err.message || 'Upload failed');
            return res.status(400).json({
                ok: false,
                error: msg,
                preferMode: 'thinking',
                reason: 'upload_error'
            });
        }
        try {
            if (!req.file) {
                return res.status(400).json({
                    ok: false,
                    error: 'No file uploaded.',
                    preferMode: 'thinking',
                    reason: 'missing_file'
                });
            }
            const result = await extractUploadedFile({
                buffer: req.file.buffer,
                originalname: req.file.originalname,
                mimetype: req.file.mimetype
            });
            // Never meters Thinking/Fast — extraction is free.
            return res.json(result);
        } catch (e) {
            console.error('extract-file:', e.message || e);
            return res.status(500).json({
                ok: false,
                error: 'Extraction failed.',
                preferMode: 'thinking',
                reason: 'server_error'
            });
        }
    });
});

// ==================== MAIN CHAT ENDPOINT (non-streaming, compatibility) ====================
app.post('/api/chat', async (req, res) => {
    let activeProvider = 'grok';
    let usageHold = null;
    let keepUsage = false;
    try {
        const { mode, webSearch } = req.body;
        const capGate = enforceChatCaps(req, res, { sse: false });
        if (!capGate.ok) return;
        const usageKind = capGate.kind;
        const deviceId = capGate.deviceId;
        // Reserve before the model call so parallel sends cannot bypass the cap.
        // Rolled back in finally unless the reply is a real success.
        if (!isAutoTitleRequest(req.body)) usageHold = holdUsage(deviceId, usageKind);

        activeProvider = resolveMode(mode).config.provider;
        let target;
        try {
            target = resolveChatTarget(mode);
        } catch (keyErr) {
            return res.status(401).json({
                reply: mapApiError(keyErr, activeProvider),
                model: 'Error'
            });
        }

        activeProvider = target.provider;
        const { safeMode } = target;
        const conversationMessages = buildConversationMessages(req.body);
        const useWebSearch = webSearch === true;

        console.log(`Mode: ${safeMode} | Provider: ${target.provider} | Model: ${target.config.model} | Web: ${useWebSearch ? 'ON' : 'OFF'} | msgs: ${conversationMessages.length} | planKind=${usageKind}`);

        const result = await runWithProviderFallback(target, async (client, config, provider) => {
            activeProvider = provider;
            let reply;
            if (safeMode === 'expert') {
                const responseData = await withTimeout(
                    callResponsesAPI(conversationMessages, config, useWebSearch),
                    UPSTREAM_TIMEOUT_MS,
                    'Expert request'
                );
                reply = responseData.output_text ||
                    responseData.output?.find(o => o.type === 'message')?.content?.[0]?.text ||
                    'No response generated.';
            } else if (safeMode === 'smart') {
                const completion = await withTimeout(
                    client.chat.completions.create({
                        model: config.model,
                        messages: conversationMessages,
                        max_tokens: config.maxTokens,
                        temperature: config.temperature,
                        reasoning_effort: 'high',
                    }),
                    UPSTREAM_TIMEOUT_MS,
                    'Smart request'
                );
                reply = completion?.choices?.[0]?.message?.content || 'No response generated.';
            } else {
                // Fast (normal): OpenAI when available, else Grok — multimodal content parts supported
                const completion = await withTimeout(
                    client.chat.completions.create({
                        model: config.model,
                        messages: conversationMessages,
                        max_tokens: config.maxTokens,
                        temperature: config.temperature,
                    }),
                    UPSTREAM_TIMEOUT_MS,
                    'Fast request'
                );
                reply = completion?.choices?.[0]?.message?.content || 'No response generated.';
            }
            return { reply, provider, modelName: config.model };
        });

        let reply = softCleanLatex(result.reply);
        if (!String(reply).trim()) {
            return res.status(502).json({
                reply: mapApiError({ message: 'empty reply' }, result.provider),
                model: 'Error'
            });
        }

        console.log(`Response: ${String(reply).length} chars | provider=${result.provider}`);
        if (result.usedGrokFallback && usageKind === 'fast') {
            plansStore.markFastHalved(deviceId);
        }
        keepUsage = true;
        res.json({ reply, model: safeMode, provider: result.provider });

    } catch (error) {
        console.error('Chat API Error:', error.message || error, error.status || '', error.cause?.code || '');
        const status = error.status === 401 ? 401 : error.status === 429 ? 429 : 500;
        res.status(status).json({ reply: mapApiError(error, activeProvider), model: 'Error' });
    } finally {
        if (usageHold && !keepUsage) usageHold.rollback();
    }
});

// ==================== STREAMING CHAT ENDPOINT ====================
app.post('/api/chat/stream', async (req, res) => {
    const sendSse = (obj) => {
        try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {}
    };
    let usageHold = null;
    let keepUsage = false;

    try {
        const { mode, webSearch } = req.body;
        const capGate = enforceChatCaps(req, res, { sse: true, sendSse });
        if (!capGate.ok) return;
        const usageKind = capGate.kind;
        const deviceId = capGate.deviceId;
        let usedGrokFallback = false;
        if (!isAutoTitleRequest(req.body)) usageHold = holdUsage(deviceId, usageKind);

        let target;
        try {
            target = resolveChatTarget(mode);
        } catch (keyErr) {
            const modeInfo = resolveMode(mode);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            sendSse({ error: mapApiError(keyErr, modeInfo.config.provider) });
            sendSse({ done: true });
            return res.end();
        }

        let { safeMode, config, client, provider, allowGrokFallback } = target;
        const conversationMessages = buildConversationMessages(req.body);
        const useWebSearch = webSearch === true;

        console.log(`Stream: ${safeMode} | Provider: ${provider} | Model: ${config.model} | Web: ${useWebSearch ? 'ON' : 'OFF'} | msgs: ${conversationMessages.length} | planKind=${usageKind}`);

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        // Honest UX status (not fabricated CoT) — client shows thinking UI until text arrives
        const initialStatus = (safeMode === 'expert' && useWebSearch)
            ? 'searching'
            : (safeMode === 'expert')
                ? 'researching'
                : (safeMode === 'smart')
                    ? 'thinking'
                    : 'generating';
        sendSse({ status: initialStatus, mode: safeMode, provider, webSearch: useWebSearch });

        // Expert: non-streaming Responses API, emit as one chunk
        if (safeMode === 'expert') {
            try {
                sendSse({ status: useWebSearch ? 'searching' : 'researching' });
                const responseData = await withTimeout(
                    callResponsesAPI(conversationMessages, config, useWebSearch),
                    UPSTREAM_TIMEOUT_MS,
                    'Expert stream'
                );
                let reply = responseData.output_text ||
                    responseData.output?.find(o => o.type === 'message')?.content?.[0]?.text ||
                    'No response generated.';
                reply = softCleanLatex(reply);
                sendSse({ status: 'generating' });
                sendSse({ text: reply });
                if (String(reply).trim() && reply !== 'No response generated.') keepUsage = true;
                sendSse({ done: true, model: safeMode, provider });
                console.log(`Stream done (expert): ${String(reply).length} chars`);
                return res.end();
            } catch (err) {
                sendSse({ error: mapApiError(err, provider) });
                sendSse({ done: true });
                return res.end();
            }
        }

        const abortCtrl = new AbortController();
        const timeoutId = setTimeout(() => abortCtrl.abort(), UPSTREAM_TIMEOUT_MS);
        let clientClosed = false;
        // Use response close — request 'close' often fires after the body is read on proxies like Render
        res.on('close', () => {
            if (!res.writableEnded) {
                clientClosed = true;
                try { abortCtrl.abort(); } catch (e) {}
            }
        });

        async function openStream(activeClient, activeConfig) {
            const createArgs = {
                model: activeConfig.model,
                messages: conversationMessages,
                max_tokens: activeConfig.maxTokens,
                temperature: activeConfig.temperature,
                stream: true,
            };
            if (safeMode === 'smart') createArgs.reasoning_effort = 'high';
            return activeClient.chat.completions.create(createArgs, { signal: abortCtrl.signal });
        }

        async function nonStreamCompletion(activeClient, activeConfig, label) {
            const fallbackArgs = {
                model: activeConfig.model,
                messages: conversationMessages,
                max_tokens: activeConfig.maxTokens,
                temperature: activeConfig.temperature,
            };
            if (safeMode === 'smart') fallbackArgs.reasoning_effort = 'high';
            const completion = await withTimeout(
                activeClient.chat.completions.create(fallbackArgs),
                UPSTREAM_TIMEOUT_MS,
                label
            );
            return completion?.choices?.[0]?.message?.content || '';
        }

        try {
            let stream;
            try {
                stream = await openStream(client, config);
            } catch (openErr) {
                if (provider === 'openai' && allowGrokFallback && shouldFallbackOpenAIToGrok(openErr)) {
                    const cause = openErr?.cause?.code || openErr?.cause?.message || '';
                    console.warn(`OpenAI Fast stream failed (${openErr.message}${cause ? '; ' + cause : ''}) — falling back to Grok ${GROK_FAST_MODEL}`);
                    provider = 'grok';
                    config = { ...config, model: GROK_FAST_MODEL, provider: 'grok' };
                    client = grok;
                    allowGrokFallback = false;
                    usedGrokFallback = true;
                    stream = await openStream(client, config);
                } else {
                    throw openErr;
                }
            }

            let full = '';
            let emittedGenerating = false;
            for await (const chunk of stream) {
                if (clientClosed) break;
                const choice = chunk.choices?.[0];
                const deltaObj = choice?.delta || {};
                // Surface real reasoning fields only when the provider sends them (never invent CoT)
                const reasoningDelta = deltaObj.reasoning_content
                    || deltaObj.reasoning
                    || (typeof deltaObj.reasoning_text === 'string' ? deltaObj.reasoning_text : '')
                    || '';
                if (reasoningDelta) {
                    sendSse({ reasoning: reasoningDelta, status: 'thinking' });
                }
                const delta = deltaObj.content
                    || deltaObj.text
                    || (typeof choice?.delta === 'string' ? choice.delta : '')
                    || '';
                if (delta) {
                    if (!emittedGenerating) {
                        emittedGenerating = true;
                        sendSse({ status: 'generating' });
                    }
                    full += delta;
                    sendSse({ text: delta });
                }
            }
            clearTimeout(timeoutId);

            // If streaming returned nothing (common with reasoning / proxy abort), fall back once
            if (!clientClosed && !full.trim()) {
                sendSse({ status: safeMode === 'smart' ? 'thinking' : 'waiting' });
                console.warn('Stream empty — falling back to non-stream completion');
                try {
                    full = await nonStreamCompletion(client, config, 'Stream fallback');
                    if (full) sendSse({ text: full });
                } catch (fbErr) {
                    if (provider === 'openai' && allowGrokFallback && shouldFallbackOpenAIToGrok(fbErr)) {
                        console.warn('OpenAI empty-stream fallback failed — trying Grok');
                        provider = 'grok';
                        config = { ...config, model: GROK_FAST_MODEL, provider: 'grok' };
                        client = grok;
                        usedGrokFallback = true;
                        full = await nonStreamCompletion(client, config, 'Stream Grok fallback');
                        if (full) sendSse({ text: full });
                    } else {
                        sendSse({ error: mapApiError(fbErr, provider) });
                        sendSse({ done: true });
                        return res.end();
                    }
                }
            }

            if (!clientClosed) {
                const cleaned = softCleanLatex(full) || '';
                if (!cleaned.trim()) {
                    sendSse({ error: mapApiError({ message: 'empty reply' }, provider) });
                } else {
                    if (usedGrokFallback && usageKind === 'fast') {
                        plansStore.markFastHalved(deviceId);
                    }
                    keepUsage = true;
                }
                sendSse({ done: true, model: safeMode, provider, full: cleaned });
                console.log(`Stream done: ${cleaned.length} chars | provider=${provider}`);
            }
            return res.end();
        } catch (err) {
            clearTimeout(timeoutId);
            if (clientClosed || err?.name === 'AbortError') {
                // Last-chance non-stream if abort looked spurious and we got nothing yet
                try {
                    const text = await nonStreamCompletion(client, config, 'Abort recovery');
                    if (text) {
                        const cleanedAbort = softCleanLatex(text);
                        sendSse({ text: cleanedAbort });
                        if (String(cleanedAbort).trim()) {
                            if (usedGrokFallback && usageKind === 'fast') {
                                plansStore.markFastHalved(deviceId);
                            }
                            keepUsage = true;
                        }
                        sendSse({ done: true, model: safeMode, provider, full: cleanedAbort });
                        return res.end();
                    }
                } catch (e) {}
                try { sendSse({ done: true, aborted: true }); } catch (e) {}
                return res.end();
            }

            // Final OpenAI → Grok rescue for Fast
            if (provider === 'openai' && allowGrokFallback && shouldFallbackOpenAIToGrok(err)) {
                try {
                    const cause = err?.cause?.code || err?.cause?.message || '';
                    console.warn(`OpenAI Fast failed mid-stream (${err.message}${cause ? '; ' + cause : ''}) — non-stream Grok fallback`);
                    provider = 'grok';
                    config = { ...config, model: GROK_FAST_MODEL, provider: 'grok' };
                    client = grok;
                    usedGrokFallback = true;
                    const text = await nonStreamCompletion(client, config, 'Grok rescue');
                    if (text) {
                        const cleanedRescue = softCleanLatex(text);
                        sendSse({ text: cleanedRescue });
                        if (String(cleanedRescue).trim()) {
                            if (usedGrokFallback && usageKind === 'fast') {
                                plansStore.markFastHalved(deviceId);
                            }
                            keepUsage = true;
                        }
                        sendSse({ done: true, model: safeMode, provider, full: cleanedRescue });
                        return res.end();
                    }
                } catch (rescueErr) {
                    sendSse({ error: mapApiError(rescueErr, 'grok') });
                    sendSse({ done: true });
                    return res.end();
                }
            }

            sendSse({ error: mapApiError(err, provider) });
            sendSse({ done: true });
            return res.end();
        }
    } catch (error) {
        console.error('Stream Error:', error.message || error, error.cause?.code || '');
        const modeInfo = resolveMode(req.body?.mode);
        if (!res.headersSent) {
            return res.status(500).json({ reply: mapApiError(error, modeInfo.config.provider), model: 'Error' });
        }
        try {
            sendSse({ error: mapApiError(error, modeInfo.config.provider) });
            sendSse({ done: true });
            res.end();
        } catch (e) {}
    } finally {
        if (usageHold && !keepUsage) usageHold.rollback();
    }
});

// ==================== CHAT PERSISTENCE STORE ====================
function ensureDataDir() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
        console.error('DATA_DIR error:', e.message);
    }
}

function readStore() {
    ensureDataDir();
    try {
        if (!fs.existsSync(CHATS_FILE)) return {};
        const raw = fs.readFileSync(CHATS_FILE, 'utf8');
        return JSON.parse(raw || '{}') || {};
    } catch (e) {
        console.error('chats.json read error:', e.message);
        return {};
    }
}

function writeStore(store) {
    ensureDataDir();
    try {
        const tmp = CHATS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(store));
        fs.renameSync(tmp, CHATS_FILE);
    } catch (e) {
        console.error('chats.json write error:', e.message);
        throw e;
    }
}

function getClientId(req) {
    const id = (req.headers['x-client-id'] || '').toString().trim();
    if (!id || id.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    return id;
}

function requireClientId(req, res) {
    const id = getClientId(req);
    if (!id) {
        res.status(400).json({ error: 'Missing or invalid X-Client-Id header' });
        return null;
    }
    return id;
}

function mergeJsonDeviceToUser(deviceId, userKey) {
    if (!deviceId || !userKey) return { merged: 0 };
    const store = readStore();
    const from = store[deviceId] || {};
    if (!store[userKey]) store[userKey] = {};
    let merged = 0;
    for (const id of Object.keys(from)) {
        const incoming = from[id];
        const existing = store[userKey][id];
        if (!existing) {
            store[userKey][id] = incoming;
            merged += 1;
        } else {
            const a = String(incoming.updatedAt || incoming.createdAt || '');
            const b = String(existing.updatedAt || existing.createdAt || '');
            if (a > b) {
                store[userKey][id] = incoming;
                merged += 1;
            }
        }
    }
    delete store[deviceId];
    writeStore(store);
    return { merged };
}

auth = createAuth({ mergeJsonDeviceToUser });
auth.ensureSchema().catch((e) => console.error('Auth schema warmup:', e.message));

/** Chat owner: logged-in userId key, else guest device id. Plans still use device id. */
function resolveChatOwnerKey(req, res) {
    const deviceId = getClientId(req);
    const user = auth.readUserFromReq(req);
    if (user && user.id) return 'u_' + user.id;
    if (!deviceId) {
        res.status(400).json({ error: 'Missing or invalid X-Client-Id header' });
        return null;
    }
    return deviceId;
}

function listChatsFromJson(ownerKey) {
    const store = readStore();
    const clientChats = store[ownerKey] || {};
    return Object.keys(clientChats).map(id => {
        const c = clientChats[id] || {};
        return {
            id,
            name: c.name || 'New Chat',
            createdAt: c.createdAt || null,
            updatedAt: c.updatedAt || null,
            named: !!c.named,
            messageCount: Array.isArray(c.messages) ? c.messages.length : 0
        };
    }).sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}

app.get('/api/chats', async (req, res) => {
    const ownerKey = resolveChatOwnerKey(req, res);
    if (!ownerKey) return;
    try {
        const pgList = await auth.listChats(ownerKey);
        if (pgList) return res.json({ chats: pgList, ownerKeyPrefix: ownerKey.startsWith('u_') ? 'user' : 'device' });
    } catch (e) {
        console.error('pg listChats:', e.message);
    }
    res.json({ chats: listChatsFromJson(ownerKey), ownerKeyPrefix: ownerKey.startsWith('u_') ? 'user' : 'device' });
});

app.get('/api/chats/:id', async (req, res) => {
    const ownerKey = resolveChatOwnerKey(req, res);
    if (!ownerKey) return;
    try {
        const pgChat = await auth.getChat(ownerKey, req.params.id);
        if (pgChat === null) {
            // pg unavailable → json
        } else if (pgChat === undefined) {
            return res.status(404).json({ error: 'Not found' });
        } else {
            return res.json(pgChat);
        }
    } catch (e) {
        console.error('pg getChat:', e.message);
    }
    const store = readStore();
    const chat = store[ownerKey]?.[req.params.id];
    if (!chat) return res.status(404).json({ error: 'Not found' });
    res.json({ id: req.params.id, ...chat });
});

app.post('/api/chats', async (req, res) => {
    const ownerKey = resolveChatOwnerKey(req, res);
    if (!ownerKey) return;
    const body = req.body || {};
    const id = body.id || ('chat_' + Date.now());
    const now = new Date().toISOString();
    const chat = {
        name: body.name || 'New Chat',
        messages: Array.isArray(body.messages) ? body.messages : [],
        createdAt: body.createdAt || now,
        updatedAt: now,
        named: !!body.named,
        customInstructions: body.customInstructions || '',
        systemPrompt: body.systemPrompt || ''
    };
    try {
        const ok = await auth.upsertChat(ownerKey, id, chat);
        if (ok) return res.status(201).json({ id, ...chat });
    } catch (e) {
        console.error('pg upsertChat:', e.message);
    }
    const store = readStore();
    if (!store[ownerKey]) store[ownerKey] = {};
    store[ownerKey][id] = chat;
    try {
        writeStore(store);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save' });
    }
    res.status(201).json({ id, ...chat });
});

app.put('/api/chats/:id', async (req, res) => {
    const ownerKey = resolveChatOwnerKey(req, res);
    if (!ownerKey) return;
    const body = req.body || {};
    const now = new Date().toISOString();
    let existing = {};
    try {
        const pgChat = await auth.getChat(ownerKey, req.params.id);
        if (pgChat && pgChat !== null) existing = pgChat;
    } catch (_) {}
    if (!existing.name) {
        const store = readStore();
        existing = (store[ownerKey] && store[ownerKey][req.params.id]) || {};
    }
    const chat = {
        name: body.name !== undefined ? body.name : (existing.name || 'New Chat'),
        messages: Array.isArray(body.messages) ? body.messages : (existing.messages || []),
        createdAt: existing.createdAt || body.createdAt || now,
        updatedAt: now,
        named: body.named !== undefined ? !!body.named : !!existing.named,
        customInstructions: body.customInstructions !== undefined ? body.customInstructions : (existing.customInstructions || ''),
        systemPrompt: body.systemPrompt !== undefined ? body.systemPrompt : (existing.systemPrompt || '')
    };
    try {
        const ok = await auth.upsertChat(ownerKey, req.params.id, chat);
        if (ok) return res.json({ id: req.params.id, ...chat });
    } catch (e) {
        console.error('pg upsertChat put:', e.message);
    }
    const store = readStore();
    if (!store[ownerKey]) store[ownerKey] = {};
    store[ownerKey][req.params.id] = chat;
    try {
        writeStore(store);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save' });
    }
    res.json({ id: req.params.id, ...chat });
});

app.delete('/api/chats/:id', async (req, res) => {
    const ownerKey = resolveChatOwnerKey(req, res);
    if (!ownerKey) return;
    let deleted = false;
    try {
        const pgChat = await auth.getChat(ownerKey, req.params.id);
        if (pgChat) {
            await auth.deleteChat(ownerKey, req.params.id);
            deleted = true;
        } else if (pgChat === null) {
            // fallback json
        } else {
            // pg ok, not found — still try json
        }
    } catch (e) {
        console.error('pg deleteChat:', e.message);
    }
    const store = readStore();
    if (store[ownerKey] && store[ownerKey][req.params.id]) {
        delete store[ownerKey][req.params.id];
        try { writeStore(store); } catch (e) { return res.status(500).json({ error: 'Failed to delete' }); }
        deleted = true;
    }
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

// ==================== AUTH (email OTP + Google OAuth) ====================
app.get('/api/auth/status', (req, res) => {
    const st = auth.authStatus();
    const user = auth.readUserFromReq(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        ...st,
        user: user ? { id: user.id, email: user.email, name: user.name } : null,
        guest: !user
    });
});

app.get('/api/auth/me', (req, res) => {
    const user = auth.readUserFromReq(req);
    res.setHeader('Cache-Control', 'no-store');
    if (!user) return res.status(401).json({ user: null, guest: true });
    res.json({ user, guest: false });
});

app.post('/api/auth/logout', (req, res) => {
    auth.clearSessionCookie(res);
    res.json({ ok: true });
});

app.post('/api/auth/otp/request', async (req, res) => {
    try {
        const email = (req.body && req.body.email) || '';
        const deviceId = getClientId(req);
        const result = await auth.requestEmailOtp({ email, deviceId });
        if (!result.ok) {
            const disabled = result.status && !result.status.emailOtp;
            return res.status(disabled ? 503 : 400).json(result);
        }
        res.json(result);
    } catch (e) {
        console.error('otp request:', e.message);
        res.status(500).json({ ok: false, error: 'Failed to send login code.' });
    }
});

app.post('/api/auth/otp/verify', async (req, res) => {
    try {
        const email = (req.body && req.body.email) || '';
        const code = (req.body && req.body.code) || '';
        const deviceId = getClientId(req);
        const result = await auth.verifyEmailOtp({ email, code, deviceId, res, req });
        if (!result.ok) {
            const disabled = result.status && !result.status.emailOtp;
            return res.status(disabled ? 503 : 400).json(result);
        }
        res.json(result);
    } catch (e) {
        console.error('otp verify:', e.message);
        res.status(500).json({ ok: false, error: 'Failed to verify login code.' });
    }
});

app.get('/api/auth/google/start', (req, res) => {
    const st = auth.authStatus();
    if (!st.ready || !st.googleOAuth) {
        return res.status(503).json({
            ok: false,
            error: 'Google OAuth is not configured yet.',
            missing: st.liveLoginBlockedBy,
            need: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'DATABASE_URL', 'SESSION_SECRET']
        });
    }
    const qCid = (req.query.cid || '').toString().trim();
    const deviceId = getClientId(req) || (/^[a-zA-Z0-9_-]{1,128}$/.test(qCid) ? qCid : '');
    const state = Buffer.from(JSON.stringify({ d: deviceId, t: Date.now() })).toString('base64url');
    res.redirect(auth.googleAuthUrl(req, state));
});

app.get('/api/auth/google/callback', async (req, res) => {
    try {
        const code = req.query.code;
        let deviceId = null;
        try {
            const state = JSON.parse(Buffer.from(String(req.query.state || ''), 'base64url').toString('utf8'));
            deviceId = state && state.d ? String(state.d) : null;
        } catch (_) {}
        if (!deviceId) deviceId = getClientId(req);
        const result = await auth.completeGoogleLogin(code, deviceId, res, req);
        if (!result.ok) {
            return res.redirect('/?auth=google_error&msg=' + encodeURIComponent(result.error || 'Google login failed'));
        }
        return res.redirect('/?auth=ok');
    } catch (e) {
        console.error('google callback:', e.message);
        return res.redirect('/?auth=google_error');
    }
});

/** Explicit device→user merge (also runs automatically on login). */
app.post('/api/auth/merge-device', async (req, res) => {
    const user = auth.readUserFromReq(req);
    if (!user) return res.status(401).json({ ok: false, error: 'Login required' });
    const deviceId = getClientId(req);
    if (!deviceId) return res.status(400).json({ ok: false, error: 'Missing X-Client-Id' });
    try {
        await auth.linkDevice(user.id, deviceId);
        const pg = await auth.mergeDeviceChatsToUser(deviceId, user.id);
        const json = mergeJsonDeviceToUser(deviceId, 'u_' + user.id);
        res.json({ ok: true, postgresMerged: pg.merged, jsonMerged: json.merged });
    } catch (e) {
        console.error('merge-device:', e.message);
        res.status(500).json({ ok: false, error: 'Merge failed' });
    }
});

// ==================== PLANS / UPGRADE / ADMIN ====================
app.get('/api/plan', (req, res) => {
    const deviceId = getClientId(req);
    sendFreshJson(res, plansStore.getStatus(deviceId));
});

app.get('/api/plan-status', (req, res) => {
    const deviceId = getClientId(req);
    sendFreshJson(res, plansStore.getPlanStatusUi(deviceId));
});

app.get('/api/my-plan', (req, res) => {
    const deviceId = getClientId(req);
    sendFreshJson(res, plansStore.getMyPlan(deviceId));
});



app.post('/api/upgrade/request', (req, res) => {
    const deviceId = getClientId(req);
    if (!deviceId) {
        return res.status(400).json({ ok: false, error: 'Missing or invalid X-Client-Id header' });
    }
    const body = req.body || {};
    if (!body.acceptedPolicies) {
        return res.status(400).json({ ok: false, error: 'You must accept Terms, Privacy, and Refund policies.' });
    }
    const result = plansStore.createPaymentRequest({
        deviceId,
        plan: body.plan,
        phone: body.phone
    });
    if (!result.ok) {
        return res.status(400).json(result);
    }
    res.status(201).json({
        ok: true,
        payment: {
            id: result.payment.id,
            plan: result.payment.plan,
            amount: result.payment.amount,
            phone: result.payment.phone,
            status: result.payment.status,
            createdAt: result.payment.createdAt,
            destination: OMT_DESTINATION
        },
        message: result.message || 'Payment request created. Status: Waiting.'
    });
});

app.post('/api/admin/login', (req, res) => {
    if (!ADMIN_PASSKEY) {
        return res.status(503).json({ error: 'ADMIN_PASSKEY is not configured on the server.' });
    }
    const passkey = (req.body && req.body.passkey) || '';
    if (!passkey || passkey !== ADMIN_PASSKEY) {
        return res.status(401).json({ error: 'Invalid passkey' });
    }
    const token = adminTokenFromPasskey(ADMIN_PASSKEY);
    res.setHeader('Set-Cookie', `gsa_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'gsa_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ ok: true });
});

function requireAdmin(req, res) {
    if (!ADMIN_PASSKEY) {
        res.status(503).json({ error: 'ADMIN_PASSKEY is not configured on the server.' });
        return false;
    }
    if (!isAdminAuthed(req, ADMIN_PASSKEY)) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

app.get('/api/admin/payments', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ payments: plansStore.listPayments() });
});

app.post('/api/admin/payments/:id/approve', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const result = plansStore.approvePayment(req.params.id);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
});

app.post('/api/admin/payments/:id/decline', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const result = plansStore.declinePayment(req.params.id);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
});

app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});
app.get('/terms.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/privacy.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/refund', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'refund.html'));
});
app.get('/refund.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'refund.html'));
});
app.get('/upgrade', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upgrade.html'));
});
app.get('/upgrade.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upgrade.html'));
});

app.get('/my-plan', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'my-plan.html'));
});
app.get('/my-plan.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'my-plan.html'));
});
app.get('/plan-status', (req, res) => {
    res.redirect(302, '/my-plan');
});
app.get('/plan-status.html', (req, res) => {
    res.redirect(302, '/my-plan');
});

app.get('/admin-page', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-page.html'));
});
app.get('/admin-page.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-page.html'));
});

// ==================== STATIC FILE ROUTES (for PWA) ====================
app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/offline.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'offline.html'));
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        app: 'GoldenSpaceAI',
        providers: {
            fast: (FAST_PROVIDER_PREF === 'openai' ? ('OpenAI ' + OPENAI_FAST_MODEL + ' → Grok fallback') : ('Grok ' + GROK_FAST_MODEL + ' (OpenAI opt-in via FAST_PROVIDER=openai)')),
            thinking: 'Grok 4.3',
            expert: 'Grok multi-agent'
        },
        mathCleaner: true,
        streaming: true,
        persistence: true,
        plans: true,
        dailyResetTimezone: 'UTC',
        historyWindow: HISTORY_WINDOW,
        pwaReady: true,
        fastProviderPref: FAST_PROVIDER_PREF || 'auto',
        grokKeyConfigured: !!process.env.GROK_API_KEY,
        openaiKeyConfigured: !!process.env.OPENAI_API_KEY,
        adminPasskeyConfigured: !!ADMIN_PASSKEY,
        auth: auth ? auth.authStatus() : { ready: false }
    });
});

// ==================== CATCH-ALL ROUTE ====================
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    res.status(500).json({ reply: '⚠️ Server error.' });
});

// ==================== START SERVER ====================
ensureDataDir();
app.listen(PORT, () => {
    console.log('═══════════════════════════════');
    console.log('🚀 GoldenSpaceAI Server');
    console.log(`📡 Port: ${PORT}`);
    console.log(`⚡ Fast: pref=${FAST_PROVIDER_PREF || 'grok-default'} | OpenAI ${OPENAI_FAST_MODEL} (${process.env.OPENAI_API_KEY ? 'key ✅' : 'key ❌'}) | Grok ${GROK_FAST_MODEL} (${process.env.GROK_API_KEY ? 'key ✅' : 'key ❌'})`);
    console.log(`🧠 Thinking/Expert: Grok (key ${process.env.GROK_API_KEY ? '✅' : '❌'})`);
    console.log(`📜 History window: ${HISTORY_WINDOW} messages`);
    console.log(`📐 Math Cleaner: ✅`);
    console.log(`📡 Streaming: ✅ /api/chat/stream`);
    console.log(`💾 Persistence: ✅ ${CHATS_FILE}`);
    console.log(`💳 Plans store: ✅ ${plansStore.filePath} (daily Fast reset: UTC)`);
    console.log(`🔐 Admin passkey: ${ADMIN_PASSKEY ? '✅ set' : '❌ missing ADMIN_PASSKEY'}`);
    const _as = auth.authStatus();
    console.log(`👤 Auth: db=${_as.database ? '✅' : '❌'} session=${_as.sessionSecret ? '✅' : '❌'} google=${_as.googleOAuth ? '✅' : '❌'} emailOtp=${_as.emailOtp ? '✅' : '❌'}`);
    console.log(`⏱️ Timeout: ${UPSTREAM_TIMEOUT_MS}ms`);
    console.log(`🛡️ Rate limit: ${RATE_LIMIT}/min per IP on /api/chat*`);
    console.log(`📱 PWA Support: ✅ Ready`);
    console.log('═══════════════════════════════');
});
