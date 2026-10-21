import { describe, expect, it } from 'vitest';
import { compareVersions, formatVersion, parseVersion } from './semver';

describe('parseVersion', () => {
  it('reads plain, short, prefixed and build-suffixed versions', () => {
    expect(parseVersion('1.4.2')).toEqual([1, 4, 2]);
    expect(parseVersion('1.4')).toEqual([1, 4, 0]);
    expect(parseVersion('v2.0.10')).toEqual([2, 0, 10]);
    expect(parseVersion(' 3.1.0 (build 87)')).toEqual([3, 1, 0]);
    expect(parseVersion('1.2.3-beta.1')).toEqual([1, 2, 3]);
    expect(parseVersion('0.0.0')).toEqual([0, 0, 0]);
  });
  it('rejects everything else', () => {
    for (const bad of [null, undefined, '', 'abc', '1', '1.', '1.x.3', '1.2.3.4', '-1.2.3', '1234567.0.0'])
      expect(parseVersion(bad)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(compareVersions([1, 2, 3], [1, 2, 4])).toBe(-1);
    expect(compareVersions([1, 3, 0], [1, 2, 9])).toBe(1);
    expect(compareVersions([2, 0, 0], [1, 99, 99])).toBe(1);
    expect(compareVersions([1, 10, 0], [1, 9, 0])).toBe(1); // numbers, not text
  });
  it('formats', () => expect(formatVersion([1, 4, 0])).toBe('1.4.0'));
});
