import SystemSettings, { getSettings } from '../models/SystemSettings.js';
import { fromReq, log } from '../utils/activityLogger.js';

export const getSystemSettings = async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.json({ settings });
  } catch (err) { next(err); }
};

export const updateSystemSettings = async (req, res, next) => {
  try {
    const allowedKeys = [
      'maintenanceMode', 'maintenanceMessage', 'allowNewRegistrations', 'platformName',
      'twoFactorAuthEnabled', 'twoFactorRequired', 'maxLoginAttempts', 'lockoutDurationMinutes', 'sessionTimeoutMinutes',
      'maxExamsPerDay', 'maxQuestionsPerExam', 'minQuestionsPerExam', 'allowedDifficulties',
      'emailWelcomeEnabled', 'emailResultEnabled', 'emailCertificateEnabled',
      'emailSecurityAlertEnabled', 'emailProctoringViolationEnabled', 'emailOtpEnabled',
      'emailInstructorInviteEnabled', 'emailPlanUpgradeEnabled', 'emailPlanDowngradeEnabled',
      'proctoringEnabled', 'certificatesEnabled', 'leaderboardEnabled', 'studyModeEnabled', 'gamificationEnabled',
      'certShowQRCode', 'certShowProctoredBadge', 'certShowInstructorName',
      'certPrimaryColor', 'certAccentColor', 'certOrganizationName', 'certFooterText',
      'planPricePro', 'planPriceEnterprise',
    ];

    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowedKeys.includes(k)));
    updates.updatedBy = req.user._id;

    const settings = await SystemSettings.findOneAndUpdate(
      { key: 'global' },
      { $set: updates },
      { new: true, upsert: true }
    );

    await log({ user: req.user, action: 'admin_settings_updated', category: 'admin', metadata: { keys: Object.keys(updates) }, ...fromReq(req) });
    res.json({ settings, message: 'Settings updated' });
  } catch (err) { next(err); }
};

export const getPublicSettings = async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.json({
      maintenanceMode: settings.maintenanceMode,
      maintenanceMessage: settings.maintenanceMessage,
      allowNewRegistrations: settings.allowNewRegistrations,
      twoFactorAuthEnabled: settings.twoFactorAuthEnabled,
      twoFactorRequired: settings.twoFactorRequired,
      proctoringEnabled: settings.proctoringEnabled,
      studyModeEnabled: settings.studyModeEnabled,
      leaderboardEnabled: settings.leaderboardEnabled,
    });
  } catch (err) { next(err); }
};
