/**
 * @file src/api/routes/roles.ts
 * @description Lecture seule des rôles du serveur Discord (nom, couleur) —
 * pour qu'un site externe propose un rôle par son nom (ex. le rôle membre,
 * ou le rôle lié à un grade) au lieu d'un identifiant à copier depuis
 * Discord.
 *
 * Lu dans le cache du client du bot (`guild.roles.cache`, tenu à jour par
 * l'intent `Guilds`), pas par un appel à l'API Discord : d'où la fabrique
 * `rolesRouter(client)`, contrairement aux autres groupes qui n'ont besoin
 * que de la base.
 *
 * Ouvert à tout membre autorisé (`requireAuth` seul) : ces noms sont visibles
 * par tous sur le serveur. Comme le reste de l'API, filtré par
 * `req.apiUser.guildId` — jamais les rôles d'une autre guilde.
 */
import { Router } from 'express';
import type { Client } from 'discord.js';

export default function rolesRouter(client: Client): Router {
  const router = Router();

  /**
   * GET /api/roles — rôles du serveur, du plus haut au plus bas (ordre de
   * Discord), sans @everyone ni les rôles gérés par une intégration (bots),
   * qu'on n'attribue pas à la main. Liste vide si le bot n'est pas prêt sur
   * cette guilde.
   */
  router.get('/', (req, res) => {
    const guild = client.guilds.cache.get(req.apiUser!.guildId);
    if (!guild) {
      res.json([]);
      return;
    }
    res.json([...guild.roles.cache.values()]
      .filter(r => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.hexColor })));
  });

  return router;
}
