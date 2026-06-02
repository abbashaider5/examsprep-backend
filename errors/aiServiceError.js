/** Thrown when an upstream AI provider fails; carries full diagnostics for admins. */
export class AiServiceError extends Error {
  /**
   * @param {import('../services/ai/aiProviderErrors.js').NormalizedAiError} diagnostics
   */
  constructor(diagnostics) {
    super(diagnostics.message || 'AI service unavailable');
    this.name = 'AiServiceError';
    this.isAiServiceError = true;
    this.publicCode = 'AI_SERVICE_UNAVAILABLE';
    this.diagnostics = diagnostics;
    const http = Number(diagnostics.httpStatus);
    this.statusCode = http >= 400 && http < 600 && http !== 429 ? http : 503;
  }
}
