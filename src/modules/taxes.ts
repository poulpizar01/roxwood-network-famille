/**
 * @file src/modules/taxes.ts
 * @description Gestion des taxes et loyers dans le contexte RP (FiveM).
 *
 * Types de taxes supportés : 'roxwood' (zone de vente), 'sporex' (labo Spore
 * X), 'vente' (vente de drogue), 'fertilisant' (récolte). Contrairement à
 * items/activités/quotas, ces 4 types restent fixes dans le code plutôt que
 * configurables via `/config` : chacun a des champs de modal hétérogènes
 * (Roxwood a téléphone + mot de passe, les autres non) — les rendre
 * dynamiques demanderait un moteur de formulaire générique, hors du
 * périmètre de généralisation retenu pour ce projet (items, quotas,
 * cooldowns, types de braquage). Seuls le salon, le rôle d'accès et les
 * échéances sont configurables.
 *
 * Toute taxe est payée par défaut à sa création ; le cron quotidien
 * `checkExpiredTaxes` alerte pour chaque taxe expirée non-Roxwood (une seule
 * fois par expiration, via `alerte_sent`).
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
  type RepliableInteraction,
  type InteractionReplyOptions,
} from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';

type Taxe = NonNullable<Awaited<ReturnType<typeof db.getTaxe>>>;

const TYPES_RECHERCHE = ['roxwood', 'sporex', 'vente', 'fertilisant'] as const;
type TaxeType = (typeof TYPES_RECHERCHE)[number];

// ─── AUTO-DELETE HELPERS ──────────────────────────────────────────────────────

async function replyAutoDelete(interaction: RepliableInteraction, payload: string | InteractionReplyOptions, options: { deleteAfterMs?: number } = {}): Promise<void> {
  const p: InteractionReplyOptions = typeof payload === 'string' ? { content: payload } : payload;
  const { resource } = await interaction.reply({ ...p, withResponse: true });
  const message = resource?.message;
  if (options.deleteAfterMs && options.deleteAfterMs > 0 && message) {
    setTimeout(() => { message.delete().catch(() => null); }, options.deleteAfterMs);
  }
}

async function updateAutoDelete(interaction: StringSelectMenuInteraction, payload: string | Record<string, unknown>): Promise<void> {
  const p = typeof payload === 'string' ? { content: payload } : payload;
  await interaction.update(p as Parameters<StringSelectMenuInteraction['update']>[0]);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateFull(ts: number): string {
  return new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function isExpired(echeance: number): boolean {
  return echeance <= Date.now();
}

function typeLabel(type: string): string {
  switch (type) {
    case 'roxwood': return 'Roxwood';
    case 'sporex': return 'Labo Sporex';
    case 'vente': return 'Vente';
    case 'fertilisant': return 'Fertilisant';
    default: return type;
  }
}

// ─── EMBED TAXE ───────────────────────────────────────────────────────────────

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

function buildPayeToggleRow(taxe: Taxe): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tax_toggle_paye_${taxe.id}`)
      .setLabel(taxe.paye ? 'Marquer Non payée' : 'Marquer Payée')
      .setStyle(taxe.paye ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setEmoji(taxe.paye ? '❌' : '✅'),
  );
}

function buildAlertButtons(taxeId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`tax_renew_${taxeId}`).setLabel('Renouveler').setStyle(ButtonStyle.Success).setEmoji('🔄'),
    new ButtonBuilder().setCustomId(`tax_delete_${taxeId}`).setLabel('Supprimer').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
  );
}

// ─── MESSAGE PERMANENT ────────────────────────────────────────────────────────

export async function initPermanentMessage(client: Client): Promise<void> {
  const channelId = configStore.get().CHANNELS.taxes;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return;

    const embed = new EmbedBuilder()
      .setTitle('💰 Gestion des Taxes & Rackets')
      .setColor(0xFEE75C)
      .setDescription(
        'Utilisez les boutons ci-dessous pour enregistrer une taxe.\n\n' +
        '**Roxwood** — zone de vente\n**Fertilisant** — récolte\n**Spore X** — production\n**Vente** — vente de drogue',
      );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('tax_roxwood').setLabel('Taxe Roxwood').setStyle(ButtonStyle.Primary).setEmoji('🏘️'),
      new ButtonBuilder().setCustomId('tax_fertilisant').setLabel('Taxe Fertilisant').setStyle(ButtonStyle.Primary).setEmoji('🌱'),
      new ButtonBuilder().setCustomId('tax_sporex').setLabel('Taxe Spore X').setStyle(ButtonStyle.Primary).setEmoji('🧪'),
      new ButtonBuilder().setCustomId('tax_vente').setLabel('Taxe Vente').setStyle(ButtonStyle.Secondary).setEmoji('💊'),
    );

    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('tax_rechercher').setLabel('Rechercher une taxe').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
      new ButtonBuilder().setCustomId('tax_supprimer').setLabel('Supprimer une taxe').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    );

    const storedId = await db.getSetting('taxes_message_id');
    if (storedId) {
      const msg = await channel.messages.fetch(storedId).catch(() => null);
      if (msg) { await msg.edit({ embeds: [embed], components: [row, row2] }); return; }
    }

    const newMsg = await channel.send({ embeds: [embed], components: [row, row2] });
    await db.setSetting('taxes_message_id', newMsg.id);
  } catch (err) {
    console.error('[taxes] initPermanentMessage:', (err as Error).message);
  }
}

// ─── CHECK TAXES EXPIRÉES ─────────────────────────────────────────────────────

export async function checkExpiredTaxes(client: Client): Promise<void> {
  const channelId = configStore.get().CHANNELS.alertes_taxes;
  if (!channelId) return;
  try {
    const expired = await db.getExpiredTaxes('roxwood');
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

      await channel.send({ embeds: [embed], components: [buildAlertButtons(taxe.id)] }).catch(() => null);
      await db.markTaxeAlerteSent(taxe.id);
    }
  } catch (err) {
    console.error('[taxes] checkExpiredTaxes:', (err as Error).message);
  }
}

export function getCommands() {
  return [];
}

// ─── HANDLER BOUTONS ─────────────────────────────────────────────────────────

function buildCreationModal(type: TaxeType): ModalBuilder {
  const titres: Record<TaxeType, string> = { roxwood: 'Taxe Roxwood', sporex: 'Taxe Spore X', vente: 'Taxe Vente', fertilisant: 'Taxe Fertilisant' };
  const rows = [
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('nom').setLabel('Nom du groupe').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50),
    ),
  ];
  if (type === 'roxwood') {
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

  return new ModalBuilder().setCustomId(`modal_tax_${type}`).setTitle(titres[type]).addComponents(...rows);
}

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId;

  if (id === 'tax_roxwood' || id === 'tax_sporex' || id === 'tax_vente' || id === 'tax_fertilisant') {
    return interaction.showModal(buildCreationModal(id.replace('tax_', '') as TaxeType));
  }

  if (id.startsWith('tax_renew_')) {
    const taxeId = parseInt(id.replace('tax_renew_', ''), 10);
    const taxe = await db.getTaxe(taxeId);
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
    const action = id === 'tax_rechercher' ? 'rechercher' : 'supprimer';
    const select = new StringSelectMenuBuilder()
      .setCustomId(`tax_select_${action}_type`)
      .setPlaceholder(action === 'rechercher' ? 'Quel type de taxe ?' : 'Quel type de taxe supprimer ?')
      .addOptions(TYPES_RECHERCHE.map(type => ({ label: typeLabel(type), value: type })));

    return replyAutoDelete(interaction, {
      content: action === 'rechercher' ? '🔍 Quel type de taxe veux-tu rechercher ?' : '🗑️ Quel type de taxe veux-tu supprimer ?',
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    }, { deleteAfterMs: 60_000 });
  }

  if (id.startsWith('tax_toggle_paye_')) {
    const taxeId = parseInt(id.replace('tax_toggle_paye_', ''), 10);
    const taxe = await db.getTaxe(taxeId);
    if (!taxe) return replyAutoDelete(interaction, '❌ Taxe introuvable.');

    await db.setTaxePaye(taxeId, !taxe.paye);
    const updated = (await db.getTaxe(taxeId))!;
    const components = [buildPayeToggleRow(updated), buildAlertButtons(updated.id)];

    await interaction.update({ embeds: [buildTaxeEmbed(updated)], components });
    return;
  }

  if (id.startsWith('tax_delete_')) {
    const taxeId = parseInt(id.replace('tax_delete_', ''), 10);
    const taxe = await db.getTaxe(taxeId);
    if (!taxe) return replyAutoDelete(interaction, '❌ Taxe introuvable.');

    await db.deleteTaxe(taxeId);
    await interaction.update({ content: `🗑️ Taxe **${taxe.nom}** supprimée.`, embeds: [], components: [] })
      .catch(async () => { await replyAutoDelete(interaction, `🗑️ Taxe **${taxe.nom}** supprimée.`); });
  }
}

// ─── HANDLER MODALS ───────────────────────────────────────────────────────────

async function handleCreationModal(interaction: ModalSubmitInteraction, type: TaxeType): Promise<void> {
  const nom = interaction.fields.getTextInputValue('nom').trim();
  const jours = parseInt(interaction.fields.getTextInputValue('jours'), 10);
  const mdp = interaction.fields.getTextInputValue('mot_de_passe').trim();
  let tel = '';
  try { tel = interaction.fields.getTextInputValue('telephone').trim(); } catch { /* absent hors roxwood */ }

  if (isNaN(jours) || jours <= 0) return replyAutoDelete(interaction, '❌ Nombre de jours invalide.');

  const echeance = Date.now() + jours * 24 * 60 * 60 * 1000;
  await db.addTaxe({ nom, type, telephone: tel || null, echeance, mot_de_passe: mdp || null });

  return replyAutoDelete(interaction, `✅ Taxe ${typeLabel(type)} **${nom}** enregistrée — échéance le **${formatDate(echeance)}**.`);
}

export async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const id = interaction.customId;

  if (id === 'modal_tax_roxwood' || id === 'modal_tax_sporex' || id === 'modal_tax_vente' || id === 'modal_tax_fertilisant') {
    return handleCreationModal(interaction, id.replace('modal_tax_', '') as TaxeType);
  }

  if (id.startsWith('modal_tax_renew_')) {
    const taxeId = parseInt(id.replace('modal_tax_renew_', ''), 10);
    const jours = parseInt(interaction.fields.getTextInputValue('jours'), 10);

    if (isNaN(jours) || jours <= 0) return replyAutoDelete(interaction, '❌ Nombre de jours invalide.');

    const newDate = await db.renewTaxe(taxeId, jours);
    if (!newDate) return replyAutoDelete(interaction, '❌ Taxe introuvable.');

    const taxe = await db.getTaxe(taxeId);
    if (taxe?.type === 'roxwood') await db.setTaxePaye(taxeId, true);

    return replyAutoDelete(interaction, `✅ Taxe renouvelée jusqu'au **${formatDate(newDate)}**.`);
  }

  if (id.startsWith('modal_tax_recherche_') || id.startsWith('modal_tax_supprimer_recherche_')) {
    const forSuppression = id.startsWith('modal_tax_supprimer_recherche_');
    const type = id.replace(forSuppression ? 'modal_tax_supprimer_recherche_' : 'modal_tax_recherche_', '');
    const query = interaction.fields.getTextInputValue('recherche').trim().toLowerCase();

    const matches = (await db.getAllTaxes())
      .filter(t => t.type === type)
      .filter(t => !query || t.nom.toLowerCase().includes(query));

    if (!matches.length) return replyAutoDelete(interaction, `❌ Aucune taxe ${typeLabel(type)} ne correspond à « ${query || '(tout)'} ».`);

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

export async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (interaction.customId === 'tax_select_supprimer_resultat') {
    const taxeId = parseInt(interaction.values[0], 10);
    const taxe = await db.getTaxe(taxeId);
    if (!taxe) return updateAutoDelete(interaction, { content: '❌ Taxe introuvable.', components: [] });
    await db.deleteTaxe(taxeId);
    return updateAutoDelete(interaction, { content: `🗑️ Taxe **${taxe.nom}** (${typeLabel(taxe.type)}) supprimée.`, components: [] });
  }

  if (interaction.customId === 'tax_select_supprimer_type' || interaction.customId === 'tax_select_rechercher_type') {
    const forSuppression = interaction.customId === 'tax_select_supprimer_type';
    const type = interaction.values[0] as TaxeType;
    if (!TYPES_RECHERCHE.includes(type)) return updateAutoDelete(interaction, { content: '❌ Type invalide.', components: [] });

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
    const taxe = await db.getTaxe(taxeId);
    if (!taxe) return updateAutoDelete(interaction, { content: '❌ Taxe introuvable.', components: [] });
    return updateAutoDelete(interaction, {
      content: null,
      embeds: [buildTaxeEmbed(taxe)],
      components: [buildPayeToggleRow(taxe), buildAlertButtons(taxe.id)],
    });
  }
}
