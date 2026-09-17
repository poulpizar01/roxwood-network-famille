/**
 * @file src/api/routes/stocks.ts
 * @description Lecture seule des stocks — résumé global, détail par coffre
 * (salon `logs_coffres`), et historique des mouvements. Le détail par coffre
 * (`CoffreStock`) est un complément du total global (`Stock`, toujours
 * exact) — les deux sont maintenus ensemble à chaque mouvement, voir
 * `stocks.parseAndApply`.
 *
 * Route statique `/history`/`/channels` déclarées AVANT `/:channelId` —
 * sinon Express interpréterait `/stocks/history` comme une recherche du
 * coffre "history" (même principe que `/api/quotas`, `/:userId` toujours en
 * dernier).
 *
 * Chaque route filtre par `req.apiUser.guildId` (posé par `requireAuth`,
 * voir src/api/auth.ts) — jamais les données d'une autre guilde.
 *
 * Un coffre `logs_coffres_admin` n'est visible (dans `/channels`) ou
 * interrogeable en détail (`/:channelId`) que par un admin — mais `/` (le
 * total global, tous coffres confondus) reste inchangé pour tout le monde :
 * exclure les coffres admin de CE total casserait le stock affiché (il ne
 * reflèterait plus la réalité), voir `db.getAllStocks`, jamais filtré par
 * rôle de salon.
 */
import { Router } from 'express';
import * as db from '../../db';
import * as configStore from '../../config-store';

const router = Router();

/** GET /api/stocks — quantité actuelle de chaque item suivi, tous coffres confondus (admin inclus, pour tout le monde — voir docstring de fichier). */
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
 * GET /api/stocks/channels — liste des coffres surveillés (`logs_coffres` +
 * `logs_coffres_admin`, avec leur `label` éventuel) pour peupler un
 * sélecteur côté site externe. Les coffres admin ne sont renvoyés qu'aux
 * requêtes admin.
 */
router.get('/channels', async (req, res) => {
  const apiUser = req.apiUser!;
  const normaux = (await db.getChannelsWithLabel(apiUser.guildId, 'logs_coffres')).map(c => ({ ...c, role: 'logs_coffres' as const }));
  const admin = apiUser.isAdmin
    ? (await db.getChannelsWithLabel(apiUser.guildId, 'logs_coffres_admin')).map(c => ({ ...c, role: 'logs_coffres_admin' as const }))
    : [];
  res.json([...normaux, ...admin]);
});

/**
 * GET /api/stocks/:channelId — quantité actuelle de chaque item pour UN
 * coffre précis (un salon `logs_coffres` ou `logs_coffres_admin` — voir
 * `/config channel list` côté Discord pour les identifiants). Liste vide
 * (pas d'erreur) si ce salon n'a encore aucun mouvement enregistré. Rejette
 * un coffre admin pour un non-admin (même règle que `/channels`). Toujours
 * en dernier : route la plus générique du groupe.
 */
router.get('/:channelId', async (req, res) => {
  const apiUser = req.apiUser!;
  const channelId = String(req.params.channelId);
  if (!apiUser.isAdmin && configStore.get(apiUser.guildId).CHANNELS.logs_coffres_admin.includes(channelId)) {
    res.status(403).json({ error: 'Accès réservé aux administrateurs pour ce coffre.' });
    return;
  }
  res.json(await db.getCoffreStocks(apiUser.guildId, channelId));
});

export default router;
