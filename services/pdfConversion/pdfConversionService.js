import logger from '../../utils/logger.js';
import { convertWithCloudConvert } from './providers/cloudconvertProvider.js';
import { providerNotImplemented } from './providers/stubProviders.js';

/**
 * @typedef {{
 *   pdfBuffer: Buffer,
 *   originalFilename?: string,
 *   sourceUrl?: string,
 *   timeoutMs?: number,
 * }} PdfConversionInput
 */

/** @returns {string} normalized provider id */
export function getPdfConversionProviderId() {
  const raw = (process.env.PDF_CONVERSION_PROVIDER || 'none').trim().toLowerCase();
  if (!raw || raw === 'none' || raw === 'off' || raw === 'disabled') return 'none';
  return raw;
}

/**
 * Whether the selected provider has the credentials / binaries it needs.
 */
export function isPdfConversionConfigured() {
  const id = getPdfConversionProviderId();
  if (id === 'none') return false;
  if (id === 'cloudconvert') return Boolean(process.env.CLOUDCONVERT_API_KEY?.trim());
  if (['convertapi', 'adobe', 'adobe_pdf_services', 'local'].includes(id)) return false;
  return false;
}

/**
 * Provider-based PDF → DOCX. Callers should not import CloudConvert directly.
 * @param {PdfConversionInput} input
 * @returns {Promise<import('./pdfConversionErrors.js').PdfConversionSuccess | import('./pdfConversionErrors.js').PdfConversionFailure>}
 */
export async function convertPdfToDocx(input) {
  const id = getPdfConversionProviderId();

  if (id === 'none') {
    return {
      ok: false,
      code: 'CONVERSION_DISABLED',
      message: 'Automatic PDF→DOCX conversion is disabled (PDF_CONVERSION_PROVIDER=none).',
      provider: 'none',
    };
  }

  if (id === 'cloudconvert') {
    return convertWithCloudConvert(input);
  }

  if (id === 'convertapi') {
    return providerNotImplemented('convertapi');
  }

  if (id === 'adobe' || id === 'adobe_pdf_services') {
    return providerNotImplemented('adobe');
  }

  if (id === 'local') {
    return providerNotImplemented('local');
  }

  logger.warn(`[pdfConversion] Unknown PDF_CONVERSION_PROVIDER="${id}"`);
  return {
    ok: false,
    code: 'UNKNOWN_PROVIDER',
    message: `Unknown PDF_CONVERSION_PROVIDER: ${id}`,
    provider: id,
  };
}
