/**
 * @file src/parse.ts
 * @description Lecture des nombres saisis dans un modal Discord. `parseInt`
 * seul accepterait `12abc` (12) ou `1e5` (1) : un nombre saisi se valide par
 * expression régulière, en un seul endroit.
 */

/** Entier positif ou nul saisi par un membre (espaces de milliers tolérés), ou `null` s'il n'en est pas un ou dépasse `max`. */
export function parseEntier(raw: string, max = Number.MAX_SAFE_INTEGER): number | null {
  const cleaned = raw.replace(/[\s  ]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) && value <= max ? value : null;
}

/** Nombre décimal positif ou nul (virgule ou point), ou `null` s'il n'en est pas un ou dépasse `max`. */
export function parseMontant(raw: string, max: number): number | null {
  const cleaned = raw.replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value <= max ? value : null;
}
