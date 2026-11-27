const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUESTION_TYPES = new Set(['true_false', 'multiple_choice', 'open_answer', 'paragraph_answer', 'long_answer']);
const MAX_QUESTIONS = 100;

function createStudyStore(dataDir) {
    const file = path.join(dataDir, 'study-exams.json');
    function read() {
        try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; }
        catch (_) { return {}; }
    }
    function write(value) {
        fs.mkdirSync(dataDir, { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
        fs.renameSync(tmp, file);
    }
    function cleanQuestion(q, index) {
        if (!q || typeof q !== 'object') return null;
        const type = String(q.type || '').toLowerCase();
        if (!QUESTION_TYPES.has(type)) return null;
        const prompt = String(q.prompt || q.question || '').trim().slice(0, 4000);
        if (!prompt) return null;
        const options = Array.isArray(q.options) ? q.options.map(v => String(v).trim().slice(0, 500)).filter(Boolean).slice(0, 8) : [];
        const answer = q.answer == null ? '' : String(q.answer).trim().slice(0, 1000);
        return { id: String(q.id || `q${index + 1}`).slice(0, 80), type, prompt, options, answer, points: Math.max(1, Math.min(20, Number(q.points) || 1)) };
    }
    function validateQuestions(input) {
        if (!Array.isArray(input) || input.length < 1 || input.length > MAX_QUESTIONS) return { ok: false, error: 'Provide between 1 and 100 questions.' };
        const questions = input.map(cleanQuestion).filter(Boolean);
        if (questions.length !== input.length) return { ok: false, error: 'Every question needs a supported type and prompt.' };
        return { ok: true, questions };
    }
    function create({ ownerKey, chatId, questions, title }) {
        const checked = validateQuestions(questions);
        if (!checked.ok) return checked;
        const token = crypto.randomBytes(24).toString('base64url');
        const createdAt = new Date();
        const exam = { token, ownerKey, chatId: String(chatId), title: String(title || 'Interactive exam').slice(0, 160), createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + 60 * 60 * 1000).toISOString(), status: 'issued', questions: checked.questions, userAnswers: null, score: null, maxScore: checked.questions.reduce((sum, q) => sum + q.points, 0), perQuestionFeedback: null, submittedAt: null };
        const all = read(); all[token] = exam; write(all); return { ok: true, exam };
    }
    function get(token) { return read()[String(token)] || null; }
    function save(exam) { const all = read(); all[exam.token] = exam; write(all); return exam; }
    function expireIfNeeded(exam) {
        if (exam && (exam.status === 'issued' || exam.status === 'in_progress') && Date.now() >= Date.parse(exam.expiresAt)) { exam.status = 'expired'; save(exam); }
        return exam;
    }
    function grade(exam, answers, rubricGrades) {
        const userAnswers = Array.isArray(answers) ? answers : [];
        const rubric = rubricGrades && typeof rubricGrades === 'object' ? rubricGrades : {};
        const feedback = [];
        let score = 0;
        for (const q of exam.questions) {
            const raw = userAnswers.find(a => a && String(a.id) === q.id)?.answer;
            const answer = raw == null ? '' : String(raw).trim();
            let earned = 0; let note = 'Keep reviewing this question.';
            if (q.type === 'true_false' || q.type === 'multiple_choice') {
                const correct = q.answer && answer.toLowerCase() === q.answer.toLowerCase();
                earned = correct ? q.points : 0; note = correct ? 'Correct.' : `Expected: ${q.answer || 'the keyed answer'}.`;
            } else {
                const ai = rubric[q.id];
                if (ai && Number.isFinite(Number(ai.score))) {
                    earned = Math.max(0, Math.min(q.points, Math.round(Number(ai.score))));
                    note = String(ai.feedback || (earned === q.points ? 'Strong answer.' : 'Add more specific evidence.')).slice(0, 1200);
                } else {
                    const expected = String(q.answer || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
                    const actual = answer.toLowerCase();
                    const hits = expected.filter(w => actual.includes(w)).length;
                    const ratio = expected.length ? hits / expected.length : (answer.length >= 40 ? 1 : answer.length ? 0.5 : 0);
                    earned = Math.round(q.points * Math.min(1, ratio));
                    note = earned === q.points ? 'Strong answer.' : (earned ? 'Good start; add more specific evidence.' : 'Add a clearer explanation and supporting details.');
                }
            }
            score += earned; feedback.push({ id: q.id, score: earned, maxScore: q.points, feedback: note });
        }
        exam.userAnswers = userAnswers; exam.score = score; exam.perQuestionFeedback = feedback; exam.status = 'submitted'; exam.submittedAt = new Date().toISOString(); save(exam); return exam;
    }
    return { create, get, save, expireIfNeeded, grade, validateQuestions };
}

module.exports = { createStudyStore, QUESTION_TYPES };
