import { BadRequestException } from '@nestjs/common';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

export const AVATAR_UPLOAD_DIR = join(process.cwd(), 'uploads', 'avatars');
export const AVATAR_URL_PREFIX = '/uploads/avatars';

mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_AVATAR_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

export const avatarUploadOptions: MulterOptions = {
  storage: diskStorage({
    destination: AVATAR_UPLOAD_DIR,
    filename: (_req, file, callback) => {
      callback(null, `${randomUUID()}${extname(file.originalname)}`);
    },
  }),
  limits: {
    fileSize: MAX_AVATAR_SIZE_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      callback(
        new BadRequestException(
          `Unsupported file type. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`,
        ),
        false,
      );
      return;
    }
    callback(null, true);
  },
};
