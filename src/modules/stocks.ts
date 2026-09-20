/**
 * @file src/modules/stocks.ts
 * @description Surveillance et gestion des stocks d'items du serveur FiveM.
 *
 * Écoute les salons `logs_coffres`/`logs_coffres_admin` (configurables via
 * `/config channel add-log-coffre`/`add-log-coffre-admin`) dans lesquels le
 * bot de jeu FiveM poste automatiquement les opérations de coffre : "Joueur
 * a retiré 50x Cannabis".
 *
 * La liste des items suivis, leurs regroupements d'affichage (STOCK_GROUPS)
 * et leur éligibilité à la vente ne sont plus codés en dur : ils viennent de
 * `/config item` (voir src/modules/config.ts) — tout item absent de cette
 * liste est silencieusement ignoré lors du parsing des logs (piège n°1 déjà
 * documenté dans le projet source : vérifier l'orthographe EXACTE des logs
 * FiveM avant d'ajouter un item).
 */
import { EmbedBuilder, SlashCommandBuilder, MessageFlags, ChannelType, type Client, type Message, type ChatInputCommandInteraction, type AutocompleteInteraction, type TextBasedChannel } from 'discord.js';
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

/**
 * Alerte dans `admin` qu'un joueur sans compte Discord mappé vient de
 * retirer/déposer un item suivi — quel que soit l'item, pas seulement les
 * drogues, pour ne jamais perdre la correspondance avec un membre. Seulement
 * pour les mouvements en temps réel (voir `handleMessage`) : le rattrapage au
 * démarrage et la resync ne l'appellent pas, pour ne pas flooder `admin` avec
 * des mouvements passés (même principe que `ventes.onStockEntry`).
 */
async function alertJoueurNonMappe(client: Client, guildId: string, entry: StockEntry): Promise<void> {
  const channelId = configStore.get(guildId).CHANNELS.admin;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isSendable()) return;

  const verbe = entry.action === 'retire' ? 'retiré' : 'déposé';
  const embed = new EmbedBuilder()
    .setTitle('⚠️ Joueur non mappé')
    .setColor(0xED4245)
    .setDescription(`**${entry.joueur}** n'est associé à aucun compte Discord.\nUtilisez \`/adduser\` pour le lier.`)
    .addFields({ name: 'Contexte', value: `A ${verbe} ${entry.quantite.toLocaleString('fr-FR')} × ${entry.item}` })
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => null);
}

/**
 * Salons `logs_coffres`/`logs_coffres_admin` surveillés — les deux listes sont
 * traitées de façon identique ici, `logs_coffres_admin` obtenant en plus le
 * badge 🛡️ (voir `logStockToChannel`). Un salon donné n'appartient normalement
 * qu'à UNE SEULE des deux listes (voir `handleChannel` dans `modules/config.ts`,
 * qui rejette l'ajout à l'un des deux rôles si déjà présent dans l'autre) —
 * le `Set` ici est un filet de sécurité pur (ex. données historiques
 * antérieures à cette règle), pas la garantie principale : sans lui, un salon
 * cumulant les deux rôles serait traité deux fois par `catchUpMissedMessages`
 * et `fullResync`, doublant ses mouvements de stock à chaque
 * redémarrage/`/sync-stock` (`handleMessage`, un simple test d'appartenance,
 * n'est lui pas affecté par un éventuel cumul).
 */
function coffreLogChannelIds(guildId: string): string[] {
  const c = configStore.get(guildId).CHANNELS;
  return [...new Set([...c.logs_coffres, ...c.logs_coffres_admin])];
}

/** Point d'entrée temps réel : traite un nouveau message posté dans un salon `logs_coffres`/`logs_coffres_admin` suivi. */
export async function handleMessage(message: Message): Promise<void> {
  const guildId = message.guildId;
  if (!guildId || !coffreLogChannelIds(guildId).includes(message.channelId)) return;

  await db.setSetting(guildId, `last_stock_msg_${message.channelId}`, message.id);

  const entries = await parseAndApplyAll(guildId, extractText(message), message.channelId, true);
  if (entries.length > 0) {
    // `entry.item` est déjà en minuscules (voir parseAndApply) — comparé tel
    // quel aux items affichés dans l'armurerie (groupe munitions de pistolet
    // + munitions SMG, hors groupe) pour éviter de la rafraîchir sur un
    // mouvement qui n'a rien à voir (voir docstring de updateStockMessage).
    const munitionsItems = new Set([
      ...(configStore.get(guildId).STOCK_GROUPS[armurerie.MUNITIONS_STOCK_GROUP] ?? []),
      armurerie.MUNITIONS_SMG_ITEM,
    ].map(i => i.toLowerCase()));
    const toucheMunitions = entries.some(e => munitionsItems.has(e.item));
    await updateStockMessage(message.client, guildId, { skipArmurerie: !toucheMunitions });
    if (toucheMunitions) await armurerie.updatePermanentMessage(message.client, guildId);
    for (const entry of entries) {
      await logStockToChannel(message.client, guildId, entry, message.channelId);
      if (!(await db.getUserMappings(guildId, entry.joueur)).length) {
        await alertJoueurNonMappe(message.client, guildId, entry);
      }
      await ventes.onStockEntry(message.client, guildId, entry);
    }
  }
}

// ─── RATTRAPAGE AU DÉMARRAGE ──────────────────────────────────────────────────

/**
 * Rejoue les messages de stock publiés pendant le downtime. Ne déclenche PAS
 * le module ventes (évite de flooder les alertes sur des mouvements passés).
 */
export async function catchUpMissedMessages(client: Client, guildId: string): Promise<number> {
  let total = 0;

  for (const channelId of coffreLogChannelIds(guildId)) {
    const lastId = await db.getSetting(guildId, `last_stock_msg_${channelId}`);
    if (!lastId) continue;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) continue;

    const messages = await fetchMessagesAfter(channel, lastId);
    for (const msg of messages) {
      await db.setSetting(guildId, `last_stock_msg_${channelId}`, msg.id);
      total += (await parseAndApplyAll(guildId, extractText(msg), channelId, true)).length;
    }
  }

  if (total > 0) {
    console.log(`[stocks] Rattrapage (${guildId}) : ${total} message(s) manqué(s) traité(s)`);
    await updateStockMessage(client, guildId);
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
async function logStockToChannel(client: Client, guildId: string, entry: StockEntry, sourceChannelId?: string): Promise<void> {
  const c = configStore.get(guildId);
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
    const badge = sourceChannelId && c.CHANNELS.logs_coffres_admin.includes(sourceChannelId) ? '🛡️ ' : '';

    await channel.send(`${badge}${icon} **${entry.joueur}** ${sign}${qte} ${item} | \`${avant}\` ➜ \`${apres}\``).catch(() => null);
  } catch { /* silence */ }
}

/** Extrait le texte analysable d'un message (content, sinon descriptions d'embeds concaténées). */
function extractText(msg: Message): string {
  if (msg.content) return msg.content;
  return msg.embeds.map(e => e.description || '').filter(Boolean).join('\n');
}

// ─── PARSING D'UNE LIGNE ─────────────────────────────────────────────────────

/**
 * Parse une ligne de log de coffre (retrait/dépôt) et applique le delta au
 * stock si l'item est suivi ; `false` si la ligne ne matche rien ou que
 * l'item est inconnu (voir piège n°1 du projet : orthographe exacte).
 * `channelId` : salon `logs_coffres` d'origine — le delta est appliqué à la
 * fois au total global (`Stock`, inchangé) ET au détail par coffre
 * (`CoffreStock`, voir README section Interopérabilité), dans une seule
 * transaction DB (voir `db.applyStockAndCoffreDelta`) — jamais l'un sans
 * l'autre, y compris en cas de crash entre les deux écritures.
 */
async function parseAndApply(guildId: string, line: string, channelId: string, log = false): Promise<StockEntry | false> {
  const retireMatch = line.match(RE_RETIRE);
  const deposeMatch = line.match(RE_DEPOSE);
  if (!retireMatch && !deposeMatch) return false;

  const match = retireMatch || deposeMatch!;
  const joueur = match[1].replace(/\*\*/g, '').trim();
  const quantite = parseInt(match[2], 10);
  const item = match[3].trim().toLowerCase().replace(/\s*\([^)]*\)$/, '');

  const allowedLower = configStore.get(guildId).ALLOWED_ITEMS.map(i => i.toLowerCase());
  if (!allowedLower.includes(item)) return false;

  const action: 'retire' | 'depose' = retireMatch ? 'retire' : 'depose';
  const delta = retireMatch ? -quantite : quantite;
  const { avant: stockAvant, apres: stockApres } = await db.applyStockAndCoffreDelta(guildId, channelId, item, delta);

  const entry: StockEntry = { joueur, action, item, quantite, stock_avant: stockAvant, stock_apres: stockApres };

  if (log) await db.addStockHistory(guildId, { timestamp: Date.now(), ...entry, channel_id: channelId });

  return entry;
}

/** Applique `parseAndApply` à chaque ligne d'un contenu de message et retourne les mouvements de stock effectivement appliqués. */
async function parseAndApplyAll(guildId: string, content: string, channelId: string, log = false): Promise<StockEntry[]> {
  const entries: StockEntry[] = [];
  for (const line of content.split('\n')) {
    const entry = await parseAndApply(guildId, line, channelId, log);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ─── RESYNC COMPLÈTE DEPUIS LE DÉBUT ─────────────────────────────────────────

/** Repart de zéro : supprime tout le stock/historique et rejoue l'intégralité de chaque salon suivi. */
export async function fullResync(client: Client, guildId: string): Promise<number> {
  await db.resetAllStocks(guildId);
  await db.clearStockHistory(guildId);

  let total = 0;

  for (const channelId of coffreLogChannelIds(guildId)) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) continue;

    const messages = await fetchMessagesAfter(channel, '0');
    for (const msg of messages) {
      await db.setSetting(guildId, `last_stock_msg_${channelId}`, msg.id);
      total += (await parseAndApplyAll(guildId, extractText(msg), channelId, true)).length;
    }
  }

  console.log(`[stocks] Resync complet (${guildId}) : ${total} mouvement(s) traité(s)`);
  await updateStockMessage(client, guildId);
  return total;
}

// ─── MESSAGE PERMANENT ────────────────────────────────────────────────────────

/**
 * Édite le message permanent "Stock Général" (ou le crée s'il n'existe pas
 * encore/plus), puis rafraîchit l'embed armurerie (munitions) par défaut.
 *
 * `skipArmurerie` : à ne passer que depuis un point d'entrée à très haute
 * fréquence qui sait déjà que le mouvement ne concerne pas les munitions
 * (voir `handleMessage`) — sans ça, `armurerie.updatePermanentMessage`
 * (plusieurs requêtes DB + un edit Discord) se déclencherait à CHAQUE
 * mouvement de coffre, quel que soit l'item, même pour un retrait d'ATM ou
 * de drogue sans aucun rapport. Tous les autres appelants (resync, correction
 * manuelle, changement de salon/tier…) sont rares et gagnent à rester
 * simples : ils laissent le défaut rafraîchir armurerie systématiquement.
 */
export async function updateStockMessage(client: Client, guildId: string, opts: { skipArmurerie?: boolean } = {}): Promise<void> {
  const c = configStore.get(guildId);
  if (c.CHANNELS.stock_general) {
    try {
      const channel = await client.channels.fetch(c.CHANNELS.stock_general).catch(() => null);
      if (channel?.isSendable()) {
        const stocks = await db.getAllStocks(guildId);
        const embed = buildStockEmbed(guildId, stocks);

        const storedId = await db.getSetting(guildId, 'stock_message_id');
        let edited = false;
        if (storedId) {
          const msg = await channel.messages.fetch(storedId).catch(() => null);
          if (msg) { await msg.edit({ embeds: [embed] }); edited = true; }
        }
        if (!edited) {
          const newMsg = await channel.send({ embeds: [embed] });
          await db.setSetting(guildId, 'stock_message_id', newMsg.id);
        }
      }
    } catch (err) {
      console.error(`[stocks] updateStockMessage(${guildId}):`, (err as Error).message);
    }
  }

  if (!opts.skipArmurerie) await armurerie.updatePermanentMessage(client, guildId);
}

/** Construit l'embed affichant l'état actuel des stocks, avec regroupements STOCK_GROUPS. */
function buildStockEmbed(guildId: string, stocks: Array<{ item: string; quantite: number }>): EmbedBuilder {
  const c = configStore.get(guildId);
  const embed = new EmbedBuilder().setTitle('📦 Stock Général').setColor(0x2b2d31).setTimestamp().setFooter({ text: 'Dernière mise à jour' });

  const stockMap: Record<string, number> = {};
  for (const s of stocks) stockMap[s.item] = s.quantite;

  const itemToGroup: Record<string, string> = {};
  for (const [label, items] of Object.entries(c.STOCK_GROUPS)) {
    for (const item of items) itemToGroup[item.toLowerCase()] = label;
  }

  // Un item `visibleStock: false` reste suivi (stock à jour, historique,
  // groupes...) mais n'apparaît jamais dans ce message — ni seul, ni via le
  // total d'un groupe auquel il appartiendrait.
  const isVisible = (item: string) => c.ITEMS_BY_NAME[item]?.visibleStock !== false;

  // Un item lié à un labo (`laboLie` non nul) n'apparaît JAMAIS dans le corps
  // principal, que son labo soit actif pour le tier courant ou non : actif,
  // il est déjà montré via VENTE_ITEMS/LABO_ITEMS/MATERIAL_ITEMS (voir
  // itemsAffichesAilleurs ci-dessous) ; inactif pour ce tier, il doit rester
  // totalement invisible (pas de repli en item générique) — un item créé
  // pour un labo d'un autre tier ne doit apparaître nulle part tant que ce
  // tier n'est pas sélectionné.
  const hasLaboLie = (item: string) => !!c.ITEMS_BY_NAME[item]?.laboLie;

  // Un item actuellement dans VENTE_ITEMS/LABO_ITEMS/MATERIAL_ITEMS est
  // TOUJOURS exclu du corps principal, indépendamment de `visibleStock` : il
  // est déjà montré via l'un des trois champs dédiés ci-dessous, jamais deux
  // fois (VENTE_ITEMS/LABO_ITEMS sont mutuellement exclusifs entre eux, voir
  // config-store.ts ; MATERIAL_ITEMS ne recoupe ni l'un ni l'autre, un item
  // n'ayant qu'un seul rôle labo_lie_role à la fois). Sans ça, oublier
  // `stock_general:false` sur un item vente_pnj/labo_lie le ferait apparaître
  // en double sur ce même message.
  const itemsAffichesAilleurs = new Set([...c.VENTE_ITEMS, ...c.LABO_ITEMS, ...c.MATERIAL_ITEMS].map(i => i.toLowerCase()));

  const lines: string[] = [];
  const shownGroups = new Set<string>();

  for (const item of c.ALLOWED_ITEMS) {
    if (!isVisible(item) || itemsAffichesAilleurs.has(item.toLowerCase()) || hasLaboLie(item)) continue;
    const lower = item.toLowerCase();
    const group = itemToGroup[lower];

    if (group) {
      if (shownGroups.has(group)) continue;
      shownGroups.add(group);
      const groupItems = c.STOCK_GROUPS[group].filter(i => isVisible(i) && !itemsAffichesAilleurs.has(i.toLowerCase()) && !hasLaboLie(i));
      const total = armurerie.weightedStockSum(groupItems, stockMap, c.ITEMS_BY_NAME);
      // Traité comme un item classique (pas de gras) : dans cette liste sans
      // titre de catégorie ni séparation, mettre ce total en avant n'aurait
      // pas de sens — contrairement aux 3 champs dédiés plus bas, qui ont
      // leur propre titre et une séparation avant le Total.
      lines.push(`${group} : \`${total.toLocaleString('fr-FR')}\``);
    } else {
      const qty = stockMap[lower] || 0;
      lines.push(`${item} : \`${qty.toLocaleString('fr-FR')}\``);
    }
  }

  embed.setDescription(lines.length ? lines.join('\n') : '*Aucun stock enregistré*');

  // Drogues à vendre : détail par item ayant un stock > 0 (le détail
  // complet, items à 0 compris, reste consultable via `/drogues-a-vendre`) +
  // un total — même format que Drogues de production ci-dessous. Les listes
  // sont dynamiques (dépendent du tier — voir VENTE_ITEMS/LABO_ITEMS/
  // MATERIAL_ITEMS dans config-store.ts) et mutuellement exclusives.
  // Format commun aux 3 champs ci-dessous : items en clair (pas de gras,
  // pour bien les distinguer du Total), pas de ligne blanche avant le Total
  // en gras.
  // Triées par quantité croissante (la moins stockée en premier) — pas
  // l'ordre de VENTE_ITEMS, pour repérer d'un coup d'œil ce qui manque le
  // plus (voir aussi handleDroguesAVendreCommand, même règle).
  const venteEnStock = c.VENTE_ITEMS
    .filter(item => (stockMap[item.toLowerCase()] || 0) > 0)
    .sort((a, b) => stockMap[a.toLowerCase()] - stockMap[b.toLowerCase()]);
  if (venteEnStock.length) {
    const venteLines = venteEnStock.map(item => `${item} : \`${stockMap[item.toLowerCase()].toLocaleString('fr-FR')}\``);
    const total = venteEnStock.reduce((sum, item) => sum + stockMap[item.toLowerCase()], 0);
    embed.addFields({
      name: '💊 Drogues à vendre',
      value: `${venteLines.join('\n')}\n**Total : \`${total.toLocaleString('fr-FR')}\`**`,
    });
  }

  if (c.LABO_ITEMS.length) {
    const laboLines = c.LABO_ITEMS.map(item => `${item} : \`${(stockMap[item.toLowerCase()] || 0).toLocaleString('fr-FR')}\``);
    const total = c.LABO_ITEMS.reduce((sum, item) => sum + (stockMap[item.toLowerCase()] || 0), 0);
    embed.addFields({
      name: '🧪 Drogues de production',
      value: `${laboLines.join('\n')}\n**Total : \`${total.toLocaleString('fr-FR')}\`**`,
    });
  }

  // Matériaux de production : détail par item sans total (contrairement aux
  // deux champs ci-dessus) — des matières premières hétérogènes n'ont pas de
  // somme qui fasse sens ensemble. Dépend du tier comme Drogues de
  // production (voir MATERIAL_ITEMS dans config-store.ts).
  if (c.MATERIAL_ITEMS.length) {
    const materialLines = c.MATERIAL_ITEMS.map(item => `${item} : \`${(stockMap[item.toLowerCase()] || 0).toLocaleString('fr-FR')}\``);
    embed.addFields({ name: '🧱 Matériaux de production', value: materialLines.join('\n') });
  }

  return embed;
}

/** Met la première lettre en majuscule. */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────

/** Déclare les commandes `/set-stock`, `/coffre-stock`, `/historique-stock`, `/sync-stock`, `/drogues-a-vendre`. */
export function getCommands() {
  return [
    {
      data: new SlashCommandBuilder()
        .setName('set-stock')
        .setDescription("Force la valeur du stock d'un item (correction manuelle, admin)")
        .addStringOption(opt => opt.setName('item').setDescription("L'item à corriger").setRequired(true).setAutocomplete(true))
        .addIntegerOption(opt => opt.setName('quantite').setDescription('Nouvelle valeur du stock').setRequired(true).setMinValue(0))
        .addChannelOption(opt => opt.setName('coffre').setDescription('Le coffre à corriger (le total global suit le même delta)').setRequired(true)
          .addChannelTypes(ChannelType.GuildText)),
    },
    {
      data: new SlashCommandBuilder()
        .setName('coffre-stock')
        .setDescription("Affiche le détail du stock d'un coffre précis (admin)")
        .addChannelOption(opt => opt.setName('coffre').setDescription('Le salon coffre à consulter').setRequired(true)
          .addChannelTypes(ChannelType.GuildText)),
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

/** Autocomplete des options `item` (`/set-stock`, `/historique-stock`) sur `ALLOWED_ITEMS`. */
export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const matches = configStore.get(interaction.guildId!).ALLOWED_ITEMS
    .filter(i => i.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(i => ({ name: i, value: i.toLowerCase() }));
  await interaction.respond(matches).catch(() => null);
}

/** `/set-stock` (admin) : force la valeur du stock d'un item (correction manuelle). */
export async function handleSetStockCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  if (!isAdmin(guildId, interaction.member)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
    return;
  }

  const item = interaction.options.getString('item', true);
  const quantite = interaction.options.getInteger('quantite', true);
  const coffre = interaction.options.getChannel('coffre', true);
  const itemLabel = configStore.get(guildId).ALLOWED_ITEMS.find(i => i.toLowerCase() === item) || item;

  // Corrige CE coffre précis (SET absolu) et répercute le même delta sur le
  // total global — cohérent avec le fait qu'un mouvement réel met à jour les
  // deux compteurs en parallèle du même delta (voir parseAndApply). `coffre`
  // obligatoire : un ancien chemin "sans coffre" écrasait directement le
  // total global (db.setStock) sans jamais le rattacher à un CoffreStock,
  // faisant diverger le total de la somme des coffres connus dès qu'on
  // mélangeait les deux usages sur un même item.
  const { avant, apres } = await db.setCoffreStock(guildId, coffre.id, item, quantite);
  const delta = apres - avant;
  if (delta !== 0) await db.applyStockDelta(guildId, item, delta);
  await updateStockMessage(interaction.client, guildId);
  await interaction.reply({
    content: `✅ Stock de **${itemLabel}** corrigé pour <#${coffre.id}> : \`${avant.toLocaleString('fr-FR')}\` → \`${apres.toLocaleString('fr-FR')}\` (total global ajusté du même delta).`,
    flags: MessageFlags.Ephemeral,
  });
}

/** `/coffre-stock` (admin) : détail du stock d'un coffre précis — liste vide (pas d'erreur) si ce salon n'a encore aucun mouvement enregistré. */
export async function handleCoffreStockCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  if (!isAdmin(guildId, interaction.member)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
    return;
  }

  const coffre = interaction.options.getChannel('coffre', true);
  // Le nom assigné au coffre (option `nom` de add-log-coffre/-admin) prime
  // sur le nom du salon Discord, quand il existe — plus lisible pour
  // distinguer plusieurs coffres du même rôle (voir /config channel list).
  const [normaux, adminCoffres] = await Promise.all([
    db.getChannelsWithLabel(guildId, 'logs_coffres'),
    db.getChannelsWithLabel(guildId, 'logs_coffres_admin'),
  ]);
  const entry = normaux.find(ch => ch.channelId === coffre.id) ?? adminCoffres.find(ch => ch.channelId === coffre.id);
  const suivi = !!entry;
  const displayName = entry?.label || coffre.name;

  const rows = await db.getCoffreStocks(guildId, coffre.id);
  const embed = new EmbedBuilder()
    .setTitle(`📦 Stock — ${displayName}`)
    .setColor(0x2b2d31);

  if (!suivi) {
    embed.setDescription(`⚠️ Ce salon n'est pas configuré comme coffre suivi (\`/config channel add-log-coffre\`/\`add-log-coffre-admin\`)${rows.length ? ' — figures ci-dessous issues de mouvements passés :' : ', aucune donnée.'}`);
  }

  if (rows.length) {
    const lines = rows.map(r => `**${capitalize(r.item)}** : \`${r.quantite.toLocaleString('fr-FR')}\``);
    embed.addFields({ name: suivi ? 'Détail' : '​', value: lines.join('\n') });
  } else if (suivi) {
    embed.setDescription('Aucun mouvement enregistré pour ce coffre pour le moment.');
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/** `/historique-stock` : affiche les derniers mouvements de stock, filtrés par item si fourni. */
export async function handleHistoriqueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const item = interaction.options.getString('item') || null;
  const lignes = interaction.options.getInteger('lignes') || 20;

  const rows = await db.getRecentStockHistory(guildId, item, lignes);
  if (!rows.length) {
    await interaction.reply({ content: '❌ Aucun mouvement enregistré.', flags: MessageFlags.Ephemeral });
    return;
  }

  const lines = rows.map(r => {
    const d = new Date(r.timestamp).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
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

/** `/sync-stock` (admin) : resynchronise entièrement les stocks depuis le début de chaque salon `logs_coffres` suivi. */
export async function handleSyncStockCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  if (!isAdmin(guildId, interaction.member)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const total = await fullResync(interaction.client, guildId);
  await interaction.editReply({ content: `✅ Resync terminé — **${total}** mouvement(s) traité(s).` });
}

/** `/drogues-a-vendre` (admin) : détail par item + total du stock des items actuellement vendables en PNJ (`VENTE_ITEMS`, dépend du tier — voir docstring de config-store.ts). */
export async function handleDroguesAVendreCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  if (!isAdmin(guildId, interaction.member)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
    return;
  }

  const venteItems = configStore.get(guildId).VENTE_ITEMS;
  const quantities: Array<{ item: string; qty: number }> = [];
  for (const item of venteItems) quantities.push({ item, qty: await db.getStock(guildId, item) });
  // Triées par quantité croissante (la moins stockée en premier) — même règle
  // que le champ "💊 Drogues à vendre" du Stock Général (voir buildStockEmbed).
  quantities.sort((a, b) => a.qty - b.qty);
  const total = quantities.reduce((sum, { qty }) => sum + qty, 0);
  const lines = quantities.map(({ item, qty }) => `**${item}** : \`${qty.toLocaleString('fr-FR')}\``);

  const embed = new EmbedBuilder()
    .setTitle('💊 Drogues à vendre')
    .setColor(0xFEE75C)
    .setDescription(lines.join('\n') || '*Aucun item de vente configuré (voir /config item add vente_pnj:True)*')
    .addFields({ name: 'Total', value: `\`${total.toLocaleString('fr-FR')}\`` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
