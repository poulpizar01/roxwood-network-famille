/**
 * @file src/modules/ventes.ts
 * @description Cycle de vie des ventes de drogue (retrait coffre → dépôt argent).
 *
 * Flux : un retrait sur un item marqué `vente: true` (voir `/config item add
 * --vente`) crée une vente en attente et alerte dans `ventes_drogue`. Le
 * joueur peut Déclarer (attend un dépôt d'argent), Reposer (attend un
 * redépôt), ou corriger la quantité. Un dépôt sur un item marqué `paiement:
 * true` confirme automatiquement (fenêtre de {@link WINDOW_MS}), log dans
 * `log_ventes`, met à jour stats/quota.
 */
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  MessageFlags,
  type Client,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  type ChatInputCommandInteraction,
} from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';
import { isAdmin } from '../permissions';
import * as quotas from './quotas';
import type { StockEntry } from './stocks';

/** Fenêtre max (ms) entre retrait et dépôt d'argent pour confirmation auto (3h). */
const WINDOW_MS = 3 * 60 * 60 * 1000;
/** Fenêtre max (ms) entre deux retraits successifs cumulés dans la même alerte (5 min). */
const ACCUMULATION_WINDOW_MS = 5 * 60 * 1000;

type PendingSale = Awaited<ReturnType<typeof db.getPendingSale>>;

// ─── POINT D'ENTRÉE DEPUIS STOCKS ────────────────────────────────────────────

/** Point d'entrée appelé par `stocks.handleMessage` pour chaque mouvement détecté : route vers création de vente en attente ou tentative de confirmation selon l'item et le sens du mouvement. */
export async function onStockEntry(client: Client, entry: StockEntry): Promise<void> {
  const c = configStore.get();
  const itemLower = entry.item.toLowerCase();
  const venteItems = c.VENTE_ITEMS.map(i => i.toLowerCase());
  const argentItems = c.VENTE_ARGENT_ITEMS.map(i => i.toLowerCase());

  if (entry.action === 'retire' && venteItems.includes(itemLower)) {
    await createPendingSale(client, entry);
    return;
  }
  if (entry.action === 'depose' && argentItems.includes(itemLower)) {
    await tryConfirmMoneyDeposit(client, entry);
    return;
  }
  if (entry.action === 'depose' && venteItems.includes(itemLower)) {
    await tryConfirmRedeposit(client, entry);
  }
}

// ─── ALERTE JOUEUR NON MAPPÉ ──────────────────────────────────────────────────

/** Alerte dans `admin` qu'un joueur sans compte Discord mappé est impliqué dans une vente (stats/quota non attribuables). */
async function alertMissingMapping(client: Client, joueur: string, contexte: string): Promise<void> {
  const channelId = configStore.get().CHANNELS.admin;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isSendable()) return;

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Joueur non mappé')
    .setColor(0xED4245)
    .setDescription(`**${joueur}** n'est associé à aucun compte Discord.\nUtilisez \`/adduser\` pour le lier.`)
    .addFields({ name: 'Contexte', value: contexte })
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => null);
}

// ─── CRÉER LA VENTE EN ATTENTE ET ENVOYER L'ALERTE ───────────────────────────

/** Crée une vente en attente et poste l'alerte dans `ventes_drogue` — ou cumule sur une alerte déjà postée si un retrait du même item par le même joueur date de moins de {@link ACCUMULATION_WINDOW_MS}. */
async function createPendingSale(client: Client, entry: StockEntry): Promise<void> {
  const channelId = configStore.get().CHANNELS.ventes_drogue;
  if (!channelId) return;

  const existing = await db.getPendingSaleForAccumulation(entry.joueur, entry.item, Date.now() - ACCUMULATION_WINDOW_MS);
  if (existing) {
    const newQuantite = existing.quantite + entry.quantite;
    await db.accumulatePendingSale(existing.id, newQuantite, Date.now());
    await editAccumulatedAlert(client, existing, newQuantite);
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isSendable()) return;

  // Pas d'alerte "joueur non mappé" ici si `discordIds` est vide : c'est déjà
  // fait en amont par `stocks.handleMessage` pour tout mouvement de coffre,
  // avant même que ce module ne soit appelé.
  const discordIds = await db.getUserMappings(entry.joueur);
  const discordId = discordIds.length === 1 ? discordIds[0] : null;

  const saleId = await db.createPendingSale({ joueur: entry.joueur, discord_id: discordId, item: entry.item, quantite: entry.quantite, timestamp: Date.now() });

  const embed = buildAlertEmbed(entry, saleId, '🚨 Retrait de drogue détecté', 0xE67E22, discordId);
  const row = buildAlertButtons(saleId);
  const ping = discordIds.length > 0 ? discordIds.map(id => `<@${id}>`).join(' ') : `**${entry.joueur}**`;

  const sentMsg = await channel.send({ content: ping, embeds: [embed], components: [row] });
  await db.updatePendingSaleMessage(saleId, sentMsg.id, sentMsg.channelId);
}

/** Embed d'alerte de vente : joueur, item, quantité — le footer `Vente #<id>` identifie la vente (voir `handleTrashReaction`). */
function buildAlertEmbed(entry: { joueur: string; item: string; quantite: number }, saleId: number, title: string, color: number, discordId: string | null = null): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: 'Joueur', value: discordId ? `<@${discordId}>` : entry.joueur, inline: true },
      { name: 'Item', value: entry.item, inline: true },
      { name: 'Quantité', value: entry.quantite.toLocaleString('fr-FR'), inline: true },
    )
    .setFooter({ text: `Vente #${saleId}` })
    .setTimestamp();
}

/** Boutons Déclarer/Reposer/Modifier d'une alerte de vente en attente. */
function buildAlertButtons(saleId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`vente_declarer_${saleId}`).setLabel('Déclarer la Vente').setStyle(ButtonStyle.Success).setEmoji('💰'),
    new ButtonBuilder().setCustomId(`vente_reposer_${saleId}`).setLabel('Reposer').setStyle(ButtonStyle.Secondary).setEmoji('📦'),
    new ButtonBuilder().setCustomId(`vente_modifier_${saleId}`).setLabel('Modifier la quantité').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
  );
}

/** Met à jour l'embed d'une alerte de vente après cumul d'une nouvelle quantité (nouveau retrait, ou reposage partiel). */
async function editAccumulatedAlert(client: Client, sale: NonNullable<PendingSale>, newQuantite: number): Promise<void> {
  if (!sale.channelId || !sale.messageId) return;
  try {
    const channel = await client.channels.fetch(sale.channelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const msg = await channel.messages.fetch(sale.messageId).catch(() => null);
    if (!msg) return;

    const embed = buildAlertEmbed({ joueur: sale.joueur, item: sale.item, quantite: newQuantite }, sale.id, '🚨 Retrait de drogue détecté', 0xE67E22, sale.discordId);
    await msg.edit({ embeds: [embed] });
  } catch { /* silence */ }
}

// ─── CONFIRMATION PAR DÉPÔT D'ARGENT ─────────────────────────────────────────

/** Un dépôt d'un item de paiement confirme toutes les ventes déclarées en attente d'un joueur dans la fenêtre {@link WINDOW_MS}. */
async function tryConfirmMoneyDeposit(client: Client, entry: StockEntry): Promise<void> {
  const sales = await db.getPendingSalesForConfirmation(entry.joueur, Date.now() - WINDOW_MS);
  if (!sales.length) return;

  for (const sale of sales) {
    await db.confirmPendingSale(sale.id);
    await editAlertMessage(client, sale, '✅ Vente confirmée — argent déposé', 0x57F287);
  }
  await sendLogVente(client, sales, entry.quantite);
}

// ─── CONFIRMATION PAR RETOUR DE DROGUE ───────────────────────────────────────

/** Un dépôt de l'item de vente lui-même confirme un reposage déclaré, ou décrémente/annule une vente en attente pas encore déclarée (redépôt partiel ou total). */
async function tryConfirmRedeposit(client: Client, entry: StockEntry): Promise<void> {
  const saleRepose = await db.getPendingSaleRepose(entry.joueur, entry.item, Date.now() - WINDOW_MS);
  if (saleRepose) {
    await db.confirmPendingSale(saleRepose.id);
    await editAlertMessage(client, saleRepose, '✅ Drogue reposée et vérifiée', 0x57F287);
    return;
  }

  const saleEnAttente = await db.getPendingSaleForAccumulation(entry.joueur, entry.item, Date.now() - WINDOW_MS);
  if (!saleEnAttente) return;

  const nouvelleQuantite = saleEnAttente.quantite - entry.quantite;
  if (nouvelleQuantite <= 0) {
    await db.updatePendingSaleStatut(saleEnAttente.id, 'ignore');
    await editAlertMessage(client, saleEnAttente, '📦 Drogue intégralement reposée — vente annulée', 0x95A5A6);
  } else {
    await db.accumulatePendingSale(saleEnAttente.id, nouvelleQuantite, Date.now());
    await editAccumulatedAlert(client, saleEnAttente, nouvelleQuantite);
  }
}

// ─── LOG FINAL DANS log_ventes ────────────────────────────────────────────────

/** Poste le log final dans `log_ventes` pour une ou plusieurs ventes confirmées ensemble, puis met à jour stats/quota (ou alerte si le joueur n'est pas mappé). */
async function sendLogVente(client: Client, sales: Array<NonNullable<PendingSale>>, montantDepose: number): Promise<void> {
  const channelId = configStore.get().CHANNELS.log_ventes;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isSendable()) return;

  const totalQuantite = sales.reduce((sum, s) => sum + s.quantite, 0);
  const detail = sales.map(s => `${s.item} × ${s.quantite.toLocaleString('fr-FR')}`).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(sales.length > 1 ? `✅ ${sales.length} ventes de drogue confirmées` : '✅ Vente de drogue confirmée')
    .setColor(0x57F287)
    .addFields(
      { name: 'Joueur', value: sales[0].joueur, inline: true },
      { name: 'Total unités', value: totalQuantite.toLocaleString('fr-FR'), inline: true },
      { name: 'Argent déposé', value: `${montantDepose.toLocaleString('fr-FR')} $`, inline: true },
      { name: 'Détail', value: detail },
    )
    .setTimestamp();

  await channel.send({ embeds: [embed] });

  for (const sale of sales) {
    if (sale.discordId) {
      await db.addTransaction({ user_id: sale.discordId, username: sale.joueur, action: 'vente', quantite: sale.quantite, type: sale.item, timestamp: Date.now() });
      await db.incrementStat(sale.discordId, 'vente', sale.quantite, 0);
    } else {
      await alertMissingMapping(client, sale.joueur, `Vente confirmée — quota de ${sale.quantite.toLocaleString('fr-FR')} × ${sale.item} non attribué`);
    }
  }
  await quotas.initPermanentMessage(client);
  await quotas.syncQuotaReminder(client);
}

// ─── RÉACTION 🗑️ → IGNORER LA VENTE ──────────────────────────────────────────

/** Réaction 🗑️ sur une alerte de vente (identifiée par le footer `Vente #<id>`) : marque la vente ignorée si l'auteur est admin ou le joueur concerné. @returns `true` si la réaction concernait bien une alerte de vente (gérée ou rejetée), `false` sinon (laisse `index.ts` traiter la réaction normalement). */
export async function handleTrashReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<boolean> {
  const msg = reaction.message;
  const footer = msg.embeds?.[0]?.footer?.text;
  if (!footer?.startsWith('Vente #')) return false;

  const saleId = parseInt(footer.replace('Vente #', ''), 10);
  if (isNaN(saleId)) return false;

  const sale = await db.getPendingSale(saleId);
  if (!sale || sale.statut !== 'en_attente') return false;

  const member = await msg.guild?.members.fetch(user.id).catch(() => null);
  const admin = isAdmin(member ?? null);
  const isOwner = !!(sale.discordId && sale.discordId === user.id);

  if (!admin && !isOwner) {
    await reaction.users.remove(user.id).catch(() => null);
    return true;
  }

  await db.updatePendingSaleStatut(saleId, 'ignore');
  const embed = EmbedBuilder.from(msg.embeds[0]).setTitle('🗑️ Vente ignorée').setColor(0x95A5A6);
  await msg.edit({ embeds: [embed], components: [] }).catch(() => null);
  return true;
}

// ─── ÉDITION DU MESSAGE ALERTE ────────────────────────────────────────────────

/** Édite le titre/couleur de l'embed d'une alerte de vente et retire ses boutons (fin de cycle : confirmée, expirée...). */
async function editAlertMessage(client: Client, sale: NonNullable<PendingSale>, title: string, color: number): Promise<void> {
  if (!sale.channelId || !sale.messageId) return;
  try {
    const channel = await client.channels.fetch(sale.channelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const msg = await channel.messages.fetch(sale.messageId).catch(() => null);
    if (!msg || !msg.embeds[0]) return;
    const embed = EmbedBuilder.from(msg.embeds[0]).setTitle(title).setColor(color);
    await msg.edit({ embeds: [embed], components: [] });
  } catch { /* silence */ }
}

// ─── AUTORISATION D'INTERACTION ───────────────────────────────────────────────

/** Vrai si l'auteur de l'interaction est mappé au joueur de la vente (et backfill `discordId` si absent), ou admin ; répond sinon avec un refus. */
async function authorizeSaleInteraction(interaction: ButtonInteraction, sale: NonNullable<PendingSale>): Promise<boolean> {
  const mappedIds = await db.getUserMappings(sale.joueur);

  if (mappedIds.includes(interaction.user.id)) {
    if (sale.discordId !== interaction.user.id) {
      await db.updatePendingSaleDiscordId(sale.id, interaction.user.id);
      sale.discordId = interaction.user.id;
    }
    return true;
  }

  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (isAdmin(member ?? null)) return true;

  await interaction.reply({
    content: `❌ Vous n'êtes pas identifié comme **${sale.joueur}**, vous ne pouvez pas interagir avec cette vente.`,
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

// ─── HANDLER BOUTONS ─────────────────────────────────────────────────────────

/** Route les clics de bouton d'une alerte de vente (`vente_*`) : déclarer, reposer, modifier la quantité. */
export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId;

  if (id.startsWith('vente_declarer_')) {
    const saleId = parseInt(id.replace('vente_declarer_', ''), 10);
    const sale = await db.getPendingSale(saleId);
    if (!sale || sale.statut !== 'en_attente') {
      await interaction.reply({ content: "❌ Cette vente n'est plus en attente.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await authorizeSaleInteraction(interaction, sale))) return;
    await db.updatePendingSaleStatut(saleId, 'declare');
    const embed = EmbedBuilder.from(interaction.message.embeds[0]).setTitle("💰 Vente déclarée — en attente du dépôt d'argent").setColor(0xFEE75C);
    await interaction.update({ embeds: [embed], components: [] });
    return;
  }

  if (id.startsWith('vente_reposer_')) {
    const saleId = parseInt(id.replace('vente_reposer_', ''), 10);
    const sale = await db.getPendingSale(saleId);
    if (!sale || sale.statut !== 'en_attente') {
      await interaction.reply({ content: "❌ Cette vente n'est plus en attente.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await authorizeSaleInteraction(interaction, sale))) return;
    await db.updatePendingSaleStatut(saleId, 'repose');
    const embed = EmbedBuilder.from(interaction.message.embeds[0]).setTitle('📦 Drogue reposée — en attente de vérification').setColor(0x5865F2);
    await interaction.update({ embeds: [embed], components: [] });
    return;
  }

  if (id.startsWith('vente_modifier_')) {
    const saleId = parseInt(id.replace('vente_modifier_', ''), 10);
    const sale = await db.getPendingSale(saleId);
    if (!sale || sale.statut !== 'en_attente') {
      await interaction.reply({ content: "❌ Cette vente n'est plus en attente.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await authorizeSaleInteraction(interaction, sale))) return;
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`modal_vente_modifier_${saleId}`)
        .setTitle('Corriger la quantité')
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('quantite').setLabel('Quantité correcte')
            .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder(`Actuel : ${sale.quantite}`),
        )),
    );
  }
}

// ─── HANDLER MODALS ───────────────────────────────────────────────────────────

/** Traite la soumission du modal de correction de quantité (`modal_vente_modifier_<id>`). */
export async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const id = interaction.customId;

  if (id.startsWith('modal_vente_modifier_')) {
    const saleId = parseInt(id.replace('modal_vente_modifier_', ''), 10);
    const sale = await db.getPendingSale(saleId);
    const raw = interaction.fields.getTextInputValue('quantite').replace(/[\s ]/g, '');
    const quantite = parseInt(raw, 10);

    if (!sale) { await interaction.reply({ content: '❌ Vente introuvable.', flags: MessageFlags.Ephemeral }); return; }
    if (isNaN(quantite) || quantite <= 0) { await interaction.reply({ content: '❌ Quantité invalide.', flags: MessageFlags.Ephemeral }); return; }

    const ancienneQuantite = sale.quantite;
    await db.updatePendingSaleQuantite(saleId, quantite);

    try {
      const channel = sale.channelId ? await interaction.client.channels.fetch(sale.channelId).catch(() => null) : null;
      const msg = channel?.isTextBased() && sale.messageId ? await channel.messages.fetch(sale.messageId).catch(() => null) : null;
      if (msg) {
        const embed = buildAlertEmbed({ joueur: sale.joueur, item: sale.item, quantite }, saleId, '🚨 Retrait de drogue détecté (quantité corrigée)', 0xE67E22, sale.discordId);
        await msg.edit({ embeds: [embed], components: [buildAlertButtons(saleId)] });
      }
    } catch { /* silence */ }

    await interaction.reply({
      content: `✅ Quantité corrigée : **${quantite.toLocaleString('fr-FR')}** (était ${ancienneQuantite.toLocaleString('fr-FR')}).`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ─── NETTOYAGE DES VENTES EXPIRÉES (cron) ────────────────────────────────────

/** Cron (toutes les 10 min) : marque expirées les ventes sans action depuis plus de {@link WINDOW_MS}. */
export async function cleanupExpiredSales(client: Client): Promise<void> {
  const expired = await db.getExpiredPendingSales(Date.now() - WINDOW_MS);
  for (const sale of expired) {
    await db.updatePendingSaleStatut(sale.id, 'expire');
    await editAlertMessage(client, sale, '⏰ Vente expirée — aucune action', 0x95A5A6);
  }
}

// ─── COMMANDES SLASH ─────────────────────────────────────────────────────────

/** Déclare les commandes `/adduser`, `/removeuser`, `/listusers`. */
export function getCommands() {
  return [
    {
      data: new SlashCommandBuilder()
        .setName('adduser')
        .setDescription('Associe un nom en jeu à un membre Discord')
        .addStringOption(opt => opt.setName('nom_jeu').setDescription("Nom exact tel qu'il apparaît dans les logs coffre").setRequired(true))
        .addUserOption(opt => opt.setName('membre').setDescription('Membre Discord correspondant').setRequired(true)),
    },
    {
      data: new SlashCommandBuilder()
        .setName('removeuser')
        .setDescription("Supprime l'association nom en jeu ↔ Discord")
        .addStringOption(opt => opt.setName('nom_jeu').setDescription('Nom en jeu à dissocier').setRequired(true))
        .addUserOption(opt => opt.setName('membre').setDescription('Membre Discord à dissocier (requis si plusieurs comptes pour ce nom)').setRequired(false)),
    },
    {
      data: new SlashCommandBuilder().setName('listusers').setDescription('Liste toutes les associations nom en jeu ↔ Discord'),
    },
  ];
}

/** `/adduser` (admin) : associe un nom en jeu à un membre Discord. */
export async function handleAddUserCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction.member)) { await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral }); return; }
  const nomJeu = interaction.options.getString('nom_jeu', true).trim();
  const membre = interaction.options.getUser('membre', true);
  const existing = await db.getUserMappings(nomJeu);
  if (existing.includes(membre.id)) {
    await interaction.reply({ content: `⚠️ **${nomJeu}** est déjà associé à <@${membre.id}>.`, flags: MessageFlags.Ephemeral });
    return;
  }
  await db.setUserMapping(nomJeu, membre.id);
  await interaction.reply({ content: `✅ **${nomJeu}** associé à <@${membre.id}>.`, flags: MessageFlags.Ephemeral });
}

/** `/removeuser` (admin) : dissocie un nom en jeu d'un membre Discord (ou de tous les comptes associés si aucun membre n'est précisé et qu'il n'y en a qu'un). */
export async function handleRemoveUserCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction.member)) { await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral }); return; }
  const nomJeu = interaction.options.getString('nom_jeu', true).trim();
  const membre = interaction.options.getUser('membre');
  const existing = await db.getUserMappings(nomJeu);

  if (existing.length === 0) {
    await interaction.reply({ content: `❌ Aucune association trouvée pour **${nomJeu}**.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!membre && existing.length > 1) {
    const mentions = existing.map(id => `<@${id}>`).join(', ');
    await interaction.reply({ content: `⚠️ Plusieurs comptes associés à **${nomJeu}** : ${mentions}\nPrécise le membre à dissocier.`, flags: MessageFlags.Ephemeral });
    return;
  }
  const targetId = membre ? membre.id : null;
  await db.deleteUserMapping(nomJeu, targetId);
  const who = membre ? `<@${membre.id}>` : 'tous les comptes';
  await interaction.reply({ content: `✅ Association **${nomJeu}** → ${who} supprimée.`, flags: MessageFlags.Ephemeral });
}

/** `/listusers` (admin) : liste toutes les associations nom en jeu ↔ Discord. */
export async function handleListUsersCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction.member)) { await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral }); return; }
  const mappings = await db.getAllUserMappings();
  if (!mappings.length) {
    await interaction.reply({ content: '❌ Aucune association enregistrée.', flags: MessageFlags.Ephemeral });
    return;
  }
  const lines = mappings.map(m => `**${m.gameName}** → <@${m.discordId}>`);
  const embed = new EmbedBuilder().setTitle('🔗 Associations nom en jeu ↔ Discord').setColor(0x2b2d31).setDescription(lines.join('\n'));
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
