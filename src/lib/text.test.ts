import { describe, expect, it } from 'vitest';
import { BARCODE_RE, canonicalBarcode, isValidGtin } from './barcode';
import { escapeLike, normalizeName } from './text';

describe('normalizeName', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalizeName('  Droëwors  (Beef) ')).toBe('droewors beef');
    expect(normalizeName('Crème Brûlée')).toBe('creme brulee');
    expect(normalizeName("Mrs. Ball's Chutney")).toBe('mrs ball s chutney');
    expect(normalizeName('')).toBe('');
  });
});

describe('escapeLike', () => {
  it('neutralises wildcards', () => {
    expect(escapeLike('100%_pure\\')).toBe('100\\%\\_pure\\\\');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('barcodes', () => {
  it('accepts real GTINs and rejects bad check digits', () => {
    expect(isValidGtin('4006381333931')).toBe(true); // EAN-13
    expect(isValidGtin('036000291452')).toBe(true); // UPC-A
    expect(isValidGtin('96385074')).toBe(true); // EAN-8
    expect(isValidGtin('4006381333932')).toBe(false);
    expect(isValidGtin('12345')).toBe(false);
    expect(isValidGtin('abcdefghijklm')).toBe(false);
    expect(BARCODE_RE.test('123456789')).toBe(false);
  });
  it('turns UPC-A into the 13 digit form', () => {
    expect(canonicalBarcode('036000291452')).toBe('0036000291452');
    expect(canonicalBarcode('4006381333931')).toBe('4006381333931');
  });
});
