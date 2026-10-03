/**
 * @file src/api/routes/stocks.ts
 * @description Lecture seule des stocks — résumé global, détail par coffre
 * (salon `logs_coffres`), et historique des mouvements. `CoffreStock` est la
 * SEULE source de vérité (voir docstring de `db.ts`, section STOCKS) : le
 * total global (`/`, `db.getAllStocks`) est toujours la somme des coffres,
 * recalculée à la lecture — jamais un compteur séparé qui pourrait diverger.
 *
 * Route statique `/history`/`/channels`/`/items` déclarées AVANT
 * `/:channelId` — sinon Express interpréterait `/stocks/history` comme une
 * recherche du coffre "history" (même principe que `/api/quotas`, `/:userId`
 * toujours en dernier).
 *
 * Chaque route filtre par `req.apiUser.guildId` (posé par `requireAuth`,
 * voir src/api/auth.ts) — jamais les données d'une autre guilde.
 *
 * Un coffre `logs_coffres_admin` n'est visible (dans `/channels`) ou
 * interrogeable en détail (`/:channelId`) que par un admin, et `/history`
 * exclut leurs mouvements — mais `/` (le total global) reste le même pour
 * tout le monde : il somme tous les coffres suivis, admin compris (en
 * exclure ferait mentir le stock affiché), voir `db.getAllStocks`. Un salon
 * retiré de la config (`/config channel remove-log-coffre`) n'y compte plus.
 */
import { Router } from 'express';
import * as db from '../../db';
import * as configStore from '../../config-store';

const router = Router();

/** GET /api/stocks — quantité actuelle de chaque item suivi, tous coffres confondus (admin inclus, pour tout le monde — voir docstring de fichier). */
router.get('/', async (req, res) => {
  res.json(await db.getAllStocks(req.apiUser!.guildId, configStore.coffreChannelIds(req.apiUser!.guildId)));
});

/**
 * GET /api/stocks/history?item=&channelId=&limit= — derniers mouvements,
 * filtrables par item (nom exact) et/ou par coffre. Même règle que
 * `/:channelId` pour les coffres admin : un non-admin ne voit pas leurs
 * mouvements (exclus de la liste, 403 s'il les demande explicitement) —
 * sinon l'historique global contournait la restriction du détail par coffre.
 */
router.get('/history', async (req, res) => {
  const apiUser = req.apiUser!;
  const item = typeof req.query.item === 'string' ? req.query.item : null;
  const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : null;
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  const adminChannels = configStore.get(apiUser.guildId).CHANNELS.logs_coffres_admin;
  if (!apiUser.isAdmin && channelId && adminChannels.includes(channelId)) {
    res.status(403).json({ error: 'Accès réservé aux administrateurs pour ce coffre.' });
    return;
  }
  const excludeChannelIds = apiUser.isAdmin ? [] : adminChannels;
  res.json(await db.getRecentStockHistory(apiUser.guildId, item, limit, channelId, excludeChannelIds));
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
 * GET /api/stocks/items — catalogue des objets suivis (`db.getAllItems`),
 * dans l'ordre du Stock Général (`displayOrder`) — pour que le site externe
 * groupe/ordonne comme le panneau Discord au lieu de dupliquer la liste en
 * dur. Déclarée avant `/:channelId`.
 */
router.get('/items', async (req, res) => {
  res.json(await db.getAllItems(req.apiUser!.guildId));
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
