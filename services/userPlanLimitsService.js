import Plan from '../models/Plan.js';
import Enterprise from '../models/Enterprise.js';
import Subscription from '../models/Subscription.js';
import User, { PLAN_LIMITS, PLAN_MAX_Q } from '../models/User.js';
import { getSettings } from '../models/SystemSettings.js';
import { enterpriseSubscriptionIsActive } from './subscriptionLifecycleService.js';
import { findDefaultInstructorTrialPlan } from './instructorTrialService.js';

/** Human-readable labels for plan feature flags (admin-defined keys). */
export const FEATURE_LABELS = {
  aiQuestionGeneration: 'AI Question Generation',
  aiRegeneration: 'AI Regeneration',
  aiFlashcards: 'AI Flashcards',
  aiExplanations: 'AI Explanations',
  mcqExams: 'MCQ Exams',
  descriptiveExams: 'Descriptive Exams',
  mixedExams: 'Mixed Exams',
  codingExams: 'Coding Exams',
  listeningExams: 'Listening Exams',
  certificates: 'Certificates',
  answerReview: 'Answer Review',
  flashcards: 'Flashcards',
  reattempts: 'Reattempts',
  resultVisibility: 'Result Visibility',
  aiProctoring: 'AI Proctoring',
  screenshotMonitoring: 'Screenshot Monitoring',
  resourceUpload: 'Resource Upload',
  aiResourceProcessing: 'AI Resource Processing',
  adminResourcesAccess: 'Admin Resources Access',
};

export function effectivePlanType(user) {
  if (!user) return 'free';
  const now = new Date();
  if (user.instructorTrialEndsAt && user.instructorTrialEndsAt > now) return 'pro';
  if (user.plan === 'free') return 'free';
  if (user.planExpiresAt && user.planExpiresAt < now) return 'free';
  return user.plan;
}

export function effectivePlanTypeWithEnterprise(user, ent) {
  if (user?.enterpriseId && (user.role === 'instructor' || user.role === 'principal') && ent && enterpriseSubscriptionIsActive(ent)) {
    return 'enterprise';
  }
  return effectivePlanType(user);
}

function planStatusForUser(user) {
  if (!user) return 'free';
  const now = new Date();
  if (user.instructorTrialEndsAt && user.instructorTrialEndsAt > now) return 'trial';
  if (user.plan === 'free') return 'free';
  if (user.planExpiresAt && user.planExpiresAt < now) return 'expired';
  return 'active';
}

function limitsFromPlanDoc(plan) {
  const l = plan?.limits || {};
  return {
    examsPerMonth: Number(l.examsPerMonth) || 20,
    questionsPerExam: Number(l.questionsPerExam) || 50,
    studentsAllowed: Number(l.studentsAllowed) || 0,
    resourceUploadLimit: Number(l.resourceUploadLimit) || 20,
    storageLimitGb: Number(l.storageLimitGb) || 5,
  };
}

function featuresFromPlanDoc(plan) {
  const raw = plan?.features && typeof plan.features === 'object'
    ? (plan.features.toObject ? plan.features.toObject() : plan.features)
    : {};
  return { ...raw };
}

function featuresFromEnterprise(ent) {
  return {
    aiQuestionGeneration: ent.aiExamGenerationEnabled !== false,
    aiRegeneration: ent.aiExamGenerationEnabled !== false,
    aiFlashcards: true,
    aiExplanations: true,
    mcqExams: true,
    descriptiveExams: true,
    mixedExams: true,
    codingExams: ent.codingExamsEnabled !== false,
    listeningExams: ent.aiListeningEnabled !== false,
    certificates: true,
    answerReview: true,
    flashcards: true,
    reattempts: true,
    resultVisibility: true,
    aiProctoring: ent.aiProctoringEnabled !== false,
    screenshotMonitoring: true,
    resourceUpload: true,
    aiResourceProcessing: ent.aiResourceProcessingEnabled !== false,
    adminResourcesAccess: true,
  };
}

const FEATURE_CATEGORIES = {
  mcqExams: 'exam', descriptiveExams: 'exam', mixedExams: 'exam', codingExams: 'exam', listeningExams: 'exam', reattempts: 'exam',
  aiQuestionGeneration: 'ai', aiRegeneration: 'ai', aiFlashcards: 'ai', aiExplanations: 'ai', aiResourceProcessing: 'ai',
  aiProctoring: 'security', screenshotMonitoring: 'security',
  certificates: 'reporting', answerReview: 'reporting', flashcards: 'reporting', resultVisibility: 'reporting',
  resourceUpload: 'resource', adminResourcesAccess: 'resource',
};

const DEFAULT_FEATURE_PRIORITY = {
  aiQuestionGeneration: 95, aiProctoring: 90, codingExams: 88, resourceUpload: 85, certificates: 82, flashcards: 80,
  listeningExams: 75, aiResourceProcessing: 70, mixedExams: 65, mcqExams: 60, descriptiveExams: 58, answerReview: 55,
  aiRegeneration: 50, aiFlashcards: 48, aiExplanations: 46, screenshotMonitoring: 44, reattempts: 42, resultVisibility: 40,
  adminResourcesAccess: 35,
};

const DEFAULT_HIGHLIGHTED = new Set([
  'aiQuestionGeneration', 'resourceUpload', 'certificates', 'flashcards', 'aiProctoring', 'codingExams',
]);

function featureMetaFromPlan(planRecord, key) {
  const settings = planRecord?.featureSettings?.[key] || {};
  const priority = Number.isFinite(Number(settings.priority))
    ? Number(settings.priority)
    : (DEFAULT_FEATURE_PRIORITY[key] ?? 50);
  const highlighted = settings.highlighted === true
    || settings.isHighlighted === true
    || (Array.isArray(planRecord?.highlightedFeatures) && planRecord.highlightedFeatures.includes(key))
    || DEFAULT_HIGHLIGHTED.has(key);
  const category = settings.category || FEATURE_CATEGORIES[key] || 'exam';
  return { priority, highlighted, category };
}

export function buildFeatureList(features, planRecord = null) {
  if (!features || typeof features !== 'object') return [];
  return Object.entries(features).map(([key, enabled]) => {
    const meta = featureMetaFromPlan(planRecord, key);
    return {
      key,
      label: FEATURE_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()).trim(),
      enabled: enabled !== false,
      category: meta.category,
      priority: meta.priority,
      highlighted: meta.highlighted,
    };
  });
}

async function loadFreeTierLimits() {
  const settings = await getSettings();
  return {
    examsPerMonth: settings.examsIncludedFree ?? PLAN_LIMITS.free,
    questionsPerExam: settings.maxQuestionsFree ?? PLAN_MAX_Q.free,
    studentsAllowed: 0,
    resourceUploadLimit: 5,
    storageLimitGb: 1,
  };
}

async function loadFreeTierFeatures() {
  return {
    aiQuestionGeneration: true,
    aiRegeneration: false,
    aiFlashcards: false,
    aiExplanations: false,
    mcqExams: true,
    descriptiveExams: false,
    mixedExams: false,
    codingExams: false,
    listeningExams: false,
    certificates: false,
    answerReview: false,
    flashcards: false,
    reattempts: false,
    resultVisibility: true,
    aiProctoring: false,
    screenshotMonitoring: false,
    resourceUpload: true,
    aiResourceProcessing: false,
    adminResourcesAccess: false,
  };
}

async function findIndividualPlanByCode(code, { includeInactive = false } = {}) {
  if (!code) return null;
  const q = { code, audience: 'individual' };
  if (!includeInactive) q.isActive = true;
  return Plan.findOne(q).lean();
}

async function findRecommendedIndividualPlan() {
  return Plan.findOne({ audience: 'individual', isActive: true, isRecommended: true }).lean()
    || Plan.findOne({ audience: 'individual', isActive: true }).sort({ sortOrder: 1 }).lean();
}

/**
 * Resolves plan record, limits, and features for a user (enterprise overrides included).
 */
export async function resolveActivePlanForUser(user) {
  if (!user) return null;

  const now = new Date();
  const legacyPlan = effectivePlanType(user);

  if (user.enterpriseId && (user.role === 'instructor' || user.role === 'principal')) {
    const ent = await Enterprise.findById(user.enterpriseId)
      .select(
        'examsPerTeacherLimit questionsPerExamLimit aiProctoringEnabled aiListeningEnabled '
        + 'aiResourceProcessingEnabled codingExamsEnabled aiExamGenerationEnabled orgPlanExpiresAt orgTrialEndsAt',
      )
      .lean();
    if (enterpriseSubscriptionIsActive(ent)) {
      return {
        source: 'enterprise',
        planCode: 'enterprise',
        planName: 'Organization',
        legacyPlan: 'enterprise',
        sortOrder: 10000,
        limits: {
          examsPerMonth: Number(ent.examsPerTeacherLimit) || PLAN_LIMITS.enterprise,
          questionsPerExam: Number(ent.questionsPerExamLimit) || PLAN_MAX_Q.enterprise,
          studentsAllowed: 0,
          resourceUploadLimit: 50,
          storageLimitGb: 10,
        },
        features: featuresFromEnterprise(ent),
        planRecord: null,
      };
    }
  }

  if (user.instructorTrialEndsAt && user.instructorTrialEndsAt > now) {
    let trialPlan = null;
    if (user.individualPlanCode) {
      trialPlan = await findIndividualPlanByCode(user.individualPlanCode, { includeInactive: true });
    }
    if (!trialPlan) {
      trialPlan = await findDefaultInstructorTrialPlan();
    }
    if (trialPlan) {
      return {
        source: 'trial',
        planCode: trialPlan.code,
        planName: trialPlan.name,
        legacyPlan: 'pro',
        sortOrder: Number(trialPlan.sortOrder) || 100,
        limits: limitsFromPlanDoc(trialPlan),
        features: featuresFromPlanDoc(trialPlan),
        planRecord: trialPlan,
      };
    }
  }

  if (legacyPlan === 'free') {
    return {
      source: 'free',
      planCode: 'free',
      planName: 'Free',
      legacyPlan: 'free',
      sortOrder: 0,
      limits: await loadFreeTierLimits(),
      features: await loadFreeTierFeatures(),
      planRecord: null,
    };
  }

  let planRecord = null;
  if (user.individualPlanCode) {
    planRecord = await findIndividualPlanByCode(user.individualPlanCode, { includeInactive: true });
  }
  if (!planRecord) {
    planRecord = await findIndividualPlanByCode('premium');
    if (!planRecord) planRecord = await findRecommendedIndividualPlan();
  }

  if (planRecord) {
    return {
      source: 'individual',
      planCode: planRecord.code,
      planName: planRecord.name,
      legacyPlan,
      sortOrder: Number(planRecord.sortOrder) || 100,
      limits: limitsFromPlanDoc(planRecord),
      features: featuresFromPlanDoc(planRecord),
      planRecord,
    };
  }

  const settings = await getSettings();
  const tier = legacyPlan === 'enterprise' ? 'enterprise' : 'pro';
  return {
    source: 'legacy-settings',
    planCode: user.individualPlanCode || tier,
    planName: user.individualPlanCode || (tier === 'enterprise' ? 'Enterprise' : 'Premium'),
    legacyPlan,
    sortOrder: tier === 'enterprise' ? 200 : 100,
    limits: {
      examsPerMonth: tier === 'enterprise'
        ? (settings.examsIncludedEnterprise ?? PLAN_LIMITS.enterprise)
        : (settings.examsIncludedPro ?? PLAN_LIMITS.pro),
      questionsPerExam: tier === 'enterprise'
        ? (settings.maxQuestionsEnterprise ?? PLAN_MAX_Q.enterprise)
        : (settings.maxQuestionsPro ?? PLAN_MAX_Q.pro),
      studentsAllowed: 0,
      resourceUploadLimit: 20,
      storageLimitGb: tier === 'enterprise' ? 10 : 5,
    },
    features: await loadFreeTierFeatures(),
    planRecord: null,
  };
}

/**
 * Single source of truth for per-user plan limits, features, and billing metadata.
 */
export async function getUserPlanLimits(userOrId) {
  const user = userOrId?._id || typeof userOrId === 'object'
    ? userOrId
    : await User.findById(userOrId);
  if (!user) return null;

  const resolved = await resolveActivePlanForUser(user);
  if (!resolved) return null;

  return {
    planCode: resolved.planCode,
    planName: resolved.planName,
    individualPlanCode: user.individualPlanCode || '',
    legacyPlan: resolved.legacyPlan,
    sortOrder: resolved.sortOrder,
    status: planStatusForUser(user),
    expiresAt: user.planExpiresAt || null,
    instructorTrialEndsAt: user.instructorTrialEndsAt || null,
    autoRenew: Boolean(user.autoRenew),
    nextBillingDate: user.nextBillingDate || null,
    lastBillingDate: user.lastBillingDate || null,
    subscriptionStatus: user.subscriptionStatus || '',
    limits: resolved.limits,
    features: resolved.features,
    featureList: buildFeatureList(resolved.features, resolved.planRecord),
    planRecord: resolved.planRecord,
    source: resolved.source,
  };
}

const ACTIVE_SUB_STATUSES = ['active', 'pending', 'payment_pending', 'grace_period'];

/** Normalize plan code for lookups. */
function normCode(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * Resolve the user's current individual catalog plan from DB (not frontend state).
 * Prefers user.individualPlanCode, then active Subscription, then limits resolution.
 */
export async function resolveCurrentIndividualPlan(user, planCatalog = null) {
  if (!user || effectivePlanType(user) === 'free') return null;

  const catalog = planCatalog || await Plan.find({ audience: 'individual', isActive: true })
    .select('code name description pricing limits features featureSettings highlightedFeatures billing isRecommended isActive sortOrder')
    .sort({ sortOrder: 1 })
    .lean();

  let code = normCode(user.individualPlanCode);
  if (!code || code === 'free') {
    const sub = await Subscription.findOne({
      user: user._id,
      status: { $in: ACTIVE_SUB_STATUSES },
    })
      .select('individualPlanCode plan')
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();
    code = normCode(sub?.individualPlanCode);
  }

  if (!code || code === 'free') return null;

  let match = catalog.find((p) => p.code === code);
  if (!match) {
    match = await findIndividualPlanByCode(code, { includeInactive: true });
  }
  return match || null;
}

/**
 * Upgrade targets: strictly higher sortOrder; never current or lower tiers.
 * Free users (no current plan) see all catalog plans with sortOrder >= 0.
 */
export function filterUpgradeEligiblePlans(planCatalog, currentPlan, user) {
  const currentCode = normCode(currentPlan?.code);
  const currentOrder = currentPlan != null
    ? Number(currentPlan.sortOrder ?? 0)
    : (effectivePlanType(user) === 'free' ? -1 : 0);

  return [...(planCatalog || [])]
    .filter((p) => {
      if (!p?.code) return false;
      if (currentCode && normCode(p.code) === currentCode) return false;
      const pOrder = Number(p.sortOrder ?? 0);
      return pOrder > currentOrder;
    })
    .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0));
}

/** Billing page: current plan + upgrade list from authoritative DB resolution. */
export async function resolveBillingPlanContext(user, planCatalog = null) {
  const catalog = planCatalog || await Plan.find({ audience: 'individual', isActive: true })
    .select('code name description pricing limits features featureSettings highlightedFeatures billing isRecommended isActive sortOrder')
    .sort({ sortOrder: 1 })
    .lean();

  const limitsCtx = await getUserPlanLimits(user);
  let currentPlan = await resolveCurrentIndividualPlan(user, catalog);
  if (!currentPlan && limitsCtx?.planRecord) currentPlan = limitsCtx.planRecord;
  if (!currentPlan && limitsCtx?.planCode && limitsCtx.planCode !== 'free') {
    currentPlan = await findIndividualPlanByCode(limitsCtx.planCode, { includeInactive: true });
  }

  const currentSortOrder = currentPlan != null
    ? Number(currentPlan.sortOrder ?? 0)
    : (effectivePlanType(user) === 'free' ? -1 : Number(limitsCtx?.sortOrder ?? 0));

  const upgradeEligiblePlans = filterUpgradeEligiblePlans(catalog, currentPlan, user);

  return {
    currentPlan,
    currentPlanCode: currentPlan?.code || limitsCtx?.planCode || '',
    currentPlanName: currentPlan?.name || limitsCtx?.planName || 'Free',
    currentSortOrder,
    upgradeEligiblePlans,
    limitsCtx,
  };
}

/** AutoPay: resolve plan document for user's active paid tier. */
export async function resolveAutoPayTargetPlan(user, requestedPlanCode = '') {
  const requested = normCode(requestedPlanCode);

  const ctx = await resolveBillingPlanContext(user);
  if (ctx.currentPlan?.pricing?.monthlyPricePaise) {
    if (!requested || requested === normCode(ctx.currentPlan.code)) return ctx.currentPlan;
  }

  if (requested) {
    const explicit = await findIndividualPlanByCode(requested, { includeInactive: false })
      || await findIndividualPlanByCode(requested, { includeInactive: true });
    if (explicit?.pricing?.monthlyPricePaise) return explicit;
  }

  if (ctx.currentPlan?.pricing?.monthlyPricePaise) return ctx.currentPlan;
  if (ctx.limitsCtx?.planRecord?.pricing?.monthlyPricePaise) return ctx.limitsCtx.planRecord;

  const premium = await findIndividualPlanByCode('premium');
  if (premium?.pricing?.monthlyPricePaise) return premium;

  return findRecommendedIndividualPlan();
}
