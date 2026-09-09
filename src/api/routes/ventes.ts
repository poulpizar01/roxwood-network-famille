/**
 * @file src/api/routes/ventes.ts
 * @description Lecture seule des ventes de drogue CONFIRMÉES — sur la
 * semaine en cours par défaut, ou une semaine ISO passée via `?week=`
 * (ex. `2026-W37`, voir `../week.ts`), même principe que `/api/quotas`.
 * Reconstruit depuis `Transaction` (`action: 'vente'`, jamais purgée) —
 * `total` ici est donc toujours identique à `byQuotaType['vente']` d'un
 * quota pour la même plage (voir `db.getVenteTotalsForRange`/
 * `getVenteDetailForUser` dans db.ts).
 *
 * Route statique... il n'y en a qu'une ici (`/`), donc `/:userId` peut être
 * déclarée juste après sans risque d'ambiguïté — gardé en dernier quand
 * même, par cohérence avec les autres groupes de l'API.
 */
import { Router } from 'express';
import * as db from '../../db';
import { resolveWeekRange } from '../week';

const router = Router();

/**
 * GET /api/ventes?week= — total vendu par joueur sur la plage, trié
 * décroissant, plus le total du groupe (somme de tous les joueurs).
 */
router.get('/', async (req, res) => {
  const range = await resolveWeekRange(req, res);
  if (!range) return;

  const players = (await db.getVenteTotalsForRange(range.since, range.until)).sort((a, b) => b.total - a.total);
  const groupTotal = players.reduce((sum, p) => sum + p.total, 0);
  res.json({ players, groupTotal });
});

/** GET /api/ventes/:userId?week= — ventes d'un joueur précis : total + détail par drogue vendue. */
router.get('/:userId', async (req, res) => {
  const range = await resolveWeekRange(req, res);
  if (!range) return;

  const detail = await db.getVenteDetailForUser(req.params.userId, range.since, range.until);
  const total = detail.reduce((sum, d) => sum + d.quantite, 0);
  res.json({ userId: req.params.userId, total, detail });
});

export default router;
