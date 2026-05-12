import { isCambAiTtsConfigured, synthesizeSpeechWithCambAi } from './cambAiTtsProvider.js';

/**
 * Provider-based TTS entry (CAMB.AI today; swap implementation without touching exam flow).
 */
export const synthesizeExamNarration = async (text, voiceMeta = {}) => {
  if (!isCambAiTtsConfigured()) {
    throw new Error('Text-to-speech is not configured (CAMB_AI_API_KEY).');
  }
  return synthesizeSpeechWithCambAi(text, {
    voiceId: voiceMeta.voiceId,
    language: voiceMeta.language,
    gender: voiceMeta.gender,
    age: voiceMeta.age,
  });
};

export { isCambAiTtsConfigured };
