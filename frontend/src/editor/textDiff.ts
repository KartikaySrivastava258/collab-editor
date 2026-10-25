/**
 * Computes the single contiguous edit that turns `before` into `after`.
 *
 * The editor lets the browser perform every kind of text input (typing,
 * selection replacement, paste, cut, IME, autocorrect, emoji pickers, drag and
 * drop) and then derives the edit from the textarea's value. One code path
 * for every kind of input is what keeps paste, IME and emoji reliable.
 *
 * `caret` (the selection end after the edit) disambiguates repeated text:
 * typing "a" into "aa" at the end must insert after the second "a".
 * Boundaries never split a UTF-16 surrogate pair.
 */
export interface TextEdit {
  /** UTF-16 offset where the change starts (same in before and after). */
  start: number;
  /** UTF-16 units removed from `before`. */
  removed: number;
  /** Text inserted at `start`. */
  inserted: string;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

export function diffText(before: string, after: string, caret = after.length): TextEdit | null {
  if (before === after) return null;
  const bl = before.length;
  const al = after.length;
  // Common suffix, limited so it does not reach left of the caret in `after`.
  const maxSuffix = Math.min(bl, Math.max(0, al - Math.min(Math.max(caret, 0), al)));
  let s = 0;
  while (s < maxSuffix && before.charCodeAt(bl - 1 - s) === after.charCodeAt(al - 1 - s)) s++;
  // Common prefix in what remains.
  const maxPrefix = Math.min(bl - s, al - s);
  let p = 0;
  while (p < maxPrefix && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  // Never split a surrogate pair.
  if (p > 0 && isHigh(before.charCodeAt(p - 1))) p--;
  if (s > 0 && isLow(before.charCodeAt(bl - s))) s--;
  return { start: p, removed: bl - s - p, inserted: after.slice(p, al - s) };
}

/** UTF-16 offset → index in the code-point array of `text`. */
export function utf16ToCodePointIndex(text: string, offset: number): number {
  let idx = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isHigh(c) && i + 1 < text.length && isLow(text.charCodeAt(i + 1))) i++;
    idx++;
  }
  return idx;
}

/** Code-point index → UTF-16 offset, given the code-point values. */
export function codePointIndexToUtf16(values: readonly string[], index: number): number {
  let off = 0;
  const n = Math.min(index, values.length);
  for (let i = 0; i < n; i++) off += values[i].length;
  return off;
}
