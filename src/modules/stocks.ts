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
 * et leur éligibilité à la vente viennent de `/config item` (voir
 * src/modules/config.ts) — tout item absent de cette liste est
 * silencieusement ignoré lors du parsing des logs (piège n°1 : vérifier
 * l'orthographe EXACTE des logs FiveM avant d'ajouter un item).
 *
 * Tout traitement d'un message de log (temps réel, rattrapage, resync) doit
 * tourner dans la file de sa guilde (`guild-queue.ts`) : `handleMessage` et
 * `catchUpMissedMessages` supposent que l'appelant les y a placés (voir
 * `index.ts`), `fullResync` s'y place lui-même.
 */
import { EmbedBuilder, SlashCommandBuilder, MessageFlags, ChannelType, type Client, type Message, type ChatInputCommandInteraction, type AutocompleteInteraction } from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';
import { isAdmin, hasApiAccess } from '../permissions';
import { runExclusive } from '../guild-queue';
import { upsertPanel } from '../permanent-message';
import { fetchPagesAfter } from '../discord-fetch';
import * as ventes from './ventes';
import * as armurerie from './armurerie';

const RE_RETIRE = /^(.+) a retiré (\d+)\s*[xX] (.+)$/im;
const RE_DEPOSE = /^(.+) a déposé (\d+)\s*[xX] (.+)$/im;

/** Mouvement appliqué, avec le stock global avant/après et l'heure du message de log qui l'a décrit. */
export type StockEntry = db.AppliedStockMovement & { timestamp: number };

/** Les effets "en direct" (alertes, ventes en attente) ne valent que pour un message publié pendant que ce process tournait — voir `runSideEffects`. */
const PROCESS_START = Date.now();

/** Au-delà, la ligne est ignorée : la quantité ne tiendrait pas dans une colonne `Int` et ferait échouer tout le message. */
const MAX_QUANTITE_LOG = 1_000_000_000;

/**
 * Salons à rattraper (`${guildId}:${channelId}`) : dernier rattrapage ou
 * dernière écriture en échec, resync interrompue, coupure de connexion à
 * Discord. Tant qu'un salon y figure, un message temps réel n'est pas
 * appliqué directement (il ferait avancer le curseur au-delà des messages
 * jamais appliqués) : il relance le rattrapage du salon, qui le récupère avec
 * les autres.
 */
const needsCatchUp = new Set<string>();

/**
 * Début d'une resync interrompue, par salon. Les messages plus anciens ont
 * déjà eu leurs suites (ventes, alertes) en temps réel avant la resync : leur
 * rattrapage ne doit pas les redéclencher. Les plus récents, eux, ne les ont
 * jamais eues.
 */
const resyncStartedAt = new Map<string, number>();

/** Délai de regroupement des rafraîchissements du Stock Général : Discord limite les éditions d'un message à quelques-unes par seconde. */
const PANEL_REFRESH_DELAY_MS = 3_000;
const pendingPanelRefresh = new Map<string, { timer: ReturnType<typeof setTimeout>; munitions: boolean }>();

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
 * Vrai si le message peut venir du bot de jeu. Un message humain ne déclenche
 * jamais de mouvement (voir Sécurité dans CLAUDE.md) ; la réponse d'une
 * commande d'application est elle aussi écartée : son auteur est bien un bot,
 * mais c'est un membre qui l'a déclenchée, éventuellement avec sa propre
 * application installée, pour faire poster une fausse ligne de log.
 */
export function isGameLogMessage(message: Message): boolean {
  return message.author.bot && !message.interactionMetadata;
}

/**
 * Applique un message de log (mouvements, historique et curseur en une seule
 * transaction, voir `db.applyStockMessage`). `null` si le message avait déjà
 * été appliqué : temps réel et rattrapage peuvent livrer le même. Une erreur
 * d'écriture marque le salon à rattraper avant de remonter : sinon le message
 * suivant ferait avancer le curseur par-dessus celui-ci, perdu pour toujours.
 */
async function applyMessage(guildId: string, message: Message, channelId: string): Promise<StockEntry[] | null> {
  const movements = isGameLogMessage(message) ? parseMessage(guildId, extractText(message)) : [];
  try {
    const applied = await db.applyStockMessage(guildId, channelId, message.id, movements, message.createdTimestamp);
    return applied && applied.map(entry => ({ ...entry, timestamp: message.createdTimestamp }));
  } catch (err) {
    needsCatchUp.add(`${guildId}:${channelId}`);
    throw err;
  }
}

/**
 * Effets d'un message appliqué, hors stock : journal `historique_stock`,
 * alerte "joueur non mappé", cycle de vente. Complets pour un message publié
 * pendant que le process tournait (temps réel, ou rattrapé après une coupure
 * de connexion) ; pour un message plus ancien que le démarrage, seule la
 * confirmation d'une vente déjà déclarée est rejouée — ni alerte ni nouvelle
 * vente en attente sur des mouvements passés. Une entrée en échec n'empêche
 * pas les suivantes.
 */
async function runSideEffects(client: Client, guildId: string, message: Message, channelId: string, entries: StockEntry[]): Promise<void> {
  const live = message.createdTimestamp >= PROCESS_START;
  for (const entry of entries) {
    try {
      if (live) {
        await logStockToChannel(client, guildId, entry, channelId);
        if (!(await db.getUserMappings(guildId, entry.joueur)).length) {
          await alertJoueurNonMappe(client, guildId, entry);
        }
      }
      await ventes.onStockEntry(client, guildId, entry, { replay: !live });
    } catch (err) {
      console.error(`[stocks] suites du mouvement (${guildId}, ${entry.item}) :`, (err as Error).message);
    }
  }
}

/**
 * Programme le rafraîchissement du Stock Général (et de l'armurerie si des
 * munitions ont bougé) quelques secondes plus tard, en regroupant les
 * mouvements d'une rafale : un message de coffre n'attend pas l'édition du
 * panneau, et Discord ne reçoit qu'une édition pour toute la rafale.
 */
function schedulePanelRefresh(client: Client, guildId: string, entries: StockEntry[]): void {
  // `entry.item` est en minuscules (voir parseLine), comme les items comparés ici.
  const munitionsItems = new Set([
    ...(configStore.get(guildId).STOCK_GROUPS[armurerie.MUNITIONS_STOCK_GROUP] ?? []),
    armurerie.MUNITIONS_SMG_ITEM,
  ].map(i => i.toLowerCase()));
  const munitions = entries.some(e => munitionsItems.has(e.item));

  const pending = pendingPanelRefresh.get(guildId);
  if (pending) {
    pending.munitions ||= munitions;
    return;
  }
  const entry = {
    munitions,
    timer: setTimeout(() => {
      pendingPanelRefresh.delete(guildId);
      if (!configStore.has(guildId)) return;
      void updateStockMessage(client, guildId, { skipArmurerie: !entry.munitions })
        .then(() => (entry.munitions ? armurerie.updatePermanentMessage(client, guildId) : undefined))
        .catch(err => console.error(`[stocks] rafraîchissement des panneaux (${guildId}) :`, (err as Error).message));
    }, PANEL_REFRESH_DELAY_MS),
  };
  pendingPanelRefresh.set(guildId, entry);
}

/**
 * Point d'entrée temps réel : traite un nouveau message posté dans un salon
 * `logs_coffres`/`logs_coffres_admin` suivi. À appeler dans la file de la
 * guilde.
 */
export async function handleMessage(message: Message): Promise<void> {
  const guildId = message.guildId;
  if (!guildId || !configStore.coffreChannelIds(guildId).includes(message.channelId)) return;
  const client = message.client;

  if (needsCatchUp.has(`${guildId}:${message.channelId}`)) {
    const entries = await catchUpChannel(client, guildId, message.channelId);
    if (entries.length) schedulePanelRefresh(client, guildId, entries);
    return;
  }

  const entries = await applyMessage(guildId, message, message.channelId);
  if (!entries?.length) return;
  await runSideEffects(client, guildId, message, message.channelId, entries);
  schedulePanelRefresh(client, guildId, entries);
}

/**
 * Marque tous les salons de coffre d'une guilde à rattraper — à appeler dès
 * qu'une coupure de connexion à Discord est détectée, AVANT que le moindre
 * message temps réel ne soit traité : le premier d'entre eux relance alors
 * le rattrapage au lieu d'avancer le curseur par-dessus la coupure.
 */
export function markForCatchUp(guildId: string): void {
  for (const channelId of configStore.coffreChannelIds(guildId)) needsCatchUp.add(`${guildId}:${channelId}`);
}

// ─── RATTRAPAGE ───────────────────────────────────────────────────────────────

/**
 * Rejoue les messages d'un salon postérieurs à son curseur. Un échec de
 * lecture (après plusieurs tentatives) laisse le salon marqué dans
 * `needsCatchUp` et le curseur sur le dernier message réellement appliqué :
 * rien n'est sauté, la suite sera reprise au prochain message ou rattrapage.
 */
async function catchUpChannel(client: Client, guildId: string, channelId: string): Promise<StockEntry[]> {
  const key = `${guildId}:${channelId}`;
  const lastId = await db.getSetting(guildId, `last_stock_msg_${channelId}`);
  if (!lastId) { needsCatchUp.delete(key); return []; }

  // Marqué avant de lire le salon : un échec de lecture, quel qu'il soit, laisse le salon à rattraper.
  needsCatchUp.add(key);
  const all: StockEntry[] = [];
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) return [];
    const silentBefore = resyncStartedAt.get(key) ?? 0;

    for await (const page of fetchPagesAfter(channel, lastId)) {
      for (const msg of page) {
        const entries = await applyMessage(guildId, msg, channelId);
        if (!entries?.length) continue;
        all.push(...entries);
        if (msg.createdTimestamp >= silentBefore) await runSideEffects(client, guildId, msg, channelId, entries);
      }
    }
    needsCatchUp.delete(key);
    resyncStartedAt.delete(key);
  } catch (err) {
    console.error(`[stocks] Rattrapage interrompu (${guildId}, salon ${channelId}) — repris au prochain message :`, (err as Error).message);
  }
  return all;
}

/**
 * Rejoue les messages de coffre manqués (bot arrêté, connexion à Discord
 * coupée) pour tous les salons suivis d'une guilde. À appeler dans la file de
 * la guilde.
 */
export async function catchUpMissedMessages(client: Client, guildId: string): Promise<number> {
  const all: StockEntry[] = [];
  for (const channelId of configStore.coffreChannelIds(guildId)) {
    all.push(...await catchUpChannel(client, guildId, channelId));
  }
  if (all.length) {
    console.log(`[stocks] Rattrapage (${guildId}) : ${all.length} mouvement(s) manqué(s) appliqué(s)`);
    await updateStockMessage(client, guildId);
  }
  return all.length;
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
 * Parse une ligne de log de coffre (retrait/dépôt) ; `null` si la ligne ne
 * matche rien, que l'item n'est pas suivi (voir piège n°1 du projet :
 * orthographe exacte) ou que la quantité est aberrante. Ne touche pas à la
 * base : l'application se fait par message entier (`db.applyStockMessage`).
 */
function parseLine(guildId: string, line: string): db.StockMovementInput | null {
  const retireMatch = line.match(RE_RETIRE);
  const deposeMatch = line.match(RE_DEPOSE);
  if (!retireMatch && !deposeMatch) return null;

  const match = retireMatch || deposeMatch!;
  const joueur = match[1].replace(/\*\*/g, '').trim();
  const quantite = parseInt(match[2], 10);
  const item = match[3].trim().toLowerCase().replace(/\s*\([^)]*\)$/, '');

  const allowedLower = configStore.get(guildId).ALLOWED_ITEMS.map(i => i.toLowerCase());
  if (!allowedLower.includes(item)) return null;
  if (!Number.isSafeInteger(quantite) || quantite > MAX_QUANTITE_LOG) {
    console.warn(`[stocks] Ligne ignorée (${guildId}) — quantité hors limite : ${line.slice(0, 120)}`);
    return null;
  }

  return { joueur, action: retireMatch ? 'retire' : 'depose', item, quantite };
}

/** Mouvements de stock décrits par le contenu d'un message (une ligne = au plus un mouvement). */
function parseMessage(guildId: string, content: string): db.StockMovementInput[] {
  const movements: db.StockMovementInput[] = [];
  for (const line of content.split('\n')) {
    const movement = parseLine(guildId, line);
    if (movement) movements.push(movement);
  }
  return movements;
}

// ─── RESYNC COMPLÈTE DEPUIS LE DÉBUT ─────────────────────────────────────────

const resyncRunning = new Set<string>();

/** Vrai si une resynchronisation complète est en cours pour cette guilde. */
export function isResyncRunning(guildId: string): boolean {
  return resyncRunning.has(guildId);
}

/**
 * Repart de zéro : supprime tout le stock/historique et rejoue l'intégralité
 * de chaque salon suivi, dans la file de la guilde — le temps réel attend
 * donc la fin, et retrouve ensuite un curseur à jour.
 *
 * - La remise à zéro (stock, historique, curseurs à `0`) est une seule
 *   transaction : un arrêt juste après ne laisse pas un stock vidé avec des
 *   curseurs intacts, que le rattrapage ne reconstruirait jamais.
 * - Un message publié pendant la resync a déjà été lu par elle quand le temps
 *   réel le reçoit (qui le trouve alors déjà appliqué) : ses suites (ventes,
 *   alertes) sont donc déclenchées ici. Celles des messages antérieurs l'ont
 *   été en temps réel, jamais deux fois.
 * - Un salon illisible ou une lecture qui échoue en route fait échouer la
 *   resync (jamais de "terminé" sur un stock partiel) ; le salon reste marqué
 *   à rattraper depuis le dernier message réellement appliqué, sans
 *   redéclencher les suites des messages antérieurs à la resync.
 */
export async function fullResync(client: Client, guildId: string): Promise<number> {
  resyncRunning.add(guildId);
  try {
    return await runExclusive(guildId, async () => {
      const startedAt = Date.now();
      const channelIds = configStore.coffreChannelIds(guildId);
      await db.resetStocksForResync(guildId, channelIds.map(id => `last_stock_msg_${id}`));
      for (const channelId of channelIds) {
        needsCatchUp.add(`${guildId}:${channelId}`);
        resyncStartedAt.set(`${guildId}:${channelId}`, startedAt);
      }

      let total = 0;
      try {
        for (const channelId of channelIds) {
          const channel = await client.channels.fetch(channelId);
          if (!channel || !channel.isTextBased() || channel.isDMBased()) {
            throw new Error(`salon de coffre ${channelId} illisible`);
          }

          for await (const page of fetchPagesAfter(channel, '0')) {
            for (const msg of page) {
              const entries = await applyMessage(guildId, msg, channelId);
              if (!entries?.length) continue;
              total += entries.length;
              if (msg.createdTimestamp >= startedAt) await runSideEffects(client, guildId, msg, channelId, entries);
            }
          }
          needsCatchUp.delete(`${guildId}:${channelId}`);
          resyncStartedAt.delete(`${guildId}:${channelId}`);
        }
      } finally {
        await updateStockMessage(client, guildId);
      }

      console.log(`[stocks] Resync complet (${guildId}) : ${total} mouvement(s) traité(s)`);
      return total;
    });
  } finally {
    resyncRunning.delete(guildId);
  }
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
        await upsertPanel(channel, guildId, 'stock_message_id', STOCK_PANEL_TITLE, async () => {
          const stocks = await db.getAllStocks(guildId, configStore.coffreChannelIds(guildId));
          return { embeds: [buildStockEmbed(guildId, stocks)] };
        });
      }
    } catch (err) {
      console.error(`[stocks] updateStockMessage(${guildId}):`, (err as Error).message);
    }
  }

  if (!opts.skipArmurerie) await armurerie.updatePermanentMessage(client, guildId);
}

const STOCK_PANEL_TITLE = '📦 Stock Général';

/** Construit l'embed affichant l'état actuel des stocks, avec regroupements STOCK_GROUPS. */
function buildStockEmbed(guildId: string, stocks: Array<{ item: string; quantite: number }>): EmbedBuilder {
  const c = configStore.get(guildId);
  const embed = new EmbedBuilder().setTitle(STOCK_PANEL_TITLE).setColor(0x2b2d31).setTimestamp().setFooter({ text: 'Dernière mise à jour' });

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
        .addChannelOption(opt => opt.setName('coffre').setDescription('Le coffre à corriger (le total global est recalculé à partir des coffres)').setRequired(true)
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

  const item = interaction.options.getString('item', true).trim().toLowerCase();
  const quantite = interaction.options.getInteger('quantite', true);
  const coffre = interaction.options.getChannel('coffre', true);
  // L'autocomplete ne contraint rien : une valeur libre créerait une ligne de
  // stock pour un item non suivi, ou dans un salon qui n'est pas un coffre.
  const itemLabel = configStore.get(guildId).ALLOWED_ITEMS.find(i => i.toLowerCase() === item);
  if (!itemLabel) {
    await interaction.reply({ content: "❌ Cet item n'est pas suivi (voir `/config item list`).", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!configStore.coffreChannelIds(guildId).includes(coffre.id)) {
    await interaction.reply({ content: `❌ <#${coffre.id}> n'est pas un coffre suivi (voir \`/config channel list\`).`, flags: MessageFlags.Ephemeral });
    return;
  }

  // Corrige CE coffre précis (SET absolu) — `coffre` obligatoire : le total
  // global n'est jamais stocké séparément (voir db.ts), il se recalcule tout
  // seul comme la somme des coffres dès la prochaine lecture.
  const { avant, apres } = await db.setCoffreStock(guildId, coffre.id, item, quantite);
  await updateStockMessage(interaction.client, guildId);
  await interaction.reply({
    content: `✅ Stock de **${itemLabel}** corrigé pour <#${coffre.id}> : \`${avant.toLocaleString('fr-FR')}\` → \`${apres.toLocaleString('fr-FR')}\` (total global recalculé automatiquement).`,
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

/**
 * `/historique-stock` : affiche les derniers mouvements de stock, filtrés par
 * item si fourni. Réservée au rôle membre (ou admin), comme l'API : être sur
 * le serveur ne suffit pas, un lien d'invitation public y donnerait accès à
 * n'importe quel arrivant. Sans les coffres admin pour un non-admin (même
 * règle que `/api/stocks/history`).
 */
export async function handleHistoriqueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member || !hasApiAccess(guildId, member)) {
    await interaction.reply({ content: '❌ Commande réservée aux membres de l\'organisation (rôle membre).', flags: MessageFlags.Ephemeral });
    return;
  }
  const item = interaction.options.getString('item') || null;
  const lignes = interaction.options.getInteger('lignes') || 20;

  const coffresMasques = isAdmin(guildId, member) ? [] : configStore.get(guildId).CHANNELS.logs_coffres_admin;
  const rows = await db.getRecentStockHistory(guildId, item, lignes, null, coffresMasques);
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

  if (isResyncRunning(guildId)) {
    await interaction.reply({ content: '⏳ Une resynchronisation est déjà en cours.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let content: string;
  try {
    const total = await fullResync(interaction.client, guildId);
    content = `✅ Resync terminé — **${total}** mouvement(s) traité(s).`;
  } catch (err) {
    console.error(`[stocks] fullResync(${guildId}):`, (err as Error).message);
    content = "❌ Resync interrompue : l'historique d'un salon de coffre n'a pas pu être lu jusqu'au bout. Le stock affiché est **partiel** — relance `/sync-stock`.";
  }
  // Le jeton d'une interaction expire après 15 minutes, une resync peut durer plus.
  await interaction.editReply({ content }).catch(async () => {
    if (interaction.channel?.isSendable()) await interaction.channel.send({ content: `<@${interaction.user.id}> ${content}` }).catch(() => null);
  });
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
  for (const item of venteItems) quantities.push({ item, qty: await db.getStock(guildId, item, configStore.coffreChannelIds(guildId)) });
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
