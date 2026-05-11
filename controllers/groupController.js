import Exam from '../models/Exam.js';
import Group from '../models/Group.js';
import GroupInvite from '../models/GroupInvite.js';
import GroupChatModeration from '../models/GroupChatModeration.js';
import GroupMessage from '../models/GroupMessage.js';
import ChatModerationLog from '../models/ChatModerationLog.js';
import User from '../models/User.js';
import { createNotificationsForUsers } from './notificationController.js';
import { uploadGroupMedia } from '../services/cloudinaryService.js';
import { sendGroupInviteEmail } from '../services/emailService.js';
import { delCache, getCache, setCache } from '../services/cacheService.js';
import { detectAbusiveContent } from '../utils/chatModeration.js';
import logger from '../utils/logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const isInstructor = (user) => user.role === 'instructor' || user.role === 'admin';
const isPro       = (user) => ['pro', 'enterprise'].includes(user.plan) || user.role === 'admin';
const CLIENT_URL  = process.env.CLIENT_URL || 'http://localhost:5173';
const WARNING_LIMIT = 3;
const MODERATION_REPLACEMENT_TEXT = '⚠ Message removed due to inappropriate language.';
const CHAT_BLOCKED_TEXT = '🚫 Your chat access has been blocked due to repeated inappropriate language.';

const assertGroupAccess = async (groupId, user) => {
  const group = await Group.findById(groupId);
  if (!group) return { error: 'Group not found', status: 404 };
  const uid = user._id.toString();
  const isMember = group.members.map(id => id.toString()).includes(uid);
  const isOwner  = group.instructor.toString() === uid;
  const isAdmin  = user.role === 'admin';
  if (
    !isAdmin && user.enterpriseId && group.enterpriseId
    && user.enterpriseId.toString() !== group.enterpriseId.toString()
  ) {
    return { error: 'Not a member of this group', status: 403 };
  }
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
      enterpriseId: req.user.enterpriseId || null,
      settings: {
        allowMedia:  settings?.allowMedia  !== false,
        whoCanSend:  settings?.whoCanSend  || 'all',
        isPrivate:   settings?.isPrivate   || false,
      },
    });
    await delCache(`groups:${req.user._id}`);
    res.status(201).json({ group });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getMyGroups(req, res) {
  try {
    const key = `groups:${req.user._id}`;
    const cached = await getCache(key);
    if (cached) return res.json(cached);

    let groups;
    if (isInstructor(req.user)) {
      const ownerQ = { instructor: req.user._id, isActive: true };
      if (req.user.enterpriseId) {
        ownerQ.enterpriseId = req.user.enterpriseId;
      } else {
        ownerQ.$or = [{ enterpriseId: null }, { enterpriseId: { $exists: false } }];
      }
      groups = await Group.find(ownerQ)
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

    const payload = { groups: withPreview };
    await setCache(key, payload, 300);
    res.json(payload);
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
    await delCache(`groups:${req.user._id}`);
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
    await delCache(`groups:${req.user._id}`);
    res.json({ group });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function deleteGroup(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.kind === 'school_class') {
      return res.status(400).json({
        message: 'School class chats cannot be deleted from here. They stay with the class.',
      });
    }
    if (group.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }
    group.isActive = false;
    await group.save();
    await delCache(`groups:${req.user._id}`);
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
    if (group.kind === 'school_class') {
      return res.status(400).json({
        message: 'Class chat membership follows school enrollment. Add students from the Students page.',
      });
    }
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

    if (existing) {
      createNotificationsForUsers([existing._id], {
        type: 'group_invite',
        title: `Batch invitation: ${group.name}`,
        message: `${req.user.name} invited you to join the batch "${group.name}". Review it from your dashboard or batches page.`,
        link: '/dashboard',
        meta: { groupId: group._id, inviteId: invite._id },
      }).catch(logger.error);
    }

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

    // In-app notification for the joined user
    createNotificationsForUsers([req.user._id], {
      type: 'batch_joined',
      title: `You joined "${group?.name || 'a batch'}"`,
      message: `Welcome! You are now a member of the batch "${group?.name || ''}". Check the Batches page to view shared tests.`,
      link: '/batches',
      meta: { groupId: invite.group },
    }).catch(logger.error);

    // Notify the instructor that a new member joined
    if (group?.instructor) {
      createNotificationsForUsers([group.instructor], {
        type: 'batch_joined',
        title: `New member in "${group.name}"`,
        message: `${req.user.name} (${req.user.email}) has joined your batch "${group.name}".`,
        link: '/batches',
        meta: { groupId: group._id, userId: req.user._id },
      }).catch(logger.error);
    }

    await delCache(`groups:${req.user._id}`, ...(group?.instructor ? [`groups:${group.instructor}`] : []));

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
    if (group.kind === 'school_class') {
      return res.status(400).json({ message: 'Manage class roster from the school Students page, not from chat.' });
    }
    if (group.instructor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not your group' });
    }
    const removedUserId = req.params.userId;
    group.members = group.members.filter(m => m.toString() !== removedUserId);
    await group.save();
    await delCache(`groups:${req.user._id}`, `groups:${removedUserId}`);
    res.json({ message: 'Member removed' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function leaveGroup(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.kind === 'school_class') {
      return res.status(400).json({
        message: 'You cannot leave a class chat here. Membership follows your class enrollment.',
      });
    }
    group.members = group.members.filter(m => m.toString() !== req.user._id.toString());
    await group.save();

    await GroupMessage.create({
      group: group._id, sender: req.user._id, type: 'system',
      text: `${req.user.name} left the group`,
    });

    await delCache(`groups:${req.user._id}`);
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

    await delCache(`groups:${req.user._id}`);
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
    await delCache(`groups:${req.user._id}`);
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
    const [hasMore, moderation] = await Promise.all([
      messages.length === limit,
      GroupChatModeration.findOne({ group: req.params.id, user: req.user._id }).lean(),
    ]);

    res.json({
      messages,
      hasMore,
      moderation: {
        warningCount: moderation?.warningCount || 0,
        isBlocked: !!moderation?.isBlocked,
        blockMessage: moderation?.isBlocked ? CHAT_BLOCKED_TEXT : null,
      },
    });
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

    const moderationState = await GroupChatModeration.findOne({ group: req.params.id, user: req.user._id });
    if (moderationState?.isBlocked) {
      await ChatModerationLog.create({
        group: req.params.id,
        user: req.user._id,
        originalMessage: text?.trim() || '[media-only message]',
        normalizedMessage: '',
        detectedContent: [],
        warningCount: moderationState.warningCount || WARNING_LIMIT,
        action: 'blocked_message_attempt',
      });
      return res.status(403).json({
        message: CHAT_BLOCKED_TEXT,
        code: 'CHAT_BLOCKED',
        moderation: {
          warningCount: moderationState.warningCount || WARNING_LIMIT,
          isBlocked: true,
        },
      });
    }

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

    const hasText = !!text?.trim();
    const detection = hasText ? detectAbusiveContent(text.trim()) : { isAbusive: false, normalized: '', detected: [] };

    let msg;
    let moderationPayload = { warningCount: 0, isBlocked: false, warningMessage: null, blockedMessage: null };

    if (detection.isAbusive) {
      const state = moderationState || await GroupChatModeration.create({ group: req.params.id, user: req.user._id });
      state.warningCount = Math.min((state.warningCount || 0) + 1, WARNING_LIMIT);
      state.lastViolationAt = new Date();
      state.lastViolationMessage = text.trim();
      state.isBlocked = state.warningCount >= WARNING_LIMIT;
      state.blockedAt = state.isBlocked ? new Date() : null;
      await state.save();

      await ChatModerationLog.create({
        group: req.params.id,
        user: req.user._id,
        originalMessage: text.trim(),
        normalizedMessage: detection.normalized,
        detectedContent: detection.detected,
        warningCount: state.warningCount,
        action: state.isBlocked ? 'blocked' : 'warned',
      });

      msg = await GroupMessage.create({
        group: req.params.id,
        sender: req.user._id,
        text: MODERATION_REPLACEMENT_TEXT,
        replyTo: replyTo || null,
        type: 'text',
      });

      moderationPayload = {
        warningCount: state.warningCount,
        isBlocked: state.isBlocked,
        warningMessage: state.isBlocked ? null : `Warning ${state.warningCount}/${WARNING_LIMIT}`,
        blockedMessage: state.isBlocked ? CHAT_BLOCKED_TEXT : null,
      };
    } else {
      msg = await GroupMessage.create({
        group: req.params.id,
        sender: req.user._id,
        text: text?.trim() || null,
        replyTo: replyTo || null,
        type: mediaBase64 ? 'media' : 'text',
        mediaUrl,
        mediaType: resolvedMediaType,
        fileName: resolvedFileName,
        fileSize: fileSize || null,
      });
    }

    const populated = await GroupMessage.findById(msg._id)
      .populate('sender', 'name email role')
      .populate({ path: 'replyTo', populate: { path: 'sender', select: 'name' } })
      .lean();

    res.status(201).json({ message: populated, moderation: moderationPayload });
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

    const moderationState = await GroupChatModeration.findOne({ group: id, user: req.user._id });
    if (moderationState?.isBlocked) {
      return res.status(403).json({ message: CHAT_BLOCKED_TEXT, code: 'CHAT_BLOCKED' });
    }

    const detection = detectAbusiveContent(text.trim());
    if (detection.isAbusive) {
      const state = moderationState || await GroupChatModeration.create({ group: id, user: req.user._id });
      state.warningCount = Math.min((state.warningCount || 0) + 1, WARNING_LIMIT);
      state.lastViolationAt = new Date();
      state.lastViolationMessage = text.trim();
      state.isBlocked = state.warningCount >= WARNING_LIMIT;
      state.blockedAt = state.isBlocked ? new Date() : null;
      await state.save();

      await ChatModerationLog.create({
        group: id,
        user: req.user._id,
        originalMessage: text.trim(),
        normalizedMessage: detection.normalized,
        detectedContent: detection.detected,
        warningCount: state.warningCount,
        action: state.isBlocked ? 'blocked' : 'warned',
      });

      msg.text = MODERATION_REPLACEMENT_TEXT;
      msg.edited = true;
      await msg.save();
      return res.json({
        message: state.isBlocked ? CHAT_BLOCKED_TEXT : `Warning ${state.warningCount}/${WARNING_LIMIT}`,
        moderation: {
          warningCount: state.warningCount,
          isBlocked: state.isBlocked,
        },
      });
    }

    msg.text = text.trim();
    msg.edited = true;
    await msg.save();
    res.json({ message: 'Message updated' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getChatModerationStatus(req, res) {
  try {
    const { group, error, status, isOwner } = await assertGroupAccess(req.params.id, req.user);
    if (error) return res.status(status).json({ message: error });
    if (!isOwner) return res.status(403).json({ message: 'Only instructor can view moderation data' });

    const records = await GroupChatModeration.find({ group: group._id, $or: [{ warningCount: { $gt: 0 } }, { isBlocked: true }] })
      .populate('user', 'name email role')
      .sort({ isBlocked: -1, warningCount: -1, updatedAt: -1 })
      .lean();

    res.json({
      users: records.map((r) => ({
        user: r.user,
        warningCount: r.warningCount || 0,
        isBlocked: !!r.isBlocked,
        blockedAt: r.blockedAt || null,
        lastViolationAt: r.lastViolationAt || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function unlockChatUser(req, res) {
  try {
    const { group, error, status, isOwner } = await assertGroupAccess(req.params.id, req.user);
    if (error) return res.status(status).json({ message: error });
    if (!isOwner) return res.status(403).json({ message: 'Only instructor can unlock users' });

    const target = await GroupChatModeration.findOne({ group: group._id, user: req.params.userId });
    if (!target) return res.status(404).json({ message: 'No moderation record found for this user' });

    target.warningCount = 0;
    target.isBlocked = false;
    target.blockedAt = null;
    target.blockedBy = req.user._id;
    await target.save();

    await ChatModerationLog.create({
      group: group._id,
      user: req.params.userId,
      originalMessage: 'Unlock action by instructor',
      normalizedMessage: 'unlock action by instructor',
      detectedContent: [],
      warningCount: 0,
      action: 'unlocked_by_instructor',
      triggeredBy: req.user._id,
    });

    res.json({ message: 'Chat access restored for user' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── Bulk Invite Members (CSV/Email list) ──────────────────────────────────────

export async function bulkInviteMembers(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (group.kind === 'school_class') {
      return res.status(400).json({
        message: 'Use school student enrollment to add members to a class chat.',
      });
    }
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
        try {
          await sendGroupInviteEmail({ to: email, groupName: group.name, invitedByName: req.user.name, inviteUrl });
          if (existing) {
            createNotificationsForUsers([existing._id], {
              type: 'group_invite',
              title: `Batch invitation: ${group.name}`,
              message: `${req.user.name} invited you to join the batch "${group.name}". Review it from your dashboard or batches page.`,
              link: '/dashboard',
              meta: { groupId: group._id, inviteId: invite._id },
            }).catch(logger.error);
          }
          results.sent.push(email);
        } catch (emailErr) {
          logger.error(`Failed to send group invite email to ${email}:`, emailErr.message);
          results.failed.push({ email, reason: `Email delivery failed: ${emailErr.message}` });
        }
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
