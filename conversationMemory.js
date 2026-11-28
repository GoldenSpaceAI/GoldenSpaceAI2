const { randomUUID } = require('node:crypto');

const SECRET = /\b(?:passwords?|passphrases?|passcodes?|credentials?|api[ _-]?keys?|private[ _-]?keys?|access[ _-]?tokens?|refresh[ _-]?tokens?|recovery[ _-]?(?:codes?|phrases?)|verification[ _-]?codes?|seed[ _-]?phrases?|one[ _-]?time[ _-]?(?:codes?|passwords?)|otp|bearer)\b|\b(?:sk|ghp|github_pat|xai)[_-][\w-]{12,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN |[A-Za-z0-9_-]{32,}|\b(?:\d[ -]?){13,19}\b/i;
const SMALL_TALK = /^(?:(?:hi|hey|hello|thanks|thank you|ok(?:ay)?|cool|great|nice|bye)[!. ,]*)+$/i;

function memoryBudget(value = process.env.CHAT_MEMORY_TOKEN_LIMIT) {
    const requested = Number(value);
    return Number.isInteger(requested) && requested > 0 ? Math.min(4096, requested) : 768;
}

function compactNotes(items, budget = memoryBudget()) {
    const seen = new Set();
    const notes = [];
    let bytes = 2;
    for (const item of items) {
        if (typeof item !== 'string' || SECRET.test(item)) continue;
        const note = item.replace(/\s+/g, ' ').trim();
        const key = note.toLowerCase().replace(/[.!?]+$/, '');
        const size = Buffer.byteLength(JSON.stringify(note)) + (notes.length ? 1 : 0);
        if (!key || SMALL_TALK.test(note) || seen.has(key) || bytes + size > budget) continue;
        seen.add(key);
        notes.push(note);
        bytes += size;
    }
    // A UTF-8 byte bound is conservative across the supported model tokenizers.
    return notes;
}

function createConversationMemory({ getPool, ensureSchema, classify, budget = memoryBudget() }) {
    async function read(owner, chatId) {
        const pool = getPool();
        if (!pool || !(await ensureSchema())) throw new Error('Conversation memory database unavailable');
        const { rows } = await pool.query(
            'SELECT memory_notes, memory_enabled, memory_revision FROM chats WHERE owner_key = $1 AND chat_id = $2',
            [owner, chatId]
        );
        const row = rows[0];
        return row ? { notes: row.memory_notes, enabled: row.memory_enabled, revision: row.memory_revision } : null;
    }

    async function control(owner, chatId, { enabled, clear }) {
        const pool = getPool();
        if (!pool || !(await ensureSchema())) throw new Error('Conversation memory database unavailable');
        const { rows } = await pool.query(
            `UPDATE chats SET memory_enabled = COALESCE($3::boolean, memory_enabled),
                memory_notes = CASE WHEN $4::boolean THEN '[]'::jsonb ELSE memory_notes END,
                memory_revision = $5
             WHERE owner_key = $1 AND chat_id = $2
             RETURNING memory_notes, memory_enabled`,
            [owner, chatId, enabled ?? null, clear === true, randomUUID()]
        );
        return rows[0] ? { notes: rows[0].memory_notes, enabled: rows[0].memory_enabled } : null;
    }

    async function update(owner, chatId, snapshot, message, reply, date, retry = true) {
        if (!snapshot?.enabled || SECRET.test(message) || SMALL_TALK.test(message.trim()) || !message.trim()) return false;
        const notes = compactNotes(snapshot.notes, budget);
        const result = await classify({
            date,
            notes,
            message: message.slice(0, 6000),
            reply: SECRET.test(reply) ? '' : reply.slice(0, 3500),
            budget
        });
        if (!Array.isArray(result?.notes) || result.notes.some(note => typeof note !== 'string' || SECRET.test(note))) return false;
        const next = compactNotes(result.notes, budget);
        if (JSON.stringify(next) === JSON.stringify(snapshot.notes)) return false;
        const generation = snapshot.revision.split(':')[0];
        const { rowCount } = await getPool().query(
            `UPDATE chats SET memory_notes = $4::jsonb, memory_revision = $5
             WHERE owner_key = $1 AND chat_id = $2 AND memory_revision = $3 AND memory_enabled = true`,
            [owner, chatId, snapshot.revision, JSON.stringify(next), generation + ':' + randomUUID()]
        );
        if (rowCount === 1) return true;
        if (!retry) return false;
        const latest = await read(owner, chatId);
        // Merge a concurrent automatic update once. A user control or recreated chat starts a new generation.
        if (latest?.enabled && latest.revision.split(':')[0] === generation) {
            return update(owner, chatId, latest, message, reply, date, false);
        }
        return false;
    }

    function context(snapshot) {
        return snapshot?.enabled ? compactNotes(snapshot.notes, budget) : [];
    }

    return { read, control, update, context };
}

module.exports = { createConversationMemory, memoryBudget };
