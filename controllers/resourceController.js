import { AppError } from '../middleware/errorHandler.js';
import Group from '../models/Group.js';
import Resource from '../models/Resource.js';
import ResourceChunk from '../models/ResourceChunk.js';
import { deleteCloudinaryResource, downloadStoredResourceBuffer } from '../services/cloudinaryService.js';
import { cleanExtractedText, cleanOcrExtractedText, cleanPdfExtractedText } from '../services/resourceChunkingService.js';
import { enqueueResourceProcessing } from '../services/resourceProcessingService.js';
import { extractTextFromResourceBuffer } from '../services/resourceTextExtraction.js';
import logger from '../utils/logger.js';
import { delCache, getCache, setCache } from '../services/cacheService.js';

function canUseInstructorResourceApis(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Boolean(user.isInstructor) || ['instructor', 'principal'].includes(user.role);
}

// ── Upload a resource (admin or instructor) ────────────────────────────────
export const uploadResource = async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No file uploaded', 400));
    const lowerName = (req.file.originalname || '').toLowerCase();
    const { title, groupId, subject: subjectRaw } = req.body;
    if (!title?.trim()) return next(new AppError('Title is required', 400));
    const subject = typeof subjectRaw === 'string' ? subjectRaw.trim().slice(0, 200) : '';

    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && !canUseInstructorResourceApis(req.user)) return next(new AppError('Not authorized', 403));

    // Instructor uploads: optional groupId — when omitted, file is a personal library resource (e.g. exam creation / school mode).
    let group = null;
    if (!isAdmin) {
      if (groupId) {
        group = await Group.findById(groupId);
        if (!group) return next(new AppError('Group not found', 404));
        if (group.instructor.toString() !== req.user._id.toString()) {
          return next(new AppError('Not your group', 403));
        }
      }
    }

    // Process from multer buffer first; Cloudinary is storage-only after indexing succeeds.
    const fileBuffer = Buffer.from(req.file.buffer);

    const resource = await Resource.create({
      title: title.trim(),
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
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

    res.status(201).json({ resource });

    enqueueResourceProcessing(resource._id, { fileBuffer });

    // Invalidate caches after response is sent
    const cacheKeys = [`resources:mine:${req.user._id}`];
    if (group) cacheKeys.push(`resources:group:${group._id}`);
    if (isAdmin) cacheKeys.push('resources:admin');
    delCache(...cacheKeys).catch(() => {});
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
    if (!resource.cloudinaryUrl && !resource.cloudinaryPublicId) {
      return next(new AppError(
        'This resource has no stored file to retry from. Please upload the file again.',
        404,
      ));
    }

    await Resource.findByIdAndUpdate(resource._id, {
      processingStatus: 'processing',
      processingErrorCode: '',
      processingErrorMessage: '',
      processingStageLabel: 'Reading your resource…',
      processingFailedStage: '',
    });

    enqueueResourceProcessing(resource._id);

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
