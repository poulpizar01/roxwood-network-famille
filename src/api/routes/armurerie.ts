/**
 * @file src/api/routes/armurerie.ts
 * @description Lecture seule de l'armurerie — armes (liste filtrable,
 * recherche) et munitions (résumé + historique des ventes), mêmes données
 * que le panneau Discord (`getMunitionsSummary` exportée depuis
 * `modules/armurerie.ts`, source unique pour éviter de dupliquer le calcul).
 *
 * Endpoints en anglais (`ammo`, pas `munitions`) — le reste de l'API garde
 * des noms de ressource français (`/api/stocks`, `/api/taxes`...), mais un
 * groupe d'endpoints ne doit jamais mélanger les deux langues en son sein.
 * `/` = les armes (ressource principale du groupe, pas de préfixe `weapons`
 * : ce fichier EST déjà `/api/armurerie`) ; `ammo` reste préfixé, ressource
 * secondaire distincte.
 *
 * Chaque route filtre par `req.apiUser.guildId` (posé par `requireAuth`,
 * voir src/api/auth.ts) — jamais les données d'une autre guilde.
 */
import { Router } from 'express';
import * as db from '../../db';
import { getMunitionsSummary } from '../../modules/armurerie';

const router = Router();

/** Statut arme (anglais, valeur de `?status=`) → valeur stockée en base (française). */
const STATUS_BY_QUERY_VALUE: Record<string, string> = {
  in_stock: 'en_stock',
  loaned: 'pretee',
  lost: 'perdue',
};

/**
 * GET /api/armurerie?status=in_stock|loaned|lost — sans `status`, retourne
 * toutes les armes SAUF perdues (même défaut que le panneau Discord).
 * `status` explicite = exactement ce statut, perdues incluses.
 */
router.get('/', async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const statusParam = req.query.status;
  if (statusParam !== undefined) {
    const statut = STATUS_BY_QUERY_VALUE[String(statusParam)];
    if (!statut) {
      res.status(400).json({ error: `status invalide — attendu : ${Object.keys(STATUS_BY_QUERY_VALUE).join(', ')}` });
      return;
    }
    res.json((await db.getAllArmes(guildId)).filter(a => a.statut === statut));
    return;
  }
  res.json((await db.getAllArmes(guildId)).filter(a => a.statut !== 'perdue'));
});

/** GET /api/armurerie/search?q=<terme> — recherche par nom OU référence (sous-chaîne, insensible à la casse). */
router.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  if (!q) {
    res.status(400).json({ error: 'Paramètre q requis.' });
    return;
  }
  const armes = (await db.getAllArmes(req.apiUser!.guildId)).filter(a => a.nom.toLowerCase().includes(q) || a.reference.toLowerCase().includes(q));
  res.json(armes);
});

/** GET /api/armurerie/ammo — munitions de pistolet (stock réel + compteurs hebdomadaires indicatifs fabrication/vente) et munitions de SMG (`stockSmg`, stock brut seul). */
router.get('/ammo', async (req, res) => {
  res.json(await getMunitionsSummary(req.apiUser!.guildId));
});

/** GET /api/armurerie/ammo/history — ventes de munitions depuis le dernier reset hebdomadaire (dimanche 19h), la plus récente en premier — même fenêtre que le total "vendues cette semaine" de `/ammo`, en détail. */
router.get('/ammo/history', async (req, res) => {
  const guildId = req.apiUser!.guildId;
  const sinceReset = Number((await db.getSetting(guildId, 'last_weekly_reset')) || 0);
  res.json(await db.getMunitionsVentesDepuis(guildId, sinceReset));
});

export default router;
