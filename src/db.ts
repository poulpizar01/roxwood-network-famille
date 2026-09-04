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
 * le reste du bot manipule des `number`, exactement comme avec l'ancien
 * SQLite — ça évite de répandre `new Date()`/`.getTime()` dans chaque module.
 */
import { PrismaClient, type Prisma } from '@prisma/client';

export const prisma = new PrismaClient();

const toMs = (d: Date | null | undefined): number => (d ? d.getTime() : 0);

// ─── SETTINGS (scalaires nommés — voir docstring du modèle Setting) ─────────

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row ? row.value : null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: String(value) },
    update: { value: String(value) },
  });
}

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

export async function removeChannelFromRole(role: string, channelId: string): Promise<void> {
  await prisma.channel.deleteMany({ where: { role, channelId } });
}

// ─── RÔLES DISCORD (config) ──────────────────────────────────────────────────

export async function setDiscordRole(target: string, roleId: string): Promise<void> {
  await prisma.discordRole.upsert({ where: { target }, create: { target, roleId }, update: { roleId } });
}

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
}

export async function upsertItem(data: ItemInput): Promise<void> {
  await prisma.item.upsert({
    where: { name: data.name },
    create: {
      name: data.name,
      stockGroup: data.stock_group ?? null,
      vente: !!data.vente,
      ventePaiement: !!data.vente_paiement,
      displayOrder: data.display_order ?? 0,
    },
    update: {
      stockGroup: data.stock_group ?? null,
      vente: !!data.vente,
      ventePaiement: !!data.vente_paiement,
      displayOrder: data.display_order ?? 0,
    },
  });
}

export async function deleteItem(name: string): Promise<void> {
  await prisma.item.deleteMany({ where: { name } });
}

export async function getAllItems() {
  return prisma.item.findMany({ orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] });
}

// ─── ACTIVITY TYPES (config) ─────────────────────────────────────────────────

export interface ActivityTypeInput {
  key: string;
  label: string;
  quota_type?: string | null;
  cooldown_ms?: number | null;
  partners?: boolean;
  braquage_weekly_limit?: number | null;
  labo?: boolean;
  labo_channel_id?: string | null;
  quantity?: boolean;
  panel_button?: boolean;
  display_order?: number;
}

export async function upsertActivityType(data: ActivityTypeInput): Promise<void> {
  const shared = {
    label: data.label,
    quotaType: data.quota_type ?? null,
    cooldownMs: data.cooldown_ms ?? null,
    partners: !!data.partners,
    braquageWeeklyLimit: data.braquage_weekly_limit ?? null,
    labo: !!data.labo,
    laboChannelId: data.labo_channel_id ?? null,
    quantity: !!data.quantity,
    panelButton: data.panel_button !== false,
    displayOrder: data.display_order ?? 0,
  };
  await prisma.activityType.upsert({
    where: { key: data.key },
    create: { key: data.key, ...shared },
    update: shared,
  });
}

export async function deleteActivityType(key: string): Promise<void> {
  await prisma.activityType.deleteMany({ where: { key } });
}

export async function getAllActivityTypes() {
  return prisma.activityType.findMany({ orderBy: [{ displayOrder: 'asc' }, { key: 'asc' }] });
}

// ─── QUOTA TARGETS (config) ──────────────────────────────────────────────────

export async function setQuotaTarget(quotaType: string, weeklyTarget: number): Promise<void> {
  await prisma.quotaTarget.upsert({
    where: { quotaType },
    create: { quotaType, weeklyTarget },
    update: { weeklyTarget },
  });
}

export async function deleteQuotaTarget(quotaType: string): Promise<void> {
  await prisma.quotaTarget.deleteMany({ where: { quotaType } });
}

export async function getAllQuotaTargets() {
  return prisma.quotaTarget.findMany();
}

// ─── SALARY RATES (config) ───────────────────────────────────────────────────

export async function setSalaryRate(quotaType: string, amount: number): Promise<void> {
  await prisma.salaryRate.upsert({
    where: { quotaType },
    create: { quotaType, amount },
    update: { amount },
  });
}

export async function deleteSalaryRate(quotaType: string): Promise<void> {
  await prisma.salaryRate.deleteMany({ where: { quotaType } });
}

export async function getAllSalaryRates() {
  return prisma.salaryRate.findMany();
}

// ─── STOCKS ─────────────────────────────────────────────────────────────────

export async function getStock(item: string): Promise<number> {
  const row = await prisma.stock.findUnique({ where: { item: item.toLowerCase() } });
  return row ? row.quantite : 0;
}

export async function updateStock(item: string, delta: number): Promise<number> {
  const current = await getStock(item);
  const newQty = Math.max(0, current + delta);
  await setStock(item, newQty);
  return newQty;
}

export async function setStock(item: string, qty: number): Promise<void> {
  const key = item.toLowerCase();
  const quantite = Math.max(0, qty);
  await prisma.stock.upsert({ where: { item: key }, create: { item: key, quantite }, update: { quantite } });
}

export async function getAllStocks() {
  return prisma.stock.findMany({ orderBy: { item: 'asc' } });
}

export async function resetAllStocks(): Promise<void> {
  await prisma.stock.deleteMany();
}

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

function mapTransaction(t: Prisma.TransactionGetPayload<{}>) {
  let partenaires: string[] = [];
  try { partenaires = JSON.parse(t.partenaires); } catch { /* ignore */ }
  return { ...t, timestamp: toMs(t.timestamp), partenaires };
}

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

export async function getTransaction(id: number) {
  const row = await prisma.transaction.findFirst({ where: { id, deleted: false } });
  return row ? mapTransaction(row) : undefined;
}

export async function deleteTransaction(id: number, deletedBy: string): Promise<void> {
  await prisma.transaction.updateMany({ where: { id }, data: { deleted: true, deletedBy } });
}

export async function getAllTransactions(since = 0) {
  const rows = await prisma.transaction.findMany({
    where: { deleted: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'desc' },
  });
  return rows.map(mapTransaction);
}

// ─── STATS ───────────────────────────────────────────────────────────────────

export async function getUserStats(userId: string) {
  return prisma.stat.findMany({ where: { userId } });
}

export async function getUserStatMap(userId: string): Promise<Record<string, { count: number; points: number }>> {
  const rows = await getUserStats(userId);
  const map: Record<string, { count: number; points: number }> = {};
  for (const r of rows) map[r.action] = { count: r.count, points: r.points };
  return map;
}

export async function getAllUserTotals(): Promise<Array<{ user_id: string; total_points: number }>> {
  const rows = await prisma.stat.groupBy({ by: ['userId'], _sum: { points: true } });
  return rows
    .map(r => ({ user_id: r.userId, total_points: r._sum.points ?? 0 }))
    .sort((a, b) => b.total_points - a.total_points);
}

/**
 * Retourne le nombre d'événements par type d'action depuis `sinceTs`, tous
 * participants confondus (une transaction = un événement, voir docstring
 * historique dans database.js de la version précédente). Les clés listées
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

export async function getMunitionsFabriqueesDepuis(sinceTs: number): Promise<number> {
  const agg = await prisma.transaction.aggregate({
    where: { action: 'fabrication_munitions', deleted: false, timestamp: { gte: new Date(sinceTs) } },
    _sum: { quantite: true },
  });
  return agg._sum.quantite ?? 0;
}

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

export async function getMunitionsVenduesDepuis(sinceTs: number): Promise<number> {
  const agg = await prisma.munitionVente.aggregate({
    where: { timestamp: { gte: new Date(sinceTs) } },
    _sum: { quantite: true },
  });
  return agg._sum.quantite ?? 0;
}

export async function getFabricationMunitionsHistorique(limite = 15) {
  const rows = await prisma.transaction.findMany({
    where: { action: 'fabrication_munitions', deleted: false },
    orderBy: { timestamp: 'desc' },
    take: limite,
    select: { timestamp: true, quantite: true, username: true },
  });
  return rows.map(r => ({ ...r, timestamp: toMs(r.timestamp) }));
}

export async function getMunitionsVentesHistorique(limite = 15) {
  const rows = await prisma.munitionVente.findMany({
    orderBy: { timestamp: 'desc' },
    take: limite,
    select: { timestamp: true, quantite: true, acheteurId: true, prix: true },
  });
  return rows.map(r => ({ timestamp: toMs(r.timestamp), quantite: r.quantite, acheteur_id: r.acheteurId, prix: r.prix }));
}

export async function getAllTrackedUserIds(): Promise<string[]> {
  const rows = await prisma.stat.findMany({ distinct: ['userId'], select: { userId: true } });
  return rows.map(r => r.userId);
}

export async function incrementStat(userId: string, action: string, countDelta = 1, pointsDelta = 0): Promise<void> {
  await prisma.stat.upsert({
    where: { userId_action: { userId, action } },
    create: { userId, action, count: countDelta, points: pointsDelta },
    update: { count: { increment: countDelta }, points: { increment: pointsDelta } },
  });
}

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

export async function resetAllStats(): Promise<void> {
  await prisma.stat.deleteMany();
}

// ─── COOLDOWNS ───────────────────────────────────────────────────────────────

export async function getCooldown(userId: string, action: string): Promise<number> {
  const row = await prisma.cooldown.findUnique({ where: { userId_action: { userId, action } } });
  return row ? toMs(row.expiresAt) : 0;
}

export async function setCooldown(userId: string, action: string, expiresAt: number): Promise<void> {
  await prisma.cooldown.upsert({
    where: { userId_action: { userId, action } },
    create: { userId, action, expiresAt: new Date(expiresAt), notified: false },
    update: { expiresAt: new Date(expiresAt), notified: false },
  });
}

export async function getActiveCooldowns() {
  const rows = await prisma.cooldown.findMany({ where: { expiresAt: { gt: new Date() } } });
  return rows.map(r => ({ ...r, expires_at: toMs(r.expiresAt) }));
}

export async function getExpiredUnnotifiedCooldowns() {
  const rows = await prisma.cooldown.findMany({ where: { expiresAt: { lte: new Date() }, notified: false } });
  return rows.map(r => ({ ...r, expires_at: toMs(r.expiresAt) }));
}

export async function markCooldownNotified(userId: string, action: string): Promise<void> {
  await prisma.cooldown.updateMany({ where: { userId, action }, data: { notified: true } });
}

export async function removeCooldown(userId: string, action: string): Promise<void> {
  await prisma.cooldown.deleteMany({ where: { userId, action } });
}

// ─── BRAQUAGES (fenêtre glissante 7 jours) ───────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function addBraquage(userId: string, action: string): Promise<void> {
  await prisma.braquage.create({ data: { userId, action, timestamp: new Date() } });
}

export async function getBraquageCount(action: string): Promise<number> {
  return prisma.braquage.count({ where: { action, timestamp: { gte: new Date(Date.now() - SEVEN_DAYS_MS) } } });
}

export async function cleanOldBraquages(): Promise<void> {
  await prisma.braquage.deleteMany({ where: { timestamp: { lt: new Date(Date.now() - SEVEN_DAYS_MS) } } });
}

export async function getOldestBraquage(action: string): Promise<number | null> {
  const row = await prisma.braquage.findFirst({
    where: { action, timestamp: { gte: new Date(Date.now() - SEVEN_DAYS_MS) } },
    orderBy: { timestamp: 'asc' },
  });
  return row ? toMs(row.timestamp) : null;
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

function mapTaxe<T extends { echeance: Date }>(t: T) {
  return { ...t, echeance: toMs(t.echeance) };
}

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

export async function searchTaxNames(query: string): Promise<Array<{ id: number; nom: string }>> {
  return prisma.taxe.findMany({
    where: { actif: true, nom: { contains: query, mode: 'insensitive' } },
    select: { id: true, nom: true },
    take: 25,
  });
}

export async function renewTaxe(id: number, days: number): Promise<number | null> {
  const taxe = await getTaxe(id);
  if (!taxe) return null;
  const base = Math.max(Date.now(), taxe.echeance);
  const newDate = base + days * 24 * 60 * 60 * 1000;
  await prisma.taxe.update({ where: { id }, data: { echeance: new Date(newDate), alerteSent: false, paye: false } });
  return newDate;
}

export async function setTaxePaye(id: number, paye: boolean): Promise<void> {
  await prisma.taxe.update({ where: { id }, data: { paye } });
}

export async function deleteTaxe(id: number): Promise<void> {
  await prisma.taxe.update({ where: { id }, data: { actif: false } });
}

export async function markTaxeAlerteSent(id: number): Promise<void> {
  await prisma.taxe.update({ where: { id }, data: { alerteSent: true } });
}

// ─── USER MAPPING (nom jeu ↔ Discord) ────────────────────────────────────────

export async function setUserMapping(gameName: string, discordId: string): Promise<void> {
  await prisma.userMapping.upsert({
    where: { gameName_discordId: { gameName: gameName.toLowerCase(), discordId } },
    create: { gameName: gameName.toLowerCase(), discordId },
    update: {},
  });
}

export async function getUserMappings(gameName: string): Promise<string[]> {
  const rows = await prisma.userMapping.findMany({ where: { gameName: gameName.toLowerCase() } });
  return rows.map(r => r.discordId);
}

export async function getAllUserMappings() {
  return prisma.userMapping.findMany({ orderBy: { gameName: 'asc' } });
}

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

function mapPendingSale<T extends { timestamp: Date }>(r: T) {
  return { ...r, timestamp: toMs(r.timestamp) };
}

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

export async function getPendingSale(id: number) {
  const row = await prisma.pendingSale.findUnique({ where: { id } });
  return row ? mapPendingSale(row) : undefined;
}

export async function updatePendingSaleMessage(id: number, messageId: string, channelId: string): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { messageId, channelId } });
}

export async function updatePendingSaleStatut(id: number, statut: string): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { statut } });
}

export async function updatePendingSaleQuantite(id: number, quantite: number): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { quantite } });
}

export async function updatePendingSaleDiscordId(id: number, discordId: string): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { discordId } });
}

export async function confirmPendingSale(id: number): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { confirmed: true, statut: 'confirme' } });
}

export async function getPendingSaleForAccumulation(joueur: string, item: string, since: number) {
  const row = await prisma.pendingSale.findFirst({
    where: { joueur, item, statut: 'en_attente', confirmed: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'desc' },
  });
  return row ? mapPendingSale(row) : undefined;
}

export async function accumulatePendingSale(id: number, quantite: number, timestamp: number): Promise<void> {
  await prisma.pendingSale.update({ where: { id }, data: { quantite, timestamp: new Date(timestamp) } });
}

export async function getPendingSalesForConfirmation(joueur: string, since: number) {
  const rows = await prisma.pendingSale.findMany({
    where: { joueur, statut: 'declare', confirmed: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'asc' },
  });
  return rows.map(mapPendingSale);
}

export async function getPendingSaleRepose(joueur: string, item: string, since: number) {
  const row = await prisma.pendingSale.findFirst({
    where: { joueur, item, statut: 'repose', confirmed: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'desc' },
  });
  return row ? mapPendingSale(row) : undefined;
}

export async function getExpiredPendingSales(before: number) {
  const rows = await prisma.pendingSale.findMany({
    where: { statut: 'en_attente', timestamp: { lt: new Date(before) }, messageId: { not: null } },
  });
  return rows.map(mapPendingSale);
}

// ─── VÉHICULES / FOURRIÈRE ────────────────────────────────────────────────────

export async function getVehiculeEtat(plaque: string) {
  const row = await prisma.vehicule.findUnique({ where: { plaque } });
  return row ? { ...row, timestamp: toMs(row.timestamp) } : undefined;
}

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

export async function clearVehiculeEtat(plaque: string): Promise<void> {
  await prisma.vehicule.update({ where: { plaque }, data: { discordId: null, joueur: null } });
}

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

export async function getFourriereClassement(): Promise<Array<{ discord_id: string | null; joueur: string; total: number }>> {
  const rows = await prisma.fourriere.findMany({ select: { discordId: true, joueur: true } });
  const totals = new Map<string, { discord_id: string | null; joueur: string; total: number }>();
  for (const r of rows) {
    const key = r.discordId ?? `unmapped_${r.joueur}`;
    const existing = totals.get(key);
    if (existing) existing.total += 1;
    else totals.set(key, { discord_id: r.discordId, joueur: r.joueur, total: 1 });
  }
  return [...totals.values()].sort((a, b) => b.total - a.total);
}

export async function clearFourrieres(): Promise<void> {
  await prisma.fourriere.deleteMany();
}

// ─── ARMURERIE ────────────────────────────────────────────────────────────────

export async function addArme(nom: string, reference: string, type: string): Promise<number> {
  const row = await prisma.arme.create({ data: { nom, reference, type } });
  return row.id;
}

export async function updateArmeType(id: number, type: string): Promise<void> {
  await prisma.arme.update({ where: { id }, data: { type } });
}

export async function getAllArmes() {
  return prisma.arme.findMany({ orderBy: { nom: 'asc' } });
}

export async function getArme(id: number) {
  return prisma.arme.findUnique({ where: { id } }) ?? undefined;
}

export async function updateArmeStatut(id: number, statut: string, preteeA: string | null = null): Promise<void> {
  await prisma.arme.update({ where: { id }, data: { statut, preteeA } });
}

export async function deleteArme(id: number): Promise<void> {
  await prisma.arme.delete({ where: { id } });
}

export async function getArmesPerdue() {
  return prisma.arme.findMany({ where: { statut: 'perdue' }, orderBy: { nom: 'asc' } });
}
