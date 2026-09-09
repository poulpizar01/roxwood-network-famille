/**
 * @file src/api/routes/stocks.ts
 * @description Lecture seule des stocks — résumé global, détail par coffre
 * (salon `logs_coffres`), et historique des mouvements. Le détail par coffre
 * (`CoffreStock`) est un complément du total global (`Stock`, toujours
 * exact) — les deux sont maintenus ensemble à chaque mouvement, voir
 * `stocks.parseAndApply`.
 *
 * Route statique `/history` déclarée AVANT `/:channelId` — sinon Express
 * interpréterait `/stocks/history` comme une recherche du coffre "history"
 * (même principe que `/api/quotas`, `/:userId` toujours en dernier).
 *
 * Chaque route filtre par `req.apiUser.guildId` (posé par `requireAuth`,
 * voir src/api/auth.ts) — jamais les données d'une autre guilde.
 */
import { Router } from 'express';
import * as db from '../../db';

const router = Router();

/** GET /api/stocks — quantité actuelle de chaque item suivi, tous coffres confondus. */
router.get('/', async (req, res) => {
  res.json(await db.getAllStocks(req.apiUser!.guildId));
});

/** GET /api/stocks/history?item=&channelId=&limit= — derniers mouvements, filtrables par item (nom exact) et/ou par coffre. */
router.get('/history', async (req, res) => {
  const item = typeof req.query.item === 'string' ? req.query.item : null;
  const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : null;
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  res.json(await db.getRecentStockHistory(req.apiUser!.guildId, item, limit, channelId));
});

/**
 * GET /api/stocks/:channelId — quantité actuelle de chaque item pour UN
 * coffre précis (un salon `logs_coffres` — voir `/config channel list` côté
 * Discord pour les identifiants). Liste vide (pas d'erreur) si ce salon n'a
 * encore aucun mouvement enregistré. Toujours en dernier : route la plus
 * générique du groupe.
 */
router.get('/:channelId', async (req, res) => {
  res.json(await db.getCoffreStocks(req.apiUser!.guildId, req.params.channelId));
});

export default router;
