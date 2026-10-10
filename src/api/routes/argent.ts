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
 *
 * Détail par joueur : argent sale saisi uniquement (les dépôts/retraits de
 * coffre ne sont pas suivis par joueur), attribué au déclarant seul.
 * `/users` (classement) reste ouvert à tout membre, comme `/api/ventes` ;
 * `/:userId` exige `requireSelfOrAdmin` et reste en dernier.
 */
import { Router } from 'express';
import * as configStore from '../../config-store';
import { resolveWeekRange } from '../week';
import { requireSelfOrAdmin } from '../auth';
import { getArgentSummaryForRange, getArgentParJoueurForRange } from '../../modules/argent';

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

/** GET /api/argent/users?week= — argent sale saisi par joueur (actions + ventes), trié par total décroissant. */
router.get('/users', async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const range = await resolveWeekRange(req, res, guildId);
  if (!range) return;
  res.json({ since: range.since, until: range.until, players: await getArgentParJoueurForRange(guildId, range) });
});

/** GET /api/argent/:userId?week= — argent sale saisi par un joueur, détail par action. Réservé à ce joueur lui-même (ou un admin). */
router.get('/:userId', requireSelfOrAdmin, async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const range = await resolveWeekRange(req, res, guildId);
  if (!range) return;
  const userId = String(req.params.userId);
  const [joueur] = await getArgentParJoueurForRange(guildId, range, userId);
  res.json({
    since: range.since,
    until: range.until,
    ...(joueur ?? { userId, total: 0, actions: { total: 0, parAction: [] }, ventes: { total: 0, nombre: 0 } }),
  });
});

export default router;
