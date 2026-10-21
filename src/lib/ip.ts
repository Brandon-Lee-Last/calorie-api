/** "203.0.113.0/24" or "203.0.113.9" or an IPv6 address. IPv6 is matched exactly; IPv4 also supports /bits. */
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function v4ToInt(ip: string): number | null {
  const m = V4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function isValidIpRule(rule: string): boolean {
  const [addr, bits, extra] = rule.split('/');
  if (extra !== undefined || !addr) return false;
  if (v4ToInt(addr) !== null) return bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32);
  return bits === undefined && /^[0-9a-f:]+$/i.test(addr) && addr.includes(':');
}

export function ipMatches(ip: string, rule: string): boolean {
  const [addr, bits] = rule.split('/') as [string, string | undefined];
  const a = v4ToInt(ip);
  const b = v4ToInt(addr);
  if (a === null || b === null) return ip.toLowerCase() === addr.toLowerCase() && bits === undefined;
  const n = bits === undefined ? 32 : Number(bits);
  if (n === 0) return true;
  const mask = (0xffff_ffff << (32 - n)) >>> 0;
  return (a & mask) >>> 0 === (b & mask) >>> 0;
}

export const ipAllowed = (ip: string, rules: string[]) => rules.some((r) => ipMatches(ip, r));
