import HelpTopic from '../models/HelpTopic.js';
import { AppError } from '../middleware/errorHandler.js';
import { parseYoutubeVideoId } from '../utils/youtube.js';

function audienceForRequest(req) {
  const role = req.user?.role;
  if (role === 'admin' || role === 'instructor' || role === 'user') return role;
  return 'user';
}

function serialize(doc, { forAdmin = false, includeAudience = false } = {}) {
  const o = doc.toObject ? doc.toObject() : { ...doc };
  const base = {
    id: o.topicId,
    topicId: o.topicId,
    title: o.title,
    description: o.description,
    category: o.category,
    keywords: o.keywords || [],
    sections: o.sections || [],
    videoUrl: o.videoUrl || '',
    updatedAt: o.updatedAt,
    createdAt: o.createdAt,
  };
  if (forAdmin || includeAudience) base.audience = o.audience;
  return base;
}

/** GET /api/help/topics — list topics visible to the caller's role (admins: all roles) */
export const listHelpTopics = async (req, res, next) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const topics = isAdmin
      ? await HelpTopic.find({})
          .sort({ audience: 1, category: 1, title: 1 })
          .lean()
      : await HelpTopic.find({ audience: audienceForRequest(req) })
          .sort({ category: 1, title: 1 })
          .lean();
    res.json({
      topics: topics.map((t) => serialize(t, { includeAudience: isAdmin })),
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/help/topics/:topicId — single topic if allowed for role (admins: any topic) */
export const getHelpTopic = async (req, res, next) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const topic = isAdmin
      ? await HelpTopic.findOne({ topicId: req.params.topicId }).lean()
      : await HelpTopic.findOne({
          topicId: req.params.topicId,
          audience: audienceForRequest(req),
        }).lean();
    if (!topic) return next(new AppError('Help topic not found', 404));
    res.json({ topic: serialize(topic, { includeAudience: isAdmin }) });
  } catch (err) {
    next(err);
  }
};

// ─── Admin (mounted under /api/admin after protect + requireAdmin) ─────────

export const listHelpTopicsAdmin = async (req, res, next) => {
  try {
    const topics = await HelpTopic.find().sort({ audience: 1, category: 1, title: 1 }).lean();
    res.json({ topics: topics.map((t) => serialize(t, { forAdmin: true })) });
  } catch (err) {
    next(err);
  }
};

const TOPIC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function normalizeBody(body) {
  const {
    topicId,
    title,
    description,
    category,
    keywords,
    sections,
    audience,
    videoUrl,
  } = body;

  if (!topicId || typeof topicId !== 'string' || !TOPIC_ID_RE.test(topicId.trim())) {
    throw new AppError('Invalid topicId (lowercase letters, numbers, hyphens).', 400);
  }
  if (!title?.trim()) throw new AppError('Title is required.', 400);
  if (!description?.trim()) throw new AppError('Description is required.', 400);
  if (!category?.trim()) throw new AppError('Category is required.', 400);
  if (!['user', 'instructor', 'admin'].includes(audience)) {
    throw new AppError('Invalid audience.', 400);
  }
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new AppError('At least one section is required.', 400);
  }

  for (const s of sections) {
    if (!s.heading?.trim()) throw new AppError('Each section needs a heading.', 400);
    const paragraphs = Array.isArray(s.paragraphs) ? s.paragraphs.map(String) : [];
    const bullets = Array.isArray(s.bullets) ? s.bullets.map(String) : [];
    if (!paragraphs.length && !bullets.length) {
      throw new AppError(`Section "${s.heading}" needs paragraphs or bullets.`, 400);
    }
  }

  const kw = Array.isArray(keywords)
    ? keywords.map((k) => String(k).trim()).filter(Boolean)
    : typeof keywords === 'string'
      ? keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean)
      : [];

  let normalizedVideo = '';
  if (videoUrl != null && String(videoUrl).trim() !== '') {
    const raw = String(videoUrl).trim();
    if (!parseYoutubeVideoId(raw)) {
      throw new AppError('Invalid YouTube URL. Paste a youtube.com or youtu.be link.', 400);
    }
    normalizedVideo = raw;
  }

  return {
    topicId: topicId.trim(),
    title: title.trim(),
    description: description.trim(),
    category: category.trim(),
    keywords: kw,
    sections: sections.map((s) => ({
      heading: String(s.heading).trim(),
      paragraphs: Array.isArray(s.paragraphs) ? s.paragraphs.map(String) : [],
      bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : [],
    })),
    audience,
    videoUrl: normalizedVideo,
  };
}

export const createHelpTopic = async (req, res, next) => {
  try {
    const data = normalizeBody(req.body);
    const exists = await HelpTopic.findOne({ topicId: data.topicId });
    if (exists) return next(new AppError('A topic with this ID already exists.', 409));
    const doc = await HelpTopic.create(data);
    res.status(201).json({ topic: serialize(doc, { forAdmin: true }) });
  } catch (err) {
    next(err);
  }
};

export const updateHelpTopic = async (req, res, next) => {
  try {
    const { topicId } = req.params;
    if (!topicId || !TOPIC_ID_RE.test(topicId)) {
      return next(new AppError('Invalid topic id in URL.', 400));
    }
    if (req.body.topicId && String(req.body.topicId).trim() !== topicId) {
      return next(new AppError('Body topicId must match the URL.', 400));
    }
    const data = normalizeBody({ ...req.body, topicId });
    const doc = await HelpTopic.findOneAndUpdate(
      { topicId },
      {
        $set: {
          title: data.title,
          description: data.description,
          category: data.category,
          keywords: data.keywords,
          sections: data.sections,
          audience: data.audience,
          videoUrl: data.videoUrl,
        },
      },
      { new: true, runValidators: true }
    );
    if (!doc) return next(new AppError('Topic not found.', 404));
    res.json({ topic: serialize(doc, { forAdmin: true }) });
  } catch (err) {
    next(err);
  }
};

export const deleteHelpTopic = async (req, res, next) => {
  try {
    const { topicId } = req.params;
    const result = await HelpTopic.deleteOne({ topicId });
    if (result.deletedCount === 0) return next(new AppError('Topic not found.', 404));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};
