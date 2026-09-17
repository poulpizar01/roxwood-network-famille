/**
 * @file src/api/routes/users.ts
 * @description Lecture seule de la liste des comptes Discord connus de la
 * guilde (`db.getKnownUsers`) — un seul endpoint partagé plutôt qu'une copie
 * sous `/quotas` et sous `/ventes` : les deux vues du site externe ont
 * besoin du même sélecteur de joueur, pas de deux implémentations qui
 * pourraient diverger (même principe que `armurerie.getMunitionsSummary`,
 * partagée entre le panneau Discord et sa route API).
 *
 * Un membre normal ne reçoit QUE lui-même — jamais la liste complète des
 * autres joueurs, même règle que pour les coffres admin côté stocks (voir
 * `src/api/routes/stocks.ts`) : un non-admin peut interroger ses propres
 * données (quotas/ventes/paie), jamais celles d'un autre (voir
 * `requireSelfOrAdmin` dans `auth.ts`, appliqué sur les routes `:userId`
 * correspondantes).
 *
 * Chaque route filtre par `req.apiUser.guildId` (posé par `requireAuth`,
 * voir src/api/auth.ts) — jamais les données d'une autre guilde.
 */
import { Router } from 'express';
import * as db from '../../db';

const router = Router();

/** GET /api/users — comptes Discord connus de la guilde (userId + dernier nom connu). Un non-admin ne reçoit que lui-même. */
router.get('/', async (req, res) => {
  const apiUser = req.apiUser!;
  if (!apiUser.isAdmin) {
    res.json([{ userId: apiUser.id, username: apiUser.username }]);
    return;
  }
  res.json(await db.getKnownUsers(apiUser.guildId));
});

export default router;
