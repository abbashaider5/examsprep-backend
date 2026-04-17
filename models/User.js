import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

export const PLAN_LIMITS = { free: 3, pro: 10, enterprise: 30 };
export const PLAN_MAX_Q  = { free: 20, pro: 50, enterprise: 100 };

const badgeSchema = new mongoose.Schema({
  name: String,
  icon: String,
  awardedAt: { type: Date, default: Date.now },
});

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6, select: false },
  role: { type: String, enum: ['user', 'instructor', 'admin'], default: 'user' },
  avatar: { type: String, default: '' },

  // Subscription / plan
  plan: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
  planExpiresAt: { type: Date, default: null },
  examsCreatedThisMonth: { type: Number, default: 0 },
  monthlyExamResetDate: { type: Date, default: null },

  // Gamification
  xp: { type: Number, default: 0 },
  level: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced', 'Expert'], default: 'Beginner' },
  streak: { type: Number, default: 0 },
  lastExamDate: Date,
  badges: [badgeSchema],
  weakTopics: [String],
  totalExams: { type: Number, default: 0 },
  totalScore: { type: Number, default: 0 },
  isPublic: { type: Boolean, default: true },

  // Legacy daily counter (kept for migration safety)
  examCreationsToday: { type: Number, default: 0 },
  lastExamCreationDate: Date,

  // Security
  failedLoginAttempts: { type: Number, default: 0 },
  accountLockedUntil: Date,
  isBlocked: { type: Boolean, default: false },

  refreshToken: { type: String, select: false },
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.updateLevel = function () {
  if (this.xp >= 5000) this.level = 'Expert';
  else if (this.xp >= 2000) this.level = 'Advanced';
  else if (this.xp >= 500) this.level = 'Intermediate';
  else this.level = 'Beginner';
};

/** Returns the currently active plan (falls back to 'free' if expired) */
userSchema.methods.getEffectivePlan = function () {
  if (this.plan === 'free') return 'free';
  if (this.planExpiresAt && this.planExpiresAt < new Date()) return 'free';
  return this.plan;
};

/** Resets monthly exam counter if the calendar month changed */
userSchema.methods._syncMonthly = function () {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${now.getMonth()}`;
  const lastMonth = this.monthlyExamResetDate
    ? `${this.monthlyExamResetDate.getFullYear()}-${this.monthlyExamResetDate.getMonth()}`
    : null;
  if (lastMonth !== thisMonth) {
    this.examsCreatedThisMonth = 0;
    this.monthlyExamResetDate = now;
  }
};

userSchema.methods.canCreateExam = function () {
  this._syncMonthly();
  const limit = PLAN_LIMITS[this.getEffectivePlan()] || 3;
  return this.examsCreatedThisMonth < limit;
};

userSchema.methods.getRemainingExams = function () {
  this._syncMonthly();
  const limit = PLAN_LIMITS[this.getEffectivePlan()] || 3;
  return Math.max(0, limit - (this.examsCreatedThisMonth || 0));
};

userSchema.methods.getMonthlyLimit = function () {
  return PLAN_LIMITS[this.getEffectivePlan()] || 3;
};

userSchema.methods.getMaxQuestions = function () {
  return PLAN_MAX_Q[this.getEffectivePlan()] || 10;
};

userSchema.methods.canUseProctoring = function () {
  return ['pro', 'enterprise'].includes(this.getEffectivePlan());
};

userSchema.methods.isAccountLocked = function () {
  if (this.accountLockedUntil && this.accountLockedUntil > new Date()) return true;
  return false;
};

userSchema.methods.recordFailedLogin = async function () {
  this.failedLoginAttempts += 1;
  if (this.failedLoginAttempts >= 5) {
    this.accountLockedUntil = new Date(Date.now() + 30 * 60 * 1000);
    this.failedLoginAttempts = 0;
  }
  await this.save({ validateBeforeSave: false });
};

userSchema.methods.resetFailedLogins = async function () {
  this.failedLoginAttempts = 0;
  this.accountLockedUntil = undefined;
  await this.save({ validateBeforeSave: false });
};

userSchema.virtual('isInstructor').get(function() {
  return this.role === 'instructor' || this.role === 'admin';
});

userSchema.virtual('planStatus').get(function() {
  if (this.plan === 'free') return 'free';
  if (this.planExpiresAt && this.planExpiresAt < new Date()) return 'expired';
  return 'active';
});

export default mongoose.model('User', userSchema);
