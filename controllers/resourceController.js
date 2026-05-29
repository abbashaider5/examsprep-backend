import { AppError } from '../middleware/errorHandler.js';
import Group from '../models/Group.js';
import Resource from '../models/Resource.js';
import ResourceChunk from '../models/ResourceChunk.js';
import { deleteCloudinaryResource, downloadStoredResourceBuffer } from '../services/cloudinaryService.js';
import { cleanExtractedText, cleanOcrExtractedText, cleanPdfExtractedText } from '../services/resourceChunkingService.js';
import {
  enqueueResourceProcessing,
  enqueueResourceTextProcessing,
  processResourceDocument,
  processResourceFromClientText,
  storeResourceFileEarly,
} from '../services/resourceProcessingService.js';
import { isCloudinaryConfigured } from '../services/cloudinaryService.js';
import { extractTextFromResourceBuffer } from '../services/resourceTextExtraction.js';
import logger from '../utils/logger.js';
import { delCache, getCache, setCache } from '../services/cacheService.js';
import { RESOURCE_UPLOAD_MAX_BYTES } from '../config/uploadLimits.js';
import { pdfBufferFingerprint } from '../utils/pdfExtractionDiagnostics.js';

function canUseInstructorResourceApis(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Boolean(user.isInstructor) || ['instructor', 'principal'].includes(user.role);
}

/**
 * @param {import('express').Request} req
 * @param {{ buffer: Buffer, originalName: string, mimetype: string, size: number, title: string, groupId?: string, subject?: string, uploadChannel?: string }} input
 */
async function ingestResourceUpload(req, res, next, input) {
  const { buffer, originalName, mimetype, size, title, groupId, subject: subjectRaw, uploadChannel } = input;
  const lowerName = (originalName || '').toLowerCase();

  if (!title?.trim()) return next(new AppError('Title is required', 400));
  if (!buffer?.length) return next(new AppError('Uploaded file is empty. Please choose the file again.', 400));
  if (buffer.length > RESOURCE_UPLOAD_MAX_BYTES) {
    return next(new AppError(
      process.env.VERCEL
        ? 'File is too large for production upload (max 4.5 MB).'
        : 'File is too large (max 20 MB).',
      413,
    ));
  }

  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && !canUseInstructorResourceApis(req.user)) return next(new AppError('Not authorized', 403));

  let group = null;
  if (!isAdmin && groupId) {
    group = await Group.findById(groupId);
    if (!group) return next(new AppError('Group not found', 404));
    if (group.instructor.toString() !== req.user._id.toString()) {
      return next(new AppError('Not your group', 403));
    }
  }

  const subject = typeof subjectRaw === 'string' ? subjectRaw.trim().slice(0, 200) : '';
  const fileBuffer = Buffer.from(buffer);

  if (lowerName.endsWith('.pdf') || (mimetype || '').includes('pdf')) {
    const fp = pdfBufferFingerprint(fileBuffer);
    logger.info('[Resource] PDF upload received', {
      channel: uploadChannel || 'multipart',
      ...fp,
      userId: String(req.user._id),
    });
    if (!fp.hasPdfSig) {
      return next(new AppError(
        'The PDF did not upload correctly (invalid file header). Try uploading again or use Word (.docx).',
        400,
      ));
    }
  }

  const resource = await Resource.create({
    title: title.trim(),
    originalName: originalName || 'resource',
    mimetype: mimetype || 'application/octet-stream',
    size: size || fileBuffer.length,
    cloudinaryUrl: '',
    cloudinaryPublicId: '',
    uploadedBy: req.user._id,
    enterpriseId: req.user.enterpriseId || null,
    subject,
    scope: isAdmin ? 'admin' : 'instructor',
    group: group ? group._id : null,
    processingStatus: 'processing',
    processingErrorCode: '',
    processingErrorMessage: '',
    chunkCount: 0,
  });

  await storeResourceFileEarly(resource._id, fileBuffer, originalName || 'resource');

  if (process.env.VERCEL) {
    try {
      await processResourceDocument(resource._id, { fileBuffer });
    } catch (procErr) {
      logger.error(`[Resource] Inline processing error for ${resource._id}: ${procErr.message}`);
    }
    const updated = await Resource.findById(resource._id);
    res.status(201).json({ resource: updated || resource });
  } else {
    res.status(201).json({ resource });
    enqueueResourceProcessing(resource._id, { fileBuffer });
  }

  const cacheKeys = [`resources:mine:${req.user._id}`];
  if (group) cacheKeys.push(`resources:group:${group._id}`);
  if (isAdmin) cacheKeys.push('resources:admin');
  delCache(...cacheKeys).catch(() => {});
}

// ── Upload a resource (admin or instructor) ────────────────────────────────
export const uploadResource = async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No file uploaded', 400));
    const { title, groupId, subject: subjectRaw } = req.body;
    await ingestResourceUpload(req, res, next, {
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      title,
      groupId,
      subject: subjectRaw,
      uploadChannel: 'multipart',
    });
  } catch (err) { next(err); }
};

/** Text extracted in the browser (pdf.js) — uses standard POST /api/resources/import-text. */
export const importResourceText = async (req, res, next) => {
  try {
    const {
      title,
      text,
      originalName,
      pageCount,
      groupId,
      subject: subjectRaw,
      mimetype,
      size,
    } = req.body || {};

    const raw = typeof text === 'string' ? text : '';
    if (!raw.trim()) return next(new AppError('Document text is required', 400));
    if (raw.length > 2_500_000) {
      return next(new AppError('Extracted text is too large. Try a shorter PDF or Word (.docx).', 413));
    }

    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && !canUseInstructorResourceApis(req.user)) return next(new AppError('Not authorized', 403));

    if (!title?.trim()) return next(new AppError('Title is required', 400));

    let group = null;
    if (!isAdmin && groupId) {
      group = await Group.findById(groupId);
      if (!group) return next(new AppError('Group not found', 404));
      if (group.instructor.toString() !== req.user._id.toString()) {
        return next(new AppError('Not your group', 403));
      }
    }

    const subject = typeof subjectRaw === 'string' ? subjectRaw.trim().slice(0, 200) : '';
    const name = (originalName || 'document.pdf').slice(0, 255);
    const pages = Math.max(0, Number(pageCount) || 0);

    const resource = await Resource.create({
      title: title.trim(),
      originalName: name,
      mimetype: mimetype || 'application/pdf',
      size: Number(size) || raw.length,
      cloudinaryUrl: '',
      cloudinaryPublicId: '',
      uploadedBy: req.user._id,
      enterpriseId: req.user.enterpriseId || null,
      subject,
      scope: isAdmin ? 'admin' : 'instructor',
      group: group ? group._id : null,
      processingStatus: 'processing',
      processingErrorCode: '',
      processingErrorMessage: '',
      chunkCount: 0,
    });

    logger.info('[Resource] Client PDF text import', {
      resourceId: String(resource._id),
      chars: raw.length,
      pages,
      userId: String(req.user._id),
    });

    if (process.env.VERCEL) {
      try {
        await processResourceFromClientText(resource._id, raw, { pageCount: pages });
      } catch (procErr) {
        logger.error(`[Resource] Client-text processing error for ${resource._id}: ${procErr.message}`);
      }
      const updated = await Resource.findById(resource._id);
      res.status(201).json({ resource: updated || resource });
    } else {
      res.status(201).json({ resource });
      enqueueResourceTextProcessing(resource._id, raw, { pageCount: pages });
    }

    const cacheKeys = [`resources:mine:${req.user._id}`];
    if (group) cacheKeys.push(`resources:group:${group._id}`);
    if (isAdmin) cacheKeys.push('resources:admin');
    delCache(...cacheKeys).catch(() => {});
  } catch (err) { next(err); }
};

/** JSON base64 upload — avoids multipart corruption through Vercel proxies. */
export const uploadResourceBytes = async (req, res, next) => {
  try {
    const {
      fileBase64,
      originalName,
      mimetype,
      size,
      title,
      groupId,
      subject: subjectRaw,
    } = req.body || {};

    if (!fileBase64 || typeof fileBase64 !== 'string') {
      return next(new AppError('fileBase64 is required', 400));
    }

    const stripped = fileBase64.replace(/^data:[^;]+;base64,/, '').trim();
    let buffer;
    try {
      buffer = Buffer.from(stripped, 'base64');
    } catch {
      return next(new AppError('Invalid file encoding', 400));
    }

    await ingestResourceUpload(req, res, next, {
      buffer,
      originalName: originalName || 'upload.pdf',
      mimetype: mimetype || 'application/pdf',
      size: Number(size) || buffer.length,
      title,
      groupId,
      subject: subjectRaw,
      uploadChannel: 'base64-json',
    });
  } catch (err) { next(err); }
};

// ── Get admin-scoped resources (global; for instructors to use during exam creation) ──
export const getAdminResources = async (req, res, next) => {
  try {
    if (!canUseInstructorResourceApis(req.user)) return next(new AppError('Not authorized', 403));
    const key = 'resources:admin';
    const cached = await getCache(key);
    if (cached) return res.json(cached);

    const resources = await Resource.find({ scope: 'admin' })
      .sort({ createdAt: -1 });
    const payload = { resources };
    await setCache(key, payload, 600);
    res.json(payload);
  } catch (err) { next(err); }
};

// ── Get resources for a specific group (instructor only) ──────────────────
export const getGroupResources = async (req, res, next) => {
  try {
    const group = await Group.findById(req.params.groupId);
    if (!group) return next(new AppError('Group not found', 404));
    const isOwner = group.instructor.toString() === req.user._id.toString();
    const isMember = group.members.map(m => m.toString()).includes(req.user._id.toString());
    if (!isOwner && !isMember && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    const key = `resources:group:${group._id}`;
    const cached = await getCache(key);
    if (cached) return res.json(cached);

    const resources = await Resource.find({ scope: 'instructor', group: group._id })
      .sort({ createdAt: -1 });
    const payload = { resources };
    await setCache(key, payload, 300);
    res.json(payload);
  } catch (err) { next(err); }
};

// ── Get all resources uploaded by the current instructor (across all groups) ──
export const getMyResources = async (req, res, next) => {
  try {
    if (!canUseInstructorResourceApis(req.user)) return next(new AppError('Not authorized', 403));
    const key = `resources:mine:${req.user._id}`;
    const cached = await getCache(key);
    if (cached) return res.json(cached);

    const resources = await Resource.find({ scope: 'instructor', uploadedBy: req.user._id })
      .populate('group', 'name')
      .sort({ createdAt: -1 });
    const payload = { resources };
    await setCache(key, payload, 300);
    res.json(payload);
  } catch (err) { next(err); }
};

// ── Delete a resource ─────────────────────────────────────────────────────
export const deleteResource = async (req, res, next) => {
  try {
    const resource = await Resource.findById(req.params.id);
    if (!resource) return next(new AppError('Resource not found', 404));
    const isOwner = resource.uploadedBy.toString() === req.user._id.toString();
    if (!isOwner && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }
    // Delete from Cloudinary
    if (resource.cloudinaryPublicId) {
      await deleteCloudinaryResource(resource.cloudinaryPublicId);
    }
    await ResourceChunk.deleteMany({ resource: resource._id });
    await resource.deleteOne();

    // Invalidate caches
    const cacheKeys = [`resources:mine:${resource.uploadedBy}`];
    if (resource.group) cacheKeys.push(`resources:group:${resource.group}`);
    if (resource.scope === 'admin') cacheKeys.push('resources:admin');
    await delCache(...cacheKeys);

    res.json({ message: 'Resource deleted' });
  } catch (err) { next(err); }
};

// ── Get resource text for AI question generation (lazy parse) ─────────────
export const getResourceText = async (req, res, next) => {
  try {
    const resource = await Resource.findById(req.params.id)
      .select('cloudinaryUrl cloudinaryPublicId title scope group uploadedBy mimetype originalName');
    if (!resource) return next(new AppError('Resource not found', 404));

    const isAdmin = req.user.role === 'admin';
    if (resource.scope === 'admin') {
      // Admin resources are available to all logged-in instructors/admins
    } else {
      const isOwner = resource.uploadedBy.toString() === req.user._id.toString();
      if (!isOwner && !isAdmin) return next(new AppError('Not authorized', 403));
    }

    if (!resource.cloudinaryUrl) {
      return next(new AppError('Resource file not available', 404));
    }

    // Download file from Cloudinary and parse text on demand
    const buffer = await downloadStoredResourceBuffer({
      cloudinaryUrl: resource.cloudinaryUrl,
      cloudinaryPublicId: resource.cloudinaryPublicId,
    });

    let text = '';
    let pages = 0;
    try {
      const extracted = await extractTextFromResourceBuffer(buffer, resource.originalName, resource.mimetype);
      const raw = extracted.text || '';
      const isPdf = (resource.originalName || '').toLowerCase().endsWith('.pdf')
        || (resource.mimetype || '').toLowerCase() === 'application/pdf';
      const normalized = isPdf ? cleanPdfExtractedText(raw) : (extracted.usedOcr ? cleanOcrExtractedText(raw) : cleanExtractedText(raw));
      text = normalized.slice(0, 60000);
      pages = extracted.pages || 0;
    } catch (e) {
      if (e.code === 'LEGACY_PPT') {
        return next(new AppError('Legacy .ppt is not supported. Save as .pptx and upload again.', 422));
      }
      if (e.code === 'PDF_SCANNED') {
        return next(new AppError(e.message || 'This PDF appears to be scanned or image-based. Upload Word (.docx) or a text-based PDF.', 422));
      }
      if (
        e.code === 'PDF_NOT_SUPPORTED'
        || e.code === 'EXTRACTION_FAILED'
        || e.code === 'PDF_MALFORMED'
        || e.code === 'PDF_ENCRYPTED'
        || e.code === 'PDF_RUNTIME'
      ) {
        return next(new AppError(e.message || 'This PDF could not be processed.', 422));
      }
      logger.warn(`[Resource] Text extract failed for ${resource._id}: ${e.message}`);
      return next(new AppError('Could not read text from this file.', 422));
    }

    if (!text || text.length < 20) {
      return next(new AppError(
        (resource.originalName || '').toLowerCase().endsWith('.pdf')
          ? 'This PDF appears to be scanned or image-based. For best results, upload a Word file or text-based PDF.'
          : 'This file does not contain enough readable text.',
        422,
      ));
    }

    res.json({ text, title: resource.title, pages, chars: text.length });
  } catch (err) { next(err); }
};

// ── Processing status (for AI indexing UI + polling) ──────────────────────
export const getResourceProcessingStatus = async (req, res, next) => {
  try {
    const resource = await Resource.findById(req.params.id).select(
      'title processingStatus processingStageLabel processingFailedStage processingErrorCode processingErrorMessage chunkCount extractedCharCount structureOutline processedAt scope uploadedBy embeddingModel pages',
    );
    if (!resource) return next(new AppError('Resource not found', 404));

    if (resource.scope === 'admin') {
      if (!canUseInstructorResourceApis(req.user)) return next(new AppError('Not authorized', 403));
    } else {
      const isOwner = resource.uploadedBy.toString() === req.user._id.toString();
      if (!isOwner && req.user.role !== 'admin') return next(new AppError('Not authorized', 403));
    }

    const processingStatus = resource.processingStatus || 'ready';

    res.json({
      processingStatus,
      processingStageLabel: resource.processingStageLabel || '',
      chunkCount: resource.chunkCount || 0,
      extractedCharCount: resource.extractedCharCount || 0,
      pages: resource.pages || 0,
      embeddingModel: resource.embeddingModel || '',
      processedAt: resource.processedAt,
      structureOutline: (resource.structureOutline || []).slice(0, 40),
      error: resource.processingStatus === 'failed' ? {
        code: resource.processingErrorCode || 'FAILED',
        message: resource.processingErrorMessage || 'Processing failed.',
        stage: resource.processingFailedStage || undefined,
      } : null,
    });
  } catch (err) { next(err); }
};

// ── Retry failed / stale processing ────────────────────────────────────────
export const retryResourceProcessing = async (req, res, next) => {
  try {
    const resource = await Resource.findById(req.params.id);
    if (!resource) return next(new AppError('Resource not found', 404));
    const isOwner = resource.uploadedBy.toString() === req.user._id.toString();
    if (!isOwner && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }
    const hasStoredFile = Boolean(resource.cloudinaryUrl || resource.cloudinaryPublicId);
    if (!hasStoredFile) {
      const hint = isCloudinaryConfigured()
        ? 'The original file was not saved to storage. Please upload the file again.'
        : 'File storage is not configured on the server. Please upload the file again.';
      return next(new AppError(hint, 404, { code: 'NO_STORED_FILE' }));
    }

    await Resource.findByIdAndUpdate(resource._id, {
      processingStatus: 'processing',
      processingErrorCode: '',
      processingErrorMessage: '',
      processingStageLabel: 'Reading your resource…',
      processingFailedStage: '',
    });

    if (process.env.VERCEL) {
      try {
        await processResourceDocument(resource._id);
      } catch (procErr) {
        logger.error(`[Resource] Inline retry error for ${resource._id}: ${procErr.message}`);
      }
    } else {
      enqueueResourceProcessing(resource._id);
    }

    const cacheKeys = [`resources:mine:${resource.uploadedBy}`];
    if (resource.group) cacheKeys.push(`resources:group:${resource.group}`);
    if (resource.scope === 'admin') cacheKeys.push('resources:admin');
    await delCache(...cacheKeys);

    res.json({ ok: true, processingStatus: 'processing' });
  } catch (err) { next(err); }
};

// ── Admin: list ALL resources ─────────────────────────────────────────────
export const adminListResources = async (req, res, next) => {
  try {
    const resources = await Resource.find({ scope: 'admin' })
      .populate('uploadedBy', 'name email role')
      .sort({ createdAt: -1 });
    res.json({ resources });
  } catch (err) { next(err); }
};
