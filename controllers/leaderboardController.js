import User from '../models/User.js';

export const getLeaderboard = async (req, res, next) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const users = await User.find({ isPublic: true })
      .select('name xp level totalExams streak badges avatar')
      .sort({ xp: -1 })
      .limit(10);

    res.json({ leaderboard: users });
  } catch (err) {
    next(err);
  }
};
