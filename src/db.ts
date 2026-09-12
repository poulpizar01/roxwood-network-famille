/**
 * @file src/db.ts
 * @description Couche d'accès aux données (DAL), au-dessus de Prisma/PostgreSQL.
 *
 * Expose un ensemble de fonctions **asynchrones** couvrant settings, config
 * (items/activités/quotas/armes), stocks, transactions, stats, cooldowns,
 * braquages, taxes, armurerie, user_mapping, pending_sales, véhicules/fourrière
 * et munitions.
 *
 * Cette couche est la SEULE à convertir entre `Date` (colonnes Postgres
 * `TIMESTAMPTZ`) et millisecondes epoch (`number`, comme `Date.now()`) : tout
 * le reste du bot manipule des `number`, ce qui évite de répandre
 * `new Date()`/`.getTime()` dans chaque module.
 *
 * **Multi-tenant** : toutes les tables métier sont scopées par `guildId`
 * (voir schema.prisma) — chaque fonction ci-dessous prend `guildId` en
 * PREMIER paramètre, jamais optionnel. Les fonctions identifiées uniquement
 * par un `id` autoincrémenté (taxes, armes, ventes en attente, transactions)
 * utilisent `updateMany`/`deleteMany({ where: { id, guildId } })` plutôt que
 * `update`/`delete` : un `id` d'une autre guilde n'affecte alors
 * silencieusement aucune ligne, au lieu de risquer une mutation croisée si
 * jamais deux guildes partageaient par erreur un même `id` (autoincrement
 * par table, donc en pratique déjà unique globalement — cette précaution est
 * une défense en profondeur, pas un correctif d'une collision réelle).
 */
import { PrismaClient, type Prisma } from '@prisma/client';

export const prisma = new PrismaClient();

/** Convertit une colonne `TIMESTAMPTZ` (ou `null`) en millisecondes epoch. */
const toMs = (d: Date | null | undefined): number => (d ? d.getTime() : 0);

// ─── SETTINGS (scalaires nommés — voir docstring du modèle Setting) ─────────

/** Lit un `Setting` scalaire par clé, ou `null` si absent. */
export async function getSetting(guildId: string, key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { guildId_key: { guildId, key } } });
  return row ? row.value : null;
}

/** Écrit (upsert) un `Setting` scalaire — `value` est converti en chaîne. */
export async function setSetting(guildId: string, key: string, value: unknown): Promise<void> {
  await prisma.setting.upsert({
    where: { guildId_key: { guildId, key } },
    create: { guildId, key, value: String(value) },
    update: { value: String(value) },
  });
}

/** Supprime un `Setting` par clé (no-op si absent). */
export async function deleteSetting(guildId: string, key: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { guildId, key } });
}

// ─── CHANNELS (config) ────────────────────────────────────────────────────────

/** Toutes les associations rôle → salon d'une guilde en une requête (utilisé par config-store.reload()). */
export async function getAllChannels(guildId: string) {
  return prisma.channel.findMany({ where: { guildId } });
}

/** Retourne les salons assignés à un rôle (généralement un seul, sauf 'logs_coffres'). */
export async function getChannelsByRole(guildId: string, role: string): Promise<string[]> {
  return (await prisma.channel.findMany({ where: { guildId, role } })).map(r => r.channelId);
}

/** Remplace le(s) salon(s) d'un rôle à valeur unique (stock_general, quotas, ...) par un seul. */
export async function setChannelRole(guildId: string, role: string, channelId: string): Promise<void> {
  await prisma.channel.deleteMany({ where: { guildId, role } });
  await prisma.channel.create({ data: { guildId, role, channelId } });
}

/** Ajoute un salon à un rôle à valeurs multiples (ex. 'logs_coffres'), sans toucher aux autres. */
export async function addChannelToRole(guildId: string, role: string, channelId: string): Promise<void> {
  await prisma.channel.upsert({
    where: { guildId_role_channelId: { guildId, role, channelId } },
    create: { guildId, role, channelId },
    update: {},
  });
}

/** Retire un salon d'un rôle à valeurs multiples (ex. 'logs_coffres'). */
export async function removeChannelFromRole(guildId: string, role: string, channelId: string): Promise<void> {
  await prisma.channel.deleteMany({ where: { guildId, role, channelId } });
}

// ─── RÔLES DISCORD (config) ──────────────────────────────────────────────────

/** Associe (upsert) un rôle Discord à un usage du bot (ex. 'admin', 'taxes'). */
export async function setDiscordRole(guildId: string, target: string, roleId: string): Promise<void> {
  await prisma.discordRole.upsert({
    where: { guildId_target: { guildId, target } },
    create: { guildId, target, roleId },
    update: { roleId },
  });
}

/** Toutes les associations usage → rôle Discord configurées pour une guilde. */
export async function getAllDiscordRoles(guildId: string) {
  return prisma.discordRole.findMany({ where: { guildId } });
}

// ─── ITEMS (config) ─────────────────────────────────────────────────────────

export interface ItemInput {
  name: string;
  stock_group?: string | null;
  vente?: boolean;
  display_order?: number;
  /** Défaut `true` (contrairement aux autres flags, défaut `false`) : omettre cette option ne doit pas faire disparaître un item du Stock Général. */
  visible_stock?: boolean;
  /** Clé d'activité labo (ex. "labo_cocaine") si cet item est LA drogue que ce labo produit — voir docstring du modèle Item. */
  labo_lie?: string | null;
  /** Unités de base représentées par une unité de cet item (ex. 24 pour une boîte de munitions) — voir docstring du modèle Item et `armurerie.weightedStockSum`. Défaut 1 (pas de conversion). */
  stock_multiplier?: number;
}

/** Ajoute ou remplace entièrement la configuration d'un item suivi (upsert complet, voir docstring de `/config item add`). */
export async function upsertItem(guildId: string, data: ItemInput): Promise<void> {
  await prisma.item.upsert({
    where: { guildId_name: { guildId, name: data.name } },
    create: {
      guildId,
      name: data.name,
      stockGroup: data.stock_group ?? null,
      vente: !!data.vente,
      displayOrder: data.display_order ?? 0,
      visibleStock: data.visible_stock !== false,
      laboLie: data.labo_lie ?? null,
      stockMultiplier: data.stock_multiplier ?? 1,
    },
    update: {
      stockGroup: data.stock_group ?? null,
      vente: !!data.vente,
      displayOrder: data.display_order ?? 0,
      visibleStock: data.visible_stock !== false,
      laboLie: data.labo_lie ?? null,
      stockMultiplier: data.stock_multiplier ?? 1,
    },
  });
}

/** Retire un item suivi (ne supprime pas son stock/historique). */
export async function deleteItem(guildId: string, name: string): Promise<void> {
  await prisma.item.deleteMany({ where: { guildId, name } });
}

/** Tous les items suivis d'une guilde, triés par ordre d'affichage puis par nom. */
export async function getAllItems(guildId: string) {
  return prisma.item.findMany({ where: { guildId }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] });
}

// ─── QUOTA TARGETS (config) ──────────────────────────────────────────────────

/** Fixe (upsert) l'objectif hebdomadaire d'une catégorie de quota. */
export async function setQuotaTarget(guildId: string, quotaType: string, weeklyTarget: number): Promise<void> {
  await prisma.quotaTarget.upsert({
    where: { guildId_quotaType: { guildId, quotaType } },
    create: { guildId, quotaType, weeklyTarget },
    update: { weeklyTarget },
  });
}

/** Retire l'objectif d'une catégorie de quota (elle reste suivie, sans cible). */
export async function deleteQuotaTarget(guildId: string, quotaType: string): Promise<void> {
  await prisma.quotaTarget.deleteMany({ where: { guildId, quotaType } });
}

/** Tous les objectifs de quota configurés pour une guilde. */
export async function getAllQuotaTargets(guildId: string) {
  return prisma.quotaTarget.findMany({ where: { guildId } });
}

// ─── SALARY RATES (config) ───────────────────────────────────────────────────

/** Fixe (upsert) le taux de paie ($ par unité) d'une catégorie de quota. */
export async function setSalaryRate(guildId: string, quotaType: string, amount: number): Promise<void> {
  await prisma.salaryRate.upsert({
    where: { guildId_quotaType: { guildId, quotaType } },
    create: { guildId, quotaType, amount },
    update: { amount },
  });
}

/** Retire le taux de paie d'une catégorie de quota (elle ne génère plus de paie). */
export async function deleteSalaryRate(guildId: string, quotaType: string): Promise<void> {
  await prisma.salaryRate.deleteMany({ where: { guildId, quotaType } });
}

/** Tous les taux de paie configurés pour une guilde. */
export async function getAllSalaryRates(guildId: string) {
  return prisma.salaryRate.findMany({ where: { guildId } });
}

// ─── STOCKS ─────────────────────────────────────────────────────────────────

/** Quantité en stock d'un item (0 si jamais initialisé). */
export async function getStock(guildId: string, item: string): Promise<number> {
  const row = await prisma.stock.findUnique({ where: { guildId_item: { guildId, item: item.toLowerCase() } } });
  return row ? row.quantite : 0;
}

/** Stock de plusieurs items en une seule requête, individuellement (clé = nom en minuscules, absent si jamais mouvementé) — voir `armurerie.getMunitionsStock`/`weightedStockSum`, qui pondèrent différemment chaque item d'un groupe avant de sommer (contre un `getStock` par item, un N+1 pour un groupe qui peut grossir). */
export async function getStocksByItems(guildId: string, items: string[]): Promise<Record<string, number>> {
  if (!items.length) return {};
  const rows = await prisma.stock.findMany({ where: { guildId, item: { in: items.map(i => i.toLowerCase()) } } });
  return Object.fromEntries(rows.map(r => [r.item, r.quantite]));
}

/**
 * Applique un delta au stock d'un item de façon atomique (une seule requête
 * SQL — upsert + valeur précédente lue dans la même instruction), et retourne
 * les quantités avant/après. Deux mouvements concurrents sur le même item
 * (ex. deux retraits de coffre détectés à quelques ms d'intervalle) ne
 * peuvent donc pas s'écraser l'un l'autre comme le ferait un
 * lire-puis-écrire en deux requêtes séparées.
 */
export async function applyStockDelta(guildId: string, item: string, delta: number): Promise<{ avant: number; apres: number }> {
  const key = item.toLowerCase();
  const rows = await prisma.$queryRaw<Array<{ avant: number; apres: number }>>`
    WITH prev AS (
      SELECT quantite FROM stocks WHERE guild_id = ${guildId} AND item = ${key}
    ), upserted AS (
      INSERT INTO stocks (guild_id, item, quantite) VALUES (${guildId}, ${key}, GREATEST(${delta}, 0))
      ON CONFLICT (guild_id, item) DO UPDATE SET quantite = GREATEST(stocks.quantite + ${delta}, 0)
      RETURNING quantite
    )
    SELECT COALESCE((SELECT quantite FROM prev), 0)::int AS avant, (SELECT quantite FROM upserted)::int AS apres
  `;
  return { avant: rows[0]?.avant ?? 0, apres: rows[0]?.apres ?? 0 };
}

/** Applique un delta au stock d'un item et retourne uniquement la quantité résultante (voir `applyStockDelta`). */
export async function updateStock(guildId: string, item: string, delta: number): Promise<number> {
  return (await applyStockDelta(guildId, item, delta)).apres;
}

/** Force la valeur du stock d'un item (correction manuelle) — jamais négative. */
export async function setStock(guildId: string, item: string, qty: number): Promise<void> {
  const key = item.toLowerCase();
  const quantite = Math.max(0, qty);
  await prisma.stock.upsert({
    where: { guildId_item: { guildId, item: key } },
    create: { guildId, item: key, quantite },
    update: { quantite },
  });
}

/** Le stock de tous les items d'une guilde, trié par nom. */
export async function getAllStocks(guildId: string) {
  return prisma.stock.findMany({ where: { guildId }, orderBy: { item: 'asc' } });
}

/** Supprime tout le stock d'une guilde — global ET par coffre (resync complète, voir `stocks.fullResync`). */
export async function resetAllStocks(guildId: string): Promise<void> {
  await prisma.stock.deleteMany({ where: { guildId } });
  await prisma.coffreStock.deleteMany({ where: { guildId } });
}

// ─── STOCK PAR COFFRE ─────────────────────────────────────────────────────────
//
// Détail par salon `logs_coffres` (voir modèle CoffreStock) — mis à jour EN
// PLUS du total global (jamais à sa place, voir `applyStockDelta`) à chaque
// mouvement, avec le même identifiant de salon que celui d'où vient le log.

/**
 * Applique un delta au stock d'un item POUR UN COFFRE DONNÉ, atomiquement —
 * même pattern que `applyStockDelta` (upsert + valeur précédente en une
 * seule requête, contre une course entre deux mouvements concurrents sur le
 * même coffre/item).
 */
export async function applyCoffreStockDelta(guildId: string, channelId: string, item: string, delta: number): Promise<{ avant: number; apres: number }> {
  const key = item.toLowerCase();
  const rows = await prisma.$queryRaw<Array<{ avant: number; apres: number }>>`
    WITH prev AS (
      SELECT quantite FROM coffre_stocks WHERE guild_id = ${guildId} AND channel_id = ${channelId} AND item = ${key}
    ), upserted AS (
      INSERT INTO coffre_stocks (guild_id, channel_id, item, quantite) VALUES (${guildId}, ${channelId}, ${key}, GREATEST(${delta}, 0))
      ON CONFLICT (guild_id, channel_id, item) DO UPDATE SET quantite = GREATEST(coffre_stocks.quantite + ${delta}, 0)
      RETURNING quantite
    )
    SELECT COALESCE((SELECT quantite FROM prev), 0)::int AS avant, (SELECT quantite FROM upserted)::int AS apres
  `;
  return { avant: rows[0]?.avant ?? 0, apres: rows[0]?.apres ?? 0 };
}

/** Le stock de tous les items d'UN coffre précis, trié par nom (liste vide si ce salon n'a encore aucun mouvement enregistré — pas d'erreur). */
export async function getCoffreStocks(guildId: string, channelId: string) {
  return prisma.coffreStock.findMany({ where: { guildId, channelId }, orderBy: { item: 'asc' } });
}

/** Supprime tout l'historique de mouvements de stock d'une guilde (resync complète). */
export async function clearStockHistory(guildId: string): Promise<void> {
  await prisma.stockHistory.deleteMany({ where: { guildId } });
}

// ─── STOCK HISTORY ───────────────────────────────────────────────────────────

export interface StockHistoryInput {
  timestamp: number;
  joueur: string;
  action: string;
  item: string;
  quantite: number;
  stock_avant: number;
  stock_apres: number;
  /** Salon `logs_coffres` d'origine (voir modèle CoffreStock) — absent pour un appel qui ne le connaît pas. */
  channel_id?: string | null;
}

/** Journalise un mouvement de stock et plafonne l'historique de la guilde à 500 entrées (les plus anciennes sont purgées). */
export async function addStockHistory(guildId: string, data: StockHistoryInput): Promise<void> {
  await prisma.stockHistory.create({
    data: {
      guildId,
      timestamp: new Date(data.timestamp),
      joueur: data.joueur,
      action: data.action,
      item: data.item,
      quantite: data.quantite,
      stockAvant: data.stock_avant,
      stockApres: data.stock_apres,
      channelId: data.channel_id ?? null,
    },
  });
  // Plafonne l'historique de CETTE guilde à 500 entrées (les plus anciennes
  // sont purgées) — le `where: { guildId }` est indispensable ici : sans lui,
  // le tri global par `id` autoincrémenté purgerait les plus vieilles lignes
  // d'une AUTRE guilde selon l'ordre d'insertion, pas celles de `guildId`.
  const excess = await prisma.stockHistory.findMany({
    where: { guildId },
    orderBy: { id: 'desc' },
    skip: 500,
    select: { id: true },
    take: 1000,
  });
  if (excess.length) {
    await prisma.stockHistory.deleteMany({ where: { id: { in: excess.map(r => r.id) } } });
  }
}

/**
 * Derniers mouvements de stock d'une guilde, du plus récent au plus ancien,
 * filtrés par item et/ou coffre (salon `logs_coffres`) si fournis.
 * `channelId` ne filtre que les lignes enregistrées depuis l'ajout de ce
 * suivi (voir `channelId` dans le modèle StockHistory — `null` sur les
 * lignes plus anciennes, jamais retournées par ce filtre).
 */
export async function getRecentStockHistory(guildId: string, item: string | null = null, limit = 20, channelId: string | null = null) {
  const rows = await prisma.stockHistory.findMany({
    where: {
      guildId,
      ...(item ? { item: item.toLowerCase() } : {}),
      ...(channelId ? { channelId } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit,
  });
  return rows.map(r => ({ ...r, timestamp: toMs(r.timestamp) }));
}

// ─── TRANSACTIONS ────────────────────────────────────────────────────────────

export interface TransactionInput {
  user_id: string;
  username?: string;
  action: string;
  quantite?: number;
  type?: string | null;
  partenaires?: string[];
  temps_restant?: string | null;
  timestamp?: number;
}

/** Convertit une ligne Prisma `Transaction` : timestamp en ms, `partenaires` reparsé depuis son JSON stocké. */
function mapTransaction(t: Prisma.TransactionGetPayload<{}>) {
  let partenaires: string[] = [];
  try { partenaires = JSON.parse(t.partenaires); } catch { /* ignore */ }
  return { ...t, timestamp: toMs(t.timestamp), partenaires };
}

/** Enregistre une transaction (déclaration d'activité) et retourne son ID. */
export async function addTransaction(guildId: string, data: TransactionInput): Promise<number> {
  const row = await prisma.transaction.create({
    data: {
      guildId,
      userId: data.user_id,
      username: data.username || '',
      action: data.action,
      quantite: data.quantite || 0,
      type: data.type || null,
      partenaires: JSON.stringify(data.partenaires || []),
      tempsRestant: data.temps_restant || null,
      timestamp: new Date(data.timestamp || Date.now()),
    },
  });
  return row.id;
}

/** Une transaction non supprimée par ID, ou `undefined`. */
export async function getTransaction(guildId: string, id: number) {
  const row = await prisma.transaction.findFirst({ where: { id, guildId, deleted: false } });
  return row ? mapTransaction(row) : undefined;
}

/** Soft-delete une transaction (utilisé par `/supp`) en conservant qui l'a supprimée. */
export async function deleteTransaction(guildId: string, id: number, deletedBy: string): Promise<void> {
  await prisma.transaction.updateMany({ where: { id, guildId }, data: { deleted: true, deletedBy } });
}

/** Transactions non supprimées d'une guilde depuis `since`, de la plus récente à la plus ancienne. */
export async function getAllTransactions(guildId: string, since = 0) {
  const rows = await prisma.transaction.findMany({
    where: { guildId, deleted: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'desc' },
  });
  return rows.map(mapTransaction);
}

// ─── STATS ───────────────────────────────────────────────────────────────────

/** Toutes les lignes de stats d'un joueur (une ligne par action). */
export async function getUserStats(guildId: string, userId: string) {
  return prisma.stat.findMany({ where: { guildId, userId } });
}

/** Toutes les lignes de stats d'une guilde, tous joueurs confondus, en une seule requête — voir quotas.getAllUserQuotaSummaries (évite un N+1 sur /listquota, le classement et la paie hebdomadaire). */
export async function getAllStats(guildId: string) {
  return prisma.stat.findMany({ where: { guildId } });
}

/** Stats d'un joueur sous forme de carte `action → { count, points }`. */
export async function getUserStatMap(guildId: string, userId: string): Promise<Record<string, { count: number; points: number }>> {
  const rows = await getUserStats(guildId, userId);
  const map: Record<string, { count: number; points: number }> = {};
  for (const r of rows) map[r.action] = { count: r.count, points: r.points };
  return map;
}

/** Total de points par joueur d'une guilde, tous suivis, trié décroissant. */
export async function getAllUserTotals(guildId: string): Promise<Array<{ user_id: string; total_points: number }>> {
  const rows = await prisma.stat.groupBy({ by: ['userId'], where: { guildId }, _sum: { points: true } });
  return rows
    .map(r => ({ user_id: r.userId, total_points: r._sum.points ?? 0 }))
    .sort((a, b) => b.total_points - a.total_points);
}

/**
 * Retourne le nombre d'événements par type d'action entre `sinceTs` et
 * `untilTs` (exclu, défaut maintenant — donc "depuis sinceTs" par défaut,
 * comme avant), tous participants confondus (une transaction = un
 * événement). Les clés listées dans `quantityActions` sont sommées par
 * quantité plutôt que comptées.
 */
export async function getGroupActionTotals(guildId: string, sinceTs = 0, quantityActions: string[] = [], untilTs: number = Date.now()): Promise<Array<{ action: string; total: number }>> {
  const rows = await prisma.transaction.findMany({
    where: { guildId, deleted: false, timestamp: { gte: new Date(sinceTs), lt: new Date(untilTs) } },
    select: { action: true, quantite: true },
  });
  const totals = new Map<string, number>();
  for (const r of rows) {
    const add = quantityActions.includes(r.action) ? r.quantite : 1;
    totals.set(r.action, (totals.get(r.action) ?? 0) + add);
  }
  return [...totals.entries()].map(([action, total]) => ({ action, total }));
}

/**
 * Comme {@link getGroupActionTotals}, mais détaillé par joueur plutôt
 * qu'agrégé pour tout le groupe — base de la reconstruction de quota/paie
 * pour une semaine passée depuis `Transaction` (jamais purgée), contrairement
 * au cache `Stat` qui ne connaît que la période en cours (voir
 * `modules/quotas.ts`, fonctions `*ForRange`, et `src/api/routes/quotas.ts`).
 * `userId` optionnel filtre sur un seul joueur (évite de tout charger puis
 * filtrer en mémoire pour une vue "un seul joueur").
 */
export async function getUserActionTotals(guildId: string, sinceTs: number, untilTs: number, quantityActions: string[] = [], userId?: string): Promise<Array<{ userId: string; action: string; total: number }>> {
  const rows = await prisma.transaction.findMany({
    where: { guildId, deleted: false, timestamp: { gte: new Date(sinceTs), lt: new Date(untilTs) }, ...(userId ? { userId } : {}) },
    select: { userId: true, action: true, quantite: true },
  });
  const totals = new Map<string, { userId: string; action: string; total: number }>();
  for (const r of rows) {
    const key = `${r.userId}|${r.action}`;
    const add = quantityActions.includes(r.action) ? r.quantite : 1;
    const existing = totals.get(key);
    if (existing) existing.total += add;
    else totals.set(key, { userId: r.userId, action: r.action, total: add });
  }
  return [...totals.values()];
}

/** Total de munitions déclarées fabriquées depuis `sinceTs`. */
export async function getMunitionsFabriqueesDepuis(guildId: string, sinceTs: number): Promise<number> {
  const agg = await prisma.transaction.aggregate({
    where: { guildId, action: 'fabrication_munitions', deleted: false, timestamp: { gte: new Date(sinceTs) } },
    _sum: { quantite: true },
  });
  return agg._sum.quantite ?? 0;
}

/** Enregistre une vente de munitions. */
export async function addMunitionVente(guildId: string, data: { vendeur_id: string; vendeur_username?: string; acheteur_id: string; quantite: number; prix: number }): Promise<void> {
  await prisma.munitionVente.create({
    data: {
      guildId,
      vendeurId: data.vendeur_id,
      vendeurUsername: data.vendeur_username || '',
      acheteurId: data.acheteur_id,
      quantite: data.quantite,
      prix: data.prix,
    },
  });
}

/** Total de munitions vendues depuis `sinceTs`. */
export async function getMunitionsVenduesDepuis(guildId: string, sinceTs: number): Promise<number> {
  const agg = await prisma.munitionVente.aggregate({
    where: { guildId, timestamp: { gte: new Date(sinceTs) } },
    _sum: { quantite: true },
  });
  return agg._sum.quantite ?? 0;
}

/** Ventes de munitions depuis `sinceTs` (détail ligne par ligne, pas juste le total), du plus récent au plus ancien — pas de limite, contrairement à {@link getMunitionsVentesHistorique}. */
export async function getMunitionsVentesDepuis(guildId: string, sinceTs: number) {
  const rows = await prisma.munitionVente.findMany({
    where: { guildId, timestamp: { gte: new Date(sinceTs) } },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true, quantite: true, acheteurId: true, prix: true },
  });
  return rows.map(r => ({ timestamp: toMs(r.timestamp), quantite: r.quantite, acheteur_id: r.acheteurId, prix: r.prix }));
}

/** Dernières déclarations de fabrication de munitions, du plus récent au plus ancien. */
export async function getFabricationMunitionsHistorique(guildId: string, limite = 15) {
  const rows = await prisma.transaction.findMany({
    where: { guildId, action: 'fabrication_munitions', deleted: false },
    orderBy: { timestamp: 'desc' },
    take: limite,
    select: { timestamp: true, quantite: true, username: true },
  });
  return rows.map(r => ({ ...r, timestamp: toMs(r.timestamp) }));
}

/** Dernières ventes de munitions, du plus récent au plus ancien. */
export async function getMunitionsVentesHistorique(guildId: string, limite = 15) {
  const rows = await prisma.munitionVente.findMany({
    where: { guildId },
    orderBy: { timestamp: 'desc' },
    take: limite,
    select: { timestamp: true, quantite: true, acheteurId: true, prix: true },
  });
  return rows.map(r => ({ timestamp: toMs(r.timestamp), quantite: r.quantite, acheteur_id: r.acheteurId, prix: r.prix }));
}

/**
 * Purge les ventes de munitions d'une guilde antérieures à `beforeTs`,
 * retourne le nombre supprimé. Contrairement à `transactions` (voir
 * `getUserActionTotals` / `*ForRange` dans quotas.ts), cette table
 * n'alimente aucune navigation par semaine passée — juste un compteur
 * "cette semaine" et les 15 dernières ventes (voir
 * `getMunitionsVentesDepuis`/`getMunitionsVentesHistorique`) — rien ne
 * justifie de la garder indéfiniment.
 */
export async function deleteOldMunitionVentes(guildId: string, beforeTs: number): Promise<number> {
  const { count } = await prisma.munitionVente.deleteMany({ where: { guildId, timestamp: { lt: new Date(beforeTs) } } });
  return count;
}

/** Incrémente (upsert) le compteur et les points d'une stat pour un joueur/action. */
export async function incrementStat(guildId: string, userId: string, action: string, countDelta = 1, pointsDelta = 0): Promise<void> {
  await prisma.stat.upsert({
    where: { guildId_userId_action: { guildId, userId, action } },
    create: { guildId, userId, action, count: countDelta, points: pointsDelta },
    update: { count: { increment: countDelta }, points: { increment: pointsDelta } },
  });
}

/** Décrémente une stat existante (utilisé par `/supp`), jamais sous zéro ; no-op si la ligne n'existe pas. */
export async function decrementStat(guildId: string, userId: string, action: string, countDelta = 1, pointsDelta = 0): Promise<void> {
  const row = await prisma.stat.findUnique({ where: { guildId_userId_action: { guildId, userId, action } } });
  if (!row) return;
  await prisma.stat.update({
    where: { guildId_userId_action: { guildId, userId, action } },
    data: {
      count: Math.max(0, row.count - countDelta),
      points: Math.max(0, row.points - pointsDelta),
    },
  });
}

/** Supprime toutes les stats d'une guilde (reset hebdomadaire). */
export async function resetAllStats(guildId: string): Promise<void> {
  await prisma.stat.deleteMany({ where: { guildId } });
}

// ─── COOLDOWNS ───────────────────────────────────────────────────────────────

/** Timestamp d'expiration (ms) du cooldown d'un joueur/action, ou 0 si aucun. */
export async function getCooldown(guildId: string, userId: string, action: string): Promise<number> {
  const row = await prisma.cooldown.findUnique({ where: { guildId_userId_action: { guildId, userId, action } } });
  return row ? toMs(row.expiresAt) : 0;
}

/** Fixe (upsert) le cooldown d'un joueur/action et réinitialise son flag `notified`. */
export async function setCooldown(guildId: string, userId: string, action: string, expiresAt: number): Promise<void> {
  await prisma.cooldown.upsert({
    where: { guildId_userId_action: { guildId, userId, action } },
    create: { guildId, userId, action, expiresAt: new Date(expiresAt), notified: false },
    update: { expiresAt: new Date(expiresAt), notified: false },
  });
}

/** Tous les cooldowns encore actifs (non expirés) d'une guilde. */
export async function getActiveCooldowns(guildId: string) {
  const rows = await prisma.cooldown.findMany({ where: { guildId, expiresAt: { gt: new Date() } } });
  return rows.map(r => ({ ...r, expires_at: toMs(r.expiresAt) }));
}

/** Cooldowns d'une guilde expirés dont l'alerte de fin n'a pas encore été envoyée. */
export async function getExpiredUnnotifiedCooldowns(guildId: string) {
  const rows = await prisma.cooldown.findMany({ where: { guildId, expiresAt: { lte: new Date() }, notified: false } });
  return rows.map(r => ({ ...r, expires_at: toMs(r.expiresAt) }));
}

/** Marque un cooldown comme déjà notifié (évite une double alerte de fin de cooldown). */
export async function markCooldownNotified(guildId: string, userId: string, action: string): Promise<void> {
  await prisma.cooldown.updateMany({ where: { guildId, userId, action }, data: { notified: true } });
}

/** Supprime le cooldown d'un joueur/action. */
export async function removeCooldown(guildId: string, userId: string, action: string): Promise<void> {
  await prisma.cooldown.deleteMany({ where: { guildId, userId, action } });
}

// ─── BRAQUAGES (fenêtre glissante 7 jours) ───────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Enregistre un braquage (consomme un slot de la fenêtre glissante de 7 jours). */
export async function addBraquage(guildId: string, userId: string, action: string): Promise<void> {
  await prisma.braquage.create({ data: { guildId, userId, action, timestamp: new Date() } });
}

/** Nombre de braquages d'un type donné dans les 7 derniers jours, pour une guilde. */
export async function getBraquageCount(guildId: string, action: string): Promise<number> {
  return prisma.braquage.count({ where: { guildId, action, timestamp: { gte: new Date(Date.now() - SEVEN_DAYS_MS) } } });
}

/** Purge les entrées de braquage sorties de la fenêtre glissante de 7 jours, toutes guildes confondues — la fenêtre glissante rend le filtrage par guilde inutile ici (une entrée hors fenêtre l'est pour toutes). */
export async function cleanOldBraquages(): Promise<void> {
  await prisma.braquage.deleteMany({ where: { timestamp: { lt: new Date(Date.now() - SEVEN_DAYS_MS) } } });
}

/** Timestamp (ms) du braquage le plus ancien encore dans la fenêtre de 7 jours pour une action, ou `null`. */
export async function getOldestBraquage(guildId: string, action: string): Promise<number | null> {
  const row = await prisma.braquage.findFirst({
    where: { guildId, action, timestamp: { gte: new Date(Date.now() - SEVEN_DAYS_MS) } },
    orderBy: { timestamp: 'asc' },
  });
  return row ? toMs(row.timestamp) : null;
}

/**
 * Supprime l'entrée de braquage la plus récente pour (userId, action), pour
 * libérer le slot hebdomadaire qu'elle consommait — utilisé par `/supp`
 * quand la transaction annulée est un braquage. Les entrées de `braquages`
 * n'étant pas liées à une transaction précise, on cible la plus récente :
 * `/supp` corrige presque toujours une erreur juste après coup.
 */
export async function removeMostRecentBraquage(guildId: string, userId: string, action: string): Promise<void> {
  const row = await prisma.braquage.findFirst({ where: { guildId, userId, action }, orderBy: { timestamp: 'desc' } });
  if (row) await prisma.braquage.deleteMany({ where: { id: row.id, guildId } });
}

// ─── TAXES ───────────────────────────────────────────────────────────────────

export interface TaxeInput {
  nom: string;
  type: string;
  telephone?: string | null;
  echeance: number;
  mot_de_passe?: string | null;
  paye?: boolean;
}

/** Convertit une ligne Prisma `Taxe` : `echeance` en millisecondes epoch. */
function mapTaxe<T extends { echeance: Date }>(t: T) {
  return { ...t, echeance: toMs(t.echeance) };
}

/** Crée une taxe et retourne son ID. */
export async function addTaxe(guildId: string, data: TaxeInput): Promise<number> {
  const row = await prisma.taxe.create({
    data: {
      guildId,
      nom: data.nom,
      type: data.type,
      telephone: data.telephone ?? null,
      echeance: new Date(data.echeance),
      motDePasse: data.mot_de_passe ?? null,
      paye: data.paye !== false,
    },
  });
  return row.id;
}

/** Une taxe active (non soft-deleted) par ID, ou `undefined`. */
export async function getTaxe(guildId: string, id: number) {
  const row = await prisma.taxe.findFirst({ where: { id, guildId, actif: true } });
  return row ? mapTaxe(row) : undefined;
}

/**
 * Taxe active ET non expirée pour un type donné, ou undefined — utilisé pour
 * bloquer la création d'une nouvelle taxe tant qu'une autre du même type est
 * encore en cours. `actif` (soft-delete) ne suffit pas seul : une taxe
 * expirée mais pas encore supprimée ne doit PAS bloquer une nouvelle
 * création, d'où le filtre supplémentaire sur `echeance`.
 */
export async function getActiveTaxeByType(guildId: string, type: string) {
  const row = await prisma.taxe.findFirst({ where: { guildId, type, actif: true, echeance: { gt: new Date() } } });
  return row ? mapTaxe(row) : undefined;
}

/** Toutes les taxes actives d'une guilde, triées par échéance croissante. */
export async function getAllTaxes(guildId: string) {
  const rows = await prisma.taxe.findMany({ where: { guildId, actif: true }, orderBy: { echeance: 'asc' } });
  return rows.map(mapTaxe);
}

/** Taxes actives et expirées d'une guilde, en excluant les types au cycle géré différemment (ex. les zones). */
export async function getExpiredTaxes(guildId: string, excludeTypes: string[] = []) {
  const rows = await prisma.taxe.findMany({
    where: {
      guildId,
      actif: true,
      echeance: { lte: new Date() },
      ...(excludeTypes.length ? { type: { notIn: excludeTypes } } : {}),
    },
  });
  return rows.map(mapTaxe);
}

export interface FindTaxesOptions {
  /** Restreint aux types listés (ex. `taxes.FIXED_TYPES` et/ou `taxes.ZONE_TYPE_KEYS`, voir modules/taxes.ts) — omis = tous types confondus. */
  types?: string[];
  /** `true` = uniquement expirées, `false` = uniquement en cours, omis = les deux. */
  expired?: boolean;
  /** Sous-chaîne sur `nom`, insensible à la casse — omis = pas de filtre par nom. */
  query?: string;
  limit?: number;
}

/**
 * Recherche flexible de taxes actives (non soft-deleted) d'une guilde —
 * combine filtre par type(s), par état (en cours/expirée), et par nom, selon
 * les options fournies. Base de `GET /api/taxes` (list, filtres type/état)
 * et `GET /api/taxes/search` (recherche par nom dans un type donné) — voir
 * `src/api/routes/taxes.ts`. Remplace `getAllTaxes`/`getExpiredTaxes` pour
 * ces deux usages (gardées telles quelles pour leurs appelants existants,
 * qui n'ont pas besoin de cette flexibilité).
 */
export async function findTaxes(guildId: string, opts: FindTaxesOptions = {}) {
  const now = new Date();
  const rows = await prisma.taxe.findMany({
    where: {
      guildId,
      actif: true,
      ...(opts.types ? { type: { in: opts.types } } : {}),
      ...(opts.expired === true ? { echeance: { lte: now } } : {}),
      ...(opts.expired === false ? { echeance: { gt: now } } : {}),
      ...(opts.query ? { nom: { contains: opts.query, mode: 'insensitive' } } : {}),
    },
    orderBy: { echeance: 'asc' },
    take: opts.limit,
  });
  return rows.map(mapTaxe);
}

/** Ajoute `days` jours à l'échéance d'une taxe (au moins depuis maintenant) et retourne la nouvelle échéance, ou `null` si introuvable. */
export async function renewTaxe(guildId: string, id: number, days: number): Promise<number | null> {
  const taxe = await getTaxe(guildId, id);
  if (!taxe) return null;
  const base = Math.max(Date.now(), taxe.echeance);
  const newDate = base + days * 24 * 60 * 60 * 1000;
  await prisma.taxe.updateMany({ where: { id, guildId }, data: { echeance: new Date(newDate), alerteSent: false, paye: false } });
  return newDate;
}

/** Marque une taxe comme payée ou non. */
export async function setTaxePaye(guildId: string, id: number, paye: boolean): Promise<void> {
  await prisma.taxe.updateMany({ where: { id, guildId }, data: { paye } });
}

/** Soft-delete une taxe (`actif: false`). */
export async function deleteTaxe(guildId: string, id: number): Promise<void> {
  await prisma.taxe.updateMany({ where: { id, guildId }, data: { actif: false } });
}

/** Marque l'alerte d'expiration d'une taxe comme envoyée (évite une double alerte). */
export async function markTaxeAlerteSent(guildId: string, id: number): Promise<void> {
  await prisma.taxe.updateMany({ where: { id, guildId }, data: { alerteSent: true } });
}

// ─── USER MAPPING (nom jeu ↔ Discord) ────────────────────────────────────────

/** Associe (upsert) un nom en jeu à un compte Discord. */
export async function setUserMapping(guildId: string, gameName: string, discordId: string): Promise<void> {
  await prisma.userMapping.upsert({
    where: { guildId_gameName_discordId: { guildId, gameName: gameName.toLowerCase(), discordId } },
    create: { guildId, gameName: gameName.toLowerCase(), discordId },
    update: {},
  });
}

/** Comptes Discord associés à un nom en jeu (généralement un seul). */
export async function getUserMappings(guildId: string, gameName: string): Promise<string[]> {
  const rows = await prisma.userMapping.findMany({ where: { guildId, gameName: gameName.toLowerCase() } });
  return rows.map(r => r.discordId);
}

/** Toutes les associations nom en jeu ↔ Discord d'une guilde, triées par nom en jeu. */
export async function getAllUserMappings(guildId: string) {
  return prisma.userMapping.findMany({ where: { guildId }, orderBy: { gameName: 'asc' } });
}

/** Supprime une association nom en jeu ↔ Discord ; sans `discordId`, supprime tous les comptes associés à ce nom. */
export async function deleteUserMapping(guildId: string, gameName: string, discordId: string | null = null): Promise<void> {
  if (discordId) {
    await prisma.userMapping.deleteMany({ where: { guildId, gameName: gameName.toLowerCase(), discordId } });
  } else {
    await prisma.userMapping.deleteMany({ where: { guildId, gameName: gameName.toLowerCase() } });
  }
}

// ─── PENDING SALES (ventes en attente de confirmation) ───────────────────────

export interface PendingSaleInput {
  joueur: string;
  discord_id?: string | null;
  item: string;
  quantite: number;
  timestamp: number;
}

/** Convertit une ligne Prisma `PendingSale` : `timestamp` en millisecondes epoch. */
function mapPendingSale<T extends { timestamp: Date }>(r: T) {
  return { ...r, timestamp: toMs(r.timestamp) };
}

/** Crée une vente en attente et retourne son ID. */
export async function createPendingSale(guildId: string, data: PendingSaleInput): Promise<number> {
  const row = await prisma.pendingSale.create({
    data: {
      guildId,
      joueur: data.joueur,
      discordId: data.discord_id ?? null,
      item: data.item,
      quantite: data.quantite,
      timestamp: new Date(data.timestamp),
    },
  });
  return row.id;
}

/** Une vente en attente par ID, ou `undefined`. */
export async function getPendingSale(guildId: string, id: number) {
  const row = await prisma.pendingSale.findFirst({ where: { id, guildId } });
  return row ? mapPendingSale(row) : undefined;
}

/** Associe le message Discord de l'alerte à une vente en attente. */
export async function updatePendingSaleMessage(guildId: string, id: number, messageId: string, channelId: string): Promise<void> {
  await prisma.pendingSale.updateMany({ where: { id, guildId }, data: { messageId, channelId } });
}

/** Change le statut d'une vente en attente ('en_attente', 'declare', 'repose', 'confirme', 'ignore', 'expire'...). */
export async function updatePendingSaleStatut(guildId: string, id: number, statut: string): Promise<void> {
  await prisma.pendingSale.updateMany({ where: { id, guildId }, data: { statut } });
}

/** Corrige la quantité d'une vente en attente. */
export async function updatePendingSaleQuantite(guildId: string, id: number, quantite: number): Promise<void> {
  await prisma.pendingSale.updateMany({ where: { id, guildId }, data: { quantite } });
}

/** Associe (rétroactivement) un compte Discord à une vente en attente. */
export async function updatePendingSaleDiscordId(guildId: string, id: number, discordId: string): Promise<void> {
  await prisma.pendingSale.updateMany({ where: { id, guildId }, data: { discordId } });
}

/** Marque une vente en attente comme confirmée. */
export async function confirmPendingSale(guildId: string, id: number): Promise<void> {
  await prisma.pendingSale.updateMany({ where: { id, guildId }, data: { confirmed: true, statut: 'confirme' } });
}

/** Vente en attente accumulable (même joueur/item, pas encore confirmée) depuis `since`, la plus récente. */
export async function getPendingSaleForAccumulation(guildId: string, joueur: string, item: string, since: number) {
  const row = await prisma.pendingSale.findFirst({
    where: { guildId, joueur, item, statut: 'en_attente', confirmed: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'desc' },
  });
  return row ? mapPendingSale(row) : undefined;
}

/** Cumule une nouvelle quantité sur une vente en attente existante et rafraîchit son timestamp. */
export async function accumulatePendingSale(guildId: string, id: number, quantite: number, timestamp: number): Promise<void> {
  await prisma.pendingSale.updateMany({ where: { id, guildId }, data: { quantite, timestamp: new Date(timestamp) } });
}

/** Ventes déclarées d'un joueur en attente de confirmation (dépôt d'argent) depuis `since`. */
export async function getPendingSalesForConfirmation(guildId: string, joueur: string, since: number) {
  const rows = await prisma.pendingSale.findMany({
    where: { guildId, joueur, statut: 'declare', confirmed: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'asc' },
  });
  return rows.map(mapPendingSale);
}

/** Vente reposée d'un joueur/item en attente de vérification depuis `since`, la plus récente. */
export async function getPendingSaleRepose(guildId: string, joueur: string, item: string, since: number) {
  const row = await prisma.pendingSale.findFirst({
    where: { guildId, joueur, item, statut: 'repose', confirmed: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'desc' },
  });
  return row ? mapPendingSale(row) : undefined;
}

/**
 * Ventes en attente d'une action pour la confirmer, plus vieilles que
 * `before` — inclut 'en_attente' (rien déclaré) mais aussi 'declare' et
 * 'repose' : une vente déclarée dont le dépôt d'argent n'arrive jamais (ou
 * reposée dont le redépôt n'arrive jamais) reste sinon bloquée indéfiniment,
 * son message affichant "en attente" sans plus aucun bouton pour agir dessus.
 */
export async function getExpiredPendingSales(guildId: string, before: number) {
  const rows = await prisma.pendingSale.findMany({
    where: { guildId, statut: { in: ['en_attente', 'declare', 'repose'] }, timestamp: { lt: new Date(before) }, messageId: { not: null } },
  });
  return rows.map(mapPendingSale);
}

/**
 * Purge les ventes en attente TERMINÉES (confirmée/reposée/ignorée/expirée)
 * d'une guilde antérieures à `beforeTs`, retourne le nombre supprimé. Ne
 * touche jamais 'en_attente'/'declare' (en cours) quelle que soit leur
 * ancienneté — garde-fou défensif, même si ces statuts ne devraient de toute
 * façon jamais durer au-delà de la fenêtre de confirmation de 3h (voir
 * `getExpiredPendingSales`, qui les fait justement basculer vers un statut
 * terminal). Pure debris opérationnel une fois terminée : le vrai
 * historique de vente vit dans `transactions`, jamais dans cette table (voir
 * `getVenteTotalsForRange`).
 */
export async function deleteOldPendingSales(guildId: string, beforeTs: number): Promise<number> {
  const { count } = await prisma.pendingSale.deleteMany({
    where: { guildId, timestamp: { lt: new Date(beforeTs) }, statut: { in: ['confirme', 'repose', 'ignore', 'expire'] } },
  });
  return count;
}

// ─── VENTES CONFIRMÉES SUR UNE PLAGE (API) ─────────────────────────────────────
//
// Une vente confirmée (voir `tryConfirmMoneyDeposit`/`tryConfirmRedeposit`
// dans modules/ventes.ts) écrit une `Transaction` (`action: 'vente'`, `type`
// = l'item vendu, `quantite` = quantité) EN PLUS de créditer le quota — les
// deux fonctions ci-dessous relisent cette même `Transaction` (jamais
// purgée), même principe que les fonctions `*ForRange` de `modules/quotas.ts`
// pour naviguer sur une semaine passée via `?week=` (voir
// `src/api/routes/ventes.ts`). `total` ici est donc toujours identique à
// `byQuotaType['vente']` d'un résumé de quota pour la même plage — une seule
// vérité, jamais deux calculs divergents.

/** Total vendu par joueur d'une guilde (toutes drogues confondues) sur une plage — base de `GET /api/ventes`. */
export async function getVenteTotalsForRange(guildId: string, sinceTs: number, untilTs: number): Promise<Array<{ userId: string; total: number }>> {
  const rows = await prisma.transaction.groupBy({
    by: ['userId'],
    where: { guildId, deleted: false, action: 'vente', timestamp: { gte: new Date(sinceTs), lt: new Date(untilTs) } },
    _sum: { quantite: true },
  });
  return rows.map(r => ({ userId: r.userId, total: r._sum.quantite ?? 0 }));
}

/** Détail par item vendu (`Transaction.type`) d'UN joueur sur une plage — base de `GET /api/ventes/:userId`. */
export async function getVenteDetailForUser(guildId: string, userId: string, sinceTs: number, untilTs: number): Promise<Array<{ item: string; quantite: number }>> {
  const rows = await prisma.transaction.groupBy({
    by: ['type'],
    where: { guildId, deleted: false, action: 'vente', userId, timestamp: { gte: new Date(sinceTs), lt: new Date(untilTs) } },
    _sum: { quantite: true },
  });
  return rows.map(r => ({ item: r.type ?? 'inconnu', quantite: r._sum.quantite ?? 0 }));
}

// ─── VÉHICULES / FOURRIÈRE ────────────────────────────────────────────────────

/** État courant (responsable) d'un véhicule par plaque, ou `undefined` si jamais vu. */
export async function getVehiculeEtat(guildId: string, plaque: string) {
  const row = await prisma.vehicule.findUnique({ where: { guildId_plaque: { guildId, plaque } } });
  return row ? { ...row, timestamp: toMs(row.timestamp) } : undefined;
}

/** Fixe (upsert) le responsable courant d'un véhicule. */
export async function setVehiculeEtat(guildId: string, data: { plaque: string; modele?: string | null; discord_id?: string | null; joueur: string; timestamp?: number }): Promise<void> {
  const shared = {
    modele: data.modele ?? null,
    discordId: data.discord_id ?? null,
    joueur: data.joueur,
    timestamp: new Date(data.timestamp ?? Date.now()),
  };
  await prisma.vehicule.upsert({
    where: { guildId_plaque: { guildId, plaque: data.plaque } },
    create: { guildId, plaque: data.plaque, ...shared },
    update: shared,
  });
}

/** Efface le responsable courant d'un véhicule (rangé proprement dans un garage). */
export async function clearVehiculeEtat(guildId: string, plaque: string): Promise<void> {
  await prisma.vehicule.updateMany({ where: { guildId, plaque }, data: { discordId: null, joueur: null } });
}

/** Enregistre une mise en fourrière et retourne son ID. */
export async function addFourriere(guildId: string, data: { discord_id?: string | null; joueur: string; plaque: string; modele?: string | null; timestamp?: number }): Promise<number> {
  const row = await prisma.fourriere.create({
    data: {
      guildId,
      discordId: data.discord_id ?? null,
      joueur: data.joueur,
      plaque: data.plaque,
      modele: data.modele ?? null,
      timestamp: new Date(data.timestamp ?? Date.now()),
    },
  });
  return row.id;
}

/** Classement cumulé des mises en fourrière d'une guilde par joueur, décroissant. */
export async function getFourriereClassement(guildId: string): Promise<Array<{ discord_id: string | null; joueur: string; total: number }>> {
  const rows = await prisma.fourriere.findMany({ where: { guildId }, select: { discordId: true, joueur: true } });
  const totals = new Map<string, { discord_id: string | null; joueur: string; total: number }>();
  for (const r of rows) {
    // Préfixe `unmapped_` : sans lui, tous les joueurs jamais mappés à un
    // compte Discord partageraient la même clé `null` et verraient leurs
    // fourrières comptées ensemble au lieu d'une ligne par joueur.
    const key = r.discordId ?? `unmapped_${r.joueur}`;
    const existing = totals.get(key);
    if (existing) existing.total += 1;
    else totals.set(key, { discord_id: r.discordId, joueur: r.joueur, total: 1 });
  }
  return [...totals.values()].sort((a, b) => b.total - a.total);
}

/** Supprime tout l'historique de mises en fourrière d'une guilde (reset hebdomadaire du classement). */
export async function clearFourrieres(guildId: string): Promise<void> {
  await prisma.fourriere.deleteMany({ where: { guildId } });
}

// ─── ARMURERIE ────────────────────────────────────────────────────────────────

/** Ajoute une arme à l'armurerie (statut par défaut 'en_stock') et retourne son ID. */
export async function addArme(guildId: string, nom: string, reference: string, type: string): Promise<number> {
  const row = await prisma.arme.create({ data: { guildId, nom, reference, type } });
  return row.id;
}

/** Change le type (clé de `ARME_TYPES`) d'une arme existante. */
export async function updateArmeType(guildId: string, id: number, type: string): Promise<void> {
  await prisma.arme.updateMany({ where: { id, guildId }, data: { type } });
}

/** Toutes les armes d'une guilde, triées par nom. */
export async function getAllArmes(guildId: string) {
  return prisma.arme.findMany({ where: { guildId }, orderBy: { nom: 'asc' } });
}

/** Une arme par ID, ou `undefined`. */
export async function getArme(guildId: string, id: number) {
  return (await prisma.arme.findFirst({ where: { id, guildId } })) ?? undefined;
}

/** Change le statut ('en_stock' | 'pretee' | 'perdue') d'une arme, et à qui elle est prêtée le cas échéant. */
export async function updateArmeStatut(guildId: string, id: number, statut: string, preteeA: string | null = null): Promise<void> {
  await prisma.arme.updateMany({ where: { id, guildId }, data: { statut, preteeA } });
}

/** Supprime définitivement une arme. */
export async function deleteArme(guildId: string, id: number): Promise<void> {
  await prisma.arme.deleteMany({ where: { id, guildId } });
}

/** Toutes les armes au statut 'perdue' d'une guilde, triées par nom. */
export async function getArmesPerdue(guildId: string) {
  return prisma.arme.findMany({ where: { guildId, statut: 'perdue' }, orderBy: { nom: 'asc' } });
}
