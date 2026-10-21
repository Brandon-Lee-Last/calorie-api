import { describe, expect, it } from 'vitest';
import { ipAllowed, ipMatches, isValidIpRule } from './ip';

describe('ip rules', () => {
  it('validates rules', () => {
    for (const ok of ['203.0.113.9', '203.0.113.0/24', '0.0.0.0/0', '2001:db8::1', '10.0.0.1/32'])
      expect(isValidIpRule(ok), ok).toBe(true);
    for (const bad of [
      '',
      'abc',
      '999.1.1.1',
      '1.2.3',
      '1.2.3.4/33',
      '1.2.3.4/x',
      '1.2.3.4/24/8',
      '2001:db8::/32',
      'hello:world',
    ])
      expect(isValidIpRule(bad), bad).toBe(false);
  });
  it('matches exact addresses and IPv4 ranges', () => {
    expect(ipMatches('203.0.113.9', '203.0.113.9')).toBe(true);
    expect(ipMatches('203.0.113.10', '203.0.113.9')).toBe(false);
    expect(ipMatches('203.0.113.200', '203.0.113.0/24')).toBe(true);
    expect(ipMatches('203.0.114.1', '203.0.113.0/24')).toBe(false);
    expect(ipMatches('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipMatches('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipMatches('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(ipMatches('255.255.255.255', '255.255.255.255/32')).toBe(true);
  });
  it('matches IPv6 exactly, ignoring case, and never against an IPv4 rule', () => {
    expect(ipMatches('2001:DB8::1', '2001:db8::1')).toBe(true);
    expect(ipMatches('2001:db8::2', '2001:db8::1')).toBe(false);
    expect(ipMatches('2001:db8::1', '203.0.113.0/24')).toBe(false);
    expect(ipMatches('unknown', '203.0.113.0/24')).toBe(false);
    expect(ipMatches('', '203.0.113.0/24')).toBe(false);
  });
  it('allows if any rule matches', () => {
    expect(ipAllowed('10.0.0.5', ['192.168.0.0/16', '10.0.0.0/24'])).toBe(true);
    expect(ipAllowed('10.0.1.5', ['192.168.0.0/16', '10.0.0.0/24'])).toBe(false);
    expect(ipAllowed('10.0.0.5', [])).toBe(false);
  });
});
