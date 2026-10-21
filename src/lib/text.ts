/** Lowercase, strip accents and punctuation, collapse spaces. Used for matching food names ("Droëwors" finds "droewors"). */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape `%`, `_` and the escape character so user text is matched literally inside LIKE ... ESCAPE '\'. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
