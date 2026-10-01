/**
 * GoldenSpaceAI plans, usage caps, and OMT payment requests.
 * Persistence: Postgres (DATABASE_URL) is primary so data survives Render redeploys;
 * JSON under DATA_DIR is a local mirror / offline fallback. On boot, load PG first;
 * if PG is empty and JSON has data, migrate JSON → Postgres.
 * Daily Fast limits reset on UTC calendar day. Paid Thinking/Expert caps are per 30-day period.
 * Logged-in users: subscriptions, usage, and payment history are keyed by u_<userId>
 * (account), not only X-Client-Id, so every device sees the same plan/history.
 * Guests remain device-local.
 *
 * Approve / upgrade stacking (Fast, Thinking, Expert 4 / 16-AI):
 * 1) Free → any paid: grant that plan's full base limits.
 * 2) Higher tier (e.g. Plus→Pro, Pro→Max): keep current effective caps and ADD
 *    (newBase − oldBase) for each quota.
 * 3) Same plan again (e.g. Max→Max): ADD another full base allotment (doubles when
 *    starting from a single allotment).
 * Effective caps are stored on the subscription as `caps` and used for enforcement.
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

const PLAN_RANK = { free: 0, plus: 1, pro: 2, max: 3 };

function cloneCaps(c) {
    const src = c && typeof c === 'object' ? c : {};
    return {
        fastPerDay: Math.max(0, Number(src.fastPerDay) || 0),
        thinkingPerPeriod: Math.max(0, Number(src.thinkingPerPeriod) || 0),
        expert4PerPeriod: Math.max(0, Number(src.expert4PerPeriod) || 0),
        expert16PerPeriod: Math.max(0, Number(src.expert16PerPeriod) || 0)
    };
}

function capsFromPlanId(planId) {
    return cloneCaps(PLAN_DEFS[planId] || PLAN_DEFS.free);
}

function addCaps(a, b) {
    const x = cloneCaps(a);
    const y = cloneCaps(b);
    return {
        fastPerDay: x.fastPerDay + y.fastPerDay,
        thinkingPerPeriod: x.thinkingPerPeriod + y.thinkingPerPeriod,
        expert4PerPeriod: x.expert4PerPeriod + y.expert4PerPeriod,
        expert16PerPeriod: x.expert16PerPeriod + y.expert16PerPeriod
    };
}

/** Difference of base plan defs (new − old), floored at 0 per quota. */
function deltaCaps(newPlanId, oldPlanId) {
    const n = capsFromPlanId(newPlanId);
    const o = capsFromPlanId(oldPlanId);
    return {
        fastPerDay: Math.max(0, n.fastPerDay - o.fastPerDay),
        thinkingPerPeriod: Math.max(0, n.thinkingPerPeriod - o.thinkingPerPeriod),
        expert4PerPeriod: Math.max(0, n.expert4PerPeriod - o.expert4PerPeriod),
        expert16PerPeriod: Math.max(0, n.expert16PerPeriod - o.expert16PerPeriod)
    };
}

function defWithCaps(planId, caps) {
    const base = PLAN_DEFS[planId] || PLAN_DEFS.free;
    if (!caps) return base;
    const c = cloneCaps(caps);
    return {
        id: base.id,
        label: base.label,
        priceUsd: base.priceUsd,
        fastPerDay: c.fastPerDay,
        thinkingPerPeriod: c.thinkingPerPeriod,
        expert4PerPeriod: c.expert4PerPeriod,
        expert16PerPeriod: c.expert16PerPeriod
    };
}

/**
 * Compute stacked caps when approving a paid plan purchase.
 * @param {object|null} currentSub - active subscription (or null/free)
 * @param {string} newPlanId - purchased plan id
 * @returns {{ mode, plan, fromPlan, toPlan, capsBefore, capsDelta, capsAfter }}
 */
function computeStackOnApprove(currentSub, newPlanId) {
    const toPlan = String(newPlanId || '').toLowerCase();
    if (!PLAN_DEFS[toPlan] || toPlan === 'free') {
        return null;
    }
    const ends = currentSub ? Date.parse(currentSub.endsAt || 0) : NaN;
    const activePaid = !!(
        currentSub &&
        currentSub.plan &&
        currentSub.plan !== 'free' &&
        Number.isFinite(ends) &&
        Date.now() < ends
    );
    const fromPlan = activePaid ? String(currentSub.plan).toLowerCase() : 'free';
    const before = activePaid
        ? (currentSub.caps ? cloneCaps(currentSub.caps) : capsFromPlanId(fromPlan))
        : capsFromPlanId('free');
    const newBase = capsFromPlanId(toPlan);
    const fromRank = PLAN_RANK[fromPlan] || 0;
    const toRank = PLAN_RANK[toPlan] || 0;

    let mode;
    let plan;
    let delta;
    let after;

    if (!activePaid || fromPlan === 'free' || fromRank === 0) {
        // Free → any paid: full plan limits
        mode = 'grant_full';
        plan = toPlan;
        delta = cloneCaps(newBase);
        after = cloneCaps(newBase);
    } else if (toPlan === fromPlan) {
        // Same plan again: stack another full allotment
        mode = 'same_stack';
        plan = toPlan;
        delta = cloneCaps(newBase);
        after = addCaps(before, newBase);
    } else if (toRank > fromRank) {
        // Higher tier: keep current + add (newBase − oldBase)
        mode = 'upgrade_delta';
        plan = toPlan;
        delta = deltaCaps(toPlan, fromPlan);
        after = addCaps(before, delta);
    } else {
        // Lower tier purchase while on higher: stack full purchased allotment, keep higher tier
        mode = 'lower_stack';
        plan = fromPlan;
        delta = cloneCaps(newBase);
        after = addCaps(before, newBase);
    }

    return {
        mode,
        plan,
        fromPlan,
        toPlan,
        capsBefore: before,
        capsDelta: delta,
        capsAfter: after
    };
}

function utcDayKey(d = new Date()) {
    return d.toISOString().slice(0, 10);
}

function emptyStore() {
    return {
        subscriptions: {},
        phoneIndex: {},
        usage: {},
        payments: [],
        geoCache: {}
    };
}

function createPlansStore(dataDir, options = {}) {
    const filePath = path.join(dataDir, 'plans.json');
    const getPool = typeof options.getPool === 'function' ? options.getPool : () => null;
    let cache = null;
    let writeTimer = null;
    let pgSchemaReady = false;
    let pgSchemaPromise = null;
    let pgPersistTimer = null;
    let pgPersistPromise = null;
    let persistenceSource = 'uninitialized';
    let pgEnabled = false;

    function normalizeStore(parsed) {
        const src = parsed && typeof parsed === 'object' ? parsed : {};
        return {
            subscriptions: src.subscriptions && typeof src.subscriptions === 'object' ? src.subscriptions : {},
            phoneIndex: src.phoneIndex && typeof src.phoneIndex === 'object' ? src.phoneIndex : {},
            usage: src.usage && typeof src.usage === 'object' ? src.usage : {},
            payments: Array.isArray(src.payments) ? src.payments : [],
            geoCache: src.geoCache && typeof src.geoCache === 'object' ? src.geoCache : {}
        };
    }

    function storeHasData(store) {
        if (!store) return false;
        return Object.keys(store.subscriptions || {}).length > 0 ||
            Object.keys(store.usage || {}).length > 0 ||
            Object.keys(store.phoneIndex || {}).length > 0 ||
            (Array.isArray(store.payments) && store.payments.length > 0);
    }

    function ensureDir() {
        try {
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        } catch (e) {
            console.error('plans DATA_DIR error:', e.message);
        }
    }

    function readFromFile() {
        ensureDir();
        try {
            if (!fs.existsSync(filePath)) {
                return emptyStore();
            }
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw || '{}') || {};
            return normalizeStore(parsed);
        } catch (e) {
            console.error('plans.json read error:', e.message);
            return emptyStore();
        }
    }

    function writeFileSync() {
        ensureDir();
        try {
            const tmp = filePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(cache || emptyStore(), null, 2));
            fs.renameSync(tmp, filePath);
        } catch (e) {
            console.error('plans.json write error:', e.message);
        }
    }

    async function ensurePgSchema() {
        const p = getPool();
        if (!p) return false;
        if (pgSchemaReady) return true;
        if (pgSchemaPromise) return pgSchemaPromise;
        pgSchemaPromise = (async () => {
            const client = await p.connect();
            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS plans_store (
                        id TEXT PRIMARY KEY,
                        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                `);
                pgSchemaReady = true;
                pgEnabled = true;
                return true;
            } catch (e) {
                console.error('plans_store schema error:', e.message);
                pgSchemaReady = false;
                pgEnabled = false;
                return false;
            } finally {
                client.release();
                pgSchemaPromise = null;
            }
        })();
        return pgSchemaPromise;
    }

    async function loadFromPostgres() {
        const p = getPool();
        if (!p) return null;
        const ok = await ensurePgSchema();
        if (!ok) return null;
        try {
            const r = await p.query(
                `SELECT payload FROM plans_store WHERE id = 'main' LIMIT 1`
            );
            if (!r.rows[0]) return null;
            return normalizeStore(r.rows[0].payload);
        } catch (e) {
            console.error('plans_store read error:', e.message);
            return null;
        }
    }

    async function saveToPostgres() {
        const p = getPool();
        if (!p) return false;
        const ok = await ensurePgSchema();
        if (!ok) return false;
        try {
            const payload = JSON.stringify(cache || emptyStore());
            await p.query(
                `INSERT INTO plans_store (id, payload, updated_at)
                 VALUES ('main', $1::jsonb, NOW())
                 ON CONFLICT (id) DO UPDATE SET
                   payload = EXCLUDED.payload,
                   updated_at = NOW()`,
                [payload]
            );
            pgEnabled = true;
            return true;
        } catch (e) {
            console.error('plans_store write error:', e.message);
            return false;
        }
    }

    function schedulePgPersist() {
        if (pgPersistTimer) return;
        pgPersistTimer = setTimeout(() => {
            pgPersistTimer = null;
            pgPersistPromise = saveToPostgres().catch((e) => {
                console.error('plans_store persist:', e.message);
            }).finally(() => {
                pgPersistPromise = null;
            });
        }, 25);
        if (typeof pgPersistTimer.unref === 'function') pgPersistTimer.unref();
    }

    async function flushAsync() {
        if (writeTimer) {
            clearTimeout(writeTimer);
            writeTimer = null;
        }
        if (pgPersistTimer) {
            clearTimeout(pgPersistTimer);
            pgPersistTimer = null;
        }
        writeFileSync();
        if (pgPersistPromise) {
            try { await pgPersistPromise; } catch (_) {}
        }
        await saveToPostgres();
    }

    /**
     * Boot: prefer Postgres; if empty, migrate existing JSON; always mirror to JSON.
     */
    async function initPersistence() {
        let pgStore = null;
        try {
            pgStore = await loadFromPostgres();
        } catch (e) {
            console.error('plans init PG load:', e.message);
        }

        if (pgStore && storeHasData(pgStore)) {
            cache = pgStore;
            persistenceSource = 'postgres';
            writeFileSync();
            return { source: 'postgres', migrated: 0, pg: true };
        }

        const fileStore = readFromFile();
        cache = fileStore;

        if (storeHasData(fileStore)) {
            const migrated = await saveToPostgres();
            persistenceSource = migrated ? 'json-migrated' : 'json';
            if (migrated) {
                console.log('plans: migrated JSON → Postgres (plans_store)');
            }
            return {
                source: persistenceSource,
                migrated: migrated ? 1 : 0,
                pg: !!migrated
            };
        }

        // Empty everywhere — seed Postgres row when available so later writes have a target
        cache = emptyStore();
        const seeded = await saveToPostgres();
        persistenceSource = seeded ? 'postgres-empty' : 'json-empty';
        writeFileSync();
        return { source: persistenceSource, migrated: 0, pg: !!seeded };
    }

    function read() {
        if (cache) return cache;
        cache = readFromFile();
        return cache;
    }

    function flushSync() {
        if (writeTimer) {
            clearTimeout(writeTimer);
            writeTimer = null;
        }
        writeFileSync();
        schedulePgPersist();
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
            caps: null,
            stackMode: null,
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
                caps: capsFromPlanId('free'),
                phone: null,
                startsAt: null,
                endsAt: null,
                stackMode: null
            };
        }
        const caps = sub.caps ? cloneCaps(sub.caps) : capsFromPlanId(sub.plan);
        return {
            plan: sub.plan,
            def: defWithCaps(sub.plan, caps),
            caps,
            phone: sub.phone || null,
            startsAt: sub.startsAt || null,
            endsAt: sub.endsAt || null,
            paymentRequestId: sub.paymentRequestId || null,
            stackMode: sub.stackMode || null
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
        const baseDef = getPlanDef(effective.plan);
        const stacked = effective.plan !== 'free' && (
            effective.caps.fastPerDay !== baseDef.fastPerDay ||
            effective.caps.thinkingPerPeriod !== baseDef.thinkingPerPeriod ||
            effective.caps.expert4PerPeriod !== baseDef.expert4PerPeriod ||
            effective.caps.expert16PerPeriod !== baseDef.expert16PerPeriod
        );
        return {
            plan: effective.plan,
            label: effective.def.label,
            priceUsd: effective.def.priceUsd,
            phone: effective.phone,
            startsAt: effective.startsAt,
            endsAt: effective.endsAt,
            timezoneNote: 'Daily Fast limits reset at UTC midnight. Thinking and Expert limits are per 30-day paid period starting on payment confirmation.',
            omtDestination: OMT_DESTINATION,
            stacking: {
                active: effective.plan !== 'free',
                stacked: !!stacked,
                stackMode: effective.stackMode || null,
                caps: effective.caps || capsFromPlanId(effective.plan),
                baseCaps: capsFromPlanId(effective.plan),
                rules: [
                    'Free → paid: grant full plan limits (Fast / Thinking / 4-AI / 16-AI).',
                    'Upgrade to a higher plan: keep current caps and ADD the difference (newBase − oldBase).',
                    'Buy the same plan again: ADD another full allotment (doubles from a single allotment).'
                ]
            },
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

    function normalizeEmail(value) {
        const norm = String(value || '').trim().toLowerCase();
        if (!norm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) return null;
        return norm;
    }

    function accountOwnerKey(userId) {
        if (!userId) return null;
        return 'u_' + String(userId);
    }

    function paymentOwnerKey(payment) {
        if (!payment) return null;
        if (payment.userId) return accountOwnerKey(payment.userId);
        return payment.deviceId || null;
    }

    /**
     * Attach device-local payments/subscription to a logged-in account so history
     * and plan status follow the user across devices (not only X-Client-Id).
     */
    function syncAccountPlan(deviceId, userId, email) {
        const uid = userId != null ? String(userId) : '';
        if (!uid) return { ok: false, attached: 0 };
        const ak = accountOwnerKey(uid);
        const emailNorm = normalizeEmail(email);
        const store = read();
        let attached = 0;
        let migratedSub = false;

        for (const p of store.payments) {
            const sameDevice = deviceId && p.deviceId === deviceId;
            const sameEmail = emailNorm && p.email && p.email === emailNorm;
            const alreadyUser = p.userId != null && String(p.userId) === uid;
            if (!alreadyUser && (sameDevice || sameEmail)) {
                p.userId = uid;
                attached += 1;
            }
            if (emailNorm && !p.email && (sameDevice || alreadyUser || String(p.userId) === uid)) {
                p.email = emailNorm;
                attached += 1;
            }
        }

        const deviceSub = deviceId ? store.subscriptions[deviceId] : null;
        const userSub = store.subscriptions[ak];
        const devicePaid = deviceSub && deviceSub.plan && deviceSub.plan !== 'free';
        const userPaid = userSub && userSub.plan && userSub.plan !== 'free';
        if (devicePaid && !userPaid) {
            store.subscriptions[ak] = Object.assign({}, deviceSub);
            const phone = normalizePhone(deviceSub.phone);
            if (phone) store.phoneIndex[phone] = ak;
            store.subscriptions[deviceId] = {
                plan: 'free',
                phone: null,
                startsAt: null,
                endsAt: null,
                paymentRequestId: null,
                caps: null,
                stackMode: null,
                migratedTo: ak,
                migratedAt: new Date().toISOString()
            };
            if (store.usage[deviceId] && !store.usage[ak]) {
                store.usage[ak] = Object.assign({}, store.usage[deviceId]);
            }
            migratedSub = true;
        }

        if (attached || migratedSub) {
            save();
            flushSync();
        }
        return { ok: true, attached, migratedSub, ownerKey: ak };
    }

    function createPaymentRequest({ deviceId, plan, phone, email, userId, ip, currentPlan } = {}) {
        const planId = String(plan || '').toLowerCase();
        const def = PLAN_DEFS[planId];
        if (!def || planId === 'free') {
            return { ok: false, error: 'Choose Plus, Pro, or Max.' };
        }
        const normalized = normalizePhone(phone);
        if (!isValidOmtPhone(normalized)) {
            return { ok: false, error: 'Enter a valid OMT Pay wallet number.' };
        }
        const uid = userId != null ? String(userId) : '';
        // Logged-in upgrades are account-scoped; guests (if allowed) stay device-local.
        if (!uid && !deviceId) {
            return { ok: false, error: 'Missing device id.' };
        }
        const emailNorm = normalizeEmail(email);
        if (uid && !emailNorm) {
            return { ok: false, error: 'Account email required for upgrade notifications.' };
        }

        if (uid && deviceId) {
            syncAccountPlan(deviceId, uid, emailNorm);
        }

        const store = read();
        // Block duplicate waiting requests for same account (or guest device)+plan
        const existingWaiting = store.payments.find(p => {
            if (p.status !== 'waiting' || p.plan !== planId) return false;
            if (uid) {
                return String(p.userId || '') === uid ||
                    (emailNorm && p.email === emailNorm) ||
                    (deviceId && p.deviceId === deviceId);
            }
            return p.deviceId === deviceId;
        });
        if (existingWaiting) {
            let emailAttached = false;
            let userAttached = false;
            if (emailNorm && !existingWaiting.email) {
                existingWaiting.email = emailNorm;
                emailAttached = true;
            }
            if (uid && String(existingWaiting.userId || '') !== uid) {
                existingWaiting.userId = uid;
                userAttached = true;
            }
            if (emailAttached || userAttached) {
                save();
                flushSync();
            }
            return {
                ok: true,
                payment: existingWaiting,
                message: 'You already have a waiting request for this plan.',
                already: true,
                emailAttached
            };
        }

        const ownerForPlan = uid ? accountOwnerKey(uid) : (deviceId || '');
        const livePlan = ownerForPlan ? (getEffectivePlan(ownerForPlan).plan || 'free') : 'free';
        const currentPlanNorm = String(currentPlan || livePlan || 'free').toLowerCase();
        const ipNorm = typeof ip === 'string' ? ip.trim().slice(0, 64) : '';
        const payment = {
            id: 'pay_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
            phone: normalized,
            plan: planId,
            amount: def.priceUsd,
            deviceId: deviceId || null,
            userId: uid || null,
            email: emailNorm,
            status: 'waiting',
            createdAt: new Date().toISOString(),
            decidedAt: null,
            currentPlan: currentPlanNorm,
            ip: ipNorm || null,
            geo: null
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

    function mapPaymentPublic(p) {
        return {
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
        };
    }

    /** Payments for this device only (guests / legacy). */
    function listPaymentsForDevice(deviceId) {
        if (!deviceId) return [];
        return read().payments
            .filter(p => p.deviceId === deviceId)
            .map(mapPaymentPublic);
    }

    /**
     * Logged-in: all payments for this userId/email (any device).
     * Guest: device-local only.
     */
    function listPaymentsForAccount({ deviceId, userId, email } = {}) {
        const uid = userId != null ? String(userId) : '';
        const emailNorm = normalizeEmail(email);
        if (uid || emailNorm) {
            if (uid && deviceId) syncAccountPlan(deviceId, uid, emailNorm);
            return read().payments
                .filter(p => {
                    if (uid && p.userId != null && String(p.userId) === uid) return true;
                    if (emailNorm && p.email && p.email === emailNorm) return true;
                    // Include still-unattached device rows until sync runs
                    if (uid && deviceId && p.deviceId === deviceId) return true;
                    return false;
                })
                .map(mapPaymentPublic);
        }
        return listPaymentsForDevice(deviceId);
    }

    /**
     * User-facing my-plan page payload: current plan + quotas + payment requests.
     * Prefer account owner key when logged in so all devices share history/plan.
     */
    function getMyPlan(ownerOrDeviceId, opts) {
        const options = opts && typeof opts === 'object' ? opts : {};
        const deviceId = options.deviceId || null;
        const userId = options.userId != null ? options.userId : null;
        const email = options.email || null;
        let ownerKey = ownerOrDeviceId || '';
        if (userId) {
            syncAccountPlan(deviceId, userId, email);
            ownerKey = accountOwnerKey(userId);
        }
        const statusUi = getPlanStatusUi(ownerKey);
        const requests = listPaymentsForAccount({ deviceId, userId, email });
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
            myPlanUrl: '/my-plan',
            accountScoped: !!userId
        };
    }

    function formatGeoLabel(geo) {
        if (!geo || typeof geo !== 'object') return null;
        if (geo.label) return String(geo.label);
        const parts = [geo.city, geo.region, geo.country].filter(Boolean);
        return parts.length ? parts.join(', ') : null;
    }

    function getCachedGeo(ip) {
        const key = String(ip || '').trim();
        if (!key) return null;
        const entry = read().geoCache[key];
        return entry && typeof entry === 'object' ? entry : null;
    }

    function setCachedGeo(ip, geo) {
        const key = String(ip || '').trim();
        if (!key || !geo || typeof geo !== 'object') return null;
        const store = read();
        const entry = {
            city: geo.city || null,
            region: geo.region || null,
            country: geo.country || null,
            countryCode: geo.countryCode || null,
            label: formatGeoLabel(geo) || geo.label || null,
            lookedUpAt: geo.lookedUpAt || new Date().toISOString(),
            source: geo.source || 'ipwho.is'
        };
        store.geoCache[key] = entry;
        save();
        return entry;
    }

    function attachGeoToPayment(paymentId, geo) {
        const store = read();
        const payment = store.payments.find(p => p.id === paymentId);
        if (!payment) return null;
        const entry = {
            city: geo && geo.city || null,
            region: geo && geo.region || null,
            country: geo && geo.country || null,
            countryCode: geo && geo.countryCode || null,
            label: formatGeoLabel(geo) || (geo && geo.label) || null,
            lookedUpAt: (geo && geo.lookedUpAt) || new Date().toISOString(),
            source: (geo && geo.source) || 'ipwho.is'
        };
        payment.geo = entry;
        if (payment.ip) {
            store.geoCache[payment.ip] = entry;
        }
        save();
        return payment;
    }

    function mapPaymentAdmin(p) {
        const ownerKey = paymentOwnerKey(p);
        const live = ownerKey ? getEffectivePlan(ownerKey) : null;
        const cached = p.ip ? getCachedGeo(p.ip) : null;
        const geo = p.geo || cached || null;
        return {
            id: p.id,
            phone: p.phone || null,
            email: p.email || null,
            plan: p.plan,
            requestedPlan: p.plan,
            currentPlan: p.currentPlan || (live && live.plan) || 'free',
            livePlan: (live && live.plan) || 'free',
            effectivePlan: p.effectivePlan || (live && live.plan) || p.plan,
            amount: p.amount,
            status: p.status,
            createdAt: p.createdAt || null,
            decidedAt: p.decidedAt || null,
            startsAt: p.startsAt || null,
            endsAt: p.endsAt || null,
            deviceId: p.deviceId || null,
            userId: p.userId || null,
            ip: p.ip || null,
            geo: geo,
            location: formatGeoLabel(geo) || (p.ip ? 'Looking up…' : '—'),
            stackMode: p.stackMode || null,
            stackedFrom: p.stackedFrom || null,
            stackedTo: p.stackedTo || null,
            capsBefore: p.capsBefore || null,
            capsDelta: p.capsDelta || null,
            capsAfter: p.capsAfter || (live && live.caps) || null
        };
    }

    function listPayments() {
        return read().payments.slice();
    }

    function listPaymentsAdmin() {
        return read().payments.map(mapPaymentAdmin);
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
        const ownerKey = paymentOwnerKey(payment);
        if (!ownerKey) {
            return { ok: false, error: 'Payment has no account or device owner' };
        }
        const planId = payment.plan;
        const def = getPlanDef(planId);
        if (!def || planId === 'free') {
            return { ok: false, error: 'Invalid plan on payment' };
        }

        // Expire current owner sub if needed so stacking sees accurate state
        expireIfNeeded(ownerKey);
        const currentSub = store.subscriptions[ownerKey] || null;
        const stack = computeStackOnApprove(currentSub, planId);
        if (!stack) {
            return { ok: false, error: 'Invalid plan on payment' };
        }

        // One OMT number = one active paid plan: clear previous holder if any
        const prevOwner = store.phoneIndex[phone];
        if (prevOwner && prevOwner !== ownerKey) {
            store.subscriptions[prevOwner] = {
                plan: 'free',
                phone: null,
                startsAt: null,
                endsAt: null,
                paymentRequestId: null,
                caps: null,
                stackMode: null,
                replacedBy: payment.id,
                expiredAt: new Date().toISOString()
            };
        }

        const startsAt = new Date();
        const endsAt = new Date(startsAt.getTime() + PAID_PERIOD_MS);
        store.subscriptions[ownerKey] = {
            plan: stack.plan,
            phone,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            paymentRequestId: payment.id,
            caps: cloneCaps(stack.capsAfter),
            stackMode: stack.mode,
            stackedFrom: stack.fromPlan,
            stackedTo: stack.toPlan
        };
        store.phoneIndex[phone] = ownerKey;

        // Reset period usage for this account/device owner
        const u = store.usage[ownerKey] || {
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
        store.usage[ownerKey] = u;

        payment.status = 'approved';
        payment.decidedAt = new Date().toISOString();
        payment.startsAt = startsAt.toISOString();
        payment.endsAt = endsAt.toISOString();
        payment.stackMode = stack.mode;
        payment.stackedFrom = stack.fromPlan;
        payment.stackedTo = stack.toPlan;
        payment.capsBefore = cloneCaps(stack.capsBefore);
        payment.capsDelta = cloneCaps(stack.capsDelta);
        payment.capsAfter = cloneCaps(stack.capsAfter);
        payment.effectivePlan = stack.plan;

        save();
        flushSync();
        return {
            ok: true,
            payment,
            subscription: store.subscriptions[ownerKey],
            stacking: stack
        };
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
        const ownerKey = paymentOwnerKey(payment);
        const sub = ownerKey ? store.subscriptions[ownerKey] : null;
        if (sub && sub.paymentRequestId === payment.id) {
            const phone = normalizePhone(sub.phone);
            if (phone && store.phoneIndex[phone] === ownerKey) {
                delete store.phoneIndex[phone];
            }
            store.subscriptions[ownerKey] = {
                plan: 'free',
                phone: null,
                startsAt: null,
                endsAt: null,
                paymentRequestId: null,
                caps: null,
                stackMode: null,
                declinedAt: new Date().toISOString()
            };
        }

        save();
        flushSync();
        return { ok: true, payment };
    }

    return {
        PLAN_DEFS,
        PLAN_RANK,
        OMT_DESTINATION,
        utcDayKey,
        normalizePhone,
        isValidOmtPhone,
        computeStackOnApprove,
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
        listPaymentsAdmin,
        listPaymentsForDevice,
        listPaymentsForAccount,
        getCachedGeo,
        setCachedGeo,
        attachGeoToPayment,
        formatGeoLabel,
        syncAccountPlan,
        accountOwnerKey,
        getMyPlan,
        getPayment,
        approvePayment,
        declinePayment,
        flushSync,
        flushAsync,
        initPersistence,
        getPersistenceInfo: () => ({
            source: persistenceSource,
            pg: pgEnabled,
            filePath
        }),
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
    PLAN_RANK,
    computeStackOnApprove,
    capsFromPlanId,
    deltaCaps,
    addCaps,
    OMT_DESTINATION
};
