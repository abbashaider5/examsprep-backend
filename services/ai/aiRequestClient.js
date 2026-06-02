import Groq from 'groq-sdk';
import { AiServiceError } from '../../errors/aiServiceError.js';
import { getRequestContext } from '../../utils/requestContext.js';
import logger from '../../utils/logger.js';
import { recordAiFailure, recordAiSuccess } from '../aiHealthService.js';
import { getAppEnvironment, getPrimaryProviderId, resolveProviderConfig } from './aiProviderRegistry.js';
import { normalizeProviderError } from './aiProviderErrors.js';
import { finishAiCall, startAiCall } from './aiRequestTrace.js';

const clients = new Map();

function getGroqClient(apiKey) {
  const key = `groq:${apiKey?.slice(0, 8)}`;
  if (!clients.has(key)) {
    clients.set(key, new Groq({ apiKey }));
  }
  return clients.get(key);
}

/**
 * Provider-agnostic chat completion. Currently implements Groq; extend switch for other providers.
 * @param {object} params — OpenAI-compatible chat completion params
 * @param {{ operation?: string, provider?: string }} [meta]
 */
export async function aiChatCompletion(params, meta = {}) {
  const providerId = meta.provider || getPrimaryProviderId();
  const config = resolveProviderConfig(providerId);
  const model = params.model || config.model;
  const environment = getAppEnvironment();
  const operation = meta.operation || 'chat_completion';

  if (!config.apiKey) {
    const diagnostics = normalizeProviderError(
      new Error(`${config.displayName} API key is not configured`),
      { provider: providerId, model, operation, environment },
    );
    diagnostics.errorType = 'Configuration Error';
    diagnostics.errorCode = 'missing_api_key';
    await recordAiFailure({ diagnostics, operation });
    throw new AiServiceError(diagnostics);
  }

  const promptChars = JSON.stringify(params.messages || '').length;
  const traceRef = startAiCall({
    operation,
    model,
    purpose: meta.purpose || operation,
    promptChars,
  });

  try {
    let completion;
    switch (config.client) {
      case 'groq-sdk':
        completion = await getGroqClient(config.apiKey).chat.completions.create({
          ...params,
          model,
        });
        break;
      default:
        throw new Error(`Provider client not implemented: ${providerId}`);
    }

    finishAiCall(traceRef, completion);

    if (!meta.skipHealthRecording) {
      await recordAiSuccess();
    }
    return completion;
  } catch (err) {
    if (err instanceof AiServiceError) throw err;

    const ctx = getRequestContext();
    const diagnostics = normalizeProviderError(err, {
      provider: providerId,
      model,
      operation,
      environment,
    });

    logger.error('[ai] provider failure', {
      provider: diagnostics.providerDisplayName,
      errorType: diagnostics.errorType,
      errorCode: diagnostics.errorCode,
      model: diagnostics.model,
      httpStatus: diagnostics.httpStatus,
      requestId: ctx?.requestId,
      userId: ctx?.userId,
      operation,
    });

    if (!meta.skipHealthRecording) {
      await recordAiFailure({
        diagnostics,
        userId: ctx?.userId,
        userEmail: ctx?.userEmail,
        userName: ctx?.userName,
        requestId: ctx?.requestId,
        operation,
      });
    }

    throw new AiServiceError(diagnostics);
  }
}

export function getConfiguredChatModel(providerId) {
  return resolveProviderConfig(providerId || getPrimaryProviderId()).model;
}

export function getConfiguredVisionModel(providerId) {
  const config = resolveProviderConfig(providerId || getPrimaryProviderId());
  return config.visionModel || config.model;
}
