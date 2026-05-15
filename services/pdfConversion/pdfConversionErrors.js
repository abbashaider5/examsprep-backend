/** @typedef {{ ok: true, docxBuffer: Buffer, meta: { provider: string, jobId?: string } }} PdfConversionSuccess */
/** @typedef {{ ok: false, code: string, message: string, provider: string, detail?: string }} PdfConversionFailure */

export class PdfConversionError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [provider]
   */
  constructor(code, message, provider = '') {
    super(message);
    this.name = 'PdfConversionError';
    this.code = code;
    this.provider = provider || '';
  }
}
