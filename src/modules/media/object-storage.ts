import { badRequest, payloadTooLarge } from '../../core/errors';

export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
export type ImageType = keyof typeof IMAGE_TYPES;

/** What the first bytes of a file say it is, regardless of what the client claimed. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'image/png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Validate an uploaded image: size limit, and real image bytes whose type matches the declared one. */
export async function readImageUpload(
  req: Request,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; type: ImageType }> {
  const declared = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (!declared || !(declared in IMAGE_TYPES))
    throw badRequest('Send the image as image/jpeg, image/png or image/webp');
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > maxBytes) throw payloadTooLarge(`Images may be at most ${Math.floor(maxBytes / 1024)} KB`);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0) throw badRequest('The image is empty');
  if (bytes.length > maxBytes)
    throw payloadTooLarge(`Images may be at most ${Math.floor(maxBytes / 1024)} KB`);
  const actual = sniffImageType(bytes);
  if (actual !== declared) throw badRequest('The file is not the image type it claims to be');
  return { bytes, type: actual };
}

/** The Worker's R2 bucket, with the few operations the API needs. Keys are decided by callers, never by clients. */
export class ObjectStorage {
  constructor(private bucket: R2Bucket) {}

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } });
  }

  get(key: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(key);
  }

  head(key: string): Promise<R2Object | null> {
    return this.bucket.head(key);
  }

  getRange(key: string, range: { offset: number; length: number }): Promise<R2ObjectBody | null> {
    return this.bucket.get(key, { range });
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let removed = 0;
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 500 });
      if (page.objects.length) await this.bucket.delete(page.objects.map((o) => o.key));
      removed += page.objects.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return removed;
  }
}
