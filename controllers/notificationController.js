import Notification from '../models/Notification.js';

// ── Get my notifications ──────────────────────────────────────────────────────
export async function getMyNotifications(req, res) {
  try {
    const notifications = await Notification.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ notifications });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── Mark one as read ──────────────────────────────────────────────────────────
export async function markRead(req, res) {
  try {
    await Notification.updateOne({ _id: req.params.id, user: req.user._id }, { isRead: true });
    res.json({ message: 'Marked as read' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── Mark all as read ──────────────────────────────────────────────────────────
export async function markAllRead(req, res) {
  try {
    await Notification.updateMany({ user: req.user._id, isRead: false }, { isRead: true });
    res.json({ message: 'All marked as read' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── Delete one notification ───────────────────────────────────────────────────
export async function deleteNotification(req, res) {
  try {
    await Notification.deleteOne({ _id: req.params.id, user: req.user._id });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── Helper: create notifications for multiple users ───────────────────────────
export async function createNotificationsForUsers(userIds, payload) {
  if (!userIds?.length) return;
  const docs = userIds.map(uid => ({ user: uid, ...payload }));
  await Notification.insertMany(docs, { ordered: false }).catch(() => {});
}
