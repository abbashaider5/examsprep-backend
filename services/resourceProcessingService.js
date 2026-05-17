import Resource from '../models/Resource.js';
import ResourceChunk from '../models/ResourceChunk.js';
import logger from '../utils/logger.js';
import {
  cleanExtractedText,
  cleanPdfExtractedText,
  chunkTextForEmbedding,
  detectStructureOutline,
} from './resourceChunkingService.js';
import { embedTexts, getEmbeddingModelLabel, isEmbeddingServiceEnabled } from './embeddingService.js';
import { extractTextFromResourceBuffer } from './resourceTextExtraction.js';
import { logPdfExtract, pdfBufferFingerprint } from '../utils/pdfExtractionDiagnostics.js';
import { delCache } from './cacheService.js';
import {
  downloadStoredResourceBuffer,
  isCloudinaryConfigured,
  uploadResourceFile,
} from './cloudinaryService.js';
import { scheduleBackgroundWork } from '../utils/backgroundTask.js';

const isPdfResource = (resource) => {
  const n = (resource.originalName || '').toLowerCase();
  const mt = (resource.mimetype || '').toLowerCase();
  return n.endsWith('.pdf') || mt === 'application/pdf';
};

const invalidateResourceCaches = async (resource) => {
  const keys = [`resources:mine:${resource.uploadedBy}`];
  if (resource.group) keys.push(`resources:group:${resource.group}`);
  if (resource.scope === 'admin') keys.push('resources:admin');
  await delCache(...keys).catch(() => {});
};

const setProcessingStage = async (resourceId, label) => {
  if (!resourceId || label == null) return;
  await Resource.findByIdAndUpdate(resourceId, {
    processingStageLabel: String(label).slice(0, 300),
  });
};

const fail = async (resourceId, code, message, failedStage = '') => {
  const resource = await Resource.findById(resourceId).select('uploadedBy group scope');
  await Resource.findByIdAndUpdate(resourceId, {
    processingStatus: 'failed',
    processingErrorCode: code,
    processingErrorMessage: message,
    processingStageLabel: '',
    processingFailedStage: failedStage ? String(failedStage).slice(0, 64) : '',
    chunkCount: 0,
  });
  logger.warn(`[resourceProcessing] ${resourceId} failed: ${code} — ${message}`);
  if (resource) await invalidateResourceCaches(resource);
};

/**
 * @param {import('mongoose').Types.ObjectId|string} resourceId
 * @param {import('mongoose').Document} resource
 * @param {{ text: string, pages: number }} extracted
 * @param {string} cleaned
 */
async function finalizeResourceIndexing(resourceId, resource, extracted, cleaned) {
  await setProcessingStage(resourceId, 'Preparing AI-ready content…');

  const outline = detectStructureOutline(cleaned);
  const chunkSpecs = chunkTextForEmbedding(cleaned);
  if (!chunkSpecs.length) {
    await fail(
      resourceId,
      'CHUNK_FAILED',
      'We could not turn this into useful study segments. Try a document with clearer structure or more prose.',
      'prepare',
    );
    return;
  }

  await ResourceChunk.deleteMany({ resource: resource._id });

  const texts = chunkSpecs.map((c) => c.text);
  let embeddings = null;
  let embeddingModel = '';
  if (isEmbeddingServiceEnabled()) {
    try {
      const pack = await embedTexts(texts);
      if (pack?.embeddings?.length === texts.length) {
        embeddings = pack.embeddings;
        embeddingModel = pack.model || getEmbeddingModelLabel();
      } else if (pack?.embeddings?.length) {
        logger.warn(`[resourceProcessing] Embedding length mismatch (${pack.embeddings.length}/${texts.length}); storing chunks without vectors`);
      } else {
        logger.warn('[resourceProcessing] No embeddings returned (is the local embedding service running?). Chunks saved for lexical retrieval.');
      }
    } catch (e) {
      logger.warn(`[resourceProcessing] Embedding call failed: ${e.message}; continuing without vectors`);
    }
  }

  const docs = chunkSpecs.map((c, i) => ({
    resource: resource._id,
    enterpriseId: resource.enterpriseId || null,
    uploadedBy: resource.uploadedBy,
    chunkIndex: i,
    text: c.text,
    sectionTitle: c.sectionTitle || '',
    charCount: c.charCount || c.text.length,
    embedding: embeddings?.[i] || undefined,
    embeddingModel: embeddings?.[i] ? embeddingModel : '',
  }));

  try {
    await ResourceChunk.insertMany(docs, { ordered: false });
  } catch (e) {
    logger.error(`[resourceProcessing] insertMany failed: ${e.message}`);
    await fail(resourceId, 'AI_INDEXING_FAILED', 'We could not save the AI index. Please try again in a moment.', 'index');
    return;
  }

  await Resource.findByIdAndUpdate(resourceId, {
    processingStatus: 'ready',
    processingErrorCode: '',
    processingErrorMessage: '',
    processingStageLabel: '',
    processingFailedStage: '',
    chunkCount: docs.length,
    extractedCharCount: cleaned.length,
    pages: extracted.pages || resource.pages || 0,
    structureOutline: outline.slice(0, 80),
    embeddingModel: embeddingModel || 'none',
    processedAt: new Date(),
  });

  await invalidateResourceCaches(resource);
  logger.info(`[resourceProcessing] Resource ${resourceId} ready with ${docs.length} chunks`);
}

const handleExtractError = async (resourceId, e) => {
  const msg = (e?.message || '').trim();
  if (e.code === 'LEGACY_PPT') {
    await fail(resourceId, 'LEGACY_PPT', 'Older .ppt files are not supported. Save as .pptx and upload again.', 'extract');
  } else if (e.code === 'PDF_SCANNED') {
    await fail(
      resourceId,
      'PDF_SCANNED',
      msg || 'This PDF appears to be scanned or image-based. For best results, upload a Word file or a text-based PDF export.',
      'extract',
    );
  } else if (e.code === 'PDF_NOT_SUPPORTED') {
    await fail(resourceId, 'PDF_NOT_SUPPORTED', 'This PDF could not be opened. Try exporting it again from the original app.', 'extract');
  } else if (e.code === 'PDF_MALFORMED' || e.code === 'PDF_ENCRYPTED' || e.code === 'PDF_RUNTIME') {
    await fail(resourceId, e.code, msg || 'This PDF could not be processed. Try exporting again or upload Word (.docx).', 'extract');
  } else if (e.code === 'UNSUPPORTED_FORMAT') {
    await fail(resourceId, 'UNSUPPORTED_FILE', 'This file type is not supported. Use DOCX, PPTX, PDF, or TXT.', 'extract');
  } else if (e.code === 'EXTRACTION_FAILED') {
    await fail(
      resourceId,
      'EXTRACTION_FAILED',
      msg || 'This PDF could not be read. It may be corrupted, password-protected, or an unusual export.',
      'extract',
    );
  } else {
    await fail(
      resourceId,
      'EXTRACTION_FAILED',
      msg || 'We could not read text from this file. Try another export or format.',
      'extract',
    );
  }
};

/**
 * Resolve file bytes: prefer upload-time buffer; Cloudinary download only for retries/legacy.
 * @param {import('mongoose').Document} resource
 * @param {Buffer | null | undefined} fileBuffer
 * @returns {Promise<Buffer>}
 */
async function resolveFileBuffer(resource, fileBuffer) {
  if (fileBuffer?.length) return fileBuffer;

  if (!resource.cloudinaryUrl && !resource.cloudinaryPublicId) {
    const err = new Error('No file buffer or stored file available for processing.');
    err.code = 'NO_FILE';
    throw err;
  }

  return downloadStoredResourceBuffer({
    cloudinaryUrl: resource.cloudinaryUrl,
    cloudinaryPublicId: resource.cloudinaryPublicId,
  });
}

/**
 * Persist the raw upload to Cloudinary immediately so Retry can re-download the file
 * even when text extraction / indexing fails later.
 * @returns {Promise<boolean>} true when a stored URL exists on the resource
 */
export async function storeResourceFileEarly(resourceId, fileBuffer, originalName = 'resource') {
  if (!fileBuffer?.length) return false;

  const existing = await Resource.findById(resourceId).select('cloudinaryUrl cloudinaryPublicId');
  if (existing?.cloudinaryUrl && existing?.cloudinaryPublicId) return true;

  if (!isCloudinaryConfigured()) {
    logger.warn(`[resourceProcessing] Cloudinary not configured; resource ${resourceId} cannot be retried after failure`);
    return false;
  }

  const uploaded = await uploadResourceFile(fileBuffer, originalName);
  if (!uploaded?.url || !uploaded?.publicId) {
    logger.warn(`[resourceProcessing] Early Cloudinary store failed for ${resourceId}`);
    return false;
  }

  const resource = await Resource.findByIdAndUpdate(
    resourceId,
    { cloudinaryUrl: uploaded.url, cloudinaryPublicId: uploaded.publicId },
    { new: true },
  );
  if (resource) await invalidateResourceCaches(resource);
  logger.info(`[resourceProcessing] Stored original file for ${resourceId} (retry-safe)`);
  return true;
}

/**
 * Store original file on Cloudinary after indexing if not already stored at upload time.
 */
async function persistOriginalToCloudinary(resourceId, resource, fileBuffer) {
  const fresh = await Resource.findById(resourceId).select('cloudinaryUrl cloudinaryPublicId uploadedBy group scope');
  if (fresh?.cloudinaryUrl && fresh?.cloudinaryPublicId) return;

  if (!fileBuffer?.length) return;
  const stored = await storeResourceFileEarly(resourceId, fileBuffer, resource.originalName || 'resource');
  if (!stored) {
    logger.warn(`[resourceProcessing] Indexed ${resourceId} but Cloudinary storage upload failed`);
  }
}

/**
 * Full async pipeline: extract → clean → chunk → embed → persist → Cloudinary storage.
 * @param {import('mongoose').Types.ObjectId|string} resourceId
 * @param {{ fileBuffer?: Buffer | null }} [opts] — multer buffer from upload; omit on retry (uses Cloudinary fallback)
 */
export const processResourceDocument = async (resourceId, opts = {}) => {
  const uploadBuffer = opts.fileBuffer?.length ? Buffer.from(opts.fileBuffer) : null;
  const resource = await Resource.findById(resourceId);
  if (!resource) return;

  await Resource.findByIdAndUpdate(resourceId, {
    processingStatus: 'processing',
    processingErrorCode: '',
    processingErrorMessage: '',
    processingStageLabel: 'Reading your resource…',
    processingFailedStage: '',
  });

  let buffer;
  try {
    buffer = await resolveFileBuffer(resource, uploadBuffer);
    if (isPdfResource(resource)) {
      const fp = pdfBufferFingerprint(buffer);
      logPdfExtract('resource_upload_buffer', {
        resourceId: String(resourceId),
        source: uploadBuffer?.length ? 'multer' : 'cloudinary',
        ...fp,
        originalName: resource.originalName || '',
      });
      if (!fp.bytes) {
        await fail(resourceId, 'PDF_MALFORMED', 'The PDF did not upload correctly (empty file). Please try again.', 'upload');
        return;
      }
    }
  } catch (e) {
    if (e.code === 'NO_FILE') {
      await fail(resourceId, 'NO_FILE', 'The file did not attach correctly. Please upload again.', 'upload');
      return;
    }
    logger.warn(`[resourceProcessing] Download failed for ${resourceId}: ${e.message}`);
    const detail = (e?.message || 'Unknown error').slice(0, 280);
    await fail(
      resourceId,
      'DOWNLOAD_FAILED',
      `We could not load your file from storage. ${detail}`,
      'download',
    );
    return;
  }

  let extracted;
  try {
    extracted = await extractTextFromResourceBuffer(buffer, resource.originalName, resource.mimetype, {
      onPdfStage: (label) => setProcessingStage(resourceId, label),
      pdfLabel: `resource:${resourceId}`,
    });
  } catch (e) {
    await handleExtractError(resourceId, e);
    return;
  }

  const cleaned = isPdfResource(resource)
    ? cleanPdfExtractedText(extracted.text)
    : cleanExtractedText(extracted.text);

  if (!cleaned || cleaned.length < 80) {
    await fail(
      resourceId,
      'NO_TEXT',
      isPdfResource(resource)
        ? 'This PDF appears to be scanned or image-based. For best results, upload a Word (.docx) file or a text-based PDF exported from your original document.'
        : 'No readable text was detected. This file may be images only or nearly empty.',
      'prepare',
    );
    return;
  }

  await finalizeResourceIndexing(resourceId, resource, extracted, cleaned);

  // Original upload buffer path: store file after successful indexing (not used for extraction).
  const storageBuffer = uploadBuffer || buffer;
  await persistOriginalToCloudinary(resourceId, resource, storageBuffer);
};

/**
 * @param {import('mongoose').Types.ObjectId|string} resourceId
 * @param {{ fileBuffer?: Buffer }} [opts]
 */
export const enqueueResourceProcessing = (resourceId, opts = {}) => {
  const fileBuffer = opts.fileBuffer?.length ? Buffer.from(opts.fileBuffer) : null;
  scheduleBackgroundWork(async () => {
    try {
      await processResourceDocument(resourceId, { fileBuffer });
    } catch (err) {
      logger.error(`[resourceProcessing] Unhandled error for ${resourceId}: ${err.message}`);
      await Resource.findByIdAndUpdate(resourceId, {
        processingStatus: 'failed',
        processingErrorCode: 'UNEXPECTED',
        processingErrorMessage: 'Something interrupted processing. Try again or upload a different file.',
        processingStageLabel: '',
        processingFailedStage: 'other',
      }).catch(() => {});
    }
  });
};
