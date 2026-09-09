/**
 * @file src/index.ts
 * @description Point d'entrée — client Discord, déploiement des commandes,
 * routage de toutes les interactions vers les modules métier, cron jobs.
 *
 * Organisation du bot (RP FiveM illégal, entièrement configurable via
 * `/config`, voir src/modules/config.ts) :
 *   - stocks    : suivi des ressources dans les coffres (logs automatiques)
 *   - quotas    : activités hebdomadaires déclarables (panneau dynamique)
 *   - taxes     : suivi et validation des taxes dues par les membres
 *   - armurerie : gestion des stocks d'armes et munitions
 *   - alertes   : cooldowns, disponibilité de braquage, statut labo
 *   - ventes    : circuit de vente de drogue
 *   - garages   : fourrière véhicules
 *
 * **Multi-tenant** : un seul process sert plusieurs guildes Discord à la
 * fois (voir src/guild-registry.ts pour le registre, src/config-store.ts
 * pour la config par guilde). Chaque guilde connue est "bootstrapée"
 * (`bootstrapGuild`) soit au démarrage (toutes les guildes déjà présentes
 * dans `client.guilds.cache`), soit à la volée (`guildCreate`, une guilde
 * qui vient d'inviter le bot) — même chemin de code dans les deux cas.
 */
import 'dotenv/config';

// ─── PROTECTION MULTI-INSTANCE (fichier PID) ──────────────────────────────────
import fs from 'fs';
import path from 'path';
const PID_FILE = path.join(__dirname, '..', 'bot.pid');

const existingPid = fs.existsSync(PID_FILE) ? parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10) : null;
if (existingPid) {
  try {
    process.kill(existingPid, 0);
    console.error(`❌ Le bot tourne déjà (PID ${existingPid}). Arrête-le d'abord.`);
    process.exit(1);
  } catch {
    // Process inexistant → PID file obsolète, on continue
  }
}
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch { /* déjà absent */ } });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

import { Client, GatewayIntentBits, Partials, REST, Routes, MessageFlags, type Guild } from 'discord.js';
import cron from 'node-cron';

import * as configStore from './config-store';
import * as guildRegistry from './guild-registry';
import * as db from './db';
import { seedDefaultItems } from './default-items';
import * as configModule from './modules/config';
import * as stocks from './modules/stocks';
import * as quotas from './modules/quotas';
import * as taxes from './modules/taxes';
import * as armurerie from './modules/armurerie';
import * as alertes from './modules/alertes';
import * as ventes from './modules/ventes';
import * as garages from './modules/garages';
import { startApiServer } from './api/server';

// ─── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  // Sans ça, discord.js garde en RAM tous les messages vus (jusqu'à 200 par
  // salon par défaut) sans jamais les libérer — sur les salons de logs
  // coffre à fort trafic, ça grossit indéfiniment. Les messages permanents
  // (stock/quotas/armurerie/taxes) ne dépendent pas de ce cache : ils sont
  // toujours re-fetchés par ID (`channel.messages.fetch(storedId)`), jamais
  // lus depuis le cache — donc rien ne casse quand un vieux message en sort.
  sweepers: {
    messages: { interval: 3600, lifetime: 3600 },
  },
});

// ─── DÉPLOIEMENT DES COMMANDES SLASH ─────────────────────────────────────────
/** Enregistre auprès de Discord toutes les commandes slash exposées par les modules, pour UNE guilde précise. Idempotent (un `PUT` remplace entièrement) — sans risque de le rappeler pour une guilde déjà connue. */
async function deployCommandsForGuild(guildId: string): Promise<void> {
  const commands = [
    ...quotas.getCommands(),
    ...taxes.getCommands(),
    ...stocks.getCommands(),
    ...ventes.getCommands(),
    ...garages.getCommands(),
    ...configModule.getCommands(),
  ].map(c => c.data.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN!);
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID!, guildId), { body: commands });
    console.log(`✅ ${commands.length} commande(s) slash déployée(s) sur ${guildId}`);
  } catch (err) {
    console.error(`❌ Déploiement commandes slash (${guildId}) :`, (err as Error).message);
  }
}

// ─── BOOTSTRAP D'UNE GUILDE ───────────────────────────────────────────────────
/**
 * Met une guilde en état de marche : enregistrement dans le registre,
 * config chargée, items par défaut pré-remplis, commandes déployées,
 * panneaux permanents initialisés/rafraîchis. Même chemin de code que la
 * guilde soit déjà connue (appelé en boucle au démarrage) ou toute nouvelle
 * (`guildCreate`) — voir docstring de fichier.
 */
async function bootstrapGuild(guild: Guild): Promise<void> {
  const guildId = guild.id;
  await guildRegistry.registerGuild(guildId, guild.name);
  await configStore.reload(guildId);
  // Pré-remplit les items connus absents (ex. munitions, argent sale) — voir
  // src/default-items.ts. N'écrase jamais un item déjà configuré ; recharge
  // le cache seulement si quelque chose a effectivement été inséré.
  await seedDefaultItems(guildId);
  await deployCommandsForGuild(guildId);

  await stocks.catchUpMissedMessages(client, guildId);
  await stocks.updateStockMessage(client, guildId);
  await quotas.initPermanentMessage(client, guildId);
  await armurerie.initPermanentMessage(client, guildId);
  await taxes.initPermanentMessage(client, guildId);
  await alertes.initLaboTimers(client, guildId);
  await garages.catchUpMissedMessages(client, guildId);
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('clientReady', async (readyClient) => {
  console.log(`✅ Connecté en tant que ${readyClient.user.tag}`);

  // Réconcilie le registre avec la réalité Discord : une guilde `active` en
  // base mais absente du cache actuel a retiré le bot pendant qu'il était
  // hors ligne (le `guildDelete` correspondant n'a jamais pu se déclencher).
  const currentGuildIds = new Set(client.guilds.cache.keys());
  for (const knownId of await guildRegistry.listActiveGuildIds()) {
    if (!currentGuildIds.has(knownId)) await guildRegistry.deactivateGuild(knownId);
  }

  // Bootstrap séquentiel de chaque guilde présente — couvre aussi le cas
  // "a invité le bot pendant qu'il était hors ligne" (jamais de `guildCreate`
  // pour elle, donc jamais bootstrapée sans ce passage).
  for (const guild of client.guilds.cache.values()) {
    try {
      await bootstrapGuild(guild);
    } catch (err) {
      console.error(`[index] bootstrapGuild(${guild.id}) :`, (err as Error).message);
    }
  }

  await guildRegistry.warmCorsCache();
  startApiServer(client);

  // ── CRON : Reset hebdomadaire (dimanche 19h Europe/Paris), auto-réparant ──
  await forEachActiveGuild(guildId => quotas.checkWeeklyReset(client, guildId));
  cron.schedule('*/15 * * * *', () => forEachActiveGuild(guildId => quotas.checkWeeklyReset(client, guildId)));

  // ── CRON : Rappel de quota du dimanche (00h-19h) ──────────────────────────
  await forEachActiveGuild(guildId => quotas.checkQuotaReminder(client, guildId));
  cron.schedule('*/15 * * * *', () => forEachActiveGuild(guildId => quotas.checkQuotaReminder(client, guildId)));

  // ── CRON : Vérif taxes expirées chaque jour à 10h00 ──────────────────────
  cron.schedule('0 10 * * *', () => forEachActiveGuild(guildId => taxes.checkExpiredTaxes(client, guildId)), { timezone: 'Europe/Paris' });

  // ── CRON : Purge des ventes terminées (pending_sales) et des ventes de
  // munitions de plus de 30 jours — pur debris opérationnel, voir
  // ventes.purgeOldPendingSales / armurerie.purgeOldMunitionVentes.
  cron.schedule('0 4 * * *', () => forEachActiveGuild(guildId => ventes.purgeOldPendingSales(guildId)), { timezone: 'Europe/Paris' });
  cron.schedule('0 4 * * *', () => forEachActiveGuild(guildId => armurerie.purgeOldMunitionVentes(guildId)), { timezone: 'Europe/Paris' });

  // ── CRON : Vérif cooldowns expirés chaque minute ──────────────────────────
  cron.schedule('* * * * *', () => forEachActiveGuild(guildId => alertes.checkExpiredCooldowns(client, guildId)));

  // ── CRON : Expiration des ventes sans action (toutes les 10 min) ──────────
  cron.schedule('*/10 * * * *', () => forEachActiveGuild(guildId => ventes.cleanupExpiredSales(client, guildId)));

  // ── CRON : Nettoyage braquages anciens (toutes les heures) ────────────────
  // Liste des activités "braquage" dérivée du registre ACTIVITY_TYPES (voir
  // config-store.ts) plutôt qu'un tableau de clés en dur ici.
  cron.schedule('0 * * * *', () => forEachActiveGuild(async guildId => {
    const braquageActions = Object.entries(configStore.get(guildId).ACTIVITY_TYPES)
      .filter(([, cfg]) => cfg.enabled && cfg.braquageWeeklyLimit != null)
      .map(([key]) => key);
    const before: Record<string, number> = {};
    for (const action of braquageActions) before[action] = await db.getBraquageCount(guildId, action);
    await db.cleanOldBraquages();
    for (const action of braquageActions) {
      if ((await db.getBraquageCount(guildId, action)) < before[action]) {
        await alertes.postBraquageAlert(client, guildId, action);
      }
    }
    await quotas.initPermanentMessage(client, guildId);
  }));

  console.log('✅ Tâches cron démarrées');
});

/**
 * Exécute `fn` séquentiellement pour chaque guilde active connue —
 * séquentiel et pas `Promise.all` : ce bot est très dépendant du rate-limit
 * Discord par itération (fetch de salon, édition de message), paralléliser
 * multiplierait le risque de le déclencher globalement. Une guilde en échec
 * (config incohérente, etc.) n'interrompt jamais les suivantes.
 */
async function forEachActiveGuild(fn: (guildId: string) => Promise<void>): Promise<void> {
  for (const guildId of await guildRegistry.listActiveGuildIds()) {
    try {
      await fn(guildId);
    } catch (err) {
      console.error(`[cron] échec sur guilde ${guildId} :`, (err as Error).message);
    }
  }
}

// ─── GUILDES REJOINTES/QUITTÉES EN COURS DE ROUTE ────────────────────────────
client.on('guildCreate', async (guild) => {
  console.log(`[index] Nouvelle guilde : ${guild.name} (${guild.id})`);
  try {
    await bootstrapGuild(guild);
  } catch (err) {
    console.error(`[index] bootstrapGuild(${guild.id}) après guildCreate :`, (err as Error).message);
  }
});

client.on('guildDelete', async (guild) => {
  console.log(`[index] Guilde retirée : ${guild.id}`);
  await guildRegistry.deactivateGuild(guild.id);
  configStore.remove(guild.id);
});

// ─── RÉACTION 🗑️ → SUPPRESSION DU MESSAGE DU BOT ────────────────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name !== '🗑️') return;
  if (!reaction.message.guildId) return; // pas de config sans guilde (DM) — n'arrive normalement jamais, aucun intent DM

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch {
    return;
  }

  if (reaction.message.author?.id !== client.user?.id) return;

  if (await ventes.handleTrashReaction(reaction, user)) return;

  const message = reaction.message.partial ? null : reaction.message;
  if (!message) return; // fetch() ci-dessus a échoué silencieusement (message supprimé entre-temps)

  const c = configStore.get(reaction.message.guildId);
  const noDeleteChannels = [
    c.CHANNELS.alertes_braquages,
    c.CHANNELS.alertes_actions,
    c.CHANNELS.paie,
    c.CHANNELS.historique_stock,
    c.CHANNELS.log_ventes,
    c.CHANNELS.logs_activites,
    c.CHANNELS.ventes_drogue,
  ];
  if (noDeleteChannels.includes(message.channelId)) return;

  if (quotas.isQuotaReminderMessage(message)) return;

  if (message.components?.length) return;

  await message.delete().catch(() => null);
});

// ─── MESSAGES (logs coffres/garages + réaction 🗑️ auto) ─────────────────────
client.on('messageCreate', async (message) => {
  if (!message.guildId) return; // pas de config sans guilde (DM) — n'arrive normalement jamais, aucun intent DM
  const c = configStore.get(message.guildId);
  const noTrashChannels = [
    c.CHANNELS.stock_general,
    c.CHANNELS.bilan,
    c.CHANNELS.paie,
    c.CHANNELS.historique_stock,
    c.CHANNELS.log_ventes,
    c.CHANNELS.logs_activites,
    c.CHANNELS.ventes_drogue,
    c.CHANNELS.alertes_braquages,
    c.CHANNELS.alertes_actions,
  ];
  if (
    message.author.id === client.user?.id &&
    !noTrashChannels.includes(message.channelId) &&
    !quotas.isQuotaReminderMessage(message)
  ) {
    if (!message.components?.length) message.react('🗑️').catch(() => null);
  }

  const channelsBotAutorises = [...c.CHANNELS.logs_coffres, c.CHANNELS.logs_garages].filter((id): id is string => !!id);
  if (message.author.bot && !channelsBotAutorises.includes(message.channelId)) return;

  await stocks.handleMessage(message).catch(err => console.error('[stocks] messageCreate :', (err as Error).message));
  await garages.handleMessage(message).catch(err => console.error('[garages] messageCreate :', (err as Error).message));
});

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.guildId) return; // commandes/boutons/modals toujours guild-scopés — n'arrive normalement jamais

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'config') return await configModule.handleCommand(interaction);
      if (interaction.commandName === 'supp') return await quotas.handleSuppCommand(interaction);
      if (interaction.commandName === 'listquota') return await quotas.handleListQuotaCommand(interaction);
      if (interaction.commandName === 'historique-stock') return await stocks.handleHistoriqueCommand(interaction);
      if (interaction.commandName === 'set-stock') return await stocks.handleSetStockCommand(interaction);
      if (interaction.commandName === 'sync-stock') return await stocks.handleSyncStockCommand(interaction);
      if (interaction.commandName === 'drogues-a-vendre') return await stocks.handleDroguesAVendreCommand(interaction);
      if (interaction.commandName === 'adduser') return await ventes.handleAddUserCommand(interaction);
      if (interaction.commandName === 'removeuser') return await ventes.handleRemoveUserCommand(interaction);
      if (interaction.commandName === 'listusers') return await ventes.handleListUsersCommand(interaction);
      if (interaction.commandName === 'fourrieres') return await garages.handleClassementCommand(interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'set-stock' || interaction.commandName === 'historique-stock') return await stocks.handleAutocomplete(interaction);
      if (interaction.commandName === 'config') return await configModule.handleAutocomplete(interaction);
      return;
    }

    if (interaction.isButton()) {
      const cid = interaction.customId;

      if (cid === 'view_quota' || cid === 'view_paie' || cid === 'view_classement' || cid === 'view_bilan' || cid === 'view_minuterie' ||
          (cid.startsWith('act_') && !cid.startsWith('act_select_'))) {
        return await quotas.handleButton(interaction);
      }
      if (cid.startsWith('tax_')) return await taxes.handleButton(interaction);
      if (cid.startsWith('arm_')) return await armurerie.handleButton(interaction);
      if (cid.startsWith('vente_')) return await ventes.handleButton(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      const cid = interaction.customId;

      if (cid.startsWith('modal_act_') || cid.startsWith('modal_actlabo_')) return await quotas.handleModal(interaction);
      if (cid.startsWith('modal_tax_')) return await taxes.handleModal(interaction);
      if (cid.startsWith('modal_arm_')) return await armurerie.handleModal(interaction);
      if (cid.startsWith('modal_vente_')) return await ventes.handleModal(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const cid = interaction.customId;

      if (cid === 'act_more_select') return await quotas.handleStringSelect(interaction);
      if (cid.startsWith('arm_select_')) return await armurerie.handleSelect(interaction);
      if (cid.startsWith('tax_select_')) return await taxes.handleSelect(interaction);
      return;
    }

    if (interaction.isUserSelectMenu()) {
      const cid = interaction.customId;
      if (cid.startsWith('act_select_')) return await quotas.handleSelect(interaction);
      return;
    }
  } catch (err) {
    console.error('[interactionCreate] Erreur non gérée :', err);

    const errPayload = { content: '❌ Une erreur interne est survenue.', flags: MessageFlags.Ephemeral as const };
    try {
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) await interaction.followUp(errPayload);
        else await interaction.reply(errPayload);
      }
    } catch { /* silence */ }
  }
});

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
if (!process.env.TOKEN) {
  console.error('❌ TOKEN manquant dans le fichier .env');
  process.exit(1);
}
if (!process.env.CLIENT_ID) {
  console.error('❌ CLIENT_ID manquant dans le fichier .env');
  process.exit(1);
}

client.login(process.env.TOKEN).catch(err => {
  console.error('❌ Connexion impossible :', (err as Error).message);
  process.exit(1);
});
