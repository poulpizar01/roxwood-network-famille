/**
 * @file src/config-store.ts
 * @description Remplace l'ancien `config.js` statique : toute la configuration
 * métier (salons, rôles, items, activités déclarables, quotas, types d'armes)
 * vit en base (voir src/db.ts) et se modifie depuis Discord via `/config`
 * (src/modules/config.ts).
 *
 * `reload()` (async, Prisma oblige) reconstruit un cache en mémoire ; `get()`
 * (sync) le retourne tel quel. Un changement de config prend effet dès que
 * `/config` appelle `reload()` — jamais besoin de redémarrer le process.
 *
 * Usage dans les modules : `import * as configStore from '../config-store';`
 * puis `configStore.get().CHANNELS.stock_general` (ne jamais mettre en cache
 * le résultat de `get()` dans une variable de module chargée une seule fois).
 */
import * as db from './db';

/**
 * Rôles de salon fixes reconnus par le bot (le "quel salon fait quoi" reste un
 * ensemble fermé — ce sont les fonctionnalités présentes — mais chaque rôle est
 * assignable à n'importe quel salon Discord via `/config channel set`).
 */
export const CHANNEL_ROLES = [
  'coffre_admin', 'stock_general', 'logs_activites', 'alertes_braquages',
  'alertes_actions', 'bilan', 'paie', 'armurerie', 'quotas', 'taxes',
  'alertes_taxes', 'historique_stock', 'ventes_drogue', 'log_ventes',
  'admin', 'logs_garages',
] as const;

export type ChannelRole = (typeof CHANNEL_ROLES)[number];

export interface ActivityTypeConfig {
  label: string;
  quotaType: string | null;
  cooldownMs: number | null;
  partners: boolean;
  braquageWeeklyLimit: number | null;
  labo: boolean;
  laboChannelId: string | null;
  quantity: boolean;
  panelButton: boolean;
  displayOrder: number;
}

export interface ItemConfig {
  name: string;
  stockGroup: string | null;
  vente: boolean;
  ventePaiement: boolean;
  displayOrder: number;
}

export interface BotConfig {
  CHANNELS: Record<ChannelRole, string | null> & { logs_coffres: string[] };
  ALLOWED_ITEMS: string[];
  ITEMS_BY_NAME: Record<string, ItemConfig>;
  STOCK_GROUPS: Record<string, string[]>;
  VENTE_ITEMS: string[];
  VENTE_ARGENT_ITEMS: string[];
  ACTIVITY_TYPES: Record<string, ActivityTypeConfig>;
  QUOTA_TARGETS: Record<string, number>;
  ADMIN_ROLE_ID: string | null;
  TAXES_ROLE_ID: string | null;
  /** $ par unité, par catégorie de quota — voir `/config salaire` et `computeSalaire` dans quotas.ts. Catégorie absente = aucune paie pour elle. */
  SALARY_RATES: Record<string, number>;
}

let cache: BotConfig | null = null;

/**
 * Recharge le cache de configuration depuis PostgreSQL. À appeler (et
 * `await`) après toute écriture faite par `/config`, et une fois au démarrage
 * avant `client.login()`.
 */
export async function reload(): Promise<BotConfig> {
  const channelRows = await db.getAllChannels();
  const CHANNELS = { logs_coffres: [] as string[] } as BotConfig['CHANNELS'];
  for (const role of CHANNEL_ROLES) CHANNELS[role] = null;
  for (const { role, channelId } of channelRows) {
    if (role === 'logs_coffres') {
      CHANNELS.logs_coffres.push(channelId);
    } else if ((CHANNEL_ROLES as readonly string[]).includes(role)) {
      CHANNELS[role as ChannelRole] = channelId;
    }
  }

  const items = await db.getAllItems();
  const ITEMS_BY_NAME: Record<string, ItemConfig> = {};
  const STOCK_GROUPS: Record<string, string[]> = {};
  const ALLOWED_ITEMS: string[] = [];
  const VENTE_ITEMS: string[] = [];
  const VENTE_ARGENT_ITEMS: string[] = [];
  for (const it of items) {
    ITEMS_BY_NAME[it.name] = it;
    ALLOWED_ITEMS.push(it.name);
    if (it.stockGroup) (STOCK_GROUPS[it.stockGroup] ??= []).push(it.name);
    if (it.vente) VENTE_ITEMS.push(it.name);
    if (it.ventePaiement) VENTE_ARGENT_ITEMS.push(it.name);
  }

  const activityRows = await db.getAllActivityTypes();
  const ACTIVITY_TYPES: Record<string, ActivityTypeConfig> = {};
  for (const row of activityRows) {
    ACTIVITY_TYPES[row.key] = {
      label: row.label,
      quotaType: row.quotaType,
      cooldownMs: row.cooldownMs,
      partners: row.partners,
      braquageWeeklyLimit: row.braquageWeeklyLimit,
      labo: row.labo,
      laboChannelId: row.laboChannelId,
      quantity: row.quantity,
      panelButton: row.panelButton,
      displayOrder: row.displayOrder,
    };
  }

  const QUOTA_TARGETS: Record<string, number> = {};
  for (const row of await db.getAllQuotaTargets()) QUOTA_TARGETS[row.quotaType] = row.weeklyTarget;

  const SALARY_RATES: Record<string, number> = {};
  for (const row of await db.getAllSalaryRates()) SALARY_RATES[row.quotaType] = row.amount;

  const rolesByTarget: Record<string, string> = {};
  for (const r of await db.getAllDiscordRoles()) rolesByTarget[r.target] = r.roleId;

  cache = {
    CHANNELS,
    ALLOWED_ITEMS,
    ITEMS_BY_NAME,
    STOCK_GROUPS,
    VENTE_ITEMS,
    VENTE_ARGENT_ITEMS,
    ACTIVITY_TYPES,
    QUOTA_TARGETS,
    ADMIN_ROLE_ID: rolesByTarget.admin ?? null,
    TAXES_ROLE_ID: rolesByTarget.taxes ?? null,
    SALARY_RATES,
  };
  return cache;
}

/**
 * Exécute une écriture de configuration puis recharge systématiquement le
 * cache — structurellement impossible d'oublier `reload()` après une
 * mutation, contrairement à `db.xxx(); configStore.reload();` répété à la
 * main dans chaque handler de `/config`.
 */
export async function mutate<T>(fn: () => Promise<T>): Promise<T> {
  const result = await fn();
  await reload();
  return result;
}

/**
 * Retourne la configuration actuelle (celle du dernier `reload()`). Lève une
 * erreur si `reload()` n'a jamais été appelé — le bot doit toujours charger
 * la config au démarrage avant tout usage (voir src/index.ts).
 */
export function get(): BotConfig {
  if (!cache) throw new Error('config-store: reload() doit être appelé avant get() (voir src/index.ts au démarrage)');
  return cache;
}
