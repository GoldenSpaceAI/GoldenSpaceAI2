/**
 * Provider cost accounting. xAI reports per-request billed cost in usage ticks;
 * DeepSeek reports token/cache counts, priced using its UTC peak/off-peak schedule.
 */
const LONG_CONTEXT_PROMPT_TOKENS = 200000;
const MODEL_PRICING = {
  'deepseek-flash': { input: 0.30, output: 1.20, inputLong: 0.30, outputLong: 1.20 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'grok-4.3': { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 },
  'grok-4.20-multi-agent-0309': { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 },
  'grok-4': { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 },
  'grok-4.20-0309-reasoning': { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 },
  'grok-4.20-0309-non-reasoning': { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 }
};
const DEFAULT_PRICING = { input: 1.25, output: 2.50, inputLong: 2.50, outputLong: 5.00 };
function normalizeModelId(model) { return String(model || '').trim().toLowerCase(); }
function lookupPricing(model) {
  const id = normalizeModelId(model);
  if (MODEL_PRICING[id]) return MODEL_PRICING[id];
  for (const key of Object.keys(MODEL_PRICING)) if (id.startsWith(key) || key.startsWith(id)) return MODEL_PRICING[key];
  return DEFAULT_PRICING;
}
function normalizeProvider(provider, model) {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'deepseek' || p === 'deepseek-ai') return 'deepseek';
  if (p === 'grok' || p === 'xai') return 'grok';
  if (p === 'openai') return 'openai';
  const id = normalizeModelId(model);
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('grok') || id.startsWith('xai')) return 'grok';
  return p || 'unknown';
}
function isDeepSeekPeakTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getUTCDay(), hour = d.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}
function costFromUsage(model, promptTokens, completionTokens, options = {}) {
  const prompt = Math.max(0, Number(promptTokens) || 0);
  const completion = Math.max(0, Number(completionTokens) || 0);
  const rates = lookupPricing(model);
  const longContext = prompt >= LONG_CONTEXT_PROMPT_TOKENS && rates.inputLong != null;
  let inputRate = longContext ? (rates.inputLong || rates.input) : rates.input;
  let outputRate = longContext ? (rates.outputLong || rates.output) : rates.output;
  const provider = normalizeProvider(options.provider, model);
  const cacheHitTokens = Math.min(prompt, Math.max(0, Number(options.cacheHitTokens) || 0));
  let cacheMissTokens = Math.min(prompt - cacheHitTokens, Math.max(0, Number(options.cacheMissTokens) || 0));
  let costUsd;
  if (provider === 'deepseek') {
    const multiplier = isDeepSeekPeakTime(options.at || new Date()) ? 1 : 0.5;
    inputRate = 0.30 * multiplier;
    outputRate = 1.20 * multiplier;
    if (cacheHitTokens + cacheMissTokens < prompt) cacheMissTokens = prompt - cacheHitTokens;
    costUsd = cacheHitTokens / 1e6 * 0.006 * multiplier +
      cacheMissTokens / 1e6 * inputRate + completion / 1e6 * outputRate;
  } else {
    costUsd = prompt / 1e6 * inputRate + completion / 1e6 * outputRate;
  }
  return { costUsd: Number(costUsd.toFixed(10)), promptTokens: prompt, completionTokens: completion,
    model: String(model || ''), rates: { inputPerM: inputRate, outputPerM: outputRate }, longContext,
    cacheHitTokens, cacheMissTokens };
}
function extractTokenCounts(usage) {
  if (!usage || typeof usage !== 'object') return { promptTokens: 0, completionTokens: 0 };
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ??
    (usage.input && (usage.input.tokens || usage.input)) ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ??
    (usage.output && (usage.output.tokens || usage.output)) ?? 0) || 0;
  const total = Number(usage.total_tokens || 0) || 0;
  if (!prompt && !completion && total > 0) return { promptTokens: total, completionTokens: 0 };
  return { promptTokens: prompt, completionTokens: completion };
}
function costFromProviderUsage(model, usage, provider, at) {
  const counts = extractTokenCounts(usage);
  const prov = normalizeProvider(provider, model);
  const ticks = Number(usage && usage.cost_in_usd_ticks);
  if (prov === 'grok' && Number.isFinite(ticks) && ticks >= 0) {
    return { costUsd: Number((ticks / 1e10).toFixed(10)), promptTokens: counts.promptTokens,
      completionTokens: counts.completionTokens, model: String(model || ''), rates: null,
      longContext: false, costSource: 'provider_reported' };
  }
  const details = (usage && (usage.prompt_tokens_details || usage.input_tokens_details)) || {};
  const cacheHit = Number((usage && (usage.prompt_cache_hit_tokens ?? usage.cache_hit_tokens)) ??
    details.cached_tokens ?? 0) || 0;
  const cacheMiss = Number((usage && (usage.prompt_cache_miss_tokens ?? usage.cache_miss_tokens)) ?? 0) || 0;
  return Object.assign(costFromUsage(model, counts.promptTokens, counts.completionTokens, {
    provider: prov, at: at || new Date(), cacheHitTokens: cacheHit, cacheMissTokens: cacheMiss
  }), { costSource: 'token_rate' });
}
function estimateTokensFromText(text) {
  const s = String(text || '');
  return s ? Math.max(1, Math.ceil(s.length / 4)) : 0;
}
function estimateCostFromTexts(model, promptText, completionText) {
  return Object.assign(costFromUsage(model, estimateTokensFromText(promptText), estimateTokensFromText(completionText)), {
    costSource: 'estimated_text'
  });
}
module.exports = { MODEL_PRICING, DEFAULT_PRICING, LONG_CONTEXT_PROMPT_TOKENS, lookupPricing,
  costFromUsage, extractTokenCounts, costFromProviderUsage, estimateTokensFromText,
  estimateCostFromTexts, normalizeProvider, isDeepSeekPeakTime };