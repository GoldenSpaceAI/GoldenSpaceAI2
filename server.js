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
const {
    costFromProviderUsage,
    estimateCostFromTexts,
    extractTokenCounts
} = require('./pricing');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { extractUploadedFile, MAX_FILE_BYTES } = require('./fileExtract');
const { createAuth } = require('./auth');
const {
    sendPlanRequestReceivedEmail,
    sendPlanApprovedEmail,
    sendPlanDeclinedEmail,
    normalizeEmail: normalizeNotifyEmail
} = require('./mail');

const app = express();
// Render / reverse proxies set X-Forwarded-For
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 60000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
const plansStore = createPlansStore(DATA_DIR, {
    // Lazy: auth is assigned below; pool appears once DATABASE_URL is set.
    getPool: () => (auth && typeof auth.getPool === 'function' ? auth.getPool() : null)
});
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

// Pause gate: block non-admin pages/APIs while site is paused (admin stays reachable).
const PAUSE_ASSET_EXEMPT = new Set([
    '/theme.css',
    '/theme.js',
    '/logo.png',
    '/manifest.json',
    '/sw.js',
    '/offline.html',
    '/updating.html',
    '/favicon.ico'
]);

function isPauseExemptPath(pathname) {
    const p = String(pathname || '');
    if (p === '/admin-page' || p === '/admin-page.html') return true;
    if (p === '/admin-users' || p === '/admin-users.html') return true;
    if (p.startsWith('/api/admin/')) return true;
    if (PAUSE_ASSET_EXEMPT.has(p)) return true;
    return false;
}

function wantsHtmlPage(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/html')) return true;
    const p = req.path || '';
    if (p === '/' || p.endsWith('.html')) return true;
    // Pretty routes that map to HTML pages
    const pretty = [
        '/login', '/upgrade', '/my-plan', '/terms', '/privacy', '/refund',
        '/install', '/app-install'
    ];
    return pretty.includes(p);
}

function sendPausedPage(res) {
    res.status(503);
    res.setHeader('Retry-After', '120');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(__dirname, 'public', 'updating.html'));
}

app.use((req, res, next) => {
    try {
        if (!plansStore.isPaused()) return next();
    } catch (_) {
        return next();
    }
    if (isPauseExemptPath(req.path)) return next();
    if (wantsHtmlPage(req)) return sendPausedPage(res);
    if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(503).json({
            error: 'paused',
            message: 'Updating GoldenSpaceAI. Please wait and come back later.'
        });
    }
    // Non-API, non-HTML static assets for public pages stay blocked except exempt list
    if (req.method === 'GET' || req.method === 'HEAD') {
        return sendPausedPage(res);
    }
    return res.status(503).json({
        error: 'paused',
        message: 'Updating GoldenSpaceAI. Please wait and come back later.'
    });
});

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
    const deviceId = resolvePlanOwnerKey(req) || getClientId(req);
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
 * $ spend tracker for a chat request.
 * Budget is checked up-front via enforceChatCaps; actual USD is committed after
 * provider usage arrives (or estimated from text if usage is missing).
 */
function holdUsage(deviceId, kind) {
    let committed = false;
    return {
        commit(spend) {
            if (committed || !deviceId || !kind) return null;
            committed = true;
            try {
                return plansStore.recordSpend(deviceId, kind, spend || {});
            } catch (e) {
                console.error('recordSpend failed:', e.message);
                return null;
            }
        },
        rollback() {
            // No provisional hold under $ budgets — nothing to undo.
        }
    };
}

function messagesTextForEstimate(messages) {
    if (!Array.isArray(messages)) return '';
    return messages.map((m) => {
        if (!m) return '';
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
            return m.content.map((c) => (c && c.type === 'text' ? c.text : '')).join(' ');
        }
        return '';
    }).join('\n');
}

function spendFromUsageOrEstimate(model, usage, promptMessages, replyText) {
    const counts = extractTokenCounts(usage);
    if (counts.promptTokens > 0 || counts.completionTokens > 0) {
        return costFromProviderUsage(model, usage);
    }
    return estimateCostFromTexts(model, messagesTextForEstimate(promptMessages), replyText || '');
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

function hostnameFromUrl(raw) {
    try {
        const u = new URL(String(raw));
        return (u.hostname || '').replace(/^www\./i, '') || '';
    } catch (e) {
        return '';
    }
}

function normalizeSiteEntry(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') {
        const url = entry.trim();
        if (!/^https?:\/\//i.test(url)) return null;
        const domain = hostnameFromUrl(url);
        return domain ? { url, domain, title: domain } : null;
    }
    if (typeof entry !== 'object') return null;
    const url = String(entry.url || entry.uri || entry.href || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    const domain = hostnameFromUrl(url) || String(entry.domain || '').trim();
    if (!domain) return null;
    const title = String(entry.title || entry.label || entry.name || domain).trim() || domain;
    return { url, domain, title };
}

/** Collect real search/citation sites + reasoning snippets from a Responses API payload. Never invents URLs. */
function extractActivityFromResponses(responseData) {
    const sites = [];
    const seen = new Set();
    const pushSite = (entry) => {
        const site = normalizeSiteEntry(entry);
        if (!site) return;
        const key = site.url.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        sites.push(site);
    };

    if (!responseData || typeof responseData !== 'object') {
        return { sites, reasoning: '', text: '' };
    }

    // Top-level citations (xAI / agent tools): list of URL strings
    const topCitations = responseData.citations;
    if (Array.isArray(topCitations)) {
        topCitations.forEach((c) => pushSite(typeof c === 'string' ? c : c));
    }

    let text = '';
    if (typeof responseData.output_text === 'string' && responseData.output_text.trim()) {
        text = responseData.output_text;
    }

    const output = Array.isArray(responseData.output) ? responseData.output : [];
    for (const item of output) {
        if (!item || typeof item !== 'object') continue;

        // web_search_call / tool call actions may include open_page URLs or queries (query is not a site)
        if (item.type === 'web_search_call' || item.type === 'server_side_tool_call') {
            const action = item.action || item.web_search_call?.action || {};
            if (action.url) pushSite({ url: action.url, title: action.title || hostnameFromUrl(action.url) });
            if (Array.isArray(action.sources)) action.sources.forEach(pushSite);
            if (Array.isArray(action.urls)) action.urls.forEach(pushSite);
            if (Array.isArray(item.sources)) item.sources.forEach(pushSite);
        }

        if (item.type === 'message' || item.role === 'assistant') {
            const parts = Array.isArray(item.content) ? item.content : [];
            for (const part of parts) {
                if (!part || typeof part !== 'object') continue;
                const partText = part.text || part.output_text || '';
                if (!text && typeof partText === 'string' && partText.trim()) text = partText;
                const anns = part.annotations || part.citation || [];
                if (Array.isArray(anns)) {
                    anns.forEach((a) => {
                        if (!a) return;
                        if (a.type === 'url_citation' || a.url || a.url_citation) {
                            pushSite(a.url_citation || a);
                        }
                    });
                }
            }
            // Some payloads put annotations on the message itself
            if (Array.isArray(item.annotations)) {
                item.annotations.forEach((a) => pushSite(a.url_citation || a));
            }
        }

        // Reasoning summary items (when provider emits them)
        if (item.type === 'reasoning') {
            // collected below via reasoning fields
        }
    }

    let reasoning = '';
    const r = responseData.reasoning;
    if (r && typeof r === 'object') {
        if (typeof r.summary === 'string' && r.summary.trim() && r.summary !== 'detailed' && r.summary !== 'concise' && r.summary !== 'auto') {
            reasoning = r.summary.trim();
        }
        if (typeof r.content === 'string' && r.content.trim()) reasoning = (reasoning ? reasoning + '\n' : '') + r.content.trim();
    } else if (typeof r === 'string' && r.trim()) {
        reasoning = r.trim();
    }
    // Also scan output for reasoning text parts
    for (const item of output) {
        if (!item || item.type !== 'reasoning') continue;
        const parts = Array.isArray(item.summary) ? item.summary
            : (Array.isArray(item.content) ? item.content : []);
        for (const part of parts) {
            if (!part) continue;
            const t = typeof part === 'string' ? part : (part.text || part.content || '');
            if (typeof t === 'string' && t.trim()) {
                reasoning = (reasoning ? reasoning + '\n' : '') + t.trim();
            }
        }
    }

    if (!text) {
        const msg = output.find((o) => o && o.type === 'message');
        const c0 = msg && Array.isArray(msg.content) ? msg.content[0] : null;
        text = (c0 && (c0.text || c0.output_text)) || '';
    }

    return { sites, reasoning: reasoning.slice(0, 8000), text: text || '' };
}

function siteFromStreamEvent(evt) {
    if (!evt || typeof evt !== 'object') return null;
    // annotation.added
    const ann = evt.annotation || evt.url_citation || null;
    if (ann) return normalizeSiteEntry(ann.url_citation || ann);
    // output_item.done / added with web_search_call
    const item = evt.item || null;
    if (item && (item.type === 'web_search_call' || item.type === 'server_side_tool_call')) {
        const action = item.action || {};
        if (action.url) return normalizeSiteEntry({ url: action.url, title: action.title });
        if (Array.isArray(action.sources) && action.sources[0]) return normalizeSiteEntry(action.sources[0]);
    }
    if (evt.url) return normalizeSiteEntry(evt);
    return null;
}

function callResponsesAPI(conversationMessages, config, useWebSearch, opts) {
    const options = opts || {};
    const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    const wantStream = !!options.stream && !!onEvent;

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

        const body = {
            model: config.model,
            input: input,
            tools: tools,
            max_output_tokens: config.maxTokens,
            temperature: config.temperature
        };
        if (wantStream) body.stream = true;

        const payload = JSON.stringify(body);

        const reqOptions = {
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

        const req = https.request(reqOptions, (res) => {
            if (wantStream && res.statusCode < 400) {
                let buffer = '';
                let finalResponse = null;
                let textAcc = '';
                const siteSeen = new Set();

                const emitSite = (site) => {
                    if (!site) return;
                    const key = String(site.url || '').toLowerCase();
                    if (!key || siteSeen.has(key)) return;
                    siteSeen.add(key);
                    try { onEvent({ type: 'site', site }); } catch (e) {}
                };

                res.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                    const parts = buffer.split('\n');
                    buffer = parts.pop() || '';
                    for (let i = 0; i < parts.length; i++) {
                        const line = parts[i].trim();
                        if (!line || line.indexOf('data:') !== 0) continue;
                        const raw = line.slice(5).trim();
                        if (!raw || raw === '[DONE]') continue;
                        let evt;
                        try { evt = JSON.parse(raw); } catch (e) { continue; }
                        const et = String(evt.type || '');

                        if (et === 'response.web_search_call.in_progress' || et === 'response.web_search_call.searching') {
                            try { onEvent({ type: 'status', status: 'searching' }); } catch (e) {}
                        }
                        if (et === 'response.output_item.added' || et === 'response.output_item.done') {
                            const item = evt.item || {};
                            if (item.type === 'web_search_call' || item.type === 'server_side_tool_call') {
                                try { onEvent({ type: 'status', status: 'searching' }); } catch (e) {}
                                emitSite(siteFromStreamEvent(evt));
                                const action = item.action || {};
                                if (action.query && typeof action.query === 'string') {
                                    try { onEvent({ type: 'search_query', query: action.query.slice(0, 240) }); } catch (e) {}
                                }
                                if (Array.isArray(action.sources)) action.sources.forEach((s) => emitSite(normalizeSiteEntry(s)));
                                if (action.url) emitSite(normalizeSiteEntry(action));
                            }
                            if (item.type === 'reasoning') {
                                try { onEvent({ type: 'status', status: 'thinking' }); } catch (e) {}
                            }
                        }
                        if (et === 'response.output_text.annotation.added' || et.indexOf('annotation') !== -1) {
                            emitSite(siteFromStreamEvent(evt));
                        }
                        if (et === 'response.reasoning_summary_text.delta' || et === 'response.reasoning.delta') {
                            const d = evt.delta || evt.text || '';
                            if (d) {
                                try { onEvent({ type: 'reasoning', text: String(d) }); } catch (e) {}
                            }
                        }
                        if (et === 'response.output_text.delta') {
                            const d = evt.delta || '';
                            if (d) {
                                textAcc += d;
                                try { onEvent({ type: 'text', text: String(d) }); } catch (e) {}
                            }
                        }
                        if (et === 'response.completed') {
                            finalResponse = evt.response || evt;
                        }
                        // Some gateways wrap the whole object without type
                        if (!et && (evt.output || evt.output_text || evt.citations)) {
                            finalResponse = evt;
                        }
                    }
                });

                res.on('end', () => {
                    if (!finalResponse) {
                        finalResponse = { output_text: textAcc, citations: [] };
                    }
                    // Merge any late citations from completed payload
                    const meta = extractActivityFromResponses(finalResponse);
                    meta.sites.forEach(emitSite);
                    if (meta.reasoning) {
                        try { onEvent({ type: 'reasoning', text: meta.reasoning }); } catch (e) {}
                    }
                    if (!textAcc && meta.text) {
                        try { onEvent({ type: 'text', text: meta.text }); } catch (e) {}
                        textAcc = meta.text;
                    }
                    resolve(Object.assign({}, finalResponse, {
                        output_text: textAcc || meta.text || finalResponse.output_text || '',
                        _activity: extractActivityFromResponses(Object.assign({}, finalResponse, { output_text: textAcc || meta.text }))
                    }));
                });
                return;
            }

            // Non-streaming (or stream open failed with HTTP error body)
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        reject({ status: res.statusCode, message: json.error?.message || json.detail || 'Unknown error' });
                    } else {
                        const activity = extractActivityFromResponses(json);
                        json._activity = activity;
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




/** Expand stored attachedFile extract into model-facing user text (UI keeps content clean). */
function expandUserContentForModel(msg) {
    let text = (msg && typeof msg.content === 'string') ? msg.content : '';
    const af = msg && msg.attachedFile;
    if (af && typeof af.text === 'string' && af.text) {
        const noteLine = af.note ? ('\nNote: ' + af.note) : '';
        const fileBlock = '\n\n---\nAttached file: ' + (af.name || 'file') + noteLine +
            '\n```\n' + String(af.text).slice(0, 120000) + '\n```\n';
        text = (String(text).trim() || 'Please review the attached file.') + fileBlock;
    }
    return text;
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
                const modelText = expandUserContentForModel(msg);
                if (modelText && modelText.trim()) {
                    content.push({ type: 'text', text: modelText.trim() });
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


// ==================== PREMIUM TTS (OpenAI) ====================
const TTS_VOICES = [
    { id: 'nova', label: 'Nova', desc: 'Warm & friendly' },
    { id: 'alloy', label: 'Alloy', desc: 'Neutral & clear' },
    { id: 'shimmer', label: 'Shimmer', desc: 'Soft & expressive' },
    { id: 'echo', label: 'Echo', desc: 'Soft male' },
    { id: 'fable', label: 'Fable', desc: 'Storyteller' },
    { id: 'onyx', label: 'Onyx', desc: 'Deep & steady' }
];
const TTS_VOICE_IDS = new Set(TTS_VOICES.map((v) => v.id));
const TTS_MAX_CHARS = 4000;
const ttsRateBuckets = new Map();
const TTS_RATE_LIMIT = 20;
const TTS_RATE_WINDOW_MS = 60 * 1000;

function ttsRateLimit(req, res) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    const now = Date.now();
    let bucket = ttsRateBuckets.get(ip);
    if (!bucket || now - bucket.start >= TTS_RATE_WINDOW_MS) {
        bucket = { start: now, count: 0 };
        ttsRateBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > TTS_RATE_LIMIT) {
        res.status(429).json({ error: 'Too many speak requests. Please wait a minute.', fallback: true });
        return false;
    }
    return true;
}

function openaiTtsReady() {
    return !!(openaiClient && process.env.OPENAI_API_KEY);
}

app.get('/api/tts/status', (req, res) => {
    res.json({
        provider: openaiTtsReady() ? 'openai' : 'browser',
        openai: openaiTtsReady(),
        model: openaiTtsReady() ? 'tts-1-hd' : null,
        voices: TTS_VOICES,
        defaultVoice: 'nova',
        maxChars: TTS_MAX_CHARS
    });
});

app.post('/api/tts', async (req, res) => {
    try {
        if (!ttsRateLimit(req, res)) return;
        if (!openaiTtsReady()) {
            return res.status(503).json({
                error: 'OpenAI TTS not configured',
                fallback: true,
                provider: 'browser'
            });
        }
        const raw = String(req.body?.text || '').trim();
        if (!raw) return res.status(400).json({ error: 'Missing text', fallback: true });
        const text = raw.length > TTS_MAX_CHARS ? raw.slice(0, TTS_MAX_CHARS) : raw;
        const voiceRaw = String(req.body?.voice || 'nova').trim().toLowerCase();
        const voice = TTS_VOICE_IDS.has(voiceRaw) ? voiceRaw : 'nova';

        const speech = await openaiClient.audio.speech.create({
            model: 'tts-1-hd',
            voice,
            input: text,
            response_format: 'mp3'
        });
        const buf = Buffer.from(await speech.arrayBuffer());
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-TTS-Provider', 'openai');
        res.setHeader('X-TTS-Voice', voice);
        return res.send(buf);
    } catch (e) {
        console.error('TTS error:', e.message || e);
        return res.status(502).json({
            error: 'TTS failed',
            fallback: true,
            provider: 'browser',
            detail: String(e.message || e).slice(0, 200)
        });
    }
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
                const activity = responseData._activity || extractActivityFromResponses(responseData);
                reply = responseData.output_text ||
                    activity.text ||
                    responseData.output?.find(o => o.type === 'message')?.content?.[0]?.text ||
                    'No response generated.';
                return {
                    reply,
                    provider,
                    modelName: config.model,
                    activity,
                    usage: responseData.usage || null
                };
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
                return { reply, provider, modelName: config.model, usage: completion?.usage || null };
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
                return { reply, provider, modelName: config.model, usage: completion?.usage || null };
            }
        });

        let reply = softCleanLatex(result.reply);
        if (!String(reply).trim()) {
            return res.status(502).json({
                reply: mapApiError({ message: 'empty reply' }, result.provider),
                model: 'Error'
            });
        }

        console.log(`Response: ${String(reply).length} chars | provider=${result.provider}`);
        if (usageHold) {
            const spend = spendFromUsageOrEstimate(
                result.modelName || target.config.model,
                result.usage,
                conversationMessages,
                reply
            );
            const recorded = usageHold.commit(spend);
            console.log(`Spend: ${spend.costUsd.toFixed(6)} model=${spend.model} tokens=${spend.promptTokens}+${spend.completionTokens}${recorded && recorded.demoted ? ' (demoted→free)' : ''}`);
        }
        keepUsage = true;
        const chatPayload = { reply, model: safeMode, provider: result.provider };
        if (result.activity && (result.activity.sites?.length || result.activity.reasoning)) {
            chatPayload.sites = result.activity.sites || [];
            if (result.activity.reasoning) chatPayload.reasoning = result.activity.reasoning;
        }
        res.json(chatPayload);

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

        // Expert: Responses API (prefer stream so search/thinking events surface live)
        if (safeMode === 'expert') {
            try {
                sendSse({ status: useWebSearch ? 'searching' : 'researching' });
                const collectedSites = [];
                const siteKeys = new Set();
                let reasoningAcc = '';
                let streamedText = '';
                let emittedGenerating = false;

                const pushSiteSse = (site) => {
                    const normalized = normalizeSiteEntry(site);
                    if (!normalized) return;
                    const key = normalized.url.toLowerCase();
                    if (siteKeys.has(key)) return;
                    siteKeys.add(key);
                    collectedSites.push(normalized);
                    sendSse({ site: normalized, sites: collectedSites.slice(), status: 'searching' });
                };

                const onEvent = (evt) => {
                    if (!evt || typeof evt !== 'object') return;
                    if (evt.type === 'status' && evt.status) sendSse({ status: evt.status });
                    if (evt.type === 'site' && evt.site) pushSiteSse(evt.site);
                    if (evt.type === 'search_query' && evt.query) {
                        sendSse({ searchQuery: String(evt.query).slice(0, 240), status: 'searching' });
                    }
                    if (evt.type === 'reasoning' && evt.text) {
                        reasoningAcc += evt.text;
                        sendSse({ reasoning: evt.text, status: 'thinking' });
                    }
                    if (evt.type === 'text' && evt.text) {
                        if (!emittedGenerating) {
                            emittedGenerating = true;
                            sendSse({ status: 'generating' });
                        }
                        streamedText += evt.text;
                        sendSse({ text: evt.text });
                    }
                };

                let responseData;
                try {
                    responseData = await withTimeout(
                        callResponsesAPI(conversationMessages, config, useWebSearch, {
                            stream: true,
                            onEvent
                        }),
                        UPSTREAM_TIMEOUT_MS,
                        'Expert stream'
                    );
                } catch (streamErr) {
                    console.warn('Expert Responses stream failed — falling back to non-stream:', streamErr.message || streamErr);
                    responseData = await withTimeout(
                        callResponsesAPI(conversationMessages, config, useWebSearch),
                        UPSTREAM_TIMEOUT_MS,
                        'Expert stream fallback'
                    );
                }

                const activity = responseData._activity || extractActivityFromResponses(responseData);
                (activity.sites || []).forEach(pushSiteSse);
                if (activity.reasoning && !reasoningAcc) {
                    reasoningAcc = activity.reasoning;
                    sendSse({ reasoning: activity.reasoning, status: 'thinking' });
                }

                let reply = streamedText ||
                    responseData.output_text ||
                    activity.text ||
                    responseData.output?.find(o => o.type === 'message')?.content?.[0]?.text ||
                    'No response generated.';
                reply = softCleanLatex(reply);

                // If stream already sent text deltas, avoid duplicating; otherwise emit once
                if (!streamedText.trim() && reply && reply !== 'No response generated.') {
                    sendSse({ status: 'generating' });
                    sendSse({ text: reply });
                } else if (streamedText.trim() && softCleanLatex(streamedText) !== reply) {
                    // Soft-clean may have adjusted latex — send full cleaned as authoritative
                    sendSse({ full: reply });
                }

                if (String(reply).trim() && reply !== 'No response generated.') {
                    if (usageHold) {
                        const spend = spendFromUsageOrEstimate(
                            config.model,
                            responseData.usage,
                            conversationMessages,
                            reply
                        );
                        const recorded = usageHold.commit(spend);
                        console.log(`Spend: ${spend.costUsd.toFixed(6)} model=${spend.model} tokens=${spend.promptTokens}+${spend.completionTokens}${recorded && recorded.demoted ? ' (demoted→free)' : ''}`);
                    }
                    keepUsage = true;
                }
                sendSse({
                    done: true,
                    model: safeMode,
                    provider,
                    full: reply,
                    sites: collectedSites.slice(),
                    reasoning: reasoningAcc ? reasoningAcc.slice(0, 8000) : undefined
                });
                console.log(`Stream done (expert): ${String(reply).length} chars | sites=${collectedSites.length}`);
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
                stream_options: { include_usage: true }
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
            return {
                text: completion?.choices?.[0]?.message?.content || '',
                usage: completion?.usage || null,
                model: activeConfig.model
            };
        }

        function commitStreamSpend(modelName, usage, replyText) {
            if (!usageHold || isAutoTitleRequest(req.body)) return;
            const spend = spendFromUsageOrEstimate(
                modelName || config.model,
                usage,
                conversationMessages,
                replyText || ''
            );
            const recorded = usageHold.commit(spend);
            console.log(`Spend: ${spend.costUsd.toFixed(6)} model=${spend.model} tokens=${spend.promptTokens}+${spend.completionTokens}${recorded && recorded.demoted ? ' (demoted→free)' : ''}`);
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
            let streamUsage = null;
            for await (const chunk of stream) {
                if (clientClosed) break;
                if (chunk && chunk.usage) streamUsage = chunk.usage;
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
                    const fb = await nonStreamCompletion(client, config, 'Stream fallback');
                    full = fb.text || '';
                    if (fb.usage) streamUsage = fb.usage;
                    if (full) sendSse({ text: full });
                } catch (fbErr) {
                    if (provider === 'openai' && allowGrokFallback && shouldFallbackOpenAIToGrok(fbErr)) {
                        console.warn('OpenAI empty-stream fallback failed — trying Grok');
                        provider = 'grok';
                        config = { ...config, model: GROK_FAST_MODEL, provider: 'grok' };
                        client = grok;
                        usedGrokFallback = true;
                        const fb2 = await nonStreamCompletion(client, config, 'Stream Grok fallback');
                        full = fb2.text || '';
                        if (fb2.usage) streamUsage = fb2.usage;
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
                    commitStreamSpend(config.model, streamUsage, cleaned);
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
                    const recovered = await nonStreamCompletion(client, config, 'Abort recovery');
                    const text = recovered && recovered.text;
                    if (text) {
                        const cleanedAbort = softCleanLatex(text);
                        sendSse({ text: cleanedAbort });
                        if (String(cleanedAbort).trim()) {
                            commitStreamSpend(config.model, recovered.usage, cleanedAbort);
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
                    const rescued = await nonStreamCompletion(client, config, 'Grok rescue');
                    const text = rescued && rescued.text;
                    if (text) {
                        const cleanedRescue = softCleanLatex(text);
                        sendSse({ text: cleanedRescue });
                        if (String(cleanedRescue).trim()) {
                            commitStreamSpend(config.model, rescued.usage, cleanedRescue);
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

/** Best-effort client IP (Render / Cloudflare / direct). */
function clientIp(req) {
    const xf = (req.headers['x-forwarded-for'] || '').toString();
    if (xf) {
        const first = xf.split(',')[0].trim();
        if (first) return first.slice(0, 64);
    }
    const real = (req.headers['x-real-ip'] || '').toString().trim();
    if (real) return real.slice(0, 64);
    const cf = (req.headers['cf-connecting-ip'] || '').toString().trim();
    if (cf) return cf.slice(0, 64);
    const ip = (req.ip || '').toString().trim();
    return ip ? ip.slice(0, 64) : '';
}

function isPrivateOrLocalIp(ip) {
    const s = String(ip || '').trim().toLowerCase();
    if (!s || s === 'unknown' || s === '::1' || s === '127.0.0.1') return true;
    if (s.startsWith('10.') || s.startsWith('192.168.') || s.startsWith('127.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(s)) return true;
    if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80:')) return true;
    if (s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.')) return true;
    return false;
}

/**
 * Free IP geolocation via ipwho.is (no API key). Results cached in plans store.
 */
function lookupIpGeo(ip) {
    return new Promise((resolve) => {
        const key = String(ip || '').trim();
        if (!key) return resolve(null);
        if (isPrivateOrLocalIp(key)) {
            return resolve({
                city: null,
                region: null,
                country: 'Private / local network',
                countryCode: null,
                label: 'Private / local network',
                lookedUpAt: new Date().toISOString(),
                source: 'local'
            });
        }
        const cached = plansStore.getCachedGeo(key);
        if (cached && cached.label) return resolve(cached);

        const url = 'https://ipwho.is/' + encodeURIComponent(key);
        const req = https.get(url, { timeout: 4000 }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; if (raw.length > 20000) res.destroy(); });
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw || '{}');
                    if (!data || data.success === false) return resolve(null);
                    const geo = {
                        city: data.city || null,
                        region: data.region || null,
                        country: data.country || null,
                        countryCode: data.country_code || null,
                        label: null,
                        lookedUpAt: new Date().toISOString(),
                        source: 'ipwho.is'
                    };
                    geo.label = plansStore.formatGeoLabel(geo) || data.country || key;
                    try { plansStore.setCachedGeo(key, geo); } catch (_) {}
                    resolve(geo);
                } catch (_) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    });
}

async function ensurePaymentGeo(payment) {
    if (!payment) return payment;
    if (payment.geo && payment.geo.label) return payment;
    if (!payment.ip) return payment;
    const cached = plansStore.getCachedGeo(payment.ip);
    if (cached && cached.label) {
        try { plansStore.attachGeoToPayment(payment.id, cached); } catch (_) {}
        payment.geo = cached;
        payment.location = cached.label;
        return payment;
    }
    const geo = await lookupIpGeo(payment.ip);
    if (geo) {
        try { plansStore.attachGeoToPayment(payment.id, geo); } catch (_) {}
        payment.geo = geo;
        payment.location = geo.label || plansStore.formatGeoLabel(geo) || null;
    }
    return payment;
}

function requireClientId(req, res) {
    const id = getClientId(req);
    if (!id) {
        res.status(400).json({ error: 'Missing or invalid X-Client-Id header' });
        return null;
    }
    return id;
}

/** Plan/subscription owner: u_<userId> when logged in, else X-Client-Id (guest). */
function resolvePlanOwnerKey(req) {
    const user = auth && auth.readUserFromReq(req);
    const deviceId = getClientId(req);
    if (user && user.id) {
        try {
            plansStore.syncAccountPlan(deviceId, user.id, user.email);
        } catch (e) {
            console.error('syncAccountPlan:', e.message);
        }
        return plansStore.accountOwnerKey(user.id);
    }
    return deviceId || '';
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

/**
 * Chat sync is account-only: owner key is always u_<userId>.
 * Guests have no cloud chat memory (ephemeral client-only). Plans still use device id.
 */
function resolveChatOwnerKey(req, res) {
    const user = auth.readUserFromReq(req);
    if (user && user.id) return 'u_' + user.id;
    res.status(401).json({ error: 'Login required to sync chats', guest: true });
    return null;
}

/** Guest-safe list: empty without requiring login (refresh must not restore cloud guest history). */
function resolveChatOwnerKeyOrGuestEmpty(req) {
    const user = auth.readUserFromReq(req);
    if (user && user.id) return { ownerKey: 'u_' + user.id, guest: false };
    return { ownerKey: null, guest: true };
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

function chatTs(c) {
    return String((c && (c.updatedAt || c.createdAt)) || '');
}

/** Union PG + JSON lists so Oregon JSON fallback is never hidden by an empty PG result. */
function mergeChatMetaLists(primary, secondary) {
    const byId = new Map();
    for (const list of [secondary || [], primary || []]) {
        for (const c of list) {
            if (!c || !c.id) continue;
            const prev = byId.get(c.id);
            if (!prev || chatTs(c) > chatTs(prev)) byId.set(c.id, c);
        }
    }
    return Array.from(byId.values()).sort((a, b) => chatTs(b).localeCompare(chatTs(a)));
}

async function migrateJsonChatsToPostgres(ownerKey) {
    if (!ownerKey || !auth) return { migrated: 0 };
    const store = readStore();
    const from = store[ownerKey] || {};
    const ids = Object.keys(from);
    if (!ids.length) return { migrated: 0 };
    let migrated = 0;
    for (const id of ids) {
        const chat = from[id];
        if (!chat) continue;
        try {
            const ok = await auth.upsertChat(ownerKey, id, {
                name: chat.name || 'New Chat',
                messages: Array.isArray(chat.messages) ? chat.messages : [],
                createdAt: chat.createdAt || new Date().toISOString(),
                updatedAt: chat.updatedAt || chat.createdAt || new Date().toISOString(),
                named: !!chat.named,
                customInstructions: chat.customInstructions || '',
                systemPrompt: chat.systemPrompt || ''
            });
            if (ok) migrated += 1;
        } catch (e) {
            console.error('migrate json→pg:', e.message);
        }
    }
    if (migrated > 0) {
        try {
            delete store[ownerKey];
            writeStore(store);
        } catch (e) {
            console.error('clear json after migrate:', e.message);
        }
    }
    return { migrated };
}

app.get('/api/chats', async (req, res) => {
    const resolved = resolveChatOwnerKeyOrGuestEmpty(req);
    if (resolved.guest) {
        return res.json({ chats: [], ownerKeyPrefix: 'guest', guest: true, persist: false });
    }
    const ownerKey = resolved.ownerKey;
    const user = auth.readUserFromReq(req);
    // Repair chats stuck under linked device keys (failed historical merges).
    if (user && user.id) {
        try { await auth.mergeAllLinkedDeviceChats(user.id); } catch (e) {
            console.error('list merge linked:', e.message);
        }
    }
    // Lift any JSON-only account chats into Postgres when available (Oregon split-brain fix).
    try { await migrateJsonChatsToPostgres(ownerKey); } catch (e) {
        console.error('list migrate json:', e.message);
    }
    let pgList = null;
    try {
        pgList = await auth.listChats(ownerKey);
    } catch (e) {
        console.error('pg listChats:', e.message);
    }
    const jsonList = listChatsFromJson(ownerKey);
    const chats = mergeChatMetaLists(pgList || [], jsonList);
    res.json({
        chats,
        ownerKeyPrefix: 'user',
        guest: false,
        persist: true,
        storage: pgList ? 'postgres+json' : 'json'
    });
});

app.get('/api/chats/:id', async (req, res) => {
    const ownerKey = resolveChatOwnerKey(req, res);
    if (!ownerKey) return;
    try {
        const pgChat = await auth.getChat(ownerKey, req.params.id);
        if (pgChat === null) {
            // pg unavailable → json
        } else if (pgChat) {
            return res.json(pgChat);
        }
        // pg ok but miss → still try JSON (pre-migrate / split-brain)
    } catch (e) {
        console.error('pg getChat:', e.message);
    }
    const store = readStore();
    const chat = store[ownerKey]?.[req.params.id];
    if (!chat) return res.status(404).json({ error: 'Not found' });
    // Opportunistic lift into Postgres so the next device sees it.
    try {
        await auth.upsertChat(ownerKey, req.params.id, {
            name: chat.name || 'New Chat',
            messages: Array.isArray(chat.messages) ? chat.messages : [],
            createdAt: chat.createdAt || new Date().toISOString(),
            updatedAt: chat.updatedAt || chat.createdAt || new Date().toISOString(),
            named: !!chat.named,
            customInstructions: chat.customInstructions || '',
            systemPrompt: chat.systemPrompt || ''
        });
    } catch (_) {}
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
    if (!user) return res.status(401).json({ ok: false, error: 'Not logged in' });
    const deviceId = getClientId(req);
    if (!deviceId) return res.status(400).json({ ok: false, error: 'Missing X-Client-Id' });
    try {
        await auth.linkDevice(user.id, deviceId);
        const pg = await auth.mergeDeviceChatsToUser(deviceId, user.id);
        const json = mergeJsonDeviceToUser(deviceId, 'u_' + user.id);
        const linked = await auth.mergeAllLinkedDeviceChats(user.id);
        try { await migrateJsonChatsToPostgres('u_' + user.id); } catch (_) {}
        let planSync = null;
        try {
            planSync = plansStore.syncAccountPlan(deviceId, user.id, user.email);
        } catch (e) {
            console.error('merge-device plan sync:', e.message);
        }
        res.json({ ok: true, postgres: pg, json, linked, planSync });
    } catch (e) {
        console.error('merge-device:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ==================== PLANS / UPGRADE / ADMIN ====================
app.get('/api/plan', (req, res) => {
    const ownerKey = resolvePlanOwnerKey(req);
    // Public payload: percent quotas only (no $ spend / token counts for end users)
    sendFreshJson(res, plansStore.getPlanPublic(ownerKey));
});

app.get('/api/plan-status', (req, res) => {
    const ownerKey = resolvePlanOwnerKey(req);
    sendFreshJson(res, plansStore.getPlanStatusUi(ownerKey));
});

app.get('/api/my-plan', (req, res) => {
    const deviceId = getClientId(req);
    const sessionUser = auth && auth.readUserFromReq(req);
    if (sessionUser && sessionUser.id) {
        sendFreshJson(res, plansStore.getMyPlan(plansStore.accountOwnerKey(sessionUser.id), {
            deviceId,
            userId: sessionUser.id,
            email: sessionUser.email
        }));
        return;
    }
    // Guests: device-local payment history only
    sendFreshJson(res, plansStore.getMyPlan(deviceId, { deviceId }));
});

app.post('/api/upgrade/request', async (req, res) => {
    const sessionUser = auth && auth.readUserFromReq(req);
    if (!sessionUser || !sessionUser.id) {
        return res.status(401).json({
            ok: false,
            error: 'Log in to request an upgrade.',
            loginUrl: '/login'
        });
    }
    const deviceId = getClientId(req);
    if (!deviceId) {
        return res.status(400).json({ ok: false, error: 'Missing or invalid X-Client-Id header' });
    }
    const body = req.body || {};
    if (!body.acceptedPolicies) {
        return res.status(400).json({ ok: false, error: 'You must accept Terms, Privacy, and Refund policies.' });
    }
    const email = normalizeNotifyEmail(sessionUser.email);
    if (!email) {
        return res.status(400).json({
            ok: false,
            error: 'Your account has no email. Sign in with Google or email OTP, then try again.'
        });
    }
    const ownerKey = plansStore.accountOwnerKey(sessionUser.id);
    const currentPlan = (plansStore.getEffectivePlan(ownerKey).plan || 'free');
    const ip = clientIp(req);
    const result = plansStore.createPaymentRequest({
        deviceId,
        plan: body.plan,
        phone: body.phone,
        email,
        userId: sessionUser.id,
        ip,
        currentPlan
    });
    if (!result.ok) {
        return res.status(400).json(result);
    }
    try { await plansStore.flushAsync(); } catch (e) {
        console.error('plans flush after upgrade request:', e.message);
    }
    // Resolve & cache estimated location from request IP (best-effort, never blocks response).
    if (result.payment && result.payment.ip && !result.already) {
        ensurePaymentGeo(result.payment).then(() =>
            plansStore.flushAsync().catch(() => {})
        ).catch((e) => console.error('upgrade geo lookup:', e.message));
    }
    // Notify on new waiting requests, or when an existing waiting request first receives an email.
    if (result.payment && result.payment.email && (!result.already || result.emailAttached)) {
        sendPlanRequestReceivedEmail(result.payment).catch((e) =>
            console.error('plan request email:', e.message)
        );
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
            email: result.payment.email,
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

app.get('/api/admin/payments', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const payments = plansStore.listPaymentsAdmin();
    // Fill missing geo for rows that have an IP (cached after first lookup).
    const needGeo = payments.filter(p => p.ip && !(p.geo && p.geo.label));
    if (needGeo.length) {
        const batch = needGeo.slice(0, 15); // avoid stampeding free API
        await Promise.all(batch.map(async (p) => {
            try {
                await ensurePaymentGeo(p);
                const refreshed = plansStore.listPaymentsAdmin().find(x => x.id === p.id);
                if (refreshed) {
                    p.geo = refreshed.geo;
                    p.location = refreshed.location;
                }
            } catch (e) {
                console.error('admin geo:', e.message);
            }
        }));
        try { await plansStore.flushAsync(); } catch (_) {}
    }
    res.json({ payments });
});

app.post('/api/admin/payments/:id/approve', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const result = plansStore.approvePayment(req.params.id);
    if (!result.ok) return res.status(404).json(result);
    try { await plansStore.flushAsync(); } catch (e) {
        console.error('plans flush after approve:', e.message);
    }
    if (!result.already && result.payment) {
        sendPlanApprovedEmail(result.payment).catch((e) =>
            console.error('plan approved email:', e.message)
        );
    }
    res.json(result);
});

app.post('/api/admin/payments/:id/decline', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) {
        return res.status(400).json({ ok: false, error: 'Decline reason is required' });
    }
    const result = plansStore.declinePayment(req.params.id, { reason });
    if (!result.ok) return res.status(result.error === 'Not found' ? 404 : 400).json(result);
    try { await plansStore.flushAsync(); } catch (e) {
        console.error('plans flush after decline:', e.message);
    }
    if (!result.already && result.payment) {
        sendPlanDeclinedEmail(result.payment).catch((e) =>
            console.error('plan declined email:', e.message)
        );
    }
    res.json(result);
});

app.get('/api/admin/pause', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ ok: true, ...plansStore.getPauseState() });
});

app.post('/api/admin/pause', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = req.body || {};
    const paused = body.paused === true || body.paused === 'true' || body.paused === 1;
    const state = plansStore.setPaused(paused, { by: 'admin' });
    try { await plansStore.flushAsync(); } catch (e) {
        console.error('plans flush after pause toggle:', e.message);
    }
    res.json({ ok: true, ...state });
});

app.get('/api/admin/users', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    let accounts = [];
    let authError = null;
    if (auth && typeof auth.listUsersForAdmin === 'function') {
        try {
            const listed = await auth.listUsersForAdmin();
            if (listed && listed.ok) {
                accounts = listed.users || [];
            } else {
                authError = (listed && listed.error) || 'Auth list failed';
            }
        } catch (e) {
            console.error('admin users list:', e.message);
            authError = e.message || 'Auth list failed';
        }
    } else {
        authError = 'Auth not configured';
    }
    const users = plansStore.listUsersAdmin({ accounts });
    // Best-effort geo fill for rows that only have a payment IP
    const needGeo = users.filter(u => u.ip && !(u.geo && u.geo.label));
    if (needGeo.length) {
        const batch = needGeo.slice(0, 15);
        await Promise.all(batch.map(async (u) => {
            try {
                const geo = await lookupIpGeo(u.ip);
                if (geo) {
                    try { plansStore.setCachedGeo(u.ip, geo); } catch (_) {}
                    u.geo = geo;
                    u.location = plansStore.formatGeoLabel(geo) || geo.label || null;
                    u.locationLabel = u.location || ('IP ' + u.ip);
                    u.locationSource = 'geo_cache';
                }
            } catch (e) {
                console.error('admin users geo:', e.message);
            }
        }));
        try { await plansStore.flushAsync(); } catch (_) {}
    }
    res.json({
        ok: true,
        users,
        meta: {
            accountCount: accounts.length,
            authError: authError || null,
            gaps: [
                'No dedicated last-login IP / user-agent on users table',
                'Location from last payment request IP geo (or cached IP) when available',
                'Device from device_links (most recent) else last payment deviceId',
                'Today/total tokens+$ from persisted usage (UTC day); totals seeded from period spend for older rows'
            ]
        }
    });
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

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
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

app.get('/admin-users', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-users.html'));
});
app.get('/admin-users.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-users.html'));
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
        ttsProvider: openaiTtsReady() ? 'openai' : 'browser',
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

async function startServer() {
    let plansPersist = { source: 'pending', pg: false };
    try {
        if (auth && typeof auth.ensureSchema === 'function') {
            await auth.ensureSchema();
        }
        plansPersist = await plansStore.initPersistence();
        console.log('💳 Plans persistence:', plansPersist);
    } catch (e) {
        console.error('Plans persistence init failed (JSON fallback):', e.message);
    }

    app.listen(PORT, () => {
        const pi = plansStore.getPersistenceInfo ? plansStore.getPersistenceInfo() : {};
        console.log('═══════════════════════════════');
        console.log('🚀 GoldenSpaceAI Server');
        console.log(`📡 Port: ${PORT}`);
        console.log(`⚡ Fast: pref=${FAST_PROVIDER_PREF || 'grok-default'} | OpenAI ${OPENAI_FAST_MODEL} (${process.env.OPENAI_API_KEY ? 'key ✅' : 'key ❌'}) | Grok ${GROK_FAST_MODEL} (${process.env.GROK_API_KEY ? 'key ✅' : 'key ❌'})`);
        console.log(`🧠 Thinking/Expert: Grok (key ${process.env.GROK_API_KEY ? '✅' : '❌'})`);
        console.log(`📜 History window: ${HISTORY_WINDOW} messages`);
        console.log(`📐 Math Cleaner: ✅`);
        console.log(`📡 Streaming: ✅ /api/chat/stream`);
        console.log(`🔊 TTS: ${openaiTtsReady() ? 'OpenAI tts-1-hd ✅' : 'browser fallback (no OPENAI_API_KEY)'}`);
        console.log(`💾 Persistence: ✅ ${CHATS_FILE}`);
        console.log(`💳 Plans store: ✅ ${pi.pg ? 'postgres' : 'json'} (${pi.source || plansPersist.source}) + ${plansStore.filePath} (daily Fast reset: UTC)`);
        console.log(`🔐 Admin passkey: ${ADMIN_PASSKEY ? '✅ set' : '❌ missing ADMIN_PASSKEY'}`);
        const _as = auth.authStatus();
        console.log(`👤 Auth: db=${_as.database ? '✅' : '❌'} session=${_as.sessionSecret ? '✅' : '❌'} google=${_as.googleOAuth ? '✅' : '❌'} emailOtp=${_as.emailOtp ? '✅' : '❌'}`);
        console.log(`⏱️ Timeout: ${UPSTREAM_TIMEOUT_MS}ms`);
        console.log(`🛡️ Rate limit: ${RATE_LIMIT}/min per IP on /api/chat*`);
        console.log(`📱 PWA Support: ✅ Ready`);
        console.log('═══════════════════════════════');
    });
}

startServer().catch((e) => {
    console.error('Failed to start server:', e);
    process.exit(1);
});
