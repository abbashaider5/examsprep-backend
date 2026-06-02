import AiHealthEvent from '../models/AiHealthEvent.js';
import AiServiceIncident from '../models/AiServiceIncident.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';
import { createNotificationsForUsers } from '../controllers/notificationController.js';
import { getAppEnvironment } from './ai/aiProviderRegistry.js';

const ALERT_KEY = 'global-ai-outage';
const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CRITICAL_ERROR_TYPES = new Set([
  'Rate Limit Exceeded',
  'Token Limit Exceeded',
  'Provider Unavailable',
  'Timeout',
  'Network Error',
  'Authentication Failure',
  'AI Generation Failure',
  'Configuration Error',
]);

let consecutiveSuccesses = 0;
const RESOLVE_AFTER_SUCCESSES = 3;

async function getAdminUserIds() {
  const admins = await User.find({ role: 'admin', isBlocked: { $ne: true } }).select('_id').lean();
  return admins.map((a) => a._id);
}

function formatTime(d) {
  return new Date(d).toLocaleString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    day: 'numeric',
    month: 'short',
  });
}

function incidentDetailsText(incident, diagnostics) {
  const d = diagnostics || incident.lastErrorSample || {};
  const lines = [
    `Provider: ${d.providerDisplayName || incident.providerDisplayName || incident.provider || '—'}`,
    `Error Type: ${d.errorType || incident.errorType || '—'}`,
    `Error Code: ${d.errorCode || incident.errorCode || '—'}`,
    `Model: ${d.model || incident.model || '—'}`,
  ];
  if (d.tokensUsed != null || incident.tokensUsed != null) {
    lines.push(`Tokens — Used: ${d.tokensUsed ?? incident.tokensUsed ?? '—'}, Limit: ${d.tokensLimit ?? incident.tokensLimit ?? '—'}`);
  }
  lines.push(
    `Environment: ${incident.environment || d.environment || getAppEnvironment()}`,
    `First Detected: ${formatTime(incident.firstDetectedAt)}`,
    `Last Detected: ${formatTime(incident.lastDetectedAt)}`,
    `Affected Users: ${incident.affectedUserCount ?? 0}`,
    `Total Failures: ${incident.failureCount ?? 0}`,
  );
  if (d.rawResponse) {
    lines.push('', 'Raw Response:', String(d.rawResponse).slice(0, 4000));
  }
  return lines.join('\n');
}

async function findActiveIncidentInWindow() {
  const since = new Date(Date.now() - ALERT_WINDOW_MS);
  return AiServiceIncident.findOne({
    alertKey: ALERT_KEY,
    status: 'active',
    firstDetectedAt: { $gte: since },
  }).sort({ firstDetectedAt: -1 });
}

/**
 * @param {{ diagnostics: import('./ai/aiProviderErrors.js').NormalizedAiError, userId?: string, userEmail?: string, userName?: string, requestId?: string, operation?: string }} payload
 */
export async function recordAiFailure(payload) {
  const { diagnostics, userId, requestId, operation } = payload;
  if (!diagnostics) return null;

  if (!CRITICAL_ERROR_TYPES.has(diagnostics.errorType)) {
    logger.warn(`[aiHealth] non-critical AI error: ${diagnostics.errorType}`);
  }

  let incident = await findActiveIncidentInWindow();
  const isNewIncident = !incident;

  if (!incident) {
    incident = await AiServiceIncident.create({
      alertKey: ALERT_KEY,
      status: 'active',
      provider: diagnostics.provider,
      providerDisplayName: diagnostics.providerDisplayName,
      errorType: diagnostics.errorType,
      errorCode: diagnostics.errorCode,
      model: diagnostics.model,
      tokensUsed: diagnostics.tokensUsed,
      tokensLimit: diagnostics.tokensLimit,
      environment: diagnostics.environment || getAppEnvironment(),
      firstDetectedAt: new Date(),
      lastDetectedAt: new Date(),
      affectedUserIds: userId ? [userId] : [],
      affectedUserCount: userId ? 1 : 0,
      failureCount: 1,
      lastErrorSample: diagnostics,
      requestIds: requestId ? [requestId] : [],
    });
  } else {
    incident.lastDetectedAt = new Date();
    incident.failureCount = (incident.failureCount || 0) + 1;
    incident.provider = diagnostics.provider || incident.provider;
    incident.providerDisplayName = diagnostics.providerDisplayName || incident.providerDisplayName;
    incident.errorType = diagnostics.errorType || incident.errorType;
    incident.errorCode = diagnostics.errorCode || incident.errorCode;
    incident.model = diagnostics.model || incident.model;
    if (diagnostics.tokensUsed != null) incident.tokensUsed = diagnostics.tokensUsed;
    if (diagnostics.tokensLimit != null) incident.tokensLimit = diagnostics.tokensLimit;
    incident.lastErrorSample = diagnostics;

    if (userId) {
      const uid = String(userId);
      const ids = (incident.affectedUserIds || []).map(String);
      if (!ids.includes(uid)) {
        incident.affectedUserIds.push(userId);
      }
      incident.affectedUserCount = incident.affectedUserIds.length;
    }

    if (requestId && !(incident.requestIds || []).includes(requestId)) {
      incident.requestIds = [...(incident.requestIds || []), requestId].slice(-50);
    }
    await incident.save();
  }

  await AiHealthEvent.create({
    incident: incident._id,
    provider: diagnostics.provider,
    errorType: diagnostics.errorType,
    errorCode: diagnostics.errorCode,
    model: diagnostics.model,
    user: userId || null,
    requestId: requestId || '',
    operation: operation || diagnostics.operation || '',
    environment: diagnostics.environment || getAppEnvironment(),
    message: diagnostics.message,
    rawResponse: diagnostics.rawResponse,
    stackTrace: diagnostics.stackTrace,
    tokensUsed: diagnostics.tokensUsed,
    tokensLimit: diagnostics.tokensLimit,
  }).catch((e) => logger.warn(`[aiHealth] event log failed: ${e.message}`));

  if (isNewIncident) {
    const adminIds = await getAdminUserIds();
    if (adminIds.length) {
      const count = incident.affectedUserCount || 0;
      await createNotificationsForUsers(adminIds, {
        type: 'ai_service_alert',
        title: '🔴 Critical AI Service Alert',
        message: `AI exam generation is currently failing for one or more users. Affected users: ${count}.`,
        severity: 'critical',
        details: incidentDetailsText(incident, diagnostics),
        meta: {
          incidentId: String(incident._id),
          provider: diagnostics.providerDisplayName,
          errorType: diagnostics.errorType,
          errorCode: diagnostics.errorCode,
          model: diagnostics.model,
          affectedUserCount: count,
          firstDetectedAt: incident.firstDetectedAt,
          lastDetectedAt: incident.lastDetectedAt,
          aiDiagnostics: diagnostics,
        },
      });
      incident.alertSentAt = new Date();
      await incident.save();
    }
  } else if (!incident.alertSentAt) {
    const adminIds = await getAdminUserIds();
    if (adminIds.length) {
      await createNotificationsForUsers(adminIds, {
        type: 'ai_service_alert',
        title: '🔴 Critical AI Service Alert',
        message: `AI exam generation is still failing. Affected users: ${incident.affectedUserCount || 0}.`,
        severity: 'critical',
        details: incidentDetailsText(incident, diagnostics),
        meta: { incidentId: String(incident._id), aiDiagnostics: diagnostics },
      });
      incident.alertSentAt = new Date();
      await incident.save();
    }
  }

  consecutiveSuccesses = 0;
  return incident;
}

export async function recordAiSuccess() {
  consecutiveSuccesses += 1;
  if (consecutiveSuccesses < RESOLVE_AFTER_SUCCESSES) return;

  const active = await AiServiceIncident.find({ status: 'active' }).sort({ lastDetectedAt: -1 });
  if (!active.length) return;

  for (const incident of active) {
    const downtimeMs = Date.now() - new Date(incident.firstDetectedAt).getTime();
    const hours = Math.floor(downtimeMs / 3600000);
    const mins = Math.floor((downtimeMs % 3600000) / 60000);
    const durationLabel = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    incident.status = 'resolved';
    incident.resolvedAt = new Date();
    await incident.save();

    if (!incident.restoredNotificationSentAt) {
      const adminIds = await getAdminUserIds();
      if (adminIds.length) {
        await createNotificationsForUsers(adminIds, {
          type: 'ai_service_restored',
          title: '🟢 AI Service Restored',
          message: 'AI exam generation has returned to normal operation.',
          severity: 'success',
          details: [
            `Downtime duration: ${durationLabel}`,
            `Total affected users: ${incident.affectedUserCount || 0}`,
            `Resolved at: ${formatTime(incident.resolvedAt)}`,
            `Peak error: ${incident.errorType || '—'} (${incident.providerDisplayName || incident.provider || '—'})`,
          ].join('\n'),
          meta: {
            incidentId: String(incident._id),
            downtimeMs,
            affectedUserCount: incident.affectedUserCount,
            resolvedAt: incident.resolvedAt,
          },
        });
        incident.restoredNotificationSentAt = new Date();
        await incident.save();
      }
    }
  }
  consecutiveSuccesses = 0;
}

export async function getActiveIncidentSummary() {
  const incident = await findActiveIncidentInWindow();
  if (!incident) return null;
  return {
    id: incident._id,
    status: incident.status,
    provider: incident.providerDisplayName || incident.provider,
    errorType: incident.errorType,
    errorCode: incident.errorCode,
    model: incident.model,
    affectedUserCount: incident.affectedUserCount || 0,
    failureCount: incident.failureCount || 0,
    firstDetectedAt: incident.firstDetectedAt,
    lastDetectedAt: incident.lastDetectedAt,
    environment: incident.environment,
  };
}

export async function getIncidentById(id) {
  const incident = await AiServiceIncident.findById(id).lean();
  if (!incident) return null;
  const events = await AiHealthEvent.find({ incident: id })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('user', 'name email')
    .lean();
  return { incident, events };
}

export async function listRecentIncidents(limit = 20) {
  return AiServiceIncident.find().sort({ createdAt: -1 }).limit(limit).lean();
}
