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
 */
import { PrismaClient, type Prisma } from '@prisma/client';

export const prisma = new PrismaClient();

/** Convertit une colonne `TIMESTAMPTZ` (ou `null`) en millisecondes epoch. */
const toMs = (d: Date | null | undefined): number => (d ? d.getTime() : 0);

// ─── SETTINGS (scalaires nommés — voir docstring du modèle Setting) ─────────

/** Lit un `Setting` scalaire par clé, ou `null` si absent. */
export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row ? row.value : null;
}

/** Écrit (upsert) un `Setting` scalaire — `value` est converti en chaîne. */
export async function setSetting(key: string, value: unknown): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: String(value) },
    update: { value: String(value) },
  });
}

/** Supprime un `Setting` par clé (no-op si absent). */
export async function deleteSetting(key: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key } });
}

// ─── CHANNELS (config) ────────────────────────────────────────────────────────

/** Toutes les associations rôle → salon en une requête (utilisé par config-store.reload()). */
export async function getAllChannels() {
  return prisma.channel.findMany();
}

/** Retourne les salons assignés à un rôle (généralement un seul, sauf 'logs_coffres'). */
export async function getChannelsByRole(role: string): Promise<string[]> {
  return (await prisma.channel.findMany({ where: { role } })).map(r => r.channelId);
}

/** Remplace le(s) salon(s) d'un rôle à valeur unique (stock_general, quotas, ...) par un seul. */
export async function setChannelRole(role: string, channelId: string): Promise<void> {
  await prisma.channel.deleteMany({ where: { role } });
  await prisma.channel.create({ data: { role, channelId } });
}

/** Ajoute un salon à un rôle à valeurs multiples (ex. 'logs_coffres'), sans toucher aux autres. */
export async function addChannelToRole(role: string, channelId: string): Promise<void> {
  await prisma.channel.upsert({
    where: { role_channelId: { role, channelId } },
    create: { role, channelId },
    update: {},
  });
}

/** Retire un salon d'un rôle à valeurs multiples (ex. 'logs_coffres'). */
export async function removeChannelFromRole(role: string, channelId: string): Promise<void> {
  await prisma.channel.deleteMany({ where: { role, channelId } });
}

// ─── RÔLES DISCORD (config) ──────────────────────────────────────────────────

/** Associe (upsert) un rôle Discord à un usage du bot (ex. 'admin', 'taxes'). */
export async function setDiscordRole(target: string, roleId: string): Promise<void> {
  await prisma.discordRole.upsert({ where: { target }, create: { target, roleId }, update: { roleId } });
}

/** Toutes les associations usage → rôle Discord configurées. */
export async function getAllDiscordRoles() {
  return prisma.discordRole.findMany();
}

// ─── ITEMS (config) ─────────────────────────────────────────────────────────

export interface ItemInput {
  name: string;
  stock_group?: string | null;
  vente?: boolean;
  vente_paiement?: boolean;
  display_order?: number;
  /** Défaut `true` (contrairement aux autres flags, défaut `false`) : omettre cette option ne doit pas faire disparaître un item du Stock Général. */
  visible_stock?: boolean;
  /** Clé d'activité labo (ex. "labo_cocaine") si cet item est LA drogue que ce labo produit — voir docstring du modèle Item. */
  labo_lie?: string | null;
}

/** Ajoute ou remplace entièrement la configuration d'un item suivi (upsert complet, voir docstring de `/config item add`). */
export async function upsertItem(data: ItemInput): Promise<void> {
  await prisma.item.upsert({
    where: { name: data.name },
    create: {
      name: data.name,
      stockGroup: data.stock_group ?? null,
      vente: !!data.vente,
      ventePaiement: !!data.vente_paiement,
      displayOrder: data.display_order ?? 0,
      visibleStock: data.visible_stock !== false,
      laboLie: data.labo_lie ?? null,
    },
    update: {
      stockGroup: data.stock_group ?? null,
      vente: !!data.vente,
      ventePaiement: !!data.vente_paiement,
      displayOrder: data.display_order ?? 0,
      visibleStock: data.visible_stock !== false,
      laboLie: data.labo_lie ?? null,
    },
  });
}

/** Retire un item suivi (ne supprime pas son stock/historique). */
export async function deleteItem(name: string): Promise<void> {
  await prisma.item.deleteMany({ where: { name } });
}

/** Tous les items suivis, triés par ordre d'affichage puis par nom. */
export async function getAllItems() {
  return prisma.item.findMany({ orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] });
}

// ─── QUOTA TARGETS (config) ──────────────────────────────────────────────────

/** Fixe (upsert) l'objectif hebdomadaire d'une catégorie de quota. */
export async function setQuotaTarget(quotaType: string, weeklyTarget: number): Promise<void> {
  await prisma.quotaTarget.upsert({
    where: { quotaType },
    create: { quotaType, weeklyTarget },
    update: { weeklyTarget },
  });
}

/** Retire l'objectif d'une catégorie de quota (elle reste suivie, sans cible). */
export async function deleteQuotaTarget(quotaType: string): Promise<void> {
  await prisma.quotaTarget.deleteMany({ where: { quotaType } });
}

/** Tous les objectifs de quota configurés. */
export async function getAllQuotaTargets() {
  return prisma.quotaTarget.findMany();
}

// ─── SALARY RATES (config) ───────────────────────────────────────────────────

/** Fixe (upsert) le taux de paie ($ par unité) d'une catégorie de quota. */
export async function setSalaryRate(quotaType: string, amount: number): Promise<void> {
  await prisma.salaryRate.upsert({
    where: { quotaType },
    create: { quotaType, amount },
    update: { amount },
  });
}

/** Retire le taux de paie d'une catégorie de quota (elle ne génère plus de paie). */
export async function deleteSalaryRate(quotaType: string): Promise<void> {
  await prisma.salaryRate.deleteMany({ where: { quotaType } });
}

/** Tous les taux de paie configurés. */
export async function getAllSalaryRates() {
  return prisma.salaryRate.findMany();
}

// ─── STOCKS ─────────────────────────────────────────────────────────────────

/** Quantité en stock d'un item (0 si jamais initialisé). */
export async function getStock(item: string): Promise<number> {
  const row = await prisma.stock.findUnique({ where: { item: item.toLowerCase() } });
  return row ? row.quantite : 0;
}

/**
 * Applique un delta au stock d'un item de façon atomique (une seule requête
 * SQL — upsert + valeur précédente lue dans la même instruction), et retourne
 * les quantités avant/après. Deux mouvements concurrents sur le même item
 * (ex. deux retraits de coffre détectés à quelques ms d'intervalle) ne
 * peuvent donc pas s'écraser l'un l'autre comme le ferait un
 * lire-puis-écrire en deux requêtes séparées.
 */
export async function applyStockDelta(item: string, delta: number): Promise<{ avant: number; apres: number }> {
  const key = item.toLowerCase();
  const rows = await prisma.$queryRaw<Array<{ avant: number; apres: number }>>`
    WITH prev AS (
      SELECT quantite FROM stocks WHERE item = ${key}
    ), upserted AS (
      INSERT INTO stocks (item, quantite) VALUES (${key}, GREATEST(${delta}, 0))
      ON CONFLICT (item) DO UPDATE SET quantite = GREATEST(stocks.quantite + ${delta}, 0)
      RETURNING quantite
    )
    SELECT COALESCE((SELECT quantite FROM prev), 0)::int AS avant, (SELECT quantite FROM upserted)::int AS apres
  `;
  return { avant: rows[0]?.avant ?? 0, apres: rows[0]?.apres ?? 0 };
}

/** Applique un delta au stock d'un item et retourne uniquement la quantité résultante (voir `applyStockDelta`). */
export async function updateStock(item: string, delta: number): Promise<number> {
  return (await applyStockDelta(item, delta)).apres;
}

/** Force la valeur du stock d'un item (correction manuelle) — jamais négative. */
export async function setStock(item: string, qty: number): Promise<void> {
  const key = item.toLowerCase();
  const quantite = Math.max(0, qty);
  await prisma.stock.upsert({ where: { item: key }, create: { item: key, quantite }, update: { quantite } });
}

/** Le stock de tous les items, trié par nom. */
export async function getAllStocks() {
  return prisma.stock.findMany({ orderBy: { item: 'asc' } });
}

/** Supprime tout le stock (resync complète). */
export async function resetAllStocks(): Promise<void> {
  await prisma.stock.deleteMany();
}

/** Supprime tout l'historique de mouvements de stock (resync complète). */
export async function clearStockHistory(): Promise<void> {
  await prisma.stockHistory.deleteMany();
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
}

/** Journalise un mouvement de stock et plafonne l'historique à 500 entrées (les plus anciennes sont purgées). */
export async function addStockHistory(data: StockHistoryInput): Promise<void> {
  await prisma.stockHistory.create({
    data: {
      timestamp: new Date(data.timestamp),
      joueur: data.joueur,
      action: data.action,
      item: data.item,
      quantite: data.quantite,
      stockAvant: data.stock_avant,
      stockApres: data.stock_apres,
    },
  });
  // Plafonne l'historique à 500 entrées (les plus anciennes sont purgées).
  const excess = await prisma.stockHistory.findMany({
    orderBy: { id: 'desc' },
    skip: 500,
    select: { id: true },
    take: 1000,
  });
  if (excess.length) {
    await prisma.stockHistory.deleteMany({ where: { id: { in: excess.map(r => r.id) } } });
  }
}

/** Derniers mouvements de stock, du plus récent au plus ancien, filtrés par item si fourni. */
export async function getRecentStockHistory(item: string | null = null, limit = 20) {
  const rows = await prisma.stockHistory.findMany({
    where: item ? { item: item.toLowerCase() } : undefined,
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
export async function addTransaction(data: TransactionInput): Promise<number> {
  const row = await prisma.transaction.create({
    data: {
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
export async function getTransaction(id: number) {
  const row = await prisma.transaction.findFirst({ where: { id, deleted: false } });
  return row ? mapTransaction(row) : undefined;
}

/** Soft-delete une transaction (utilisé par `/supp`) en conservant qui l'a supprimée. */
export async function deleteTransaction(id: number, deletedBy: string): Promise<void> {
  await prisma.transaction.updateMany({ where: { id }, data: { deleted: true, deletedBy } });
}

/** Transactions non supprimées depuis `since`, de la plus récente à la plus ancienne. */
export async function getAllTransactions(since = 0) {
  const rows = await prisma.transaction.findMany({
    where: { deleted: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'desc' },
  });
  return rows.map(mapTransaction);
}

// ─── STATS ───────────────────────────────────────────────────────────────────

/** Toutes les lignes de stats d'un joueur (une ligne par action). */
export async function getUserStats(userId: string) {
  return prisma.stat.findMany({ where: { userId } });
}

/** Toutes les lignes de stats, tous joueurs confondus, en une seule requête — voir quotas.getAllUserQuotaSummaries (évite un N+1 sur /listquota, le classement et la paie hebdomadaire). */
export async function getAllStats() {
  return prisma.stat.findMany();
}

/** Stats d'un joueur sous forme de carte `action → { count, points }`. */
export async function getUserStatMap(userId: string): Promise<Record<string, { count: number; points: number }>> {
  const rows = await getUserStats(userId);
  const map: Record<string, { count: number; points: number }> = {};
  for (const r of rows) map[r.action] = { count: r.count, points: r.points };
  return map;
}

/** Total de points par joueur, tous suivis, trié décroissant. */
export async function getAllUserTotals(): Promise<Array<{ user_id: string; total_points: number }>> {
  const rows = await prisma.stat.groupBy({ by: ['userId'], _sum: { points: true } });
  return rows
    .map(r => ({ user_id: r.userId, total_points: r._sum.points ?? 0 }))
    .sort((a, b) => b.total_points - a.total_points);
}

/**
 * Retourne le nombre d'événements par type d'action depuis `sinceTs`, tous
 * participants confondus (une transaction = un événement). Les clés listées
 * dans `quantityActions` sont sommées par quantité plutôt que comptées.
 */
export async function getGroupActionTotals(sinceTs = 0, quantityActions: string[] = []): Promise<Array<{ action: string; total: number }>> {
  const rows = await prisma.transaction.findMany({
    where: { deleted: false, timestamp: { gte: new Date(sinceTs) } },
    select: { action: true, quantite: true },
  });
  const totals = new Map<string, number>();
  for (const r of rows) {
    const add = quantityActions.includes(r.action) ? r.quantite : 1;
    totals.set(r.action, (totals.get(r.action) ?? 0) + add);
  }
  return [...totals.entries()].map(([action, total]) => ({ action, total }));
}

/** Total de munitions déclarées fabriquées depuis `sinceTs`. */
export async function getMunitionsFabriqueesDepuis(sinceTs: number): Promise<number> {
  const agg = await prisma.transaction.aggregate({
    where: { action: 'fabrication_munitions', deleted: false, timestamp: { gte: new Date(sinceTs) } },
    _sum: { quantite: true },
  });
  return agg._sum.quantite ?? 0;
}

/** Enregistre une vente de munitions. */
export async function addMunitionVente(data: { vendeur_id: string; vendeur_username?: string; acheteur_id: string; quantite: number; prix: number }): Promise<void> {
  await prisma.munitionVente.create({
    data: {
      vendeurId: data.vendeur_id,
      vendeurUsername: data.vendeur_username || '',
      acheteurId: data.acheteur_id,
      quantite: data.quantite,
      prix: data.prix,
    },
  });
}

/** Total de munitions vendues depuis `sinceTs`. */
export async function getMunitionsVenduesDepuis(sinceTs: number): Promise<number> {
  const agg = await prisma.munitionVente.aggregate({
    where: { timestamp: { gte: new Date(sinceTs) } },
    _sum: { quantite: true },
  });
  return agg._sum.quantite ?? 0;
}

/** Dernières déclarations de fabrication de munitions, du plus récent au plus ancien. */
export async function getFabricationMunitionsHistorique(limite = 15) {
  const rows = await prisma.transaction.findMany({
    where: { action: 'fabrication_munitions', deleted: false },
    orderBy: { timestamp: 'desc' },
    take: limite,
    select: { timestamp: true, quantite: true, username: true },
  });
  return rows.map(r => ({ ...r, timestamp: toMs(r.timestamp) }));
}

/** Dernières ventes de munitions, du plus récent au plus ancien. */
export async function getMunitionsVentesHistorique(limite = 15) {
  const rows = await prisma.munitionVente.findMany({
    orderBy: { timestamp: 'desc' },
    take: limite,
    select: { timestamp: true, quantite: true, acheteurId: true, prix: true },
  });
  return rows.map(r => ({ timestamp: toMs(r.timestamp), quantite: r.quantite, acheteur_id: r.acheteurId, prix: r.prix }));
}

/** Incrémente (upsert) le compteur et les points d'une stat pour un joueur/action. */
export async function incrementStat(userId: string, action: string, countDelta = 1, pointsDelta = 0): Promise<void> {
  await prisma.stat.upsert({
    where: { userId_action: { userId, action } },
    create: { userId, action, count: countDelta, points: pointsDelta },
    update: { count: { increment: countDelta }, points: { increment: pointsDelta } },
  });
}

/** Décrémente une stat existante (utilisé par `/supp`), jamais sous zéro ; no-op si la ligne n'existe pas. */
export async function decrementStat(userId: string, action: string, countDelta = 1, pointsDelta = 0): Promise<void> {
  const row = await prisma.stat.findUnique({ where: { userId_action: { userId, action } } });
  if (!row) return;
  await prisma.stat.update({
    where: { userId_action: { userId, action } },
    data: {
      count: Math.max(0, row.count - countDelta),
      points: Math.max(0, row.points - pointsDelta),
    },
  });
}

/** Supprime toutes les stats (reset hebdomadaire). */
export async function resetAllStats(): Promise<void> {
  await prisma.stat.deleteMany();
}

// ─── COOLDOWNS ───────────────────────────────────────────────────────────────

/** Timestamp d'expiration (ms) du cooldown d'un joueur/action, ou 0 si aucun. */
export async function getCooldown(userId: string, action: string): Promise<number> {
  const row = await prisma.cooldown.findUnique({ where: { userId_action: { userId, action } } });
  return row ? toMs(row.expiresAt) : 0;
}

/** Fixe (upsert) le cooldown d'un joueur/action et réinitialise son flag `notified`. */
export async function setCooldown(userId: string, action: string, expiresAt: number): Promise<void> {
  await prisma.cooldown.upsert({
    where: { userId_action: { userId, action } },
    create: { userId, action, expiresAt: new Date(expiresAt), notified: false },
    update: { expiresAt: new Date(expiresAt), notified: false },
  });
}

/** Tous les cooldowns encore actifs (non expirés). */
export async function getActiveCooldowns() {
  const rows = await prisma.cooldown.findMany({ where: { expiresAt: { gt: new Date() } } });
  return rows.map(r => ({ ...r, expires_at: toMs(r.expiresAt) }));
}

/** Cooldowns expirés dont l'alerte de fin n'a pas encore été envoyée. */
export async function getExpiredUnnotifiedCooldowns() {
  const rows = await prisma.cooldown.findMany({ where: { expiresAt: { lte: new Date() }, notified: false } });
  return rows.map(r => ({ ...r, expires_at: toMs(r.expiresAt) }));
}

/** Marque un cooldown comme déjà notifié (évite une double alerte de fin de cooldown). */
export async function markCooldownNotified(userId: string, action: string): Promise<void> {
  await prisma.cooldown.updateMany({ where: { userId, action }, data: { notified: true } });
}

/** Supprime le cooldown d'un joueur/action. */
export async function removeCooldown(userId: string, action: string): Promise<void> {
  await prisma.cooldown.deleteMany({ where: { userId, action } });
}

// ─── BRAQUAGES (fenêtre glissante 7 jours) ───────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Enregistre un braquage (consomme un slot de la fenêtre glissante de 7 jours). */
export async function addBraquage(userId: string, action: string): Promise<void> {
  await prisma.braquage.create({ data: { userId, action, timestamp: new Date() } });
}

/** Nombre de braquages d'un type donné dans les 7 derniers jours. */
export async function getBraquageCount(action: string): Promise<number> {
  return prisma.braquage.count({ where: { action, timestamp: { gte: new Date(Date.now() - SEVEN_DAYS_MS) } } });
}

/** Purge les entrées de braquage sorties de la fenêtre glissante de 7 jours. */
export async function cleanOldBraquages(): Promise<void> {
  await prisma.braquage.deleteMany({ where: { timestamp: { lt: new Date(Date.now() - SEVEN_DAYS_MS) } } });
}

/** Timestamp (ms) du braquage le plus ancien encore dans la fenêtre de 7 jours pour une action, ou `null`. */
export async function getOldestBraquage(action: string): Promise<number | null> {
  const row = await prisma.braquage.findFirst({
    where: { action, timestamp: { gte: new Date(Date.now() - SEVEN_DAYS_MS) } },
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
export async function removeMostRecentBraquage(userId: string, action: string): Promise<void> {
  const row = await prisma.braquage.findFirst({ where: { userId, action }, orderBy: { timestamp: 'desc' } });
  if (row) await prisma.braquage.delete({ where: { id: row.id } });
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
export async function addTaxe(data: TaxeInput): Promise<number> {
  const row = await prisma.taxe.create({
    data: {
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
export async function getTaxe(id: number) {
  const row = await prisma.taxe.findFirst({ where: { id, actif: true } });
  return row ? mapTaxe(row) : undefined;
}

/**
 * Taxe active ET non expirée pour un type donné, ou undefined — utilisé pour
 * bloquer la création d'une nouvelle taxe tant qu'une autre du même type est
 * encore en cours. `actif` (soft-delete) ne suffit pas seul : une taxe
 * expirée mais pas encore supprimée ne doit PAS bloquer une nouvelle
 * création, d'où le filtre supplémentaire sur `echeance`.
 */
export async function getActiveTaxeByType(type: string) {
  const row = await prisma.taxe.findFirst({ where: { type, actif: true, echeance: { gt: new Date() } } });
  return row ? mapTaxe(row) : undefined;
}

/** Toutes les taxes actives, triées par échéance croissante. */
export async function getAllTaxes() {
  const rows = await prisma.taxe.findMany({ where: { actif: true }, orderBy: { echeance: 'asc' } });
  return rows.map(mapTaxe);
}

/** Taxes actives et expirées, en excluant les types au cycle géré différemment (ex. les zones). */
export async function getExpiredTaxes(excludeTypes: string[] = []) {
  const rows = await prisma.taxe.findMany({
    where: {
      actif: true,
      echeance: { lte: new Date() },
      ...(excludeTypes.length ? { type: { notIn: excludeTypes } } : {}),
    },
  });
  return rows.map(mapTaxe);
}

/** Recherche des taxes actives par sous-chaîne de nom (insensible à la casse), 25 résultats max. */
export async function searchTaxNames(query: string): Promise<Array<{ id: number; nom: string }>> {
  return prisma.taxe.findMany({
    where: { actif: true, nom: { contains: query, mode: 'insensitive' } },
    select: { id: true, nom: true },
    take: 25,
  });
}

/** Ajoute `days` jours à l'échéance d'une taxe (au moins depuis maintenant) et retourne la nouvelle échéance, ou `null` si introuvable. */
export async function renewTaxe(id: number, days: number): Promise<number | null> {
  const taxe = await getTaxe(id);
  if (!taxe) return null;
  const base = Math.max(Date.now(), taxe.echeance);
  const newDate = base + days * 24 * 60 * 60 * 1000;
  await prisma.taxe.update({ where: { id }, data: { echeance: new Date(newDate), alerteSent: false, paye: false } });
  return newDate;
}

/** Marque une taxe comme payée ou non. */
export async function setTaxePaye(id: number, paye: boolean): Promise<void> {
  await prisma.taxe.update({ where: { id }, data: { paye } });
}

/** Soft-delete une taxe (`actif: false`). */
export async function deleteTaxe(id: number): Promise<void> {
  await prisma.taxe.update({ where: { id }, data: { actif: false } });
}

/** Marque l'alerte d'expiration d'une taxe comme envoyée (évite une double alerte). */
export async function markTaxeAlerteSent(id: number): Promise<void> {
  await prisma.taxe.update({ where: { id }, data: { alerteSent: true } });
}

// ─── USER MAPPING (nom jeu ↔ Discord) ────────────────────────────────────────

/** Associe (upsert) un nom en jeu à un compte Discord. */
export async function setUserMapping(gameName: string, discordId: string): Promise<void> {
  await prisma.userMapping.upsert({
    where: { gameName_discordId: { gameName: gameName.toLowerCase(), discordId } },
    create: { gameName: gameName.toLowerCase(), discordId },
    update: {},
  });
}

/** Comptes Discord associés à un nom en jeu (généralement un seul). */
export async function getUserMappings(gameName: string): Promise<string[]> {
  const rows = await prisma.userMapping.findMany({ where: { gameName: gameName.toLowerCase() } });
  return rows.map(r => r.discordId);
}

/** Toutes les associations nom en jeu ↔ Discord, triées par nom en jeu. */
export async function getAllUserMappings() {
  return prisma.userMapping.findMany({ orderBy: { gameName: 'asc' } });
}

/** Supprime une association nom en jeu ↔ Discord ; sans `discordId`, supprime tous les comptes associés à ce nom. */
export async function deleteUserMapping(gameName: string, discordId: string | null = null): Promise<void> {
  if (discordId) {
    await prisma.userMapping.deleteMany({ where: { gameName: gameName.toLowerCase(), discordId } });
  } else {
    await prisma.userMapping.deleteMany({ where: { gameName: gameName.toLowerCase() } });
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
export async function createPendingSale(data: PendingSaleInput): Promise<number> {
  const row = await prisma.pendingSale.create({
    data: {
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
export async function getPendingSale(id: number) {
  const row = await prisma.pendingSale.findUnique({ where: { id } });
  return row ? mapPendingSale(row) : undefined;
}

/** Associe le message Discord de l'alerte à une vente en attente. */
export async function updatePendingSaleMessage(id: number, messageId: string, channelId: string): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { messageId, channelId } });
}

/** Change le statut d'une vente en attente ('en_attente', 'declare', 'repose', 'confirme', 'ignore', 'expire'...). */
export async function updatePendingSaleStatut(id: number, statut: string): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { statut } });
}

/** Corrige la quantité d'une vente en attente. */
export async function updatePendingSaleQuantite(id: number, quantite: number): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { quantite } });
}

/** Associe (rétroactivement) un compte Discord à une vente en attente. */
export async function updatePendingSaleDiscordId(id: number, discordId: string): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { discordId } });
}

/** Marque une vente en attente comme confirmée. */
export async function confirmPendingSale(id: number): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { confirmed: true, statut: 'confirme' } });
}

/** Vente en attente accumulable (même joueur/item, pas encore confirmée) depuis `since`, la plus récente. */
export async function getPendingSaleForAccumulation(joueur: string, item: string, since: number) {
  const row = await prisma.pendingSale.findFirst({
    where: { joueur, item, statut: 'en_attente', confirmed: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'desc' },
  });
  return row ? mapPendingSale(row) : undefined;
}

/** Cumule une nouvelle quantité sur une vente en attente existante et rafraîchit son timestamp. */
export async function accumulatePendingSale(id: number, quantite: number, timestamp: number): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { quantite, timestamp: new Date(timestamp) } });
}

/** Ventes déclarées d'un joueur en attente de confirmation (dépôt d'argent) depuis `since`. */
export async function getPendingSalesForConfirmation(joueur: string, since: number) {
  const rows = await prisma.pendingSale.findMany({
    where: { joueur, statut: 'declare', confirmed: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'asc' },
  });
  return rows.map(mapPendingSale);
}

/** Vente reposée d'un joueur/item en attente de vérification depuis `since`, la plus récente. */
export async function getPendingSaleRepose(joueur: string, item: string, since: number) {
  const row = await prisma.pendingSale.findFirst({
    where: { joueur, item, statut: 'repose', confirmed: false, timestamp: { gte: new Date(since) } },
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
export async function getExpiredPendingSales(before: number) {
  const rows = await prisma.pendingSale.findMany({
    where: { statut: { in: ['en_attente', 'declare', 'repose'] }, timestamp: { lt: new Date(before) }, messageId: { not: null } },
  });
  return rows.map(mapPendingSale);
}

// ─── VÉHICULES / FOURRIÈRE ────────────────────────────────────────────────────

/** État courant (responsable) d'un véhicule par plaque, ou `undefined` si jamais vu. */
export async function getVehiculeEtat(plaque: string) {
  const row = await prisma.vehicule.findUnique({ where: { plaque } });
  return row ? { ...row, timestamp: toMs(row.timestamp) } : undefined;
}

/** Fixe (upsert) le responsable courant d'un véhicule. */
export async function setVehiculeEtat(data: { plaque: string; modele?: string | null; discord_id?: string | null; joueur: string; timestamp?: number }): Promise<void> {
  const shared = {
    modele: data.modele ?? null,
    discordId: data.discord_id ?? null,
    joueur: data.joueur,
    timestamp: new Date(data.timestamp ?? Date.now()),
  };
  await prisma.vehicule.upsert({
    where: { plaque: data.plaque },
    create: { plaque: data.plaque, ...shared },
    update: shared,
  });
}

/** Efface le responsable courant d'un véhicule (rangé proprement dans un garage). */
export async function clearVehiculeEtat(plaque: string): Promise<void> {
  await prisma.vehicule.update({ where: { plaque }, data: { discordId: null, joueur: null } });
}

/** Enregistre une mise en fourrière et retourne son ID. */
export async function addFourriere(data: { discord_id?: string | null; joueur: string; plaque: string; modele?: string | null; timestamp?: number }): Promise<number> {
  const row = await prisma.fourriere.create({
    data: {
      discordId: data.discord_id ?? null,
      joueur: data.joueur,
      plaque: data.plaque,
      modele: data.modele ?? null,
      timestamp: new Date(data.timestamp ?? Date.now()),
    },
  });
  return row.id;
}

/** Classement cumulé des mises en fourrière par joueur, décroissant. */
export async function getFourriereClassement(): Promise<Array<{ discord_id: string | null; joueur: string; total: number }>> {
  const rows = await prisma.fourriere.findMany({ select: { discordId: true, joueur: true } });
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

/** Supprime tout l'historique de mises en fourrière (reset hebdomadaire du classement). */
export async function clearFourrieres(): Promise<void> {
  await prisma.fourriere.deleteMany();
}

// ─── ARMURERIE ────────────────────────────────────────────────────────────────

/** Ajoute une arme à l'armurerie (statut par défaut 'en_stock') et retourne son ID. */
export async function addArme(nom: string, reference: string, type: string): Promise<number> {
  const row = await prisma.arme.create({ data: { nom, reference, type } });
  return row.id;
}

/** Change le type (clé de `ARME_TYPES`) d'une arme existante. */
export async function updateArmeType(id: number, type: string): Promise<void> {
  await prisma.arme.update({ where: { id }, data: { type } });
}

/** Toutes les armes, triées par nom. */
export async function getAllArmes() {
  return prisma.arme.findMany({ orderBy: { nom: 'asc' } });
}

/** Une arme par ID, ou `undefined`. */
export async function getArme(id: number) {
  return prisma.arme.findUnique({ where: { id } }) ?? undefined;
}

/** Change le statut ('en_stock' | 'pretee' | 'perdue') d'une arme, et à qui elle est prêtée le cas échéant. */
export async function updateArmeStatut(id: number, statut: string, preteeA: string | null = null): Promise<void> {
  await prisma.arme.update({ where: { id }, data: { statut, preteeA } });
}

/** Supprime définitivement une arme. */
export async function deleteArme(id: number): Promise<void> {
  await prisma.arme.delete({ where: { id } });
}

/** Toutes les armes au statut 'perdue', triées par nom. */
export async function getArmesPerdue() {
  return prisma.arme.findMany({ where: { statut: 'perdue' }, orderBy: { nom: 'asc' } });
}
