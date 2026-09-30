const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 60000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');

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
app.use(cors(corsOptions));
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
        openaiClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            timeout: UPSTREAM_TIMEOUT_MS,
        });
    } catch (e) {
        console.error('Failed to initialize OpenAI client:', e.message);
    }
}

const HISTORY_WINDOW = 40;
const OPENAI_FAST_MODEL = process.env.OPENAI_FAST_MODEL || 'gpt-4o-mini';

const MODELS = {
    // Fast → OpenAI gpt-4o-mini (vision-capable). Thinking/expert stay on Grok.
    normal: { model: OPENAI_FAST_MODEL, maxTokens: 2048, temperature: 0.7, provider: 'openai' },
    fast: { model: OPENAI_FAST_MODEL, maxTokens: 2048, temperature: 0.7, provider: 'openai' },
    smart: { model: 'grok-4.3', maxTokens: 4096, temperature: 0.3, provider: 'grok' },
    expert: { model: 'grok-4.20-multi-agent-0309', maxTokens: 4096, temperature: 0.5, provider: 'grok' }
};

function resolveMode(mode) {
    const key = mode === 'fast' ? 'normal' : (mode || 'normal');
    return { safeMode: key === 'fast' ? 'normal' : (MODELS[key] ? key : 'normal'), config: MODELS[key] || MODELS.normal };
}

// ==================== MATH CLEANER ====================
// Soft clean: keep $ / $$ for KaTeX on the client; strip noisy wrappers only lightly.
function softCleanLatex(text) {
    if (!text) return text;
    return text
        .replace(/\\boxed\{([^}]+)\}/g, '$$$$1$$')
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
    const raw = String(error?.message || error || '');
    const clean = raw.split('\n')[0].replace(/\s+at\s+.*/g, '').substring(0, 160);
    const who = provider === 'openai' ? 'OpenAI' : 'Grok';

    if (error?.code === 'missing_openai_key') {
        return '🔑 Fast mode needs OPENAI_API_KEY. Set it in Render environment variables, then redeploy.';
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
    if (/ECONNRESET|ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(raw)) {
        return '⚠️ Network error reaching ' + who + '. Check connectivity and try again.';
    }
    if (/empty reply|no response/i.test(raw)) {
        return '⚠️ The model returned an empty reply. Tap Retry or switch mode.';
    }
    if (clean) return '⚠️ ' + clean;
    return '⚠️ Something went wrong. Please try again.';
}

function requireProviderKey(safeMode, config) {
    if (config.provider === 'openai') {
        if (!process.env.OPENAI_API_KEY || !openaiClient) {
            const err = new Error('OPENAI_API_KEY missing');
            err.code = 'missing_openai_key';
            err.status = 401;
            throw err;
        }
        return openaiClient;
    }
    if (!process.env.GROK_API_KEY) {
        const err = new Error('GROK_API_KEY missing');
        err.code = 'missing_grok_key';
        err.status = 401;
        throw err;
    }
    return grok;
}

// ==================== MAIN CHAT ENDPOINT (non-streaming, compatibility) ====================
app.post('/api/chat', async (req, res) => {
    try {
        const { mode, webSearch } = req.body;
        const { safeMode, config } = resolveMode(mode);
        let client;
        try {
            client = requireProviderKey(safeMode, config);
        } catch (keyErr) {
            return res.status(401).json({
                reply: mapApiError(keyErr, config.provider),
                model: 'Error'
            });
        }

        const conversationMessages = buildConversationMessages(req.body);
        const useWebSearch = webSearch === true;

        console.log(`Mode: ${safeMode} | Provider: ${config.provider} | Model: ${config.model} | Web: ${useWebSearch ? 'ON' : 'OFF'} | msgs: ${conversationMessages.length}`);

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
            // Fast (normal): OpenAI gpt-4o-mini with multimodal content parts
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

        reply = softCleanLatex(reply);
        if (!String(reply).trim()) {
            return res.status(502).json({
                reply: mapApiError({ message: 'empty reply' }, config.provider),
                model: 'Error'
            });
        }

        console.log(`Response: ${String(reply).length} chars`);
        res.json({ reply, model: safeMode, provider: config.provider });

    } catch (error) {
        const modeInfo = resolveMode(req.body?.mode);
        console.error('Chat API Error:', error.message || error, error.status || '');
        const status = error.status === 401 ? 401 : error.status === 429 ? 429 : 500;
        res.status(status).json({ reply: mapApiError(error, modeInfo.config.provider), model: 'Error' });
    }
});

// ==================== STREAMING CHAT ENDPOINT ====================
app.post('/api/chat/stream', async (req, res) => {
    const sendSse = (obj) => {
        try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {}
    };

    try {
        const { mode, webSearch } = req.body;
        const { safeMode, config } = resolveMode(mode);
        let client;
        try {
            client = requireProviderKey(safeMode, config);
        } catch (keyErr) {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            sendSse({ error: mapApiError(keyErr, config.provider) });
            sendSse({ done: true });
            return res.end();
        }

        const conversationMessages = buildConversationMessages(req.body);
        const useWebSearch = webSearch === true;

        console.log(`Stream: ${safeMode} | Provider: ${config.provider} | Model: ${config.model} | Web: ${useWebSearch ? 'ON' : 'OFF'} | msgs: ${conversationMessages.length}`);

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        // Expert: non-streaming Responses API, emit as one chunk
        if (safeMode === 'expert') {
            try {
                const responseData = await withTimeout(
                    callResponsesAPI(conversationMessages, config, useWebSearch),
                    UPSTREAM_TIMEOUT_MS,
                    'Expert stream'
                );
                let reply = responseData.output_text ||
                    responseData.output?.find(o => o.type === 'message')?.content?.[0]?.text ||
                    'No response generated.';
                reply = softCleanLatex(reply);
                sendSse({ text: reply });
                sendSse({ done: true, model: safeMode });
                console.log(`Stream done (expert): ${String(reply).length} chars`);
                return res.end();
            } catch (err) {
                sendSse({ error: mapApiError(err, config.provider) });
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

        try {
            const createArgs = {
                model: config.model,
                messages: conversationMessages,
                max_tokens: config.maxTokens,
                temperature: config.temperature,
                stream: true,
            };
            if (safeMode === 'smart') createArgs.reasoning_effort = 'high';

            const stream = await client.chat.completions.create(createArgs, { signal: abortCtrl.signal });

            let full = '';
            for await (const chunk of stream) {
                if (clientClosed) break;
                const choice = chunk.choices?.[0];
                const delta = choice?.delta?.content
                    || choice?.delta?.text
                    || (typeof choice?.delta === 'string' ? choice.delta : '')
                    || '';
                if (delta) {
                    full += delta;
                    sendSse({ text: delta });
                }
            }
            clearTimeout(timeoutId);

            // If streaming returned nothing (common with reasoning / proxy abort), fall back once
            if (!clientClosed && !full.trim()) {
                console.warn('Stream empty — falling back to non-stream completion');
                try {
                    const fallbackArgs = {
                        model: config.model,
                        messages: conversationMessages,
                        max_tokens: config.maxTokens,
                        temperature: config.temperature,
                    };
                    if (safeMode === 'smart') fallbackArgs.reasoning_effort = 'high';
                    const completion = await withTimeout(
                        client.chat.completions.create(fallbackArgs),
                        UPSTREAM_TIMEOUT_MS,
                        'Stream fallback'
                    );
                    full = completion?.choices?.[0]?.message?.content || '';
                    if (full) sendSse({ text: full });
                } catch (fbErr) {
                    sendSse({ error: mapApiError(fbErr, config.provider) });
                    sendSse({ done: true });
                    return res.end();
                }
            }

            if (!clientClosed) {
                const cleaned = softCleanLatex(full) || '';
                if (!cleaned.trim()) {
                    sendSse({ error: mapApiError({ message: 'empty reply' }, config.provider) });
                }
                sendSse({ done: true, model: safeMode, full: cleaned });
                console.log(`Stream done: ${cleaned.length} chars`);
            }
            return res.end();
        } catch (err) {
            clearTimeout(timeoutId);
            if (clientClosed || err?.name === 'AbortError') {
                // Last-chance non-stream if abort looked spurious and we got nothing yet
                try {
                    const fallbackArgs = {
                        model: config.model,
                        messages: conversationMessages,
                        max_tokens: config.maxTokens,
                        temperature: config.temperature,
                    };
                    if (safeMode === 'smart') fallbackArgs.reasoning_effort = 'high';
                    const completion = await client.chat.completions.create(fallbackArgs);
                    const text = completion?.choices?.[0]?.message?.content || '';
                    if (text) {
                        sendSse({ text: softCleanLatex(text) });
                        sendSse({ done: true, model: safeMode, full: softCleanLatex(text) });
                        return res.end();
                    }
                } catch (e) {}
                try { sendSse({ done: true, aborted: true }); } catch (e) {}
                return res.end();
            }
            sendSse({ error: mapApiError(err, config.provider) });
            sendSse({ done: true });
            return res.end();
        }
    } catch (error) {
        console.error('Stream Error:', error.message || error);
        const modeInfo = resolveMode(req.body?.mode);
        if (!res.headersSent) {
            return res.status(500).json({ reply: mapApiError(error, modeInfo.config.provider), model: 'Error' });
        }
        try {
            sendSse({ error: mapApiError(error, modeInfo.config.provider) });
            sendSse({ done: true });
            res.end();
        } catch (e) {}
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

app.get('/api/chats', (req, res) => {
    const clientId = requireClientId(req, res);
    if (!clientId) return;
    const store = readStore();
    const clientChats = store[clientId] || {};
    const list = Object.keys(clientChats).map(id => {
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
    res.json({ chats: list });
});

app.get('/api/chats/:id', (req, res) => {
    const clientId = requireClientId(req, res);
    if (!clientId) return;
    const store = readStore();
    const chat = store[clientId]?.[req.params.id];
    if (!chat) return res.status(404).json({ error: 'Not found' });
    res.json({ id: req.params.id, ...chat });
});

app.post('/api/chats', (req, res) => {
    const clientId = requireClientId(req, res);
    if (!clientId) return;
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
    const store = readStore();
    if (!store[clientId]) store[clientId] = {};
    store[clientId][id] = chat;
    try {
        writeStore(store);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save' });
    }
    res.status(201).json({ id, ...chat });
});

app.put('/api/chats/:id', (req, res) => {
    const clientId = requireClientId(req, res);
    if (!clientId) return;
    const store = readStore();
    if (!store[clientId]) store[clientId] = {};
    const existing = store[clientId][req.params.id] || {};
    const body = req.body || {};
    const now = new Date().toISOString();
    const chat = {
        name: body.name !== undefined ? body.name : (existing.name || 'New Chat'),
        messages: Array.isArray(body.messages) ? body.messages : (existing.messages || []),
        createdAt: existing.createdAt || body.createdAt || now,
        updatedAt: now,
        named: body.named !== undefined ? !!body.named : !!existing.named,
        customInstructions: body.customInstructions !== undefined ? body.customInstructions : (existing.customInstructions || ''),
        systemPrompt: body.systemPrompt !== undefined ? body.systemPrompt : (existing.systemPrompt || '')
    };
    store[clientId][req.params.id] = chat;
    try {
        writeStore(store);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save' });
    }
    res.json({ id: req.params.id, ...chat });
});

app.delete('/api/chats/:id', (req, res) => {
    const clientId = requireClientId(req, res);
    if (!clientId) return;
    const store = readStore();
    if (!store[clientId] || !store[clientId][req.params.id]) {
        return res.status(404).json({ error: 'Not found' });
    }
    delete store[clientId][req.params.id];
    try {
        writeStore(store);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to delete' });
    }
    res.json({ ok: true });
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
        app: 'GoldenSpaceAI2',
        providers: {
            fast: 'OpenAI ' + OPENAI_FAST_MODEL,
            thinking: 'Grok 4.3',
            expert: 'Grok multi-agent'
        },
        mathCleaner: true,
        streaming: true,
        persistence: true,
        historyWindow: HISTORY_WINDOW,
        pwaReady: true,
        grokKeyConfigured: !!process.env.GROK_API_KEY,
        openaiKeyConfigured: !!process.env.OPENAI_API_KEY
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
    console.log('🚀 GoldenSpaceAI2 Server');
    console.log(`📡 Port: ${PORT}`);
    console.log(`⚡ Fast: OpenAI ${OPENAI_FAST_MODEL} (${process.env.OPENAI_API_KEY ? 'key ✅' : 'key ❌'})`);
    console.log(`🧠 Thinking/Expert: Grok (key ${process.env.GROK_API_KEY ? '✅' : '❌'})`);
    console.log(`📜 History window: ${HISTORY_WINDOW} messages`);
    console.log(`📐 Math Cleaner: ✅`);
    console.log(`📡 Streaming: ✅ /api/chat/stream`);
    console.log(`💾 Persistence: ✅ ${CHATS_FILE}`);
    console.log(`⏱️ Timeout: ${UPSTREAM_TIMEOUT_MS}ms`);
    console.log(`🛡️ Rate limit: ${RATE_LIMIT}/min per IP on /api/chat*`);
    console.log(`📱 PWA Support: ✅ Ready`);
    console.log('═══════════════════════════════');
});
