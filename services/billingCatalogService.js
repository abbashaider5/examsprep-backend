import { getSettings } from '../models/SystemSettings.js';
import { PLAN_LIMITS, PLAN_MAX_Q } from '../models/User.js';

/** List reference monthly price (INR paise) — used for “original” / savings UI. */
export const DEFAULT_REFER_PRICE_MONTHLY_PAISE = 99900;

/** Default per-additional-exam credit (INR paise); override in SystemSettings. */
export const DEFAULT_ADDITIONAL_EXAM_CREDIT_PAISE = 9900;

/** Duration tiers: months → discount on total list price (not compound per month). */
export const SUBSCRIPTION_DURATION_TIERS = [
  { months: 1, discountPercent: 0 },
  { months: 3, discountPercent: 60 },
  { months: 6, discountPercent: 80 },
];

/** Organization renewal: custom monthly rate × term, with these discounts on the subtotal. */
export const ENTERPRISE_RENEWAL_DURATION_TIERS = [
  { months: 1, discountPercent: 20, label: '1 month' },
  { months: 3, discountPercent: 30, label: '3 months' },
  { months: 6, discountPercent: 50, label: '6 months' },
];

export function roundPaise(n) {
  return Math.max(100, Math.round(Number(n) || 0));
}

/** Rough cost basis (INR / month) for transparency — tune via settings, not hardcoded in UI. */
export function defaultCostBasisInrMonthly() {
  return {
    aiTokensInr: 220,
    embeddingsInr: 45,
    storageInr: 35,
    infraInr: 120,
    operationsInr: 180,
  };
}

export async function getBillingCatalogFromSettings() {
  const settings = await getSettings();
  const referMonthly = settings.referPriceMonthlyInrPaise || DEFAULT_REFER_PRICE_MONTHLY_PAISE;
  const additionalExamCreditPricePaise = settings.additionalExamCreditPricePaise || DEFAULT_ADDITIONAL_EXAM_CREDIT_PAISE;
  const costBasis = settings.billingCostBasisInrMonthly && typeof settings.billingCostBasisInrMonthly === 'object'
    ? settings.billingCostBasisInrMonthly
    : defaultCostBasisInrMonthly();
  const totalCostBasis = Object.values(costBasis).reduce((a, b) => a + (Number(b) || 0), 0);

  const durations = SUBSCRIPTION_DURATION_TIERS.map((tier) => {
    const listTotal = referMonthly * tier.months;
    const factor = (100 - tier.discountPercent) / 100;
    const payableTotal = roundPaise(listTotal * factor);
    const savings = Math.max(0, listTotal - payableTotal);
    const effectiveMonthlyPaise = roundPaise(payableTotal / tier.months);
    return {
      months: tier.months,
      discountPercent: tier.discountPercent,
      listTotalPaise: listTotal,
      payableTotalPaise: payableTotal,
      savingsPaise: savings,
      effectiveMonthlyPaise,
      label:
        tier.months === 6 ? '6 Months'
          : tier.months === 3 ? '3 Months'
            : '1 Month',
    };
  });

  return {
    referPriceMonthlyPaise: referMonthly,
    additionalExamCreditPricePaise,
    enterpriseRenewalDurations: ENTERPRISE_RENEWAL_DURATION_TIERS.map(({ months, discountPercent, label }) => ({
      months,
      discountPercent,
      label,
    })),
    planExamLimits: {
      free: settings.examsIncludedFree ?? PLAN_LIMITS.free,
      pro: settings.examsIncludedPro ?? PLAN_LIMITS.pro,
      enterprise: settings.examsIncludedEnterprise ?? PLAN_LIMITS.enterprise,
    },
    planMaxQuestions: {
      free: settings.maxQuestionsFree ?? PLAN_MAX_Q.free,
      pro: settings.maxQuestionsPro ?? PLAN_MAX_Q.pro,
      enterprise: settings.maxQuestionsEnterprise ?? PLAN_MAX_Q.enterprise,
    },
    durations,
    costBasisInrMonthly: costBasis,
    totalCostBasisInrMonthly: totalCostBasis,
    billingNotes: settings.billingPublicNotes || '',
  };
}

export function subscriptionPayableForMonths(months, catalog) {
  const row = catalog.durations.find((d) => d.months === months);
  if (!row) return null;
  return row.payableTotalPaise;
}

/** Organization renewal checkout: custom monthly rate × term with enterprise tier discounts. */
export function enterpriseTermTotalPaise(estimatedMonthlyPaise, months) {
  const monthly = Math.round(Number(estimatedMonthlyPaise) || 0);
  if (monthly < 1) return null;
  const row = ENTERPRISE_RENEWAL_DURATION_TIERS.find((d) => d.months === months);
  if (!row) return null;
  const listTotal = monthly * months;
  const factor = (100 - row.discountPercent) / 100;
  return roundPaise(listTotal * factor);
}
