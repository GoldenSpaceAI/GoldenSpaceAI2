/**
 * Transactional email helpers for GoldenoAI.
 * Soft-skips when RESEND_API_KEY is unset (never blocks API flows).
 */

function env(name) {
    const v = process.env[name];
    return v == null ? '' : String(v).trim();
}

function emailFromAddress() {
    return env('EMAIL_FROM') || env('MAGIC_LINK_FROM') || env('SMTP_FROM') || 'GoldenoAI <onboarding@resend.dev>';
}

function normalizeEmail(value) {
    const norm = String(value || '').trim().toLowerCase();
    if (!norm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) return null;
    return norm;
}

function escapeEmailHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function safeEmailHref(value) {
    const url = String(value || '');
    if (/^https:\/\/www\.goldenspaceai\.space(?:\/|$)/i.test(url)) return escapeEmailHtml(url);
    return '#';
}

function renderBrandedEmail(options) {
    const o = options || {};
    const tone = String((o.status && o.status.tone) || 'neutral');
    const tones = {
        success: { bg: '#e8f5ee', fg: '#176b42', label: 'Status' },
        warning: { bg: '#fff4d6', fg: '#795400', label: 'Status' },
        danger: { bg: '#fdeceb', fg: '#a52e2a', label: 'Status' },
        neutral: { bg: '#eef2f6', fg: '#354052', label: 'Status' }
    };
    const colors = tones[tone] || tones.neutral;
    const preview = escapeEmailHtml(o.preheader || '');
    const title = escapeEmailHtml(o.title || 'GoldenoAI update');
    const paragraphs = (Array.isArray(o.paragraphs) ? o.paragraphs : []).map(function(p) {
        return '<p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#344054;">' +
            escapeEmailHtml(p).replace(/\r?\n/g, '<br>') + '</p>';
    }).join('');
    const status = o.status && o.status.label
        ? '<span style="display:inline-block;padding:7px 11px;border-radius:20px;background:' + colors.bg +
          ';color:' + colors.fg + ';font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:.02em;">' +
          escapeEmailHtml(o.status.label) + '</span>'
        : '';
    const details = (Array.isArray(o.details) ? o.details : []).filter(function(item) {
        return item && item.value != null && String(item.value) !== '';
    }).map(function(item, index) {
        const valueStyle = item.kind === 'code'
            ? 'font-family:SFMono-Regular,Consolas,monospace;font-size:20px;font-weight:700;letter-spacing:.12em;color:#142239;'
            : 'font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#182230;';
        return '<tr><td style="padding:12px 0;' + (index ? 'border-top:1px solid #e9edf2;' : '') +
            'font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#667085;vertical-align:top;width:38%;">' +
            escapeEmailHtml(item.label || '') + '</td><td style="padding:12px 0;' + (index ? 'border-top:1px solid #e9edf2;' : '') +
            valueStyle + 'vertical-align:top;word-break:break-word;">' + escapeEmailHtml(item.value) + '</td></tr>';
    }).join('');
    const detailCard = details
        ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;padding:4px 18px;border:1px solid #e5e9ef;border-radius:12px;background:#fafbfc;">' + details + '</table>'
        : '';
    const notice = o.notice
        ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border:1px solid ' +
          (tone === 'danger' ? '#f0c7c4' : '#ead9a7') + ';border-radius:12px;background:' + (tone === 'danger' ? '#fff7f6' : '#fffaf0') +
          ';"><tr><td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;">' +
          '<div style="margin:0 0 5px;font-size:13px;font-weight:700;color:#344054;">' + escapeEmailHtml(o.notice.title || 'Important') + '</div>' +
          '<div style="font-size:13px;line-height:1.6;color:#475467;">' + escapeEmailHtml(o.notice.body || '').replace(/\r?\n/g, '<br>') + '</div>' +
          '</td></tr></table>'
        : '';
    const action = o.action && o.action.url && o.action.label
        ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;"><tr><td bgcolor="#142239" style="border-radius:9px;">' +
          '<a href="' + safeEmailHref(o.action.url) + '" style="display:inline-block;padding:13px 20px;border:1px solid #142239;border-radius:9px;' +
          'font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">' +
          escapeEmailHtml(o.action.label) + '</a></td></tr></table>'
        : '';
    const footerLink = o.footerLink && o.footerLink.url && o.footerLink.label
        ? '<br><a href="' + safeEmailHref(o.footerLink.url) + '" style="color:#667085;text-decoration:underline;">' +
          escapeEmailHtml(o.footerLink.label) + '</a>'
        : '';
    const footer = escapeEmailHtml(o.footer || 'This message relates to your GoldenoAI account.').replace(/\r?\n/g, '<br>');
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
        '<meta name="color-scheme" content="light"><title>' + title + '</title></head>' +
        '<body style="margin:0;padding:0;background:#f2f4f7;">' +
        '<div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">' + preview + '</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f4f7;">' +
        '<tr><td align="center" style="padding:28px 12px 36px;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;">' +
        '<tr><td style="padding:0 8px 16px;">' +
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="34" height="34" align="center" valign="middle" bgcolor="#d4af37" style="width:34px;height:34px;border-radius:10px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;color:#142239;">G</td>' +
        '<td style="padding-left:10px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;letter-spacing:.01em;color:#142239;">GoldenoAI</td></tr></table>' +
        '</td></tr>' +
        '<tr><td bgcolor="#ffffff" style="padding:0;background:#ffffff;border:1px solid #e4e7ec;border-radius:16px;overflow:hidden;">' +
        '<div style="height:4px;background:#d4af37;font-size:1px;line-height:4px;">&nbsp;</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:30px 32px 32px;">' +
        (status ? '<div style="margin:0 0 16px;">' + status + '</div>' : '') +
        '<h1 style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:25px;line-height:1.25;letter-spacing:-.02em;color:#142239;">' + title + '</h1>' +
        paragraphs + detailCard + notice + action +
        '</td></tr></table></td></tr>' +
        '<tr><td style="padding:18px 10px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.65;color:#667085;">' +
        footer + footerLink + '<br><span style="color:#98a2b3;">© GoldenoAI</span></td></tr>' +
        '</table></td></tr></table></body></html>';
}

async function sendResendEmail({ to, subject, text, html }) {
    if (!env('RESEND_API_KEY')) return { ok: false, skipped: true, error: 'RESEND_API_KEY not set' };
    const norm = normalizeEmail(to);
    if (!norm) return { ok: false, skipped: true, error: 'No email' };
    const from = emailFromAddress();
    const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env('RESEND_API_KEY'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from, to: [norm], subject: subject, html: html, text: text })
    });
    if (!resp.ok) {
        const body = await resp.text().catch(function() { return ''; });
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
    return '$' + (Math.round(n * 100) / 100).toFixed(2);
}

function formatWhen(iso) {
    try {
        const d = iso ? new Date(iso) : new Date();
        if (Number.isNaN(d.getTime())) return new Date().toISOString();
        return new Intl.DateTimeFormat('en-US', {
            dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Beirut'
        }).format(d) + ' Beirut time';
    } catch (_) {
        return new Date().toISOString();
    }
}

function billingTerm(payment) {
    return payment && String(payment.billingPeriod || '').toLowerCase() === 'yearly' ? '12 months' : '30 days';
}

function planAmount(payment) {
    const amount = money(payment && payment.amount);
    return amount ? amount + ' / ' + billingTerm(payment) : '';
}

function detail(label, value, kind) {
    return { label: label, value: value, kind: kind };
}

async function sendPlanRequestReceivedEmail(payment) {
    if (!payment) return { ok: false, skipped: true };
    const to = normalizeEmail(payment.email);
    if (!to) return { ok: false, skipped: true, error: 'No email on payment' };
    const label = planLabel(payment.plan);
    const term = billingTerm(payment);
    const amount = planAmount(payment);
    const when = formatWhen(payment.createdAt);
    const subject = 'We received your GoldenoAI ' + label + ' plan request';
    const requestId = payment.id ? String(payment.id) : '';
    const text = 'Hello,\n\nWe received your request for GoldenoAI ' + label + ' (' + term + ').' +
        (amount ? '\nAmount: ' + amount : '') +
        '\nStatus: Waiting for payment review\nSubmitted: ' + when +
        (requestId ? '\nRequest ID: ' + requestId : '') +
        '\n\nOur team will review the OMT Pay transfer and update your request. You can check its status at https://www.goldenoai.com/my-plan.' +
        '\n\nSecurity: Never share your Request ID or request code. GoldenoAI staff will never ask you to send it in chat or on social media. If you did not make this request, ignore this email.' +
        '\n\nGoldenoAI Support';
    const html = renderBrandedEmail({
        preheader: 'Your plan request is in the review queue.',
        title: 'We received your request',
        paragraphs: ['Hello,', 'We received your request for GoldenoAI ' + label + ' (' + term + '). Our team will review the OMT Pay transfer and update its status.'],
        status: { label: 'Payment review pending', tone: 'warning' },
        details: [detail('Plan', label), detail('Term', term), detail('Amount', amount), detail('Submitted', when), detail('Request ID', requestId, 'code')],
        notice: { title: 'Keep your request code private', body: 'Never share your Request ID with anyone. GoldenoAI staff will never ask you to send it in chat or on social media. If you did not make this request, you can ignore this email.' },
        action: { label: 'View request status', url: 'https://www.goldenoai.com/my-plan' },
        footer: 'You received this email because a plan request was submitted from your GoldenoAI account.'
    });
    return sendResendEmail({ to: to, subject: subject, text: text, html: html });
}

async function sendPlanApprovedEmail(payment) {
    if (!payment) return { ok: false, skipped: true };
    const to = normalizeEmail(payment.email);
    if (!to) return { ok: false, skipped: true, error: 'No email on payment' };
    const label = planLabel(payment.plan);
    const term = billingTerm(payment);
    const amount = planAmount(payment);
    const startsAt = payment.startsAt || payment.decidedAt;
    const endsAt = payment.endsAt || '';
    const starts = formatWhen(startsAt);
    const ends = endsAt ? formatWhen(endsAt) : '';
    const queued = payment.stackMode === 'same_stack_queued' && Date.parse(startsAt || '') > Date.now();
    const subject = queued
        ? 'Your GoldenoAI ' + label + ' plan period is scheduled'
        : 'Your GoldenoAI ' + label + ' plan is active';
    const paragraphs = queued
        ? ['Hello,', 'Your payment was confirmed. Your additional ' + label + ' plan period is scheduled to begin after your current plan period ends.']
        : ['Hello,', 'Your payment was confirmed and your GoldenoAI ' + label + ' plan is active. Enjoy your upgraded limits.'];
    const statusLabel = queued ? 'Scheduled' : 'Plan active';
    const text = 'Hello,\n\n' + paragraphs[1] +
        (amount ? '\nAmount: ' + amount : '') +
        '\nPlan period starts: ' + starts +
        (ends ? '\nPlan period ends: ' + ends : '') +
        (payment.id ? '\nRequest ID: ' + payment.id : '') +
        '\n\nOpen chat at https://www.goldenoai.com/ or manage your plan at https://www.goldenoai.com/my-plan.' +
        '\n\nGoldenoAI Support';
    const html = renderBrandedEmail({
        preheader: queued ? 'Your payment is confirmed and the new plan period is scheduled.' : 'Your payment is confirmed and your plan is active.',
        title: queued ? 'Your plan period is scheduled' : 'Your plan is active',
        paragraphs: paragraphs,
        status: { label: statusLabel, tone: 'success' },
        details: [detail('Plan', label), detail('Term', term), detail('Amount', amount), detail('Starts', starts), detail('Ends', ends), detail('Request ID', payment.id || '', 'code')],
        action: { label: queued ? 'View current plan' : 'Open GoldenoAI', url: queued ? 'https://www.goldenoai.com/my-plan' : 'https://www.goldenoai.com/' },
        footer: 'Plan periods do not renew automatically. Visit My Plan to review your subscription status.'
    });
    return sendResendEmail({ to: to, subject: subject, text: text, html: html });
}

async function sendPlanDeclinedEmail(payment) {
    if (!payment) return { ok: false, skipped: true };
    const to = normalizeEmail(payment.email);
    if (!to) return { ok: false, skipped: true, error: 'No email on payment' };
    const label = planLabel(payment.plan);
    const when = formatWhen(payment.decidedAt || new Date().toISOString());
    const reason = String(payment.declineReason || '').trim().slice(0, 2000);
    const subject = 'Update on your GoldenoAI ' + label + ' plan request';
    const explanation = 'We reviewed your request for GoldenoAI ' + label + ' and could not confirm the payment at this time.';
    const refund = 'The money sent for this request will be refunded, minus any transfer fees charged by the payment provider.';
    const text = 'Hello,\n\n' + explanation +
        '\nStatus: Declined\nReviewed: ' + when +
        (payment.id ? '\nRequest ID: ' + payment.id : '') +
        (reason ? '\nReason: ' + reason : '') +
        '\n\nRefund: ' + refund +
        '\n\nYou can submit a new request at https://www.goldenoai.com/upgrade or check details at https://www.goldenoai.com/my-plan.' +
        '\n\nIf you believe this was a mistake, reply to this email with your request ID and we will help.' +
        '\n\nGoldenoAI Support';
    const html = renderBrandedEmail({
        preheader: 'An update is available for your plan request.',
        title: 'We could not confirm the payment',
        paragraphs: ['Hello,', explanation],
        status: { label: 'Request declined', tone: 'danger' },
        details: [detail('Plan', label), detail('Reviewed', when), detail('Request ID', payment.id || '', 'code'), detail('Reason', reason)],
        notice: { title: 'Refund information', body: refund },
        action: { label: 'Review plan options', url: 'https://www.goldenoai.com/upgrade' },
        footer: 'If you believe this decision was made in error, reply to this email with your request code and the support team can review it.'
    });
    return sendResendEmail({ to: to, subject: subject, text: text, html: html });
}

module.exports = {
    sendResendEmail: sendResendEmail,
    sendPlanRequestReceivedEmail: sendPlanRequestReceivedEmail,
    sendPlanApprovedEmail: sendPlanApprovedEmail,
    sendPlanDeclinedEmail: sendPlanDeclinedEmail,
    normalizeEmail: normalizeEmail,
    emailFromAddress: emailFromAddress,
    renderBrandedEmail: renderBrandedEmail,
    escapeEmailHtml: escapeEmailHtml
};
