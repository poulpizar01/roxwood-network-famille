/**
 * @file src/api/routes/garages.ts
 * @description Lecture seule des garages/fourrière — véhicules actuellement
 * sortis (tout membre, comme le reste de l'API) et classement cumulé des
 * mises en fourrière (réservé aux admins, même règle que la commande
 * Discord `/fourrieres`). Pas de route dynamique dans ce groupe.
 *
 * Chaque route filtre par `req.apiUser.guildId` (posé par `requireAuth`,
 * voir src/api/auth.ts) — jamais les données d'une autre guilde.
 */
import { Router } from 'express';
import * as db from '../../db';
import { MONTANT_FOURRIERE } from '../../modules/garages';

const router = Router();

/**
 * GET /api/garages/vehicles — véhicules actuellement sortis et pas encore
 * rangés (`db.getVehiculesSortis`), le plus récemment sorti en premier —
 * pour savoir qui a quel véhicule dehors.
 */
router.get('/vehicles', async (req, res) => {
  const rows = await db.getVehiculesSortis(req.apiUser!.guildId);
  res.json(rows.map(r => ({ plaque: r.plaque, modele: r.modele, discordId: r.discordId, joueur: r.joueur, since: r.timestamp })));
});

/**
 * GET /api/garages/impounds — classement cumulé des mises en fourrière
 * (`db.getFourriereClassement`), avec le montant indicatif (`MONTANT_FOURRIERE`,
 * purement informatif — aucune facturation automatique nulle part dans le
 * bot). Réservé aux admins, comme `/fourrieres` côté Discord.
 */
router.get('/impounds', async (req, res) => {
  const apiUser = req.apiUser!;
  if (!apiUser.isAdmin) {
    res.status(403).json({ error: 'Accès réservé aux administrateurs.' });
    return;
  }
  const classement = await db.getFourriereClassement(apiUser.guildId);
  res.json(classement.map(c => ({ discordId: c.discord_id, joueur: c.joueur, total: c.total, montant: c.total * MONTANT_FOURRIERE })));
});

export default router;
