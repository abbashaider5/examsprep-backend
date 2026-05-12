import logger from '../../utils/logger.js';

const DEFAULT_BASE = 'https://client.camb.ai/apis';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * CAMB.AI async TTS (server-side only).
 * @see https://docs.camb.ai/api-reference/endpoint/create-tts
 * @param {string} text
 * @param {{ voiceId?: number, language?: number, gender?: number, age?: number, projectName?: string }} opts
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export const synthesizeSpeechWithCambAi = async (text, opts = {}) => {
  const apiKey = process.env.CAMB_AI_API_KEY;
  if (!apiKey) {
    throw new Error('CAMB_AI_API_KEY is not configured');
  }
  const base = (process.env.CAMB_AI_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const headers = {
    'x-api-key': apiKey,
    'Content-Type': 'application/json',
  };

  const voiceId = Number(opts.voiceId ?? process.env.CAMB_AI_VOICE_ID ?? 147320);
  const language = Number(opts.language ?? process.env.CAMB_AI_LANGUAGE_ID ?? 1);
  const gender = Number(opts.gender ?? process.env.CAMB_AI_GENDER ?? 1);
  const age = Number(opts.age ?? process.env.CAMB_AI_AGE ?? 30);
  const projectName = (opts.projectName || 'LikhitAI Exam Audio').slice(0, 255);

  const body = {
    text: String(text || '').trim(),
    voice_id: voiceId,
    language,
    gender,
    age,
    project_name: projectName,
    project_description: 'Educational narration for an online assessment.',
  };

  if (!body.text || body.text.length < 2) {
    throw new Error('TTS text is empty');
  }

  const createRes = await fetch(`${base}/tts`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => '');
    logger.warn(`[CAMB.AI] create tts failed ${createRes.status}: ${errText.slice(0, 400)}`);
    throw new Error(`CAMB.AI TTS request failed (${createRes.status})`);
  }
  const { task_id: taskId } = await createRes.json();
  if (!taskId) throw new Error('CAMB.AI did not return task_id');

  const deadline = Date.now() + Number(process.env.CAMB_AI_TTS_TIMEOUT_MS || 180_000);
  let runId = null;
  while (Date.now() < deadline) {
    const stRes = await fetch(`${base}/tts/${encodeURIComponent(taskId)}`, { headers: { 'x-api-key': apiKey } });
    if (!stRes.ok) {
      const t = await stRes.text().catch(() => '');
      logger.warn(`[CAMB.AI] status ${stRes.status}: ${t.slice(0, 200)}`);
      throw new Error('CAMB.AI TTS status check failed');
    }
    const st = await stRes.json();
    const status = String(st.status || '').toUpperCase();
    if (status === 'SUCCESS' && st.run_id) {
      runId = st.run_id;
      break;
    }
    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error(st.message || 'CAMB.AI TTS generation failed');
    }
    await sleep(Number(process.env.CAMB_AI_TTS_POLL_MS || 2000));
  }
  if (!runId) throw new Error('CAMB.AI TTS timed out');

  const audioRes = await fetch(`${base}/tts-result/${encodeURIComponent(runId)}`, {
    headers: { 'x-api-key': apiKey },
  });
  if (!audioRes.ok) {
    const t = await audioRes.text().catch(() => '');
    logger.warn(`[CAMB.AI] download ${audioRes.status}: ${t.slice(0, 200)}`);
    throw new Error('CAMB.AI audio download failed');
  }
  const arrayBuf = await audioRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const contentType = audioRes.headers.get('content-type') || 'audio/wav';
  return { buffer, contentType };
};

export const isCambAiTtsConfigured = () => Boolean(process.env.CAMB_AI_API_KEY?.trim());
