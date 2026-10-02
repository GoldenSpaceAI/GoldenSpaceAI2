/**
 * GoldenSpaceAI plans, usage caps, and OMT payment requests.
 * Persistence: Postgres (DATABASE_URL) is primary so data survives Render redeploys;
 * JSON under DATA_DIR is a local mirror / offline fallback. On boot, load PG first;
 * if PG is empty and JSON has data, migrate JSON → Postgres.
 *
 * Budgets are real model-cost USD (not plan list price), tracked from provider
 * prompt+completion tokens via pricing.js rates. Hard-stop per bucket — no borrowing.
 * Buckets:
 * - Fast: Fast / normal mode only (gpt-5-nano)
 * - ThinkShare: Thinking alone (Plus) or Thinking + Expert 4 shared (Pro/Max)
 * - Expert16: Expert 16 alone (Max only)
 * Retained $ on paid plans is margin (not usable as API budget).
 * Paid allotments are per 30-day period from admin approve (no auto-renew).
 * Free Fast is $0.05/day UTC midnight reset. Images count toward the same Fast bucket.
 * Talk minutes (Live / TTS voice time) are separate hard-stops: Free 1 min/UTC week;
 * paid Talk is per 30-day period. Hard-stop per bucket — no borrowing across modes/Talk.
 * When all usable paid buckets are exhausted, the account is demoted to Free.
 *
 * Logged-in users: subscriptions, usage, and payment history are keyed by u_<userId>
 * (account), not only X-Client-Id, so every device sees the same plan/history.
 * Guests remain device-local.
 *
 * Approve / upgrade stacking (per bucket $):
 * 1) Free → any paid: grant that plan's full base $ budgets.
 * 2) Higher tier (e.g. Plus→Pro, Pro→Max): keep current effective caps and ADD
 *    (newBase − oldBase) for each bucket.
 * 3) Same plan again (e.g. Max→Max): ADD another full base allotment (doubles when
 *    starting from a single allotment).
 * Effective caps are stored on the subscription as `caps` and used for enforcement.
 * Users see % used only — never $ or tokens in the public UI.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    costFromProviderUsage,
    estimateCostFromTexts,
    normalizeProvider,
    MODEL_PRICING,
    DEFAULT_PRICING
} = require('./pricing');

const OMT_DESTINATION = '81056987';
const PAID_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Plan defs — priceUsd is what the user pays via OMT (wallet-to-wallet).
 * fastUsd / thinkShareUsd / expert16Usd are included model-cost budgets (USD).
 * retainedUsd is platform margin (not usable). Mode flags gate Thinking / Expert.
 * talkMinutes is Live/TTS voice time (hard-stop; users see % only).
 * Free Fast is a small daily allowance; paid buckets are per 30-day period.
 */
const PLAN_DEFS = {
    free: {
        id: 'free',
        label: 'Free',
        priceUsd: 0,
        fastUsd: 0.05,
        thinkShareUsd: 0,
        expert16Usd: 0,
        retainedUsd: 0,
        imagesPerDay: 5,
        talkMinutes: 1,
        talkPeriod: 'weekly',
        fastPeriod: 'daily',
        allowThinking: false,
        allowExpert4: false,
        allowExpert16: false
    },
    plus: {
        id: 'plus',
        label: 'Plus',
        priceUsd: 5,
        fastUsd: 1.30,
        thinkShareUsd: 0.60,
        expert16Usd: 0,
        retainedUsd: 3,
        imagesPerDay: 10,
        talkMinutes: 5,
        talkPeriod: 'period',
        fastPeriod: 'period',
        allowThinking: true,
        allowExpert4: false,
        allowExpert16: false
    },
    pro: {
        id: 'pro',
        label: 'Pro',
        priceUsd: 10,
        fastUsd: 3.80,
        thinkShareUsd: 3,
        expert16Usd: 0,
        retainedUsd: 3,
        imagesPerDay: 20,
        talkMinutes: 10,
        talkPeriod: 'period',
        fastPeriod: 'period',
        allowThinking: true,
        allowExpert4: true,
        allowExpert16: false
    },
    max: {
        id: 'max',
        label: 'Max',
        priceUsd: 15,
        fastUsd: 5.60,
        thinkShareUsd: 3,
        expert16Usd: 3,
        retainedUsd: 3,
        imagesPerDay: 30,
        talkMinutes: 20,
        talkPeriod: 'period',
        fastPeriod: 'period',
        allowThinking: true,
        allowExpert4: true,
        allowExpert16: true
    }
};

const PLAN_RANK = { free: 0, plus: 1, pro: 2, max: 3 };

function roundUsd(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x <= 0) return 0;
    return Math.round(x * 1e8) / 1e8;
}

function cloneCaps(c) {
    const src = c && typeof c === 'object' ? c : {};
    // Migrate legacy message-count caps → $ budgets using plan base if needed
    let fastUsd = src.fastUsd;
    let thinkShareUsd = src.thinkShareUsd;
    let expert16Usd = src.expert16Usd;
    // Prior single "other" pool → ThinkShare (Expert16 starts at 0 unless set)
    if (thinkShareUsd == null && src.otherUsd != null) {
        thinkShareUsd = src.otherUsd;
    }
    if (fastUsd == null && (src.fastPerDay != null || src.thinkingPerPeriod != null)) {
        // Legacy shape: cannot convert 1:1; caller should prefer capsFromPlanId.
        fastUsd = 0;
        thinkShareUsd = 0;
        expert16Usd = 0;
    }
    return {
        fastUsd: roundUsd(Math.max(0, Number(fastUsd) || 0)),
        thinkShareUsd: roundUsd(Math.max(0, Number(thinkShareUsd) || 0)),
        expert16Usd: roundUsd(Math.max(0, Number(expert16Usd) || 0))
    };
}

function capsFromPlanId(planId) {
    const def = PLAN_DEFS[planId] || PLAN_DEFS.free;
    return cloneCaps({
        fastUsd: def.fastUsd,
        thinkShareUsd: def.thinkShareUsd,
        expert16Usd: def.expert16Usd
    });
}

function addCaps(a, b) {
    const x = cloneCaps(a);
    const y = cloneCaps(b);
    return {
        fastUsd: roundUsd(x.fastUsd + y.fastUsd),
        thinkShareUsd: roundUsd(x.thinkShareUsd + y.thinkShareUsd),
        expert16Usd: roundUsd(x.expert16Usd + y.expert16Usd)
    };
}

/** Difference of base plan defs (new − old), floored at 0 per bucket. */
function deltaCaps(newPlanId, oldPlanId) {
    const n = capsFromPlanId(newPlanId);
    const o = capsFromPlanId(oldPlanId);
    return {
        fastUsd: roundUsd(Math.max(0, n.fastUsd - o.fastUsd)),
        thinkShareUsd: roundUsd(Math.max(0, n.thinkShareUsd - o.thinkShareUsd)),
        expert16Usd: roundUsd(Math.max(0, n.expert16Usd - o.expert16Usd))
    };
}

function defWithCaps(planId, caps) {
    const base = PLAN_DEFS[planId] || PLAN_DEFS.free;
    if (!caps) return Object.assign({}, base);
    const c = cloneCaps(caps);
    return {
        id: base.id,
        label: base.label,
        priceUsd: base.priceUsd,
        fastUsd: c.fastUsd,
        thinkShareUsd: c.thinkShareUsd,
        expert16Usd: c.expert16Usd,
        retainedUsd: base.retainedUsd || 0,
        imagesPerDay: Number(base.imagesPerDay) || 0,
        talkMinutes: Number(base.talkMinutes) || 0,
        talkPeriod: base.talkPeriod || (base.id === 'free' ? 'weekly' : 'period'),
        fastPeriod: base.fastPeriod,
        allowThinking: !!base.allowThinking,
        allowExpert4: !!base.allowExpert4,
        allowExpert16: !!base.allowExpert16
    };
}

function isLegacyCaps(caps) {
    if (!caps || typeof caps !== 'object') return false;
    if (caps.fastUsd != null || caps.thinkShareUsd != null || caps.otherUsd != null || caps.expert16Usd != null) {
        return false;
    }
    return caps.fastPerDay != null || caps.thinkingPerPeriod != null ||
        caps.expert4PerPeriod != null || caps.expert16PerPeriod != null;
}

/**
 * Migrate stacked legacy message caps → approximate $ caps by scale vs base plan.
 */
function migrateLegacyCaps(planId, legacy) {
    const baseMsg = {
        free: { fast: 50, think: 0, e16: 0 },
        plus: { fast: 120, think: 40, e16: 0 },
        pro: { fast: 200, think: 80 + 40, e16: 0 },
        max: { fast: 300, think: 120 + 60, e16: 15 }
    };
    const base$ = capsFromPlanId(planId);
    const bm = baseMsg[planId] || baseMsg.free;
    const lf = Number(legacy.fastPerDay) || 0;
    const lt = (Number(legacy.thinkingPerPeriod) || 0) + (Number(legacy.expert4PerPeriod) || 0);
    const le = Number(legacy.expert16PerPeriod) || 0;
    const fastScale = bm.fast > 0 ? lf / bm.fast : 1;
    const thinkScale = bm.think > 0 ? lt / bm.think : (lt > 0 ? 1 : 0);
    const e16Scale = bm.e16 > 0 ? le / bm.e16 : (le > 0 ? 1 : 0);
    return {
        fastUsd: roundUsd(base$.fastUsd * Math.max(0, fastScale)),
        thinkShareUsd: roundUsd(base$.thinkShareUsd * Math.max(0, thinkScale)),
        expert16Usd: roundUsd(base$.expert16Usd * Math.max(0, e16Scale))
    };
}

function modesForPlan(planId) {
    const def = PLAN_DEFS[planId] || PLAN_DEFS.free;
    return {
        fast: true,
        thinking: !!def.allowThinking,
        expert4: !!def.allowExpert4,
        expert16: !!def.allowExpert16
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
    let before;
    if (activePaid) {
        if (currentSub.caps && isLegacyCaps(currentSub.caps)) {
            before = migrateLegacyCaps(fromPlan, currentSub.caps);
        } else if (currentSub.caps) {
            before = cloneCaps(currentSub.caps);
            // If migration left zeros, fall back to plan base
            if (before.fastUsd <= 0 && before.thinkShareUsd <= 0 && before.expert16Usd <= 0) {
                before = capsFromPlanId(fromPlan);
            }
        } else {
            before = capsFromPlanId(fromPlan);
        }
    } else {
        before = capsFromPlanId('free');
    }
    const newBase = capsFromPlanId(toPlan);
    const fromRank = PLAN_RANK[fromPlan] || 0;
    const toRank = PLAN_RANK[toPlan] || 0;

    let mode;
    let plan;
    let delta;
    let after;

    if (!activePaid || fromPlan === 'free' || fromRank === 0) {
        mode = 'grant_full';
        plan = toPlan;
        delta = cloneCaps(newBase);
        after = cloneCaps(newBase);
    } else if (toPlan === fromPlan) {
        mode = 'same_stack';
        plan = toPlan;
        delta = cloneCaps(newBase);
        after = addCaps(before, newBase);
    } else if (toRank > fromRank) {
        mode = 'upgrade_delta';
        plan = toPlan;
        delta = deltaCaps(toPlan, fromPlan);
        after = addCaps(before, delta);
    } else {
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

/** ISO-like UTC week key (YYYY-Www) for Free Talk reset. */
function utcWeekKey(d = new Date()) {
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return date.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

/**
 * Estimate spoken seconds for Live/TTS from text + playback speed.
 * ~15 chars/sec at speed 1.0 (≈150 wpm). Minimum 0.5s.
 */
function estimateTalkSeconds(text, speed) {
    const s = Number(speed);
    const spd = Number.isFinite(s) && s > 0 ? Math.max(0.25, Math.min(4, s)) : 1;
    const chars = String(text || '').length;
    if (chars <= 0) return 0;
    const raw = chars / 15 / spd;
    return Math.max(0.5, Math.round(raw * 100) / 100);
}

function emptyStore() {
    return {
        subscriptions: {},
        phoneIndex: {},
        usage: {},
        payments: [],
        geoCache: {},
        settings: {
            paused: false,
            pausedAt: null,
            pausedBy: null
        }
    };
}

function poolForKind(kind) {
    if (kind === 'fast') return 'fast';
    if (kind === 'thinking' || kind === 'expert4' || kind === 'thinkShare' || kind === 'other') return 'thinkShare';
    if (kind === 'expert16') return 'expert16';
    return null;
}


function thinkShareUsed(u) {
    if (!u || typeof u !== 'object') return 0;
    if (u.thinkShareSpendUsd != null) return roundUsd(Number(u.thinkShareSpendUsd) || 0);
    return roundUsd(Number(u.otherSpendUsd) || 0);
}

function expert16Used(u) {
    if (!u || typeof u !== 'object') return 0;
    return roundUsd(Number(u.expert16SpendUsd) || 0);
}


function rollImageDay(u, day) {
    if (!u || typeof u !== 'object') return u;
    if (u.imagesToday == null) u.imagesToday = 0;
    if (!u.imageDay || u.imageDay !== day) {
        u.imageDay = day;
        u.imagesToday = 0;
    }
    return u;
}

/**
 * Roll Talk seconds for Free (UTC week) or paid (30-day period key).
 * Talk is Live/TTS voice time — hard-stop, no borrow from mode $ buckets.
 */
function rollTalkPeriod(u, planId, periodStartsAt) {
    if (!u || typeof u !== 'object') return u;
    if (u.talkSecondsUsed == null) u.talkSecondsUsed = 0;
    const isFree = !planId || planId === 'free';
    const key = isFree
        ? ('week:' + utcWeekKey())
        : ('period:' + (periodStartsAt || 'none'));
    if (!u.talkPeriodKey || u.talkPeriodKey !== key) {
        u.talkPeriodKey = key;
        u.talkSecondsUsed = 0;
    }
    return u;
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

    function normalizeSettings(src) {
        const s = src && typeof src === 'object' ? src : {};
        return {
            paused: !!s.paused,
            pausedAt: s.pausedAt ? String(s.pausedAt) : null,
            pausedBy: s.pausedBy ? String(s.pausedBy) : null
        };
    }

    function normalizeStore(parsed) {
        const src = parsed && typeof parsed === 'object' ? parsed : {};
        return {
            subscriptions: src.subscriptions && typeof src.subscriptions === 'object' ? src.subscriptions : {},
            phoneIndex: src.phoneIndex && typeof src.phoneIndex === 'object' ? src.phoneIndex : {},
            usage: src.usage && typeof src.usage === 'object' ? src.usage : {},
            payments: Array.isArray(src.payments) ? src.payments : [],
            geoCache: src.geoCache && typeof src.geoCache === 'object' ? src.geoCache : {},
            settings: normalizeSettings(src.settings)
        };
    }

    function storeHasData(store) {
        if (!store) return false;
        const settings = store.settings || {};
        return Object.keys(store.subscriptions || {}).length > 0 ||
            Object.keys(store.usage || {}).length > 0 ||
            Object.keys(store.phoneIndex || {}).length > 0 ||
            (Array.isArray(store.payments) && store.payments.length > 0) ||
            !!settings.paused ||
            !!settings.pausedAt;
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
        let caps;
        if (sub.caps && isLegacyCaps(sub.caps)) {
            caps = migrateLegacyCaps(sub.plan, sub.caps);
            // Persist migrated $ caps so stacking / status stay consistent
            sub.caps = caps;
            save();
        } else if (sub.caps) {
            caps = cloneCaps(sub.caps);
            if (caps.fastUsd <= 0 && caps.thinkShareUsd <= 0 && caps.expert16Usd <= 0) {
                caps = capsFromPlanId(sub.plan);
            }
        } else {
            caps = capsFromPlanId(sub.plan);
        }
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

    function emptyUsageRow(day, periodStartsAt) {
        const d = day || utcDayKey();
        return {
            day: d,
            periodStartsAt: periodStartsAt || null,
            fastSpendUsd: 0,
            thinkShareSpendUsd: 0,
            expert16SpendUsd: 0,
            // legacy alias kept for migration / admin visibility
            otherSpendUsd: 0,
            // Admin / analytics: daily + lifetime (not reset by plan period)
            spendDay: d,
            todaySpendUsd: 0,
            todayTokens: 0,
            todayGrokSpendUsd: 0,
            todayOpenaiSpendUsd: 0,
            totalSpendUsd: 0,
            totalTokens: 0,
            totalGrokSpendUsd: 0,
            totalOpenaiSpendUsd: 0,
            // legacy counters kept for migration / admin visibility
            fast: 0,
            thinking: 0,
            expert4: 0,
            expert16: 0,
            imagesToday: 0,
            imageDay: d,
            talkSecondsUsed: 0,
            talkPeriodKey: null,
            fastHalved: false
        };
    }

    function migrateUsageTotals(u, day) {
        if (!u || typeof u !== 'object') return u;
        if (u.totalSpendUsd == null) {
            // Seed lifetime from current period pools (best-effort for pre-existing rows)
            u.totalSpendUsd = roundUsd((Number(u.fastSpendUsd) || 0) + thinkShareUsed(u) + expert16Used(u));
        }
        if (u.totalTokens == null) u.totalTokens = 0;
        if (u.todaySpendUsd == null) u.todaySpendUsd = 0;
        if (u.todayTokens == null) u.todayTokens = 0;
        if (u.todayGrokSpendUsd == null) u.todayGrokSpendUsd = 0;
        if (u.todayOpenaiSpendUsd == null) u.todayOpenaiSpendUsd = 0;
        if (u.totalGrokSpendUsd == null) u.totalGrokSpendUsd = 0;
        if (u.totalOpenaiSpendUsd == null) u.totalOpenaiSpendUsd = 0;
        if (!u.spendDay) u.spendDay = u.day || day || utcDayKey();
        return u;
    }

    function rollDailySpendCounters(u, day) {
        migrateUsageTotals(u, day);
        if (u.spendDay !== day) {
            u.spendDay = day;
            u.todaySpendUsd = 0;
            u.todayTokens = 0;
            u.todayGrokSpendUsd = 0;
            u.todayOpenaiSpendUsd = 0;
        }
        return u;
    }

    /** Read-only admin snapshot of today + lifetime spend (tokens + USD). */
    function adminUsageSnapshot(ownerKey) {
        const store = read();
        const day = utcDayKey();
        const u = (ownerKey && store.usage[ownerKey]) || null;
        if (!u) {
            return {
                todayTokens: 0,
                todaySpendUsd: 0,
                todayGrokSpendUsd: 0,
                todayOpenaiSpendUsd: 0,
                totalTokens: 0,
                totalSpendUsd: 0,
                totalGrokSpendUsd: 0,
                totalOpenaiSpendUsd: 0,
                periodFastSpendUsd: 0,
                periodThinkShareSpendUsd: 0,
                periodExpert16SpendUsd: 0,
                periodOtherSpendUsd: 0
            };
        }
        const spendDay = u.spendDay || u.day || null;
        const todayActive = spendDay === day;
        return {
            todayTokens: todayActive ? (Number(u.todayTokens) || 0) : 0,
            todaySpendUsd: todayActive ? roundUsd(Number(u.todaySpendUsd) || 0) : 0,
            todayGrokSpendUsd: todayActive ? roundUsd(Number(u.todayGrokSpendUsd) || 0) : 0,
            todayOpenaiSpendUsd: todayActive ? roundUsd(Number(u.todayOpenaiSpendUsd) || 0) : 0,
            totalTokens: Number(u.totalTokens) || 0,
            totalSpendUsd: roundUsd(
                u.totalSpendUsd != null
                    ? Number(u.totalSpendUsd) || 0
                    : (Number(u.fastSpendUsd) || 0) + thinkShareUsed(u) + expert16Used(u)
            ),
            totalGrokSpendUsd: roundUsd(Number(u.totalGrokSpendUsd) || 0),
            totalOpenaiSpendUsd: roundUsd(Number(u.totalOpenaiSpendUsd) || 0),
            periodFastSpendUsd: roundUsd(Number(u.fastSpendUsd) || 0),
            periodThinkShareSpendUsd: thinkShareUsed(u),
            periodExpert16SpendUsd: expert16Used(u),
            periodOtherSpendUsd: roundUsd(thinkShareUsed(u) + expert16Used(u))
        };
    }

    function ensureUsage(deviceId) {
        const store = read();
        const day = utcDayKey();
        const effective = getEffectivePlan(deviceId);
        let u = store.usage[deviceId];
        if (!u) {
            u = emptyUsageRow(day, effective.startsAt || null);
            store.usage[deviceId] = u;
            save();
            return u;
        }
        // Migrate legacy-only rows
        if (u.fastSpendUsd == null) u.fastSpendUsd = 0;
        if (u.thinkShareSpendUsd == null) {
            u.thinkShareSpendUsd = roundUsd(Number(u.otherSpendUsd) || 0);
        }
        if (u.expert16SpendUsd == null) u.expert16SpendUsd = 0;
        if (u.otherSpendUsd == null) u.otherSpendUsd = roundUsd(thinkShareUsed(u) + expert16Used(u));
        rollDailySpendCounters(u, day);
        rollImageDay(u, day);
        if (u.talkSecondsUsed == null) u.talkSecondsUsed = 0;
        rollTalkPeriod(u, effective.plan, effective.startsAt || null);

        if (effective.plan === 'free') {
            // Free Fast: small daily $ allowance resets at UTC midnight
            if (u.day !== day) {
                u.day = day;
                u.fastSpendUsd = 0;
                u.fast = 0;
                u.fastHalved = false;
                save();
            }
        } else {
            // Paid: buckets are period budgets (no daily Fast reset)
            if (u.day !== day) {
                u.day = day;
                save();
            }
        }

        const periodKey = effective.startsAt || null;
        if ((u.periodStartsAt || null) !== periodKey) {
            u.periodStartsAt = periodKey;
            u.fastSpendUsd = 0;
            u.thinkShareSpendUsd = 0;
            u.expert16SpendUsd = 0;
            u.otherSpendUsd = 0;
            u.thinking = 0;
            u.expert4 = 0;
            u.expert16 = 0;
            // Keep same-day free fast counter if somehow on free; for paid clear Fast spend
            if (effective.plan !== 'free') {
                u.fast = 0;
            }
            // Re-key Talk for the new paid period (or Free week)
            rollTalkPeriod(u, effective.plan, periodKey);
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

    function budgetCapsFor(deviceId) {
        const effective = getEffectivePlan(deviceId);
        return {
            plan: effective.plan,
            def: effective.def,
            caps: effective.caps,
            fastCap: roundUsd(effective.def.fastUsd),
            thinkShareCap: roundUsd(effective.def.thinkShareUsd),
            expert16Cap: roundUsd(effective.def.expert16Usd),
            // Back-compat alias (ThinkShare + Expert16)
            otherCap: roundUsd(
                (Number(effective.def.thinkShareUsd) || 0) + (Number(effective.def.expert16Usd) || 0)
            ),
            startsAt: effective.startsAt,
            endsAt: effective.endsAt
        };
    }

    function remainingFor(deviceId, pool) {
        const { fastCap, thinkShareCap, expert16Cap } = budgetCapsFor(deviceId);
        const u = ensureUsage(deviceId);
        if (pool === 'fast') {
            return roundUsd(Math.max(0, fastCap - (Number(u.fastSpendUsd) || 0)));
        }
        if (pool === 'expert16') {
            return roundUsd(Math.max(0, expert16Cap - expert16Used(u)));
        }
        // thinkShare (and legacy "other")
        return roundUsd(Math.max(0, thinkShareCap - thinkShareUsed(u)));
    }

    /**
     * Demote paid subscription to Free when all usable $ buckets are exhausted.
     */
    function demoteToFree(deviceId, reason) {
        if (!deviceId) return null;
        const store = read();
        const sub = store.subscriptions[deviceId];
        if (!sub || !sub.plan || sub.plan === 'free') return null;
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
            demotedAt: new Date().toISOString(),
            demoteReason: String(reason || 'budget_exhausted').slice(0, 200)
        };
        // Start fresh Free daily allowance
        const u = store.usage[deviceId] || emptyUsageRow(utcDayKey(), null);
        u.periodStartsAt = null;
        u.fastSpendUsd = 0;
        u.thinkShareSpendUsd = 0;
        u.expert16SpendUsd = 0;
        u.otherSpendUsd = 0;
        u.day = utcDayKey();
        u.fast = 0;
        u.thinking = 0;
        u.expert4 = 0;
        u.expert16 = 0;
        rollTalkPeriod(u, 'free', null);
        store.usage[deviceId] = u;
        save();
        flushSync();
        return store.subscriptions[deviceId];
    }

    function maybeDemoteIfExhausted(deviceId) {
        const effective = getEffectivePlan(deviceId);
        if (effective.plan === 'free') return { demoted: false, plan: 'free' };
        const u = ensureUsage(deviceId);
        const fastCap = roundUsd(effective.def.fastUsd);
        const thinkShareCap = roundUsd(effective.def.thinkShareUsd);
        const expert16Cap = roundUsd(effective.def.expert16Usd);
        const fastDone = (Number(u.fastSpendUsd) || 0) >= fastCap - 1e-9;
        const thinkDone = thinkShareCap <= 0
            ? true
            : (thinkShareUsed(u) >= thinkShareCap - 1e-9);
        const e16Done = expert16Cap <= 0
            ? true
            : (expert16Used(u) >= expert16Cap - 1e-9);
        // Demote when every usable paid bucket is exhausted (no borrowing across buckets).
        const allotmentDone = fastDone && thinkDone && e16Done;
        if (allotmentDone) {
            demoteToFree(deviceId, 'paid_allotment_exhausted');
            return { demoted: true, plan: 'free' };
        }
        return { demoted: false, plan: effective.plan };
    }

    function buildLimitError(kind, deviceId) {
        const effective = getEffectivePlan(deviceId);
        const u = ensureUsage(deviceId);
        const upgradeUrl = '/upgrade';
        const pool = poolForKind(kind) || 'fast';
        const fastCap = roundUsd(effective.def.fastUsd);
        const thinkShareCap = roundUsd(effective.def.thinkShareUsd);
        const expert16Cap = roundUsd(effective.def.expert16Usd);
        const fastUsed = roundUsd(u.fastSpendUsd || 0);
        const thinkUsed = thinkShareUsed(u);
        const e16Used = expert16Used(u);
        const modes = modesForPlan(effective.plan);

        function pctUsed(used, cap) {
            const lim = Number(cap) || 0;
            if (lim <= 0) return 100;
            return Math.max(0, Math.min(100, Math.round((Number(used) || 0) / lim * 100)));
        }

        const labels = {
            thinking: 'Thinking',
            expert4: 'Expert 4 (4-AI)',
            expert16: 'Expert 16 (16-AI)',
            thinkShare: 'Thinking / Expert 4',
            other: 'Thinking / Expert',
            fast: 'Fast'
        };

        // Mode not on this plan (hard gate — not a spend issue)
        if (kind === 'thinking' && !modes.thinking) {
            return {
                status: 429,
                code: 'plan_required',
                reply: 'Thinking is not included on Free. Plan used — please upgrade.',
                upgradeUrl,
                limit: { kind, pool: 'thinkShare', percent: 100, percentLeft: 0, unit: 'percent', plan: effective.plan }
            };
        }
        if (kind === 'expert4' && !modes.expert4) {
            return {
                status: 429,
                code: 'plan_required',
                reply: 'Expert 4 is not included on ' + (effective.def.label || effective.plan) +
                    '. Plan used — please upgrade.',
                upgradeUrl,
                limit: { kind, pool: 'thinkShare', percent: 100, percentLeft: 0, unit: 'percent', plan: effective.plan }
            };
        }
        if (kind === 'expert16' && !modes.expert16) {
            return {
                status: 429,
                code: 'plan_required',
                reply: 'Expert 16 is not included on ' + (effective.def.label || effective.plan) +
                    '. Plan used — please upgrade.',
                upgradeUrl,
                limit: { kind, pool: 'expert16', percent: 100, percentLeft: 0, unit: 'percent', plan: effective.plan }
            };
        }

        if (pool === 'fast') {
            const percent = pctUsed(fastUsed, fastCap);
            return {
                status: 429,
                code: 'limit_reached',
                reply: 'Plan used — please upgrade. Fast allowance is ' + percent + '% used.',
                upgradeUrl,
                limit: {
                    kind: 'fast',
                    pool: 'fast',
                    percent,
                    percentLeft: Math.max(0, 100 - percent),
                    unit: 'percent',
                    plan: effective.plan,
                    resets: effective.plan === 'free' ? 'utc_midnight' : 'period'
                }
            };
        }

        if (pool === 'expert16') {
            const percent = pctUsed(e16Used, expert16Cap);
            return {
                status: 429,
                code: 'limit_reached',
                reply: 'Plan used — please upgrade. Expert 16 allowance is ' + percent + '% used.',
                upgradeUrl,
                limit: {
                    kind,
                    pool: 'expert16',
                    percent,
                    percentLeft: Math.max(0, 100 - percent),
                    unit: 'percent',
                    plan: effective.plan,
                    resets: 'period'
                }
            };
        }

        // thinkShare
        const percent = pctUsed(thinkUsed, thinkShareCap);
        const shareLabel = modes.expert4
            ? 'Thinking & Expert 4 share this allowance'
            : 'Thinking allowance';
        return {
            status: 429,
            code: 'limit_reached',
            reply: 'Plan used — please upgrade. ' + (labels[kind] || 'This mode') +
                ' allowance is ' + percent + '% used. ' + shareLabel + '.',
            upgradeUrl,
            limit: {
                kind,
                pool: 'thinkShare',
                percent,
                percentLeft: Math.max(0, 100 - percent),
                unit: 'percent',
                plan: effective.plan,
                resets: 'period'
            }
        };
    }

    /**
     * Check whether a chat request is allowed. Does not consume budget.
     * Demotes to Free when paid allotment is already fully used.
     */
    function buildImageLimitError(deviceId) {
        const effective = getEffectivePlan(deviceId);
        const u = ensureUsage(deviceId);
        const cap = Number(effective.def.imagesPerDay) || 0;
        const used = Number(u.imagesToday) || 0;
        const percent = cap <= 0 ? 100 : Math.max(0, Math.min(100, Math.round(used / cap * 100)));
        return {
            status: 429,
            code: 'image_limit_reached',
            reply: 'Daily image limit reached (' + percent + '% used). Resets at UTC midnight. Documents/files are still unlimited.',
            upgradeUrl: '/upgrade',
            limit: {
                kind: 'images',
                pool: 'images',
                percent,
                percentLeft: Math.max(0, 100 - percent),
                unit: 'percent',
                plan: effective.plan,
                resets: 'utc_midnight'
            }
        };
    }

    function checkImageAllowed(deviceId) {
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
        const effective = getEffectivePlan(deviceId);
        const u = ensureUsage(deviceId);
        const cap = Number(effective.def.imagesPerDay) || 0;
        const used = Number(u.imagesToday) || 0;
        if (cap > 0 && used >= cap) {
            return { ok: false, error: buildImageLimitError(deviceId) };
        }
        return { ok: true, left: Math.max(0, cap - used), cap, used };
    }

    /**
     * Count one image send against the daily image cap (UTC day).
     * Does not touch $ buckets — image token cost is recorded via recordSpend into Fast/etc.
     */
    function recordImage(deviceId) {
        if (!deviceId) return null;
        const u = ensureUsage(deviceId);
        rollImageDay(u, utcDayKey());
        u.imagesToday = (Number(u.imagesToday) || 0) + 1;
        flushSync();
        return { imagesToday: u.imagesToday, imagesCap: Number(getEffectivePlan(deviceId).def.imagesPerDay) || 0 };
    }

    function talkCapSeconds(def) {
        const mins = Number(def && def.talkMinutes) || 0;
        return Math.max(0, mins) * 60;
    }

    function buildTalkLimitError(deviceId) {
        const effective = getEffectivePlan(deviceId);
        const u = ensureUsage(deviceId);
        const capSec = talkCapSeconds(effective.def);
        const used = Number(u.talkSecondsUsed) || 0;
        const percent = capSec <= 0 ? 100 : Math.max(0, Math.min(100, Math.round(used / capSec * 100)));
        const period = (effective.def.talkPeriod === 'weekly') ? 'weekly' : 'period';
        const resetHint = period === 'weekly'
            ? 'Resets each UTC week.'
            : 'Resets with your paid period.';
        return {
            status: 429,
            code: 'talk_limit_reached',
            reply: 'Talk (Live / speak-aloud) limit reached (' + percent + '% used). ' + resetHint,
            upgradeUrl: '/upgrade',
            limit: {
                kind: 'talk',
                pool: 'talk',
                percent,
                percentLeft: Math.max(0, 100 - percent),
                unit: 'percent',
                plan: effective.plan,
                period,
                resets: period === 'weekly' ? 'utc_week' : 'paid_period'
            }
        };
    }

    /**
     * Check Talk (Live/TTS voice time) allowance. Does not consume.
     * @param {string} deviceId
     * @param {number} [secondsNeeded=0] - estimated seconds for this utterance
     */
    function checkTalkAllowed(deviceId, secondsNeeded) {
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
        const effective = getEffectivePlan(deviceId);
        const u = ensureUsage(deviceId);
        const capSec = talkCapSeconds(effective.def);
        const used = Number(u.talkSecondsUsed) || 0;
        const need = Math.max(0, Number(secondsNeeded) || 0);
        if (capSec <= 0) {
            return { ok: false, error: buildTalkLimitError(deviceId), leftSec: 0, capSec: 0, used };
        }
        if (used >= capSec - 1e-9) {
            return { ok: false, error: buildTalkLimitError(deviceId), leftSec: 0, capSec, used };
        }
        // Hard-stop: do not start an utterance that would fully exhaust leftover under need
        // Still allow if any time remains (last clip may slightly overrun).
        return {
            ok: true,
            leftSec: Math.max(0, capSec - used),
            capSec,
            used,
            need
        };
    }

    /**
     * Record Talk seconds (Live / TTS). Hard-stop pool — never borrows from mode $.
     */
    function recordTalk(deviceId, seconds) {
        if (!deviceId) return null;
        const sec = Math.max(0, Number(seconds) || 0);
        if (sec <= 0) return null;
        const effective = getEffectivePlan(deviceId);
        const u = ensureUsage(deviceId);
        rollTalkPeriod(u, effective.plan, effective.startsAt || null);
        u.talkSecondsUsed = Math.round(((Number(u.talkSecondsUsed) || 0) + sec) * 100) / 100;
        flushSync();
        const capSec = talkCapSeconds(effective.def);
        return {
            talkSecondsUsed: u.talkSecondsUsed,
            talkCapSeconds: capSec,
            talkMinutes: Number(effective.def.talkMinutes) || 0
        };
    }

    function checkChatAllowed(deviceId, mode, agents, opts) {
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
        const options = opts && typeof opts === 'object' ? opts : {};
        const hasImage = !!options.hasImage;
        const demote = maybeDemoteIfExhausted(deviceId);
        const kind = resolveUsageKind(mode, agents);
        const pool = poolForKind(kind);
        const effective = getEffectivePlan(deviceId);
        const modes = modesForPlan(effective.plan);

        if (kind === 'thinking' && !modes.thinking) {
            return { ok: false, error: buildLimitError(kind, deviceId), kind, pool };
        }
        if (kind === 'expert4' && !modes.expert4) {
            return { ok: false, error: buildLimitError(kind, deviceId), kind, pool };
        }
        if (kind === 'expert16' && !modes.expert16) {
            return { ok: false, error: buildLimitError(kind, deviceId), kind, pool };
        }

        if (hasImage) {
            const img = checkImageAllowed(deviceId);
            if (!img.ok) {
                return { ok: false, error: img.error, kind, pool, imageBlocked: true };
            }
        }

        const left = remainingFor(deviceId, pool);
        if (left <= 1e-9) {
            // Hard-stop this bucket; demote only when all usable buckets are done
            if (effective.plan !== 'free') {
                maybeDemoteIfExhausted(deviceId);
            }
            return { ok: false, error: buildLimitError(kind, deviceId), kind, pool, demoted: demote.demoted };
        }
        return { ok: true, kind, pool, plan: effective.plan, leftUsd: left, hasImage };
    }

    /**
     * Record actual $ spend after a successful model call.
     * @param {string} deviceId
     * @param {string} kind - fast | thinking | expert4 | expert16
     * @param {{ costUsd: number, model?: string, provider?: string, promptTokens?: number, completionTokens?: number }} spend
     */
    function recordSpend(deviceId, kind, spend) {
        if (!deviceId || !kind) return null;
        const pool = poolForKind(kind);
        if (!pool) return null;
        const cost = roundUsd(spend && spend.costUsd);
        if (cost <= 0) return ensureUsage(deviceId);
        const u = ensureUsage(deviceId);
        const promptTokens = spend && spend.promptTokens != null ? Math.max(0, Number(spend.promptTokens) || 0) : 0;
        const completionTokens = spend && spend.completionTokens != null ? Math.max(0, Number(spend.completionTokens) || 0) : 0;
        const tokens = promptTokens + completionTokens;
        rollDailySpendCounters(u, utcDayKey());
        if (pool === 'fast') {
            u.fastSpendUsd = roundUsd((Number(u.fastSpendUsd) || 0) + cost);
            u.fast = (Number(u.fast) || 0) + 1;
        } else if (pool === 'expert16') {
            u.expert16SpendUsd = roundUsd(expert16Used(u) + cost);
            u.expert16 = (Number(u.expert16) || 0) + 1;
        } else {
            // thinkShare — Thinking and Expert 4 share; never borrow from Expert16/Fast
            u.thinkShareSpendUsd = roundUsd(thinkShareUsed(u) + cost);
            if (kind === 'thinking') u.thinking = (Number(u.thinking) || 0) + 1;
            else if (kind === 'expert4') u.expert4 = (Number(u.expert4) || 0) + 1;
        }
        u.otherSpendUsd = roundUsd(thinkShareUsed(u) + expert16Used(u));
        u.todaySpendUsd = roundUsd((Number(u.todaySpendUsd) || 0) + cost);
        u.todayTokens = (Number(u.todayTokens) || 0) + tokens;
        u.totalSpendUsd = roundUsd((Number(u.totalSpendUsd) || 0) + cost);
        u.totalTokens = (Number(u.totalTokens) || 0) + tokens;
        const provider = normalizeProvider(
            spend && spend.provider,
            spend && spend.model
        );
        if (provider === 'grok') {
            u.todayGrokSpendUsd = roundUsd((Number(u.todayGrokSpendUsd) || 0) + cost);
            u.totalGrokSpendUsd = roundUsd((Number(u.totalGrokSpendUsd) || 0) + cost);
        } else if (provider === 'openai') {
            u.todayOpenaiSpendUsd = roundUsd((Number(u.todayOpenaiSpendUsd) || 0) + cost);
            u.totalOpenaiSpendUsd = roundUsd((Number(u.totalOpenaiSpendUsd) || 0) + cost);
        }
        u.lastSpend = {
            at: new Date().toISOString(),
            kind,
            pool,
            costUsd: cost,
            model: spend && spend.model ? String(spend.model) : null,
            provider: provider !== 'unknown' ? provider : null,
            promptTokens: spend && spend.promptTokens != null ? Number(spend.promptTokens) : null,
            completionTokens: spend && spend.completionTokens != null ? Number(spend.completionTokens) : null
        };
        flushSync();
        const demote = maybeDemoteIfExhausted(deviceId);
        return { usage: u, demoted: demote.demoted, plan: demote.plan };
    }

    /** @deprecated message-count hold — kept as no-op shim for older callers */
    function recordUsage(deviceId, kind) {
        // Soft provisional hold removed; spend is recorded after provider usage arrives.
        return ensureUsage(deviceId);
    }

    function releaseUsage() {
        // No-op: provisional message holds removed under $ budgets.
    }

    function markFastHalved() {
        // No-op: Grok fallback cost is billed via actual tokens into the Fast pool.
    }

    function getStatus(deviceId) {
        const effective = getEffectivePlan(deviceId || '');
        const u = deviceId ? ensureUsage(deviceId) : emptyUsageRow(utcDayKey(), null);
        const day = utcDayKey();
        rollImageDay(u, day);
        const fastCap = roundUsd(effective.def.fastUsd);
        const thinkShareCap = roundUsd(effective.def.thinkShareUsd);
        const expert16Cap = roundUsd(effective.def.expert16Usd);
        const imagesCap = Number(effective.def.imagesPerDay) || 0;
        rollTalkPeriod(u, effective.plan, effective.startsAt || null);
        const talkCapSec = Math.max(0, (Number(effective.def.talkMinutes) || 0) * 60);
        const talkUsed = Number(u.talkSecondsUsed) || 0;
        const fastUsed = roundUsd(u.fastSpendUsd || 0);
        const thinkUsed = thinkShareUsed(u);
        const e16Used = expert16Used(u);
        const imagesUsed = Number(u.imagesToday) || 0;
        const otherUsed = roundUsd(thinkUsed + e16Used);
        const otherCap = roundUsd(thinkShareCap + expert16Cap);
        const baseDef = getPlanDef(effective.plan);
        const stacked = effective.plan !== 'free' && (
            roundUsd(effective.caps.fastUsd) !== roundUsd(baseDef.fastUsd) ||
            roundUsd(effective.caps.thinkShareUsd) !== roundUsd(baseDef.thinkShareUsd) ||
            roundUsd(effective.caps.expert16Usd) !== roundUsd(baseDef.expert16Usd)
        );
        const modes = modesForPlan(effective.plan);
        return {
            plan: effective.plan,
            label: effective.def.label,
            priceUsd: effective.def.priceUsd,
            phone: effective.phone,
            startsAt: effective.startsAt,
            endsAt: effective.endsAt,
            retainedUsd: effective.def.retainedUsd || 0,
            imagesPerDay: imagesCap,
            talkMinutes: Number(effective.def.talkMinutes) || 0,
            talkPeriod: effective.def.talkPeriod || (effective.plan === 'free' ? 'weekly' : 'period'),
            modes,
            timezoneNote: effective.plan === 'free'
                ? 'Free Fast allowance and daily image cap reset at UTC midnight. Talk (Live/speak-aloud) resets each UTC week. Thinking/Expert require a paid plan. Document uploads are unlimited.'
                : 'Paid Fast / Thinking+Expert4 / Expert16 allowances are per 30-day period from admin confirmation (no auto-renew). Daily image caps reset at UTC midnight. Talk (Live/speak-aloud) is per paid period. When all usable mode allowances are used, you move to Free. Document uploads are unlimited.',
            omtDestination: OMT_DESTINATION,
            pricing: {
                note: 'Internal provider rates (not shown to end users).',
                models: Object.keys(MODEL_PRICING).map((id) => {
                    const r = MODEL_PRICING[id];
                    return {
                        id,
                        inputPerMUsd: r.input,
                        outputPerMUsd: r.output,
                        inputLongPerMUsd: r.inputLong || null,
                        outputLongPerMUsd: r.outputLong || null
                    };
                }),
                defaultPerMUsd: DEFAULT_PRICING
            },
            stacking: {
                active: effective.plan !== 'free',
                stacked: !!stacked,
                stackMode: effective.stackMode || null,
                caps: effective.caps || capsFromPlanId(effective.plan),
                baseCaps: capsFromPlanId(effective.plan),
                rules: [
                    'Free → paid: grant full Fast / Thinking / Expert16 allowances for that plan.',
                    'Upgrade to a higher plan: keep current capacity and ADD the difference vs the lower plan (per mode).',
                    'Buy the same plan again: ADD another full allotment per mode (doubles from a single allotment).',
                    'Modes never borrow from each other.'
                ]
            },
            usage: {
                day: u.day,
                unit: 'usd',
                fastSpendUsd: fastUsed,
                fastCapUsd: fastCap,
                fastLeftUsd: roundUsd(Math.max(0, fastCap - fastUsed)),
                thinkShareSpendUsd: thinkUsed,
                thinkShareCapUsd: thinkShareCap,
                thinkShareLeftUsd: roundUsd(Math.max(0, thinkShareCap - thinkUsed)),
                expert16SpendUsd: e16Used,
                expert16CapUsd: expert16Cap,
                expert16LeftUsd: roundUsd(Math.max(0, expert16Cap - e16Used)),
                // Back-compat combined "other"
                otherSpendUsd: otherUsed,
                otherCapUsd: otherCap,
                otherLeftUsd: roundUsd(Math.max(0, otherCap - otherUsed)),
                imagesToday: imagesUsed,
                imagesCap,
                imagesLeft: Math.max(0, imagesCap - imagesUsed),
                talkSecondsUsed: talkUsed,
                talkCapSeconds: talkCapSec,
                talkLeftSeconds: Math.max(0, talkCapSec - talkUsed),
                talkMinutes: Number(effective.def.talkMinutes) || 0,
                talkPeriod: effective.def.talkPeriod || (effective.plan === 'free' ? 'weekly' : 'period'),
                // Back-compat aliases for older UI that expected message counts:
                fast: fastUsed,
                fastCap: fastCap,
                fastPlanCap: fastCap,
                fastHalved: false,
                thinking: thinkUsed,
                thinkingCap: thinkShareCap,
                expert4: 0,
                expert4Cap: 0,
                expert16: e16Used,
                expert16Cap: expert16Cap,
                requestCounts: {
                    fast: u.fast || 0,
                    thinking: u.thinking || 0,
                    expert4: u.expert4 || 0,
                    expert16: u.expert16 || 0,
                    imagesToday: imagesUsed
                }
            },
            plans: Object.values(PLAN_DEFS).map(p => ({
                id: p.id,
                label: p.label,
                priceUsd: p.priceUsd,
                fastUsd: p.fastUsd,
                thinkShareUsd: p.thinkShareUsd,
                expert16Usd: p.expert16Usd,
                retainedUsd: p.retainedUsd || 0,
                imagesPerDay: p.imagesPerDay || 0,
                talkMinutes: p.talkMinutes || 0,
                talkPeriod: p.talkPeriod || (p.id === 'free' ? 'weekly' : 'period'),
                // legacy alias
                otherUsd: roundUsd((p.thinkShareUsd || 0) + (p.expert16Usd || 0)),
                fastPeriod: p.fastPeriod,
                allowThinking: !!p.allowThinking,
                allowExpert4: !!p.allowExpert4,
                allowExpert16: !!p.allowExpert16
            }))
        };
    }

    /**
     * UI-friendly plan status: plan name + percent-used quotas.
     * End users never see dollar amounts or token counts here — budgets stay $ under the hood.
     * Image quota is also percent of the daily image cap.
     * Talk quota is percent of Live/TTS voice-time minutes (week or paid period).
     */
    function getPlanStatusUi(deviceId) {
        const status = getStatus(deviceId);
        const u = status.usage || {};
        const modes = status.modes || modesForPlan(status.plan);
        const quotas = [];

        function pct(used, limit) {
            const lim = Number(limit) || 0;
            if (lim <= 0) return 0;
            const p = Math.round((Number(used) || 0) / lim * 100);
            return Math.max(0, Math.min(100, p));
        }

        function quotaRow(id, label, period, used, limit, note) {
            const percent = pct(used, limit);
            const leftPct = Math.max(0, 100 - percent);
            const row = {
                id,
                label,
                period,
                unit: 'percent',
                used: percent,
                limit: 100,
                left: leftPct,
                planLimit: 100,
                percent,
                displayUsed: percent + '% used',
                displayLimit: '100%',
                displayLeft: leftPct + '% left'
            };
            if (note) row.note = note;
            return row;
        }

        quotas.push(quotaRow(
            'fast',
            'Fast',
            status.plan === 'free' ? 'daily' : 'monthly',
            u.fastSpendUsd || 0,
            u.fastCapUsd || 0
        ));

        if ((u.thinkShareCapUsd || 0) > 0 || modes.thinking) {
            quotas.push(quotaRow(
                'thinkShare',
                modes.expert4 ? 'Thinking + Expert 4' : 'Thinking',
                'monthly',
                u.thinkShareSpendUsd || 0,
                u.thinkShareCapUsd || 0,
                modes.expert4
                    ? 'Thinking and Expert 4 share this allowance — no borrowing from Fast or Expert 16'
                    : 'Thinking only on Plus — Expert 4/16 not included'
            ));
        }

        if ((u.expert16CapUsd || 0) > 0 || modes.expert16) {
            quotas.push(quotaRow(
                'expert16',
                'Expert 16',
                'monthly',
                u.expert16SpendUsd || 0,
                u.expert16CapUsd || 0,
                'Expert 16 has its own allowance — no borrowing from Thinking/Expert 4'
            ));
        }

        if ((u.imagesCap || 0) > 0) {
            quotas.push(quotaRow(
                'images',
                'Images',
                'daily',
                u.imagesToday || 0,
                u.imagesCap || 0,
                'Daily image count (UTC). Documents/files are unlimited.'
            ));
        }

        if ((u.talkCapSeconds || 0) > 0 || (status.talkMinutes || 0) > 0) {
            const talkPeriod = (u.talkPeriod === 'weekly' || status.talkPeriod === 'weekly') ? 'weekly' : 'monthly';
            quotas.push(quotaRow(
                'talk',
                'Talk',
                talkPeriod,
                u.talkSecondsUsed || 0,
                u.talkCapSeconds || 0,
                talkPeriod === 'weekly'
                    ? 'Live / speak-aloud voice time this UTC week'
                    : 'Live / speak-aloud voice time this paid period'
            ));
        }

        return {
            ok: true,
            plan: status.plan,
            label: status.label,
            priceUsd: status.priceUsd,
            startsAt: status.startsAt,
            endsAt: status.endsAt,
            timezoneNote: status.timezoneNote,
            modes,
            imagesPerDay: status.imagesPerDay || 0,
            talkMinutes: status.talkMinutes || 0,
            talkPeriod: status.talkPeriod || (status.plan === 'free' ? 'weekly' : 'period'),
            quotas,
            upgradeUrl: '/upgrade'
        };
    }

    /**
     * Public /api/plan payload: plan + stacking hints without exposing $ spend / token counts.
     */
    function getPlanPublic(deviceId) {
        const status = getStatus(deviceId);
        const ui = getPlanStatusUi(deviceId);
        const stacking = status.stacking || {};
        return {
            plan: status.plan,
            label: status.label,
            priceUsd: status.priceUsd,
            phone: status.phone,
            startsAt: status.startsAt,
            endsAt: status.endsAt,
            timezoneNote: status.timezoneNote,
            omtDestination: status.omtDestination,
            stacking: {
                active: !!stacking.active,
                stacked: !!stacking.stacked,
                stackMode: stacking.stackMode || null,
                rules: stacking.rules || []
            },
            quotas: ui.quotas,
            modes: ui.modes || modesForPlan(status.plan),
            imagesPerDay: ui.imagesPerDay || 0,
            talkMinutes: ui.talkMinutes || 0,
            talkPeriod: ui.talkPeriod || (status.plan === 'free' ? 'weekly' : 'period'),
            plans: (status.plans || []).map((p) => ({
                id: p.id,
                label: p.label,
                priceUsd: p.priceUsd
            })),
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
            declineReason: p.declineReason || null,
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
            declineReason: p.declineReason || null,
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

        // Reset period $ spend for this account/device owner (stacking adds caps; spend starts fresh for the new period window)
        const u = store.usage[ownerKey] || emptyUsageRow(utcDayKey(), startsAt.toISOString());
        u.periodStartsAt = startsAt.toISOString();
        u.day = utcDayKey();
        u.fastSpendUsd = 0;
        u.thinkShareSpendUsd = 0;
        u.expert16SpendUsd = 0;
        u.otherSpendUsd = 0;
        u.fast = 0;
        u.thinking = 0;
        u.expert4 = 0;
        u.expert16 = 0;
        // Daily image cap is UTC-day based — do not reset mid-day on approve
        rollImageDay(u, utcDayKey());
        // Talk minutes reset with the new paid period
        u.talkPeriodKey = null;
        rollTalkPeriod(u, stack.plan, startsAt.toISOString());
        u.fastHalved = false;
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

    function declinePayment(id, opts) {
        const store = read();
        const payment = store.payments.find(p => p.id === id);
        if (!payment) return { ok: false, error: 'Not found' };
        if (payment.status === 'declined') {
            return { ok: true, payment, already: true };
        }

        const reason = String((opts && opts.reason) || '').trim();
        if (!reason) {
            return { ok: false, error: 'Decline reason is required' };
        }

        payment.status = 'declined';
        payment.decidedAt = new Date().toISOString();
        payment.declineReason = reason.slice(0, 2000);

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

    function getPauseState() {
        const store = read();
        const settings = normalizeSettings(store.settings);
        return {
            paused: !!settings.paused,
            pausedAt: settings.pausedAt,
            pausedBy: settings.pausedBy
        };
    }

    function isPaused() {
        return getPauseState().paused;
    }

    function setPaused(paused, opts) {
        const store = read();
        const next = !!paused;
        const by = opts && opts.by ? String(opts.by).slice(0, 200) : null;
        store.settings = normalizeSettings(store.settings);
        store.settings.paused = next;
        store.settings.pausedAt = next ? new Date().toISOString() : null;
        store.settings.pausedBy = next ? by : null;
        save();
        flushSync();
        return getPauseState();
    }

    function paymentTimeMs(p) {
        const t = Date.parse((p && (p.createdAt || p.decidedAt)) || '');
        return Number.isFinite(t) ? t : 0;
    }

    /**
     * Admin read-only user directory rows.
     * Merges auth accounts with plan subscriptions + best payment IP geo / device signals.
     * @param {{ accounts?: Array }} opts
     */
    function listUsersAdmin(opts) {
        const accounts = (opts && Array.isArray(opts.accounts)) ? opts.accounts : [];
        const store = read();
        const seen = new Set();
        const rows = [];

        function pickBestPayment(userId, email) {
            const uid = userId != null ? String(userId) : '';
            const emailNorm = normalizeEmail(email);
            const matched = store.payments.filter((p) => {
                if (uid && p.userId != null && String(p.userId) === uid) return true;
                if (emailNorm && p.email && p.email === emailNorm) return true;
                return false;
            });
            matched.sort((a, b) => paymentTimeMs(b) - paymentTimeMs(a));
            return matched[0] || null;
        }

        function buildRow({ userId, email, name, createdAt, updatedAt, devices }) {
            const uid = userId != null ? String(userId) : null;
            const emailNorm = normalizeEmail(email) || (email ? String(email).trim().toLowerCase() : null);
            const ownerKey = uid ? accountOwnerKey(uid) : null;
            const effective = ownerKey ? getEffectivePlan(ownerKey) : { plan: 'free' };
            const pay = pickBestPayment(uid, emailNorm);
            const deviceList = Array.isArray(devices) ? devices : [];
            const latestLink = deviceList[0] || null;
            const deviceId = (latestLink && latestLink.deviceId) || (pay && pay.deviceId) || null;
            const deviceSource = latestLink
                ? 'device_links'
                : (pay && pay.deviceId ? 'payment' : null);
            const geo = (pay && (pay.geo || (pay.ip && getCachedGeo(pay.ip)))) || null;
            const location = formatGeoLabel(geo) || null;
            const locationSource = location
                ? (pay && pay.geo ? 'payment_geo' : (pay && pay.ip ? 'geo_cache' : null))
                : null;

            const usage = adminUsageSnapshot(ownerKey);
            return {
                id: uid || null,
                email: emailNorm || null,
                name: name || null,
                plan: (effective && effective.plan) || 'free',
                device: deviceId || null,
                deviceSource: deviceSource,
                deviceLinkedAt: (latestLink && latestLink.linkedAt) || null,
                deviceCount: deviceList.length,
                location: location,
                locationLabel: location || (pay && pay.ip ? ('IP ' + pay.ip) : '—'),
                locationSource: locationSource || (pay && pay.ip ? 'payment_ip' : null),
                ip: (pay && pay.ip) || null,
                geo: geo,
                createdAt: createdAt || null,
                updatedAt: updatedAt || null,
                lastPaymentAt: (pay && pay.createdAt) || null,
                todayTokens: usage.todayTokens,
                todaySpendUsd: usage.todaySpendUsd,
                todayGrokSpendUsd: usage.todayGrokSpendUsd,
                todayOpenaiSpendUsd: usage.todayOpenaiSpendUsd,
                totalTokens: usage.totalTokens,
                totalSpendUsd: usage.totalSpendUsd,
                totalGrokSpendUsd: usage.totalGrokSpendUsd,
                totalOpenaiSpendUsd: usage.totalOpenaiSpendUsd,
                tokensToday: usage.todayTokens,
                dollarsToday: usage.todaySpendUsd,
                tokensTotal: usage.totalTokens,
                dollarsTotal: usage.totalSpendUsd,
                grokSpendToday: usage.todayGrokSpendUsd,
                openaiSpendToday: usage.todayOpenaiSpendUsd,
                grokSpendTotal: usage.totalGrokSpendUsd,
                openaiSpendTotal: usage.totalOpenaiSpendUsd
            };
        }

        for (const acc of accounts) {
            const uid = acc && acc.id != null ? String(acc.id) : '';
            if (!uid) continue;
            seen.add('u:' + uid);
            const emailNorm = normalizeEmail(acc.email) || (acc.email ? String(acc.email).trim().toLowerCase() : null);
            if (emailNorm) seen.add('e:' + emailNorm);
            rows.push(buildRow({
                userId: uid,
                email: acc.email,
                name: acc.name,
                createdAt: acc.createdAt,
                updatedAt: acc.updatedAt,
                devices: acc.devices
            }));
        }

        // Payment-only emails (no auth row yet) — still durable customer signals.
        const payEmails = new Map();
        for (const p of store.payments) {
            const emailNorm = normalizeEmail(p.email);
            if (!emailNorm) continue;
            if (seen.has('e:' + emailNorm)) continue;
            if (p.userId != null && seen.has('u:' + String(p.userId))) continue;
            const prev = payEmails.get(emailNorm);
            if (!prev || paymentTimeMs(p) > paymentTimeMs(prev)) {
                payEmails.set(emailNorm, p);
            }
        }
        for (const [emailNorm, p] of payEmails) {
            seen.add('e:' + emailNorm);
            rows.push(buildRow({
                userId: p.userId || null,
                email: emailNorm,
                name: null,
                createdAt: p.createdAt || null,
                updatedAt: p.decidedAt || p.createdAt || null,
                devices: p.deviceId ? [{ deviceId: p.deviceId, linkedAt: p.createdAt || null }] : []
            }));
        }

        rows.sort((a, b) => {
            const ta = Date.parse(a.updatedAt || a.createdAt || a.lastPaymentAt || '') || 0;
            const tb = Date.parse(b.updatedAt || b.createdAt || b.lastPaymentAt || '') || 0;
            return tb - ta;
        });
        return rows;
    }

    return {
        PLAN_DEFS,
        PLAN_RANK,
        OMT_DESTINATION,
        utcDayKey,
        utcWeekKey,
        estimateTalkSeconds,
        normalizePhone,
        isValidOmtPhone,
        computeStackOnApprove,
        getEffectivePlan,
        getStatus,
        getPlanPublic,
        getPlanStatusUi,
        adminUsageSnapshot,
        checkChatAllowed,
        checkImageAllowed,
        recordImage,
        checkTalkAllowed,
        recordTalk,
        recordSpend,
        recordUsage,
        releaseUsage,
        markFastHalved,
        resolveUsageKind,
        poolForKind,
        modesForPlan,
        remainingFor,
        demoteToFree,
        maybeDemoteIfExhausted,
        costFromProviderUsage,
        estimateCostFromTexts,
        normalizeProvider,
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
        getPauseState,
        isPaused,
        setPaused,
        listUsersAdmin,
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
    utcDayKey,
    utcWeekKey,
    estimateTalkSeconds,
    computeStackOnApprove,
    capsFromPlanId,
    deltaCaps,
    addCaps,
    cloneCaps,
    poolForKind,
    modesForPlan,
    OMT_DESTINATION,
    costFromProviderUsage,
    estimateCostFromTexts,
    normalizeProvider,
    MODEL_PRICING,
    DEFAULT_PRICING
};
