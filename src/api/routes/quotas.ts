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
 * spécifiques (`/config`, `/summary`, `/ranking`, `/pay`), et `/:userId` (le paramètre
 * dynamique) toujours en dernier — sinon Express interpréterait
 * `/quotas/ranking` comme une recherche de l'utilisateur "ranking".
 *
 * Chaque route filtre par `req.apiUser.guildId` (posé par `requireAuth`,
 * voir src/api/auth.ts) — jamais les données d'une autre guilde.
 *
 * `/:userId` et `/pay/:userId` exigent en plus `requireSelfOrAdmin` : un
 * membre normal ne peut consulter que SES PROPRES quota/paie, jamais ceux
 * d'un autre (voir `../auth.ts`). Les routes de groupe (`/`, `/pay`,
 * `/ranking`, `/summary`) restent ouvertes à tout membre, comme les vues
 * équivalentes du panneau Discord (classement/bilan visibles par tous).
 */
import { Router } from 'express';
import * as quotas from '../../modules/quotas';
import * as configStore from '../../config-store';
import { activityDisplayLabel } from '../../config-store';
import { resolveWeekRange } from '../week';
import { requireSelfOrAdmin } from '../auth';

const router = Router();

/** GET /api/quotas?week= — quota de tous les joueurs suivis (somme par catégorie + détail brut par activité). */
router.get('/', async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const range = await resolveWeekRange(req, res, guildId);
  if (!range) return;
  res.json(await quotas.getAllUserQuotaSummariesForRange(guildId, range));
});

/**
 * GET /api/quotas/config?week= — ce qu'un client a besoin de connaître pour
 * INTERPRÉTER les autres réponses de ce groupe, sans le recalculer lui-même :
 * la plage `[since, until)` effectivement résolue (semaine en cours = depuis
 * le dernier reset hebdo, sinon la semaine ISO demandée), les objectifs
 * hebdomadaires (`/config quota`) et les taux de paie (`/config salaire`)
 * ACTUELS — ce sont ceux appliqués à n'importe quelle plage, voir la limite
 * documentée en tête de fichier. Les catégories de quota et leurs libellés
 * viennent du même registre `ACTIVITY_TYPES` que les calculs.
 */
router.get('/config', async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const range = await resolveWeekRange(req, res, guildId);
  if (!range) return;
  const c = configStore.get(guildId);
  const activities = Object.fromEntries(
    Object.entries(c.ACTIVITY_TYPES).map(([key, cfg]) => [key, { label: activityDisplayLabel(cfg), quotaType: cfg.quotaType, enabled: cfg.enabled }]),
  );
  res.json({
    range,
    isCurrentWeek: req.query.week === undefined,
    targets: c.QUOTA_TARGETS,
    salaryRates: c.SALARY_RATES,
    itemSalaryRates: c.ITEM_SALARY_RATES,
    classementRates: c.CLASSEMENT_RATES,
    activities,
  });
});

/** GET /api/quotas/summary?week= — bilan groupe : total par activité sur la plage. */
router.get('/summary', async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const range = await resolveWeekRange(req, res, guildId);
  if (!range) return;
  res.json(await quotas.getGroupSummaryForRange(guildId, range));
});

/** GET /api/quotas/ranking?week= — classement groupe par points (voir /config classement), trié décroissant, uniquement > 0 pt (mêmes règles que le bouton Discord "Classement Groupe"). */
router.get('/ranking', async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const range = await resolveWeekRange(req, res, guildId);
  if (!range) return;
  res.json(await quotas.getClassementRankingForRange(guildId, range));
});

/** GET /api/quotas/pay?week= — paie de tous les joueurs suivis, y compris à 0$. */
router.get('/pay', async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const range = await resolveWeekRange(req, res, guildId);
  if (!range) return;
  res.json(await quotas.getAllUserPayForRange(guildId, range));
});

/** GET /api/quotas/pay/:userId?week= — paie d'un joueur précis. Réservé à ce joueur lui-même (ou un admin), voir `requireSelfOrAdmin`. */
router.get('/pay/:userId', requireSelfOrAdmin, async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const range = await resolveWeekRange(req, res, guildId);
  if (!range) return;
  res.json(await quotas.getUserPayForRange(guildId, String(req.params.userId), range));
});

/** GET /api/quotas/:userId?week= — quota d'un joueur précis. Réservé à ce joueur lui-même (ou un admin). Toujours en dernier : c'est le paramètre dynamique du groupe. */
router.get('/:userId', requireSelfOrAdmin, async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const range = await resolveWeekRange(req, res, guildId);
  if (!range) return;
  res.json(await quotas.getUserQuotaSummaryForRange(guildId, String(req.params.userId), range));
});

export default router;
