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

/** Remplace le(s) salon(s) d'un rôle à valeur unique (stock_general, quotas, ...) par un seul. */
export async function setChannelRole(guildId: string, role: string, channelId: string): Promise<void> {
  await prisma.channel.deleteMany({ where: { guildId, role } });
  await prisma.channel.create({ data: { guildId, role, channelId } });
}

/**
 * Ajoute un salon à un rôle à valeurs multiples (ex. 'logs_coffres'), sans
 * toucher aux autres. `label` optionnel (ex. "Coffre principal") — ré-ajouter
 * un salon déjà présent avec un nouveau `label` met juste à jour son nom
 * (jamais de doublon, upsert sur la clé composite) ; omis, le label existant
 * n'est pas touché.
 */
export async function addChannelToRole(guildId: string, role: string, channelId: string, label?: string | null): Promise<void> {
  await prisma.channel.upsert({
    where: { guildId_role_channelId: { guildId, role, channelId } },
    create: { guildId, role, channelId, label: label ?? null },
    update: label !== undefined ? { label } : {},
  });
}

/** Retire un salon d'un rôle à valeurs multiples (ex. 'logs_coffres'). */
export async function removeChannelFromRole(guildId: string, role: string, channelId: string): Promise<void> {
  await prisma.channel.deleteMany({ where: { guildId, role, channelId } });
}

/** Salons d'un rôle à valeurs multiples, avec leur `label` éventuel (voir `/config channel list`). */
export async function getChannelsWithLabel(guildId: string, role: string): Promise<Array<{ channelId: string; label: string | null }>> {
  const rows = await prisma.channel.findMany({ where: { guildId, role } });
  return rows.map(r => ({ channelId: r.channelId, label: r.label }));
}

// ─── RÔLES DISCORD (config) ──────────────────────────────────────────────────

/** Associe (upsert) un rôle Discord à un usage du bot ('admin' ou 'membre', voir ROLE_TARGETS dans modules/config.ts). */
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
  /** Clé d'activité labo (ex. "labo_cocaine") si cet item est LA drogue que ce labo produit, ou un matériau qu'il consomme (voir `labo_lie_role`) — voir docstring du modèle Item. */
  labo_lie?: string | null;
  /** 'produit' (défaut si `labo_lie` fourni sans précision) ou 'materiau'. Ignoré si `labo_lie` est `null`. */
  labo_lie_role?: 'produit' | 'materiau' | null;
  /** Unités de base représentées par une unité de cet item (ex. 24 pour une boîte de munitions) — voir docstring du modèle Item et `armurerie.weightedStockSum`. Défaut 1 (pas de conversion). */
  stock_multiplier?: number;
}

/**
 * Ajoute ou remplace la configuration d'un item suivi (upsert, voir docstring
 * de `/config item add`) — remplacement complet à chaque appel pour tous les
 * champs SAUF `stockGroup` : `/config item add` ne l'expose pas (trop
 * générique pour son seul usage réel, la pondération munitions — voir
 * `default-items.ts`), donc `data.stock_group` vaut toujours `undefined`
 * quand l'appel vient de cette commande. `undefined` signifie ici "ne pas
 * toucher au champ existant", jamais "l'effacer" — sinon changer juste le
 * multiplicateur de "Munition de pistolet" effacerait silencieusement son
 * groupe. Ne pas généraliser ce pattern aux autres champs.
 */
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
      laboLieRole: data.labo_lie ? (data.labo_lie_role ?? 'produit') : null,
      stockMultiplier: data.stock_multiplier ?? 1,
    },
    update: {
      ...(data.stock_group !== undefined ? { stockGroup: data.stock_group } : {}),
      vente: !!data.vente,
      ...(data.display_order !== undefined ? { displayOrder: data.display_order } : {}),
      visibleStock: data.visible_stock !== false,
      laboLie: data.labo_lie ?? null,
      laboLieRole: data.labo_lie ? (data.labo_lie_role ?? 'produit') : null,
      stockMultiplier: data.stock_multiplier ?? 1,
    },
  });
}

/** Retire un item suivi (ne supprime pas son stock/historique). */
export async function deleteItem(guildId: string, name: string): Promise<void> {
  await prisma.item.deleteMany({ where: { guildId, name } });
}

/** Tous les items suivis d'une guilde, triés par ordre d'affichage puis par ordre d'insertion (jamais par nom — voir `Item.id` dans schema.prisma). */
export async function getAllItems(guildId: string) {
  return prisma.item.findMany({ where: { guildId }, orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] });
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

// ─── TAUX DE PAIE PAR ITEM (config) ──────────────────────────────────────────

/** Fixe (upsert) le taux de paie ($ par unité) d'UN item vendu, remplaçant le taux général "vente" pour cet item précis. */
export async function setItemSalaryRate(guildId: string, item: string, amount: number): Promise<void> {
  await prisma.itemSalaryRate.upsert({
    where: { guildId_item: { guildId, item } },
    create: { guildId, item, amount },
    update: { amount },
  });
}

/** Retire le taux de paie spécifique d'un item (il retombe sur le taux général "vente"). */
export async function deleteItemSalaryRate(guildId: string, item: string): Promise<void> {
  await prisma.itemSalaryRate.deleteMany({ where: { guildId, item } });
}

/** Tous les taux de paie par item configurés pour une guilde. */
export async function getAllItemSalaryRates(guildId: string) {
  return prisma.itemSalaryRate.findMany({ where: { guildId } });
}

// ─── PALIERS DE PAIE VENTE (config) ──────────────────────────────────────────

/** Ajoute une tranche au barème de paie de la vente (général si `item` est `null`, propre à cet item sinon) — validation de l'ordre/unicité de la tranche finale faite par l'appelant (`modules/config.ts`), pas ici. */
export async function addSalaryTier(guildId: string, item: string | null, upTo: number | null, amount: number): Promise<void> {
  await prisma.salaryTier.create({ data: { guildId, item, upTo, amount } });
}

/** Retire UNE tranche précise (par sa borne haute — `null` cible la tranche finale sans limite) du barème général ou d'un item. */
export async function removeSalaryTier(guildId: string, item: string | null, upTo: number | null): Promise<void> {
  await prisma.salaryTier.deleteMany({ where: { guildId, item, upTo } });
}

/** Retire tout le barème (général ou celui d'un item précis) — retombe sur le taux plat (`SalaryRate`/`ItemSalaryRate`) s'il existe. */
export async function clearSalaryTiers(guildId: string, item: string | null): Promise<void> {
  await prisma.salaryTier.deleteMany({ where: { guildId, item } });
}

/** Toutes les tranches de tous les barèmes (général + par item) d'une guilde, triées par item puis par borne haute croissante (Postgres place les `NULL` en dernier sur un `ORDER BY ... ASC` — la tranche finale sans limite se retrouve donc naturellement en dernier de son groupe). */
export async function getAllSalaryTiers(guildId: string) {
  return prisma.salaryTier.findMany({ where: { guildId }, orderBy: [{ item: 'asc' }, { upTo: 'asc' }] });
}

/** Les tranches du barème d'UNE seule cible (général si `item` est `null`), triées par borne haute croissante. */
export async function getSalaryTiersFor(guildId: string, item: string | null) {
  return prisma.salaryTier.findMany({ where: { guildId, item }, orderBy: { upTo: 'asc' } });
}

// ─── CLASSEMENT (config) ──────────────────────────────────────────────────────

/** Fixe (upsert) les points de classement d'une catégorie de quota. */
export async function setClassementRate(guildId: string, quotaType: string, amount: number): Promise<void> {
  await prisma.classementRate.upsert({
    where: { guildId_quotaType: { guildId, quotaType } },
    create: { guildId, quotaType, amount },
    update: { amount },
  });
}

/** Retire les points de classement d'une catégorie de quota. */
export async function deleteClassementRate(guildId: string, quotaType: string): Promise<void> {
  await prisma.classementRate.deleteMany({ where: { guildId, quotaType } });
}

/** Tous les points de classement par catégorie configurés pour une guilde. */
export async function getAllClassementRates(guildId: string) {
  return prisma.classementRate.findMany({ where: { guildId } });
}

/** Fixe (upsert) les points de classement d'UNE activité de la catégorie "actions", remplaçant le nombre général de cette catégorie pour cette activité précise. */
export async function setActivityClassementRate(guildId: string, activityKey: string, amount: number): Promise<void> {
  await prisma.activityClassementRate.upsert({
    where: { guildId_activityKey: { guildId, activityKey } },
    create: { guildId, activityKey, amount },
    update: { amount },
  });
}

/** Retire les points de classement spécifiques d'une activité (elle retombe sur le nombre général "actions"). */
export async function deleteActivityClassementRate(guildId: string, activityKey: string): Promise<void> {
  await prisma.activityClassementRate.deleteMany({ where: { guildId, activityKey } });
}

/** Tous les points de classement par activité configurés pour une guilde. */
export async function getAllActivityClassementRates(guildId: string) {
  return prisma.activityClassementRate.findMany({ where: { guildId } });
}

// ─── STOCKS ─────────────────────────────────────────────────────────────────
//
// Il n'existe qu'UNE table de stock, `CoffreStock` (détail par salon
// `logs_coffres`) : le total global n'est jamais stocké, toujours recalculé
// à la lecture comme la somme des coffres pour cet item. Un total tenu dans
// une table à part divergerait : chaque table plafonne sa propre valeur à 0
// (`GREATEST(quantite + delta, 0)`), donc un retrait absorbé côté coffre (déjà
// à 0 selon le suivi) ne le serait pas côté total (qui a du stock ailleurs).

/** Quantité en stock d'un item, tous coffres confondus (0 si jamais mouvementé). */
export async function getStock(guildId: string, item: string): Promise<number> {
  const result = await prisma.coffreStock.aggregate({
    where: { guildId, item: item.toLowerCase() },
    _sum: { quantite: true },
  });
  return result._sum.quantite ?? 0;
}

/** Stock de plusieurs items en une seule requête (clé = nom en minuscules, absent si jamais mouvementé) — voir `armurerie.getMunitionsStock`/`weightedStockSum`, qui pondèrent différemment chaque item d'un groupe avant de sommer (contre un `getStock` par item, un N+1 pour un groupe qui peut grossir). */
export async function getStocksByItems(guildId: string, items: string[]): Promise<Record<string, number>> {
  if (!items.length) return {};
  const rows = await prisma.coffreStock.groupBy({
    by: ['item'],
    where: { guildId, item: { in: items.map(i => i.toLowerCase()) } },
    _sum: { quantite: true },
  });
  return Object.fromEntries(rows.map(r => [r.item, r._sum.quantite ?? 0]));
}

/** Le stock de tous les items d'une guilde (sommé sur tous les coffres), trié par nom. */
export async function getAllStocks(guildId: string): Promise<Array<{ guildId: string; item: string; quantite: number }>> {
  const rows = await prisma.coffreStock.groupBy({
    by: ['item'],
    where: { guildId },
    _sum: { quantite: true },
    orderBy: { item: 'asc' },
  });
  return rows.map(r => ({ guildId, item: r.item, quantite: r._sum.quantite ?? 0 }));
}

/** Supprime tout le stock détaillé par coffre d'une guilde (resync complète, voir `stocks.fullResync`) — le total global suit automatiquement puisqu'il n'est jamais stocké. */
export async function resetAllStocks(guildId: string): Promise<void> {
  await prisma.coffreStock.deleteMany({ where: { guildId } });
}

// ─── STOCK PAR COFFRE ─────────────────────────────────────────────────────────
//
// Détail par salon `logs_coffres` (voir modèle CoffreStock) — SEULE source de
// vérité pour le stock (voir commentaire ci-dessus).

/**
 * Applique un delta au stock d'UN coffre précis, de façon atomique (upsert +
 * valeur précédente lue dans la même instruction — deux mouvements
 * concurrents sur le même item/coffre ne peuvent pas s'écraser comme le
 * ferait un lire-puis-écrire en deux requêtes séparées), et retourne le total
 * GLOBAL avant/après (somme de tous les coffres pour cet item), pas juste ce
 * coffre — c'est ce qu'affichent l'historique et `historique_stock`. Un CTE
 * ne voit pas les lignes que la même requête modifie : la somme des AUTRES
 * coffres (`autres`, qui exclut CE coffre) est donc calculée séparément puis
 * additionnée à la valeur avant/après de ce coffre, plutôt que de resommer
 * `coffre_stocks` après coup (qui renverrait l'ancienne valeur pour ce
 * coffre). Exécutée dans la transaction de {@link applyStockMessage}.
 */
async function stockMovementQuery(client: Pick<Prisma.TransactionClient, '$queryRaw'>, guildId: string, channelId: string, item: string, delta: number): Promise<{ avant: number; apres: number }> {
  const key = item.toLowerCase();
  const rows = await client.$queryRaw<Array<{ avant: number; apres: number }>>`
    WITH prev AS (
      SELECT quantite FROM coffre_stocks WHERE guild_id = ${guildId} AND channel_id = ${channelId} AND item = ${key}
    ), autres AS (
      SELECT COALESCE(SUM(quantite), 0)::int AS total FROM coffre_stocks
      WHERE guild_id = ${guildId} AND item = ${key} AND channel_id != ${channelId}
    ), upserted AS (
      INSERT INTO coffre_stocks (guild_id, channel_id, item, quantite) VALUES (${guildId}, ${channelId}, ${key}, GREATEST(${delta}, 0))
      ON CONFLICT (guild_id, channel_id, item) DO UPDATE SET quantite = GREATEST(coffre_stocks.quantite + ${delta}, 0)
      RETURNING quantite
    )
    SELECT
      (SELECT total FROM autres) + COALESCE((SELECT quantite FROM prev), 0) AS avant,
      (SELECT total FROM autres) + (SELECT quantite FROM upserted) AS apres
  `;
  return { avant: rows[0]?.avant ?? 0, apres: rows[0]?.apres ?? 0 };
}

/**
 * Force la valeur du stock d'un item POUR UN COFFRE DONNÉ (correction
 * manuelle, `/set-stock ... coffre:`) — SET absolu, pas un delta (contraste
 * avec {@link applyStockMessage}, additive). Même pattern atomique (upsert +
 * valeur précédente en une seule requête) pour ne pas écraser un mouvement
 * réel concurrent sur ce même coffre/item. Le total global suit tout seul à
 * la lecture, aucun appel complémentaire nécessaire.
 */
export async function setCoffreStock(guildId: string, channelId: string, item: string, quantite: number): Promise<{ avant: number; apres: number }> {
  const key = item.toLowerCase();
  const qty = Math.max(0, quantite);
  const rows = await prisma.$queryRaw<Array<{ avant: number; apres: number }>>`
    WITH prev AS (
      SELECT quantite FROM coffre_stocks WHERE guild_id = ${guildId} AND channel_id = ${channelId} AND item = ${key}
    ), upserted AS (
      INSERT INTO coffre_stocks (guild_id, channel_id, item, quantite) VALUES (${guildId}, ${channelId}, ${key}, ${qty})
      ON CONFLICT (guild_id, channel_id, item) DO UPDATE SET quantite = ${qty}
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

export interface StockMovementInput {
  joueur: string;
  action: 'retire' | 'depose';
  item: string;
  quantite: number;
}

/**
 * Applique en UNE transaction tous les mouvements d'un message de log de
 * coffre, leur historique, et l'avancée du curseur `last_stock_msg_<salon>` —
 * un arrêt du process au milieu ne laisse donc ni message marqué traité sans
 * mouvement, ni message à moitié appliqué qui serait rejoué en double. Le
 * curseur ne peut qu'avancer : un message dont l'ID ne lui est pas postérieur
 * a déjà été appliqué (temps réel et rattrapage peuvent livrer le même), et
 * la fonction retourne alors `null` sans rien écrire.
 */
export async function applyStockMessage(
  guildId: string, channelId: string, messageId: string, movements: StockMovementInput[], timestamp: number,
): Promise<Array<StockMovementInput & { stock_avant: number; stock_apres: number }> | null> {
  const key = `last_stock_msg_${channelId}`;
  const applied = await prisma.$transaction(async tx => {
    const cursor = await tx.setting.findUnique({ where: { guildId_key: { guildId, key } } });
    if (cursor && BigInt(messageId) <= BigInt(cursor.value)) return null;

    const done: Array<StockMovementInput & { stock_avant: number; stock_apres: number }> = [];
    for (const m of movements) {
      const { avant, apres } = await stockMovementQuery(tx, guildId, channelId, m.item, m.action === 'retire' ? -m.quantite : m.quantite);
      await tx.stockHistory.create({
        data: {
          guildId, timestamp: new Date(timestamp), joueur: m.joueur, action: m.action, item: m.item,
          quantite: m.quantite, stockAvant: avant, stockApres: apres, channelId,
        },
      });
      done.push({ ...m, stock_avant: avant, stock_apres: apres });
    }
    await tx.setting.upsert({
      where: { guildId_key: { guildId, key } },
      create: { guildId, key, value: messageId },
      update: { value: messageId },
    });
    return done;
  });
  // Le plafond de l'historique est indicatif (rien ne dépend d'un total
  // exact) : un tirage 1/20 le maintient proche de 500 sans requête de
  // nettoyage à chaque mouvement de coffre, le chemin le plus fréquent du bot.
  if (applied?.length && Math.random() < 0.05) await pruneStockHistory(guildId);
  return applied;
}

/** Plafonne l'historique de stock d'une guilde à ~500 entrées (les plus anciennes sont purgées). */
async function pruneStockHistory(guildId: string): Promise<void> {
  const excess = await prisma.stockHistory.findMany({
    where: { guildId },
    orderBy: { id: 'desc' },
    skip: 500,
    select: { id: true },
    take: 1000,
  });
  if (excess.length) {
    await prisma.stockHistory.deleteMany({ where: { guildId, id: { in: excess.map(r => r.id) } } });
  }
}

/**
 * Derniers mouvements de stock d'une guilde, du plus récent au plus ancien,
 * filtrés par item et/ou coffre (salon `logs_coffres`) si fournis.
 * `channelId` ne filtre que les lignes enregistrées depuis l'ajout de ce
 * suivi (voir `channelId` dans le modèle StockHistory — `null` sur les
 * lignes plus anciennes, jamais retournées par ce filtre).
 */
export async function getRecentStockHistory(guildId: string, item: string | null = null, limit = 20, channelId: string | null = null, excludeChannelIds: string[] = []) {
  const rows = await prisma.stockHistory.findMany({
    where: {
      guildId,
      ...(item ? { item: item.toLowerCase() } : {}),
      ...(channelId ? { channelId } : {}),
      // `OR` avec `null` : les lignes antérieures au suivi par coffre (channelId
      // jamais backfillé) ne sont pas des mouvements de coffre admin, on les garde.
      ...(excludeChannelIds.length ? { OR: [{ channelId: null }, { channelId: { notIn: excludeChannelIds } }] } : {}),
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

/** Verrou transactionnel par clé (libéré au commit) : sérialise deux transactions qui lisent puis écrivent la même ressource logique. */
async function lockKey(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

export interface ActivityInput {
  userId: string;
  username: string;
  action: string;
  quantite?: number;
  type?: string | null;
  partenaires?: string[];
  tempsRestant?: string | null;
  /** Quantité créditée à chaque participant (déclarant + partenaires) dans `Stat`. */
  statDelta: number;
  /** Limite de braquage à faire respecter (fenêtre glissante de 7 jours) — omis pour une activité sans limite. */
  braquageLimit?: number | null;
  /** Cooldown à vérifier puis poser pour le déclarant — omis pour une activité sans cooldown. */
  cooldownMs?: number | null;
}

export type ActivityResult =
  | { ok: true; txId: number }
  | { ok: false; reason: 'limite'; used: number }
  | { ok: false; reason: 'cooldown'; remainingMs: number };

/**
 * Enregistre une déclaration d'activité en UNE transaction : limite de
 * braquage et cooldown revérifiés sous verrou au moment de l'écriture (la
 * vérification faite à l'ouverture du modal/menu ne vaut plus rien 60 s plus
 * tard), puis `Transaction`, `Stat` de chaque participant, slot de braquage
 * et cooldown. Le braquage porte exactement l'horodatage de sa transaction :
 * c'est ce qui permet à `/supp` de libérer LE slot de la transaction annulée
 * (voir {@link suppTransaction}).
 */
export async function recordActivity(guildId: string, data: ActivityInput): Promise<ActivityResult> {
  return prisma.$transaction(async (tx): Promise<ActivityResult> => {
    const now = new Date();
    if (data.braquageLimit != null) {
      await lockKey(tx, `braquage:${guildId}:${data.action}`);
      const used = await tx.braquage.count({ where: { guildId, action: data.action, timestamp: { gte: new Date(now.getTime() - SEVEN_DAYS_MS) } } });
      if (used >= data.braquageLimit) return { ok: false, reason: 'limite', used };
    }
    if (data.cooldownMs) {
      await lockKey(tx, `cooldown:${guildId}:${data.userId}:${data.action}`);
      const cd = await tx.cooldown.findUnique({ where: { guildId_userId_action: { guildId, userId: data.userId, action: data.action } } });
      if (cd && cd.expiresAt.getTime() > now.getTime()) return { ok: false, reason: 'cooldown', remainingMs: cd.expiresAt.getTime() - now.getTime() };
    }

    const partenaires = data.partenaires ?? [];
    const row = await tx.transaction.create({
      data: {
        guildId, userId: data.userId, username: data.username, action: data.action,
        quantite: data.quantite ?? 0, type: data.type ?? null,
        partenaires: JSON.stringify(partenaires), tempsRestant: data.tempsRestant ?? null, timestamp: now,
      },
    });
    for (const uid of [data.userId, ...partenaires]) {
      await tx.stat.upsert({
        where: { guildId_userId_action: { guildId, userId: uid, action: data.action } },
        create: { guildId, userId: uid, action: data.action, count: data.statDelta, points: 0 },
        update: { count: { increment: data.statDelta } },
      });
    }
    if (data.braquageLimit != null) {
      await tx.braquage.create({ data: { guildId, userId: data.userId, action: data.action, timestamp: now } });
    }
    if (data.cooldownMs) {
      const expiresAt = new Date(now.getTime() + data.cooldownMs);
      await tx.cooldown.upsert({
        where: { guildId_userId_action: { guildId, userId: data.userId, action: data.action } },
        create: { guildId, userId: data.userId, action: data.action, expiresAt, notified: false },
        update: { expiresAt, notified: false },
      });
    }
    return { ok: true, txId: row.id };
  });
}

/**
 * Annule une transaction (`/supp`) en UNE transaction DB : le marquage
 * `deleted` est conditionnel (deux `/supp` simultanés sur le même ID ne
 * décrémentent qu'une fois), `Stat` n'est décrémenté que si la transaction
 * appartient à la période en cours (`sinceTs` = dernier reset hebdomadaire —
 * `Stat` ne contient rien d'antérieur), et le slot de braquage libéré est
 * celui de CETTE transaction (même horodatage, voir {@link recordActivity}),
 * jamais simplement le plus récent du déclarant.
 * @returns `false` si la transaction n'existe pas ou était déjà supprimée.
 */
export async function suppTransaction(
  guildId: string, id: number, deletedBy: string,
  opts: { statUserIds: string[]; statDelta: number; sinceTs: number; freeBraquage: boolean },
): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const row = await tx.transaction.findFirst({ where: { id, guildId, deleted: false } });
    if (!row) return false;
    const { count } = await tx.transaction.updateMany({ where: { id, guildId, deleted: false }, data: { deleted: true, deletedBy } });
    if (count !== 1) return false;

    if (row.timestamp.getTime() >= opts.sinceTs) {
      for (const uid of opts.statUserIds) {
        await tx.$executeRaw`
          UPDATE stats SET count = GREATEST(count - ${opts.statDelta}, 0)
          WHERE guild_id = ${guildId} AND user_id = ${uid} AND action = ${row.action}
        `;
      }
    }
    if (opts.freeBraquage) {
      const braquage = await tx.braquage.findFirst({ where: { guildId, userId: row.userId, action: row.action, timestamp: row.timestamp } });
      if (braquage) await tx.braquage.deleteMany({ where: { id: braquage.id, guildId } });
    }
    return true;
  });
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

/** Toutes les lignes de stats d'une guilde, tous joueurs confondus, en une seule requête — voir quotas.getAllUserQuotaSummaries (évite un N+1 sur /quotas, le classement et la paie hebdomadaire). */
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
 *
 * Un événement labo/braquage crédite le déclarant ET chaque `partenaires`
 * (même règle que le crédit de `Stat` dans `recordActivity`, voir `modules/quotas.ts`
 * `handleModal`/`handleSelect`) — sans ça, un partenaire apparaîtrait dans
 * son quota/sa paie du panneau Discord live mais disparaîtrait de l'API pour
 * une semaine passée, alors que `Transaction` est censée reconstruire
 * exactement ce que `Stat` donnerait. `partenaires` n'inclut jamais le
 * déclarant lui-même (déjà filtré à la création, voir `quotas.ts`), donc pas
 * de double-crédit.
 */
export async function getUserActionTotals(guildId: string, sinceTs: number, untilTs: number, quantityActions: string[] = [], userId?: string): Promise<Array<{ userId: string; action: string; total: number }>> {
  const rows = await prisma.transaction.findMany({
    where: {
      guildId, deleted: false, timestamp: { gte: new Date(sinceTs), lt: new Date(untilTs) },
      // Substring sur le JSON stocké, entre guillemets pour éviter qu'un ID
      // soit un faux positif de sous-chaîne d'un autre — un `contains` évite
      // de charger toute la guilde juste pour retrouver les transactions où
      // ce joueur n'est que partenaire (pas déclarant).
      ...(userId ? { OR: [{ userId }, { partenaires: { contains: `"${userId}"` } }] } : {}),
    },
    select: { userId: true, action: true, quantite: true, partenaires: true },
  });
  const totals = new Map<string, { userId: string; action: string; total: number }>();
  const credit = (uid: string, action: string, add: number) => {
    const key = `${uid}|${action}`;
    const existing = totals.get(key);
    if (existing) existing.total += add;
    else totals.set(key, { userId: uid, action, total: add });
  };
  for (const r of rows) {
    const add = quantityActions.includes(r.action) ? r.quantite : 1;
    let partenaires: string[] = [];
    try { partenaires = JSON.parse(r.partenaires); } catch { /* ignore */ }
    const participants = userId ? [userId] : [r.userId, ...partenaires];
    for (const uid of participants) credit(uid, r.action, add);
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

/** Déclarations de fabrication de munitions depuis `sinceTs` (détail ligne par ligne, pas juste le total), du plus récent au plus ancien — pas de limite, contrairement à {@link getFabricationMunitionsHistorique}. Pendant de {@link getMunitionsVentesDepuis} côté fabrication. */
export async function getFabricationMunitionsDepuis(guildId: string, sinceTs: number) {
  const rows = await prisma.transaction.findMany({
    where: { guildId, action: 'fabrication_munitions', deleted: false, timestamp: { gte: new Date(sinceTs) } },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true, quantite: true, username: true, userId: true },
  });
  return rows.map(r => ({ ...r, timestamp: toMs(r.timestamp) }));
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
    select: { timestamp: true, quantite: true, username: true, userId: true },
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

/**
 * Reset hebdomadaire, en UNE transaction : vide `Stat`, avance
 * `last_weekly_reset`, et note dans `weekly_publication` la période qui reste
 * à publier (bilan, paie, fourrières). Les trois écritures tiennent ou
 * tombent ensemble — jamais un reset marqué fait avec des stats intactes, ni
 * l'inverse. La publication, elle, se fait ensuite depuis `Transaction` et se
 * retente tant que `weekly_publication` existe (voir `quotas.checkWeeklyReset`).
 */
export async function performWeeklyReset(guildId: string, resetKey: string, publicationKey: string, sinceTs: number, untilTs: number): Promise<void> {
  const upsert = (key: string, value: string) => prisma.setting.upsert({
    where: { guildId_key: { guildId, key } },
    create: { guildId, key, value },
    update: { value },
  });
  await prisma.$transaction([
    prisma.stat.deleteMany({ where: { guildId } }),
    upsert(resetKey, String(untilTs)),
    upsert(publicationKey, JSON.stringify({ since: sinceTs, until: untilTs, bilan: false, paie: false, fourrieres: false })),
  ]);
}

// ─── COOLDOWNS ───────────────────────────────────────────────────────────────

/** Timestamp d'expiration (ms) du cooldown d'un joueur/action, ou 0 si aucun. */
export async function getCooldown(guildId: string, userId: string, action: string): Promise<number> {
  const row = await prisma.cooldown.findUnique({ where: { guildId_userId_action: { guildId, userId, action } } });
  return row ? toMs(row.expiresAt) : 0;
}


/** Tous les cooldowns encore actifs (non expirés) d'une guilde — voir `/api/quotas/cooldowns`, seule utilisatrice actuelle. */
export async function getActiveCooldowns(guildId: string): Promise<Array<{ userId: string; action: string; expiresAt: number }>> {
  const rows = await prisma.cooldown.findMany({ where: { guildId, expiresAt: { gt: new Date() } } });
  return rows.map(r => ({ userId: r.userId, action: r.action, expiresAt: toMs(r.expiresAt) }));
}

/** Cooldowns d'une guilde expirés dont l'alerte de fin n'a pas encore été envoyée. */
export async function getExpiredUnnotifiedCooldowns(guildId: string): Promise<Array<{ userId: string; action: string; expiresAt: number }>> {
  const rows = await prisma.cooldown.findMany({ where: { guildId, expiresAt: { lte: new Date() }, notified: false } });
  return rows.map(r => ({ userId: r.userId, action: r.action, expiresAt: toMs(r.expiresAt) }));
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

/** Nombre de braquages d'un type donné dans les 7 derniers jours, pour une guilde. */
export async function getBraquageCount(guildId: string, action: string): Promise<number> {
  return prisma.braquage.count({ where: { guildId, action, timestamp: { gte: new Date(Date.now() - SEVEN_DAYS_MS) } } });
}

/**
 * Comme {@link getBraquageCount}, mais pour plusieurs actions en une seule
 * requête (`groupBy`) — utilisé partout où le panneau affiche TOUTES les
 * activités de braquage à la fois (`quotas.buildMainEmbed`/`handleMinuterie`),
 * plutôt qu'un `getBraquageCount` par activité à chaque rafraîchissement
 * (déclenché après chaque déclaration/vente/`/supp`, un hot path). Une action
 * sans aucun braquage dans la fenêtre est simplement absente de l'objet
 * retourné (0 implicite pour l'appelant).
 */
export async function getBraquageCounts(guildId: string, actions: string[]): Promise<Record<string, number>> {
  if (!actions.length) return {};
  const rows = await prisma.braquage.groupBy({
    by: ['action'],
    where: { guildId, action: { in: actions }, timestamp: { gte: new Date(Date.now() - SEVEN_DAYS_MS) } },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.action] = r._count._all;
  return counts;
}

/** Purge les entrées de braquage d'une guilde sorties de la fenêtre glissante de 7 jours. */
export async function cleanOldBraquages(guildId: string): Promise<void> {
  await prisma.braquage.deleteMany({ where: { guildId, timestamp: { lt: new Date(Date.now() - SEVEN_DAYS_MS) } } });
}

/** Timestamp (ms) du braquage le plus ancien encore dans la fenêtre de 7 jours pour une action, ou `null`. */
export async function getOldestBraquage(guildId: string, action: string): Promise<number | null> {
  const row = await prisma.braquage.findFirst({
    where: { guildId, action, timestamp: { gte: new Date(Date.now() - SEVEN_DAYS_MS) } },
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

/** Convertit une ligne Prisma `Taxe` : `echeance` en millisecondes epoch. */
function mapTaxe<T extends { echeance: Date }>(t: T) {
  return { ...t, echeance: toMs(t.echeance) };
}

/**
 * Comme {@link mapTaxe}, mais retire `telephone`/`motDePasse` — utilisée
 * UNIQUEMENT par `findTaxes` (liste/recherche, voir `src/api/routes/taxes.ts`
 * `GET /api/taxes`/`GET /api/taxes/search`), jamais par `getTaxe` (détail
 * d'UNE taxe, `GET /api/taxes/:id`, qui a besoin de tout pour l'usage
 * Discord — fiche de taxe, renouvellement...). `id` reste présent : sans
 * lui, impossible pour un client de savoir quel id appeler ensuite sur
 * `/:id` pour obtenir le détail complet.
 */
function mapTaxeSummary<T extends { echeance: Date; telephone: string | null; motDePasse: string | null }>(t: T) {
  const { telephone, motDePasse, ...rest } = mapTaxe(t);
  return rest;
}

/** Une taxe active (non soft-deleted) par ID, ou `undefined`. */
export async function getTaxe(guildId: string, id: number) {
  const row = await prisma.taxe.findFirst({ where: { id, guildId, actif: true } });
  return row ? mapTaxe(row) : undefined;
}

/**
 * Taxe active ET non expirée pour un type ET un nom de groupe donnés (nom
 * comparé insensible à la casse), ou undefined — utilisé pour bloquer la
 * création d'une nouvelle taxe tant qu'une autre du MÊME groupe sur ce même
 * type est encore en cours. Deux groupes différents peuvent chacun avoir
 * leur propre taxe active sur le même type/zone en parallèle — voir
 * docstring de `modules/taxes.ts`. `actif` (soft-delete) ne suffit pas seul :
 * une taxe expirée mais pas encore supprimée ne doit PAS bloquer une
 * nouvelle création, d'où le filtre supplémentaire sur `echeance`.
 */
export async function getActiveTaxeByTypeAndNom(guildId: string, type: string, nom: string) {
  const row = await prisma.taxe.findFirst({
    where: { guildId, type, nom: { equals: nom, mode: 'insensitive' }, actif: true, echeance: { gt: new Date() } },
  });
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
  return rows.map(mapTaxeSummary);
}

/**
 * Ajoute `days` jours à l'échéance d'une taxe (au moins depuis maintenant) et
 * retourne la nouvelle échéance, ou `null` si introuvable. Lecture et
 * écriture sous verrou dans une même transaction : deux renouvellements
 * simultanés s'additionnent au lieu de partir de la même échéance. `paye`
 * est l'état posé avec le renouvellement, en une seule écriture.
 */
export async function renewTaxe(guildId: string, id: number, days: number, paye: boolean): Promise<number | null> {
  return prisma.$transaction(async tx => {
    await lockKey(tx, `taxe:${guildId}:${id}`);
    const taxe = await tx.taxe.findFirst({ where: { id, guildId, actif: true } });
    if (!taxe) return null;
    const base = Math.max(Date.now(), taxe.echeance.getTime());
    const newDate = base + days * 24 * 60 * 60 * 1000;
    await tx.taxe.updateMany({ where: { id, guildId }, data: { echeance: new Date(newDate), alerteSent: false, paye } });
    return newDate;
  });
}

/**
 * Crée une taxe sauf si le même groupe en a déjà une active et non expirée
 * sur ce type — vérification et création sous verrou dans une même
 * transaction, pour que deux soumissions simultanées n'en créent pas deux.
 * `unique: false` (taxe `vente`, cumulable) crée sans vérifier.
 * @returns L'ID créé, ou `null` si une taxe active existe déjà.
 */
export async function addTaxeIfFree(guildId: string, data: TaxeInput, unique: boolean): Promise<number | null> {
  return prisma.$transaction(async tx => {
    if (unique) {
      await lockKey(tx, `taxe-creation:${guildId}:${data.type}:${data.nom.toLowerCase()}`);
      const existing = await tx.taxe.findFirst({
        where: { guildId, type: data.type, nom: { equals: data.nom, mode: 'insensitive' }, actif: true, echeance: { gt: new Date() } },
      });
      if (existing) return null;
    }
    const row = await tx.taxe.create({
      data: {
        guildId, nom: data.nom, type: data.type, telephone: data.telephone ?? null,
        echeance: new Date(data.echeance), motDePasse: data.mot_de_passe ?? null, paye: data.paye !== false,
      },
    });
    return row.id;
  });
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

/**
 * Comptes Discord connus de cette guilde, pour peupler un sélecteur de
 * joueur côté site externe (voir `GET /api/users`) — union des déclarants de
 * `Transaction` (jamais purgée) et des joueurs mappés (`UserMapping`).
 * Purement DB, pas d'appel au client Discord : le nom affiché privilégie le
 * dernier tag Discord connu (`Transaction.username`, posé à chaque
 * déclaration d'activité) ; à défaut (jamais rien déclaré, seulement mappé
 * via `/adduser`), retombe sur le(s) nom(s) en jeu associés. Un compte qui ne
 * figure plus dans aucune des deux sources (mapping supprimé, jamais
 * déclaré) disparaît simplement de la liste — pas une erreur, voir les
 * autres fonctions `getVente*`/`getUserActionTotals` qui gèrent déjà un
 * `userId` sans aucune donnée en renvoyant un résultat vide. `deleted: false`
 * — même filtre que toutes les autres lectures de `Transaction` (voir
 * `getAllTransactions`/`getGroupActionTotals`/`getUserActionTotals`/
 * `getVenteTotalsForRange`) : un joueur dont l'unique déclaration a été
 * supprimée (`/supp`) ne doit pas rester "connu" ici alors que toutes les
 * autres routes API (`/api/quotas/:userId`, `/api/ventes/:userId`) le
 * traitent déjà comme n'ayant jamais rien déclaré.
 */
export async function getKnownUsers(guildId: string): Promise<Array<{ userId: string; username: string }>> {
  const [transactions, mappings] = await Promise.all([
    prisma.transaction.findMany({
      where: { guildId, deleted: false, username: { not: '' } },
      select: { userId: true, username: true },
      orderBy: { timestamp: 'desc' },
    }),
    prisma.userMapping.findMany({ where: { guildId }, select: { discordId: true, gameName: true } }),
  ]);

  const latestUsername = new Map<string, string>();
  for (const t of transactions) {
    if (!latestUsername.has(t.userId)) latestUsername.set(t.userId, t.username);
  }

  const gameNamesByUser = new Map<string, string[]>();
  for (const m of mappings) {
    const arr = gameNamesByUser.get(m.discordId) ?? [];
    arr.push(m.gameName);
    gameNamesByUser.set(m.discordId, arr);
  }

  const allIds = new Set<string>([...latestUsername.keys(), ...gameNamesByUser.keys()]);
  return [...allIds]
    .map(userId => ({ userId, username: latestUsername.get(userId) ?? gameNamesByUser.get(userId)!.join(', ') }))
    .sort((a, b) => a.username.localeCompare(b.username));
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
      quantiteRetiree: data.quantite,
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

/**
 * Fait passer une vente en attente à `statut`, SEULEMENT si elle est encore
 * dans l'un des statuts `from` — une transition concurrente (bouton, dépôt,
 * expiration) ne peut donc pas écraser celle qui a gagné, ni faire revenir en
 * `declare` une vente déjà reposée ou confirmée.
 * @returns `false` si la vente n'était plus dans un statut attendu (rien n'est écrit).
 */
export async function transitionPendingSale(guildId: string, id: number, from: string[], statut: string): Promise<boolean> {
  const { count } = await prisma.pendingSale.updateMany({
    where: { id, guildId, statut: { in: from }, confirmed: false },
    data: { statut, ...(statut === 'confirme' ? { confirmed: true } : {}) },
  });
  return count === 1;
}

/**
 * Correction manuelle de la quantité vendue (bouton "Modifier la quantité"),
 * seulement si la vente est encore `en_attente` — ne touche pas
 * `quantiteRetiree`, une correction n'étant pas un mouvement de coffre.
 * @returns `false` si la vente n'était plus en attente.
 */
export async function updatePendingSaleQuantite(guildId: string, id: number, quantite: number): Promise<boolean> {
  const { count } = await prisma.pendingSale.updateMany({ where: { id, guildId, statut: 'en_attente', confirmed: false }, data: { quantite } });
  return count === 1;
}

/** Associe (rétroactivement) un compte Discord à une vente en attente. */
export async function updatePendingSaleDiscordId(guildId: string, id: number, discordId: string): Promise<void> {
  await prisma.pendingSale.updateMany({ where: { id, guildId }, data: { discordId } });
}

/**
 * Confirme une vente DÉCLARÉE et crédite le quota/la paie du joueur
 * (catégorie `vente`) en une seule transaction DB. La confirmation est
 * conditionnelle au statut `declare` et le crédit ne se fait que si elle a
 * réellement modifié la ligne : deux dépôts d'argent traités en même temps ne
 * créditent donc la vente qu'une fois, et un arrêt entre les deux écritures
 * ne laisse pas une vente "confirmée" sans crédit. La quantité créditée est
 * celle lue dans la transaction, pas celle d'une lecture antérieure. Sans
 * `discordId` sur la vente, elle est confirmée sans crédit (rien à
 * attribuer — une alerte est postée par l'appelant).
 * @returns La quantité confirmée, ou `null` si la vente n'était plus déclarée.
 */
export async function confirmDeclaredSale(guildId: string, saleId: number): Promise<{ quantite: number; credited: boolean } | null> {
  return prisma.$transaction(async tx => {
    const sale = await tx.pendingSale.findFirst({ where: { id: saleId, guildId } });
    if (!sale) return null;
    const { count } = await tx.pendingSale.updateMany({
      where: { id: saleId, guildId, statut: 'declare', confirmed: false },
      data: { confirmed: true, statut: 'confirme' },
    });
    if (count !== 1) return null;
    if (!sale.discordId) return { quantite: sale.quantite, credited: false };

    await tx.transaction.create({
      data: { guildId, userId: sale.discordId, username: sale.joueur, action: 'vente', quantite: sale.quantite, type: sale.item, partenaires: '[]', timestamp: new Date() },
    });
    await tx.stat.upsert({
      where: { guildId_userId_action: { guildId, userId: sale.discordId, action: 'vente' } },
      create: { guildId, userId: sale.discordId, action: 'vente', count: sale.quantite, points: 0 },
      update: { count: { increment: sale.quantite } },
    });
    return { quantite: sale.quantite, credited: true };
  });
}

/** Vente en attente accumulable (même joueur/item, pas encore confirmée) depuis `since`, la plus récente. */
export async function getPendingSaleForAccumulation(guildId: string, joueur: string, item: string, since: number) {
  const row = await prisma.pendingSale.findFirst({
    where: { guildId, joueur, item, statut: 'en_attente', confirmed: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'desc' },
  });
  return row ? mapPendingSale(row) : undefined;
}

/**
 * Vente active (statut `en_attente` OU `declare`, pas encore confirmée) la
 * plus récente pour ce joueur/item depuis `since` — utilisée par un redépôt
 * pour retrouver la vente à réduire/annuler, y compris après que le joueur a
 * déjà cliqué "Déclarer" (contrairement à {@link getPendingSaleForAccumulation},
 * qui reste `en_attente` seule pour l'accumulation d'un nouveau retrait).
 */
export async function getPendingSaleForReduction(guildId: string, joueur: string, item: string, since: number) {
  const row = await prisma.pendingSale.findFirst({
    where: { guildId, joueur, item, statut: { in: ['en_attente', 'declare'] }, confirmed: false, timestamp: { gte: new Date(since) } },
    orderBy: { timestamp: 'desc' },
  });
  return row ? mapPendingSale(row) : undefined;
}

/**
 * Cumule un nouveau retrait sur une vente encore `en_attente` : `quantite` et
 * `quantiteRetiree` sont incrémentées (jamais écrites en valeur absolue
 * depuis une lecture antérieure), la fenêtre de la vente est rafraîchie.
 * @returns La nouvelle quantité, ou `null` si la vente n'était plus en attente.
 */
export async function accumulatePendingSale(guildId: string, id: number, retrait: number, timestamp: number): Promise<number | null> {
  return prisma.$transaction(async tx => {
    const { count } = await tx.pendingSale.updateMany({
      where: { id, guildId, statut: 'en_attente', confirmed: false },
      data: { quantite: { increment: retrait }, quantiteRetiree: { increment: retrait }, timestamp: new Date(timestamp) },
    });
    if (count !== 1) return null;
    const row = await tx.pendingSale.findFirst({ where: { id, guildId } });
    return row ? row.quantite : null;
  });
}

/**
 * Applique un redépôt de drogue à une vente active (`en_attente` ou
 * `declare`). `quantiteRetiree` suit le coffre réel ; la quantité vendue ne
 * peut pas dépasser ce qui reste réellement dehors, mais une correction
 * manuelle à la baisse déjà faite est conservée (`min`) — sans quoi un
 * retrait de 100 corrigé à 60 puis 40 redéposés donnerait 20 au lieu de 60.
 * Plus rien dehors : la vente est annulée (`ignore`).
 * @returns Le nouvel état, ou `null` si la vente n'était plus active.
 */
export async function applyRedeposit(guildId: string, id: number, redepot: number): Promise<{ quantite: number; annulee: boolean; statut: string } | null> {
  return prisma.$transaction(async tx => {
    await lockKey(tx, `vente:${guildId}:${id}`);
    const sale = await tx.pendingSale.findFirst({ where: { id, guildId, statut: { in: ['en_attente', 'declare'] }, confirmed: false } });
    if (!sale) return null;
    const dehors = sale.quantiteRetiree - redepot;
    if (dehors <= 0) {
      await tx.pendingSale.updateMany({ where: { id, guildId }, data: { statut: 'ignore', quantiteRetiree: 0 } });
      return { quantite: 0, annulee: true, statut: sale.statut };
    }
    const quantite = Math.min(sale.quantite, dehors);
    await tx.pendingSale.updateMany({
      where: { id, guildId },
      data: { quantite, quantiteRetiree: dehors, ...(sale.statut === 'en_attente' ? { timestamp: new Date() } : {}) },
    });
    return { quantite, annulee: false, statut: sale.statut };
  });
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
    where: { guildId, statut: { in: ['en_attente', 'declare', 'repose'] }, timestamp: { lt: new Date(before) } },
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

/**
 * Détail par item vendu (`Transaction.type`) pour TOUS les joueurs sur une
 * plage — comme `getVenteDetailForUser` mais sans filtrer un joueur précis.
 * N'a de sens d'être appelée que si au moins un taux de paie par item est
 * configuré pour la guilde (voir `quotas.getVenteByItemMap`), jamais par
 * défaut : c'est une lecture `Transaction` supplémentaire que le panneau
 * Discord live n'a normalement jamais besoin de faire.
 */
export async function getVenteDetailAllUsers(guildId: string, sinceTs: number, untilTs: number): Promise<Array<{ userId: string; item: string; quantite: number }>> {
  const rows = await prisma.transaction.groupBy({
    by: ['userId', 'type'],
    where: { guildId, deleted: false, action: 'vente', timestamp: { gte: new Date(sinceTs), lt: new Date(untilTs) } },
    _sum: { quantite: true },
  });
  return rows.map(r => ({ userId: r.userId, item: r.type ?? 'inconnu', quantite: r._sum.quantite ?? 0 }));
}

// ─── VÉHICULES / FOURRIÈRE ────────────────────────────────────────────────────

/** État courant (responsable) d'un véhicule par plaque, ou `undefined` si jamais vu. */
export async function getVehiculeEtat(guildId: string, plaque: string) {
  const row = await prisma.vehicule.findUnique({ where: { guildId_plaque: { guildId, plaque } } });
  return row ? { ...row, timestamp: toMs(row.timestamp) } : undefined;
}

/** Véhicules actuellement sortis et pas encore rangés (`joueur` non `null`, voir `clearVehiculeEtat`) — pour `/api/garages/vehicles`, le plus récemment sorti en premier. */
export async function getVehiculesSortis(guildId: string) {
  const rows = await prisma.vehicule.findMany({ where: { guildId, joueur: { not: null } }, orderBy: { timestamp: 'desc' } });
  return rows.map(r => ({ ...r, timestamp: toMs(r.timestamp) }));
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
