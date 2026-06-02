import { AppError } from '../middleware/errorHandler.js';
import Plan from '../models/Plan.js';
import User from '../models/User.js';

function normalizeCode(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export const listAdminPlans = async (req, res, next) => {
  try {
    const plans = await Plan.find({ audience: 'individual' }).sort({ sortOrder: 1, isRecommended: -1, createdAt: -1 });
    res.json({ plans });
  } catch (err) { next(err); }
};

export const listPublicPlans = async (req, res, next) => {
  try {
    let plans = await Plan.find({ audience: 'individual', isActive: true }).sort({ sortOrder: 1, isRecommended: -1, createdAt: -1 });
    if (!plans.length) {
      const seed = await Plan.create({
        code: 'premium',
        name: 'Premium',
        description: 'Default premium plan',
        audience: 'individual',
        isRecommended: true,
        isActive: true,
        sortOrder: 100,
        pricing: { monthlyPricePaise: 99900 },
      });
      plans = [seed];
    }
    res.json({ plans });
  } catch (err) { next(err); }
};

export const createPlan = async (req, res, next) => {
  try {
    const code = normalizeCode(req.body?.code || req.body?.name);
    if (!code) return next(new AppError('Plan code is required.', 400));
    if (!req.body?.name) return next(new AppError('Plan name is required.', 400));
    const exists = await Plan.findOne({ code });
    if (exists) return next(new AppError('Plan code already exists.', 409));
    if (req.body?.isRecommended) {
      await Plan.updateMany({ audience: 'individual', isRecommended: true }, { $set: { isRecommended: false } });
    }
    let sortOrder = Number(req.body?.sortOrder);
    if (!Number.isFinite(sortOrder)) {
      const top = await Plan.findOne({ audience: 'individual' }).sort({ sortOrder: -1 }).select('sortOrder').lean();
      sortOrder = Number(top?.sortOrder ?? 0) + 10;
    }
    const plan = await Plan.create({
      code,
      name: String(req.body.name).trim(),
      description: req.body.description || '',
      pricing: req.body.pricing || {},
      limits: req.body.limits || {},
      features: req.body.features || {},
      featureSettings: req.body.featureSettings || {},
      highlightedFeatures: Array.isArray(req.body.highlightedFeatures) ? req.body.highlightedFeatures : [],
      billing: req.body.billing || {},
      sortOrder,
      isRecommended: Boolean(req.body.isRecommended),
      isActive: req.body.isActive !== false,
      audience: 'individual',
    });
    res.status(201).json({ plan });
  } catch (err) { next(err); }
};

export const updatePlan = async (req, res, next) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) return next(new AppError('Plan not found.', 404));
    if (req.body?.name) plan.name = String(req.body.name).trim();
    if (typeof req.body?.description === 'string') plan.description = req.body.description;
    if (req.body?.pricing) plan.pricing = { ...plan.pricing.toObject(), ...req.body.pricing };
    if (req.body?.limits) plan.limits = { ...plan.limits.toObject(), ...req.body.limits };
    if (req.body?.features) plan.features = { ...plan.features.toObject(), ...req.body.features };
    if (req.body?.featureSettings) plan.featureSettings = { ...(plan.featureSettings || {}), ...req.body.featureSettings };
    if (Array.isArray(req.body?.highlightedFeatures)) plan.highlightedFeatures = req.body.highlightedFeatures;
    if (req.body?.billing) plan.billing = { ...plan.billing.toObject(), ...req.body.billing };
    if (req.body?.sortOrder != null && Number.isFinite(Number(req.body.sortOrder))) plan.sortOrder = Number(req.body.sortOrder);
    if (typeof req.body?.isActive === 'boolean') plan.isActive = req.body.isActive;
    if (typeof req.body?.isRecommended === 'boolean') {
      if (req.body.isRecommended) {
        await Plan.updateMany({ audience: 'individual', isRecommended: true, _id: { $ne: plan._id } }, { $set: { isRecommended: false } });
      }
      plan.isRecommended = req.body.isRecommended;
    }
    await plan.save();
    res.json({ plan });
  } catch (err) { next(err); }
};

export const deletePlan = async (req, res, next) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) return next(new AppError('Plan not found.', 404));
    const assigned = await User.countDocuments({ individualPlanCode: plan.code });
    if (assigned > 0) {
      return next(new AppError('Cannot delete a plan assigned to active users.', 409));
    }
    await plan.deleteOne();
    res.json({ success: true });
  } catch (err) { next(err); }
};
