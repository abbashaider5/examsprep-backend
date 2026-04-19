import Feedback from '../models/Feedback.js';

const DAILY_LIMIT = 2;
const TOTAL_LIMIT = 10;

export const submitFeedback = async (req, res, next) => {
  try {
    const { rating, ratings, message, trigger } = req.body;

    // Compute overall rating — either direct or averaged from sub-ratings
    let overallRating = rating ? Number(rating) : null;
    if (ratings && (ratings.ui || ratings.performance || ratings.features)) {
      const vals = [ratings.ui, ratings.performance, ratings.features].filter(Boolean).map(Number);
      overallRating = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
    if (!overallRating || overallRating < 1 || overallRating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5' });
    }

    const userId = req.user._id;

    // ── Total limit ──────────────────────────────────────────────────────────
    const totalCount = await Feedback.countDocuments({ user: userId });
    if (totalCount >= TOTAL_LIMIT) {
      return res.status(429).json({
        message: `You've reached the maximum of ${TOTAL_LIMIT} feedback submissions. Thank you for your continued support!`,
        code: 'TOTAL_LIMIT_REACHED',
      });
    }

    // ── Daily limit ──────────────────────────────────────────────────────────
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCount = await Feedback.countDocuments({
      user: userId,
      createdAt: { $gte: startOfDay },
    });
    if (todayCount >= DAILY_LIMIT) {
      return res.status(429).json({
        message: `You've already submitted ${DAILY_LIMIT} feedbacks today. Come back tomorrow!`,
        code: 'DAILY_LIMIT_REACHED',
      });
    }

    const fb = await Feedback.create({
      user: userId,
      rating: overallRating,
      ratings: ratings ? {
        ui:          ratings.ui ? Number(ratings.ui) : undefined,
        performance: ratings.performance ? Number(ratings.performance) : undefined,
        features:    ratings.features ? Number(ratings.features) : undefined,
      } : undefined,
      message: message?.trim() || '',
      trigger: trigger || 'general',
    });

    res.status(201).json({
      feedback: fb,
      remaining: {
        today: DAILY_LIMIT - todayCount - 1,
        total: TOTAL_LIMIT - totalCount - 1,
      },
    });
  } catch (err) { next(err); }
};

export const getFeedbackLimits = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [totalCount, todayCount] = await Promise.all([
      Feedback.countDocuments({ user: userId }),
      Feedback.countDocuments({ user: userId, createdAt: { $gte: startOfDay } }),
    ]);

    res.json({
      canSubmit: totalCount < TOTAL_LIMIT && todayCount < DAILY_LIMIT,
      todayUsed: todayCount,
      todayLimit: DAILY_LIMIT,
      totalUsed: totalCount,
      totalLimit: TOTAL_LIMIT,
    });
  } catch (err) { next(err); }
};

export const getFeedback = async (req, res, next) => {
  try {
    const feedback = await Feedback.find()
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(200);

    // ── Overall distribution & average ────────────────────────────────────────
    const ratingsAgg = await Feedback.aggregate([
      { $group: { _id: '$rating', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const distribution = [0, 0, 0, 0, 0];
    let sum = 0;
    ratingsAgg.forEach(r => {
      distribution[r._id - 1] = r.count;
      sum += r._id * r.count;
    });
    const total = feedback.length;
    const avg = total > 0 ? (sum / total).toFixed(1) : '0.0';

    // ── Per-category averages ─────────────────────────────────────────────────
    const categoryAgg = await Feedback.aggregate([
      { $match: { 'ratings': { $exists: true } } },
      {
        $group: {
          _id: null,
          avgUi:          { $avg: '$ratings.ui' },
          avgPerformance: { $avg: '$ratings.performance' },
          avgFeatures:    { $avg: '$ratings.features' },
          countWithRatings: { $sum: 1 },
        },
      },
    ]);
    const catData = categoryAgg[0] || {};
    const categoryAvg = {
      ui:          catData.avgUi          ? Number(catData.avgUi.toFixed(1))          : null,
      performance: catData.avgPerformance ? Number(catData.avgPerformance.toFixed(1)) : null,
      features:    catData.avgFeatures    ? Number(catData.avgFeatures.toFixed(1))    : null,
      count:       catData.countWithRatings || 0,
    };

    // ── Submissions trend — last 30 days ──────────────────────────────────────
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const trendAgg = await Feedback.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
          avgRating: { $avg: '$rating' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // ── Reply rate ────────────────────────────────────────────────────────────
    const repliedCount = feedback.filter(f => f.adminReply).length;

    res.json({
      feedback,
      stats: {
        avg,
        total,
        distribution,
        categoryAvg,
        trend: trendAgg.map(t => ({ date: t._id, count: t.count, avgRating: Number(t.avgRating.toFixed(1)) })),
        repliedCount,
      },
    });
  } catch (err) { next(err); }
};

export const replyToFeedback = async (req, res, next) => {
  try {
    const fb = await Feedback.findByIdAndUpdate(
      req.params.id,
      { adminReply: req.body.reply?.trim(), repliedAt: new Date() },
      { new: true }
    ).populate('user', 'name email');
    if (!fb) return res.status(404).json({ message: 'Feedback not found' });
    res.json({ feedback: fb });
  } catch (err) { next(err); }
};
