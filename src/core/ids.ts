const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

/**
 * Time-sortable 26-character id (ULID layout: 48-bit ms timestamp + 80 random bits).
 * Sorting ids as strings sorts by creation time, which keeps D1 primary-key inserts mostly sequential.
 */
export function newId(now: number = Date.now(), random: (n: number) => Uint8Array = randomBytes): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(10);
  let bits = 0;
  let value = 0;
  let rand = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      rand += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return time + rand;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s);

/** Client-generated ids may be a ULID or a UUID, so either is accepted for synced records. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isClientId = (s: unknown): s is string => isId(s) || (typeof s === 'string' && UUID_RE.test(s));
