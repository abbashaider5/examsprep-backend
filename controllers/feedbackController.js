import Feedback from '../models/Feedback.js';

export const submitFeedback = async (req, res, next) => {
  try {
    const { rating, message, trigger } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5' });
    }
    const fb = await Feedback.create({
      user: req.user._id,
      rating: Number(rating),
      message: message?.trim() || '',
      trigger: trigger || 'exam_completed',
    });
    res.status(201).json({ feedback: fb });
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
