/**
 * Server-side text extraction for chat file attachments.
 * Prefer Fast (vision + extracted text). Legacy/unextractable types prefer Thinking.
 */
'use strict';

const path = require('path');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { PDFParse } = require('pdf-parse');

const MAX_EXTRACT_CHARS = 120000;
const MAX_FILE_BYTES = 12 * 1024 * 1024;

const EXT_MAP = {
    '.txt': 'text',
    '.md': 'text',
    '.markdown': 'text',
    '.pdf': 'pdf',
    '.docx': 'docx',
    '.doc': 'doc',
    '.pptx': 'pptx',
    '.ppt': 'ppt'
};

function extOf(name) {
    const base = String(name || '').toLowerCase();
    const i = base.lastIndexOf('.');
    return i >= 0 ? base.slice(i) : '';
}

function classify(filename, mime) {
    const ext = extOf(filename);
    if (EXT_MAP[ext]) return { kind: EXT_MAP[ext], ext };
    const m = String(mime || '').toLowerCase();
    if (m === 'application/pdf') return { kind: 'pdf', ext: '.pdf' };
    if (m.includes('wordprocessingml') || m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        return { kind: 'docx', ext: '.docx' };
    }
    if (m.includes('msword') && !m.includes('openxml')) return { kind: 'doc', ext: '.doc' };
    if (m.includes('presentationml') || m.includes('powerpoint')) {
        return m.includes('openxml') ? { kind: 'pptx', ext: '.pptx' } : { kind: 'ppt', ext: '.ppt' };
    }
    if (m.startsWith('text/')) return { kind: 'text', ext: ext || '.txt' };
    return { kind: 'unknown', ext };
}

function truncate(text) {
    const s = String(text || '').replace(/\u0000/g, '').trim();
    if (s.length <= MAX_EXTRACT_CHARS) return s;
    return s.slice(0, MAX_EXTRACT_CHARS) + '\n\n[…truncated for chat context…]';
}

function xmlTextNodes(xml) {
    const out = [];
    const re = /<a:t[^>]*>([^<]*)<\/a:t>/g;
    let m;
    while ((m = re.exec(xml))) {
        const t = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        if (t) out.push(t);
    }
    return out.join(' ');
}

async function extractPptx(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
        .sort((a, b) => {
            const na = Number((a.match(/slide(\d+)/i) || [])[1] || 0);
            const nb = Number((b.match(/slide(\d+)/i) || [])[1] || 0);
            return na - nb;
        });
    const parts = [];
    for (const name of names) {
        const xml = await zip.files[name].async('string');
        const text = xmlTextNodes(xml).replace(/\s+/g, ' ').trim();
        if (text) {
            const n = (name.match(/slide(\d+)/i) || [])[1] || parts.length + 1;
            parts.push('--- Slide ' + n + ' ---\n' + text);
        }
    }
    return parts.join('\n\n');
}

async function extractPdf(buffer) {
    const parser = new PDFParse({ data: buffer });
    try {
        const result = await parser.getText();
        return String(result?.text || '');
    } finally {
        try { await parser.destroy(); } catch (e) {}
    }
}

async function extractDocx(buffer) {
    const result = await mammoth.extractRawText({ buffer });
    return String(result?.value || '');
}

/**
 * @returns {{
 *   ok: boolean,
 *   name: string,
 *   kind: string,
 *   text: string,
 *   note: string|null,
 *   preferMode: 'fast'|'thinking',
 *   reason: string
 * }}
 */
async function extractUploadedFile({ buffer, originalname, mimetype }) {
    const name = path.basename(originalname || 'file');
    const { kind, ext } = classify(name, mimetype);

    if (!buffer || !buffer.length) {
        return {
            ok: false,
            name,
            kind,
            text: '',
            note: 'Empty file.',
            preferMode: 'thinking',
            reason: 'empty_file'
        };
    }
    if (buffer.length > MAX_FILE_BYTES) {
        return {
            ok: false,
            name,
            kind,
            text: '',
            note: 'File too large (max ~12MB).',
            preferMode: 'thinking',
            reason: 'too_large'
        };
    }

    try {
        if (kind === 'text') {
            const text = truncate(buffer.toString('utf8'));
            return {
                ok: true,
                name,
                kind,
                text,
                note: text ? null : 'File had no readable text.',
                preferMode: 'fast',
                reason: 'extracted_text'
            };
        }

        if (kind === 'docx') {
            const text = truncate(await extractDocx(buffer));
            if (text) {
                return { ok: true, name, kind, text, note: null, preferMode: 'fast', reason: 'extracted_text' };
            }
            return {
                ok: false,
                name,
                kind,
                text: '',
                note: 'Could not extract text from this Word document.',
                preferMode: 'thinking',
                reason: 'extract_failed'
            };
        }

        if (kind === 'pdf') {
            const text = truncate(await extractPdf(buffer));
            if (text) {
                return { ok: true, name, kind, text, note: null, preferMode: 'fast', reason: 'extracted_text' };
            }
            return {
                ok: false,
                name,
                kind,
                text: '',
                note: 'PDF had little or no extractable text (may be scanned). Thinking mode is better for this file.',
                preferMode: 'thinking',
                reason: 'pdf_no_text'
            };
        }

        if (kind === 'pptx') {
            const text = truncate(await extractPptx(buffer));
            if (text) {
                return { ok: true, name, kind, text, note: null, preferMode: 'fast', reason: 'extracted_text' };
            }
            return {
                ok: false,
                name,
                kind,
                text: '',
                note: 'Could not extract text from this PowerPoint file.',
                preferMode: 'thinking',
                reason: 'extract_failed'
            };
        }

        if (kind === 'doc' || kind === 'ppt') {
            return {
                ok: false,
                name,
                kind,
                text: '',
                note: 'Legacy ' + ext + ' needs Thinking mode (or convert to ' + (kind === 'doc' ? '.docx' : '.pptx') + '). Fast cannot handle this binary format well.',
                preferMode: 'thinking',
                reason: 'legacy_office'
            };
        }

        return {
            ok: false,
            name,
            kind,
            text: '',
            note: 'Unsupported file type. Use Word, PowerPoint, PDF, txt/md, or images.',
            preferMode: 'thinking',
            reason: 'unsupported'
        };
    } catch (err) {
        console.warn('extractUploadedFile error:', err?.message || err);
        return {
            ok: false,
            name,
            kind,
            text: '',
            note: 'Extraction failed: ' + String(err?.message || err).slice(0, 120),
            preferMode: 'thinking',
            reason: 'extract_error'
        };
    }
}

module.exports = {
    extractUploadedFile,
    classify,
    MAX_FILE_BYTES,
    MAX_EXTRACT_CHARS
};
