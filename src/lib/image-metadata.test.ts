import { describe, expect, it } from 'vitest';
import { stripMetadata } from './image-metadata';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const seg = (marker: number, payload: number[]) => [
  0xff,
  marker,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 255,
  ...payload,
];
const text = (b: Uint8Array) => String.fromCharCode(...b);

/** An Exif block (little endian) with Orientation and a GPS pointer, like a phone writes. */
function exif(orientation: number): number[] {
  const tiff = [
    0x49,
    0x49,
    0x2a,
    0,
    8,
    0,
    0,
    0, // header, first directory at 8
    2,
    0, // two entries
    0x12,
    0x01,
    3,
    0,
    1,
    0,
    0,
    0,
    orientation,
    0,
    0,
    0, // Orientation
    0x25,
    0x88,
    4,
    0,
    1,
    0,
    0,
    0,
    0x1a,
    0,
    0,
    0, // GPSInfo pointer
    0,
    0,
    0,
    0,
    ...ascii('GPS-LAT-33.9249S-LON-18.4241E'),
  ];
  return [...ascii('Exif\0\0'), ...tiff];
}

const PICTURE = [0xff, 0xda, 0, 4, 0x11, 0x22, 9, 8, 7, 6, 5, 0xff, 0xd9];
const jfif = seg(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);

describe('stripMetadata: JPEG', () => {
  const photo = (extra: number[][] = []) =>
    Uint8Array.from([0xff, 0xd8, ...jfif, ...extra.flat(), ...seg(0xdb, [1, 2, 3]), ...PICTURE]);

  it('removes the position and device details but keeps the picture and the rotation', () => {
    const out = stripMetadata(
      photo([
        seg(0xe1, exif(6)),
        seg(0xe1, [
          ...ascii('http://ns.adobe.com/xap/1.0/\0'),
          ...ascii('<x:xmpmeta>serial 12345</x:xmpmeta>'),
        ]),
        seg(0xed, ascii('Photoshop 3.0 secret')),
        seg(0xfe, ascii('shot by Alice in Cape Town')),
      ]),
      'image/jpeg',
    );
    const s = text(out);
    for (const secret of ['GPS', '33.9249', 'serial', 'Photoshop', 'Alice', 'Cape Town', 'xmpmeta'])
      expect(s).not.toContain(secret);
    expect(s).toContain('JFIF');
    expect([...out.slice(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.slice(-13)]).toEqual(PICTURE); // the scan data and end marker are untouched
    // the one thing kept: Orientation = 6, in a block that says nothing else
    const at = s.indexOf('Exif');
    expect(at).toBeGreaterThan(0);
    const block = out.slice(at - 4, at - 4 + 34);
    expect(block.length).toBe(34);
    expect(text(out.slice(at + 6, at + 8))).toBe('MM');
    expect(out[at - 4 + 28]).toBe(0); // entry value, big endian
    expect(out[at - 4 + 29]).toBe(6);
  });
  it('leaves no rotation block at all when there was no rotation', () => {
    const out = stripMetadata(
      photo([seg(0xe1, [...ascii('Exif\0\0'), 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0])]),
      'image/jpeg',
    );
    expect(text(out)).not.toContain('Exif');
  });
  it('ignores a rotation value that makes no sense', () => {
    expect(text(stripMetadata(photo([seg(0xe1, exif(99))]), 'image/jpeg'))).not.toContain('Exif');
  });
  it('reads big-endian rotation tags too', () => {
    const be = [
      ...ascii('Exif\0\0'),
      0x4d,
      0x4d,
      0,
      0x2a,
      0,
      0,
      0,
      8,
      0,
      1,
      0x01,
      0x12,
      0,
      3,
      0,
      0,
      0,
      1,
      0,
      3,
      0,
      0,
      0,
      0,
      0,
      0,
    ];
    const out = stripMetadata(photo([seg(0xe1, be)]), 'image/jpeg');
    const at = text(out).indexOf('Exif');
    expect(out[at - 4 + 29]).toBe(3);
  });
  it('is a no-op on a photo that carries nothing', () => {
    const clean = photo();
    expect([...stripMetadata(clean, 'image/jpeg')]).toEqual([...clean]);
  });
  it('survives truncated or odd files without throwing', () => {
    const cases = [
      Uint8Array.of(),
      Uint8Array.of(0xff),
      Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5), // segment longer than the file
      Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0, 1), // segment length too small
      Uint8Array.of(0xff, 0xd8, 0x00, 0x01, 0x02),
      Uint8Array.of(0xff, 0xd8, 0xff, 0xff, 0xff, 0xd8, 0xff, 0xd9),
      Uint8Array.of(0x00, 0x01, 0x02, 0x03),
      Uint8Array.from([0xff, 0xd8, ...seg(0xe1, [...ascii('Exif\0\0'), 0x49, 0x49])]), // Exif block cut short
      Uint8Array.from([
        0xff,
        0xd8,
        ...seg(0xe1, [...ascii('Exif\0\0'), 0x49, 0x49, 0x2a, 0, 0xff, 0xff, 0xff, 0x7f, 1, 2]),
      ]), // directory points outside
      Uint8Array.from([
        0xff,
        0xd8,
        ...seg(0xe1, [...ascii('Exif\0\0'), 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 200, 0, 1, 2]),
      ]), // claims 200 entries
      Uint8Array.from([0xff, 0xd8, ...seg(0xe1, [...ascii('Exif\0\0'), 0x58, 0x58, 0x2a, 0, 8, 0, 0, 0])]), // unknown byte order
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd0, 0xff, 0x01, ...PICTURE]), // stand-alone markers
    ];
    for (const c of cases) expect(() => stripMetadata(c, 'image/jpeg')).not.toThrow();
    const odd = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5);
    expect([...stripMetadata(odd, 'image/jpeg')]).toEqual([...odd]); // not a real photo: stored as it came
  });
});

describe('stripMetadata: PNG', () => {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, data: number[]) => [...u32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
  const png = Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
    ...chunk('eXIf', ascii('GPS 33.9S')),
    ...chunk('tEXt', ascii('Author\0Alice')),
    ...chunk('iTXt', ascii('XML:com.adobe.xmp\0serial')),
    ...chunk('tIME', [7, 234, 10, 21, 12, 0, 0]),
    ...chunk('IDAT', [1, 2, 3, 4]),
    ...chunk('IEND', []),
  ]);
  it('drops text, time and Exif chunks and keeps the picture', () => {
    const s = text(stripMetadata(png, 'image/png'));
    for (const gone of ['eXIf', 'tEXt', 'iTXt', 'tIME', 'GPS', 'Alice', 'serial'])
      expect(s).not.toContain(gone);
    for (const kept of ['IHDR', 'IDAT', 'IEND']) expect(s).toContain(kept);
  });
  it('copes with a truncated chunk and with non-PNG bytes', () => {
    const cut = png.slice(0, png.length - 30);
    expect(() => stripMetadata(cut, 'image/png')).not.toThrow();
    const junk = Uint8Array.of(1, 2, 3);
    expect([...stripMetadata(junk, 'image/png')]).toEqual([1, 2, 3]);
  });
});

describe('stripMetadata: WebP', () => {
  const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const chunk = (name: string, data: number[]) => [
    ...ascii(name),
    ...u32le(data.length),
    ...data,
    ...(data.length % 2 ? [0] : []),
  ];
  const body = [
    ...chunk('VP8X', [0x2c, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // animation-free, with ICC (0x20) + Exif (0x08) + XMP (0x04) flags
    ...chunk('VP8 ', [1, 2, 3, 4, 5]),
    ...chunk('EXIF', ascii('GPS 33.9S')),
    ...chunk('XMP ', ascii('serial 1')),
  ];
  const webp = Uint8Array.from([...ascii('RIFF'), ...u32le(4 + body.length), ...ascii('WEBP'), ...body]);
  it('drops Exif and XMP, clears the flags that announce them, and fixes the length', () => {
    const out = stripMetadata(webp, 'image/webp');
    const s = text(out);
    expect(s).not.toContain('EXIF');
    expect(s).not.toContain('GPS');
    expect(s).not.toContain('serial');
    expect(s).toContain('VP8 ');
    expect(out[20]).toBe(0x20); // 0x2c with the Exif and XMP bits cleared
    const length = out[4]! | (out[5]! << 8) | (out[6]! << 16) | (out[7]! << 24);
    expect(length).toBe(out.length - 8);
  });
  it('copes with non-WebP bytes', () => {
    expect([...stripMetadata(Uint8Array.of(1, 2, 3), 'image/webp')]).toEqual([1, 2, 3]);
  });
});
