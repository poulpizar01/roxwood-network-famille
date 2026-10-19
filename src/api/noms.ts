/**
 * @file src/api/noms.ts
 * @description Ajoute `name` (nom affichable) aux lignes des routes de groupe
 * — `/api/quotas`, `/api/quotas/pay`, `/api/quotas/ranking`, `/api/ventes`,
 * `/api/armurerie/ammo/history`, `/api/argent/users`. Ces routes renvoyaient déjà à tout membre
 * les `userId` de chaque joueur, comme le classement sur Discord montre les
 * noms de chacun ; un client devait ensuite deviner à qui ils correspondent.
 * Le nom est mis là où il sert, sur la ligne, plutôt que d'exposer la liste
 * complète des comptes (`/api/users` reste réservé aux admins).
 *
 * Priorité au nom en jeu (`/adduser`), sinon le dernier pseudo Discord vu
 * dans une transaction — même source que `db.getKnownUsers`, un seul appel
 * par requête.
 */
import * as db from '../db';

/** `userId` → nom affichable pour toute la guilde (une requête). */
export async function carteNoms(guildId: string): Promise<Map<string, string>> {
  const users = await db.getKnownUsers(guildId);
  return new Map(users.map(u => [u.userId, u.gameName || u.username]));
}

/** Ajoute `name` à chaque ligne portant `userId` (ou la clé indiquée) — `null` si le joueur est inconnu du bot. */
export async function avecNoms<T extends object>(guildId: string, rows: T[], cle: keyof T & string = 'userId' as keyof T & string): Promise<Array<T & { name: string | null }>> {
  const noms = await carteNoms(guildId);
  return rows.map(r => ({ ...r, name: noms.get(String(r[cle])) ?? null }));
}
