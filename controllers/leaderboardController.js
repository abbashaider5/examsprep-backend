import User from '../models/User.js';
import { getCache, setCache } from '../services/cacheService.js';

export const getLeaderboard = async (req, res, next) => {
  try {
    const key = 'leaderboard';
    const cached = await getCache(key);
    if (cached) return res.json(cached);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const users = await User.find({ isPublic: true })
      .select('name xp level totalExams streak badges avatar')
      .sort({ xp: -1 })
      .limit(10);

    const payload = { leaderboard: users };
    await setCache(key, payload, 600);
    res.json(payload);
  } catch (err) {
    next(err);
  }
};
