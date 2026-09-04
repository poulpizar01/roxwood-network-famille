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

import { Client, GatewayIntentBits, Partials, REST, Routes, MessageFlags } from 'discord.js';
import cron from 'node-cron';

import * as configStore from './config-store';
import * as db from './db';
import * as configModule from './modules/config';
import * as stocks from './modules/stocks';
import * as quotas from './modules/quotas';
import * as taxes from './modules/taxes';
import * as armurerie from './modules/armurerie';
import * as alertes from './modules/alertes';
import * as ventes from './modules/ventes';
import * as garages from './modules/garages';

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
});

// ─── DÉPLOIEMENT DES COMMANDES SLASH ─────────────────────────────────────────
async function deployCommands(): Promise<void> {
  const commands = [
    ...quotas.getCommands(),
    ...taxes.getCommands(),
    ...stocks.getCommands(),
    ...ventes.getCommands(),
    ...configModule.getCommands(),
  ].map(c => c.data.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN!);
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID!, process.env.GUILD_ID!), { body: commands });
    console.log(`✅ ${commands.length} commande(s) slash déployée(s)`);
  } catch (err) {
    console.error('❌ Déploiement commandes slash :', (err as Error).message);
  }
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('clientReady', async (readyClient) => {
  console.log(`✅ Connecté en tant que ${readyClient.user.tag}`);

  // Charge la configuration depuis la base AVANT tout usage (voir config-store.ts).
  await configStore.reload();

  await deployCommands();

  await stocks.catchUpMissedMessages(client);
  await stocks.updateStockMessage(client);
  await quotas.initPermanentMessage(client);
  await armurerie.initPermanentMessage(client);
  await taxes.initPermanentMessage(client);
  await alertes.initLaboTimers(client);
  await garages.catchUpMissedMessages(client);
  await garages.updateClassementMessage(client);

  // ── CRON : Reset hebdomadaire (dimanche 19h Europe/Paris), auto-réparant ──
  await quotas.checkWeeklyReset(client);
  cron.schedule('*/15 * * * *', () => quotas.checkWeeklyReset(client));

  // ── CRON : Rappel de quota du dimanche (00h-19h) ──────────────────────────
  await quotas.checkQuotaReminder(client);
  cron.schedule('*/15 * * * *', () => quotas.checkQuotaReminder(client));

  // ── CRON : Vérif taxes expirées chaque jour à 10h00 ──────────────────────
  cron.schedule('0 10 * * *', () => taxes.checkExpiredTaxes(client), { timezone: 'Europe/Paris' });

  // ── CRON : Vérif cooldowns expirés chaque minute ──────────────────────────
  cron.schedule('* * * * *', () => alertes.checkExpiredCooldowns(client));

  // ── CRON : Expiration des ventes sans action (toutes les 10 min) ──────────
  cron.schedule('*/10 * * * *', () => ventes.cleanupExpiredSales(client));

  // ── CRON : Nettoyage braquages anciens (toutes les heures) ────────────────
  // Liste des activités "braquage" dérivée dynamiquement de la config (au lieu
  // d'un tableau de clés en dur) : toute activité avec une limite hebdomadaire
  // configurée via /config activite.
  cron.schedule('0 * * * *', async () => {
    const braquageActions = Object.entries(configStore.get().ACTIVITY_TYPES)
      .filter(([, cfg]) => cfg.braquageWeeklyLimit)
      .map(([key]) => key);
    const before: Record<string, number> = {};
    for (const action of braquageActions) before[action] = await db.getBraquageCount(action);
    await db.cleanOldBraquages();
    for (const action of braquageActions) {
      if ((await db.getBraquageCount(action)) < before[action]) {
        await alertes.postBraquageAlert(client, action);
      }
    }
    await quotas.initPermanentMessage(client);
  });

  console.log('✅ Tâches cron démarrées');
});

// ─── RÉACTION 🗑️ → SUPPRESSION DU MESSAGE DU BOT ────────────────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name !== '🗑️') return;

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

  const c = configStore.get();
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
  if (garages.isClassementMessage(message)) return;

  if (message.components?.length) return;

  await message.delete().catch(() => null);
});

// ─── MESSAGES (logs coffres/garages + réaction 🗑️ auto) ─────────────────────
client.on('messageCreate', async (message) => {
  const c = configStore.get();
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
    !quotas.isQuotaReminderMessage(message) &&
    !garages.isClassementMessage(message)
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
if (!process.env.CLIENT_ID || !process.env.GUILD_ID) {
  console.error('❌ CLIENT_ID ou GUILD_ID manquant dans le fichier .env');
  process.exit(1);
}

client.login(process.env.TOKEN).catch(err => {
  console.error('❌ Connexion impossible :', (err as Error).message);
  process.exit(1);
});
