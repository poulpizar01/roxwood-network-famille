/**
 * @file src/modules/taxes.ts
 * @description Gestion des taxes et loyers dans le contexte RP (FiveM).
 *
 * Deux familles de types de taxe, toutes deux fixes dans le code (pas
 * configurables via `/config` — voir plus bas pourquoi) :
 *  - Types fixes avec leur propre bouton : 'sporex' (labo Spore X), 'heroine'
 *    (labo Héroïne), 'vente' (vente de drogue), 'fertilisant' (récolte),
 *    'cannabis' (labo Cannabis, Gang), 'mexicana' (labo Mexicana, Organisation),
 *    'cocaine' (labo Cocaïne, Organisation), 'salvia' (Salvia, Petite Frappe).
 *  - Taxes de zone : un seul bouton "Taxe Zone" qui demande d'abord de
 *    choisir une zone, puis affiche le même formulaire que les autres types
 *    (+ téléphone). Le nom de la zone choisie EST directement stocké comme
 *    `type` de la taxe (ex. `type: 'Roxwood Village'`) — pas de colonne
 *    séparée, le regroupement par zone se fait entièrement via ce champ, qui
 *    sert aussi bien à l'affichage qu'au filtrage/recherche par type comme
 *    n'importe quel autre type.
 *
 * Contrairement à items/activités/quotas, ces types restent fixes dans le
 * code : chacun a des champs de modal hétérogènes (zone a téléphone + un
 * choix préalable de zone, les autres non) — les rendre dynamiques
 * demanderait un moteur de formulaire générique, hors du périmètre de
 * généralisation retenu pour ce projet (items, quotas, cooldowns, types de
 * braquage). Seuls le salon, le rôle d'accès et les échéances sont
 * configurables.
 *
 * **Dépendance au type d'organisation** (voir `/config type-groupe`, même
 * principe que `LABO_TIERS` dans config-store.ts) : les zones et les taxes
 * fixes n'existent PAS toutes à tous les tiers — {@link ZONES_BY_TIER}
 * et {@link TAXES_FIXES_BY_TIER} donnent, pour le tier courant, ce qui
 * est réellement proposé à la création. `vente` est la seule exception,
 * universelle (disponible à tous les tiers, y compris Indépendant qui n'a ni
 * zone ni taxe fixe). Le bouton "Taxe Zone" lui-même disparaît
 * entièrement si `ZONES_BY_TIER` est vide pour ce tier (pas de select vide).
 * Gang et Organisation partagent les mêmes 18 zones ({@link GANG_ORGA_ZONES})
 * — contrairement aux labos (`LABO_TIERS`), la répartition des zones n'est
 * pas exclusive par tier. Leurs taxes fixes, en revanche, le sont bien
 * (Cannabis pour Gang, Mexicana + Cocaïne pour Organisation) et ne suivent
 * pas forcément `LABO_TIERS` : Mexicana est produite par les deux tiers via
 * les labos, mais sa taxe reste réservée à Organisation (décision métier).
 *
 * "Rechercher une taxe"/"Supprimer une taxe" proposent les types du tier
 * courant (voir {@link currentTypesRecherche}), comme la création — une
 * Organisation ne doit pas se retrouver à chercher une taxe Spore X qu'elle
 * n'a jamais pu poser — **complétés par tout type ayant une taxe existante
 * mais sorti du barème après un changement de tier**. Sans ce complément,
 * une taxe de zone orpheline serait injoignable : contrairement aux taxes
 * fixes hors barème (qui restent gérables via les boutons Renouveler/
 * Supprimer de leur alerte d'expiration quotidienne, par ID), une taxe de
 * zone n'a **aucune** alerte automatique (voir plus bas) — sans ce
 * complément, ce serait le seul moyen de la retrouver.
 *
 * Une seule taxe active à la fois par GROUPE (nom, comparé insensible à la
 * casse) ET par type (voir `db.getActiveTaxeByTypeAndNom`, qui ignore les
 * taxes expirées — seule une taxe encore dans les temps bloque) — vérifié à
 * la soumission du formulaire (le seul moment où le nom du groupe est
 * connu ; le clic sur le bouton/la zone en amont ouvre directement le
 * formulaire, sans vérification). Chaque zone comptant comme un type à part
 * entière, ceci revient à une seule taxe active par groupe et par zone :
 * deux groupes différents peuvent chacun avoir leur taxe active sur le même
 * type/la même zone en parallèle. **Exception : `vente` n'a aucune limite**
 * — un même groupe peut cumuler plusieurs taxes Vente actives (elle se paie
 * par vente, pas par groupe).
 *
 * Toute taxe est payée par défaut à sa création ; le cron quotidien
 * `checkExpiredTaxes` alerte pour chaque taxe expirée hors zones (une seule
 * fois par expiration, via `alerte_sent`) — les taxes de zone ont un cycle de
 * renouvellement géré différemment (pas d'alerte automatique).
 */
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  type Client,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';
import type { GroupTier } from '../config-store';
import { replyAutoDelete, updateAutoDelete } from '../interaction-helpers';
import { upsertPanel } from '../permanent-message';
import { parseEntier } from '../parse';
import { isMissingAccess } from '../discord-fetch';

/** Plafond d'un nombre de jours saisi (création, renouvellement) — un an. */
const MAX_JOURS_TAXE = 365;

/** Nombre de jours saisi dans un modal, entier entre 1 et {@link MAX_JOURS_TAXE}, ou `null`. */
function parseJours(raw: string): number | null {
  const jours = parseEntier(raw, MAX_JOURS_TAXE);
  return jours && jours >= 1 ? jours : null;
}

type Taxe = NonNullable<Awaited<ReturnType<typeof db.getTaxe>>>;

/**
 * Tous les types fixes connus (hors zones) — `vente` est universelle, les
 * autres sont filtrées par tier via {@link TAXES_FIXES_BY_TIER}. Exportée
 * pour l'API (voir `src/api/routes/taxes.ts`), avec {@link ZONE_TYPE_KEYS} :
 * `type=zone` y regroupe TOUTES les zones sous un type fictif unique, plutôt
 * que de devoir filtrer une zone précise à la fois.
 */
export const FIXED_TYPES = ['sporex', 'heroine', 'vente', 'fertilisant', 'cannabis', 'mexicana', 'cocaine', 'salvia'] as const;
export type FixedType = (typeof FIXED_TYPES)[number];

/** Titre de bouton, emoji et style par type fixe — source unique pour le panneau et les modals. */
const FIXED_TYPE_META: Record<FixedType, { title: string; emoji: string; style: ButtonStyle }> = {
  sporex: { title: 'Taxe Spore X', emoji: '🧪', style: ButtonStyle.Primary },
  heroine: { title: 'Taxe Héroïne', emoji: '💉', style: ButtonStyle.Primary },
  fertilisant: { title: 'Taxe Fertilisant', emoji: '🌱', style: ButtonStyle.Primary },
  cannabis: { title: 'Taxe Cannabis', emoji: '🌿', style: ButtonStyle.Primary },
  mexicana: { title: 'Taxe Mexicana', emoji: '🌵', style: ButtonStyle.Primary },
  cocaine: { title: 'Taxe Cocaïne', emoji: '⚪', style: ButtonStyle.Primary },
  salvia: { title: 'Taxe Salvia', emoji: '🍃', style: ButtonStyle.Primary },
  vente: { title: 'Taxe Vente', emoji: '💊', style: ButtonStyle.Secondary },
};

/**
 * Taxes fixes proposées à la création, par tier — `vente` n'y figure
 * jamais (elle est universelle, voir docstring de fichier). Gang a la taxe
 * Cannabis, Organisation les taxes Mexicana + Cocaïne (même répartition que
 * LABO_TIERS dans config-store.ts pour ces drogues, mais indépendante :
 * Mexicana est produite par Gang ET Organisation via LABO_TIERS, alors que
 * sa taxe reste réservée à Organisation — décision métier, pas un miroir
 * automatique de LABO_TIERS). Petite Frappe a la taxe Salvia, réservée à ce
 * tier même si le labo Salvia (LABO_TIERS) est lui accessible à Indépendant
 * — même logique d'indépendance que Mexicana/Cocaïne ci-dessus.
 */
const TAXES_FIXES_BY_TIER: Record<GroupTier, readonly FixedType[]> = {
  independant: [],
  petite_frappe: ['sporex', 'heroine', 'fertilisant', 'salvia'],
  gang: ['cannabis'],
  organisation: ['mexicana', 'cocaine'],
};

/** Les 18 zones de vente, identiques pour Gang et Organisation (pas de découpage par tier pour ces deux-là, contrairement aux labos). */
const GANG_ORGA_ZONES: readonly string[] = [
  'Aéroport', 'Barillo Plage', 'Cayo Perico', "Champ d'éolienne", 'Del Perro', 'Eclypse Tower',
  'Fête Foraine', 'Grapeseed', 'Mirror Park', 'New Cayo Perico', 'Paleto', 'Roxwood Est',
  'Roxwood Ouest', 'Sandy Shores', 'Terrain de cross', 'Vespucci', 'Vinewood', 'Wardog',
];

/** Zones taxables par tier — Indépendant n'en a aucune ; Gang et Organisation partagent les mêmes 18 zones (voir {@link GANG_ORGA_ZONES}). Chaque liste est tenue par ordre alphabétique : c'est l'ordre d'affichage (boutons Discord, référentiel de l'API). */
const ZONES_BY_TIER: Record<GroupTier, readonly string[]> = {
  independant: [],
  petite_frappe: [
    'Carson', 'Cinéma', 'Docks', 'Grapeseed Valley', 'Hawick', 'Mirror Park', 'Paleto',
    'Pétrolière', 'Plage Cayo', 'Ponton', 'Richman', 'Roxwood Sud', 'Roxwood Village', 'S-Mart',
  ],
  gang: GANG_ORGA_ZONES,
  organisation: GANG_ORGA_ZONES,
};

/** Toutes les zones, tous tiers confondus (dédupliquées — Gang et Organisation partagent {@link GANG_ORGA_ZONES}) — sert à résoudre le libellé d'une zone même si elle est sortie du barème du tier courant (voir docstring de fichier). */
const ALL_ZONES: readonly string[] = [...new Set(Object.values(ZONES_BY_TIER).flat())];

/** Zones proposées à la création pour le tier actuellement configuré. */
function currentZones(guildId: string): readonly string[] {
  return ZONES_BY_TIER[configStore.get(guildId).TYPE_GROUPE];
}

/** Taxes fixes proposées à la création pour le tier actuellement configuré. */
function currentTaxesFixes(guildId: string): readonly FixedType[] {
  return TAXES_FIXES_BY_TIER[configStore.get(guildId).TYPE_GROUPE];
}

/**
 * Convertit un libellé de zone en clé stable (minuscules, accents retirés,
 * espaces → underscores). C'est cette clé, pas le libellé, qui est stockée
 * comme `type` de la taxe.
 */
function slugifyZone(zone: string): string {
  return zone.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '_');
}

/** Clé de zone → libellé affiché, pour toutes les zones connues (tous tiers). */
const ZONE_BY_KEY = new Map<string, string>(ALL_ZONES.map(zone => [slugifyZone(zone), zone]));

/** Toutes les clés de zone connues (tous tiers) — voir {@link FIXED_TYPES}, le "type fictif" `zone` de l'API s'y résout. */
export const ZONE_TYPE_KEYS: readonly string[] = [...ZONE_BY_KEY.keys()];

/**
 * Référentiel taxes pour le site externe (`GET /api/taxes/types`) : le tier
 * courant, TOUS les types fixes et TOUTES les zones connues (pas seulement
 * ceux du tier courant — un type/une zone sorti du barème après un
 * changement de tier doit rester nommable pour une taxe orpheline existante,
 * même logique que {@link currentTypesRecherche}), chacun avec `available`
 * indiquant s'il est proposé à la création pour le tier ACTUEL. `vente` est
 * toujours `available: true` (universelle, voir docstring de fichier).
 */
export function getTaxesReferentiel(guildId: string): {
  tier: { key: GroupTier; label: string };
  fixed: Array<{ key: FixedType; label: string; available: boolean }>;
  zones: Array<{ key: string; label: string; available: boolean }>;
} {
  const tierKey = configStore.get(guildId).TYPE_GROUPE;
  const tierLabel = configStore.GROUP_TIERS.find(t => t.key === tierKey)?.label ?? tierKey;
  const fixesActuelles = new Set<FixedType>(currentTaxesFixes(guildId));
  const zonesActuelles = new Set<string>(currentZones(guildId));

  return {
    tier: { key: tierKey, label: tierLabel },
    fixed: FIXED_TYPES.map(key => ({
      key,
      label: FIXED_TYPE_META[key].title.replace(/^Taxe /, ''),
      available: key === 'vente' || fixesActuelles.has(key),
    })),
    zones: ALL_ZONES.map(zone => ({
      key: slugifyZone(zone),
      label: zone,
      available: zonesActuelles.has(zone),
    })),
  };
}

/**
 * Types proposés dans les select menus "Rechercher"/"Supprimer une taxe" :
 * le barème du tier courant, complété par tout type ayant une taxe active
 * en base mais sorti de ce barème (voir docstring de fichier — sinon une
 * taxe de zone orpheline par un changement de tier deviendrait injoignable).
 * Capé à 25 (limite Discord d'un select) ; le tier courant prime toujours
 * sur les types orphelins en cas de dépassement (peu probable en pratique).
 */
async function currentTypesRecherche(guildId: string): Promise<string[]> {
  const types = new Set(['vente', ...currentTaxesFixes(guildId), ...currentZones(guildId).map(slugifyZone)]);
  for (const taxe of await db.getAllTaxes(guildId)) types.add(taxe.type);

  const all = [...types];
  if (all.length > 25) {
    console.warn(`[taxes] ${all.length - 25} type(s) en trop dans le select Rechercher/Supprimer (limite Discord) — des taxes orphelines resteront injoignables depuis ce menu.`);
  }
  return all.slice(0, 25);
}

/** Vrai si `type` est une clé de zone (voir ZONE_BY_KEY), par opposition à un type fixe (sporex/heroine/vente/fertilisant). */
export function isZoneType(type: string): boolean {
  return ZONE_BY_KEY.has(type);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Formate un timestamp (ms) en date courte française (JJ/MM/AAAA), en heure de Paris — sans ça, un VPS en UTC afficherait une échéance de taxe décalée d'1-2h (voire un jour différent près de minuit). */
function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Paris' });
}

/** Formate un timestamp (ms) en date + heure françaises, en heure de Paris (voir `formatDate`). */
function formatDateFull(ts: number): string {
  return new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
}

/** Vrai si l'échéance (ms) est passée. */
function isExpired(echeance: number): boolean {
  return echeance <= Date.now();
}

/** Libellé affiché pour un type — résout les clés de zone via ZONE_BY_KEY. */
function typeLabel(type: string): string {
  if (type in FIXED_TYPE_META) return FIXED_TYPE_META[type as FixedType].title.replace(/^Taxe /, '');
  return ZONE_BY_KEY.get(type) ?? type;
}

// ─── EMBED TAXE ───────────────────────────────────────────────────────────────

/** Embed de détail d'une taxe : type, statut, échéance, paiement, et téléphone/mot de passe si présents. */
function buildTaxeEmbed(taxe: Taxe): EmbedBuilder {
  const expired = isExpired(taxe.echeance);
  const embed = new EmbedBuilder()
    .setTitle(`📋 Taxe — ${taxe.nom}`)
    .setColor(expired ? 0xED4245 : 0x57F287)
    .addFields(
      { name: 'Type', value: typeLabel(taxe.type), inline: true },
      { name: 'Statut', value: expired ? '🔴 Expirée' : '🟢 Active', inline: true },
      { name: 'Échéance', value: formatDateFull(taxe.echeance), inline: true },
    );

  embed.addFields({ name: 'Paiement', value: taxe.paye ? '✅ Payée' : '❌ Non payée', inline: true });

  if (taxe.telephone) embed.addFields({ name: 'Téléphone', value: taxe.telephone, inline: true });
  if (taxe.motDePasse) embed.addFields({ name: 'Mot de passe', value: `\`${taxe.motDePasse}\``, inline: true });

  return embed;
}

/** Bouton bascule payée/non payée pour une taxe. */
function buildPayeToggleRow(taxe: Taxe): ActionRowBuilder<ButtonBuilder> {
  // L'état visé est encodé dans le bouton : deux clics sur un message pas
  // encore rafraîchi posent deux fois le même état au lieu de s'annuler.
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tax_toggle_paye_${taxe.id}_${taxe.paye ? 0 : 1}`)
      .setLabel(taxe.paye ? 'Marquer Non payée' : 'Marquer Payée')
      .setStyle(taxe.paye ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setEmoji(taxe.paye ? '❌' : '✅'),
  );
}

/** Boutons Renouveler/Supprimer, affichés sur l'alerte d'expiration et le résultat d'une recherche. */
function buildAlertButtons(taxeId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`tax_renew_${taxeId}`).setLabel('Renouveler').setStyle(ButtonStyle.Success).setEmoji('🔄'),
    new ButtonBuilder().setCustomId(`tax_delete_${taxeId}`).setLabel('Supprimer').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
  );
}

// ─── MESSAGE PERMANENT ────────────────────────────────────────────────────────

const TAXES_PANEL_TITLE = '💰 Gestion des Taxes & Rackets';

/** Discord limite à 5 ActionRows par message — la 5e est toujours réservée à la rangée Rechercher/Supprimer (voir `initPermanentMessage`), donc 4 rangées de 5 boutons max ici. */
const MAX_CREATION_BUTTONS = 20;

/**
 * Boutons de création proposés pour le tier courant : Taxe Vente (toujours,
 * en premier — voir plus bas pourquoi), puis Taxe Zone (seulement si ce
 * tier a au moins une zone), puis les taxes fixes de ce tier. Chunké par 5
 * (limite Discord par `ActionRow`).
 */
function buildCreationButtonRows(guildId: string): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];

  // Vente est poussée en premier, pas en dernier : en cas de dépassement de
  // MAX_CREATION_BUTTONS (voir le console.warn plus bas), la troncature
  // coupe la fin du tableau — Vente, seule taxe universelle à tous les
  // tiers, ne doit jamais être le bouton sacrifié.
  const venteMeta = FIXED_TYPE_META.vente;
  buttons.push(new ButtonBuilder().setCustomId('tax_vente').setLabel(venteMeta.title).setStyle(venteMeta.style).setEmoji(venteMeta.emoji));

  if (currentZones(guildId).length) {
    buttons.push(new ButtonBuilder().setCustomId('tax_zone').setLabel('Taxe Zone').setStyle(ButtonStyle.Primary).setEmoji('🏘️'));
  }
  for (const type of currentTaxesFixes(guildId)) {
    const meta = FIXED_TYPE_META[type];
    buttons.push(new ButtonBuilder().setCustomId(`tax_${type}`).setLabel(meta.title).setStyle(meta.style).setEmoji(meta.emoji));
  }

  if (buttons.length > MAX_CREATION_BUTTONS) {
    console.warn(`[taxes] ${buttons.length - MAX_CREATION_BUTTONS} bouton(s) de création en trop pour le tier courant (limite Discord) — voir ZONES_BY_TIER/TAXES_FIXES_BY_TIER dans taxes.ts.`);
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < Math.min(buttons.length, MAX_CREATION_BUTTONS); i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

/** Édite le message permanent de gestion des taxes (ou le crée s'il n'existe pas encore/plus). */
export async function initPermanentMessage(client: Client, guildId: string): Promise<void> {
  const channelId = configStore.get(guildId).CHANNELS.taxes;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return;

    const tier = configStore.get(guildId).TYPE_GROUPE;
    const tierLabel = configStore.GROUP_TIERS.find(t => t.key === tier)?.label ?? tier;
    const taxesFixesLabels = currentTaxesFixes(guildId).map(type => FIXED_TYPE_META[type].title);
    const zones = currentZones(guildId);

    const embed = new EmbedBuilder()
      .setTitle(TAXES_PANEL_TITLE)
      .setColor(0xFEE75C)
      .setDescription(
        'Utilisez les boutons ci-dessous pour enregistrer une taxe.\n\n' +
        `Type d'organisation actuel : **${tierLabel}** (voir \`/config type-groupe\`)\n` +
        `Taxes fixes disponibles : ${taxesFixesLabels.length ? taxesFixesLabels.join(', ') : '_aucune_'}\n` +
        `Zones disponibles : ${zones.length ? zones.join(', ') : '_aucune_'}`,
      );

    const searchRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('tax_rechercher').setLabel('Rechercher une taxe').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
      new ButtonBuilder().setCustomId('tax_supprimer').setLabel('Supprimer une taxe').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    );

    const components = [...buildCreationButtonRows(guildId), searchRow];

    await upsertPanel(channel, guildId, 'taxes_message_id', TAXES_PANEL_TITLE, async () => ({ embeds: [embed], components }));
  } catch (err) {
    console.error(`[taxes] initPermanentMessage(${guildId}):`, (err as Error).message);
  }
}

/** Conservation d'une taxe supprimée avant purge : plus rien ne la lit, ni le module Discord ni l'API. */
const TAXE_SUPPRIMEE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Cron quotidien : purge les taxes supprimées dont l'échéance date de plus de 30 jours. */
export async function purgeOldDeletedTaxes(guildId: string): Promise<void> {
  const count = await db.deleteOldInactiveTaxes(guildId, Date.now() - TAXE_SUPPRIMEE_RETENTION_MS);
  if (count > 0) console.log(`[taxes] Purge (${guildId}) : ${count} taxe(s) supprimée(s) de plus de 30 jours.`);
}

// ─── CHECK TAXES EXPIRÉES ─────────────────────────────────────────────────────

/** Cron quotidien (10h Europe/Paris) : alerte pour chaque taxe expirée hors zones, une seule fois par expiration (`alerteSent`). */
export async function checkExpiredTaxes(client: Client, guildId: string): Promise<void> {
  const channelId = configStore.get(guildId).CHANNELS.alertes_taxes;
  if (!channelId) return;
  try {
    const expired = await db.getExpiredTaxes(guildId, ALL_ZONES.map(slugifyZone));
    if (!expired.length) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return;

    for (const taxe of expired) {
      if (taxe.alerteSent) continue;

      const embed = new EmbedBuilder()
        .setTitle('⚠️ Taxe arrivant à échéance')
        .setColor(0xED4245)
        .setDescription(`La taxe **${taxe.nom}** (${typeLabel(taxe.type)}) est expirée !`)
        .addFields({ name: 'Échéance', value: formatDateFull(taxe.echeance), inline: true })
        .setTimestamp();

      // Marquée envoyée seulement si l'envoi a réussi : sinon le prochain passage la retente.
      try {
        await channel.send({ embeds: [embed], components: [buildAlertButtons(taxe.id)], allowedMentions: { parse: [] } });
      } catch (err) {
        if (isMissingAccess(err)) {
          console.warn(`[taxes] Permission manquante dans alertes_taxes (${guildId}) — alertes suspendues jusqu'au prochain passage.`);
          return;
        }
        continue;
      }
      await db.markTaxeAlerteSent(guildId, taxe.id);
    }
  } catch (err) {
    console.error(`[taxes] checkExpiredTaxes(${guildId}):`, (err as Error).message);
  }
}

/** Aucune commande slash dédiée — tout passe par le message permanent (boutons/modals/selects). */
export function getCommands() {
  return [];
}

// ─── HANDLER BOUTONS ─────────────────────────────────────────────────────────

/** Modal de création d'une taxe (fixe ou de zone), avec le champ téléphone en plus pour les zones. */
function buildCreationModal(type: string): ModalBuilder {
  const title = isZoneType(type) ? `Taxe — ${ZONE_BY_KEY.get(type)}` : FIXED_TYPE_META[type as FixedType].title;
  const rows = [
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('nom').setLabel('Nom du groupe').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50),
    ),
  ];
  if (isZoneType(type)) {
    rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('telephone').setLabel('Téléphone').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20),
    ));
  }
  rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId('jours').setLabel('Jours avant échéance').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4),
  ));
  rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId('mot_de_passe').setLabel('Mot de passe').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50),
  ));

  return new ModalBuilder().setCustomId(`modal_tax_create_${type}`).setTitle(title.slice(0, 45)).addComponents(...rows);
}

/** Route les clics de bouton du message permanent et des alertes (`tax_*`) : création, renouvellement, recherche, suppression, bascule payée. */
export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId;
  const guildId = interaction.guildId!;

  if (id.startsWith('tax_') && (FIXED_TYPES as readonly string[]).includes(id.replace('tax_', ''))
      && !['tax_zone', 'tax_renew_', 'tax_rechercher', 'tax_supprimer', 'tax_toggle_paye_', 'tax_delete_'].some(p => id.startsWith(p))) {
    const type = id.replace('tax_', '') as FixedType;
    // Filet de sécurité : un bouton resté affiché sur un panneau pas encore
    // rafraîchi après un changement de tier ne doit pas permettre de créer
    // une taxe hors barème (même principe que `enabled` dans quotas.ts).
    if (!isTypeDisponible(guildId, type)) {
      return replyAutoDelete(interaction, `❌ **${typeLabel(type)}** n'est pas disponible pour le type d'organisation actuel.`);
    }
    // Le nom du groupe (donc l'unicité par groupe+type) n'est connu qu'à la
    // soumission du formulaire — voir `handleCreationModal`.
    return interaction.showModal(buildCreationModal(type));
  }

  if (id === 'tax_zone') {
    const zones = currentZones(guildId);
    if (!zones.length) return replyAutoDelete(interaction, "❌ Aucune zone disponible pour le type d'organisation actuel.");

    const select = new StringSelectMenuBuilder()
      .setCustomId('tax_select_zone_create')
      .setPlaceholder('Quelle zone ?')
      .addOptions(zones.map(zone => ({ label: zone, value: slugifyZone(zone) })));

    return replyAutoDelete(interaction, {
      content: '🏘️ Pour quelle zone ?',
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    }, { deleteAfterMs: 60_000 });
  }

  if (id.startsWith('tax_renew_')) {
    const taxeId = parseInt(id.replace('tax_renew_', ''), 10);
    const taxe = await db.getTaxe(guildId, taxeId);
    if (!taxe) return replyAutoDelete(interaction, '❌ Taxe introuvable.');

    const modal = new ModalBuilder()
      .setCustomId(`modal_tax_renew_${taxeId}`)
      .setTitle(`Renouveler : ${taxe.nom}`.slice(0, 45))
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('jours').setLabel('Ajouter combien de jours ?').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4),
      ));
    return interaction.showModal(modal);
  }

  if (id === 'tax_rechercher' || id === 'tax_supprimer') {
    // Select direct, sans modal de recherche préalable : currentTypesRecherche()
    // reste sous la limite Discord de 25 options dans tous les cas réels.
    const action = id === 'tax_rechercher' ? 'rechercher' : 'supprimer';
    const select = new StringSelectMenuBuilder()
      .setCustomId(`tax_select_${action}_type`)
      .setPlaceholder(action === 'rechercher' ? 'Quel type de taxe ?' : 'Quel type de taxe supprimer ?')
      .addOptions((await currentTypesRecherche(guildId)).map(type => ({ label: typeLabel(type), value: type })));

    return replyAutoDelete(interaction, {
      content: action === 'rechercher' ? '🔍 Quel type de taxe veux-tu rechercher ?' : '🗑️ Quel type de taxe veux-tu supprimer ?',
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    }, { deleteAfterMs: 60_000 });
  }

  if (id.startsWith('tax_toggle_paye_')) {
    const [rawId, rawCible] = id.replace('tax_toggle_paye_', '').split('_');
    const taxeId = parseInt(rawId, 10);
    const taxe = await db.getTaxe(guildId, taxeId);
    if (!taxe) return replyAutoDelete(interaction, '❌ Taxe introuvable.');

    await db.setTaxePaye(guildId, taxeId, rawCible === undefined ? !taxe.paye : rawCible === '1');
    const updated = (await db.getTaxe(guildId, taxeId))!;
    const components = [buildPayeToggleRow(updated), buildAlertButtons(updated.id)];

    await interaction.update({ embeds: [buildTaxeEmbed(updated)], components });
    return;
  }

  if (id.startsWith('tax_delete_')) {
    const taxeId = parseInt(id.replace('tax_delete_', ''), 10);
    const taxe = await db.getTaxe(guildId, taxeId);
    if (!taxe) return replyAutoDelete(interaction, '❌ Taxe introuvable.');

    await db.deleteTaxe(guildId, taxeId);
    const content = `🗑️ Taxe **${taxe.nom}** supprimée.`;
    await interaction.update({ content, embeds: [], components: [], allowedMentions: { parse: [] } })
      .catch(async () => { await replyAutoDelete(interaction, { content, allowedMentions: { parse: [] } }); });
  }
}

// ─── HANDLER MODALS ───────────────────────────────────────────────────────────

/** Vrai si `type` (type fixe ou clé de zone) peut être créé pour le tier actuel. */
function isTypeDisponible(guildId: string, type: string): boolean {
  if (type === 'vente') return true;
  if (isZoneType(type)) return currentZones(guildId).some(zone => slugifyZone(zone) === type);
  return (currentTaxesFixes(guildId) as readonly string[]).includes(type);
}

/**
 * Traite la soumission du modal de création (`modal_tax_create_<type>`). Le
 * type est revérifié contre le tier actuel (il a pu changer pendant que le
 * modal était ouvert) ; l'absence de taxe active pour CE GROUPE sur ce type
 * (sauf `vente`, sans limite) est vérifiée dans la même transaction que
 * l'insertion (voir `db.addTaxeIfFree`).
 */
async function handleCreationModal(interaction: ModalSubmitInteraction, guildId: string, type: string): Promise<void> {
  if (!isTypeDisponible(guildId, type)) {
    return replyAutoDelete(interaction, `❌ **${typeLabel(type)}** n'est pas disponible pour le type d'organisation actuel.`);
  }

  const nom = interaction.fields.getTextInputValue('nom').trim();
  const jours = parseJours(interaction.fields.getTextInputValue('jours'));
  const mdp = interaction.fields.getTextInputValue('mot_de_passe').trim();
  let tel = '';
  try { tel = interaction.fields.getTextInputValue('telephone').trim(); } catch { /* absent hors zone */ }

  if (jours == null) return replyAutoDelete(interaction, `❌ Nombre de jours invalide (entier entre 1 et ${MAX_JOURS_TAXE}).`);

  const echeance = Date.now() + jours * 24 * 60 * 60 * 1000;
  // La taxe Vente se paie par vente, pas par groupe : un même groupe peut en
  // cumuler plusieurs actives, pas de vérification pour ce type.
  const taxeId = await db.addTaxeIfFree(guildId, { nom, type, telephone: tel || null, echeance, mot_de_passe: mdp || null }, type !== 'vente');
  if (taxeId == null) {
    const existing = await db.getActiveTaxeByTypeAndNom(guildId, type, nom);
    const expire = existing ? ` (expire le ${formatDate(existing.echeance)})` : '';
    return replyAutoDelete(interaction, {
      content: `🚫 **${existing?.nom ?? nom}** a déjà une taxe ${typeLabel(type)} active${expire}. Renouvelle-la plutôt que d'en créer une nouvelle, ou supprime-la d'abord.`,
      allowedMentions: { parse: [] },
    });
  }

  return replyAutoDelete(interaction, {
    content: `✅ Taxe ${typeLabel(type)} **${nom}** enregistrée — échéance le **${formatDate(echeance)}**.`,
    allowedMentions: { parse: [] },
  });
}

/** Route les soumissions de modal (`modal_tax_*`) : création, renouvellement, recherche. */
export async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const id = interaction.customId;
  const guildId = interaction.guildId!;

  if (id.startsWith('modal_tax_create_')) {
    return handleCreationModal(interaction, guildId, id.slice('modal_tax_create_'.length));
  }

  if (id.startsWith('modal_tax_renew_')) {
    const taxeId = parseInt(id.replace('modal_tax_renew_', ''), 10);
    const jours = parseJours(interaction.fields.getTextInputValue('jours'));
    if (jours == null) return replyAutoDelete(interaction, `❌ Nombre de jours invalide (entier entre 1 et ${MAX_JOURS_TAXE}).`);

    const taxe = await db.getTaxe(guildId, taxeId);
    if (!taxe) return replyAutoDelete(interaction, '❌ Taxe introuvable.');

    // Une zone se paie d'avance : renouvelée = payée ; les autres repartent
    // "non payée". Renouveler une taxe expirée la réactive : refusé si le même
    // groupe en a entre-temps une autre active sur ce type (même règle qu'à la
    // création, vérifiée dans la transaction de `db.renewTaxe`).
    const newDate = await db.renewTaxe(guildId, taxeId, jours, isZoneType(taxe.type), taxe.type !== 'vente');
    if (newDate == null) return replyAutoDelete(interaction, '❌ Taxe introuvable.');
    if (typeof newDate !== 'number') {
      return replyAutoDelete(interaction, {
        content: `🚫 **${newDate.conflit.nom}** a déjà une autre taxe ${typeLabel(taxe.type)} active (expire le ${formatDate(newDate.conflit.echeance)}) — renouvelle plutôt celle-ci.`,
        allowedMentions: { parse: [] },
      });
    }

    return replyAutoDelete(interaction, `✅ Taxe renouvelée jusqu'au **${formatDate(newDate)}**.`);
  }

  if (id.startsWith('modal_tax_recherche_') || id.startsWith('modal_tax_supprimer_recherche_')) {
    const forSuppression = id.startsWith('modal_tax_supprimer_recherche_');
    const type = id.replace(forSuppression ? 'modal_tax_supprimer_recherche_' : 'modal_tax_recherche_', '');
    const query = interaction.fields.getTextInputValue('recherche').trim().toLowerCase();

    const matches = (await db.getAllTaxes(guildId))
      .filter(t => t.type === type)
      .filter(t => !query || t.nom.toLowerCase().includes(query));

    if (!matches.length) {
      return replyAutoDelete(interaction, { content: `❌ Aucune taxe ${typeLabel(type)} ne correspond à « ${query || '(tout)'} ».`, allowedMentions: { parse: [] } });
    }

    const options = matches.slice(0, 25).map(t => ({
      label: t.nom.slice(0, 100),
      description: `${isExpired(t.echeance) ? '🔴 Expirée' : '🟢 Active'} — expire le ${formatDate(t.echeance)}`,
      value: String(t.id),
    }));

    const select = new StringSelectMenuBuilder()
      .setCustomId(forSuppression ? 'tax_select_supprimer_resultat' : 'tax_select_recherche_resultat')
      .setPlaceholder(forSuppression ? 'Choisir une taxe à supprimer…' : 'Choisir une taxe…')
      .addOptions(options);

    const baseMsg = forSuppression ? '🗑️ Quelle taxe supprimer ?' : '🔍 Quelle taxe ?';
    const content = matches.length > 25
      ? `⚠️ ${matches.length} résultats, seuls les 25 premiers sont affichés — affine ta recherche.\n${baseMsg}`
      : baseMsg;

    return replyAutoDelete(interaction, {
      content,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    }, { deleteAfterMs: 60_000 });
  }
}

// ─── HANDLER SELECT MENUS ─────────────────────────────────────────────────────

/** Route les sélections de menu (`tax_select_*`) : choix de zone, résultat de recherche/suppression, choix de type. */
export async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId!;

  if (interaction.customId === 'tax_select_zone_create') {
    const zoneKey = interaction.values[0];
    // Le nom du groupe (donc l'unicité par groupe+zone) n'est connu qu'à la
    // soumission du formulaire — voir `handleCreationModal`.
    return interaction.showModal(buildCreationModal(zoneKey));
  }

  if (interaction.customId === 'tax_select_supprimer_resultat') {
    const taxeId = parseInt(interaction.values[0], 10);
    const taxe = await db.getTaxe(guildId, taxeId);
    if (!taxe) return updateAutoDelete(interaction, { content: '❌ Taxe introuvable.', components: [] });
    await db.deleteTaxe(guildId, taxeId);
    return updateAutoDelete(interaction, { content: `🗑️ Taxe **${taxe.nom}** (${typeLabel(taxe.type)}) supprimée.`, components: [] });
  }

  if (interaction.customId === 'tax_select_supprimer_type' || interaction.customId === 'tax_select_rechercher_type') {
    const forSuppression = interaction.customId === 'tax_select_supprimer_type';
    const type = interaction.values[0];
    if (!(await currentTypesRecherche(guildId)).includes(type)) return updateAutoDelete(interaction, { content: '❌ Type invalide.', components: [] });

    const modal = new ModalBuilder()
      .setCustomId(`${forSuppression ? 'modal_tax_supprimer_recherche_' : 'modal_tax_recherche_'}${type}`)
      .setTitle(`${forSuppression ? 'Supprimer' : 'Rechercher'} : ${typeLabel(type)}`.slice(0, 45))
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('recherche').setLabel('Nom du groupe (vide = tout afficher)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50),
      ));
    return interaction.showModal(modal);
  }

  if (interaction.customId === 'tax_select_recherche_resultat') {
    const taxeId = parseInt(interaction.values[0], 10);
    const taxe = await db.getTaxe(guildId, taxeId);
    if (!taxe) return updateAutoDelete(interaction, { content: '❌ Taxe introuvable.', components: [] });
    return updateAutoDelete(interaction, {
      content: null,
      embeds: [buildTaxeEmbed(taxe)],
      components: [buildPayeToggleRow(taxe), buildAlertButtons(taxe.id)],
    });
  }
}
