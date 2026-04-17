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
    return result.secure_url;
  } catch (err) {
    logger.error(`[Cloudinary] Upload failed: ${err.message}`);
    return null;
  }
};
