import { AppError } from '../middleware/errorHandler.js';
import Result from '../models/Result.js';
import User from '../models/User.js';
import { generateRecommendation } from '../services/aiService.js';

export const getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.userId || req.user._id).select('-password');
    if (!user) return next(new AppError('User not found', 404));
    if (!user.isPublic && user._id.toString() !== req.user?._id?.toString()) {
      return next(new AppError('Profile is private', 403));
    }
    res.json({ user });
  } catch (err) {
    next(err);
  }
};

export const updateProfile = async (req, res, next) => {
  try {
    const allowed = ['name', 'avatar', 'isPublic'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true }).select('-password');
    res.json({ user });
  } catch (err) {
    next(err);
  }
};

export const getAnalytics = async (req, res, next) => {
  try {
    const results = await Result.find({ user: req.user._id })
      .populate('exam', 'title subject difficulty topics')
      .sort({ createdAt: -1 })
      .limit(20);

    const trend = results.slice().reverse().map(r => ({
      date: r.createdAt,
      percentage: r.percentage,
      subject: r.exam?.subject,
    }));

    const topicMap = {};
    results.forEach(r => {
      if (r.topicAccuracy) {
        for (const [t, acc] of r.topicAccuracy) {
          if (!topicMap[t]) topicMap[t] = [];
          topicMap[t].push(acc);
        }
      }
    });
    const topicPerf = Object.fromEntries(
      Object.entries(topicMap).map(([t, vals]) => [t, Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)])
    );

    res.json({ trend, topicPerf, totalExams: req.user.totalExams, streak: req.user.streak });
  } catch (err) {
    next(err);
  }
};

export const getRecommendation = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const recent = await Result.find({ user: user._id }).sort({ createdAt: -1 }).limit(5);
    const recentScores = recent.map(r => r.percentage);
    const subject = recent[0]?.exam ? (await recent[0].populate('exam')).exam?.subject : 'General';

    let rec = null;
    try { rec = await generateRecommendation({ weakTopics: user.weakTopics, recentScores, subject }); } catch (_) { /* AI unavailable */ }
    res.json({ recommendation: rec });
  } catch (err) {
    next(err);
  }
};

export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return next(new AppError('Current and new password required', 400));
    if (newPassword.length < 6) return next(new AppError('New password must be at least 6 characters', 400));

    const user = await User.findById(req.user._id).select('+password');
    const valid = await user.comparePassword(currentPassword);
    if (!valid) return next(new AppError('Current password is incorrect', 401));

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (err) { next(err); }
};
