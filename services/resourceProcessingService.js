import Resource from '../models/Resource.js';
import ResourceChunk from '../models/ResourceChunk.js';
import logger from '../utils/logger.js';
import { cleanExtractedText, cleanOcrExtractedText, chunkTextForEmbedding, detectStructureOutline } from './resourceChunkingService.js';
import { embedTexts, getEmbeddingModelLabel, isEmbeddingServiceEnabled } from './embeddingService.js';
import { extractTextFromResourceBuffer } from './resourceTextExtraction.js';
import { delCache } from './cacheService.js';
import { downloadStoredResourceBuffer } from './cloudinaryService.js';

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
 * Full async pipeline: extract → clean → chunk → embed → persist.
 */
export const processResourceDocument = async (resourceId) => {
  const resource = await Resource.findById(resourceId);
  if (!resource) return;

  await Resource.findByIdAndUpdate(resourceId, {
    processingStatus: 'processing',
    processingErrorCode: '',
    processingErrorMessage: '',
    processingStageLabel: 'Reading your resource…',
    processingFailedStage: '',
  });

  if (!resource.cloudinaryUrl) {
    await fail(resourceId, 'NO_FILE', 'The file did not attach correctly. Please upload again.', 'upload');
    return;
  }

  let buffer;
  try {
    buffer = await downloadStoredResourceBuffer({
      cloudinaryUrl: resource.cloudinaryUrl,
      cloudinaryPublicId: resource.cloudinaryPublicId,
    });
  } catch (e) {
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
    });
  } catch (e) {
    if (e.code === 'LEGACY_PPT') {
      await fail(resourceId, 'LEGACY_PPT', 'Older .ppt files are not supported. Save as .pptx and upload again.', 'extract');
    } else if (e.code === 'PDF_NOT_SUPPORTED') {
      await fail(resourceId, 'PDF_NOT_SUPPORTED', 'This PDF could not be opened. Try exporting it again from the original app.', 'extract');
    } else if (e.code === 'UNSUPPORTED_FORMAT') {
      await fail(resourceId, 'UNSUPPORTED_FILE', 'This file type is not supported. Use DOCX, PPTX, PDF, or TXT.', 'extract');
    } else if (e.code === 'PDF_TOO_LARGE_FOR_OCR') {
      await fail(resourceId, 'PDF_TOO_LARGE_FOR_OCR', 'This PDF is too large for automatic OCR. Use a smaller file or fewer pages.', 'ocr');
    } else if (e.code === 'OCR_TIMEOUT' || e.code === 'OCR_PAGE_TIMEOUT') {
      await fail(resourceId, 'OCR_TIMEOUT', 'OCR timed out while reading pages. Try fewer pages or a lighter file.', 'ocr');
    } else if (e.code === 'OCR_FAILED') {
      await fail(resourceId, 'OCR_FAILED', 'We could not read the scanned pages. The file may be mostly images or too faint.', 'ocr');
    } else if (e.code === 'NO_TEXT') {
      await fail(
        resourceId,
        'NO_TEXT_OCR',
        'No usable text came back from the scan. The PDF may be images only or too low quality.',
        'ocr',
      );
    } else if (e.code === 'EXTRACTION_FAILED') {
      await fail(
        resourceId,
        'EXTRACTION_FAILED',
        'This PDF could not be read. It may be corrupted, password-protected, or an unusual export.',
        'extract',
      );
    } else {
      await fail(
        resourceId,
        'EXTRACTION_FAILED',
        'We could not read text from this file. Try another export or format.',
        'extract',
      );
    }
    return;
  }

  const cleaned = extracted.usedOcr
    ? cleanOcrExtractedText(extracted.text)
    : cleanExtractedText(extracted.text);
  if (!cleaned || cleaned.length < 80) {
    if (extracted.usedOcr) {
      await fail(
        resourceId,
        'NO_TEXT_OCR',
        'After OCR, there still wasn’t enough readable text. The scan quality may be too low.',
        'prepare',
      );
    } else {
      await fail(
        resourceId,
        'NO_TEXT',
        'No readable text was detected. This file may be images only or nearly empty.',
        'prepare',
      );
    }
    return;
  }

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
};

export const enqueueResourceProcessing = (resourceId) => {
  setImmediate(() => {
    processResourceDocument(resourceId).catch((err) => {
      logger.error(`[resourceProcessing] Unhandled error for ${resourceId}: ${err.message}`);
      Resource.findByIdAndUpdate(resourceId, {
        processingStatus: 'failed',
        processingErrorCode: 'UNEXPECTED',
        processingErrorMessage: 'Something interrupted processing. Try again or upload a different file.',
        processingStageLabel: '',
        processingFailedStage: 'other',
      }).catch(() => {});
    });
  });
};
