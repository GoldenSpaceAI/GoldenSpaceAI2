/**
 * ChatGPT-style context packing: recent window + rolling summary + account memory.
 * Cuts prompt tokens vs sending full ~40-turn history every request.
 */

const RECENT_WINDOW = Math.max(4, Math.min(20, Number(process.env.RECENT_WINDOW) || 10));
/** Start (re)building a rolling summary once history exceeds recent + this gap. */
const SUMMARY_TRIGGER_EXTRA = Math.max(2, Number(process.env.SUMMARY_TRIGGER_EXTRA) || 4);
const SUMMARY_SOFT_MAX = Math.max(600, Number(process.env.SUMMARY_SOFT_MAX) || 2200);
const MEMORY_FACT_MAX = 24;
const MEMORY_VALUE_MAX = 160;

function messagePlainText(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content.trim();
    if (Array.isArray(msg.content)) {
        return msg.content
            .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
            .join(' ')
            .trim();
    }
    return '';
}

function roleLabel(msg) {
    const r = msg && msg.role;
    if (r === 'ai' || r === 'assistant') return 'Assistant';
    if (r === 'system') return 'System';
    return 'User';
}

function formatTurnLine(msg) {
    const text = messagePlainText(msg).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const clipped = text.length > 280 ? text.slice(0, 277) + '…' : text;
    return roleLabel(msg) + ': ' + clipped;
}

function truncateSummary(text, maxLen) {
    const s = String(text || '').trim();
    if (s.length <= maxLen) return s;
    // Keep head (early context) and tail (more recent aged-out turns)
    const head = Math.floor(maxLen * 0.35);
    const tail = maxLen - head - 5;
    return s.slice(0, head).trimEnd() + '\n…\n' + s.slice(-tail).trimStart();
}

/**
 * Fold messages that aged out of the recent window into a rolling summary.
 * Pure / local — no extra model call (keeps cost predictable).
 */
function updateRollingSummary(messages, existingSummary, summarizedCount) {
    const list = Array.isArray(messages) ? messages.filter((m) => m && (m.role === 'user' || m.role === 'ai' || m.role === 'assistant')) : [];
    const keepFrom = Math.max(0, list.length - RECENT_WINDOW);
    const prevCount = Math.max(0, Number(summarizedCount) || 0);
    let summary = String(existingSummary || '').trim();

    if (keepFrom <= 0) {
        return { summary: '', summarizedCount: 0, changed: summary !== '' || prevCount !== 0 };
    }
    if (keepFrom <= prevCount && summary) {
        return { summary, summarizedCount: prevCount, changed: false };
    }

    const toFold = list.slice(prevCount, keepFrom);
    if (!toFold.length && summary) {
        return { summary, summarizedCount: keepFrom, changed: prevCount !== keepFrom };
    }

    const chunk = toFold.map(formatTurnLine).filter(Boolean).join('\n');
    if (chunk) {
        summary = summary ? (summary + '\n' + chunk) : chunk;
    }
    summary = truncateSummary(summary, SUMMARY_SOFT_MAX);
    return { summary, summarizedCount: keepFrom, changed: true };
}

function shouldRefreshSummary(messageCount, summarizedCount) {
    const n = Number(messageCount) || 0;
    const upto = Number(summarizedCount) || 0;
    if (n <= RECENT_WINDOW) return false;
    if (n < RECENT_WINDOW + SUMMARY_TRIGGER_EXTRA && upto > 0) {
        // Still refresh if we have new aged-out turns
        return n - RECENT_WINDOW > upto;
    }
    return n - RECENT_WINDOW > upto;
}

function normalizeFacts(facts) {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return {};
    const out = {};
    for (const [k, v] of Object.entries(facts)) {
        const key = String(k || '').trim().slice(0, 64);
        if (!key || key.startsWith('_')) continue;
        const val = String(v == null ? '' : v).trim().slice(0, MEMORY_VALUE_MAX);
        if (!val) continue;
        out[key] = val;
        if (Object.keys(out).length >= MEMORY_FACT_MAX) break;
    }
    return out;
}

function factsToList(facts) {
    const obj = normalizeFacts(facts);
    return Object.keys(obj).sort().map((k) => ({ key: k, value: obj[k] }));
}

function formatAccountMemoryBlock(facts) {
    const list = factsToList(facts);
    if (!list.length) return '';
    const lines = list.map((f) => `- ${f.key}: ${f.value}`);
    return (
        'Account memory (sticky facts about the logged-in user — use when relevant; ' +
        'do not invent facts; do not repeat this list unless helpful):\n' +
        lines.join('\n')
    );
}

function formatRollingSummaryBlock(summary) {
    const s = String(summary || '').trim();
    if (!s) return '';
    return (
        'Conversation so far (compressed summary of earlier turns; ' +
        'recent messages follow in full):\n' + s
    );
}

/** Heuristic durable-fact extraction from the latest user turn(s). */
function extractDurableFactsFromMessages(messages, existingFacts) {
    const facts = normalizeFacts(existingFacts);
    const list = Array.isArray(messages) ? messages : [];
    // Prefer the last few user turns (fresh statements)
    const userTexts = [];
    for (let i = list.length - 1; i >= 0 && userTexts.length < 4; i--) {
        const m = list[i];
        if (!m || m.role !== 'user') continue;
        const t = messagePlainText(m);
        if (t) userTexts.push(t);
    }
    if (!userTexts.length) return { facts, changed: false, updates: {} };

    const blob = userTexts.join('\n');
    // Skip ephemeral / task-heavy lines
    if (/\b(this (code|error|bug|file|screenshot)|fix this|debug|translate this|summarize (this|the)|write (a |me )?(function|email|essay))\b/i.test(blob)
        && !/\b(my name is|i'?m called|call me|i prefer|i live|i work)\b/i.test(blob)) {
        return { facts, changed: false, updates: {} };
    }

    const updates = {};
    const set = (key, value) => {
        const v = String(value || '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_VALUE_MAX);
        if (!v || v.length < 2) return;
        // Avoid storing clearly ephemeral values
        if (/^(this|that|it|here|today|now|please)\b/i.test(v)) return;
        if (facts[key] === v) return;
        updates[key] = v;
        facts[key] = v;
    };

    let m;
    const nameRe = /\b(?:my name is|i'?m called|i am called|call me|i go by)\s+([A-Za-z][\w''-]{0,39})(?:\s+([A-Za-z][\w''-]{0,39}))?/i;
    m = blob.match(nameRe);
    if (m) {
        const stop = /^(and|but|because|since|who|that|from|in|on|at|with|for|to)$/i;
        let full = m[1];
        if (m[2] && !stop.test(m[2])) full = m[1] + ' ' + m[2];
        if (!stop.test(String(full).trim())) set('name', full);
    }

    // "I'm Faris" / "I am Faris" — only when capitalized proper-name-ish and short
    m = blob.match(/\b(?:i am|i'?m)\s+([A-Z][a-zA-Z''-]{1,30})(?:\s*[.!?,]|$)/);
    if (m && !/^(a|an|the|not|just|here|going|trying|looking|working|using)/i.test(m[1])) {
        set('name', m[1]);
    }

    m = blob.match(/\bi (?:live|am based|reside)(?:\s+in)?\s+([^.\n!?]{2,60})/i);
    if (m) set('location', m[1]);

    m = blob.match(/\bi (?:work as|am an?)\s+([^.\n!?]{2,60})/i);
    if (m) set('occupation', m[1]);

    m = blob.match(/\bi prefer(?:\s+to)?\s+([^.\n!?]{2,80})/i);
    if (m) set('preference', m[1]);

    m = blob.match(/\b(?:please )?(?:always |remember (?:that |to )?)?(?:speak|answer|reply|respond)(?:\s+to me)?\s+in\s+([A-Za-z][A-Za-z\s-]{1,40})/i);
    if (m) set('language', m[1]);

    m = blob.match(/\bmy (?:timezone|time zone) is\s+([^.\n!?]{2,40})/i);
    if (m) set('timezone', m[1]);

    m = blob.match(/\bremember (?:that )?(.{5,100}?)(?:\.|$)/i);
    if (m && !/^(this|to |my password|the code)/i.test(m[1])) {
        // Freeform sticky note — store under a stable key if it looks personal
        const note = m[1].trim();
        if (/\b(i |my |prefer|allergic|vegetarian|don'?t like|hate|love)\b/i.test(note)) {
            set('note', note);
        }
    }

    return {
        facts,
        changed: Object.keys(updates).length > 0,
        updates
    };
}

/**
 * Build the model-bound message pack.
 * Order: custom instructions → account memory → rolling summary → recent raw turns.
 */
function buildPackedMessages(opts) {
    const {
        messages,
        customInstructions,
        accountMemory,
        rollingSummary,
        image,
        expandUserContent
    } = opts || {};

    const conversationMessages = [];
    const expand = typeof expandUserContent === 'function'
        ? expandUserContent
        : (msg) => messagePlainText(msg);

    if (customInstructions && String(customInstructions).trim()) {
        conversationMessages.push({
            role: 'system',
            content: String(customInstructions).trim()
        });
    }

    const memBlock = formatAccountMemoryBlock(accountMemory);
    if (memBlock) {
        conversationMessages.push({ role: 'system', content: memBlock });
    }

    const sumBlock = formatRollingSummaryBlock(rollingSummary);
    if (sumBlock) {
        conversationMessages.push({ role: 'system', content: sumBlock });
    }

    const all = Array.isArray(messages) ? messages : [];
    const recentMessages = all.slice(-RECENT_WINDOW);

    recentMessages.forEach((msg) => {
        if (!msg || !msg.role) return;
        if (msg.role === 'user') {
            const content = [];
            const modelText = expand(msg);
            if (modelText && String(modelText).trim()) {
                content.push({ type: 'text', text: String(modelText).trim() });
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
            if (msg.content && String(msg.content).trim()) {
                conversationMessages.push({
                    role: 'assistant',
                    content: String(msg.content).trim()
                });
            }
        }
    });

    if (image && !all.some((m) => m && m.image === image)) {
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

    const systemCount = conversationMessages.filter((m) => m.role === 'system').length;
    const recentCount = conversationMessages.length - systemCount;

    return {
        messages: conversationMessages,
        meta: {
            recentWindow: RECENT_WINDOW,
            recentRawCount: recentCount,
            hasAccountMemory: !!memBlock,
            hasRollingSummary: !!sumBlock,
            systemBlocks: systemCount,
            packSize: conversationMessages.length,
            structure: [
                memBlock || sumBlock || (customInstructions && String(customInstructions).trim())
                    ? 'system: customInstructions?'
                    : null,
                'system: accountMemory? (logged-in)',
                'system: rollingSummary?',
                `recent: last ${RECENT_WINDOW} raw messages`
            ].filter(Boolean)
        }
    };
}

/** Client-side / offline helper: fold local history into a summary string. */
function clientSideRollingUpdate(chat) {
    if (!chat || !Array.isArray(chat.messages)) {
        return { summary: '', summarizedCount: 0 };
    }
    return updateRollingSummary(
        chat.messages,
        chat.rollingSummary || '',
        chat.summaryMessageCount || 0
    );
}

module.exports = {
    RECENT_WINDOW,
    SUMMARY_TRIGGER_EXTRA,
    SUMMARY_SOFT_MAX,
    updateRollingSummary,
    shouldRefreshSummary,
    normalizeFacts,
    factsToList,
    formatAccountMemoryBlock,
    formatRollingSummaryBlock,
    extractDurableFactsFromMessages,
    buildPackedMessages,
    clientSideRollingUpdate,
    messagePlainText
};
