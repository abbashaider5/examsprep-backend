import { Resend } from 'resend';
import logger from '../utils/logger.js';

let _resend = null;
const getResend = () => { if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY); return _resend; };
/** Must use a domain verified in your Resend dashboard (e.g. no-reply@likhitai.com). */
const FROM = process.env.EMAIL_FROM || 'LikhitAI <no-reply@likhitai.com>';
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const BRAND = 'LikhitAI';
/** Matches site primary (teal) — keep in sync with client theme */
const PRIMARY = '#0d9488';

const stripTrailingSlash = (u) => String(u || '').replace(/\/$/, '');

/**
 * Public HTTPS origin where the SPA is deployed. Email clients cannot load images from
 * localhost — if CLIENT_URL is local, set EMAIL_PUBLIC_URL (e.g. https://likhitai.com).
 */
function getEmailPublicBase() {
  const fromEnv =
    process.env.EMAIL_PUBLIC_URL?.trim() ||
    process.env.PUBLIC_APP_URL?.trim();
  if (fromEnv) return stripTrailingSlash(fromEnv);
  return stripTrailingSlash(CLIENT_URL);
}

/** Logo shown in HTML emails: full URL override, else {public base}/likhitai-white-logo.png */
function getLogoUrlForEmail() {
  const full = process.env.EMAIL_LOGO_URL?.trim();
  if (full) return full;
  return `${getEmailPublicBase()}/likhitai-white-logo.png`;
}

const LOGO_URL = getLogoUrlForEmail();

if (/localhost|127\.0\.0\.1/i.test(LOGO_URL) && !process.env.EMAIL_LOGO_URL?.trim()) {
  logger.warn(
    '[Email] Logo uses localhost — images will not load in Gmail/outlook.com. Set EMAIL_PUBLIC_URL=https://your-domain.com or EMAIL_LOGO_URL=https://your-domain.com/likhitai-white-logo.png'
  );
}

/** Public origin for all links inside HTML emails (same rules as logo — avoids localhost). */
const EMAIL_PUBLIC_LINK_BASE = getEmailPublicBase();

// ── Helpers ───────────────────────────────────────────────────────────────────

const attrSafe = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');

/** Header strip with brand logo (see EMAIL_PUBLIC_URL / EMAIL_LOGO_URL). */
const emailHeaderHtml = () =>
  `<img src="${attrSafe(LOGO_URL)}" alt="${attrSafe(BRAND)}" style="display:block;border:0;outline:none;margin:0 auto;max-width:200px;max-height:48px;height:auto;width:auto;" />`;

const layout = (body, preview = '') => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>${BRAND}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
${preview ? `<div style="display:none;max-height:0;overflow:hidden;">${preview}</div>` : ''}
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
      <tr><td style="background:${PRIMARY};border-radius:8px 8px 0 0;padding:18px 24px;text-align:center;">
        ${emailHeaderHtml()}
      </td></tr>
      <tr><td style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none;">
        ${body}
      </td></tr>
      <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:14px 24px;text-align:center;">
        <span style="color:#94a3b8;font-size:11px;">&copy; ${new Date().getFullYear()} ${BRAND} &nbsp;&middot;&nbsp;
          <a href="${EMAIL_PUBLIC_LINK_BASE}" style="color:${PRIMARY};text-decoration:none;">Visit</a> &nbsp;&middot;&nbsp;
          <a href="${EMAIL_PUBLIC_LINK_BASE}/contact" style="color:${PRIMARY};text-decoration:none;">Contact</a>
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
export const sendWelcomeEmail = async ({ email, name, role = 'user' }) => {
  const normalized = role === 'principal' ? 'principal' : (role === 'instructor' ? 'instructor' : 'user');
  const title = normalized === 'principal'
    ? `Welcome, ${name}! Your enterprise workspace is ready.`
    : normalized === 'instructor'
      ? `Welcome, ${name}! Your instructor workspace is ready.`
      : `Welcome, ${name}!`;
  const intro = normalized === 'principal'
    ? `You've joined <strong>${BRAND}</strong> as an <strong>Enterprise Admin</strong>. Manage teachers, review activity, and maintain organization standards.`
    : normalized === 'instructor'
      ? `You've joined <strong>${BRAND}</strong> as an <strong>Instructor</strong>. Create tests, invite learners, and track performance insights.`
      : `You've joined <strong>${BRAND}</strong> as a <strong>Student</strong>. Practice exams, improve skills, and earn certificates.`;
  const ctaUrl = normalized === 'principal'
    ? `${EMAIL_PUBLIC_LINK_BASE}/enterprise-dashboard`
    : normalized === 'instructor'
      ? `${EMAIL_PUBLIC_LINK_BASE}/instructor-dashboard`
      : `${EMAIL_PUBLIC_LINK_BASE}/dashboard`;
  const ctaText = normalized === 'principal' ? 'Open Enterprise Dashboard' : normalized === 'instructor' ? 'Open Instructor Dashboard' : 'Go to Dashboard';
  const rows = normalized === 'principal'
    ? [
        ['Teacher management', 'Invite, monitor, and manage your organization teachers'],
        ['Activity visibility', 'Track enterprise events and system usage'],
        ['Plan governance', 'Run with controls defined by your super admin'],
      ]
    : normalized === 'instructor'
      ? [
        ['Create exams', 'Generate assessments on your topics quickly'],
        ['Manage learners', 'Invite students and track progress from reports'],
        ['Improve outcomes', 'Use analytics to identify weak areas'],
      ]
      : [
        ['Attempt exams', 'Join and complete tests shared with you'],
        ['Track progress', 'Review your performance and weak topics'],
        ['Earn certificates', 'Pass exams to get verifiable certificates'],
      ];
  const html = layout(`
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a;">${title}</h2>
    <p style="color:#475569;font-size:13px;line-height:1.6;margin:0 0 16px;">${intro}</p>
    <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px;">
      ${rows.map(([t, d]) =>
        `<tr><td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;width:140px;">${t}</td><td style="padding:6px 0;font-size:12px;color:#64748b;">${d}</td></tr>`
      ).join('')}
    </table>
    <div style="margin-bottom:8px;">${btn(ctaUrl, ctaText)}</div>
    ${hr()}
    <p style="color:#94a3b8;font-size:11px;margin:0;text-align:center;">If you didn't sign up, please ignore this email.</p>
  `, `Welcome to ${BRAND}, ${name}!`);
  return send(email, `Welcome to ${BRAND}`, html);
};

/** Admin-created account — includes temporary password for first login. */
export const sendAdminProvisionedAccountEmail = async ({ email, name, temporaryPassword }) => {
  const html = layout(`
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a;">Your ${BRAND} account</h2>
    <p style="color:#475569;font-size:13px;line-height:1.6;margin:0 0 16px;">Hi <strong>${name}</strong>, an administrator created an account for you. Sign in with your email and the temporary password below, then change your password from your profile.</p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:13px;color:#334155;">
      <div style="margin-bottom:8px;"><strong>Email:</strong> ${email}</div>
      <div><strong>Temporary password:</strong> <code style="background:#fff;padding:2px 8px;border-radius:4px;font-size:13px;border:1px solid #e2e8f0;">${temporaryPassword}</code></div>
    </div>
    <div style="margin-bottom:8px;">${btn(`${EMAIL_PUBLIC_LINK_BASE}/login`, 'Sign in')}</div>
    ${notice('<strong>Security:</strong> Change your password after logging in. Never share this email with anyone.')}
    ${hr()}
    <p style="color:#94a3b8;font-size:11px;margin:0;text-align:center;">If you were not expecting this account, contact support.</p>
  `, `Your ${BRAND} account is ready`);
  return send(email, `Your ${BRAND} account — sign-in details`, html);
};

/** New enterprise principal — optional temporary password for brand-new accounts. */
export const sendEnterprisePrincipalWelcomeEmail = async ({
  email,
  name,
  enterpriseName,
  isNewAccount,
  temporaryPassword,
}) => {
  const pwdBlock = isNewAccount && temporaryPassword
    ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:13px;color:#334155;">
        <div><strong>Temporary password:</strong> <code style="background:#fff;padding:2px 8px;border-radius:4px;font-size:13px;border:1px solid #e2e8f0;">${temporaryPassword}</code></div>
        <p style="margin:10px 0 0;font-size:12px;color:#64748b;">Sign in and change your password from your profile.</p>
      </div>`
    : '';
  const html = layout(`
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a;">You're the admin for <strong>${enterpriseName}</strong></h2>
    <p style="color:#475569;font-size:13px;line-height:1.6;margin:0 0 16px;">Hi <strong>${name}</strong>, your organization <strong>${enterpriseName}</strong> is set up on <strong>${BRAND}</strong>. Use the enterprise dashboard to invite teachers and manage your team.</p>
    ${pwdBlock}
    <div style="margin-bottom:8px;">${btn(`${EMAIL_PUBLIC_LINK_BASE}/enterprise-dashboard`, 'Open enterprise dashboard')}</div>
    ${notice('<strong>Tip:</strong> Your organization name appears in the header for you and your teachers.')}
    ${hr()}
    <p style="color:#94a3b8;font-size:11px;margin:0;text-align:center;">If this wasn’t expected, contact support.</p>
  `, `${enterpriseName} on ${BRAND}`);
  return send(email, `${enterpriseName} — your LikhitAI organization`, html);
};

export const sendEnterpriseTeacherInviteEmail = async ({
  email,
  teacherName,
  enterpriseName,
  principalName,
  signupUrl,
}) => {
  const html = layout(`
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a;">Join <strong>${enterpriseName}</strong> on ${BRAND}</h2>
    <p style="color:#475569;font-size:13px;line-height:1.6;margin:0 0 16px;">Hi <strong>${teacherName}</strong>, <strong>${principalName}</strong> invited you to teach under <strong>${enterpriseName}</strong>. Create your account (or sign in with the same email) using the link below.</p>
    <div style="margin-bottom:8px;">${btn(signupUrl, 'Accept invitation')}</div>
    ${notice('This invitation is tied to your email address. If you already have an account, use the same email when signing up or contact your admin.')}
    ${hr()}
    <p style="color:#94a3b8;font-size:11px;margin:0;text-align:center;">LikhitAI · Enterprise</p>
  `, `Invitation to ${enterpriseName}`);
  return send(email, `You're invited to teach at ${enterpriseName}`, html);
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
    ${notice('<strong>Security:</strong> ' + BRAND + ' will never ask for your verification code by phone or unrelated email. If you did not request this, ignore this email.')}
  `, `Your verification code for ${BRAND}`);
  return send(email, `Verification code — ${BRAND}`, html);
};

// ── 2b. Password Reset OTP ────────────────────────────────────────────────────
export const sendPasswordResetEmail = async ({ email, name, otp }) => {
  const html = layout(`
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a;">Reset Your Password</h2>
    <p style="color:#475569;font-size:13px;margin:0 0 20px;">Hi ${name || 'there'}, you requested a password reset for your <strong>${BRAND}</strong> account. Use the code below — it expires in <strong>10 minutes</strong>.</p>
    <div style="background:#f8fafc;border:2px dashed #ef4444;border-radius:8px;padding:20px;text-align:center;margin-bottom:16px;">
      <div style="font-size:36px;font-weight:900;letter-spacing:10px;color:#ef4444;font-family:monospace;">${otp}</div>
      <div style="color:#94a3b8;font-size:11px;margin-top:6px;">Valid for 10 minutes &middot; Do not share</div>
    </div>
    ${notice('<strong>Didn\'t request this?</strong> You can safely ignore this email. Your password will not change unless you complete the reset.')}
    <p style="color:#94a3b8;font-size:11px;margin:12px 0 0;text-align:center;">For security, this code can only be used once.</p>
  `, `Reset your ${BRAND} password`);
  return send(email, `Reset your password — ${BRAND}`, html);
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
      <div style="text-align:center;margin-bottom:8px;">${btn(`${EMAIL_PUBLIC_LINK_BASE}/verify/${certId}`, 'Verify Certificate')}</div>
    ` : ''}
    ${!passed ? `
      <p style="font-size:13px;color:#475569;margin:0 0 12px;"><strong>Tip:</strong> Review the explanations in your result page to identify weak areas. Use Practice Mode for improvement.</p>
      <div style="text-align:center;">${btn(`${EMAIL_PUBLIC_LINK_BASE}/dashboard`, 'Practice Again', '#22c55e')}</div>
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
    <div style="text-align:center;">${btn(`${EMAIL_PUBLIC_LINK_BASE}/profile`, 'Secure My Account', '#ef4444')}</div>
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
    <div style="text-align:center;">${btn(`${EMAIL_PUBLIC_LINK_BASE}/dashboard`, 'Practice Mode', '#f59e0b')}</div>
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
    <div style="text-align:center;">${btn(`${EMAIL_PUBLIC_LINK_BASE}/dashboard`, 'Go to Dashboard')}</div>
  `, `${plan} plan activated`);
  return send(email, `Subscription Confirmed — ${BRAND} ${plan}`, html);
};

// ── 7. Instructor Invite ──────────────────────────────────────────────────────
export const sendInstructorInviteEmail = async ({
  email, instructorName, examTitle, examSubject, inviteUrl, signupUrl, expiresAt,
}) => {
  const signupBlock = signupUrl
    ? `<p style="color:#475569;font-size:12px;margin:0 0 10px;text-align:center;">New to ${BRAND}? Create a free account with the same email you were invited on.</p>
       <div style="text-align:center;margin-bottom:16px;">${btn(signupUrl, 'Create account & get the test', '#0d9488')}</div>`
    : '';
  const html = layout(`
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a;">Exam Invitation</h2>
    <p style="color:#475569;font-size:13px;margin:0 0 16px;"><strong>${instructorName}</strong> has invited you to take a test on <strong>${BRAND}</strong>.</p>
    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;padding:12px 16px;margin-bottom:16px;">
      <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#0369a1;">${examTitle}</p>
      <p style="margin:0;font-size:12px;color:#64748b;">Subject: <strong>${examSubject}</strong></p>
    </div>
    <div style="text-align:center;margin-bottom:12px;">${btn(inviteUrl, 'Take the test (sign in)')}</div>
    ${signupBlock}
    <p style="font-size:11px;color:#94a3b8;text-align:center;margin:0;">Invite expires on ${expiresAt}. Use the same email address this message was sent to.</p>
  `, `Invited to: ${examTitle}`);
  await send(email, `Exam Invite: ${examTitle}`, html);
};

// ── 8. Group Invite ───────────────────────────────────────────────────────────
export const sendGroupInviteEmail = async ({ email, instructorName, groupName, acceptUrl, expiresAt }) => {
  const html = layout(`
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a;">You've been invited to a group</h2>
    <p style="color:#475569;font-size:13px;margin:0 0 16px;"><strong>${instructorName}</strong> has invited you to join the study group <strong>${groupName}</strong> on <strong>${BRAND}</strong>.</p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px 16px;margin-bottom:16px;">
      <p style="margin:0;font-size:14px;font-weight:700;color:#15803d;">${groupName}</p>
      <p style="margin:4px 0 0;font-size:12px;color:#64748b;">Instructor: <strong>${instructorName}</strong></p>
    </div>
    <div style="text-align:center;margin-bottom:12px;">${btn(acceptUrl, 'Accept Invitation', '#16a34a')}</div>
    <p style="font-size:11px;color:#94a3b8;text-align:center;margin:0;">Invite expires on ${expiresAt}. You may need to log in or create an account to accept.</p>
  `, `Group invitation: ${groupName}`);
  await send(email, `Group Invite: ${groupName}`, html);
};

// ── 9. Plan Change ────────────────────────────────────────────────────────────
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
    <div style="text-align:center;">${btn(`${EMAIL_PUBLIC_LINK_BASE}/profile`, 'View My Plan')}</div>
  `, isUpgrade ? `Plan upgraded to ${newPlan}` : `Plan updated to ${newPlan}`);
  await send(email, isUpgrade ? `Plan Upgraded to ${newPlan}` : `Plan Updated — ${BRAND}`, html);
};

// ── 9. Contact Reply ──────────────────────────────────────────────────────────
export const sendContactReplyEmail = async ({ email, name, originalMessage, reply }) => {
  const html = layout(`
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a;">We've replied to your query</h2>
    <p style="color:#475569;font-size:13px;line-height:1.6;margin:0 0 16px;">Hi <strong>${name}</strong>, here's our response to your message.</p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:14px 16px;margin-bottom:16px;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;">Your original message</p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">${originalMessage}</p>
    </div>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:14px 16px;margin-bottom:20px;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#2563eb;text-transform:uppercase;">Our reply</p>
      <p style="margin:0;font-size:13px;color:#1e3a5f;line-height:1.6;">${reply}</p>
    </div>
    <p style="font-size:12px;color:#94a3b8;margin:0;">If you have further questions, feel free to contact us again at <a href="${EMAIL_PUBLIC_LINK_BASE}/contact" style="color:${PRIMARY};">our contact page</a>.</p>
  `, `Reply to your query on ${BRAND}`);
  await send(email, `Re: Your query — ${BRAND}`, html);
};

// ── 10. Ticket notifications ──────────────────────────────────────────────────
export const sendTicketCreatedEmail = async ({ email, name, ticketId, title, type, status = 'open' }) => {
  const html = layout(`
    <h2 style="margin:0 0 8px;font-size:20px;color:#0f172a;">Support ticket created</h2>
    <p style="color:#475569;font-size:13px;line-height:1.6;margin:0 0 14px;">
      Hi <strong>${name || 'there'}</strong>, your support request has been received.
    </p>
    <table cellpadding="0" cellspacing="0" width="100%" style="border-radius:6px;border:1px solid #e2e8f0;margin-bottom:16px;overflow:hidden;">
      ${row('Ticket ID', `<code style="font-family:monospace;font-size:12px;">${ticketId}</code>`)}
      ${row('Type', type)}
      ${row('Status', pill(String(status).replace('_', ' ').toUpperCase(), '#dbeafe', '#1e40af'))}
      ${row('Title', title)}
    </table>
    <div style="text-align:center;">${btn(`${EMAIL_PUBLIC_LINK_BASE}/tickets`, 'Track ticket')}</div>
  `, `Ticket ${ticketId} created`);
  await send(email, `Ticket Created: ${ticketId}`, html);
};

export const sendTicketUpdatedEmail = async ({ email, name, ticketId, status, adminResponse = '' }) => {
  const html = layout(`
    <h2 style="margin:0 0 8px;font-size:20px;color:#0f172a;">Support ticket updated</h2>
    <p style="color:#475569;font-size:13px;line-height:1.6;margin:0 0 14px;">
      Hi <strong>${name || 'there'}</strong>, there is an update on your support request.
    </p>
    <table cellpadding="0" cellspacing="0" width="100%" style="border-radius:6px;border:1px solid #e2e8f0;margin-bottom:16px;overflow:hidden;">
      ${row('Ticket ID', `<code style="font-family:monospace;font-size:12px;">${ticketId}</code>`)}
      ${row('Status', pill(String(status).replace('_', ' ').toUpperCase(), '#ecfeff', '#0e7490'))}
    </table>
    ${adminResponse ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px 14px;margin-bottom:16px;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#334155;">Admin response</p>
      <p style="margin:0;font-size:13px;color:#475569;line-height:1.6;white-space:pre-wrap;">${adminResponse}</p>
    </div>` : ''}
    <div style="text-align:center;">${btn(`${EMAIL_PUBLIC_LINK_BASE}/tickets`, 'View ticket')}</div>
  `, `Ticket ${ticketId} updated`);
  await send(email, `Ticket Updated: ${ticketId}`, html);
};

// ── Internal send helper ──────────────────────────────────────────────────────
/** Resend returns `{ data, error }` — it does not throw on API failures; always check `error`. */
export function isResendConfigured() {
  return !!process.env.RESEND_API_KEY?.trim();
}

async function send(to, subject, html, attachments = []) {
  try {
    if (!isResendConfigured()) {
      logger.warn(`[Email] RESEND_API_KEY not set — skipping to ${to}: ${subject}`);
      return false;
    }
    const { data, error } = await getResend().emails.send({
      from: FROM,
      to,
      subject,
      html,
      ...(attachments.length ? { attachments } : {}),
    });
    if (error) {
      logger.error(`[Email] Resend rejected "${subject}" → ${to}: ${JSON.stringify(error)}`);
      return false;
    }
    logger.info(`[Email] Sent "${subject}" → ${to} (id: ${data?.id ?? 'n/a'})`);
    return true;
  } catch (err) {
    logger.error(`[Email] Failed to send to ${to}: ${err.message}`);
    return false;
  }
}
