/** Digits only, 8 (EAN-8), 12 (UPC-A), 13 (EAN-13) or 14 (GTIN-14) long. */
export const BARCODE_RE = /^(\d{8}|\d{12}|\d{13}|\d{14})$/;

/** GTIN check digit: weights 3,1,3,1... from the right of the number without its check digit. */
export function isValidGtin(code: string): boolean {
  if (!BARCODE_RE.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i]! * w;
  return (10 - (sum % 10)) % 10 === check;
}

/** UPC-A is an EAN-13 with a leading zero; store one form so the same product is not cached twice. */
export function canonicalBarcode(code: string): string {
  return code.length === 12 ? `0${code}` : code;
}
