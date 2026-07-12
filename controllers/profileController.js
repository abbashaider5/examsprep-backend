import { AppError } from '../middleware/errorHandler.js';
import Result from '../models/Result.js';
import Resource from '../models/Resource.js';
import User from '../models/User.js';
import { generateRecommendation } from '../services/aiService.js';
import { uploadProfileImage } from '../services/cloudinaryService.js';

const RESOURCE_LIBRARY = [
  {
    keywords: ['react', 'hooks', 'context', 'redux', 'component', 'state'],
    items: [
      { type: 'article', title: 'React official docs', url: 'https://react.dev/learn' },
      { type: 'video', title: 'Net Ninja React playlist', url: 'https://www.youtube.com/results?search_query=net+ninja+react+tutorial' },
      { type: 'practice', title: 'React practice questions', url: 'https://www.youtube.com/results?search_query=react+interview+questions+practice' },
    ],
  },
  {
    keywords: ['javascript', 'js', 'array', 'promise', 'async', 'closure'],
    items: [
      { type: 'article', title: 'MDN JavaScript Guide', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide' },
      { type: 'video', title: 'JavaScript concepts videos', url: 'https://www.youtube.com/results?search_query=javascript+concepts+tutorial' },
      { type: 'practice', title: 'JavaScript exercises', url: 'https://javascript.info/' },
    ],
  },
  {
    keywords: ['python', 'loop', 'function', 'oop', 'list', 'dictionary'],
    items: [
      { type: 'article', title: 'Python official tutorial', url: 'https://docs.python.org/3/tutorial/' },
      { type: 'video', title: 'Python topic tutorials', url: 'https://www.youtube.com/results?search_query=python+programming+tutorial' },
      { type: 'practice', title: 'Python practice exercises', url: 'https://www.hackerrank.com/domains/python' },
    ],
  },
  {
    keywords: ['sql', 'database', 'join', 'query', 'normalization'],
    items: [
      { type: 'article', title: 'SQLBolt lessons', url: 'https://sqlbolt.com/' },
      { type: 'video', title: 'SQL tutorials', url: 'https://www.youtube.com/results?search_query=sql+joins+tutorial' },
      { type: 'practice', title: 'SQL practice set', url: 'https://leetcode.com/problemset/database/' },
    ],
  },
  {
    keywords: ['dsa', 'algorithm', 'data structure', 'tree', 'graph', 'dp'],
    items: [
      { type: 'article', title: 'GeeksforGeeks DSA overview', url: 'https://www.geeksforgeeks.org/data-structures/' },
      { type: 'video', title: 'DSA problem solving videos', url: 'https://www.youtube.com/results?search_query=data+structures+and+algorithms+tutorial' },
      { type: 'practice', title: 'LeetCode practice', url: 'https://leetcode.com/problemset/' },
    ],
  },
];

const normalizeTopic = (value = '') => value.trim().toLowerCase();

const buildWeakTopicResources = async (topics = []) => {
  const normalizedTopics = [...new Set(topics.map(normalizeTopic).filter(Boolean))].slice(0, 5);
  if (!normalizedTopics.length) return [];

  const adminResources = await Resource.find({ scope: 'admin' })
    .select('title originalName cloudinaryUrl')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  return normalizedTopics.map((topic) => {
    const preset = RESOURCE_LIBRARY.find(entry => entry.keywords.some(keyword => topic.includes(keyword)));
    const curated = preset?.items || [
      { type: 'article', title: `Read about ${topic}`, url: `https://www.google.com/search?q=${encodeURIComponent(`${topic} tutorial`)}` },
      { type: 'video', title: `Watch a ${topic} lesson`, url: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${topic} tutorial`)}` },
      { type: 'practice', title: `Practice ${topic}`, url: `https://www.google.com/search?q=${encodeURIComponent(`${topic} practice questions`)}` },
    ];

    const internal = adminResources
      .filter(resource => `${resource.title} ${resource.originalName}`.toLowerCase().includes(topic))
      .slice(0, 2)
      .map(resource => ({
        type: 'resource',
        title: resource.title,
        url: resource.cloudinaryUrl,
      }));

    return { topic, items: [...internal, ...curated].slice(0, 4) };
  });
};

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
    const allowed = ['name', 'avatar', 'isPublic', 'twoFactorEnabled', 'schoolName', 'address', 'autoRenew', 'aboutMe'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

    // Enterprise principals and enterprise-linked instructors inherit organization details from Enterprise.
    // They cannot edit schoolName/address from the profile page.
    if ((req.user.role === 'principal') || (req.user.role === 'instructor' && req.user.enterpriseId)) {
      delete updates.schoolName;
      delete updates.address;
    }

    if (updates.aboutMe !== undefined) {
      if (!['instructor', 'admin'].includes(req.user.role)) {
        delete updates.aboutMe;
      } else {
        updates.aboutMe = String(updates.aboutMe || '').trim().slice(0, 1000);
      }
    }

    if (updates.name !== undefined && !String(updates.name).trim()) {
      return next(new AppError('Name cannot be empty.', 400));
    }
    if (updates.schoolName !== undefined) {
      updates.schoolName = String(updates.schoolName || '').trim();
    }
    if (updates.address && typeof updates.address === 'object') {
      const address = {
        country: String(updates.address.country || '').trim(),
        state: String(updates.address.state || '').trim(),
        city: String(updates.address.city || '').trim(),
        zipCode: String(updates.address.zipCode || '').trim(),
      };
      if (address.zipCode && !/^[A-Za-z0-9\- ]{3,20}$/.test(address.zipCode)) {
        return next(new AppError('Please enter a valid zip/postal code.', 400));
      }
      updates.address = address;
    }

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true }).select('-password');
    res.json({ user });
  } catch (err) {
    next(err);
  }
};

export const uploadAvatar = async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('Profile image is required.', 400));
    const url = await uploadProfileImage(req.file.buffer, req.file.mimetype, req.file.originalname);
    if (!url) return next(new AppError('Failed to upload profile image. Please try again.', 503));
    const user = await User.findByIdAndUpdate(req.user._id, { avatar: url }, { new: true }).select('-password');
    res.json({ message: 'Profile image updated.', user, avatar: url });
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
    const weakTopics = [...new Set([...(user.weakTopics || []), rec?.topic].filter(Boolean))].slice(0, 5);
    const resources = await buildWeakTopicResources(weakTopics);
    res.json({ recommendation: rec, weakTopics, resources });
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
