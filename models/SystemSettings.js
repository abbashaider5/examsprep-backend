import mongoose from 'mongoose';

const systemSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'global', unique: true },

  // Platform
  maintenanceMode: { type: Boolean, default: false },
  maintenanceMessage: { type: String, default: 'We are performing scheduled maintenance. Back shortly!' },
  platformName: { type: String, default: 'ExamPrep AI' },
  allowNewRegistrations: { type: Boolean, default: true },

  // Auth & Security
  twoFactorAuthEnabled: { type: Boolean, default: false },
  twoFactorRequired: { type: Boolean, default: false },
  recaptchaLoginSignupEnabled: { type: Boolean, default: false },
  maxLoginAttempts: { type: Number, default: 5 },
  lockoutDurationMinutes: { type: Number, default: 30 },
  sessionTimeoutMinutes: { type: Number, default: 15 },

  // Exam limits
  maxExamsPerDay: { type: Number, default: 5 },
  maxQuestionsPerExam: { type: Number, default: 30 },
  minQuestionsPerExam: { type: Number, default: 5 },
  allowedDifficulties: { type: [String], default: ['easy', 'medium', 'hard'] },

  // Email notifications
  emailWelcomeEnabled: { type: Boolean, default: true },
  emailResultEnabled: { type: Boolean, default: true },
  emailCertificateEnabled: { type: Boolean, default: true },
  emailSecurityAlertEnabled: { type: Boolean, default: true },
  emailProctoringViolationEnabled: { type: Boolean, default: true },
  emailOtpEnabled: { type: Boolean, default: true },
  emailInstructorInviteEnabled: { type: Boolean, default: true },
  emailPlanUpgradeEnabled: { type: Boolean, default: true },
  emailPlanDowngradeEnabled: { type: Boolean, default: true },

  // Features
  proctoringEnabled: { type: Boolean, default: true },
  certificatesEnabled: { type: Boolean, default: true },
  leaderboardEnabled: { type: Boolean, default: true },
  studyModeEnabled: { type: Boolean, default: true },
  gamificationEnabled: { type: Boolean, default: true },

  // Certificate Design
  certShowQRCode: { type: Boolean, default: true },
  certShowProctoredBadge: { type: Boolean, default: true },
  certShowInstructorName: { type: Boolean, default: true },
  certPrimaryColor: { type: String, default: '#0366AC' },
  certAccentColor: { type: String, default: '#E3BE2C' },
  certOrganizationName: { type: String, default: 'ExamPrep AI' },
  certFooterText: { type: String, default: '' },

  // Plan Pricing (in paise)
  planPricePro: { type: Number, default: 14900 },
  planPriceEnterprise: { type: Number, default: 199900 },
  /** Marketing reference “list” price per month (INR paise), e.g. ₹999 — used for savings UI. */
  referPriceMonthlyInrPaise: { type: Number, default: 99900 },
  /** Add-on AI exam credits (INR paise each); change without deploy. */
  additionalExamCreditPricePaise: { type: Number, default: 9900 },
  /** Included AI exams / calendar month by tier (override hardcoded defaults). */
  examsIncludedFree: { type: Number, default: 3 },
  examsIncludedPro: { type: Number, default: 20 },
  examsIncludedEnterprise: { type: Number, default: 30 },
  maxQuestionsFree: { type: Number, default: 20 },
  maxQuestionsPro: { type: Number, default: 50 },
  maxQuestionsEnterprise: { type: Number, default: 100 },
  /** Optional JSON map of rough monthly cost drivers (INR, not paise) for transparency in pricing API. */
  billingCostBasisInrMonthly: { type: mongoose.Schema.Types.Mixed, default: null },
  billingPublicNotes: { type: String, default: '' },

  // Enterprise pricing configuration (in paise)
  enterpriseCostPerTeacher: { type: Number, default: 2000 },
  enterpriseCostPerExam: { type: Number, default: 300 },
  enterpriseCostPerQuestion: { type: Number, default: 20 },
  enterpriseCostAiProctoring: { type: Number, default: 5000 },

  // AutoPay / recurring billing
  autopayGraceDays: { type: Number, default: 7 },
  razorpayAutopayPlanIdProMonthly: { type: String, default: '' },
  razorpayAutopayPlanAmountProMonthly: { type: Number, default: 0 },
  razorpayAutopayPlanCurrencyProMonthly: { type: String, default: 'INR' },
  razorpayAutopayPlanIdEnterpriseMonthly: { type: String, default: '' },
  razorpayAutopayPlanAmountEnterpriseMonthly: { type: Number, default: 0 },
  razorpayAutopayPlanCurrencyEnterpriseMonthly: { type: String, default: 'INR' },

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const SystemSettings = mongoose.model('SystemSettings', systemSettingsSchema);

export const getSettings = async () => {
  let settings = await SystemSettings.findOne({ key: 'global' });
  if (!settings) settings = await SystemSettings.create({ key: 'global' });
  return settings;
};

export default SystemSettings;
