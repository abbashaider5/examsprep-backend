import { Resend } from 'resend';
import logger from '../utils/logger.js';

let _resend = null;
const getResend = () => { if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY); return _resend; };
const FROM = process.env.EMAIL_FROM || 'ExamsPrep - Abbas Logic <no-reply@abbaslogic.com>';
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const BRAND = 'ExamPrep AI';
const PRIMARY = '#0366AC';

// ── Helpers ───────────────────────────────────────────────────────────────────

const layout = (body, preview = '') => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>${BRAND}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
${preview ? `<div style="display:none;max-height:0;overflow:hidden;">${preview}</div>` : ''}
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
      <tr><td style="background:${PRIMARY};border-radius:8px 8px 0 0;padding:16px 24px;">
        <span style="font-size:18px;font-weight:800;color:#fff;letter-spacing:-0.3px;">${BRAND}</span>
      </td></tr>
      <tr><td style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none;">
        ${body}
      </td></tr>
      <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:14px 24px;text-align:center;">
        <span style="color:#94a3b8;font-size:11px;">&copy; ${new Date().getFullYear()} ${BRAND} &nbsp;&middot;&nbsp;
          <a href="${CLIENT_URL}" style="color:${PRIMARY};text-decoration:none;">Visit</a> &nbsp;&middot;&nbsp;
          <a href="${CLIENT_URL}/contact" style="color:${PRIMARY};text-decoration:none;">Contact</a>
        </span>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

const btn = (url, text, bg = PRIMARY) =>
  `<a href="${url}" style="display:inline-block;background:${bg};color:#fff;font-weight:700;font-size:13px;padding:10px 24px;border-radius:6px;text-decoration:none;">${text}</a>`;

const row = (label, value) =>
  `<tr>
    <td style="padding:8px 12px;font-size:12px;font-weight:600;color:#374151;width:130px;border-right:1px solid #e2e8f0;border-top:1px solid #e2e8f0;background:#f8fafc;">${label}</td>
    <td style="padding:8px 12px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;">${value}</td>
  </tr>`;

const pill = (text, bg, color) =>
  `<span style="display:inline-block;padding:2px 10px;border-radius:12px;background:${bg};color:${color};font-size:11px;font-weight:700;">${text}</span>`;

const notice = (text, bg = '#fffbeb', border = '#fde68a', color = '#92400e') =>
  `<div style="background:${bg};border:1px solid ${border};border-radius:6px;padding:10px 14px;margin:16px 0;font-size:12px;color:${color};">${text}</div>`;

const hr = () => `<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0;"/>`;

// ── 1. Welcome ────────────────────────────────────────────────────────────────
export const sendWelcomeEmail = async ({ email, name }) => {
  const html = layout(`
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a;">Welcome, ${name}!</h2>
    <p style="color:#475569;font-size:13px;line-height:1.6;margin:0 0 16px;">You've joined <strong>${BRAND}</strong>. Here's what you can do right away:</p>
    <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px;">
      ${[
        ['Generate exams', 'Create custom AI-generated MCQs on any topic in seconds'],
        ['Track progress', 'View your analytics and identify weak areas'],
        ['Earn certificates', 'Pass with 75%+ to get a verifiable PDF certificate'],
      ].map(([t, d]) =>
        `<tr><td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;width:140px;">${t}</td><td style="padding:6px 0;font-size:12px;color:#64748b;">${d}</td></tr>`
      ).join('')}
    </table>
    <div style="margin-bottom:8px;">${btn(`${CLIENT_URL}/dashboard`, 'Go to Dashboard')}</div>
    ${hr()}
    <p style="color:#94a3b8;font-size:11px;margin:0;text-align:center;">If you didn't sign up, please ignore this email.</p>
  `, `Welcome to ${BRAND}, ${name}!`);
  return send(email, `Welcome to ${BRAND}`, html);
};

// ── 2. OTP ────────────────────────────────────────────────────────────────────
export const sendOTPEmail = async ({ email, name, otp, purpose = 'login' }) => {
  const label = purpose === 'signup' ? 'verify your account' : 'complete your login';
  const html = layout(`
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a;">Verification Code</h2>
    <p style="color:#475569;font-size:13px;margin:0 0 20px;">Hi ${name || 'there'}, use this code to <strong>${label}</strong>. Expires in 10 minutes.</p>
    <div style="background:#f8fafc;border:2px dashed ${PRIMARY};border-radius:8px;padding:20px;text-align:center;margin-bottom:16px;">
      <div style="font-size:36px;font-weight:900;letter-spacing:10px;color:${PRIMARY};font-family:monospace;">${otp}</div>
      <div style="color:#94a3b8;font-size:11px;margin-top:6px;">Valid for 10 minutes &middot; Do not share</div>
    </div>
    ${notice('<strong>Security:</strong> ' + BRAND + ' will never ask for your OTP. If you did not request this, ignore this email.')}
  `, `Your ${BRAND} code: ${otp}`);
  return send(email, `${otp} — ${BRAND} Verification Code`, html);
};

// ── 3. Result ─────────────────────────────────────────────────────────────────
export const sendResultEmail = async ({ email, name, examName, percentage, passed, certId, pdfBuffer }) => {
  const scoreColor = percentage >= 75 ? '#16a34a' : percentage >= 50 ? '#d97706' : '#dc2626';
  const html = layout(`
    <div style="text-align:center;margin-bottom:16px;">
      <div style="display:inline-block;width:52px;height:52px;border-radius:50%;background:${passed ? '#dcfce7' : '#fee2e2'};line-height:52px;font-size:22px;font-weight:900;color:${passed ? '#16a34a' : '#dc2626'};">
        ${passed ? '&#10003;' : '&#10005;'}
      </div>
      <h2 style="margin:10px 0 2px;font-size:20px;color:#0f172a;">${passed ? 'Congratulations!' : 'Good Effort!'}</h2>
      <p style="color:#64748b;font-size:13px;margin:0;">${passed ? 'You passed the exam.' : "You didn't pass — keep practicing!"}</p>
    </div>
    <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:16px;">
      <tr>
        <td style="text-align:center;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;width:48%;">
          <div style="font-size:24px;font-weight:800;color:${scoreColor};">${percentage}%</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:2px;text-transform:uppercase;">Score</div>
        </td>
        <td width="16"></td>
        <td style="text-align:center;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;width:48%;">
          <div style="font-size:24px;font-weight:800;color:${passed ? '#16a34a' : '#dc2626'};">${passed ? 'PASSED' : 'FAILED'}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:2px;text-transform:uppercase;">Result</div>
        </td>
      </tr>
    </table>
    <p style="font-size:13px;color:#475569;text-align:center;margin:0 0 16px;">Exam: <strong>${examName}</strong></p>
    ${passed && certId ? `
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px 16px;margin-bottom:16px;">
        <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#1e40af;">Certificate Earned</p>
        <p style="margin:0 0 2px;font-size:12px;color:#475569;">ID: <code style="background:#dbeafe;padding:1px 5px;border-radius:3px;">${certId}</code></p>
        <p style="margin:4px 0 0;font-size:11px;color:#94a3b8;">Your certificate PDF is attached.</p>
      </div>
      <div style="text-align:center;margin-bottom:8px;">${btn(`${CLIENT_URL}/verify/${certId}`, 'Verify Certificate')}</div>
    ` : ''}
    ${!passed ? `
      <p style="font-size:13px;color:#475569;margin:0 0 12px;"><strong>Tip:</strong> Review the explanations in your result page to identify weak areas. Use Practice Mode for improvement.</p>
      <div style="text-align:center;">${btn(`${CLIENT_URL}/dashboard`, 'Practice Again', '#22c55e')}</div>
    ` : ''}
  `, `Your ${examName} results`);
  const attachments = passed && pdfBuffer ? [{ filename: `certificate-${certId}.pdf`, content: pdfBuffer }] : [];
  return send(email, passed ? `You passed "${examName}"` : `Your "${examName}" results`, html, attachments);
};

// ── 4. Security Alert ─────────────────────────────────────────────────────────
export const sendSecurityAlertEmail = async ({ email, name, event, details = '', ip = '', time = new Date() }) => {
  const html = layout(`
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:14px 16px;margin-bottom:16px;">
      <p style="margin:0 0 2px;font-size:15px;font-weight:700;color:#991b1b;">Security Alert</p>
      <p style="margin:0;font-size:12px;color:#7f1d1d;">Unusual activity detected on your account</p>
    </div>
    <p style="color:#475569;font-size:13px;margin:0 0 12px;">Hi <strong>${name}</strong>, we detected the following on your ${BRAND} account:</p>
    <table cellpadding="0" cellspacing="0" width="100%" style="border-radius:6px;border:1px solid #e2e8f0;margin-bottom:16px;overflow:hidden;">
      <tr><td style="padding:8px 12px;font-size:12px;font-weight:600;color:#374151;width:130px;border-right:1px solid #e2e8f0;background:#f8fafc;">Event</td><td style="padding:8px 12px;font-size:12px;color:#0f172a;">${event}</td></tr>
      ${ip ? row('IP Address', `<code style="font-family:monospace;font-size:11px;">${ip}</code>`) : ''}
      ${row('Time', new Date(time).toUTCString())}
      ${details ? row('Details', details) : ''}
    </table>
    <p style="font-size:13px;color:#475569;margin:0 0 14px;">If this was you, no action is needed. Otherwise, secure your account immediately.</p>
    <div style="text-align:center;">${btn(`${CLIENT_URL}/profile`, 'Secure My Account', '#ef4444')}</div>
  `, `Security alert on your ${BRAND} account`);
  return send(email, `Security Alert — ${event}`, html);
};

// ── 5. Proctoring Violation ───────────────────────────────────────────────────
export const sendProctoringViolationEmail = async ({ email, name, examName, violations, reason = 'Tab switching detected' }) => {
  const html = layout(`
    <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:14px 16px;margin-bottom:16px;">
      <p style="margin:0 0 2px;font-size:15px;font-weight:700;color:#92400e;">Proctoring Violation</p>
      <p style="margin:0;font-size:12px;color:#78350f;">Your exam was terminated due to policy violations</p>
    </div>
    <p style="color:#475569;font-size:13px;margin:0 0 12px;">Hi <strong>${name}</strong>, your proctored exam <strong>"${examName}"</strong> was terminated.</p>
    <table cellpadding="0" cellspacing="0" width="100%" style="border-radius:6px;border:1px solid #fde68a;margin-bottom:16px;overflow:hidden;">
      <tr><td style="padding:8px 12px;font-size:12px;font-weight:600;color:#92400e;width:130px;border-right:1px solid #fde68a;background:#fffbeb;">Exam</td><td style="padding:8px 12px;font-size:12px;color:#0f172a;">${examName}</td></tr>
      <tr><td style="padding:8px 12px;font-size:12px;font-weight:600;color:#92400e;border-right:1px solid #fde68a;border-top:1px solid #fde68a;background:#fffbeb;">Violations</td><td style="padding:8px 12px;font-size:12px;font-weight:700;color:#dc2626;border-top:1px solid #fde68a;">${violations} / 3</td></tr>
      <tr><td style="padding:8px 12px;font-size:12px;font-weight:600;color:#92400e;border-right:1px solid #fde68a;border-top:1px solid #fde68a;background:#fffbeb;">Reason</td><td style="padding:8px 12px;font-size:12px;color:#64748b;border-top:1px solid #fde68a;">${reason}</td></tr>
    </table>
    <p style="font-size:12px;font-weight:600;color:#334155;margin:0 0 6px;">Exam Rules Reminder:</p>
    <ul style="margin:0 0 16px;padding-left:18px;">
      ${['Do not switch tabs or windows', 'Do not minimize the exam window', 'Copy/paste is disabled', 'Keep focus on the exam at all times'].map(r =>
        `<li style="font-size:12px;color:#475569;padding:2px 0;">${r}</li>`
      ).join('')}
    </ul>
    <div style="text-align:center;">${btn(`${CLIENT_URL}/dashboard`, 'Practice Mode', '#f59e0b')}</div>
  `, `Proctoring violation — ${examName}`);
  return send(email, `Proctoring Violation — "${examName}"`, html);
};

// ── 6. Payment Success ────────────────────────────────────────────────────────
export const sendPaymentSuccessEmail = async ({ email, name, plan, amount, expiresAt }) => {
  const html = layout(`
    <div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:6px;padding:14px 16px;margin-bottom:16px;">
      <p style="margin:0 0 2px;font-size:15px;font-weight:700;color:#065f46;">Subscription Activated</p>
      <p style="margin:0;font-size:12px;color:#047857;">Your ${plan} plan is now active</p>
    </div>
    <p style="color:#475569;font-size:13px;margin:0 0 12px;">Hi <strong>${name}</strong>, your payment was successful.</p>
    <table cellpadding="0" cellspacing="0" width="100%" style="border-radius:6px;border:1px solid #e2e8f0;margin-bottom:16px;overflow:hidden;">
      ${row('Plan', pill(plan.toUpperCase(), '#dbeafe', '#1e40af'))}
      ${row('Amount Paid', `<strong style="color:#16a34a;">${amount}</strong>`)}
      ${row('Valid Until', expiresAt)}
    </table>
    ${notice('<strong>Note:</strong> Log out and log back in to see your updated plan and new limits.')}
    <div style="text-align:center;">${btn(`${CLIENT_URL}/dashboard`, 'Go to Dashboard')}</div>
  `, `${plan} plan activated`);
  return send(email, `Subscription Confirmed — ${BRAND} ${plan}`, html);
};

// ── 7. Instructor Invite ──────────────────────────────────────────────────────
export const sendInstructorInviteEmail = async ({ email, instructorName, examTitle, examSubject, inviteUrl, expiresAt }) => {
  const html = layout(`
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a;">Exam Invitation</h2>
    <p style="color:#475569;font-size:13px;margin:0 0 16px;"><strong>${instructorName}</strong> has invited you to take a test on <strong>${BRAND}</strong>.</p>
    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;padding:12px 16px;margin-bottom:16px;">
      <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#0369a1;">${examTitle}</p>
      <p style="margin:0;font-size:12px;color:#64748b;">Subject: <strong>${examSubject}</strong></p>
    </div>
    <div style="text-align:center;margin-bottom:12px;">${btn(inviteUrl, 'Accept Invite')}</div>
    <p style="font-size:11px;color:#94a3b8;text-align:center;margin:0;">Invite expires on ${expiresAt}. You may need to log in or create an account.</p>
  `, `Invited to: ${examTitle}`);
  await send(email, `Exam Invite: ${examTitle}`, html);
};

// ── 8. Plan Change ────────────────────────────────────────────────────────────
export const sendPlanChangeEmail = async ({ email, name, oldPlan, newPlan, changedBy = 'admin' }) => {
  const ranks = { free: 0, pro: 1, enterprise: 2 };
  const isUpgrade = (ranks[newPlan] ?? 0) > (ranks[oldPlan] ?? 0);
  const html = layout(`
    <div style="background:${isUpgrade ? '#ecfdf5' : '#f8fafc'};border:1px solid ${isUpgrade ? '#6ee7b7' : '#e2e8f0'};border-radius:6px;padding:14px 16px;margin-bottom:16px;">
      <p style="margin:0 0 2px;font-size:15px;font-weight:700;color:#0f172a;">${isUpgrade ? 'Plan Upgraded' : 'Plan Updated'}</p>
      <p style="margin:0;font-size:12px;color:#64748b;">Changed by ${changedBy}</p>
    </div>
    <p style="color:#475569;font-size:13px;margin:0 0 16px;">Hi <strong>${name}</strong>, your ${BRAND} plan has been updated.</p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:14px;margin-bottom:16px;text-align:center;">
      ${pill(oldPlan.toUpperCase(), '#f1f5f9', '#64748b')}
      <span style="padding:0 12px;color:#94a3b8;font-size:16px;">&rarr;</span>
      ${pill(newPlan.toUpperCase(), '#dbeafe', '#1e40af')}
    </div>
    ${notice('<strong>Note:</strong> Log out and log back in to see your updated plan and new limits.')}
    <div style="text-align:center;">${btn(`${CLIENT_URL}/profile`, 'View My Plan')}</div>
  `, isUpgrade ? `Plan upgraded to ${newPlan}` : `Plan updated to ${newPlan}`);
  await send(email, isUpgrade ? `Plan Upgraded to ${newPlan}` : `Plan Updated — ${BRAND}`, html);
};

// ── Internal send helper ──────────────────────────────────────────────────────
async function send(to, subject, html, attachments = []) {
  try {
    if (!process.env.RESEND_API_KEY) {
      logger.warn(`[Email] RESEND_API_KEY not set — skipping to ${to}: ${subject}`);
      return;
    }
    await getResend().emails.send({ from: FROM, to, subject, html, ...(attachments.length ? { attachments } : {}) });
    logger.info(`[Email] Sent "${subject}" → ${to}`);
  } catch (err) {
    logger.error(`[Email] Failed to send to ${to}: ${err.message}`);
  }
}
