import Exam from '../models/Exam.js';
import Group from '../models/Group.js';
import GroupInvite from '../models/GroupInvite.js';
import GroupMessage from '../models/GroupMessage.js';
import User from '../models/User.js';
import { createNotificationsForUsers } from './notificationController.js';
import { uploadGroupMedia } from '../services/cloudinaryService.js';
import { sendGroupInviteEmail } from '../services/emailService.js';
import logger from '../utils/logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const isInstructor = (user) => user.role === 'instructor' || user.role === 'admin';
const isPro       = (user) => ['pro', 'enterprise'].includes(user.plan) || user.role === 'admin';
const CLIENT_URL  = process.env.CLIENT_URL || 'http://localhost:5173';

const assertGroupAccess = async (groupId, user) => {
  const group = await Group.findById(groupId);
  if (!group) return { error: 'Group not found', status: 404 };
  const uid = user._id.toString();
  const isMember = group.members.map(id => id.toString()).includes(uid);
  const isOwner  = group.instructor.toString() === uid;
  const isAdmin  = user.role === 'admin';
  if (!isMember && !isOwner && !isAdmin) return { error: 'Not a member of this group', status: 403 };
  return { group, isOwner: isOwner || isAdmin };
};

// ── Group CRUD ────────────────────────────────────────────────────────────────

export async function createGroup(req, res) {
  try {
    if (!isInstructor(req.user)) return res.status(403).json({ message: 'Instructors only' });
    if (!isPro(req.user)) return res.status(403).json({ message: 'Pro plan required to create groups', code: 'PLAN_REQUIRED' });

    const { name, description, settings } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Group name is required' });

    const group = await Group.create({
      name: name.trim(),
      description: description?.trim() || '',
      instructor: req.user._id,
      settings: {
        allowMedia:  settings?.allowMedia  !== false,
        whoCanSend:  settings?.whoCanSend  || 'all',
        isPrivate:   settings?.isPrivate   || false,
      },
    });
    res.status(201).json({ group });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getMyGroups(req, res) {
  try {
    let groups;
    if (isInstructor(req.user)) {
      groups = await Group.find({ instructor: req.user._id, isActive: true })
        .populate('members', 'name email')
        .populate({ path: 'sharedExams.exam', select: 'title subject difficulty' })
        .sort({ createdAt: -1 })
        .lean();
    } else {
      groups = await Group.find({ members: req.user._id, isActive: true })
        .populate('instructor', 'name email role')
        .populate({ path: 'sharedExams.exam', select: 'title subject difficulty' })
        .sort({ createdAt: -1 })
        .lean();
    }

    // Attach latest message preview + unread count per group
    const withPreview = await Promise.all(groups.map(async (g) => {
      const [lastMsg, msgCount] = await Promise.all([
        GroupMessage.findOne({ group: g._id }).sort({ createdAt: -1 }).populate('sender', 'name').lean(),
        GroupMessage.countDocuments({ group: g._id }),
      ]);
      return { ...g, lastMessage: lastMsg, messageCount: msgCount };
    }));

    res.json({ groups: withPreview });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getGroup(req, res) {
  try {
    const { group, error, status } = await assertGroupAccess(req.params.id, req.user);
    if (error) return res.status(status).json({ message: error });

    const populated = await Group.findById(group._id)
      .populate('instructor', 'name email role')
      .populate('members', 'name email role')
      .populate({ path: 'sharedExams.exam', select: 'title subject difficulty questions passingPercentage allowReattempt expiryDate' })
      .lean();

    // Attach pending invites count
    const pendingCount = await GroupInvite.countDocuments({ group: group._id, status: 'pending' });
    res.json({ group: { ...populated, pendingInviteCount: pendingCount } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function updateGroup(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }
    const { name, description } = req.body;
    if (name?.trim()) group.name = name.trim();
    if (description !== undefined) group.description = description.trim();
    group.sharedExams = group.sharedExams.filter(se => se.exam != null);
    await group.save();
    res.json({ group });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function updateGroupSettings(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }
    const { allowMedia, whoCanSend, isPrivate, allowReactions, allowReplies, maxMembers, muteNotifications } = req.body;
    if (allowMedia         !== undefined) group.settings.allowMedia         = !!allowMedia;
    if (whoCanSend         !== undefined) group.settings.whoCanSend         = whoCanSend;
    if (isPrivate          !== undefined) group.settings.isPrivate          = !!isPrivate;
    if (allowReactions     !== undefined) group.settings.allowReactions     = !!allowReactions;
    if (allowReplies       !== undefined) group.settings.allowReplies       = !!allowReplies;
    if (maxMembers         !== undefined) group.settings.maxMembers         = Number(maxMembers) || 100;
    if (muteNotifications  !== undefined) group.settings.muteNotifications  = !!muteNotifications;
    group.sharedExams = group.sharedExams.filter(se => se.exam != null);
    await group.save();
    res.json({ group });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function deleteGroup(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }
    group.isActive = false;
    await group.save();
    res.json({ message: 'Group deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── Invite flow ───────────────────────────────────────────────────────────────

export async function inviteMember(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });
    const normalised = email.toLowerCase().trim();

    // Already a member?
    const existing = await User.findOne({ email: normalised });
    if (existing && group.members.map(id => id.toString()).includes(existing._id.toString())) {
      return res.status(400).json({ message: 'This user is already a member' });
    }

    // Already has a pending invite?
    const existingInvite = await GroupInvite.findOne({ group: group._id, email: normalised, status: 'pending' });
    if (existingInvite && existingInvite.expiresAt > new Date()) {
      return res.status(400).json({ message: 'A pending invite already exists for this email' });
    }

    // Create invite
    const invite = await GroupInvite.create({
      group: group._id,
      email: normalised,
      invitedBy: req.user._id,
    });

    const acceptUrl = `${CLIENT_URL}/groups/invite/${invite.token}`;
    const expiresStr = invite.expiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

    sendGroupInviteEmail({
      email: normalised,
      instructorName: req.user.name,
      groupName: group.name,
      acceptUrl,
      expiresAt: expiresStr,
    }).catch(logger.error);

    res.status(201).json({ message: 'Invite sent', invite: { email: normalised, status: 'pending' } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getGroupInvites(req, res) {
  try {
    const group = await Group.findById(req.params.id).lean();
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }
    const invites = await GroupInvite.find({ group: req.params.id })
      .populate('invitedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ invites });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getMyGroupInvites(req, res) {
  try {
    const invites = await GroupInvite.find({
      email: req.user.email,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    })
      .populate({ path: 'group', select: 'name description instructor', populate: { path: 'instructor', select: 'name email' } })
      .populate('invitedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ invites });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function validateGroupInvite(req, res) {
  try {
    const invite = await GroupInvite.findOne({ token: req.params.token })
      .populate({ path: 'group', select: 'name description instructor', populate: { path: 'instructor', select: 'name email' } })
      .populate('invitedBy', 'name')
      .lean();
    if (!invite) return res.status(404).json({ message: 'Invalid invite link' });
    if (invite.expiresAt < new Date()) return res.status(410).json({ message: 'Invite has expired' });
    if (invite.status !== 'pending') return res.status(400).json({ message: `Invite already ${invite.status}` });
    res.json({ invite });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function acceptGroupInvite(req, res) {
  try {
    const invite = await GroupInvite.findOne({ token: req.params.token });
    if (!invite) return res.status(404).json({ message: 'Invalid invite link' });
    if (invite.expiresAt < new Date()) {
      invite.status = 'declined';
      await invite.save();
      return res.status(410).json({ message: 'Invite has expired' });
    }
    if (invite.status !== 'pending') {
      return res.status(400).json({ message: `Invite already ${invite.status}` });
    }
    // Email must match the logged-in user
    if (invite.email !== req.user.email.toLowerCase()) {
      return res.status(403).json({ message: 'This invite was sent to a different email address' });
    }

    invite.status = 'accepted';
    await invite.save();

    const group = await Group.findById(invite.group);
    if (group && !group.members.map(id => id.toString()).includes(req.user._id.toString())) {
      group.members.push(req.user._id);
      await group.save();
    }

    // Post a system message
    await GroupMessage.create({
      group: invite.group,
      sender: req.user._id,
      type: 'system',
      text: `${req.user.name} joined the group`,
    });

    res.json({ message: 'Welcome to the group!', groupId: invite.group });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function declineGroupInvite(req, res) {
  try {
    const invite = await GroupInvite.findOne({ token: req.params.token });
    if (!invite) return res.status(404).json({ message: 'Invalid invite link' });
    if (invite.email !== req.user.email.toLowerCase()) {
      return res.status(403).json({ message: 'This invite was sent to a different email address' });
    }
    invite.status = 'declined';
    await invite.save();
    res.json({ message: 'Invite declined' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function cancelInvite(req, res) {
  try {
    const invite = await GroupInvite.findById(req.params.inviteId);
    if (!invite) return res.status(404).json({ message: 'Invite not found' });
    const group = await Group.findById(invite.group);
    if (group?.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }
    await invite.deleteOne();
    res.json({ message: 'Invite cancelled' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function removeMember(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }
    group.members = group.members.filter(m => m.toString() !== req.params.userId);
    await group.save();
    res.json({ message: 'Member removed' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function leaveGroup(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    group.members = group.members.filter(m => m.toString() !== req.user._id.toString());
    await group.save();

    await GroupMessage.create({
      group: group._id, sender: req.user._id, type: 'system',
      text: `${req.user.name} left the group`,
    });

    res.json({ message: 'You left the group' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── Shared Exams ──────────────────────────────────────────────────────────────

export async function shareExam(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }
    const { examId } = req.body;
    if (!examId) return res.status(400).json({ message: 'examId is required' });
    const exam = await Exam.findById(examId);
    if (!exam) return res.status(404).json({ message: 'Exam not found' });

    // Purge any invalid entries before touching sharedExams
    group.sharedExams = group.sharedExams.filter(se => se.exam != null);

    if (!group.sharedExams.some(se => se.exam?.toString() === examId.toString())) {
      group.sharedExams.push({ exam: examId });
      await group.save();
    }

    await GroupMessage.create({
      group: group._id, sender: req.user._id,
      type: 'exam_share', examRef: examId, text: `Shared exam: ${exam.title}`,
    });

    // Notify all group members — link directly to the exam
    if (group.members?.length) {
      await createNotificationsForUsers(group.members, {
        type:    'exam_shared',
        title:   `New Test in ${group.name}`,
        message: `"${exam.title}" has been shared by your instructor.`,
        link:    `/exam/${exam._id}`,
        meta:    { groupId: group._id, examId: exam._id },
      });
    }

    res.json({ message: 'Exam shared with group' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function unshareExam(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }
    group.sharedExams = group.sharedExams.filter(se => se.exam.toString() !== req.params.examId);
    await group.save();
    res.json({ message: 'Exam removed from group' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export async function getMessages(req, res) {
  try {
    const { group, error, status } = await assertGroupAccess(req.params.id, req.user);
    if (error) return res.status(status).json({ message: error });

    const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before;
    const filter = { group: req.params.id };
    if (before) filter.createdAt = { $lt: new Date(before) };

    const messages = await GroupMessage.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('sender', 'name email role')
      .populate({ path: 'replyTo', populate: { path: 'sender', select: 'name' } })
      .populate('examRef', 'title subject difficulty')
      .lean();

    messages.reverse();
    const hasMore = messages.length === limit;
    res.json({ messages, hasMore });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function sendMessage(req, res) {
  try {
    const { group, error, status, isOwner } = await assertGroupAccess(req.params.id, req.user);
    if (error) return res.status(status).json({ message: error });

    // Enforce whoCanSend setting
    if (group.settings.whoCanSend === 'instructorOnly' && !isOwner) {
      return res.status(403).json({ message: 'Only the instructor can send messages in this group' });
    }

    const { text, replyTo, mediaBase64, mediaType, fileName, fileSize } = req.body;
    if (!text?.trim() && !mediaBase64) return res.status(400).json({ message: 'Message or media required' });

    let mediaUrl = null;
    let resolvedMediaType = null;
    let resolvedFileName = null;

    if (mediaBase64) {
      // Check if media is allowed
      if (!group.settings.allowMedia && !isOwner) {
        return res.status(403).json({ message: 'Media sharing is disabled for this group' });
      }
      // Upload to Cloudinary
      const uploaded = await uploadGroupMedia(mediaBase64, fileName || 'file');
      if (uploaded) {
        mediaUrl         = uploaded.url;
        resolvedMediaType = mediaType || (uploaded.resourceType === 'image' ? 'image' : 'document');
        resolvedFileName  = fileName || 'file';
      } else {
        // Fallback: store base64 inline if Cloudinary not configured (capped at 2MB)
        if (mediaBase64.length < 2 * 1024 * 1024 * 1.37) {
          mediaUrl         = mediaBase64;
          resolvedMediaType = mediaType || 'image';
          resolvedFileName  = fileName  || 'file';
        } else {
          return res.status(400).json({ message: 'Media upload failed and file is too large for inline storage' });
        }
      }
    }

    const msg = await GroupMessage.create({
      group:     req.params.id,
      sender:    req.user._id,
      text:      text?.trim() || null,
      replyTo:   replyTo || null,
      type:      mediaBase64 ? 'media' : 'text',
      mediaUrl,
      mediaType: resolvedMediaType,
      fileName:  resolvedFileName,
      fileSize:  fileSize || null,
    });

    const populated = await GroupMessage.findById(msg._id)
      .populate('sender', 'name email role')
      .populate({ path: 'replyTo', populate: { path: 'sender', select: 'name' } })
      .lean();

    res.status(201).json({ message: populated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function deleteMessage(req, res) {
  try {
    const msg = await GroupMessage.findById(req.params.msgId);
    if (!msg) return res.status(404).json({ message: 'Message not found' });
    const uid = req.user._id.toString();
    // Only the original sender (or admin) can delete — not even group owner
    if (msg.sender.toString() !== uid && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'You can only delete your own messages' });
    }
    await msg.deleteOne();
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function editMessage(req, res) {
  try {
    const { id, msgId } = req.params;
    const { text } = req.body;
    const { error, status } = await assertGroupAccess(id, req.user);
    if (error) return res.status(status).json({ message: error });

    const msg = await GroupMessage.findById(msgId);
    if (!msg) return res.status(404).json({ message: 'Message not found' });
    if (msg.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only edit your own messages' });
    }
    if (msg.type !== 'text') return res.status(400).json({ message: 'Only text messages can be edited' });
    if (!text?.trim()) return res.status(400).json({ message: 'Message text required' });

    msg.text = text.trim();
    msg.edited = true;
    await msg.save();
    res.json({ message: 'Message updated' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── Bulk Invite Members (CSV/Email list) ──────────────────────────────────────

export async function bulkInviteMembers(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }

    const { emails } = req.body; // array of email strings from client
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ message: 'No emails provided' });
    }

    const results = { sent: [], skipped: [], failed: [] };

    for (const rawEmail of emails) {
      const email = rawEmail.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        results.skipped.push({ email, reason: 'invalid format' });
        continue;
      }

      // Check if already a member
      const existing = await User.findOne({ email });
      if (existing) {
        const alreadyMember = group.members.map(id => id.toString()).includes(existing._id.toString());
        if (alreadyMember) {
          results.skipped.push({ email, reason: 'already a member' });
          continue;
        }
      }

      // Check for existing pending invite
      const existingInvite = await GroupInvite.findOne({ group: group._id, email, status: 'pending' });
      if (existingInvite) {
        results.skipped.push({ email, reason: 'invite already pending' });
        continue;
      }

      try {
        const invite  = await GroupInvite.create({
          group:     group._id,
          email,
          invitedBy: req.user._id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        const inviteUrl = `${CLIENT_URL}/groups/invite/${invite.token}`;
        await sendGroupInviteEmail({ to: email, groupName: group.name, invitedByName: req.user.name, inviteUrl }).catch(() => {});
        results.sent.push(email);
      } catch (err) {
        results.failed.push({ email, reason: err.message });
      }
    }

    res.json({
      message: `${results.sent.length} invite(s) sent`,
      results,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export async function adminGetAll(req, res) {
  try {
    const groups = await Group.find()
      .populate('instructor', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    const withCounts = await Promise.all(groups.map(async g => {
      const msgCount = await GroupMessage.countDocuments({ group: g._id });
      return { ...g, memberCount: g.members.length, msgCount };
    }));

    res.json({ groups: withCounts });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function adminDeleteGroup(req, res) {
  try {
    await GroupMessage.deleteMany({ group: req.params.id });
    await GroupInvite.deleteMany({ group: req.params.id });
    await Group.findByIdAndDelete(req.params.id);
    res.json({ message: 'Group and all data deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
