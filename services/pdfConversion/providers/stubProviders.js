/**
 * Placeholders for future providers (ConvertAPI, Adobe PDF Services, local/OCR engines).
 * @param {string} providerId
 * @returns {import('../pdfConversionErrors.js').PdfConversionFailure}
 */
export function providerNotImplemented(providerId) {
  return {
    ok: false,
    code: 'PROVIDER_NOT_CONFIGURED',
    message:
      'This conversion provider is not wired up yet. Set PDF_CONVERSION_PROVIDER=cloudconvert '
      + 'with CLOUDCONVERT_API_KEY, or choose another supported provider when available.',
    provider: providerId,
  };
}
