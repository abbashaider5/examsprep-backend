import Enterprise from '../models/Enterprise.js';
import User from '../models/User.js';

export function addMonthsClamped(date, months) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d;
}

/** Enterprise org plan or org trial is active. */
export function enterpriseSubscriptionIsActive(ent) {
  if (!ent) return false;
  const now = new Date();
  if (ent.orgTrialEndsAt && ent.orgTrialEndsAt > now) return true;
  if (ent.orgPlanExpiresAt && ent.orgPlanExpiresAt > now) return true;
  return false;
}

function sortPendingQueue(q) {
  return [...(q || [])]
    .filter((x) => x.status === 'pending')
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

/** Start of the next renewal segment: end of paid window or org trial, whichever is later; else now. */
export function getEnterpriseRenewalChainAnchor(ent) {
  const now = new Date();
  let anchorMs = now.getTime();
  if (ent.orgPlanExpiresAt && ent.orgPlanExpiresAt > now) {
    anchorMs = Math.max(anchorMs, ent.orgPlanExpiresAt.getTime());
  }
  if (ent.orgTrialEndsAt && ent.orgTrialEndsAt > now) {
    anchorMs = Math.max(anchorMs, ent.orgTrialEndsAt.getTime());
  }
  return new Date(anchorMs);
}

export function getPersonalRenewalChainAnchor(user) {
  const now = new Date();
  let anchorMs = now.getTime();
  if (user.planExpiresAt && user.planExpiresAt > now && ['pro', 'enterprise'].includes(user.plan)) {
    anchorMs = Math.max(anchorMs, user.planExpiresAt.getTime());
  }
  if (user.instructorTrialEndsAt && user.instructorTrialEndsAt > now) {
    anchorMs = Math.max(anchorMs, user.instructorTrialEndsAt.getTime());
  }
  return new Date(anchorMs);
}

/**
 * Recompute activatesAt for each pending renewal so they chain after current org expiry.
 */
export function recomputeEnterpriseRenewalChain(ent) {
  const pending = sortPendingQueue(ent.subscriptionRenewalQueue);
  let cursor = getEnterpriseRenewalChainAnchor(ent);
  pending.forEach((item, i) => {
    item.activatesAt = new Date(cursor);
    cursor = addMonthsClamped(cursor, item.durationMonths);
    item.sequence = i;
  });
}

export function recomputeUserRenewalChain(user) {
  const pending = sortPendingQueue(user.subscriptionRenewalQueue);
  let cursor = getPersonalRenewalChainAnchor(user);
  pending.forEach((item, i) => {
    item.activatesAt = new Date(cursor);
    cursor = addMonthsClamped(cursor, item.durationMonths);
    item.sequence = i;
  });
}

function queueHasPendingTransactionId(queue, transactionId) {
  if (!transactionId) return false;
  const tid = String(transactionId);
  return (queue || []).some(
    (x) => x.status === 'pending' && x.transactionId && String(x.transactionId) === tid,
  );
}

export async function enqueuePersonalRenewal(userId, entry) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');
  if (!user.subscriptionRenewalQueue) user.subscriptionRenewalQueue = [];
  if (queueHasPendingTransactionId(user.subscriptionRenewalQueue, entry.transactionId)) {
    recomputeUserRenewalChain(user);
    user.markModified('subscriptionRenewalQueue');
    await user.save({ validateBeforeSave: false });
    return user;
  }
  const pendingCount = user.subscriptionRenewalQueue.filter((x) => x.status === 'pending').length;
  user.subscriptionRenewalQueue.push({
    ...entry,
    status: 'pending',
    sequence: pendingCount,
  });
  recomputeUserRenewalChain(user);
  user.markModified('subscriptionRenewalQueue');
  await user.save({ validateBeforeSave: false });
  return user;
}

export async function enqueueEnterpriseRenewal(enterpriseId, entry) {
  const ent = await Enterprise.findById(enterpriseId);
  if (!ent) throw new Error('Enterprise not found');
  if (!ent.subscriptionRenewalQueue) ent.subscriptionRenewalQueue = [];
  if (queueHasPendingTransactionId(ent.subscriptionRenewalQueue, entry.transactionId)) {
    recomputeEnterpriseRenewalChain(ent);
    ent.markModified('subscriptionRenewalQueue');
    await ent.save();
    return ent;
  }
  const pendingCount = ent.subscriptionRenewalQueue.filter((x) => x.status === 'pending').length;
  ent.subscriptionRenewalQueue.push({
    ...entry,
    status: 'pending',
    sequence: pendingCount,
  });
  recomputeEnterpriseRenewalChain(ent);
  ent.markModified('subscriptionRenewalQueue');
  await ent.save();
  return ent;
}

function removePendingQueueItemByTransaction(queue, next) {
  const arr = queue || [];
  const tid = next?.transactionId;
  let idx = -1;
  if (tid) {
    idx = arr.findIndex((x) => x.status === 'pending' && x.transactionId && String(x.transactionId) === String(tid));
  }
  if (idx < 0) {
    idx = arr.findIndex(
      (x) => x.status === 'pending'
        && Number(x.sequence) === Number(next.sequence)
        && Number(x.durationMonths) === Number(next.durationMonths),
    );
  }
  if (idx >= 0) arr.splice(idx, 1);
  return arr;
}

/**
 * Apply due personal renewals after expiry (FIFO). Race-safe enough for SaaS: single-writer save.
 */
export async function processPersonalSubscriptionLifecycle(userId) {
  const now = new Date();
  await User.updateMany(
    { _id: userId, instructorTrialEndsAt: { $lte: now } },
    { $set: { instructorTrialEndsAt: null } },
  );
  const user = await User.findById(userId);
  if (!user) return user;

  let guard = 0;
  while (guard++ < 20) {
    const trialActive = user.instructorTrialEndsAt && user.instructorTrialEndsAt > now;
    const paidActive = user.planExpiresAt && user.planExpiresAt > now && ['pro', 'enterprise'].includes(user.plan);
    if (trialActive || paidActive) break;

    const pending = sortPendingQueue(user.subscriptionRenewalQueue);
    const next = pending[0];
    if (!next) {
      if (user.plan === 'pro' || user.plan === 'enterprise') {
        user.plan = 'free';
        user.planExpiresAt = null;
        user.extraExamCreditsBalance = 0;
      }
      await user.save({ validateBeforeSave: false });
      break;
    }
    const anchor = user.planExpiresAt && user.planExpiresAt > new Date(0) ? user.planExpiresAt : now;
    user.planExpiresAt = addMonthsClamped(anchor <= now ? now : anchor, next.durationMonths);
    user.plan = next.plan || 'pro';
    user.examsCreatedThisMonth = 0;
    user.monthlyExamResetDate = now;
    user.subscriptionRenewalQueue = removePendingQueueItemByTransaction(user.subscriptionRenewalQueue, next);
    recomputeUserRenewalChain(user);
    user.markModified('subscriptionRenewalQueue');
    await user.save({ validateBeforeSave: false });
  }
  return User.findById(userId);
}

export async function processEnterpriseSubscriptionLifecycle(enterpriseId) {
  const ent = await Enterprise.findById(enterpriseId);
  if (!ent) return null;

  const now = new Date();
  if (ent.orgTrialEndsAt && ent.orgTrialEndsAt <= now) {
    ent.orgTrialEndsAt = null;
  }

  let guard = 0;
  while (guard++ < 20) {
    if (enterpriseSubscriptionIsActive(ent)) break;

    const pending = sortPendingQueue(ent.subscriptionRenewalQueue);
    const next = pending[0];
    if (!next) break;

    const anchor = ent.orgPlanExpiresAt && ent.orgPlanExpiresAt > new Date(0) ? ent.orgPlanExpiresAt : now;
    ent.orgPlanExpiresAt = addMonthsClamped(anchor <= now ? now : anchor, next.durationMonths);
    ent.orgPlanStartedAt = now;
    ent.orgPlanDurationMonths = next.durationMonths;
    if (next.snapshot && typeof next.snapshot === 'object') {
      if (next.snapshot.teacherLimit != null) ent.teacherLimit = next.snapshot.teacherLimit;
      if (next.snapshot.examsPerTeacherLimit != null) ent.examsPerTeacherLimit = next.snapshot.examsPerTeacherLimit;
      if (next.snapshot.questionsPerExamLimit != null) ent.questionsPerExamLimit = next.snapshot.questionsPerExamLimit;
      if (next.snapshot.studentLimit != null) ent.studentLimit = next.snapshot.studentLimit;
      if (next.snapshot.aiProctoringEnabled != null) ent.aiProctoringEnabled = next.snapshot.aiProctoringEnabled;
      if (next.snapshot.aiListeningEnabled != null) ent.aiListeningEnabled = next.snapshot.aiListeningEnabled;
      if (next.snapshot.aiResourceProcessingEnabled != null) ent.aiResourceProcessingEnabled = next.snapshot.aiResourceProcessingEnabled;
      if (next.snapshot.codingExamsEnabled != null) ent.codingExamsEnabled = next.snapshot.codingExamsEnabled;
      if (next.snapshot.aiExamGenerationEnabled != null) ent.aiExamGenerationEnabled = next.snapshot.aiExamGenerationEnabled;
    }
    ent.orgTrialEndsAt = null;
    ent.subscriptionRenewalQueue = removePendingQueueItemByTransaction(ent.subscriptionRenewalQueue, next);
    recomputeEnterpriseRenewalChain(ent);
    ent.markModified('subscriptionRenewalQueue');
    await ent.save();

    const principal = await User.findById(ent.principalUser);
    if (principal) {
      principal.plan = 'enterprise';
      principal.planExpiresAt = ent.orgPlanExpiresAt;
      await principal.save({ validateBeforeSave: false });
    }
  }

  const pendingAfter = sortPendingQueue(ent.subscriptionRenewalQueue);
  const orgAccessActive = enterpriseSubscriptionIsActive(ent);
  ent.orgPlanActive = orgAccessActive;
  await ent.save();

  if (!orgAccessActive && !pendingAfter.length) {
    const principal = await User.findById(ent.principalUser);
    if (principal?.plan === 'enterprise' && principal.enterpriseId?.toString() === ent._id.toString()) {
      principal.plan = 'free';
      principal.planExpiresAt = null;
      principal.extraExamCreditsBalance = 0;
      await principal.save({ validateBeforeSave: false });
    }
  }

  return Enterprise.findById(enterpriseId);
}

export function buildEnterpriseSnapshot(ent) {
  return {
    teacherLimit: ent.teacherLimit,
    examsPerTeacherLimit: ent.examsPerTeacherLimit,
    questionsPerExamLimit: ent.questionsPerExamLimit,
    studentLimit: ent.studentLimit,
    aiProctoringEnabled: ent.aiProctoringEnabled !== false,
    aiListeningEnabled: ent.aiListeningEnabled !== false,
    aiResourceProcessingEnabled: ent.aiResourceProcessingEnabled !== false,
    codingExamsEnabled: ent.codingExamsEnabled !== false,
    aiExamGenerationEnabled: ent.aiExamGenerationEnabled !== false,
  };
}

/** Serializable segments for billing UI (principal / subscription API). */
export function buildEnterpriseRenewalTimeline(ent) {
  if (!ent) return { segments: [] };
  const now = new Date();
  const segments = [];
  const active = enterpriseSubscriptionIsActive(ent);

  if (ent.orgPlanExpiresAt && ent.orgPlanExpiresAt > now) {
    segments.push({
      kind: 'current',
      title: 'Active organization plan',
      startsAt: ent.orgPlanStartedAt || null,
      endsAt: ent.orgPlanExpiresAt,
      durationMonths: ent.orgPlanDurationMonths ?? null,
    });
  } else if (ent.orgTrialEndsAt && ent.orgTrialEndsAt > now) {
    segments.push({
      kind: 'trial',
      title: 'Organization trial',
      startsAt: null,
      endsAt: ent.orgTrialEndsAt,
      durationMonths: null,
    });
  } else if (!active) {
    segments.push({
      kind: 'inactive',
      title: 'No active organization subscription',
      startsAt: null,
      endsAt: null,
      durationMonths: null,
    });
  }

  const pending = sortPendingQueue(ent.subscriptionRenewalQueue);
  pending.forEach((q, i) => {
    const start = q.activatesAt ? new Date(q.activatesAt) : null;
    const end = start ? addMonthsClamped(start, q.durationMonths) : null;
    segments.push({
      kind: 'queued',
      order: i + 1,
      title: `Renewal ${i + 1} (queued)`,
      startsAt: start,
      endsAt: end,
      durationMonths: q.durationMonths,
    });
  });

  return { segments };
}

export function buildPersonalRenewalTimeline(user) {
  if (!user) return { segments: [] };
  const now = new Date();
  const segments = [];
  const trialActive = user.instructorTrialEndsAt && user.instructorTrialEndsAt > now;
  const paidActive = user.planExpiresAt && user.planExpiresAt > now && ['pro', 'enterprise'].includes(user.plan);

  if (paidActive) {
    segments.push({
      kind: 'current',
      title: 'Active subscription',
      startsAt: null,
      endsAt: user.planExpiresAt,
      durationMonths: null,
      plan: user.plan,
    });
  } else if (trialActive) {
    segments.push({
      kind: 'trial',
      title: 'Instructor trial',
      startsAt: null,
      endsAt: user.instructorTrialEndsAt,
      durationMonths: null,
      plan: 'pro',
    });
  }

  const pending = sortPendingQueue(user.subscriptionRenewalQueue);
  pending.forEach((q, i) => {
    const start = q.activatesAt ? new Date(q.activatesAt) : null;
    const end = start ? addMonthsClamped(start, q.durationMonths) : null;
    segments.push({
      kind: 'queued',
      order: i + 1,
      title: `Renewal ${i + 1} (queued)`,
      startsAt: start,
      endsAt: end,
      durationMonths: q.durationMonths,
      plan: q.plan || 'pro',
    });
  });

  return { segments };
}
