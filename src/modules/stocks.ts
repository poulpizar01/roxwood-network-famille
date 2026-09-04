/**
 * @file src/modules/stocks.ts
 * @description Surveillance et gestion des stocks d'items du serveur FiveM.
 *
 * Écoute les salons `logs_coffres` (configurables via `/config channel
 * add-log-coffre`) dans lesquels le bot de jeu FiveM poste automatiquement
 * les opérations de coffre : "Joueur a retiré 50x Cannabis".
 *
 * La liste des items suivis, leurs regroupements d'affichage (STOCK_GROUPS)
 * et leur éligibilité à la vente ne sont plus codés en dur : ils viennent de
 * `/config item` (voir src/modules/config.ts) — tout item absent de cette
 * liste est silencieusement ignoré lors du parsing des logs (piège n°1 déjà
 * documenté dans le projet source : vérifier l'orthographe EXACTE des logs
 * FiveM avant d'ajouter un item).
 */
import { EmbedBuilder, SlashCommandBuilder, MessageFlags, type Client, type Message, type ChatInputCommandInteraction, type AutocompleteInteraction, type TextBasedChannel } from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';
import { isAdmin } from '../permissions';
import * as ventes from './ventes';
import * as armurerie from './armurerie';

const RE_RETIRE = /^(.+) a retiré (\d+)\s*[xX] (.+)$/im;
const RE_DEPOSE = /^(.+) a déposé (\d+)\s*[xX] (.+)$/im;

export interface StockEntry {
  joueur: string;
  action: 'retire' | 'depose';
  item: string;
  quantite: number;
  stock_avant: number;
  stock_apres: number;
}

// ─── NOUVEAU MESSAGE ──────────────────────────────────────────────────────────

export async function handleMessage(message: Message): Promise<void> {
  if (!configStore.get().CHANNELS.logs_coffres.includes(message.channelId)) return;

  await db.setSetting(`last_stock_msg_${message.channelId}`, message.id);

  const entries = await parseAndApplyAll(extractText(message), true);
  if (entries.length > 0) {
    await updateStockMessage(message.client);
    for (const entry of entries) {
      await logStockToChannel(message.client, entry, message.channelId);
      await ventes.onStockEntry(message.client, entry);
    }
  }
}

// ─── RATTRAPAGE AU DÉMARRAGE ──────────────────────────────────────────────────

/**
 * Rejoue les messages de stock publiés pendant le downtime. Ne déclenche PAS
 * le module ventes (évite de flooder les alertes sur des mouvements passés).
 */
export async function catchUpMissedMessages(client: Client): Promise<number> {
  let total = 0;

  for (const channelId of configStore.get().CHANNELS.logs_coffres) {
    const lastId = await db.getSetting(`last_stock_msg_${channelId}`);
    if (!lastId) continue;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) continue;

    const messages = await fetchMessagesAfter(channel, lastId);
    for (const msg of messages) {
      await db.setSetting(`last_stock_msg_${channelId}`, msg.id);
      total += (await parseAndApplyAll(extractText(msg), true)).length;
    }
  }

  if (total > 0) {
    console.log(`[stocks] Rattrapage : ${total} message(s) manqué(s) traité(s)`);
    await updateStockMessage(client);
  }
  return total;
}

/** Récupère tous les messages d'un salon postés après un ID donné, du plus ancien au plus récent. */
async function fetchMessagesAfter(channel: Extract<TextBasedChannel, { messages: unknown }>, afterId: string): Promise<Message[]> {
  const collected: Message[] = [];
  let cursor = afterId;

  while (true) {
    let batch;
    try {
      batch = await channel.messages.fetch({ limit: 100, after: cursor });
    } catch {
      break;
    }
    if (!batch.size) break;

    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    collected.push(...sorted);

    if (batch.size < 100) break;
    cursor = sorted[sorted.length - 1].id;
  }

  return collected;
}

/** Poste une ligne de log dans `historique_stock` pour un mouvement donné. */
async function logStockToChannel(client: Client, entry: StockEntry, sourceChannelId?: string): Promise<void> {
  const c = configStore.get();
  if (!c.CHANNELS.historique_stock) return;
  try {
    const channel = await client.channels.fetch(c.CHANNELS.historique_stock).catch(() => null);
    if (!channel || !channel.isSendable()) return;

    const icon = entry.action === 'retire' ? '🔴' : '🟢';
    const sign = entry.action === 'retire' ? '−' : '+';
    const avant = entry.stock_avant.toLocaleString('fr-FR');
    const apres = entry.stock_apres.toLocaleString('fr-FR');
    const qte = entry.quantite.toLocaleString('fr-FR');
    const item = capitalize(entry.item);
    const badge = sourceChannelId && sourceChannelId === c.CHANNELS.coffre_admin ? '🛡️ ' : '';

    await channel.send(`${badge}${icon} **${entry.joueur}** ${sign}${qte} ${item} | \`${avant}\` ➜ \`${apres}\``).catch(() => null);
  } catch { /* silence */ }
}

/** Extrait le texte analysable d'un message (content, sinon descriptions d'embeds concaténées). */
function extractText(msg: Message): string {
  if (msg.content) return msg.content;
  return msg.embeds.map(e => e.description || '').filter(Boolean).join('\n');
}

// ─── PARSING D'UNE LIGNE ─────────────────────────────────────────────────────

async function parseAndApply(line: string, log = false): Promise<StockEntry | false> {
  const retireMatch = line.match(RE_RETIRE);
  const deposeMatch = line.match(RE_DEPOSE);
  if (!retireMatch && !deposeMatch) return false;

  const match = retireMatch || deposeMatch!;
  const joueur = match[1].replace(/\*\*/g, '').trim();
  const quantite = parseInt(match[2], 10);
  const item = match[3].trim().toLowerCase().replace(/\s*\([^)]*\)$/, '');

  const allowedLower = configStore.get().ALLOWED_ITEMS.map(i => i.toLowerCase());
  if (!allowedLower.includes(item)) return false;

  const action: 'retire' | 'depose' = retireMatch ? 'retire' : 'depose';
  const delta = retireMatch ? -quantite : quantite;
  const stockAvant = await db.getStock(item);
  const stockApres = await db.updateStock(item, delta);

  const entry: StockEntry = { joueur, action, item, quantite, stock_avant: stockAvant, stock_apres: stockApres };

  if (log) await db.addStockHistory({ timestamp: Date.now(), ...entry });

  return entry;
}

async function parseAndApplyAll(content: string, log = false): Promise<StockEntry[]> {
  const entries: StockEntry[] = [];
  for (const line of content.split('\n')) {
    const entry = await parseAndApply(line, log);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ─── RESYNC COMPLÈTE DEPUIS LE DÉBUT ─────────────────────────────────────────

/** Repart de zéro : supprime tout le stock/historique et rejoue l'intégralité de chaque salon suivi. */
export async function fullResync(client: Client): Promise<number> {
  await db.resetAllStocks();
  await db.clearStockHistory();

  let total = 0;

  for (const channelId of configStore.get().CHANNELS.logs_coffres) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) continue;

    const messages = await fetchMessagesAfter(channel, '0');
    for (const msg of messages) {
      await db.setSetting(`last_stock_msg_${channelId}`, msg.id);
      total += (await parseAndApplyAll(extractText(msg), true)).length;
    }
  }

  console.log(`[stocks] Resync complet : ${total} mouvement(s) traité(s)`);
  await updateStockMessage(client);
  return total;
}

// ─── MESSAGE PERMANENT ────────────────────────────────────────────────────────

export async function updateStockMessage(client: Client): Promise<void> {
  const c = configStore.get();
  if (c.CHANNELS.stock_general) {
    try {
      const channel = await client.channels.fetch(c.CHANNELS.stock_general).catch(() => null);
      if (channel?.isSendable()) {
        const stocks = await db.getAllStocks();
        const embed = buildStockEmbed(stocks);

        const storedId = await db.getSetting('stock_message_id');
        let edited = false;
        if (storedId) {
          const msg = await channel.messages.fetch(storedId).catch(() => null);
          if (msg) { await msg.edit({ embeds: [embed] }); edited = true; }
        }
        if (!edited) {
          const newMsg = await channel.send({ embeds: [embed] });
          await db.setSetting('stock_message_id', newMsg.id);
        }
      }
    } catch (err) {
      console.error('[stocks] updateStockMessage:', (err as Error).message);
    }
  }

  // Les munitions sont affichées dans l'embed armurerie — rafraîchi à chaque mouvement.
  await armurerie.updatePermanentMessage(client);
}

/** Construit l'embed affichant l'état actuel des stocks, avec regroupements STOCK_GROUPS. */
function buildStockEmbed(stocks: Array<{ item: string; quantite: number }>): EmbedBuilder {
  const c = configStore.get();
  const embed = new EmbedBuilder().setTitle('📦 Stock Général').setColor(0x2b2d31).setTimestamp().setFooter({ text: 'Dernière mise à jour' });

  const stockMap: Record<string, number> = {};
  for (const s of stocks) stockMap[s.item] = s.quantite;

  const itemToGroup: Record<string, string> = {};
  for (const [label, items] of Object.entries(c.STOCK_GROUPS)) {
    for (const item of items) itemToGroup[item.toLowerCase()] = label;
  }

  const lines: string[] = [];
  const shownGroups = new Set<string>();

  for (const item of c.ALLOWED_ITEMS) {
    const lower = item.toLowerCase();
    const group = itemToGroup[lower];

    if (group) {
      if (shownGroups.has(group)) continue;
      shownGroups.add(group);
      const total = c.STOCK_GROUPS[group].reduce((sum, i) => sum + (stockMap[i.toLowerCase()] || 0), 0);
      lines.push(`**${group}** : \`${total.toLocaleString('fr-FR')}\``);
    } else {
      const qty = stockMap[lower] || 0;
      lines.push(`**${item}** : \`${qty.toLocaleString('fr-FR')}\``);
    }
  }

  embed.setDescription(lines.length ? lines.join('\n') : '*Aucun stock enregistré*');
  return embed;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────

export function getCommands() {
  return [
    {
      data: new SlashCommandBuilder()
        .setName('set-stock')
        .setDescription("Force la valeur du stock d'un item (correction manuelle, admin)")
        .addStringOption(opt => opt.setName('item').setDescription("L'item à corriger").setRequired(true).setAutocomplete(true))
        .addIntegerOption(opt => opt.setName('quantite').setDescription('Nouvelle valeur du stock').setRequired(true).setMinValue(0)),
    },
    {
      data: new SlashCommandBuilder()
        .setName('historique-stock')
        .setDescription('Voir les derniers mouvements de stock détectés')
        .addStringOption(opt => opt.setName('item').setDescription('Filtrer par item (optionnel)').setRequired(false).setAutocomplete(true))
        .addIntegerOption(opt => opt.setName('lignes').setDescription('Nombre de lignes (défaut 20, max 50)').setRequired(false).setMinValue(1).setMaxValue(50)),
    },
    {
      data: new SlashCommandBuilder().setName('sync-stock').setDescription('Resynchronise les stocks depuis le début du channel (admin)'),
    },
    {
      data: new SlashCommandBuilder().setName('drogues-a-vendre').setDescription('Afficher le détail des drogues à vendre (admin seulement)'),
    },
  ];
}

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const matches = configStore.get().ALLOWED_ITEMS
    .filter(i => i.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(i => ({ name: i, value: i.toLowerCase() }));
  await interaction.respond(matches).catch(() => null);
}

export async function handleSetStockCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction.member)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
    return;
  }

  const item = interaction.options.getString('item', true);
  const quantite = interaction.options.getInteger('quantite', true);
  const avant = await db.getStock(item);

  await db.setStock(item, quantite);
  await updateStockMessage(interaction.client);

  const itemLabel = configStore.get().ALLOWED_ITEMS.find(i => i.toLowerCase() === item) || item;
  await interaction.reply({
    content: `✅ Stock de **${itemLabel}** corrigé : \`${avant.toLocaleString('fr-FR')}\` → \`${quantite.toLocaleString('fr-FR')}\``,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleHistoriqueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const item = interaction.options.getString('item') || null;
  const lignes = interaction.options.getInteger('lignes') || 20;

  const rows = await db.getRecentStockHistory(item, lignes);
  if (!rows.length) {
    await interaction.reply({ content: '❌ Aucun mouvement enregistré.', flags: MessageFlags.Ephemeral });
    return;
  }

  const lines = rows.map(r => {
    const d = new Date(r.timestamp).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const icon = r.action === 'retire' ? '🔴' : '🟢';
    const sign = r.action === 'retire' ? '−' : '+';
    const avant = r.stockAvant.toLocaleString('fr-FR');
    const apres = r.stockApres.toLocaleString('fr-FR');
    const delta = r.quantite.toLocaleString('fr-FR');
    return `\`${d}\` ${icon} **${r.joueur}** ${sign}${delta} → \`${avant}\` ➜ \`${apres}\``;
  });

  const title = item ? `📦 Historique — ${capitalize(item)}` : '📦 Historique des mouvements de stock';
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > 4000) { chunks.push(current); current = ''; }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);

  const embeds = chunks.map((desc, i) => new EmbedBuilder()
    .setTitle(i === 0 ? title : null)
    .setColor(0x2b2d31)
    .setDescription(desc)
    .setFooter(i === chunks.length - 1 ? { text: `${rows.length} mouvements — du plus récent au plus ancien` } : null));

  await interaction.reply({ embeds, flags: MessageFlags.Ephemeral });
}

export async function handleSyncStockCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction.member)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const total = await fullResync(interaction.client);
  await interaction.editReply({ content: `✅ Resync terminé — **${total}** mouvement(s) traité(s).` });
}

export async function handleDroguesAVendreCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction.member)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
    return;
  }

  const venteItems = configStore.get().VENTE_ITEMS;
  const lines: string[] = [];
  let total = 0;
  for (const item of venteItems) {
    const qty = await db.getStock(item);
    total += qty;
    lines.push(`**${item}** : \`${qty.toLocaleString('fr-FR')}\``);
  }

  const embed = new EmbedBuilder()
    .setTitle('💊 Drogues à vendre')
    .setColor(0xFEE75C)
    .setDescription(lines.join('\n') || '*Aucun item de vente configuré (voir /config item add --vente)*')
    .addFields({ name: 'Total', value: `\`${total.toLocaleString('fr-FR')}\`` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
