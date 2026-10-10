/**
 * @file src/api/routes/argent.ts
 * @description Lecture seule de l'argent de la semaine en cours par défaut,
 * ou d'une semaine ISO passée via `?week=` (voir `../week.ts`) : dépôts et
 * retraits d'argent sale/propre dans les coffres, argent sale saisi sur les
 * actions (détail par action) et sur les ventes. Même calcul que le bilan
 * hebdomadaire (`argent.getArgentSummaryForRange`).
 *
 * Filtre par `req.apiUser.guildId` (posé par `requireAuth`, voir
 * src/api/auth.ts) — jamais les données d'une autre guilde.
 */
import { Router } from 'express';
import * as configStore from '../../config-store';
import { resolveWeekRange } from '../week';
import { getArgentSummaryForRange } from '../../modules/argent';

const router = Router();

/** GET /api/argent?week= — résumé de l'argent sur la plage, avec l'état des options de saisie. */
router.get('/', async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const range = await resolveWeekRange(req, res, guildId);
  if (!range) return;

  const summary = await getArgentSummaryForRange(guildId, range);
  const options = configStore.get(guildId).OPTIONS;
  res.json({
    since: range.since,
    until: range.until,
    saisie: { actions: options.saisie_argent_actions, ventes: options.saisie_argent_ventes },
    ...summary,
  });
});

export default router;
