import Group from '../models/Group.js';
import SchoolClass from '../models/SchoolClass.js';
import SchoolClassEnrollment from '../models/SchoolClassEnrollment.js';
import User from '../models/User.js';
import { delCache, getCache, setCache } from './cacheService.js';

const INFRA_CACHE_PREFIX = 'schoolChatInf:';
const INFRA_TTL_SEC = 60 * 60 * 24 * 365;

function classDisplayName(cls) {
  const parts = [cls.name, cls.section].filter(Boolean);
  return parts.join(' · ');
}

/** Keep shadow chat group title in sync when class name/section changes. */
export async function syncSchoolClassChatGroupTitle(cls) {
  if (!cls?.chatGroup || !cls?.teacher) return;
  const label = classDisplayName(cls);
  const name = `Class: ${label}`.slice(0, 80);
  await Group.findByIdAndUpdate(cls.chatGroup, { $set: { name } });
  await delCache(`groups:${cls.teacher}`);
}

/**
 * Ensure a dedicated Group exists for this school class (batch-chat compatible).
 */
export async function ensureSchoolClassChatGroup(cls) {
  if (!cls?.teacher) {
    throw new Error('Class has no assigned teacher');
  }
  if (cls.chatGroup) {
    const existing = await Group.findById(cls.chatGroup);
    if (existing && existing.isActive !== false) {
      if (existing.instructor.toString() !== cls.teacher.toString()) {
        existing.instructor = cls.teacher;
        await existing.save();
      }
      return existing;
    }
    await SchoolClass.findByIdAndUpdate(cls._id, { $unset: { chatGroup: 1 } });
  }

  const label = classDisplayName(cls);
  const group = await Group.create({
    kind: 'school_class',
    schoolClass: cls._id,
    name: `Class: ${label}`.slice(0, 80),
    description: 'Class discussion',
    instructor: cls.teacher,
    enterpriseId: cls.enterprise,
    members: [],
    isActive: true,
    settings: {
      allowMedia: true,
      whoCanSend: 'all',
      isPrivate: true,
      allowReactions: true,
      allowReplies: true,
      maxMembers: 500,
      muteNotifications: false,
    },
  });

  await SchoolClass.findByIdAndUpdate(cls._id, { chatGroup: group._id });
  await delCache(`groups:${cls.teacher}`);
  return group;
}

async function syncGroupMembersFromRoster(schoolClassId, enterpriseId) {
  const cls = await SchoolClass.findById(schoolClassId).lean();
  if (!cls?.chatGroup) return;

  const enrolled = await SchoolClassEnrollment.distinct('user', { schoolClass: schoolClassId });
  const legacy = await User.find({
    enterpriseId,
    role: 'user',
    schoolClassId,
  }).distinct('_id');

  const ids = [...new Set([...enrolled.map(String), ...legacy.map(String)])]
    .filter(Boolean)
    .map((id) => id);

  if (!ids.length) {
    await Group.findByIdAndUpdate(cls.chatGroup, { $set: { members: [] } });
    return;
  }

  await Group.findByIdAndUpdate(cls.chatGroup, { $set: { members: ids } });

  for (const uid of ids) {
    await delCache(`groups:${uid}`);
  }
  await delCache(`groups:${cls.teacher}`);
}

/**
 * Upsert enrollment, add user to class chat group, bust caches.
 */
export async function enrollUserInSchoolClass(user, clsId, enterpriseId) {
  const cls = await SchoolClass.findById(clsId);
  if (!cls) throw new Error('Class not found');

  await SchoolClassEnrollment.findOneAndUpdate(
    { schoolClass: cls._id, user: user._id },
    { $setOnInsert: { enterprise: enterpriseId } },
    { upsert: true, new: true },
  );

  await ensureSchoolClassChatGroup(cls);
  await syncGroupMembersFromRoster(cls._id, enterpriseId);
}

/**
 * One-time (cached) migration: legacy User.schoolClassId + enrollments → group members.
 */
export async function ensureSchoolChatInfrastructure(enterpriseId) {
  const cacheKey = `${INFRA_CACHE_PREFIX}${enterpriseId}`;
  const done = await getCache(cacheKey);
  if (done) return;

  const classes = await SchoolClass.find({ enterprise: enterpriseId }).lean();
  for (const c of classes) {
    try {
      if (c.teacher) await ensureSchoolClassChatGroup(c);
    } catch {
      /* class may lack teacher in bad data */
    }
  }

  const users = await User.find({
    enterpriseId,
    role: 'user',
    schoolClassId: { $ne: null },
  })
    .select('_id schoolClassId')
    .lean();

  const bulk = users
    .filter((u) => u.schoolClassId)
    .map((u) => ({
      updateOne: {
        filter: { schoolClass: u.schoolClassId, user: u._id },
        update: { $setOnInsert: { enterprise: enterpriseId, schoolClass: u.schoolClassId, user: u._id } },
        upsert: true,
      },
    }));

  if (bulk.length) {
    await SchoolClassEnrollment.bulkWrite(bulk, { ordered: false });
  }

  for (const c of classes) {
    await syncGroupMembersFromRoster(c._id, enterpriseId);
  }

  await setCache(cacheKey, { ok: true }, INFRA_TTL_SEC);
}

export async function userHasSchoolClassAccess(user, schoolClassDoc) {
  if (!user?._id || !schoolClassDoc?._id) return false;
  const cid = schoolClassDoc._id.toString();

  if (schoolClassDoc.teacher?.toString?.() === user._id.toString()) return true;

  const enrolled = await SchoolClassEnrollment.exists({ schoolClass: schoolClassDoc._id, user: user._id });
  if (enrolled) return true;

  if (
    user.schoolClassId?.toString() === cid
    && user.enterpriseId?.toString() === schoolClassDoc.enterprise?.toString()
  ) {
    return true;
  }
  return false;
}

export async function assertTeacherOwnsClass(user, schoolClassDoc) {
  if (!schoolClassDoc?.teacher) return false;
  return schoolClassDoc.teacher.toString() === user._id.toString() || user.role === 'admin';
}
