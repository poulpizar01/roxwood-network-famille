/**
 * @file src/api/routes/quotas.ts
 * @description Lecture seule des quotas/paie/classement/bilan — sur la
 * semaine en cours par défaut, ou une semaine ISO passée via `?week=`
 * (ex. `2026-W37`, voir `../week.ts`). Reconstruit depuis `Transaction`
 * (jamais purgée) via les fonctions `*ForRange` de `modules/quotas.ts` —
 * voir leur commentaire pour la limite importante : les objectifs/taux
 * appliqués sont ceux ACTUELLEMENT configurés, pas historisés.
 *
 * Ordre des routes : l'endpoint générique (`/`) en premier, puis les plus
 * spécifiques (`/summary`, `/ranking`, `/pay`), et `/:userId` (le paramètre
 * dynamique) toujours en dernier — sinon Express interpréterait
 * `/quotas/ranking` comme une recherche de l'utilisateur "ranking".
 */
import { Router } from 'express';
import * as quotas from '../../modules/quotas';
import { resolveWeekRange } from '../week';

const router = Router();

/** GET /api/quotas?week= — quota de tous les joueurs suivis (somme par catégorie + détail brut par activité). */
router.get('/', async (req, res) => {
  const range = await resolveWeekRange(req, res);
  if (!range) return;
  res.json(await quotas.getAllUserQuotaSummariesForRange(range));
});

/** GET /api/quotas/summary?week= — bilan groupe : total par activité sur la plage. */
router.get('/summary', async (req, res) => {
  const range = await resolveWeekRange(req, res);
  if (!range) return;
  res.json(await quotas.getGroupSummaryForRange(range));
});

/** GET /api/quotas/ranking?week= — classement groupe : paie triée décroissante, uniquement > 0$ (mêmes règles que le bouton Discord). */
router.get('/ranking', async (req, res) => {
  const range = await resolveWeekRange(req, res);
  if (!range) return;
  res.json(await quotas.getSalaryRankingForRange(range));
});

/** GET /api/quotas/pay?week= — paie de tous les joueurs suivis, y compris à 0$ (contrairement à `/ranking`). */
router.get('/pay', async (req, res) => {
  const range = await resolveWeekRange(req, res);
  if (!range) return;
  res.json(await quotas.getAllUserPayForRange(range));
});

/** GET /api/quotas/pay/:userId?week= — paie d'un joueur précis. */
router.get('/pay/:userId', async (req, res) => {
  const range = await resolveWeekRange(req, res);
  if (!range) return;
  res.json(await quotas.getUserPayForRange(req.params.userId, range));
});

/** GET /api/quotas/:userId?week= — quota d'un joueur précis. Toujours en dernier : c'est le paramètre dynamique du groupe. */
router.get('/:userId', async (req, res) => {
  const range = await resolveWeekRange(req, res);
  if (!range) return;
  res.json(await quotas.getUserQuotaSummaryForRange(req.params.userId, range));
});

export default router;
