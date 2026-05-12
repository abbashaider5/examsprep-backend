import { isCloudinaryConfigured, uploadAuthenticatedExamAudio } from './cloudinaryService.js';
import { synthesizeExamNarration, isCambAiTtsConfigured } from './tts/ttsService.js';
import { voiceMetaFromAccent } from '../utils/listeningVoicePresets.js';
import logger from '../utils/logger.js';

/**
 * Spread listening questions evenly through the exam (stable insert positions).
 * @param {object[]} regularQuestions
 * @param {object[]} listeningQuestions
 */
export const interleaveListeningEvenly = (regularQuestions, listeningQuestions) => {
  const reg = Array.isArray(regularQuestions) ? [...regularQuestions] : [];
  const listen = Array.isArray(listeningQuestions) ? listeningQuestions.filter(Boolean) : [];
  if (listen.length === 0) return reg;
  const n = reg.length;
  const k = listen.length;
  const total = n + k;
  const idx = [];
  for (let j = 1; j <= k; j += 1) {
    idx.push(Math.floor((j / (k + 1)) * total));
  }
  idx.sort((a, b) => a - b);
  const out = [...reg];
  const pairs = idx.map((ix, j) => ({ ix, q: listen[j] })).sort((a, b) => b.ix - a.ix);
  pairs.forEach(({ ix, q }) => out.splice(ix, 0, q));
  return out;
};

/**
 * For each listening question with narrationText, generate audio once and attach Cloudinary public id.
 * @param {object[]} questions
 * @param {{ accent?: string }} [opts]
 */
export const synthesizeAndAttachListeningAudio = async (questions, opts = {}) => {
  if (!Array.isArray(questions) || !isCambAiTtsConfigured()) {
    throw new Error('Listening audio requires CAMB_AI_API_KEY to be set.');
  }
  if (!isCloudinaryConfigured()) {
    throw new Error('Listening audio storage requires Cloudinary to be configured.');
  }
  const accent = String(opts.accent || 'american').toLowerCase();
  const voice = voiceMetaFromAccent(accent);
  const out = questions.map((q) => (q && typeof q === 'object' ? { ...q } : q));
  for (let i = 0; i < out.length; i += 1) {
    const q = out[i];
    if (!q?.isAudioQuestion || !q.narrationText?.trim()) continue;
    try {
      const { buffer, contentType } = await synthesizeExamNarration(q.narrationText.trim(), voice);
      const up = await uploadAuthenticatedExamAudio(buffer, contentType);
      if (!up?.publicId) {
        throw new Error('Audio upload returned no public id');
      }
      q.audioCloudinaryPublicId = up.publicId;
      q.audioUrl = '';
      q.audioVoice = String(voice.voiceId ?? process.env.CAMB_AI_VOICE_ID ?? '');
      q.audioLanguage = String(voice.language ?? process.env.CAMB_AI_LANGUAGE_ID ?? '');
    } catch (e) {
      logger.error(`[examListening] TTS/upload failed for Q${i}: ${e.message}`);
      throw e;
    }
  }
  return out;
};
