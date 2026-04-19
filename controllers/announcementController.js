import Announcement from '../models/Announcement.js';
import UserAnnouncementState from '../models/UserAnnouncementState.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const notExpired = () => ({
  $or: [
    { expiresAt: null },
    { expiresAt: { $exists: false } },
    { expiresAt: { $gt: new Date() } },
  ],
});

// ── User-facing endpoints ─────────────────────────────────────────────────────

/**
 * GET /api/announcements
 * Returns active, non-expired announcements targeted at the current user's plan.
 * Each announcement is enriched with the user's read/dismiss state.
 */
export const getAnnouncements = async (req, res, next) => {
  try {
    const userId  = req.user._id;
    const plan    = req.user.plan || 'free';

    const announcements = await Announcement.find({
      isActive: true,
      $and: [
        notExpired(),
        { $or: [{ targetAudience: 'all' }, { targetAudience: plan }] },
      ],
    }).sort({ createdAt: -1 });

    if (!announcements.length) return res.json({ announcements: [] });

    // Fetch this user's states in one round-trip
    const ids    = announcements.map(a => a._id);
    const states = await UserAnnouncementState.find({
      user: userId,
      announcement: { $in: ids },
    }).lean();

    const stateMap = {};
    states.forEach(s => { stateMap[s.announcement.toString()] = s; });

    const result = announcements
      .filter(a => !stateMap[a._id.toString()]?.isDismissed)
      .map(a => {
        const s = stateMap[a._id.toString()];
        return {
          ...a.toObject(),
          isRead:      s?.isRead      || false,
          isDismissed: s?.isDismissed || false,
        };
      });

    res.json({ announcements: result });
  } catch (err) { next(err); }
};

/**
 * POST /api/announcements/:id/read
 * Marks a single announcement as read for the current user.
 */
export const markRead = async (req, res, next) => {
  try {
    await UserAnnouncementState.findOneAndUpdate(
      { user: req.user._id, announcement: req.params.id },
      { $set: { isRead: true, readAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) { next(err); }
};

/**
 * POST /api/announcements/:id/dismiss
 * Dismisses an announcement permanently for the current user.
 */
export const dismiss = async (req, res, next) => {
  try {
    await UserAnnouncementState.findOneAndUpdate(
      { user: req.user._id, announcement: req.params.id },
      {
        $set: {
          isDismissed: true, dismissedAt: new Date(),
          isRead: true,      readAt: new Date(),
        },
      },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── Admin endpoints ───────────────────────────────────────────────────────────

/**
 * GET /api/announcements/admin
 * Returns all announcements (active or not) for the admin dashboard.
 */
export const adminGetAll = async (req, res, next) => {
  try {
    const announcements = await Announcement.find()
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    // Enrich each announcement with read/dismiss counts
    const ids = announcements.map(a => a._id);
    const [readCounts, dismissCounts] = await Promise.all([
      UserAnnouncementState.aggregate([
        { $match: { announcement: { $in: ids }, isRead: true } },
        { $group: { _id: '$announcement', count: { $sum: 1 } } },
      ]),
      UserAnnouncementState.aggregate([
        { $match: { announcement: { $in: ids }, isDismissed: true } },
        { $group: { _id: '$announcement', count: { $sum: 1 } } },
      ]),
    ]);

    const readMap    = Object.fromEntries(readCounts.map(r => [r._id.toString(), r.count]));
    const dismissMap = Object.fromEntries(dismissCounts.map(r => [r._id.toString(), r.count]));

    const enriched = announcements.map(a => ({
      ...a.toObject(),
      stats: {
        readCount:    readMap[a._id.toString()]    || 0,
        dismissCount: dismissMap[a._id.toString()] || 0,
      },
    }));

    res.json({ announcements: enriched });
  } catch (err) { next(err); }
};

/**
 * POST /api/announcements/admin
 * Creates a new announcement.
 */
export const adminCreate = async (req, res, next) => {
  try {
    const { title, message, type, targetAudience, isActive, expiresAt } = req.body;
    const a = await Announcement.create({
      title,
      message,
      type:           type           || 'info',
      targetAudience: targetAudience || 'all',
      isActive:       isActive !== undefined ? isActive : true,
      expiresAt:      expiresAt || null,
      createdBy:      req.user._id,
    });
    res.status(201).json({ announcement: a });
  } catch (err) { next(err); }
};

/**
 * PUT /api/announcements/admin/:id
 * Updates an existing announcement.
 */
export const adminUpdate = async (req, res, next) => {
  try {
    const { title, message, type, targetAudience, isActive, expiresAt } = req.body;
    const a = await Announcement.findByIdAndUpdate(
      req.params.id,
      { title, message, type, targetAudience, isActive, expiresAt: expiresAt || null },
      { new: true, runValidators: true }
    );
    if (!a) return res.status(404).json({ message: 'Announcement not found' });
    res.json({ announcement: a });
  } catch (err) { next(err); }
};

/**
 * DELETE /api/announcements/admin/:id
 * Deletes an announcement and all user states for it.
 */
export const adminDelete = async (req, res, next) => {
  try {
    await Promise.all([
      Announcement.findByIdAndDelete(req.params.id),
      UserAnnouncementState.deleteMany({ announcement: req.params.id }),
    ]);
    res.json({ success: true });
  } catch (err) { next(err); }
};

/**
 * PATCH /api/announcements/admin/:id/toggle
 * Toggles the isActive state.
 */
export const adminToggle = async (req, res, next) => {
  try {
    const a = await Announcement.findById(req.params.id);
    if (!a) return res.status(404).json({ message: 'Announcement not found' });
    a.isActive = !a.isActive;
    await a.save();
    res.json({ announcement: a });
  } catch (err) { next(err); }
};
