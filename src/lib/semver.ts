export type Version = [number, number, number];

/** "1.4.2", "1.4" or "1.4.2 (build 87)" -> [1, 4, 2]. Anything else is not a version. */
export function parseVersion(text: string | null | undefined): Version | null {
  const m = /^\s*v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?(?![\d.])/.exec(text ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

export const formatVersion = (v: Version) => v.join('.');
