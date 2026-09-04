/**
 * @file src/modules/quotas.ts
 * @description Panneau d'activités déclarables + quotas hebdomadaires.
 *
 * Contrairement à la source dont ce projet s'inspire (registre `ACTIONS` figé
 * dans le code), toutes les activités déclarables — leur libellé, catégorie de
 * quota, cooldown personnel, limite de braquage partagée, mode "labo", champ
 * quantité — viennent de `configStore.get().ACTIVITY_TYPES` (piloté par
 * `/config activite`, voir src/modules/config.ts). Les boutons du panneau, les
 * champs de quota, le détail par activité et le bilan hebdomadaire sont donc
 * générés dynamiquement à partir de ce registre : ajouter une activité ne
 * demande aucune modification de code.
 *
 * Règle d'agrégation des quotas : un joueur progresse dans la catégorie de
 * quota `quotaType` d'une activité pour chaque déclaration de cette activité —
 * c'est `/config activite add --quota_type` qui décide entièrement quelles
 * activités comptent dans quelle catégorie (pas de règle cachée dans le code).
 *
 * Une catégorie de quota n'apparaît dans AUCUN affichage (panneau perso,
 * `/listquota`, paie hebdomadaire) tant qu'elle n'a pas d'objectif défini via
 * `/config quota set <quota_type> <valeur>` — une activité rattachée à une
 * catégorie sans objectif compte quand même dans le détail par activité, mais
 * la catégorie elle-même reste invisible tant qu'elle n'est pas "paramétrée".
 *
 * Exception documentée : le rappel du dimanche (`checkQuotaReminder`) reste
 * spécifique à la catégorie de quota `vente`, parce qu'il est couplé au cycle
 * de vente de drogue (modules/ventes.ts) — un rappel générique par catégorie
 * n'aurait pas de règle non-arbitraire pour choisir QUELLE catégorie rappeler.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type Client,
  type Message,
  type GuildMember,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type UserSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type RepliableInteraction,
  type InteractionReplyOptions,
} from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';
import type { ActivityTypeConfig } from '../config-store';
import * as alertes from './alertes';
import * as garages from './garages';
import { isAdmin } from '../permissions';

const pendingLaboParticipants = new Map<string, string[]>();

function createLaboParticipantToken(partnerIds: string[]): string {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  pendingLaboParticipants.set(token, partnerIds);
  setTimeout(() => pendingLaboParticipants.delete(token), 5 * 60 * 1000);
  return token;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function formatTime(ms: number): string {
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return [d && `${d}j`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ') || '0s';
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Résumé de quota d'un joueur : une somme par catégorie de quota (dérivée de
 * `ACTIVITY_TYPES[*].quotaType`), plus la carte brute de toutes ses stats.
 */
async function getUserQuotaSummary(userId: string): Promise<{ byQuotaType: Record<string, number>; map: Record<string, { count: number; points: number }> }> {
  const map = await db.getUserStatMap(userId);
  const activityTypes = configStore.get().ACTIVITY_TYPES;
  const byQuotaType: Record<string, number> = {};
  for (const [key, cfg] of Object.entries(activityTypes)) {
    if (!cfg.quotaType) continue;
    byQuotaType[cfg.quotaType] = (byQuotaType[cfg.quotaType] ?? 0) + (map[key]?.count || 0);
  }
  return { byQuotaType, map };
}

// ─── AUTO-DELETE HELPERS ──────────────────────────────────────────────────────

async function replyAutoDelete(
  interaction: RepliableInteraction,
  payload: string | InteractionReplyOptions,
  options: { deleteAfterMs?: number } = {},
): Promise<void> {
  const p: InteractionReplyOptions = typeof payload === 'string' ? { content: payload } : payload;
  const { resource } = await interaction.reply({ ...p, withResponse: true });
  const message = resource?.message;

  if (!p.components?.length) message?.react('🗑️').catch(() => null);

  if (options.deleteAfterMs && options.deleteAfterMs > 0 && message) {
    setTimeout(() => { message.delete().catch(() => null); }, options.deleteAfterMs);
  }
}

async function updateAutoDelete(interaction: UserSelectMenuInteraction, payload: string | { content: string; components: unknown[] }): Promise<void> {
  const p = typeof payload === 'string' ? { content: payload } : payload;
  // @ts-expect-error components typing narrowed loosely on purpose (kept minimal, mirrors payload shape used at call sites)
  await interaction.update(p);
}

// ─── EMBEDS ───────────────────────────────────────────────────────────────────

/** Embed principal du panneau : disponibilité en temps réel des slots de braquage. */
async function buildMainEmbed(): Promise<EmbedBuilder> {
  const activityTypes = configStore.get().ACTIVITY_TYPES;
  const braquageEntries = Object.entries(activityTypes)
    .filter(([, cfg]) => cfg.braquageWeeklyLimit)
    .sort((a, b) => a[1].displayOrder - b[1].displayOrder);

  const slotLines = await Promise.all(braquageEntries.map(async ([key, cfg]) => {
    const used = await db.getBraquageCount(key);
    const dispo = Math.max(0, cfg.braquageWeeklyLimit! - used);
    const icon = dispo > 0 ? '🟢' : '🔴';
    return `${icon} ${cfg.label} : **${dispo}/${cfg.braquageWeeklyLimit}**`;
  }));

  const embed = new EmbedBuilder()
    .setTitle('🎮 Gestion des Activités')
    .setColor(0x5865F2)
    .setDescription(
      'Enregistre tes activités de la semaine en cliquant sur les boutons ci-dessous.\n' +
      'Les quotas sont remis à zéro chaque **dimanche à 19h00**.',
    )
    .setTimestamp()
    .setFooter({ text: 'Dernière interaction' });

  if (slotLines.length) {
    embed.addFields({ name: '🔫 Slots braquages disponibles (7 jours glissants)', value: slotLines.join('\n') });
  }
  return embed;
}

/**
 * Embed de quota personnel d'un membre : une ligne par catégorie de quota
 * — uniquement celles ayant un objectif configuré via `/config quota set`.
 * Une catégorie utilisée par une activité (`quota_type`) mais sans objectif
 * défini n'apparaît nulle part dans les affichages de quota (voir docstring
 * de fichier).
 */
async function buildQuotaEmbed(userId: string, member: GuildMember | null): Promise<EmbedBuilder> {
  const { byQuotaType, map } = await getUserQuotaSummary(userId);
  const activityTypes = configStore.get().ACTIVITY_TYPES;
  const targets = configStore.get().QUOTA_TARGETS;

  const quotaFields = Object.keys(targets).sort().map(qt => ({
    name: `📌 ${capitalize(qt)}`,
    value: `${byQuotaType[qt] ?? 0}/${targets[qt]}`,
    inline: true,
  }));

  const detail = Object.entries(activityTypes)
    .sort((a, b) => a[1].displayOrder - b[1].displayOrder)
    .map(([key, cfg]) => [cfg.label, map[key]?.count || 0] as const)
    .filter(([, v]) => v > 0)
    .map(([label, v]) => `• ${label}: **${v}**`)
    .join('\n') || '*Aucune activité*';

  const embed = new EmbedBuilder()
    .setTitle(`📊 Quotas — ${member?.displayName || userId}`)
    .setColor(0x5865F2);
  if (quotaFields.length) embed.addFields(...quotaFields);
  embed.addFields({ name: '📋 Détail', value: detail });
  return embed;
}

/** Embed de paie personnelle : salaire = ventes × SALAIRE_PAR_VENTE. */
async function buildPayEmbed(userId: string, member: GuildMember | null): Promise<EmbedBuilder> {
  const c = configStore.get();
  const vente = (await db.getUserStatMap(userId))['vente']?.count || 0;
  const salaire = Math.round(vente * c.SALAIRE_PAR_VENTE);
  const allTotals = await db.getAllUserActionTotals('vente');
  const rank = allTotals.findIndex(u => u.user_id === userId) + 1;

  return new EmbedBuilder()
    .setTitle(`💰 Ma Paie — ${member?.displayName || userId}`)
    .setColor(0xFEE75C)
    .addFields(
      { name: '💊 Vente (unités)', value: vente.toLocaleString('fr-FR'), inline: true },
      { name: '💵 Salaire', value: `${salaire.toLocaleString('fr-FR')} $`, inline: true },
      { name: '🏆 Classement', value: rank ? `#${rank}` : 'N/A', inline: true },
    );
}

/** Embed du classement de groupe trié par volume de ventes. */
async function buildClassementEmbed(client: Client): Promise<EmbedBuilder> {
  const allTotals = await db.getAllUserActionTotals('vente');
  const lines: string[] = [];

  for (let i = 0; i < allTotals.length; i++) {
    const u = allTotals[i];
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const member = await client.guilds.cache.first()?.members.fetch(u.user_id).catch(() => null);
    const name = member?.displayName || `<@${u.user_id}>`;
    lines.push(`${medal} ${name} — **${u.total.toLocaleString('fr-FR')}** unités vendues`);
  }

  return new EmbedBuilder()
    .setTitle('🏆 Classement du Groupe')
    .setColor(0xFEE75C)
    .setDescription(lines.length ? lines.join('\n') : '*Aucune donnée*')
    .setTimestamp();
}

/** Embed de bilan collectif : agrège toutes les activités de tous les membres depuis `sinceTs`. */
async function buildBilanEmbed(sinceTs?: number): Promise<EmbedBuilder> {
  const since = sinceTs ?? Number((await db.getSetting(LAST_RESET_KEY)) || 0);
  const activityTypes = configStore.get().ACTIVITY_TYPES;
  const quantityKeys = Object.entries(activityTypes).filter(([, c]) => c.quantity).map(([k]) => k);
  const totals = await db.getGroupActionTotals(since, quantityKeys);
  const map: Record<string, number> = {};
  for (const row of totals) map[row.action] = row.total;

  const lines = Object.entries(activityTypes)
    .sort((a, b) => a[1].displayOrder - b[1].displayOrder)
    .map(([key, cfg]) => {
      const total = map[key] || 0;
      const value = cfg.quantity ? `${total.toLocaleString('fr-FR')} unités` : `${total}`;
      return `${cfg.label} : **${value}**`;
    });

  return new EmbedBuilder()
    .setTitle('📊 Bilan du Groupe — Semaine')
    .setColor(0x57F287)
    .setDescription(lines.join('\n') || '*Aucune activité*')
    .setTimestamp();
}

function buildTransactionEmbed(txId: number, userId: string, userTag: string, action: string, details: Record<string, string | number | undefined | null>): EmbedBuilder {
  const cfg = configStore.get().ACTIVITY_TYPES[action];
  const embed = new EmbedBuilder()
    .setTitle(`📝 Transaction #${txId}`)
    .setColor(0x57F287)
    .addFields(
      { name: 'Utilisateur', value: `<@${userId}> (${userTag})`, inline: true },
      { name: 'Action', value: cfg?.label || action, inline: true },
      { name: 'Heure', value: formatDateTime(Date.now()), inline: true },
    )
    .setTimestamp();

  for (const [k, v] of Object.entries(details)) {
    if (v !== undefined && v !== null && v !== '') embed.addFields({ name: k, value: String(v), inline: true });
  }
  return embed;
}

// ─── BOUTONS ──────────────────────────────────────────────────────────────────

const MAX_DIRECT_BUTTONS = 15; // 3 rangées de 5

/**
 * Construit les rangées de boutons du panneau : jusqu'à 3 rangées d'activités
 * déclarables (`panelButton: true`, triées par ordre d'affichage), un menu
 * déroulant de repli si plus de {@link MAX_DIRECT_BUTTONS} sont configurées
 * (limite Discord de 5 boutons/rangée × 5 rangées/message), puis la rangée
 * fixe des vues (mon quota, ma paie, classement, bilan, minuterie).
 */
function buildButtonRows() {
  const activityTypes = configStore.get().ACTIVITY_TYPES;
  const declarable = Object.entries(activityTypes)
    .filter(([, cfg]) => cfg.panelButton)
    .sort((a, b) => a[1].displayOrder - b[1].displayOrder);

  const styleFor = (cfg: ActivityTypeConfig): ButtonStyle => {
    if (cfg.labo) return ButtonStyle.Success;
    if (cfg.braquageWeeklyLimit) return ButtonStyle.Danger;
    return ButtonStyle.Primary;
  };

  const direct = declarable.slice(0, MAX_DIRECT_BUTTONS);
  const overflow = declarable.slice(MAX_DIRECT_BUTTONS, MAX_DIRECT_BUTTONS + 25);
  if (declarable.length > MAX_DIRECT_BUTTONS + 25) {
    console.warn(`[quotas] ${declarable.length - MAX_DIRECT_BUTTONS - 25} activité(s) supplémentaire(s) ne tiennent plus dans le panneau (limite Discord) — voir /config activite list.`);
  }

  const rows: ActionRowBuilder<ButtonBuilder | UserSelectMenuBuilder>[] = [];
  for (let i = 0; i < direct.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const [key, cfg] of direct.slice(i, i + 5)) {
      row.addComponents(new ButtonBuilder().setCustomId(`act_${key}`).setLabel(cfg.label.slice(0, 80)).setStyle(styleFor(cfg)));
    }
    rows.push(row as ActionRowBuilder<ButtonBuilder | UserSelectMenuBuilder>);
  }

  if (overflow.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('act_more_select')
      .setPlaceholder("Plus d'activités…")
      .addOptions(overflow.map(([key, cfg]) => ({ label: cfg.label.slice(0, 100), value: key })));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as unknown as ActionRowBuilder<ButtonBuilder | UserSelectMenuBuilder>);
  }

  const btn = (id: string, label: string, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    btn('view_quota', 'Mon Quota'),
    btn('view_paie', 'Ma Paie'),
    btn('view_classement', 'Classement Groupe'),
    btn('view_bilan', 'Bilan Groupe'),
    btn('view_minuterie', '⏱️ Minuterie'),
  ) as ActionRowBuilder<ButtonBuilder | UserSelectMenuBuilder>);

  return rows;
}

// ─── MESSAGE PERMANENT ────────────────────────────────────────────────────────

export async function initPermanentMessage(client: Client): Promise<void> {
  const c = configStore.get();
  if (!c.CHANNELS.quotas) return;
  try {
    const channel = await client.channels.fetch(c.CHANNELS.quotas).catch(() => null);
    if (!channel || !channel.isSendable()) return;

    const embed = await buildMainEmbed();
    const rows = buildButtonRows();

    const storedId = await db.getSetting('quota_message_id');
    if (storedId) {
      const msg = await channel.messages.fetch(storedId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed], components: rows });
        return;
      }
    }

    const newMsg = await channel.send({ embeds: [embed], components: rows });
    await db.setSetting('quota_message_id', newMsg.id);
  } catch (err) {
    console.error('[quotas] initPermanentMessage:', (err as Error).message);
  }
}

export async function updatePermanentMessage(client: Client): Promise<void> {
  await initPermanentMessage(client);
}

// ─── VÉRIFICATIONS ────────────────────────────────────────────────────────────

async function checkCooldown(userId: string, action: string): Promise<number | null> {
  const expires = await db.getCooldown(userId, action);
  if (expires <= Date.now()) return null;
  return expires - Date.now();
}

async function checkBraquageLimit(action: string): Promise<boolean> {
  const limit = configStore.get().ACTIVITY_TYPES[action]?.braquageWeeklyLimit;
  if (!limit) return true;
  const used = await db.getBraquageCount(action);
  return used < limit;
}

async function logActivite(client: Client, embed: EmbedBuilder): Promise<void> {
  const channelId = configStore.get().CHANNELS.logs_activites;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.isSendable()) await channel.send({ embeds: [embed] }).catch(() => null);
  } catch { /* silence */ }
}

// ─── DÉCLENCHEMENT D'UNE ACTIVITÉ (bouton direct ou menu de repli) ────────────

/**
 * Point d'entrée partagé entre un clic de bouton (`act_<key>`) et une
 * sélection dans le menu de repli (`act_more_select`) : décide du flux selon
 * les indicateurs de l'activité (labo → sélection de participants puis modal
 * temps restant ; braquage → vérif limite puis sélection de participants ;
 * quantité → modal type+quantité ; sinon → modal de confirmation simple).
 */
async function triggerActivity(interaction: ButtonInteraction | StringSelectMenuInteraction, key: string): Promise<void> {
  const cfg = configStore.get().ACTIVITY_TYPES[key];
  if (!cfg) {
    return replyAutoDelete(interaction, '❌ Cette activité n\'existe plus (retirée de la configuration).');
  }

  if (cfg.labo) {
    const select = new UserSelectMenuBuilder()
      .setCustomId(`act_select_${key}`)
      .setPlaceholder('Sélectionner les participants (optionnel)')
      .setMinValues(0).setMaxValues(25);
    return replyAutoDelete(interaction, {
      content: `🧪 **${cfg.label}** — Sélectionne les participants :`,
      components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select)],
    }, { deleteAfterMs: 60_000 });
  }

  if (cfg.braquageWeeklyLimit) {
    if (!(await checkBraquageLimit(key))) {
      return replyAutoDelete(interaction, `🚫 La limite hebdomadaire de **${cfg.label}** est atteinte (${cfg.braquageWeeklyLimit}/${cfg.braquageWeeklyLimit} sur 7 jours).`);
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(`act_select_${key}`)
      .setPlaceholder('Sélectionner les partenaires (optionnel)')
      .setMinValues(0).setMaxValues(25);
    return replyAutoDelete(interaction, {
      content: `🔫 **${cfg.label}** — Sélectionne tes partenaires :`,
      components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select)],
    }, { deleteAfterMs: 60_000 });
  }

  if (cfg.quantity) {
    const c = configStore.get();
    const itemHint = c.VENTE_ITEMS.length ? c.VENTE_ITEMS.join(', ') : (c.ALLOWED_ITEMS.length ? c.ALLOWED_ITEMS.join(', ') : 'ex: Cannabis, Cocaïne…');
    const modal = new ModalBuilder()
      .setCustomId(`modal_act_${key}`)
      .setTitle(cfg.label.slice(0, 45))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('type').setLabel('Type de produit')
            .setPlaceholder(itemHint.slice(0, 97) + (itemHint.length > 97 ? '…' : ''))
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('quantite').setLabel('Quantité')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10),
        ),
      );
    if (interaction.isButton() || interaction.isStringSelectMenu()) return interaction.showModal(modal);
    return;
  }

  if (cfg.cooldownMs) {
    const remaining = await checkCooldown(interaction.user.id, key);
    if (remaining !== null) {
      return replyAutoDelete(interaction, `⏳ Tu es en cooldown pour **${cfg.label}** encore **${formatTime(remaining)}**.`);
    }
  }

  const modal = new ModalBuilder()
    .setCustomId(`modal_act_${key}`)
    .setTitle(`${cfg.label} — Confirmer`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('confirm').setLabel('Taper "oui" pour confirmer')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3),
      ),
    );
  return interaction.showModal(modal);
}

// ─── HANDLER BOUTONS ─────────────────────────────────────────────────────────

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId;

  if (id === 'view_quota') {
    const member = interaction.guild ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null) : null;
    return replyAutoDelete(interaction, { embeds: [await buildQuotaEmbed(interaction.user.id, member)] });
  }
  if (id === 'view_paie') {
    const member = interaction.guild ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null) : null;
    return replyAutoDelete(interaction, { embeds: [await buildPayEmbed(interaction.user.id, member)] });
  }
  if (id === 'view_classement') {
    return replyAutoDelete(interaction, { embeds: [await buildClassementEmbed(interaction.client)] });
  }
  if (id === 'view_bilan') {
    return replyAutoDelete(interaction, { embeds: [await buildBilanEmbed()] });
  }
  if (id === 'view_minuterie') {
    return handleMinuterie(interaction);
  }

  if (id.startsWith('act_') && !id.startsWith('act_select_')) {
    return triggerActivity(interaction, id.slice('act_'.length));
  }
}

async function handleMinuterie(interaction: ButtonInteraction): Promise<void> {
  const userId = interaction.user.id;
  const activityTypes = configStore.get().ACTIVITY_TYPES;
  const entries = Object.entries(activityTypes).sort((a, b) => a[1].displayOrder - b[1].displayOrder);

  const cooldownLines = await Promise.all(
    entries.filter(([, cfg]) => cfg.cooldownMs && !cfg.labo && !cfg.braquageWeeklyLimit).map(async ([key, cfg]) => {
      const remaining = await checkCooldown(userId, key);
      const status = remaining ? `⏳ ${formatTime(remaining)}` : '✅ Dispo';
      return `**${cfg.label}** : ${status}`;
    }),
  );

  const braquageLines = await Promise.all(
    entries.filter(([, cfg]) => cfg.braquageWeeklyLimit).map(async ([key, cfg]) => {
      const limit = cfg.braquageWeeklyLimit!;
      const dispo = Math.max(0, limit - (await db.getBraquageCount(key)));
      let line = `${dispo > 0 ? '🟢' : '🔴'} **${cfg.label}** : ${dispo}/${limit}`;
      if (dispo === 0) {
        const oldest = await db.getOldestBraquage(key);
        if (oldest) {
          const ms = (oldest + 7 * 24 * 60 * 60 * 1000) - Date.now();
          if (ms > 0) line += ` *(prochain dans ${formatTime(ms)})*`;
        }
      }
      return line;
    }),
  );

  const laboLines = await Promise.all(
    entries.filter(([, cfg]) => cfg.labo).map(async ([key, cfg]) => {
      const endsAt = parseInt((await db.getSetting(`labo_end_${key}`)) || '0', 10);
      const remaining = endsAt > 0 ? endsAt - Date.now() : 0;
      return remaining > 0 ? `🔴 **${cfg.label}** : ${formatTime(remaining)}` : `🟢 **${cfg.label}** : Disponible`;
    }),
  );

  const embed = new EmbedBuilder().setTitle('⏱️ Minuterie').setColor(0x5865F2).setTimestamp();
  if (cooldownLines.length) embed.addFields({ name: '⚡ Cooldowns (perso)', value: cooldownLines.join('\n') });
  if (braquageLines.length) embed.addFields({ name: '🔫 Braquages (slots restants)', value: braquageLines.join('\n') });
  if (laboLines.length) embed.addFields({ name: '🧪 Labos', value: laboLines.join('\n') });
  if (!cooldownLines.length && !braquageLines.length && !laboLines.length) {
    embed.setDescription('*Aucune activité à minuterie configurée.*');
  }

  return replyAutoDelete(interaction, { embeds: [embed] });
}

/** Sélection dans le menu de repli `act_more_select` (activités hors des 15 boutons directs). */
export async function handleStringSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (interaction.customId !== 'act_more_select') return;
  const key = interaction.values[0];
  if (key) await triggerActivity(interaction, key);
}

// ─── HANDLER MODALS ───────────────────────────────────────────────────────────

export async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const id = interaction.customId;

  if (id.startsWith('modal_act_') && !id.startsWith('modal_actlabo_')) {
    const key = id.slice('modal_act_'.length);
    const cfg = configStore.get().ACTIVITY_TYPES[key];
    if (!cfg) return;

    if (cfg.quantity) {
      const type = interaction.fields.getTextInputValue('type').trim();
      const rawQty = interaction.fields.getTextInputValue('quantite').trim();
      const quantite = parseInt(rawQty, 10);
      if (isNaN(quantite) || quantite <= 0) return replyAutoDelete(interaction, '❌ Quantité invalide.');

      const txId = await db.addTransaction({ user_id: interaction.user.id, username: interaction.user.tag, action: key, quantite, type, timestamp: Date.now() });
      await db.incrementStat(interaction.user.id, key, quantite, 0);

      const embed = buildTransactionEmbed(txId, interaction.user.id, interaction.user.tag, key, { Type: type, Quantité: quantite.toLocaleString('fr-FR') });
      await logActivite(interaction.client, embed);
      await updatePermanentMessage(interaction.client);
      return replyAutoDelete(interaction, `✅ **${cfg.label}** — ${quantite.toLocaleString('fr-FR')} × ${type} enregistrés (ID #${txId}).`);
    }

    const confirm = interaction.fields.getTextInputValue('confirm').trim().toLowerCase();
    if (confirm !== 'oui') return replyAutoDelete(interaction, '❌ Action annulée.');

    const txId = await db.addTransaction({ user_id: interaction.user.id, username: interaction.user.tag, action: key, timestamp: Date.now() });
    await db.incrementStat(interaction.user.id, key, 1, 0);
    if (cfg.cooldownMs) await db.setCooldown(interaction.user.id, key, Date.now() + cfg.cooldownMs);

    const embed = buildTransactionEmbed(txId, interaction.user.id, interaction.user.tag, key, {});
    await logActivite(interaction.client, embed);
    await updatePermanentMessage(interaction.client);
    return replyAutoDelete(interaction, `✅ **${cfg.label}** enregistré (ID #${txId}).`);
  }

  if (id.startsWith('modal_actlabo_')) {
    const withoutPrefix = id.slice('modal_actlabo_'.length);
    const [key, token = ''] = withoutPrefix.split('|');
    const cfg = configStore.get().ACTIVITY_TYPES[key];
    if (!cfg) return;

    const tempsRaw = interaction.fields.getTextInputValue('temps_restant').trim();
    const tempsMinutes = parseInt(tempsRaw, 10);
    if (isNaN(tempsMinutes) || tempsMinutes <= 0) return replyAutoDelete(interaction, '❌ Temps restant invalide.');

    const partnerIds = token ? (pendingLaboParticipants.get(token) || []) : [];
    if (token && !partnerIds.length) {
      return replyAutoDelete(interaction, '❌ La sélection de participants a expiré. Recommence.');
    }
    if (token) pendingLaboParticipants.delete(token);

    const filteredPartnerIds = partnerIds.filter(pid => pid !== interaction.user.id);
    const allIds = [interaction.user.id, ...filteredPartnerIds];

    await replyAutoDelete(interaction, `✅ **${cfg.label}** validé. Enregistrement en cours...`);

    void (async () => {
      try {
        const txId = await db.addTransaction({
          user_id: interaction.user.id, username: interaction.user.tag, action: key,
          partenaires: partnerIds, temps_restant: String(tempsMinutes), timestamp: Date.now(),
        });
        for (const uid of allIds) await db.incrementStat(uid, key, 1, 0);
        await alertes.setLaboStatut(interaction.client, key, false, tempsMinutes);

        const partnerMentions = partnerIds.length ? partnerIds.map(pid => `<@${pid}>`).join(', ') : '*Aucun*';
        const embed = buildTransactionEmbed(txId, interaction.user.id, interaction.user.tag, key, {
          'Temps restant': `${tempsMinutes} min`, Participants: `${allIds.length}`, Partenaires: partnerMentions,
        });
        await logActivite(interaction.client, embed);
        await updatePermanentMessage(interaction.client);
      } catch (err) {
        console.error('[quotas] erreur traitement labo:', (err as Error).message);
      }
    })();
  }
}

// ─── HANDLER SELECT MENUS (participants) ─────────────────────────────────────

export async function handleSelect(interaction: UserSelectMenuInteraction): Promise<void> {
  const id = interaction.customId;
  if (!id.startsWith('act_select_')) return;
  const key = id.slice('act_select_'.length);
  const cfg = configStore.get().ACTIVITY_TYPES[key];
  if (!cfg) return;

  if (cfg.labo) {
    const selectedIds = interaction.values.filter(uid => uid !== interaction.user.id);
    const token = selectedIds.length ? createLaboParticipantToken(selectedIds) : '';
    const modal = new ModalBuilder()
      .setCustomId(`modal_actlabo_${key}${token ? `|${token}` : ''}`)
      .setTitle(`${cfg.label} — Temps restant`.slice(0, 45))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('temps_restant').setLabel('Temps restant (en minutes)')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5),
        ),
      );
    return interaction.showModal(modal);
  }

  // Braquage : partenaires sélectionnés → enregistrement direct
  const selectedIds = interaction.values.filter(uid => uid !== interaction.user.id);
  const allIds = [interaction.user.id, ...selectedIds];

  await db.addBraquage(interaction.user.id, key);
  const txId = await db.addTransaction({ user_id: interaction.user.id, username: interaction.user.tag, action: key, partenaires: selectedIds, timestamp: Date.now() });
  for (const uid of allIds) await db.incrementStat(uid, key, 1, 0);

  const embed = buildTransactionEmbed(txId, interaction.user.id, interaction.user.tag, key, {
    Partenaires: selectedIds.length ? selectedIds.map(p => `<@${p}>`).join(', ') : '*Aucun*',
  });
  await logActivite(interaction.client, embed);
  await alertes.postBraquageAlert(interaction.client, key);
  await updatePermanentMessage(interaction.client);

  return updateAutoDelete(interaction, {
    content: `✅ **${cfg.label}** enregistré (ID #${txId}). Participants : ${allIds.map(p => `<@${p}>`).join(', ')}.`,
    components: [],
  });
}

// ─── COMMANDE /supp ───────────────────────────────────────────────────────────

export async function handleSuppCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction.member)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
    return;
  }

  const txId = interaction.options.getInteger('id', true);
  const tx = await db.getTransaction(txId);
  if (!tx) {
    await interaction.reply({ content: `❌ Transaction #${txId} introuvable ou déjà supprimée.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const cfg = configStore.get().ACTIVITY_TYPES[tx.action];
  const allIds = [tx.userId, ...tx.partenaires];

  if (cfg) {
    if (cfg.quantity) {
      await db.decrementStat(tx.userId, tx.action, tx.quantite, 0);
    } else if (cfg.labo || cfg.braquageWeeklyLimit) {
      for (const uid of allIds) await db.decrementStat(uid, tx.action, 1, 0);
    } else {
      await db.decrementStat(tx.userId, tx.action, 1, 0);
    }
  }

  await db.deleteTransaction(txId, interaction.user.tag);

  const embed = new EmbedBuilder()
    .setTitle(`🗑️ Transaction #${txId} supprimée`)
    .setColor(0xED4245)
    .addFields(
      { name: 'Supprimée par', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
      { name: 'Action', value: cfg?.label || tx.action, inline: true },
      { name: 'Utilisateur', value: `<@${tx.userId}>`, inline: true },
    )
    .setTimestamp();

  await logActivite(interaction.client, embed);
  await updatePermanentMessage(interaction.client);

  await interaction.reply({ content: `✅ La saisie #${txId} a été supprimée par <@${interaction.user.id}>.` });
}

// ─── RESET HEBDOMADAIRE ───────────────────────────────────────────────────────

const LAST_RESET_KEY = 'last_weekly_reset';

function parisWallClock(date: Date): Date {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  return new Date(fmt.format(date));
}

async function isWeeklyResetDue(): Promise<boolean> {
  const wallNow = parisWallClock(new Date());
  const boundary = new Date(wallNow);
  boundary.setHours(19, 0, 0, 0);
  boundary.setDate(boundary.getDate() - boundary.getDay());
  if (boundary.getTime() > wallNow.getTime()) boundary.setDate(boundary.getDate() - 7);

  const lastMs = Number((await db.getSetting(LAST_RESET_KEY)) || 0);
  const wallLast = parisWallClock(new Date(lastMs));
  return wallLast.getTime() < boundary.getTime();
}

export async function checkWeeklyReset(client: Client): Promise<void> {
  if (!(await isWeeklyResetDue())) return;
  const previousReset = Number((await db.getSetting(LAST_RESET_KEY)) || 0);
  await db.setSetting(LAST_RESET_KEY, Date.now());
  console.log('[quotas] Reset hebdomadaire en retard détecté — déclenchement automatique.');
  await weeklyReset(client, previousReset);
}

// ─── RAPPEL DE QUOTA DU DIMANCHE (00h → 19h) — spécifique à la catégorie "vente" ──

const QUOTA_REMINDER_KEY = 'quota_reminder_message_id';
const QUOTA_REMINDER_TITLE = '⏰ Quota vente — dernière ligne droite avant le reset (19h00)';

export function isQuotaReminderMessage(message: Message): boolean {
  return message.embeds?.[0]?.title === QUOTA_REMINDER_TITLE;
}

function isDansFenetreRappelQuota(): boolean {
  const wall = parisWallClock(new Date());
  return wall.getDay() === 0 && wall.getHours() < 19;
}

async function getMembresSousQuotaVente(): Promise<Array<{ discord_id: string; vente: number }>> {
  const quota = configStore.get().QUOTA_TARGETS['vente'];
  if (quota == null) return [];
  const mappings = await db.getAllUserMappings();
  const discordIds = [...new Set(mappings.map(m => m.discordId))];
  const results: Array<{ discord_id: string; vente: number }> = [];
  for (const discord_id of discordIds) {
    const vente = (await db.getUserStatMap(discord_id))['vente']?.count || 0;
    if (vente < quota) results.push({ discord_id, vente });
  }
  return results;
}

function buildQuotaReminderPayload(sousQuota: Array<{ discord_id: string; vente: number }>, quota: number) {
  const tries = [...sousQuota].sort((a, b) => b.vente - a.vente);
  const embed = new EmbedBuilder()
    .setTitle(QUOTA_REMINDER_TITLE)
    .setColor(0xED4245)
    .setDescription(
      tries.length
        ? tries.map(m => `<@${m.discord_id}> — **${m.vente}/${quota}** unités`).join('\n')
        : '🎉 Tout le monde a atteint son quota de vente cette semaine !',
    )
    .setTimestamp();
  return { content: tries.map(m => `<@${m.discord_id}>`).join(' '), embeds: [embed] };
}

async function ensureQuotaReminderMessage(client: Client): Promise<Message | null> {
  const c = configStore.get();
  if (!c.CHANNELS.quotas) return null;
  const quota = c.QUOTA_TARGETS['vente'];
  if (quota == null) return null;
  const channel = await client.channels.fetch(c.CHANNELS.quotas).catch(() => null);
  if (!channel || !channel.isSendable()) return null;

  const messageId = await db.getSetting(QUOTA_REMINDER_KEY);
  if (messageId) {
    const existing = await channel.messages.fetch(messageId).catch(() => null);
    if (existing) return existing;
    console.log('[quotas] Rappel de quota introuvable (supprimé manuellement) — recréation.');
  }

  const msg = await channel.send(buildQuotaReminderPayload(await getMembresSousQuotaVente(), quota));
  await db.setSetting(QUOTA_REMINDER_KEY, msg.id);
  console.log('[quotas] Rappel de quota du dimanche posté.');
  return msg;
}

export async function checkQuotaReminder(client: Client): Promise<void> {
  if (!isDansFenetreRappelQuota()) return;
  try { await ensureQuotaReminderMessage(client); } catch (err) { console.error('[quotas] checkQuotaReminder:', (err as Error).message); }
}

export async function syncQuotaReminder(client: Client): Promise<void> {
  if (!isDansFenetreRappelQuota()) return;
  try {
    const quota = configStore.get().QUOTA_TARGETS['vente'];
    if (quota == null) return;
    const msg = await ensureQuotaReminderMessage(client);
    if (msg) await msg.edit(buildQuotaReminderPayload(await getMembresSousQuotaVente(), quota));
  } catch (err) {
    console.error('[quotas] syncQuotaReminder:', (err as Error).message);
  }
}

async function deleteQuotaReminder(client: Client): Promise<void> {
  const messageId = await db.getSetting(QUOTA_REMINDER_KEY);
  if (!messageId) return;
  await db.setSetting(QUOTA_REMINDER_KEY, '');
  const channelId = configStore.get().CHANNELS.quotas;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const msg = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
    if (msg) await msg.delete().catch(() => null);
  } catch (err) {
    console.error('[quotas] deleteQuotaReminder:', (err as Error).message);
  }
}

/** Reset hebdomadaire : publie bilan + paie, remet les stats à zéro. */
export async function weeklyReset(client: Client, sinceTs?: number): Promise<void> {
  try {
    const c = configStore.get();
    const since = sinceTs ?? Number((await db.getSetting(LAST_RESET_KEY)) || 0);
    const now = new Date();
    const endDate = formatDate(now.getTime());
    const startTs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const startDate = formatDate(startTs);
    const entete = `${startDate} — ${endDate}`;

    if (c.CHANNELS.bilan) {
      const bilanEmbed = await buildBilanEmbed(since);
      bilanEmbed.setTitle(`📊 Bilan hebdomadaire — ${entete}`);
      const bilanChannel = await client.channels.fetch(c.CHANNELS.bilan).catch(() => null);
      if (bilanChannel?.isSendable()) await bilanChannel.send({ embeds: [bilanEmbed] }).catch(() => null);
    }

    if (c.CHANNELS.paie) {
      const allTotals = await db.getAllUserActionTotals('vente');
      const paieChannel = await client.channels.fetch(c.CHANNELS.paie).catch(() => null);
      const guild = client.guilds.cache.first();

      if (paieChannel?.isSendable() && allTotals.length) {
        const lines: string[] = [];
        for (let i = 0; i < allTotals.length; i++) {
          const u = allTotals[i];
          const member = guild ? await guild.members.fetch(u.user_id).catch(() => null) : null;
          const name = member?.displayName || `<@${u.user_id}>`;
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          const salaire = Math.round(u.total * c.SALAIRE_PAR_VENTE);
          const { byQuotaType } = await getUserQuotaSummary(u.user_id);
          const targets = c.QUOTA_TARGETS;
          const quotaLine = Object.keys(targets).sort()
            .map(qt => `${capitalize(qt)} ${byQuotaType[qt] ?? 0}/${targets[qt]}`)
            .join(' | ');

          lines.push(
            `${medal} **${name}** — 💊 ${u.total.toLocaleString('fr-FR')} unités — 💵 ${salaire.toLocaleString('fr-FR')} $\n` +
            (quotaLine ? `    ${quotaLine}` : ''),
          );
        }

        const paieEmbed = new EmbedBuilder()
          .setTitle(`💰 Paie hebdomadaire — ${entete}`)
          .setColor(0xFEE75C)
          .setDescription(lines.join('\n\n'))
          .setTimestamp();
        await paieChannel.send({ embeds: [paieEmbed] }).catch(() => null);
      }
    }

    await db.resetAllStats();
    await deleteQuotaReminder(client);
    await garages.resetFourrieresHebdo(client, entete);
    console.log(`[quotas] Reset hebdomadaire effectué — ${entete}`);
  } catch (err) {
    console.error('[quotas] weeklyReset:', (err as Error).message);
  }
}

// ─── COMMANDE /listquota ──────────────────────────────────────────────────────

export async function handleListQuotaCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction.member)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
    return;
  }

  const userIds = await db.getAllTrackedUserIds();
  if (!userIds.length) {
    await interaction.reply({ content: '❌ Aucune activité enregistrée.', flags: MessageFlags.Ephemeral });
    return;
  }

  const targets = configStore.get().QUOTA_TARGETS;
  const guild = interaction.guild;

  const rows: Array<{ userId: string; byQuotaType: Record<string, number>; complete: boolean; name: string; venteCount: number }> = [];
  for (const userId of userIds) {
    const { byQuotaType, map } = await getUserQuotaSummary(userId);
    const complete = Object.entries(targets).every(([qt, target]) => (byQuotaType[qt] ?? 0) >= target);
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
    rows.push({ userId, byQuotaType, complete, name: member?.displayName || `<@${userId}>`, venteCount: map['vente']?.count || 0 });
  }

  rows.sort((a, b) => (a.complete !== b.complete ? (a.complete ? 1 : -1) : b.venteCount - a.venteCount));

  const lines = rows.map(r => {
    const detail = Object.keys(targets).sort()
      .map(qt => `${capitalize(qt)} ${r.byQuotaType[qt] ?? 0}/${targets[qt]}`)
      .join(' | ');
    return `${r.complete ? '✅' : '❌'} **${r.name}** — ${detail}`;
  });

  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > 3900) { chunks.push(current); current = []; length = 0; }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length) chunks.push(current);

  const embeds = chunks.map((chunk, i) => new EmbedBuilder()
    .setTitle(i === 0 ? '📋 Suivi des quotas — tous les membres' : null)
    .setColor(0x5865F2)
    .setDescription(chunk.join('\n')));

  await interaction.reply({ embeds, flags: MessageFlags.Ephemeral });
}

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────

export function getCommands() {
  return [
    {
      data: new SlashCommandBuilder()
        .setName('supp')
        .setDescription('Supprimer une transaction (admin)')
        .addIntegerOption(opt => opt.setName('id').setDescription('ID de la transaction').setRequired(true).setMinValue(1)),
    },
    {
      data: new SlashCommandBuilder()
        .setName('listquota')
        .setDescription('Liste les quotas de tous les membres suivis (admin)'),
    },
  ];
}
