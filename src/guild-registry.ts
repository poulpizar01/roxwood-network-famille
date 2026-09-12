/**
 * @file src/guild-registry.ts
 * @description Registre des guildes Discord connues — la table `Guild` est le
 * SEUL endroit qui répond à "quelles guildes ce déploiement sert" (statut de
 * tenant), à ne pas confondre avec `config-store.ts` (config MÉTIER d'une
 * guilde donnée, une fois qu'on sait qu'elle existe). Alimenté par les
 * événements `guildCreate`/`guildDelete` dans `src/index.ts`.
 *
 * `deactivateGuild` est un soft-delete (`active:false`) : les données
 * métier d'une guilde qui retire le bot ne sont JAMAIS supprimées — elle
 * peut revenir (`registerGuild` réactive une ligne existante plutôt que
 * d'en créer une seconde).
 */
import { prisma } from './db';

/** `corsOrigin` de chaque guilde active, tenu à jour en mémoire pour éviter un aller-retour DB à chaque preflight CORS (voir src/api/server.ts). */
const activeCorsOrigins = new Set<string>();

/** (Ré)initialise le cache CORS en mémoire depuis la base — à appeler une fois au démarrage, avant que l'API n'accepte des requêtes. */
export async function warmCorsCache(): Promise<void> {
  const guilds = await prisma.guild.findMany({ where: { active: true, corsOrigin: { not: null } } });
  activeCorsOrigins.clear();
  for (const g of guilds) if (g.corsOrigin) activeCorsOrigins.add(g.corsOrigin);
}

/** Vrai si `origin` correspond au `corsOrigin` d'au moins une guilde active connue. Grossier par nature (pas de vérification de guilde précise ici) — voir docstring de src/api/server.ts pour pourquoi c'est suffisant : l'isolation réelle des données se fait ensuite, par requête, via le `guildId` du JWT. */
export function isKnownCorsOrigin(origin: string): boolean {
  return activeCorsOrigins.has(origin);
}

/**
 * Enregistre ou réactive une guilde (appelé depuis `guildCreate`, et une
 * fois par guilde déjà présente au démarrage — voir index.ts). Upsert : ne
 * crée jamais de doublon pour une guilde qui revient après un `guildDelete`.
 */
export async function registerGuild(guildId: string, name: string | null): Promise<void> {
  await prisma.guild.upsert({
    where: { guildId },
    create: { guildId, name },
    update: { name, active: true, removedAt: null },
  });
  await warmCorsCache();
}

/** Soft-delete (voir docstring de fichier) — appelé depuis `guildDelete`. */
export async function deactivateGuild(guildId: string): Promise<void> {
  await prisma.guild.updateMany({
    where: { guildId },
    data: { active: false, removedAt: new Date() },
  });
  await warmCorsCache();
}

/** Renseigne (ou efface, avec `null`) le site externe autorisé pour une guilde — voir `/config site-externe`. */
export async function setGuildSite(guildId: string, frontendUrl: string | null, corsOrigin: string | null): Promise<void> {
  await prisma.guild.update({ where: { guildId }, data: { frontendUrl, corsOrigin } });
  await warmCorsCache();
}

/** Guildes actives — source de vérité pour les boucles cron/`reloadAll` (voir index.ts, config-store.ts). */
export async function listActiveGuildIds(): Promise<string[]> {
  const rows = await prisma.guild.findMany({ where: { active: true }, select: { guildId: true } });
  return rows.map(r => r.guildId);
}

/** Vrai si `guildId` est une guilde active connue — utilisé par `/auth/login` pour rejeter un `?guild=` invalide avant même de contacter Discord. */
export async function isKnownGuild(guildId: string): Promise<boolean> {
  const row = await prisma.guild.findUnique({ where: { guildId }, select: { active: true } });
  return row?.active === true;
}

/**
 * Vrai si `guildId` est une guilde active avec un site externe configuré —
 * utilisé par `requireAuth` (src/api/auth.ts) pour qu'un token émis avant un
 * `/config site-externe remove` ou un retrait du bot cesse de fonctionner
 * immédiatement, plutôt que de rester valable jusqu'à son expiration (7j).
 */
export async function isAuthorizedGuild(guildId: string): Promise<boolean> {
  const row = await prisma.guild.findUnique({ where: { guildId }, select: { active: true, frontendUrl: true } });
  return row?.active === true && row.frontendUrl !== null;
}

/** Le `frontendUrl` configuré pour une guilde (voir `setGuildSite`) — `null` si jamais configuré, auquel cas `/auth/callback` refuse la connexion plutôt que de rediriger nulle part. */
export async function getGuildFrontendUrl(guildId: string): Promise<string | null> {
  const row = await prisma.guild.findUnique({ where: { guildId }, select: { frontendUrl: true } });
  return row?.frontendUrl ?? null;
}

/** `active` + `frontendUrl` en un seul aller-retour DB — utilisé par `/auth/login` (src/api/auth.ts) pour distinguer "guilde inconnue" de "aucun site externe configuré" sans doubler la requête. */
export async function getGuildLoginStatus(guildId: string): Promise<{ active: boolean; frontendUrl: string | null }> {
  const row = await prisma.guild.findUnique({ where: { guildId }, select: { active: true, frontendUrl: true } });
  return { active: row?.active === true, frontendUrl: row?.frontendUrl ?? null };
}

/** Site externe configuré pour une guilde (voir `setGuildSite`) — pour `/config site-externe list`. */
export async function getGuildSite(guildId: string): Promise<{ frontendUrl: string | null; corsOrigin: string | null }> {
  const row = await prisma.guild.findUnique({ where: { guildId }, select: { frontendUrl: true, corsOrigin: true } });
  return { frontendUrl: row?.frontendUrl ?? null, corsOrigin: row?.corsOrigin ?? null };
}
