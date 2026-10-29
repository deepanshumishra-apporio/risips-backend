// Selfie and signature images. Stored under uploads/ with random names; served only through signed links that expire,
// so an image can't be fetched by guessing or by reusing an old link. The app shows whatever URL /me returns.
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config/env.ts';
import { ApiError } from '../utils/errors.ts';
import { hmacHex, randomHex, safeEqual } from '../utils/crypto.ts';

fs.mkdirSync(paths.uploads, { recursive: true });

// 32 hex since 2026-10-26 (the JS backend's fae8d25); files saved before that have 8, and must keep loading.
export const FILE_NAME_RE = /^\d+_(selfie|signature)_(?:[a-f0-9]{32}|[a-f0-9]{8})\.(png|jpg)$/;
const MAX_BYTES = 8 * 1024 * 1024;
const LINK_HOURS = 2;

/** Saves a data:image/png|jpeg;base64 URL; returns the stored file name. */
export function saveImage(userId: number, kind: 'selfie' | 'signature', dataUrl: string): string {
  const m = String(dataUrl || '').match(/^data:image\/(png|jpe?g);base64,(.+)$/);
  if (!m) throw new ApiError(400, 'Invalid image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 500 || buf.length > MAX_BYTES) throw new ApiError(400, 'Image is too small or too large.');
  // the bytes must really be the image type claimed (PNG / JPEG magic numbers)
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (m[1] === 'png' ? !png : !jpg) throw new ApiError(400, 'Invalid image.');
  const name = `${userId}_${kind}_${randomHex(16)}.${m[1] === 'png' ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(paths.uploads, name), buf);
  return name;
}

const sign = (name: string, exp: number) => hmacHex(config.appSecret, `file:${name}:${exp}`);

/** A link to the file that works for 1-2 hours (it ends on an hour boundary, so it is stable for the app's cache). */
export function signedFileUrl(name: string | null | undefined): string | null {
  if (!name) return null;
  const exp = (Math.floor(Date.now() / 3600e3) + LINK_HOURS) * 3600;
  return `/files/${name}?exp=${exp}&sig=${sign(name, exp)}`;
}

/** The file's path when the link is valid and unexpired, else null (served as a 404 either way). */
export function resolveSignedFile(name: string, exp: number, sig: string): string | null {
  if (!FILE_NAME_RE.test(name) || !(exp * 1000 > Date.now()) || !safeEqual(sig, sign(name, exp))) return null;
  const f = path.join(paths.uploads, name);
  return fs.existsSync(f) ? f : null;
}
