/**
 * @file src/paris-time.ts
 * @description Calculs d'heure de Paris indépendants du fuseau du serveur —
 * le reset hebdomadaire (dimanche 19h Europe/Paris) et la résolution de
 * `?week=` côté API reposent sur les mêmes bornes, calculées ici une seule fois.
 */

/**
 * Reformate `date` en heure de Paris puis reparse la chaîne obtenue comme si
 * elle était locale au serveur : le `Date` renvoyé a donc des champs
 * (`getHours`/`getDay`/`setHours`/`setDate`...) qui reflètent l'heure de Paris,
 * quel que soit le fuseau du serveur qui exécute le process. Le format
 * `en-US` produit une chaîne (`MM/DD/YYYY, HH:mm:ss`) que `new Date(...)`
 * sait reparser de façon fiable.
 */
export function parisWallClock(date: Date): Date {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  return new Date(fmt.format(date));
}

/**
 * Instant UTC correspondant à une heure murale de Paris — le décalage
 * (heure d'hiver/d'été) est celui de Paris à cette date, pas celui du serveur.
 */
export function parisWallToUtc(year: number, month: number, day: number, hour: number): number {
  const guess = Date.UTC(year, month, day, hour);
  const offsetAt = (ts: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Paris', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ts));
    const get = (type: string) => Number(parts.find(part => part.type === type)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - ts;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

/** Au-delà, les semaines manquées les plus anciennes sont regroupées en une seule période (bot arrêté des mois). */
const MAX_WEEKS_BACK = 12;

/**
 * Frontières de reset hebdomadaire (dimanche 19h, heure de Paris) postérieures
 * à `afterMs` et passées à `nowMs`, de la plus ancienne à la plus récente — vide
 * si aucun reset n'est dû. Plusieurs frontières quand le bot a manqué
 * plusieurs dimanches : chaque semaine close est alors publiée séparément.
 */
export function weeklyBoundariesBetween(afterMs: number, nowMs: number): number[] {
  const wall = parisWallClock(new Date(nowMs));
  const sunday = new Date(wall);
  sunday.setHours(19, 0, 0, 0);
  sunday.setDate(sunday.getDate() - sunday.getDay());
  if (sunday.getTime() > wall.getTime()) sunday.setDate(sunday.getDate() - 7);

  const boundaries: number[] = [];
  for (let i = 0; i < MAX_WEEKS_BACK; i++) {
    const utc = parisWallToUtc(sunday.getFullYear(), sunday.getMonth(), sunday.getDate(), 19);
    if (utc <= afterMs) break;
    boundaries.unshift(utc);
    sunday.setDate(sunday.getDate() - 7);
  }
  return boundaries;
}
