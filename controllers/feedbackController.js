import Feedback from '../models/Feedback.js';

const DAILY_LIMIT = 2;
const TOTAL_LIMIT = 10;

export const submitFeedback = async (req, res, next) => {
  try {
    const { rating, message, trigger } = req.body;
    if (!rating || rating < 1 || rating > 5) {
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
      rating: Number(rating),
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

    res.json({ feedback, stats: { avg, total, distribution } });
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
