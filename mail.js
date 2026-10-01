/**
 * Resend transactional email helpers for GoldenSpaceAI.
 * Soft-skips when RESEND_API_KEY is unset (never blocks API flows).
 */
function env(name) {
    const v = process.env[name];
    return v == null ? '' : String(v).trim();
}

function emailFromAddress() {
    return env('EMAIL_FROM') || env('MAGIC_LINK_FROM') || env('SMTP_FROM') || 'GoldenSpaceAI <onboarding@resend.dev>';
}

function normalizeEmail(value) {
    const norm = String(value || '').trim().toLowerCase();
    if (!norm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) return null;
    return norm;
}

async function sendResendEmail({ to, subject, text, html }) {
    if (!env('RESEND_API_KEY')) {
        return { ok: false, skipped: true, error: 'RESEND_API_KEY not set' };
    }
    const norm = normalizeEmail(to);
    if (!norm) return { ok: false, skipped: true, error: 'No email' };
    const from = emailFromAddress();
    const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + env('RESEND_API_KEY'),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from, to: [norm], subject, html, text })
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error('Resend error:', resp.status, body);
        return { ok: false, error: 'Failed to send email via Resend.' };
    }
    return { ok: true };
}

function planLabel(planId) {
    const id = String(planId || '').toLowerCase();
    if (id === 'plus') return 'Plus';
    if (id === 'pro') return 'Pro';
    if (id === 'max') return 'Max';
    return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'your plan';
}

function money(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return '';
    return '$' + (Math.round(n * 100) / 100).toFixed(n % 1 ? 2 : 0);
}

function formatWhen(iso) {
    try {
        const d = iso ? new Date(iso) : new Date();
        if (Number.isNaN(d.getTime())) return new Date().toISOString();
        return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
    } catch (_) {
        return new Date().toISOString();
    }
}

/**
 * (1) User submitted a plan upgrade / OMT payment request — status Waiting.
 */
async function sendPlanRequestReceivedEmail(payment) {
    if (!payment) return { ok: false, skipped: true };
    const to = normalizeEmail(payment.email);
    if (!to) return { ok: false, skipped: true, error: 'No email on payment' };
    const label = planLabel(payment.plan);
    const amount = money(payment.amount);
    const when = formatWhen(payment.createdAt);
    const subject = `We received your GoldenSpaceAI ${label} upgrade request`;
    const securityNoteText =
        `SECURITY: Do not share your Request ID / request code with anyone. ` +
        `GoldenSpaceAI staff will never ask you to send it in chat or on social media. ` +
        `Treat it like a password — only use it on official GoldenSpaceAI pages or when you email us from this address.\n\n`;
    const securityNoteHtml =
        `<p style="margin:16px 0;padding:12px 14px;border:1px solid #c9a227;border-radius:8px;` +
        `background:#fff8e6;color:#1a1a1a;font-size:14px;line-height:1.45;">` +
        `<strong>Security:</strong> Do <em>not</em> share your Request ID / request code with anyone. ` +
        `GoldenSpaceAI staff will never ask you to send it in chat or on social media. ` +
        `Treat it like a password — only use it on official GoldenSpaceAI pages or when you email us from this address.` +
        `</p>`;
    const text =
        `Hi,\n\n` +
        `Thank you for requesting an upgrade to GoldenSpaceAI ${label}` +
        (amount ? ` (${amount} / 30 days)` : '') + `.\n\n` +
        `Status: Waiting for payment confirmation\n` +
        `Submitted: ${when}\n` +
        (payment.id ? `Request ID: ${payment.id}\n` : '') +
        `\n` + securityNoteText +
        `Our team will review your OMT Pay transfer and update this request. ` +
        `You can check status anytime at https://www.goldenspaceai.space/my-plan\n\n` +
        `If you did not make this request, you can ignore this email.\n\n` +
        `— GoldenSpaceAI Team`;
    const html =
        `<p>Hi,</p>` +
        `<p>Thank you for requesting an upgrade to <strong>GoldenSpaceAI ${label}</strong>` +
        (amount ? ` (${amount} / 30 days)` : '') + `.</p>` +
        `<p><strong>Status:</strong> Waiting for payment confirmation<br>` +
        `<strong>Submitted:</strong> ${when}` +
        (payment.id ? `<br><strong>Request ID:</strong> <code style="font-size:13px;">${payment.id}</code>` : '') +
        `</p>` +
        securityNoteHtml +
        `<p>Our team will review your OMT Pay transfer and update this request. ` +
        `You can check status anytime on your ` +
        `<a href="https://www.goldenspaceai.space/my-plan">My Plan</a> page.</p>` +
        `<p>If you did not make this request, you can ignore this email.</p>` +
        `<p>— GoldenSpaceAI Team</p>`;
    return sendResendEmail({ to, subject, text, html });
}

/**
 * (2) Admin approved the payment — plan is active.
 */
async function sendPlanApprovedEmail(payment) {
    if (!payment) return { ok: false, skipped: true };
    const to = normalizeEmail(payment.email);
    if (!to) return { ok: false, skipped: true, error: 'No email on payment' };
    const label = planLabel(payment.plan);
    const amount = money(payment.amount);
    const starts = payment.startsAt ? formatWhen(payment.startsAt) : formatWhen(payment.decidedAt);
    const ends = payment.endsAt ? formatWhen(payment.endsAt) : null;
    const subject = `Your GoldenSpaceAI ${label} plan is active`;
    const text =
        `Hi,\n\n` +
        `Good news — your payment was confirmed and your GoldenSpaceAI ${label} plan is now active` +
        (amount ? ` (${amount} / 30 days)` : '') + `.\n\n` +
        `Started: ${starts}\n` +
        (ends ? `Renews / ends: ${ends}\n` : '') +
        (payment.id ? `Request ID: ${payment.id}\n` : '') +
        `\nOpen chat at https://www.goldenspaceai.space/ and enjoy your upgraded limits. ` +
        `Manage your plan at https://www.goldenspaceai.space/my-plan\n\n` +
        `— GoldenSpaceAI Team`;
    const html =
        `<p>Hi,</p>` +
        `<p>Good news — your payment was confirmed and your <strong>GoldenSpaceAI ${label}</strong> plan is now active` +
        (amount ? ` (${amount} / 30 days)` : '') + `.</p>` +
        `<p><strong>Started:</strong> ${starts}` +
        (ends ? `<br><strong>Renews / ends:</strong> ${ends}` : '') +
        (payment.id ? `<br><strong>Request ID:</strong> ${payment.id}` : '') +
        `</p>` +
        `<p>Open <a href="https://www.goldenspaceai.space/">chat</a> to use your upgraded limits, ` +
        `or visit <a href="https://www.goldenspaceai.space/my-plan">My Plan</a> anytime.</p>` +
        `<p>— GoldenSpaceAI Team</p>`;
    return sendResendEmail({ to, subject, text, html });
}

/**
 * (3) Admin declined the payment request.
 */
async function sendPlanDeclinedEmail(payment) {
    if (!payment) return { ok: false, skipped: true };
    const to = normalizeEmail(payment.email);
    if (!to) return { ok: false, skipped: true, error: 'No email on payment' };
    const label = planLabel(payment.plan);
    const when = formatWhen(payment.decidedAt || new Date().toISOString());
    const subject = `Update on your GoldenSpaceAI ${label} upgrade request`;
    const text =
        `Hi,\n\n` +
        `We reviewed your upgrade request for GoldenSpaceAI ${label} and could not confirm the payment at this time.\n\n` +
        `Status: Declined\n` +
        `Reviewed: ${when}\n` +
        (payment.id ? `Request ID: ${payment.id}\n` : '') +
        `\nCommon reasons include a mismatched OMT Pay number, an incomplete transfer, or a duplicate request. ` +
        `You can submit a new request from https://www.goldenspaceai.space/upgrade ` +
        `or check details at https://www.goldenspaceai.space/my-plan\n\n` +
        `If you believe this was a mistake, reply to this email with your request ID and we will help.\n\n` +
        `— GoldenSpaceAI Team`;
    const html =
        `<p>Hi,</p>` +
        `<p>We reviewed your upgrade request for <strong>GoldenSpaceAI ${label}</strong> and could not confirm the payment at this time.</p>` +
        `<p><strong>Status:</strong> Declined<br>` +
        `<strong>Reviewed:</strong> ${when}` +
        (payment.id ? `<br><strong>Request ID:</strong> ${payment.id}` : '') +
        `</p>` +
        `<p>Common reasons include a mismatched OMT Pay number, an incomplete transfer, or a duplicate request. ` +
        `You can <a href="https://www.goldenspaceai.space/upgrade">submit a new request</a> ` +
        `or check details on <a href="https://www.goldenspaceai.space/my-plan">My Plan</a>.</p>` +
        `<p>If you believe this was a mistake, reply with your request ID and we will help.</p>` +
        `<p>— GoldenSpaceAI Team</p>`;
    return sendResendEmail({ to, subject, text, html });
}

module.exports = {
    sendResendEmail,
    sendPlanRequestReceivedEmail,
    sendPlanApprovedEmail,
    sendPlanDeclinedEmail,
    normalizeEmail,
    emailFromAddress
};
