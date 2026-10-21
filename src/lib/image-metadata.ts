import type { ImageType } from '../modules/media/object-storage';

/**
 * Removes the hidden data a phone writes into a photo (GPS position, camera serial, time taken, thumbnails, free-text comments)
 * without decoding the picture. Used on photos people contribute, which are kept far longer than a diary photo and end up in
 * training data. A JPEG's rotation tag is kept, as the only piece of metadata the picture needs to be shown upright.
 *
 * A file it cannot read as far as the picture data (not a real photo) is stored as it came: there is nothing to say what is in it.
 */
export function stripMetadata(bytes: Uint8Array, type: ImageType): Uint8Array {
  if (type === 'image/jpeg') return stripJpeg(bytes);
  if (type === 'image/png') return stripPng(bytes);
  return stripWebp(bytes);
}

const DROP_JPEG = new Set([0xe1, 0xed, 0xfe]); // APP1 (Exif, XMP), APP13 (Photoshop), comments

function stripJpeg(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const kept: Uint8Array[] = [];
  let orientation: number | null = null;
  let i = 2;
  let rest: Uint8Array | null = null; // the picture data itself, from the start-of-scan marker to the end of the file
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xda) {
      rest = b.subarray(i);
      break;
    }
    if (marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > b.length) break;
    const end = i + 2 + ((b[i + 2]! << 8) | b[i + 3]!);
    if (end > b.length || end < i + 4) break;
    if (marker === 0xe1) orientation ??= exifOrientation(b.subarray(i + 4, end));
    if (!DROP_JPEG.has(marker)) kept.push(b.subarray(i, end));
    i = end;
  }
  // Never reached the picture data: not a file we understand, so we cannot say what is in it. Leave it as it is.
  if (!rest) return b;
  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  const first = kept[0];
  const startsWithJfif = first !== undefined && first[1] === 0xe0;
  if (startsWithJfif) parts.push(kept.shift()!);
  if (orientation !== null && orientation >= 1 && orientation <= 8)
    parts.push(orientationOnlyExif(orientation));
  parts.push(...kept);
  parts.push(rest);
  return concat(parts);
}

/** Orientation (1 to 8) from an Exif block, or null. `data` starts at "Exif\0\0". */
function exifOrientation(data: Uint8Array): number | null {
  if (data.length < 14 || String.fromCharCode(...data.subarray(0, 4)) !== 'Exif') return null;
  const tiff = data.subarray(6);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return null;
  const count = view.getUint16(ifd, little);
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > tiff.length) return null;
    if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
  }
  return null;
}

/** A complete, minimal Exif block that says only how to rotate the picture. */
function orientationOnlyExif(orientation: number): Uint8Array {
  const out = new Uint8Array(2 + 2 + 6 + 8 + 2 + 12 + 4);
  const v = new DataView(out.buffer);
  out.set([0xff, 0xe1]);
  v.setUint16(2, out.length - 2);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  out.set([0x4d, 0x4d, 0, 0x2a], 10); // big endian, 42
  v.setUint32(14, 8); // first directory follows the header
  v.setUint16(18, 1); // one entry
  v.setUint16(20, 0x0112); // Orientation
  v.setUint16(22, 3); // SHORT
  v.setUint32(24, 1); // count
  v.setUint16(28, orientation);
  return out; // the next-directory offset is already 0
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const DROP_PNG = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(b: Uint8Array): Uint8Array {
  if (b.length < 8 || PNG_SIGNATURE.some((x, i) => b[i] !== x)) return b;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  while (i + 12 <= b.length) {
    const end = i + 12 + view.getUint32(i);
    if (end > b.length) break;
    if (!DROP_PNG.has(String.fromCharCode(...b.subarray(i + 4, i + 8)))) parts.push(b.subarray(i, end));
    i = end;
  }
  return concat(parts);
}

function stripWebp(b: Uint8Array): Uint8Array {
  const tag = (at: number) => String.fromCharCode(...b.subarray(at, at + 4));
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return b;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunks: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const size = view.getUint32(i + 4, true);
    const end = Math.min(i + 8 + size + (size & 1), b.length);
    const name = tag(i);
    if (name !== 'EXIF' && name !== 'XMP ') {
      const chunk = b.slice(i, end);
      if (name === 'VP8X' && chunk.length > 8) chunk[8]! &= ~0x0c; // the flags that announce Exif and XMP data
      chunks.push(chunk);
    }
    i = end;
  }
  const body = concat(chunks);
  const out = new Uint8Array(12 + body.length);
  out.set(b.subarray(0, 12));
  out.set(body, 12);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
