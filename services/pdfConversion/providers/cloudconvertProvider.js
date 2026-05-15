import logger from '../../../utils/logger.js';
import { PdfConversionError } from '../pdfConversionErrors.js';
import { downloadUrlToBuffer } from '../../../utils/downloadUrlToBuffer.js';

const DEFAULT_BASE = 'https://api.cloudconvert.com/v2';
const MAX_BASE64_BYTES = 7 * 1024 * 1024; // stay under CloudConvert base64 import limits
const POLL_MS = 2000;

/**
 * @param {string} apiKey
 * @param {string} baseUrl
 */
async function ccFetch(apiKey, baseUrl, path, opts = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const method = opts.method || 'GET';
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, {
    ...opts,
    method,
    headers: { ...headers, ...(opts.headers || {}) },
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!r.ok) {
    const msg = json?.message || text?.slice(0, 400) || r.statusText;
    throw new PdfConversionError('CLOUDCONVERT_HTTP', `CloudConvert ${r.status}: ${msg}`, 'cloudconvert');
  }
  return json;
}

/**
 * @param {Record<string, unknown>} jobData
 */
function findTaskByOperation(jobData, operation) {
  const tasks = jobData?.tasks || [];
  return tasks.find((t) => t.operation === operation);
}

/**
 * @param {Record<string, unknown>} task
 */
function getExportFileUrl(task) {
  const files = task?.result?.files;
  if (Array.isArray(files) && files[0]?.url) return String(files[0].url);
  const url = task?.result?.url;
  if (url) return String(url);
  return '';
}

/**
 * Poll job until finished/error or timeout.
 * @param {string} apiKey
 * @param {string} baseUrl
 * @param {string} jobId
 * @param {number} deadline
 */
async function waitForJob(apiKey, baseUrl, jobId, deadline) {
  while (Date.now() < deadline) {
    const json = await ccFetch(apiKey, baseUrl, `/jobs/${jobId}`, { method: 'GET' });
    const data = json?.data;
    const status = data?.status;
    if (status === 'finished') return data;
    if (status === 'error') {
      const bad = (data?.tasks || []).find((t) => t.status === 'error');
      const msg = bad?.message || data?.message || 'CloudConvert job failed';
      const code = bad?.code || 'JOB_FAILED';
      throw new PdfConversionError(String(code), String(msg), 'cloudconvert');
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new PdfConversionError('CONVERSION_TIMEOUT', 'PDF conversion timed out. Try a smaller file or retry later.', 'cloudconvert');
}

/**
 * Create job, optionally upload file for import/upload task, then wait for export.
 * @param {string} apiKey
 * @param {string} baseUrl
 * @param {Record<string, unknown>} tasks
 * @param {Buffer | null} uploadBuffer
 * @param {string} uploadFilename
 * @param {number} deadline
 */
async function runJob(apiKey, baseUrl, tasks, uploadBuffer, uploadFilename, deadline) {
  const created = await ccFetch(apiKey, baseUrl, '/jobs', {
    method: 'POST',
    body: JSON.stringify({ tasks }),
  });
  const jobId = created?.data?.id;
  if (!jobId) throw new PdfConversionError('JOB_CREATE_FAILED', 'CloudConvert did not return a job id.', 'cloudconvert');

  if (uploadBuffer) {
    let formInfo = null;
    const start = Date.now();
    while (Date.now() < deadline && Date.now() - start < 120_000) {
      const j = await ccFetch(apiKey, baseUrl, `/jobs/${jobId}`, { method: 'GET' });
      const imp = findTaskByOperation(j.data, 'import/upload');
      if (imp?.status === 'error') {
        throw new PdfConversionError(imp.code || 'IMPORT_FAILED', imp.message || 'Upload import failed', 'cloudconvert');
      }
      if (imp?.result?.form?.url && imp?.result?.form?.parameters) {
        formInfo = imp.result.form;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (!formInfo?.url) {
      throw new PdfConversionError('UPLOAD_FORM_MISSING', 'CloudConvert did not return an upload URL in time.', 'cloudconvert');
    }
    const form = new FormData();
    const params = formInfo.parameters || {};
    for (const [k, v] of Object.entries(params)) {
      form.append(k, String(v));
    }
    form.append('file', new Blob([uploadBuffer], { type: 'application/pdf' }), uploadFilename || 'document.pdf');
    const up = await fetch(formInfo.url, { method: 'POST', body: form });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      throw new PdfConversionError('UPLOAD_FAILED', `Upload to CloudConvert failed (${up.status}): ${t.slice(0, 200)}`, 'cloudconvert');
    }
  }

  const done = await waitForJob(apiKey, baseUrl, jobId, deadline);
  const exportTask = findTaskByOperation(done, 'export/url');
  if (!exportTask || exportTask.status !== 'finished') {
    throw new PdfConversionError('EXPORT_MISSING', 'CloudConvert finished without an export URL.', 'cloudconvert');
  }
  const fileUrl = getExportFileUrl(exportTask);
  if (!fileUrl) throw new PdfConversionError('EXPORT_URL_MISSING', 'No download URL from CloudConvert export.', 'cloudconvert');
  const docxBuffer = await downloadUrlToBuffer(fileUrl);
  if (!docxBuffer?.length) {
    throw new PdfConversionError('EMPTY_RESULT', 'Converted DOCX download was empty.', 'cloudconvert');
  }
  return { docxBuffer, jobId };
}

/**
 * @param {{ pdfBuffer: Buffer, originalFilename?: string, sourceUrl?: string, timeoutMs?: number }} input
 * @returns {Promise<import('../pdfConversionErrors.js').PdfConversionSuccess | import('../pdfConversionErrors.js').PdfConversionFailure>}
 */
export async function convertWithCloudConvert(input) {
  const apiKey = process.env.CLOUDCONVERT_API_KEY || '';
  if (!apiKey) {
    return {
      ok: false,
      code: 'MISSING_API_KEY',
      message: 'CloudConvert is selected but CLOUDCONVERT_API_KEY is not set.',
      provider: 'cloudconvert',
    };
  }

  const baseUrl = (process.env.CLOUDCONVERT_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 300_000, 60_000), 900_000);
  const deadline = Date.now() + timeoutMs;
  const name = (input.originalFilename || 'document.pdf').replace(/[^\w.\-]+/g, '_');
  const safeName = name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;

  try {
    /** @type {{ docxBuffer: Buffer, jobId: string }} */
    let out;

    if (input.sourceUrl && typeof input.sourceUrl === 'string' && input.sourceUrl.startsWith('http')) {
      try {
        const tasks = {
          'import-pdf': { operation: 'import/url', url: input.sourceUrl },
          'convert-pdf': {
            operation: 'convert',
            input: 'import-pdf',
            input_format: 'pdf',
            output_format: 'docx',
          },
          'export-docx': { operation: 'export/url', input: 'convert-pdf' },
        };
        out = await runJob(apiKey, baseUrl, tasks, null, safeName, deadline);
        logger.info(`[pdfConversion:cloudconvert] job ${out.jobId} (import/url)`);
      } catch (e) {
        logger.warn(`[pdfConversion:cloudconvert] import/url failed (${e.message}); falling back`);
        if (input.pdfBuffer?.length) {
          out = await tryBase64OrUpload(apiKey, baseUrl, input.pdfBuffer, safeName, deadline);
        } else {
          throw e;
        }
      }
    } else {
      out = await tryBase64OrUpload(apiKey, baseUrl, input.pdfBuffer, safeName, deadline);
    }

    return {
      ok: true,
      docxBuffer: out.docxBuffer,
      meta: { provider: 'cloudconvert', jobId: out.jobId },
    };
  } catch (e) {
    if (e instanceof PdfConversionError) {
      return {
        ok: false,
        code: e.code,
        message: e.message,
        provider: 'cloudconvert',
        detail: e.message,
      };
    }
    logger.warn(`[pdfConversion:cloudconvert] ${e.message}`);
    return {
      ok: false,
      code: 'CONVERSION_FAILED',
      message: e?.message || 'CloudConvert conversion failed.',
      provider: 'cloudconvert',
    };
  }
}

/**
 * @param {string} apiKey
 * @param {string} baseUrl
 * @param {Buffer} pdfBuffer
 * @param {string} safeName
 * @param {number} deadline
 */
async function tryBase64OrUpload(apiKey, baseUrl, pdfBuffer, safeName, deadline) {
  if (!pdfBuffer?.length) {
    throw new PdfConversionError('NO_BUFFER', 'No PDF bytes available for conversion.', 'cloudconvert');
  }
  if (pdfBuffer.length <= MAX_BASE64_BYTES) {
    const b64 = pdfBuffer.toString('base64');
    const tasks = {
      'import-b64': { operation: 'import/base64', file: b64, filename: safeName },
      'convert-pdf': {
        operation: 'convert',
        input: 'import-b64',
        input_format: 'pdf',
        output_format: 'docx',
      },
      'export-docx': { operation: 'export/url', input: 'convert-pdf' },
    };
    const out = await runJob(apiKey, baseUrl, tasks, null, safeName, deadline);
    logger.info(`[pdfConversion:cloudconvert] job ${out.jobId} (import/base64)`);
    return out;
  }

  const tasks = {
    'import-pdf': { operation: 'import/upload' },
    'convert-pdf': {
      operation: 'convert',
      input: 'import-pdf',
      input_format: 'pdf',
      output_format: 'docx',
    },
    'export-docx': { operation: 'export/url', input: 'convert-pdf' },
  };
  const out = await runJob(apiKey, baseUrl, tasks, pdfBuffer, safeName, deadline);
  logger.info(`[pdfConversion:cloudconvert] job ${out.jobId} (import/upload)`);
  return out;
}
