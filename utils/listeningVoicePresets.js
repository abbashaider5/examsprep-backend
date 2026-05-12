const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Map teacher accent preset → CAMB.AI voice parameters (override via env per deployment).
 */
export const voiceMetaFromAccent = (accentRaw = 'american') => {
  const accent = String(accentRaw || 'american').toLowerCase();
  const baseVoice = num(process.env.CAMB_AI_VOICE_ID, 147320);
  const baseLang = num(process.env.CAMB_AI_LANGUAGE_ID, 1);
  const baseGender = num(process.env.CAMB_AI_GENDER, 1);
  const baseAge = num(process.env.CAMB_AI_AGE, 30);

  const presets = {
    american: {
      voiceId: num(process.env.CAMB_AI_VOICE_ID_AMERICAN, baseVoice),
      language: num(process.env.CAMB_AI_LANGUAGE_ID_AMERICAN, baseLang),
    },
    british: {
      voiceId: num(process.env.CAMB_AI_VOICE_ID_BRITISH, baseVoice),
      language: num(process.env.CAMB_AI_LANGUAGE_ID_BRITISH, baseLang),
    },
    indian: {
      voiceId: num(process.env.CAMB_AI_VOICE_ID_INDIAN, baseVoice),
      language: num(process.env.CAMB_AI_LANGUAGE_ID_INDIAN, baseLang),
    },
  };
  const p = presets[accent] || presets.american;
  return {
    voiceId: p.voiceId,
    language: p.language,
    gender: baseGender,
    age: baseAge,
  };
};

const PREVIEW_BY_STYLE = {
  formal: 'This is a formal preview of LikhitAI narration for your listening assessment. The voice you hear is what candidates will experience during the exam.',
  conversational: 'Here is a quick conversational preview. LikhitAI will generate similar natural pacing for comprehension and dictation items in your test.',
  academic: 'Academic narration preview: clear pacing, neutral tone, and precise articulation—ideal for syllabus-aligned listening questions.',
  kids_friendly: 'Friendly preview voice: warm, encouraging, and easy to follow—great for younger learners while staying classroom-appropriate.',
};

export const previewSampleTextForStyle = (styleRaw = 'academic') => {
  const k = String(styleRaw || 'academic').toLowerCase();
  return PREVIEW_BY_STYLE[k] || PREVIEW_BY_STYLE.academic;
};
