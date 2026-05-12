import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import logger from '../utils/logger.js';

let _configured = false;

const configure = () => {
  if (_configured) return;
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return;
  cloudinary.config({ cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET });
  _configured = true;
};

export const isCloudinaryConfigured = () => {
  configure();
  return _configured;
};

/**
 * Upload a base64 data URI to Cloudinary.
 * Returns the secure URL or null if Cloudinary is not configured or upload fails.
 */
/** @returns {{ secureUrl: string, publicId: string } | null} */
export const uploadScreenshot = async (base64DataUri, folder = 'examprep/screenshots') => {
  if (!isCloudinaryConfigured()) return null;
  try {
    // Ensure data URI has the correct prefix Cloudinary requires
    const uri = base64DataUri.startsWith('data:')
      ? base64DataUri
      : `data:image/jpeg;base64,${base64DataUri}`;

    const result = await cloudinary.uploader.upload(uri, {
      folder,
      resource_type: 'image',
      format: 'jpg',
      quality: 60,
      width: 640,
      height: 480,
      crop: 'limit',
    });
    return { secureUrl: result.secure_url, publicId: result.public_id };
  } catch (err) {
    logger.error(`[Cloudinary] Upload failed: ${err.message}`);
    return null;
  }
};

export const deleteCloudinaryScreenshot = async (publicId) => {
  if (!isCloudinaryConfigured() || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  } catch (err) {
    logger.error(`[Cloudinary] Screenshot delete failed for ${publicId}: ${err.message}`);
  }
};

/**
 * Upload a raw file buffer (PDF/DOC/DOCX) to Cloudinary.
 * Returns { url, publicId } or null on failure.
 */
export const uploadResourceFile = async (buffer, originalName = 'resource', folder = 'examprep/resources') => {
  if (!isCloudinaryConfigured()) return null;
  try {
    const base64 = buffer.toString('base64');
    const ext = originalName.split('.').pop()?.toLowerCase() || 'pdf';
    const mimeMap = {
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      txt: 'text/plain',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    const dataUri = `data:${mime};base64,${base64}`;
    const safePublicId = `${Date.now()}_${originalName.replace(/[^a-z0-9._-]/gi, '_')}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      folder,
      resource_type: 'raw',
      public_id: safePublicId,
    });
    return { url: result.secure_url, publicId: result.public_id };
  } catch (err) {
    logger.error(`[Cloudinary] Resource upload failed: ${err.message}`);
    return null;
  }
};

/**
 * Delete a raw file from Cloudinary by publicId.
 */
export const deleteCloudinaryResource = async (publicId) => {
  if (!isCloudinaryConfigured() || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
  } catch (err) {
    logger.error(`[Cloudinary] Delete failed for ${publicId}: ${err.message}`);
  }
};

/**
 * Used for group chat media.
 * Returns { url, publicId, resourceType } or null.
 */
export const uploadGroupMedia = async (base64DataUri, originalName = 'file') => {
  if (!isCloudinaryConfigured()) return null;
  try {
    const isImage = /^data:image\//i.test(base64DataUri);
    const resourceType = isImage ? 'image' : 'raw';

    const result = await cloudinary.uploader.upload(base64DataUri, {
      folder: 'examprep/group-media',
      resource_type: resourceType,
      ...(isImage ? { quality: 80, width: 1280, crop: 'limit' } : {}),
      public_id: `${Date.now()}_${originalName.replace(/[^a-z0-9._-]/gi, '_')}`,
    });
    return { url: result.secure_url, publicId: result.public_id, resourceType };
  } catch (err) {
    logger.error(`[Cloudinary] Group media upload failed: ${err.message}`);
    return null;
  }
};

/**
 * Upload support ticket attachment from file buffer.
 * Returns { url, publicId, resourceType, originalName } or null.
 */
export const uploadTicketAttachment = async (buffer, mimetype, originalName = 'attachment') => {
  if (!isCloudinaryConfigured() || !buffer) return null;
  try {
    const base64 = buffer.toString('base64');
    const dataUri = `data:${mimetype || 'application/octet-stream'};base64,${base64}`;
    const isImage = /^image\//i.test(mimetype || '');
    const resourceType = isImage ? 'image' : 'raw';
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'examprep/tickets',
      resource_type: resourceType,
      public_id: `${Date.now()}_${originalName.replace(/[^a-z0-9._-]/gi, '_')}`,
      ...(isImage ? { quality: 85, width: 1600, crop: 'limit' } : {}),
    });
    return {
      url: result.secure_url,
      publicId: result.public_id,
      resourceType,
      originalName,
    };
  } catch (err) {
    logger.error(`[Cloudinary] Ticket attachment upload failed: ${err.message}`);
    return null;
  }
};

/**
 * Upload user profile image from file buffer.
 * Returns URL string or null.
 */
export const uploadProfileImage = async (buffer, mimetype, originalName = 'avatar') => {
  if (!isCloudinaryConfigured() || !buffer) return null;
  try {
    const base64 = buffer.toString('base64');
    const dataUri = `data:${mimetype || 'image/jpeg'};base64,${base64}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'examprep/avatars',
      resource_type: 'image',
      public_id: `${Date.now()}_${originalName.replace(/[^a-z0-9._-]/gi, '_')}`,
      width: 512,
      height: 512,
      crop: 'fill',
      gravity: 'face',
      quality: 85,
    });
    return result.secure_url;
  } catch (err) {
    logger.error(`[Cloudinary] Profile image upload failed: ${err.message}`);
    return null;
  }
};

/**
 * Upload exam narration audio (authenticated — use signed URLs for playback).
 * @returns {{ publicId: string } | null}
 */
export const uploadAuthenticatedExamAudio = async (buffer, mimetype = 'audio/wav') => {
  if (!isCloudinaryConfigured() || !buffer) return null;
  try {
    const base64 = buffer.toString('base64');
    const dataUri = `data:${mimetype || 'application/octet-stream'};base64,${base64}`;
    const suffix = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const publicId = `examprep/exam-audio/${Date.now()}_${suffix}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      resource_type: 'video',
      type: 'authenticated',
      public_id: publicId,
    });
    return { publicId: result.public_id };
  } catch (err) {
    logger.error(`[Cloudinary] Exam audio upload failed: ${err.message}`);
    return null;
  }
};

/** Signed short-lived URL for authenticated audio on Cloudinary */
export const signedAuthenticatedMediaUrl = (publicId, ttlSec = 120) => {
  configure();
  if (!publicId || !_configured) return null;
  try {
    const expiresAt = Math.floor(Date.now() / 1000) + Math.max(30, Math.min(3600, ttlSec));
    return cloudinary.url(publicId, {
      resource_type: 'video',
      type: 'authenticated',
      sign_url: true,
      secure: true,
      expires_at: expiresAt,
    });
  } catch (err) {
    logger.error(`[Cloudinary] Signed audio URL failed: ${err.message}`);
    return null;
  }
};
