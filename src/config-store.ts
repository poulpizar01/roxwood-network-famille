/**
 * @file src/config-store.ts
 * @description La configuration qui bouge réellement d'un déploiement à
 * l'autre ou dans le temps (salons, rôles, items, objectifs de quota, taux de
 * paie) vit en base (voir src/db.ts) et se modifie depuis Discord via
 * `/config` (src/modules/config.ts).
 *
 * Le registre des activités déclarables ({@link ACTIVITY_TYPES_FIXED}), lui,
 * est une liste FIXE dans ce fichier (pas de `/config activite`) — comme les
 * armes ou les types de taxe, ces activités (ATM, Cambu, Fleeca, labos…), leurs
 * cooldowns et leurs limites de braquage ne changent quasiment jamais une
 * fois le bot déployé pour une organisation donnée. Seuls les OBJECTIFS
 * hebdomadaires par catégorie de quota restent pilotables via `/config
 * quota`, parce qu'eux peuvent être renégociés. Les salons de labo restent
 * configurables via `/config channel` comme n'importe quel autre salon —
 * chaque serveur Discord a ses propres IDs.
 *
 * `reload(guildId)` (async, Prisma oblige) reconstruit le cache d'UNE
 * guilde ; `get(guildId)` (sync) le retourne tel quel. Un changement de
 * config prend effet dès que `/config` appelle `reload(guildId)` — jamais
 * besoin de redémarrer le process.
 *
 * **Multi-tenant** : le cache est un `Map<guildId, BotConfig>`, pas une
 * config globale unique — chaque guilde a la sienne, complètement
 * indépendante. `guildId` est donc obligatoire sur `get`/`reload`/`mutate`,
 * jamais optionnel.
 *
 * Usage dans les modules : `import * as configStore from '../config-store';`
 * puis `configStore.get(guildId).CHANNELS.stock_general` (ne jamais mettre
 * en cache le résultat de `get()` dans une variable de module chargée une
 * seule fois).
 */
import * as db from './db';

/**
 * Rôles de salon fixes reconnus par le bot (le "quel salon fait quoi" reste un
 * ensemble fermé — ce sont les fonctionnalités présentes — mais chaque rôle est
 * assignable à n'importe quel salon Discord via `/config channel set`).
 */
export const CHANNEL_ROLES = [
  'stock_general', 'logs_activites', 'alertes_braquages',
  'alertes_actions', 'bilan', 'paie', 'armurerie', 'quotas', 'taxes',
  'alertes_taxes', 'historique_stock', 'ventes_drogue', 'log_ventes',
  'admin', 'logs_garages', 'labo_heroine', 'labo_sporex',
  'labo_mexicana', 'labo_cannabis', 'labo_cocaine',
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
  /** Résolu dans `reload()` selon `TYPE_GROUPE` — voir {@link LABO_TIERS}. `true` pour toute activité non listée dans `LABO_TIERS` (jamais désactivée par le tier). */
  enabled: boolean;
  /** Icône d'affichage (optionnelle) — champ à part, jamais fondue dans `label` (voir {@link activityDisplayLabel}). */
  icon?: string;
}

/** Combine icône + libellé pour l'affichage (bouton, embed, message) — `label` seul reste réutilisable tel quel (ex. pour matcher un titre d'embed existant). */
export function activityDisplayLabel(cfg: ActivityTypeConfig): string {
  return cfg.icon ? `${cfg.icon} ${cfg.label}` : cfg.label;
}

/** Types d'organisation — voir docstring de {@link BRAQUAGE_LIMITS_BY_TIER} et {@link LABO_TIERS}. */
export type GroupTier = 'independant' | 'petite_frappe' | 'gang' | 'organisation';

export const GROUP_TIERS: Array<{ key: GroupTier; label: string }> = [
  { key: 'independant', label: 'Indépendant' },
  { key: 'petite_frappe', label: 'Petite Frappe' },
  { key: 'gang', label: 'Gang' },
  { key: 'organisation', label: 'Organisation' },
];

/** Clé de `Setting` (voir db.ts) où est persisté le tier actuel — modifié via `/config type-groupe set`. */
export const TYPE_GROUPE_SETTING_KEY = 'type_groupe';

/**
 * Tier appliqué tant qu'aucun `/config type-groupe set` n'a jamais été fait.
 * Choisi égal aux anciennes valeurs codées en dur (Fleeca/Armurerie 6,
 * Bijouterie/Pinebank 1) pour qu'un déploiement existant qui ne configure pas
 * immédiatement son tier ne voie pas ses limites de braquage changer.
 */
const DEFAULT_GROUP_TIER: GroupTier = 'petite_frappe';

/** Millisecondes dans une heure — raccourci pour écrire les cooldowns ci-dessous de façon lisible (`3 * H` = 3h) plutôt qu'en valeur brute. */
const H = 3_600_000;

/**
 * Registre fixe des activités déclarables. `laboChannelId` n'est pas
 * renseigné ici : il est résolu dans `reload()` depuis
 * `CHANNELS.labo_heroine`/`labo_sporex`/etc. (configurables via `/config
 * channel`, propres à chaque serveur Discord). `enabled` non plus : voir plus
 * bas.
 *
 * `braquageWeeklyLimit` de fleeca/braq_armurerie/bijouterie/pinebank/
 * human_labs est TOUJOURS écrasé dans `reload()` par {@link BRAQUAGE_LIMITS_BY_TIER}
 * selon le tier courant — la valeur `null` ici n'est qu'un placeholder, elle
 * n'est jamais utilisée telle quelle.
 */
const ACTIVITY_TYPES_FIXED: Record<string, Omit<ActivityTypeConfig, 'laboChannelId' | 'enabled'>> = {
  atm:            { label: 'ATM',           quotaType: 'actions', cooldownMs: 3 * H,  partners: false, braquageWeeklyLimit: null, labo: false, quantity: false, panelButton: true,  displayOrder: 1 },
  cambu:          { label: 'Cambu',         quotaType: 'actions', cooldownMs: 3 * H,  partners: false, braquageWeeklyLimit: null, labo: false, quantity: false, panelButton: true,  displayOrder: 2 },
  superette:      { label: 'Supérette',     quotaType: 'actions', cooldownMs: 2 * H,  partners: false, braquageWeeklyLimit: null, labo: false, quantity: false, panelButton: true,  displayOrder: 3 },
  gofast:         { label: 'Go Fast',       quotaType: 'actions', cooldownMs: 24 * H, partners: false, braquageWeeklyLimit: null, labo: false, quantity: false, panelButton: true,  displayOrder: 4 },
  fleeca:         { label: 'Fleeca',        quotaType: 'actions', cooldownMs: null,   partners: true,  braquageWeeklyLimit: null, labo: false, quantity: false, panelButton: true,  displayOrder: 5, icon: '🏦' },
  braq_armurerie: { label: 'Armurerie',     quotaType: 'actions', cooldownMs: null,   partners: true,  braquageWeeklyLimit: null, labo: false, quantity: false, panelButton: true,  displayOrder: 6, icon: '🔫' },
  bijouterie:     { label: 'Bijouterie',    quotaType: 'actions', cooldownMs: null,   partners: true,  braquageWeeklyLimit: null, labo: false, quantity: false, panelButton: true,  displayOrder: 7, icon: '💎' },
  pinebank:       { label: 'Pinebank',      quotaType: 'actions', cooldownMs: null,   partners: true,  braquageWeeklyLimit: null, labo: false, quantity: false, panelButton: true,  displayOrder: 8, icon: '🏦' },
  human_labs:     { label: 'Human Labs',    quotaType: 'actions', cooldownMs: null,   partners: true,  braquageWeeklyLimit: null, labo: false, quantity: false, panelButton: true,  displayOrder: 9, icon: '🫀' },
  vente:          { label: 'Vente drogue',  quotaType: 'vente',   cooldownMs: null,   partners: false, braquageWeeklyLimit: null, labo: false, quantity: true,  panelButton: false, displayOrder: 10 },
  recolte:        { label: 'Récolte',       quotaType: 'recolte', cooldownMs: null,   partners: false, braquageWeeklyLimit: null, labo: false, quantity: true,  panelButton: true,  displayOrder: 11 },
  labo_heroine:   { label: 'Labo Héroïne',  quotaType: 'labos',   cooldownMs: null,   partners: true,  braquageWeeklyLimit: null, labo: true,  quantity: false, panelButton: true,  displayOrder: 12 },
  labo_sporex:    { label: 'Labo Sporex',   quotaType: 'labos',   cooldownMs: null,   partners: true,  braquageWeeklyLimit: null, labo: true,  quantity: false, panelButton: true,  displayOrder: 13 },
  labo_mexicana:  { label: 'Labo Mexicana', quotaType: 'labos',   cooldownMs: null,   partners: true,  braquageWeeklyLimit: null, labo: true,  quantity: false, panelButton: true,  displayOrder: 14 },
  labo_cannabis:  { label: 'Labo Cannabis', quotaType: 'labos',   cooldownMs: null,   partners: true,  braquageWeeklyLimit: null, labo: true,  quantity: false, panelButton: true,  displayOrder: 15 },
  labo_cocaine:   { label: 'Labo Cocaïne',  quotaType: 'labos',   cooldownMs: null,   partners: true,  braquageWeeklyLimit: null, labo: true,  quantity: false, panelButton: true,  displayOrder: 16 },
};

/**
 * Barème hebdomadaire de braquages par type d'organisation — remplace le
 * `braquageWeeklyLimit` fixe des activités concernées (voir
 * `ACTIVITY_TYPES_FIXED`). `0` signifie que l'activité n'est PAS accessible à
 * ce tier : contrairement à `null` (qui veut dire "pas de limite du tout",
 * comme ATM), `0` bloque bien la déclaration (voir `checkBraquageLimit` dans
 * quotas.ts, qui distingue `null` de `0`).
 */
export const BRAQUAGE_LIMITS_BY_TIER: Record<GroupTier, Record<string, number>> = {
  independant:   { fleeca: 2,  braq_armurerie: 2,  bijouterie: 0, pinebank: 0, human_labs: 0 },
  petite_frappe: { fleeca: 6,  braq_armurerie: 6,  bijouterie: 1, pinebank: 1, human_labs: 0 },
  gang:          { fleeca: 10, braq_armurerie: 10, bijouterie: 2, pinebank: 1, human_labs: 1 },
  organisation:  { fleeca: 12, braq_armurerie: 12, bijouterie: 4, pinebank: 2, human_labs: 1 },
};

/**
 * Labos accessibles par type d'organisation — une clé absente ici (aucun
 * tier ne la liste) est désactivée pour TOUS les tiers ; le tier
 * `independant` n'apparaît dans aucune liste, donc aucun labo n'y est
 * jamais disponible. Détermine `ActivityTypeConfig.enabled` dans `reload()`.
 */
export const LABO_TIERS: Record<string, GroupTier[]> = {
  labo_heroine: ['petite_frappe'],
  labo_sporex: ['petite_frappe'],
  labo_mexicana: ['gang', 'organisation'],
  labo_cannabis: ['gang'],
  labo_cocaine: ['organisation'],
};

export interface ItemConfig {
  name: string;
  stockGroup: string | null;
  vente: boolean;
  displayOrder: number;
  visibleStock: boolean;
  laboLie: string | null;
  /** Unités de base par unité de cet item (ex. 24 pour une boîte de munitions) — voir docstring du modèle `Item` et `armurerie.weightedStockSum`. */
  stockMultiplier: number;
}

export interface BotConfig {
  /** `logs_coffres`/`logs_coffres_admin` sont des listes (plusieurs salons possibles chacune, voir `/config channel add-log-coffre`/`add-log-coffre-admin`) — les deux sont surveillées de la même façon par `stocks.ts`, `logs_coffres_admin` obtenant en plus le badge 🛡️ dans `historique_stock` (voir `logStockToChannel`). */
  CHANNELS: Record<ChannelRole, string | null> & { logs_coffres: string[]; logs_coffres_admin: string[] };
  ALLOWED_ITEMS: string[];
  ITEMS_BY_NAME: Record<string, ItemConfig>;
  STOCK_GROUPS: Record<string, string[]>;
  VENTE_ITEMS: string[];
  /** Items dont le `laboLie` est actif pour le tier courant — drogues en production interne, complément exact de VENTE_ITEMS pour ces items-là (voir `laboLie` dans db.ts). */
  LABO_ITEMS: string[];
  ACTIVITY_TYPES: Record<string, ActivityTypeConfig>;
  QUOTA_TARGETS: Record<string, number>;
  ADMIN_ROLE_ID: string | null;
  TAXES_ROLE_ID: string | null;
  /** $ par unité, par catégorie de quota — voir `/config salaire` et `computeSalaire` dans quotas.ts. Catégorie absente = aucune paie pour elle. */
  SALARY_RATES: Record<string, number>;
  /** Tier courant — voir `/config type-groupe` et {@link DEFAULT_GROUP_TIER}. */
  TYPE_GROUPE: GroupTier;
}

/** Un cache `BotConfig` par guilde — jamais de config globale unique (voir docstring de fichier). */
const cache = new Map<string, BotConfig>();

/**
 * Recharge le cache de configuration d'UNE guilde depuis PostgreSQL. À
 * appeler (et `await`) après toute écriture faite par `/config` pour cette
 * guilde, à `guildCreate` (nouvelle guilde), et pour chaque guilde connue au
 * démarrage (voir `reloadAll` et src/index.ts).
 */
export async function reload(guildId: string): Promise<BotConfig> {
  const channelRows = await db.getAllChannels(guildId);
  const CHANNELS = { logs_coffres: [] as string[], logs_coffres_admin: [] as string[] } as BotConfig['CHANNELS'];
  for (const role of CHANNEL_ROLES) CHANNELS[role] = null;
  for (const { role, channelId } of channelRows) {
    if (role === 'logs_coffres' || role === 'logs_coffres_admin') {
      CHANNELS[role].push(channelId);
    } else if ((CHANNEL_ROLES as readonly string[]).includes(role)) {
      CHANNELS[role as ChannelRole] = channelId;
    }
  }

  const tierSetting = await db.getSetting(guildId, TYPE_GROUPE_SETTING_KEY);
  const TYPE_GROUPE: GroupTier = (tierSetting && GROUP_TIERS.some(t => t.key === tierSetting))
    ? (tierSetting as GroupTier)
    : DEFAULT_GROUP_TIER;

  const items = await db.getAllItems(guildId);
  const ITEMS_BY_NAME: Record<string, ItemConfig> = {};
  const STOCK_GROUPS: Record<string, string[]> = {};
  const ALLOWED_ITEMS: string[] = [];
  const VENTE_ITEMS: string[] = [];
  const LABO_ITEMS: string[] = [];
  for (const it of items) {
    ITEMS_BY_NAME[it.name] = it;
    ALLOWED_ITEMS.push(it.name);
    if (it.stockGroup) (STOCK_GROUPS[it.stockGroup] ??= []).push(it.name);
    // Un item lié à un labo (`laboLie`) n'est vendable en PNJ que si CE tier
    // ne peut pas produire cette drogue lui-même — voir LABO_TIERS. Un item
    // sans lien reste vendable dès que `vente` est vrai, quel que soit le tier.
    // `produitParLabo` et l'exclusion de VENTE_ITEMS sont l'exact complément
    // l'un de l'autre : une drogue est soit vendable en PNJ, soit en
    // production interne pour ce tier, jamais les deux à la fois.
    const produitParLabo = !!it.laboLie && (LABO_TIERS[it.laboLie]?.includes(TYPE_GROUPE) ?? false);
    if (it.vente && !produitParLabo) VENTE_ITEMS.push(it.name);
    if (produitParLabo) LABO_ITEMS.push(it.name);
  }

  const ACTIVITY_TYPES: Record<string, ActivityTypeConfig> = {};
  for (const [key, cfg] of Object.entries(ACTIVITY_TYPES_FIXED)) {
    ACTIVITY_TYPES[key] = { ...cfg, laboChannelId: cfg.labo ? (CHANNELS[key as ChannelRole] ?? null) : null, enabled: true };
  }

  // `enabled` = false pour un labo hors du barème de ce tier, ou une activité
  // de braquage dont la limite résolue pour ce tier est 0 — dans les deux cas,
  // l'activité disparaît des boutons/listings (voir quotas.ts) sans que la
  // limite/le barème sous-jacent soit perdu (`braquageWeeklyLimit` reste 0,
  // pas `null` : voir docstring de BRAQUAGE_LIMITS_BY_TIER).
  for (const [key, limit] of Object.entries(BRAQUAGE_LIMITS_BY_TIER[TYPE_GROUPE])) {
    if (ACTIVITY_TYPES[key]) {
      ACTIVITY_TYPES[key].braquageWeeklyLimit = limit;
      ACTIVITY_TYPES[key].enabled = limit !== 0;
    }
  }
  for (const [key, tiers] of Object.entries(LABO_TIERS)) {
    if (ACTIVITY_TYPES[key]) ACTIVITY_TYPES[key].enabled = tiers.includes(TYPE_GROUPE);
  }

  const QUOTA_TARGETS: Record<string, number> = {};
  for (const row of await db.getAllQuotaTargets(guildId)) QUOTA_TARGETS[row.quotaType] = row.weeklyTarget;

  const SALARY_RATES: Record<string, number> = {};
  for (const row of await db.getAllSalaryRates(guildId)) SALARY_RATES[row.quotaType] = row.amount;

  const rolesByTarget: Record<string, string> = {};
  for (const r of await db.getAllDiscordRoles(guildId)) rolesByTarget[r.target] = r.roleId;

  const config: BotConfig = {
    CHANNELS,
    ALLOWED_ITEMS,
    ITEMS_BY_NAME,
    STOCK_GROUPS,
    VENTE_ITEMS,
    LABO_ITEMS,
    ACTIVITY_TYPES,
    QUOTA_TARGETS,
    ADMIN_ROLE_ID: rolesByTarget.admin ?? null,
    TAXES_ROLE_ID: rolesByTarget.taxes ?? null,
    SALARY_RATES,
    TYPE_GROUPE,
  };
  cache.set(guildId, config);
  return config;
}

/**
 * Recharge le cache de TOUTES les guildes listées, séquentiellement — une
 * guilde en échec (config corrompue, etc.) n'empêche pas les suivantes.
 * Appelé une fois au démarrage (voir src/index.ts, `clientReady`) pour
 * chaque guilde active connue du registre (`guild-registry.ts`).
 */
export async function reloadAll(guildIds: string[]): Promise<void> {
  for (const guildId of guildIds) {
    try {
      await reload(guildId);
    } catch (err) {
      console.error(`[config-store] reload(${guildId}):`, (err as Error).message);
    }
  }
}

/**
 * Exécute une écriture de configuration puis recharge systématiquement le
 * cache de CETTE guilde — structurellement impossible d'oublier `reload()`
 * après une mutation, contrairement à `db.xxx(); configStore.reload();`
 * répété à la main dans chaque handler de `/config`.
 */
export async function mutate<T>(guildId: string, fn: () => Promise<T>): Promise<T> {
  const result = await fn();
  await reload(guildId);
  return result;
}

/**
 * Retourne la configuration actuelle d'une guilde (celle de son dernier
 * `reload()`). Lève une erreur si cette guilde n'a jamais été chargée — le
 * bot doit toujours charger la config de chaque guilde connue au démarrage
 * (voir src/index.ts) et à `guildCreate` avant tout autre usage.
 */
export function get(guildId: string): BotConfig {
  const config = cache.get(guildId);
  if (!config) throw new Error(`config-store: reload(${guildId}) doit être appelé avant get() (voir src/index.ts au démarrage / guildCreate)`);
  return config;
}

/** Retire une guilde du cache (voir `guildDelete` dans src/index.ts) — ses données restent en base, seul le cache en mémoire est vidé. */
export function remove(guildId: string): void {
  cache.delete(guildId);
}
