/**
 * GoldenSpaceAI plans, usage caps, and OMT payment requests.
 * Persistence: JSON file under DATA_DIR (survives process restart when disk is available).
 * Daily Fast limits reset on UTC calendar day. Paid Thinking/Expert caps are per 30-day period.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OMT_DESTINATION = '81056987';
const PAID_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

const PLAN_DEFS = {
    free: {
        id: 'free',
        label: 'Free',
        priceUsd: 0,
        fastPerDay: 50,
        thinkingPerPeriod: 0,
        expert4PerPeriod: 0,
        expert16PerPeriod: 0
    },
    plus: {
        id: 'plus',
        label: 'Plus',
        priceUsd: 5,
        fastPerDay: 120,
        thinkingPerPeriod: 40,
        expert4PerPeriod: 15,
        expert16PerPeriod: 0
    },
    pro: {
        id: 'pro',
        label: 'Pro',
        priceUsd: 10,
        fastPerDay: 200,
        thinkingPerPeriod: 80,
        expert4PerPeriod: 40,
        expert16PerPeriod: 8
    },
    max: {
        id: 'max',
        label: 'Max',
        priceUsd: 15,
        fastPerDay: 300,
        thinkingPerPeriod: 120,
        expert4PerPeriod: 60,
        expert16PerPeriod: 15
    }
};

function utcDayKey(d = new Date()) {
    return d.toISOString().slice(0, 10);
}

function emptyStore() {
    return {
        subscriptions: {},
        phoneIndex: {},
        usage: {},
        payments: []
    };
}

function createPlansStore(dataDir) {
    const filePath = path.join(dataDir, 'plans.json');
    let cache = null;
    let writeTimer = null;

    function ensureDir() {
        try {
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        } catch (e) {
            console.error('plans DATA_DIR error:', e.message);
        }
    }

    function read() {
        if (cache) return cache;
        ensureDir();
        try {
            if (!fs.existsSync(filePath)) {
                cache = emptyStore();
                return cache;
            }
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw || '{}') || {};
            cache = {
                subscriptions: parsed.subscriptions || {},
                phoneIndex: parsed.phoneIndex || {},
                usage: parsed.usage || {},
                payments: Array.isArray(parsed.payments) ? parsed.payments : []
            };
            return cache;
        } catch (e) {
            console.error('plans.json read error:', e.message);
            cache = emptyStore();
            return cache;
        }
    }

    function flushSync() {
        if (writeTimer) {
            clearTimeout(writeTimer);
            writeTimer = null;
        }
        ensureDir();
        try {
            const tmp = filePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(cache || emptyStore(), null, 2));
            fs.renameSync(tmp, filePath);
        } catch (e) {
            console.error('plans.json write error:', e.message);
        }
    }

    function scheduleWrite() {
        if (writeTimer) return;
        writeTimer = setTimeout(() => {
            writeTimer = null;
            flushSync();
        }, 50);
        if (typeof writeTimer.unref === 'function') writeTimer.unref();
    }

    function save() {
        scheduleWrite();
    }

    function getPlanDef(planId) {
        return PLAN_DEFS[planId] || PLAN_DEFS.free;
    }

    function normalizePhone(phone) {
        return String(phone || '').replace(/\D/g, '');
    }

    function isValidOmtPhone(phone) {
        const p = normalizePhone(phone);
        return p.length >= 7 && p.length <= 15;
    }

    function expireIfNeeded(deviceId) {
        const store = read();
        const sub = store.subscriptions[deviceId];
        if (!sub || !sub.plan || sub.plan === 'free') return;
        const ends = Date.parse(sub.endsAt || 0);
        if (!Number.isFinite(ends) || Date.now() < ends) return;
        const phone = normalizePhone(sub.phone);
        if (phone && store.phoneIndex[phone] === deviceId) {
            delete store.phoneIndex[phone];
        }
        store.subscriptions[deviceId] = {
            plan: 'free',
            phone: null,
            startsAt: null,
            endsAt: null,
            paymentRequestId: null,
            expiredAt: new Date().toISOString()
        };
        save();
    }

    function getEffectivePlan(deviceId) {
        expireIfNeeded(deviceId);
        const store = read();
        const sub = store.subscriptions[deviceId];
        if (!sub || !sub.plan || sub.plan === 'free') {
            return {
                plan: 'free',
                def: PLAN_DEFS.free,
                phone: null,
                startsAt: null,
                endsAt: null
            };
        }
        return {
            plan: sub.plan,
            def: getPlanDef(sub.plan),
            phone: sub.phone || null,
            startsAt: sub.startsAt || null,
            endsAt: sub.endsAt || null,
            paymentRequestId: sub.paymentRequestId || null
        };
    }

    function ensureUsage(deviceId) {
        const store = read();
        const day = utcDayKey();
        const effective = getEffectivePlan(deviceId);
        let u = store.usage[deviceId];
        if (!u) {
            u = {
                day,
                fast: 0,
                fastHalved: false,
                periodStartsAt: effective.startsAt || null,
                thinking: 0,
                expert4: 0,
                expert16: 0
            };
            store.usage[deviceId] = u;
            save();
            return u;
        }
        if (u.day !== day) {
            u.day = day;
            u.fast = 0;
            u.fastHalved = false;
            save();
        }
        // Reset monthly counters when a new paid period starts (or when free / no period)
        const periodKey = effective.startsAt || null;
        if ((u.periodStartsAt || null) !== periodKey) {
            u.periodStartsAt = periodKey;
            u.thinking = 0;
            u.expert4 = 0;
            u.expert16 = 0;
            save();
        }
        return u;
    }

    function resolveUsageKind(mode, agents) {
        const key = mode === 'fast' ? 'normal' : (mode || 'normal');
        if (key === 'smart') return 'thinking';
        if (key === 'expert') {
            const n = Number(agents);
            if (n >= 16) return 'expert16';
            return 'expert4';
        }
        return 'fast';
    }

    function fastCapFor(deviceId) {
        const effective = getEffectivePlan(deviceId);
        const u = ensureUsage(deviceId);
        let cap = effective.def.fastPerDay;
        if (u.fastHalved) cap = Math.floor(cap / 2);
        return { cap, halved: !!u.fastHalved, planCap: effective.def.fastPerDay, plan: effective.plan, def: effective.def };
    }

    function buildLimitError(kind, deviceId) {
        const effective = getEffectivePlan(deviceId);
        const u = ensureUsage(deviceId);
        const upgradeUrl = '/upgrade';

        if (kind === 'fast') {
            const { cap, halved, planCap } = fastCapFor(deviceId);
            if (effective.plan === 'free') {
                return {
                    status: 429,
                    code: 'limit_reached',
                    reply: 'Limit reached — 50 messages. Resets tomorrow. Or upgrade your plan.',
                    upgradeUrl,
                    limit: { kind: 'fast', used: u.fast, cap, plan: 'free', resets: 'utc_midnight', halved }
                };
            }
            return {
                status: 429,
                code: 'limit_reached',
                reply: halved
                    ? `Limit reached — Fast ${cap}/${planCap} today (halved after Grok fallback). Resets tomorrow (UTC). Or upgrade your plan.`
                    : `Limit reached — Fast ${cap} messages today. Resets tomorrow (UTC). Or upgrade your plan.`,
                upgradeUrl,
                limit: { kind: 'fast', used: u.fast, cap, plan: effective.plan, resets: 'utc_midnight', halved }
            };
        }

        if (effective.plan === 'free') {
            const labels = {
                thinking: 'Thinking',
                expert4: 'Expert 4 (4-AI)',
                expert16: 'Expert 16 (16-AI)'
            };
            return {
                status: 429,
                code: 'plan_required',
                reply: `${labels[kind] || 'This mode'} is not included on Free. Upgrade your plan to unlock it.`,
                upgradeUrl,
                limit: { kind, used: 0, cap: 0, plan: 'free' }
            };
        }

        const def = effective.def;
        if (kind === 'thinking') {
            return {
                status: 429,
                code: 'limit_reached',
                reply: `Limit reached — Thinking ${def.thinkingPerPeriod} messages this period. Upgrade or wait until your plan renews.`,
                upgradeUrl,
                limit: { kind, used: u.thinking, cap: def.thinkingPerPeriod, plan: effective.plan }
            };
        }
        if (kind === 'expert4') {
            if (def.expert4PerPeriod <= 0) {
                return {
                    status: 429,
                    code: 'plan_required',
                    reply: 'Expert 4 (4-AI) is not included on your plan. Upgrade to unlock it.',
                    upgradeUrl,
                    limit: { kind, used: 0, cap: 0, plan: effective.plan }
                };
            }
            return {
                status: 429,
                code: 'limit_reached',
                reply: `Limit reached — Expert 4 ${def.expert4PerPeriod} messages this period. Upgrade or wait until your plan renews.`,
                upgradeUrl,
                limit: { kind, used: u.expert4, cap: def.expert4PerPeriod, plan: effective.plan }
            };
        }
        if (kind === 'expert16') {
            if (def.expert16PerPeriod <= 0) {
                return {
                    status: 429,
                    code: 'plan_required',
                    reply: 'Expert 16 (16-AI) is not included on your plan. Upgrade to Plus/Pro/Max that includes it, or choose another mode.',
                    upgradeUrl,
                    limit: { kind, used: 0, cap: 0, plan: effective.plan }
                };
            }
            return {
                status: 429,
                code: 'limit_reached',
                reply: `Limit reached — Expert 16 ${def.expert16PerPeriod} messages this period. Upgrade or wait until your plan renews.`,
                upgradeUrl,
                limit: { kind, used: u.expert16, cap: def.expert16PerPeriod, plan: effective.plan }
            };
        }
        return {
            status: 429,
            code: 'limit_reached',
            reply: 'Limit reached. Or upgrade your plan.',
            upgradeUrl
        };
    }

    /**
     * Check whether a chat request is allowed. Does not consume quota.
     */
    function checkChatAllowed(deviceId, mode, agents) {
        if (!deviceId) {
            return {
                ok: false,
                error: {
                    status: 400,
                    code: 'missing_client',
                    reply: 'Missing device id. Refresh and try again.',
                    upgradeUrl: '/upgrade'
                }
            };
        }
        const kind = resolveUsageKind(mode, agents);
        const effective = getEffectivePlan(deviceId);
        const u = ensureUsage(deviceId);
        const def = effective.def;

        if (kind === 'fast') {
            const { cap } = fastCapFor(deviceId);
            if (u.fast >= cap) {
                return { ok: false, error: buildLimitError('fast', deviceId), kind };
            }
            return { ok: true, kind, plan: effective.plan };
        }

        if (kind === 'thinking') {
            if (def.thinkingPerPeriod <= 0) {
                return { ok: false, error: buildLimitError('thinking', deviceId), kind };
            }
            if (u.thinking >= def.thinkingPerPeriod) {
                return { ok: false, error: buildLimitError('thinking', deviceId), kind };
            }
            return { ok: true, kind, plan: effective.plan };
        }

        if (kind === 'expert4') {
            if (def.expert4PerPeriod <= 0) {
                return { ok: false, error: buildLimitError('expert4', deviceId), kind };
            }
            if (u.expert4 >= def.expert4PerPeriod) {
                return { ok: false, error: buildLimitError('expert4', deviceId), kind };
            }
            return { ok: true, kind, plan: effective.plan };
        }

        if (kind === 'expert16') {
            if (def.expert16PerPeriod <= 0) {
                return { ok: false, error: buildLimitError('expert16', deviceId), kind };
            }
            if (u.expert16 >= def.expert16PerPeriod) {
                return { ok: false, error: buildLimitError('expert16', deviceId), kind };
            }
            return { ok: true, kind, plan: effective.plan };
        }

        return { ok: true, kind: 'fast', plan: effective.plan };
    }

    /**
     * Consume one unit after a chat attempt is accepted / completed.
     * @param {boolean} usedGrokFallback - Fast path OpenAI→Grok fallback only
     */
    function usageField(kind) {
        if (kind === 'fast' || kind === 'thinking' || kind === 'expert4' || kind === 'expert16') return kind;
        return null;
    }

    /**
     * Consume one unit. Called when a chat is accepted so parallel requests cannot
     * slip past the cap. Callers must releaseUsage if the reply does not succeed.
     * Persists immediately so /api/plan-status sees the same counters as this process.
     */
    function recordUsage(deviceId, kind, { usedGrokFallback = false } = {}) {
        if (!deviceId || !kind) return;
        const field = usageField(kind);
        if (!field) return;
        const u = ensureUsage(deviceId);
        if (kind === 'fast' && usedGrokFallback && !u.fastHalved) {
            u.fastHalved = true;
        }
        u[field] = (u[field] || 0) + 1;
        flushSync();
        return u;
    }

    /** Undo one recordUsage when the model call fails or returns an empty reply. */
    function releaseUsage(deviceId, kind) {
        if (!deviceId || !kind) return;
        const field = usageField(kind);
        if (!field) return;
        const u = ensureUsage(deviceId);
        u[field] = Math.max(0, (Number(u[field]) || 0) - 1);
        flushSync();
        return u;
    }

    /** Flag UTC day as Fast-halved after OpenAI→Grok fallback (does not increment). */
    function markFastHalved(deviceId) {
        if (!deviceId) return;
        const u = ensureUsage(deviceId);
        if (!u.fastHalved) {
            u.fastHalved = true;
            flushSync();
        }
        return u;
    }

    function getStatus(deviceId) {
        const effective = getEffectivePlan(deviceId || '');
        const u = deviceId ? ensureUsage(deviceId) : {
            day: utcDayKey(), fast: 0, fastHalved: false, thinking: 0, expert4: 0, expert16: 0
        };
        const { cap, halved, planCap } = deviceId
            ? fastCapFor(deviceId)
            : { cap: PLAN_DEFS.free.fastPerDay, halved: false, planCap: PLAN_DEFS.free.fastPerDay };
        return {
            plan: effective.plan,
            label: effective.def.label,
            priceUsd: effective.def.priceUsd,
            phone: effective.phone,
            startsAt: effective.startsAt,
            endsAt: effective.endsAt,
            timezoneNote: 'Daily Fast limits reset at UTC midnight. Thinking and Expert limits are per 30-day paid period starting on payment confirmation.',
            omtDestination: OMT_DESTINATION,
            usage: {
                day: u.day,
                fast: u.fast,
                fastCap: cap,
                fastPlanCap: planCap,
                fastHalved: halved,
                thinking: u.thinking,
                thinkingCap: effective.def.thinkingPerPeriod,
                expert4: u.expert4,
                expert4Cap: effective.def.expert4PerPeriod,
                expert16: u.expert16,
                expert16Cap: effective.def.expert16PerPeriod
            },
            plans: Object.values(PLAN_DEFS).map(p => ({
                id: p.id,
                label: p.label,
                priceUsd: p.priceUsd,
                fastPerDay: p.fastPerDay,
                thinkingPerPeriod: p.thinkingPerPeriod,
                expert4PerPeriod: p.expert4PerPeriod,
                expert16PerPeriod: p.expert16PerPeriod
            }))
        };
    }


    /**
     * UI-friendly plan status: plan name + quotas with used/limit/percent.
     * Free: Fast daily only. Paid: Fast daily + Thinking/Expert monthly (Expert16 if cap > 0).
     */
    function getPlanStatusUi(deviceId) {
        const status = getStatus(deviceId);
        const u = status.usage || {};
        const quotas = [];

        function pct(used, limit) {
            const lim = Number(limit) || 0;
            if (lim <= 0) return 0;
            const p = Math.round((Number(used) || 0) / lim * 100);
            return Math.max(0, Math.min(100, p));
        }

        quotas.push({
            id: 'fast',
            label: 'Fast',
            period: 'daily',
            used: u.fast || 0,
            limit: u.fastCap || 0,
            planLimit: u.fastPlanCap || u.fastCap || 0,
            percent: pct(u.fast, u.fastCap),
            halved: !!u.fastHalved
        });

        if (status.plan !== 'free') {
            if ((u.thinkingCap || 0) > 0) {
                quotas.push({
                    id: 'thinking',
                    label: 'Thinking',
                    period: 'monthly',
                    used: u.thinking || 0,
                    limit: u.thinkingCap || 0,
                    percent: pct(u.thinking, u.thinkingCap)
                });
            }
            if ((u.expert4Cap || 0) > 0) {
                quotas.push({
                    id: 'expert4',
                    label: 'Expert 4',
                    period: 'monthly',
                    used: u.expert4 || 0,
                    limit: u.expert4Cap || 0,
                    percent: pct(u.expert4, u.expert4Cap)
                });
            }
            if ((u.expert16Cap || 0) > 0) {
                quotas.push({
                    id: 'expert16',
                    label: 'Expert 16',
                    period: 'monthly',
                    used: u.expert16 || 0,
                    limit: u.expert16Cap || 0,
                    percent: pct(u.expert16, u.expert16Cap)
                });
            }
        }

        return {
            ok: true,
            plan: status.plan,
            label: status.label,
            priceUsd: status.priceUsd,
            startsAt: status.startsAt,
            endsAt: status.endsAt,
            timezoneNote: status.timezoneNote,
            quotas,
            upgradeUrl: '/upgrade'
        };
    }

    function createPaymentRequest({ deviceId, plan, phone }) {
        const planId = String(plan || '').toLowerCase();
        const def = PLAN_DEFS[planId];
        if (!def || planId === 'free') {
            return { ok: false, error: 'Choose Plus, Pro, or Max.' };
        }
        const normalized = normalizePhone(phone);
        if (!isValidOmtPhone(normalized)) {
            return { ok: false, error: 'Enter a valid OMT Pay wallet number.' };
        }
        if (!deviceId) {
            return { ok: false, error: 'Missing device id.' };
        }

        const store = read();
        // Block duplicate waiting requests for same device+plan
        const existingWaiting = store.payments.find(p =>
            p.status === 'waiting' && p.deviceId === deviceId && p.plan === planId
        );
        if (existingWaiting) {
            return {
                ok: true,
                payment: existingWaiting,
                message: 'You already have a waiting request for this plan.'
            };
        }

        const payment = {
            id: 'pay_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
            phone: normalized,
            plan: planId,
            amount: def.priceUsd,
            deviceId,
            status: 'waiting',
            createdAt: new Date().toISOString(),
            decidedAt: null
        };
        store.payments.unshift(payment);
        save();
        flushSync();
        return { ok: true, payment };
    }


    function maskPhone(phone) {
        const p = normalizePhone(phone);
        if (!p) return null;
        if (p.length <= 4) return '****';
        return p.slice(0, 2) + '*'.repeat(Math.max(2, p.length - 4)) + p.slice(-2);
    }

    /** Payments for this device only (no other customers). */
    function listPaymentsForDevice(deviceId) {
        if (!deviceId) return [];
        return read().payments
            .filter(p => p.deviceId === deviceId)
            .map(p => ({
                id: p.id,
                plan: p.plan,
                label: (PLAN_DEFS[p.plan] || {}).label || p.plan,
                amount: p.amount,
                status: p.status, // waiting | approved | declined
                createdAt: p.createdAt || null,
                decidedAt: p.decidedAt || null,
                startsAt: p.startsAt || null,
                endsAt: p.endsAt || null,
                phoneMasked: maskPhone(p.phone)
            }));
    }

    /**
     * User-facing my-plan page payload: current plan + quotas + payment requests.
     */
    function getMyPlan(deviceId) {
        const statusUi = getPlanStatusUi(deviceId);
        const requests = listPaymentsForDevice(deviceId);
        const latest = requests[0] || null;
        return {
            ok: true,
            plan: statusUi.plan,
            label: statusUi.label,
            priceUsd: statusUi.priceUsd,
            startsAt: statusUi.startsAt,
            endsAt: statusUi.endsAt,
            timezoneNote: statusUi.timezoneNote,
            quotas: statusUi.quotas,
            latestRequest: latest,
            requests,
            upgradeUrl: '/upgrade',
            myPlanUrl: '/my-plan'
        };
    }

    function listPayments() {
        return read().payments.slice();
    }

    function getPayment(id) {
        return read().payments.find(p => p.id === id) || null;
    }

    function approvePayment(id) {
        const store = read();
        const payment = store.payments.find(p => p.id === id);
        if (!payment) return { ok: false, error: 'Not found' };
        if (payment.status === 'approved') {
            return { ok: true, payment, already: true };
        }

        const phone = normalizePhone(payment.phone);
        const deviceId = payment.deviceId;
        const planId = payment.plan;
        const def = getPlanDef(planId);
        if (!def || planId === 'free') {
            return { ok: false, error: 'Invalid plan on payment' };
        }

        // One OMT number = one active paid plan: clear previous holder if any
        const prevDevice = store.phoneIndex[phone];
        if (prevDevice && prevDevice !== deviceId) {
            store.subscriptions[prevDevice] = {
                plan: 'free',
                phone: null,
                startsAt: null,
                endsAt: null,
                paymentRequestId: null,
                replacedBy: payment.id,
                expiredAt: new Date().toISOString()
            };
        }

        const startsAt = new Date();
        const endsAt = new Date(startsAt.getTime() + PAID_PERIOD_MS);
        store.subscriptions[deviceId] = {
            plan: planId,
            phone,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            paymentRequestId: payment.id
        };
        store.phoneIndex[phone] = deviceId;

        // Reset period usage for this device
        const u = store.usage[deviceId] || {
            day: utcDayKey(),
            fast: 0,
            fastHalved: false,
            thinking: 0,
            expert4: 0,
            expert16: 0
        };
        u.periodStartsAt = startsAt.toISOString();
        u.thinking = 0;
        u.expert4 = 0;
        u.expert16 = 0;
        store.usage[deviceId] = u;

        payment.status = 'approved';
        payment.decidedAt = new Date().toISOString();
        payment.startsAt = startsAt.toISOString();
        payment.endsAt = endsAt.toISOString();

        save();
        flushSync();
        return { ok: true, payment, subscription: store.subscriptions[deviceId] };
    }

    function declinePayment(id) {
        const store = read();
        const payment = store.payments.find(p => p.id === id);
        if (!payment) return { ok: false, error: 'Not found' };
        if (payment.status === 'declined') {
            return { ok: true, payment, already: true };
        }

        payment.status = 'declined';
        payment.decidedAt = new Date().toISOString();

        // If this was the active approved binding, drop to Free
        const deviceId = payment.deviceId;
        const sub = store.subscriptions[deviceId];
        if (sub && sub.paymentRequestId === payment.id) {
            const phone = normalizePhone(sub.phone);
            if (phone && store.phoneIndex[phone] === deviceId) {
                delete store.phoneIndex[phone];
            }
            store.subscriptions[deviceId] = {
                plan: 'free',
                phone: null,
                startsAt: null,
                endsAt: null,
                paymentRequestId: null,
                declinedAt: new Date().toISOString()
            };
        }

        save();
        flushSync();
        return { ok: true, payment };
    }

    return {
        PLAN_DEFS,
        OMT_DESTINATION,
        utcDayKey,
        normalizePhone,
        isValidOmtPhone,
        getEffectivePlan,
        getStatus,
        getPlanStatusUi,
        checkChatAllowed,
        recordUsage,
        releaseUsage,
        markFastHalved,
        resolveUsageKind,
        createPaymentRequest,
        listPayments,
        listPaymentsForDevice,
        getMyPlan,
        getPayment,
        approvePayment,
        declinePayment,
        flushSync,
        filePath
    };
}

function adminTokenFromPasskey(passkey) {
    if (!passkey) return null;
    return crypto.createHmac('sha256', 'goldenspaceai-admin-v1')
        .update(String(passkey))
        .digest('hex');
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    header.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx === -1) return;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    });
    return out;
}

function isAdminAuthed(req, passkey) {
    const expected = adminTokenFromPasskey(passkey);
    if (!expected) return false;
    const cookies = parseCookies(req);
    if (cookies.gsa_admin === expected) return true;
    const header = (req.headers['x-admin-passkey'] || '').toString();
    if (header && header === passkey) return true;
    return false;
}

module.exports = {
    createPlansStore,
    adminTokenFromPasskey,
    parseCookies,
    isAdminAuthed,
    PLAN_DEFS,
    OMT_DESTINATION
};
