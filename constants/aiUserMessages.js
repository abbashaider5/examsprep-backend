export const AI_USER_FACING = {
  title: 'Unable to create your exam right now',
  message: 'Our AI services are currently experiencing high demand.\n\nOur team has already been notified and is working to restore normal service.\n\nPlease try again in a few minutes.',
  helperText: 'If the issue continues, please contact support through Help & Tickets.',
  code: 'AI_SERVICE_UNAVAILABLE',
};

export function isAiRelatedError(err) {
  if (!err) return false;
  if (err.isAiServiceError || err.name === 'AiServiceError') return true;
  if (err.name === 'AiGenerationError' || err.supportHint) return true;
  const code = String(err.publicCode || '');
  return code.startsWith('AI_');
}
