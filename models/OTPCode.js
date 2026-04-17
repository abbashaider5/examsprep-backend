import crypto from 'crypto';
import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  otp: { type: String, required: true },
  purpose: { type: String, enum: ['login', 'signup', 'password_reset'], default: 'login' },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  used: { type: Boolean, default: false },
}, { timestamps: true });

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

otpSchema.statics.generate = async function (email, purpose = 'login') {
  await this.deleteMany({ email, purpose });
  const otp = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
  return this.create({ email, otp, purpose, expiresAt });
};

otpSchema.statics.verify = async function (email, otp, purpose = 'login') {
  const record = await this.findOne({ email, purpose, used: false });
  if (!record) return { valid: false, reason: 'OTP not found or expired' };
  if (record.expiresAt < new Date()) {
    await record.deleteOne();
    return { valid: false, reason: 'OTP has expired. Request a new one.' };
  }
  if (record.attempts >= 3) {
    await record.deleteOne();
    return { valid: false, reason: 'Too many attempts. Request a new OTP.' };
  }
  if (record.otp !== otp) {
    record.attempts += 1;
    await record.save();
    return { valid: false, reason: `Incorrect OTP. ${3 - record.attempts} attempt(s) left.` };
  }
  record.used = true;
  await record.deleteOne();
  return { valid: true };
};

export default mongoose.model('OTPCode', otpSchema);
