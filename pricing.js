/**
 * Model cost tables used for plan $ spend budgets.
 * Rates are USD per 1,000,000 tokens (provider list prices as of 2026-10).
 * Sources: OpenAI platform pricing (gpt-5-nano); xAI docs.x.ai/developers/pricing (Grok).
 *
 * Long-context (≥200k prompt tokens): Grok models use the higher tier for ALL tokens
 * in that request (per xAI pricing notes).
 */
const LONG_CONTEXT_PROMPT_TOKENS = 200000;

/** @type {Record<string, { input: number, output: number, inputLong?: number, outputLong?: number }>} */
const MODEL_PRICING = {
    // OpenAI Fast default (gpt-5-nano)
    'gpt-5-nano': { input: 0.05, output: 0.40 },
    // Legacy Fast alias (still billable if env override / older traffic)
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    // xAI Grok 4.3 (Fast fallback + Thinking)
    'grok-4.3': { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 },
    // xAI Expert multi-agent
    'grok-4.20-multi-agent-0309': { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 },
    // Aliases / related
    'grok-4': { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 },
    'grok-4.20-0309-reasoning': { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 },
    'grok-4.20-0309-non-reasoning': { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 }
};

const DEFAULT_PRICING = { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 };

function normalizeModelId(model) {
    return String(model || '').trim().toLowerCase();
}

function lookupPricing(model) {
    const id = normalizeModelId(model);
    if (MODEL_PRICING[id]) return MODEL_PRICING[id];
    // Prefix match (e.g. dated aliases)
    for (const key of Object.keys(MODEL_PRICING)) {
        if (id.startsWith(key) || key.startsWith(id)) return MODEL_PRICING[key];
    }
    return DEFAULT_PRICING;
}


/**
 * Normalize spend provider to `openai` | `grok` (infer from model when omitted).
 * @param {string|null|undefined} provider
 * @param {string|null|undefined} model
 * @returns {'openai'|'grok'|'unknown'}
 */
function normalizeProvider(provider, model) {
    const p = String(provider || '').trim().toLowerCase();
    if (p === 'openai') return 'openai';
    if (p === 'grok' || p === 'xai') return 'grok';
    const id = normalizeModelId(model);
    if (!id) return p || 'unknown';
    if (
        id.startsWith('gpt-') ||
        id.startsWith('o1') ||
        id.startsWith('o3') ||
        id.startsWith('o4') ||
        id.includes('chatgpt') ||
        id.includes('openai')
    ) {
        return 'openai';
    }
    if (id.startsWith('grok') || id.startsWith('xai')) return 'grok';
    return p || 'unknown';
}

/**
 * Compute USD cost from provider usage token counts.
 * @returns {{ costUsd: number, promptTokens: number, completionTokens: number, model: string, rates: object, longContext: boolean }}
 */
function costFromUsage(model, promptTokens, completionTokens) {
    const prompt = Math.max(0, Number(promptTokens) || 0);
    const completion = Math.max(0, Number(completionTokens) || 0);
    const rates = lookupPricing(model);
    const longContext = prompt >= LONG_CONTEXT_PROMPT_TOKENS && (rates.inputLong != null);
    const inRate = longContext ? (rates.inputLong || rates.input) : rates.input;
    const outRate = longContext ? (rates.outputLong || rates.output) : rates.output;
    const costUsd = (prompt / 1e6) * inRate + (completion / 1e6) * outRate;
    return {
        costUsd: Number(costUsd.toFixed(8)),
        promptTokens: prompt,
        completionTokens: completion,
        model: String(model || ''),
        rates: { inputPerM: inRate, outputPerM: outRate },
        longContext
    };
}

/**
 * Normalize provider usage objects (OpenAI chat + Responses / xAI).
 */
function extractTokenCounts(usage) {
    if (!usage || typeof usage !== 'object') {
        return { promptTokens: 0, completionTokens: 0 };
    }
    const prompt = Number(
        usage.prompt_tokens ??
        usage.input_tokens ??
        usage.promptTokens ??
        (usage.input && (usage.input.tokens || usage.input)) ??
        0
    ) || 0;
    const completion = Number(
        usage.completion_tokens ??
        usage.output_tokens ??
        usage.completionTokens ??
        (usage.output && (usage.output.tokens || usage.output)) ??
        0
    ) || 0;
    // Some Responses payloads nest under usage.input_tokens / output_tokens already covered
    const total = Number(usage.total_tokens || 0) || 0;
    if (!prompt && !completion && total > 0) {
        // Unknown split — attribute all to prompt (conservative vs under-billing)
        return { promptTokens: total, completionTokens: 0 };
    }
    return { promptTokens: prompt, completionTokens: completion };
}

function costFromProviderUsage(model, usage) {
    const { promptTokens, completionTokens } = extractTokenCounts(usage);
    return costFromUsage(model, promptTokens, completionTokens);
}

/** Estimate tokens from text when provider usage is missing (≈4 chars/token). */
function estimateTokensFromText(text) {
    const s = String(text || '');
    if (!s) return 0;
    return Math.max(1, Math.ceil(s.length / 4));
}

/**
 * Fallback cost when upstream omitted usage: estimate from prompt messages + reply.
 */
function estimateCostFromTexts(model, promptText, completionText) {
    return costFromUsage(
        model,
        estimateTokensFromText(promptText),
        estimateTokensFromText(completionText)
    );
}

module.exports = {
    MODEL_PRICING,
    DEFAULT_PRICING,
    LONG_CONTEXT_PROMPT_TOKENS,
    lookupPricing,
    costFromUsage,
    extractTokenCounts,
    costFromProviderUsage,
    estimateTokensFromText,
    estimateCostFromTexts,
    normalizeProvider
};
