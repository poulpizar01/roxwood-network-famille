/**
 * @file src/api/week.ts
 * @description Résolution de `?week=` (semaine ISO 8601, ex. `2026-W37`) en
 * plage `[since, until)` ms epoch — partagé entre les groupes de routes qui
 * naviguent sur une semaine passée (`quotas`, `ventes`, voir
 * `src/api/routes/`). Une seule implémentation, pas une par groupe.
 */
import type { Request, Response } from 'express';
import * as db from '../db';

export interface WeekRange {
  since: number;
  until: number;
}

/** Parse `2026-W37` (lundi 00:00 UTC → lundi suivant) en `{ since, until }` ms epoch — `null` si mal formé ou hors plage (semaine 1-53). */
export function parseIsoWeek(weekStr: string): WeekRange | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekStr);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;

  // Le 4 janvier est toujours en semaine 1 (définition ISO 8601) — on part de
  // son lundi, puis on avance de (week - 1) semaines.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // dimanche (0) → 7, pour que lundi=1..dimanche=7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));

  const since = new Date(week1Monday);
  since.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const until = new Date(since);
  until.setUTCDate(since.getUTCDate() + 7);
  return { since: since.getTime(), until: until.getTime() };
}

/**
 * Résout `?week=` en plage, ou la semaine en cours (depuis le dernier reset
 * hebdo) si absent. Répond directement 400 et renvoie `null` si `week` est
 * présent mais mal formé — à tester par l'appelant avant de continuer.
 */
export async function resolveWeekRange(req: Request, res: Response): Promise<WeekRange | null> {
  const weekParam = req.query.week;
  if (weekParam === undefined) {
    const since = Number((await db.getSetting('last_weekly_reset')) || 0);
    return { since, until: Date.now() };
  }
  const range = parseIsoWeek(String(weekParam));
  if (!range) {
    res.status(400).json({ error: 'week invalide — format attendu : AAAA-Www (ex. 2026-W37).' });
    return null;
  }
  return range;
}
