import https from 'https';
import http from 'http';
import { AppError } from '../middleware/errorHandler.js';
import Group from '../models/Group.js';
import Resource from '../models/Resource.js';
import { deleteCloudinaryResource, uploadResourceFile } from '../services/cloudinaryService.js';
import logger from '../utils/logger.js';
import { delCache, getCache, setCache } from '../services/cacheService.js';

// Lazily import pdf-parse to avoid import-time test file issues
const parsePDFBuffer = async (buffer) => {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  const data = await pdfParse(buffer);
  return { text: data.text?.trim() || '', pages: data.numpages || 0 };
};

// Download a file from a URL and return its buffer
const downloadBuffer = (url) => new Promise((resolve, reject) => {
  const lib = url.startsWith('https') ? https : http;
  lib.get(url, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  }).on('error', reject);
});

// ── Upload a resource (admin or instructor) ────────────────────────────────
export const uploadResource = async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No file uploaded', 400));
    const { title, groupId } = req.body;
    if (!title?.trim()) return next(new AppError('Title is required', 400));

    const isAdmin = req.user.role === 'admin';
    const isInstructor = req.user.isInstructor || ['instructor', 'admin'].includes(req.user.role);
    if (!isAdmin && !isInstructor) return next(new AppError('Not authorized', 403));

    // For instructor uploads, verify group ownership
    let group = null;
    if (!isAdmin) {
      if (!groupId) return next(new AppError('groupId is required for instructor resources', 400));
      group = await Group.findById(groupId);
      if (!group) return next(new AppError('Group not found', 404));
      if (group.instructor.toString() !== req.user._id.toString()) {
        return next(new AppError('Not your group', 403));
      }
    }

    // Upload to Cloudinary (no PDF parsing at upload time)
    const uploaded = await uploadResourceFile(req.file.buffer, req.file.originalname);
    if (!uploaded) return next(new AppError('File upload to storage failed. Please try again.', 502));

    const resource = await Resource.create({
      title: title.trim(),
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      cloudinaryUrl: uploaded.url,
      cloudinaryPublicId: uploaded.publicId,
      uploadedBy: req.user._id,
      scope: isAdmin ? 'admin' : 'instructor',
      group: group ? group._id : null,
    });

    res.status(201).json({ resource });

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
      .select('cloudinaryUrl title scope group uploadedBy mimetype originalName');
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
    const buffer = await downloadBuffer(resource.cloudinaryUrl);

    const ext = resource.originalName?.split('.').pop()?.toLowerCase() || 'pdf';
    let text = '';
    let pages = 0;

    if (ext === 'pdf') {
      try {
        const parsed = await parsePDFBuffer(buffer);
        text = parsed.text.slice(0, 60000); // cap at 60k chars for AI context
        pages = parsed.pages;
      } catch (parseErr) {
        logger.warn(`[Resource] PDF parse failed for ${resource._id}: ${parseErr.message}`);
        return next(new AppError('Could not read text from this PDF. Please ensure it is a text-based PDF.', 422));
      }
    } else {
      // For DOC/DOCX, we don't have a parser — return a helpful message
      return next(new AppError('Text extraction is only supported for PDF files. Please re-upload as PDF.', 422));
    }

    if (!text || text.length < 20) {
      return next(new AppError('This PDF does not contain readable text. Please upload a text-based PDF.', 422));
    }

    res.json({ text, title: resource.title, pages, chars: text.length });
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
