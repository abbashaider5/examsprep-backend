/**
 * Subscription/plan facade — use this module from controllers and jobs.
 * Limits and features resolve through the Plan catalog + user assignment.
 */
export {
  getUserPlanLimits,
  resolveActivePlanForUser,
  resolveCurrentIndividualPlan,
  resolveBillingPlanContext,
  resolveAutoPayTargetPlan,
  filterUpgradeEligiblePlans,
  buildFeatureList,
  FEATURE_LABELS,
  effectivePlanType,
  effectivePlanTypeWithEnterprise,
} from './userPlanLimitsService.js';

export {
  computeExamUsageSnapshot,
  computeExamUsageSnapshotWithEnterprise,
  consumeExamGenerationSlots,
  getMaxQuestionsForUser,
  canUseProctoringForUser,
  hasActivePersonalPaidPlan,
  hasActivePaidPlanForCredits,
  ensureUserSubscriptionLifecycle,
} from './subscriptionUsageService.js';
