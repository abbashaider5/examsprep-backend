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
  planPricePro:        { type: Number, default: 14900 },
  planPriceEnterprise: { type: Number, default: 34900 },

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const SystemSettings = mongoose.model('SystemSettings', systemSettingsSchema);

export const getSettings = async () => {
  let settings = await SystemSettings.findOne({ key: 'global' });
  if (!settings) settings = await SystemSettings.create({ key: 'global' });
  return settings;
};

export default SystemSettings;
