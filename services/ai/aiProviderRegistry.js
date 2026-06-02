/** Provider-agnostic registry — extend when adding OpenAI, Gemini, Claude, OpenRouter, etc. */

export const PROVIDERS = Object.freeze({
  groq: {
    id: 'groq',
    displayName: 'Groq',
    apiKeyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    visionModelEnv: 'GROQ_VISION_MODEL',
    defaultModel: 'llama-3.3-70b-versatile',
    defaultVisionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    client: 'groq-sdk',
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini',
    client: 'openai',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.0-flash',
    client: 'google',
  },
  claude: {
    id: 'claude',
    displayName: 'Claude',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-3-5-sonnet-latest',
    client: 'anthropic',
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    defaultModel: '',
    client: 'openrouter',
  },
});

export function getPrimaryProviderId() {
  const id = String(process.env.AI_PRIMARY_PROVIDER || 'groq').trim().toLowerCase();
  return PROVIDERS[id] ? id : 'groq';
}

export function resolveProviderConfig(providerId) {
  const id = PROVIDERS[providerId] ? providerId : getPrimaryProviderId();
  const def = PROVIDERS[id];
  return {
    ...def,
    model: process.env[def.modelEnv] || def.defaultModel,
    visionModel: def.visionModelEnv
      ? (process.env[def.visionModelEnv] || def.defaultVisionModel)
      : def.defaultVisionModel,
    apiKey: process.env[def.apiKeyEnv] || '',
  };
}

export function getAppEnvironment() {
  if (process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production') return 'production';
  if (process.env.VERCEL_ENV === 'preview') return 'staging';
  return process.env.NODE_ENV || 'development';
}
