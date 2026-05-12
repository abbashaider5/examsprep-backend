import http from 'http';
import https from 'https';
import Resource from '../models/Resource.js';
import ResourceChunk from '../models/ResourceChunk.js';
import logger from '../utils/logger.js';
import { cleanExtractedText, chunkTextForEmbedding, detectStructureOutline } from './resourceChunkingService.js';
import { embedTexts, getEmbeddingModelLabel, isEmbeddingServiceEnabled } from './embeddingService.js';
import { extractTextFromResourceBuffer } from './resourceTextExtraction.js';
import { delCache } from './cacheService.js';

const downloadBuffer = (url) => new Promise((resolve, reject) => {
  const lib = url.startsWith('https') ? https : http;
  lib.get(url, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  }).on('error', reject);
});

const invalidateResourceCaches = async (resource) => {
  const keys = [`resources:mine:${resource.uploadedBy}`];
  if (resource.group) keys.push(`resources:group:${resource.group}`);
  if (resource.scope === 'admin') keys.push('resources:admin');
  await delCache(...keys).catch(() => {});
};

const fail = async (resourceId, code, message) => {
  const resource = await Resource.findById(resourceId).select('uploadedBy group scope');
  await Resource.findByIdAndUpdate(resourceId, {
    processingStatus: 'failed',
    processingErrorCode: code,
    processingErrorMessage: message,
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
  });

  if (!resource.cloudinaryUrl) {
    await fail(resourceId, 'NO_FILE', 'Resource file URL is missing.');
    return;
  }

  let buffer;
  try {
    buffer = await downloadBuffer(resource.cloudinaryUrl);
  } catch (e) {
    await fail(resourceId, 'DOWNLOAD_FAILED', 'Could not download the file from storage.');
    return;
  }

  let extracted;
  try {
    extracted = await extractTextFromResourceBuffer(buffer, resource.originalName, resource.mimetype);
  } catch (e) {
    if (e.code === 'LEGACY_PPT') {
      await fail(resourceId, 'UNSUPPORTED_FILE', 'Legacy .ppt format is not supported. Please save as .pptx and re-upload.');
    } else if (e.code === 'PDF_NOT_SUPPORTED') {
      await fail(resourceId, 'PDF_NOT_SUPPORTED', e.message || 'PDF is not supported. Save as Word (.docx) and upload again.');
    } else if (e.code === 'UNSUPPORTED_FORMAT') {
      await fail(resourceId, 'UNSUPPORTED_FILE', 'This file type is not supported. Use DOCX, PPTX, or TXT.');
    } else {
      await fail(resourceId, 'EXTRACTION_FAILED', 'Could not read text from this file. Try another export or format.');
    }
    return;
  }

  const cleaned = cleanExtractedText(extracted.text);
  if (!cleaned || cleaned.length < 80) {
    await fail(resourceId, 'NO_TEXT', 'Not enough readable text was found. Scanned PDFs need OCR (coming soon).');
    return;
  }

  const outline = detectStructureOutline(cleaned);
  const chunkSpecs = chunkTextForEmbedding(cleaned);
  if (!chunkSpecs.length) {
    await fail(resourceId, 'CHUNK_FAILED', 'Could not split the document into study segments.');
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
    await fail(resourceId, 'AI_INDEXING_FAILED', 'Could not save indexed segments. Please try again.');
    return;
  }

  await Resource.findByIdAndUpdate(resourceId, {
    processingStatus: 'ready',
    processingErrorCode: '',
    processingErrorMessage: '',
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
        processingErrorMessage: 'Processing failed unexpectedly. Try re-upload or contact support.',
      }).catch(() => {});
    });
  });
};
