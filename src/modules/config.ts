/**
 * @file src/modules/config.ts
 * @description Commande `/config` — la configuration qui bouge réellement
 * (salons, rôles, items, objectifs de quota, taux de paie) se fait depuis
 * Discord, en base, sans jamais éditer de fichier ni redémarrer le process.
 * Tout ce qui ne bouge quasiment jamais une fois le bot déployé reste fixe
 * dans le code à la place — pas de commande dédiée pour ça : le registre des
 * activités déclarables (voir src/config-store.ts), les types d'armes
 * (src/modules/armurerie.ts), les types de taxe (src/modules/taxes.ts), les
 * plafonds de munitions et le montant de la fourrière (armurerie.ts /
 * garages.ts).
 *
 * Exception : `type-groupe` fixe QUEL barème s'applique (limites de braquage,
 * labos accessibles — voir BRAQUAGE_LIMITS_BY_TIER/LABO_TIERS dans
 * config-store.ts) parmi des barèmes eux-mêmes fixes dans le code — le
 * niveau d'organisation (Indépendant/Petite Frappe/Gang/Organisation) est ce
 * qui change réellement dans le temps, pas les chiffres associés à chacun.
 *
 * Toujours réservée aux administrateurs Discord natifs (permission
 * `Administrator`), et non au rôle `ADMIN_ROLE_ID` configurable par cette
 * même commande — sinon un serveur fraîchement configuré n'aurait aucun
 * moyen de définir ce rôle (`/config role set` en ferait lui-même partie).
 *
 * Chaque sous-commande `add`/`set` fait un upsert complet de la ligne
 * concernée : les champs optionnels omis reprennent leur valeur par défaut,
 * pas leur ancienne valeur. Ré-exécuter la commande avec des options
 * différentes remplace donc entièrement la configuration de cette entrée.
 */
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';
import * as quotas from './quotas';
import * as stocks from './stocks';
import * as taxes from './taxes';
import * as armurerie from './armurerie';
import * as alertes from './alertes';

const ROLE_TARGETS = [
  { name: 'Rôle admin (commandes sensibles)', value: 'admin' },
  { name: 'Rôle accès taxes (back-office web)', value: 'taxes' },
];

/** Déclare la commande `/config` et tous ses sous-groupes (channel, role, item, quota, salaire, type-groupe). */
export function getCommands() {
  const cmd = new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configuration du bot (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  cmd.addSubcommandGroup(g => g
    .setName('channel')
    .setDescription('Salons utilisés par le bot')
    .addSubcommand(s => s
      .setName('set')
      .setDescription('Associe un salon à un rôle fonctionnel du bot')
      .addStringOption(o => o.setName('role').setDescription('Rôle fonctionnel').setRequired(true)
        .addChoices(...configStore.CHANNEL_ROLES.map(r => ({ name: r, value: r }))))
      .addChannelOption(o => o.setName('salon').setDescription('Salon Discord').setRequired(true)
        .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s
      .setName('add-log-coffre')
      .setDescription('Ajoute un salon à la liste des logs de coffre surveillés')
      .addChannelOption(o => o.setName('salon').setDescription('Salon Discord').setRequired(true)
        .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s
      .setName('remove-log-coffre')
      .setDescription('Retire un salon de la liste des logs de coffre surveillés')
      .addChannelOption(o => o.setName('salon').setDescription('Salon Discord').setRequired(true)
        .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('list').setDescription('Liste les salons configurés')));

  cmd.addSubcommandGroup(g => g
    .setName('role')
    .setDescription('Rôles Discord utilisés par le bot')
    .addSubcommand(s => s
      .setName('set')
      .setDescription('Associe un rôle Discord à un usage du bot')
      .addStringOption(o => o.setName('cible').setDescription('Usage du rôle').setRequired(true)
        .addChoices(...ROLE_TARGETS))
      .addRoleOption(o => o.setName('role').setDescription('Rôle Discord').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('Liste les rôles configurés')));

  cmd.addSubcommandGroup(g => g
    .setName('item')
    .setDescription('Items de coffre suivis')
    .addSubcommand(s => s
      .setName('add')
      .setDescription("Ajoute ou remplace un item suivi (orthographe exacte des logs FiveM)")
      .addStringOption(o => o.setName('nom').setDescription("Nom exact tel qu'écrit dans les logs FiveM").setRequired(true))
      .addBooleanOption(o => o.setName('vente_pnj').setDescription('Déclarable en vente aux PNJ (marché noir) — pas une vente entre joueurs (défaut : non)').setRequired(false))
      .addBooleanOption(o => o.setName('paiement').setDescription('Compte comme paiement de vente (défaut : non)').setRequired(false))
      .addStringOption(o => o.setName('groupe').setDescription('Libellé de regroupement dans le message de stock (optionnel)').setRequired(false))
      .addBooleanOption(o => o.setName('stock_general').setDescription('Afficher dans le message Stock Général (défaut : oui — le stock reste suivi même à non)').setRequired(false))
      .addStringOption(o => o.setName('labo_lie').setDescription("Ce labo produit cet item ? Exclut alors la vente PNJ pour les tiers ayant ce labo actif (optionnel)").setRequired(false)
        .addChoices(...Object.entries(configStore.get().ACTIVITY_TYPES).filter(([, cfg]) => cfg.labo).map(([key, cfg]) => ({ name: cfg.label, value: key })))))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription('Retire un item suivi')
      .addStringOption(o => o.setName('nom').setDescription('Item à retirer').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('Liste les items suivis')
      .addStringOption(o => o.setName('filtre').setDescription('Filtrer par sous-chaîne (optionnel)').setRequired(false))));

  cmd.addSubcommandGroup(g => g
    .setName('quota')
    .setDescription('Objectifs hebdomadaires par catégorie de quota')
    .addSubcommand(s => s
      .setName('set')
      .setDescription("Fixe l'objectif hebdomadaire d'une catégorie de quota")
      .addStringOption(o => o.setName('quota_type').setDescription('Catégorie de quota (actions, vente, recolte, labos)').setRequired(true))
      .addIntegerOption(o => o.setName('valeur').setDescription('Objectif hebdomadaire').setRequired(true).setMinValue(0)))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription("Retire l'objectif d'une catégorie de quota (reste suivie, sans cible)")
      .addStringOption(o => o.setName('quota_type').setDescription('Catégorie de quota').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('Liste les objectifs configurés')));

  cmd.addSubcommandGroup(g => g
    .setName('salaire')
    .setDescription('Taux de paie ($ par unité) par catégorie de quota')
    .addSubcommand(s => s
      .setName('set')
      .setDescription("Fixe le taux de paie ($ par unité) d'une catégorie de quota")
      .addStringOption(o => o.setName('quota_type').setDescription('Catégorie de quota (actions, vente, recolte, labos)').setRequired(true))
      .addNumberOption(o => o.setName('valeur').setDescription('Montant en $ par unité').setRequired(true).setMinValue(0)))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription("Retire le taux de paie d'une catégorie de quota (elle ne génère plus de paie)")
      .addStringOption(o => o.setName('quota_type').setDescription('Catégorie de quota').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('Liste les taux de paie configurés')));

  cmd.addSubcommandGroup(g => g
    .setName('type-groupe')
    .setDescription("Type d'organisation (fait varier les limites de braquage et les labos accessibles)")
    .addSubcommand(s => s
      .setName('set')
      .setDescription("Définit le type d'organisation actuel")
      .addStringOption(o => o.setName('tier').setDescription("Type d'organisation").setRequired(true)
        .addChoices(...configStore.GROUP_TIERS.map(t => ({ name: t.label, value: t.key })))))
    .addSubcommand(s => s.setName('list').setDescription("Affiche le type actuel et le barème de chaque type")));

  return [{ data: cmd }];
}

/**
 * Vérifie que l'auteur de l'interaction possède la permission Discord native
 * `Administrator`. Volontairement indépendant de `ADMIN_ROLE_ID` — voir
 * docstring de fichier.
 */
function isNativeAdmin(interaction: ChatInputCommandInteraction): boolean {
  return !!(interaction.member && 'permissions' in interaction.member &&
    typeof interaction.member.permissions !== 'string' &&
    interaction.member.permissions.has(PermissionFlagsBits.Administrator));
}

/** Point d'entrée de `/config` : vérifie la permission `Administrator`, puis route vers le handler du sous-groupe concerné. */
export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isNativeAdmin(interaction)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs Discord.', flags: MessageFlags.Ephemeral });
    return;
  }

  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();

  if (group === 'channel') return handleChannel(interaction, sub);
  if (group === 'role') return handleRole(interaction, sub);
  if (group === 'item') return handleItem(interaction, sub);
  if (group === 'quota') return handleQuota(interaction, sub);
  if (group === 'salaire') return handleSalaire(interaction, sub);
  if (group === 'type-groupe') return handleTypeGroupe(interaction, sub);
}

/** `/config channel set|add-log-coffre|remove-log-coffre|list`. */
async function handleChannel(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'set') {
    const role = interaction.options.getString('role', true);
    const salon = interaction.options.getChannel('salon', true);
    await configStore.mutate(() => db.setChannelRole(role, salon.id));
    // Sans ça, un salon de panneau permanent (quotas/armurerie/taxes/stock)
    // configuré après le démarrage du bot resterait vide jusqu'au prochain
    // événement qui rafraîchit ce panneau (un mouvement de coffre, une
    // déclaration d'activité…) — voire jusqu'à un redémarrage pour `taxes`,
    // qui n'a aucun déclencheur de rafraîchissement indirect. Le bot n'étant
    // pas censé redémarrer une fois lancé, on crée/rafraîchit le panneau
    // immédiatement ici plutôt que de compter sur un événement indirect.
    if (role === 'stock_general') await stocks.updateStockMessage(interaction.client);
    if (role === 'armurerie') await armurerie.updatePermanentMessage(interaction.client);
    if (role === 'quotas') await quotas.updatePermanentMessage(interaction.client);
    if (role === 'taxes') await taxes.initPermanentMessage(interaction.client);
    // Idem pour le préfixe 🟢 d'un salon de labo : sans ça, il resterait sans
    // préfixe (ni rouge ni vert) jusqu'à la première déclaration de ce labo.
    // No-op silencieux si ce labo n'est pas actif pour le tier courant.
    if (role.startsWith('labo_')) await alertes.setLaboStatut(interaction.client, role, true);
    await interaction.reply({ content: `✅ Salon **${role}** → <#${salon.id}>`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'add-log-coffre' || sub === 'remove-log-coffre') {
    const salon = interaction.options.getChannel('salon', true);
    await configStore.mutate(() => sub === 'add-log-coffre'
      ? db.addChannelToRole('logs_coffres', salon.id)
      : db.removeChannelFromRole('logs_coffres', salon.id));
    const total = configStore.get().CHANNELS.logs_coffres.length;
    await interaction.reply({ content: `✅ Logs de coffre : ${total} salon(s) surveillé(s).`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const c = configStore.get().CHANNELS;
    const lines = configStore.CHANNEL_ROLES.map(role => `**${role}** : ${c[role] ? `<#${c[role]}>` : '_non configuré_'}`);
    lines.push(`**logs_coffres** : ${c.logs_coffres.length ? c.logs_coffres.map(id => `<#${id}>`).join(', ') : '_aucun_'}`);
    const embed = new EmbedBuilder().setTitle('⚙️ Salons configurés').setDescription(lines.join('\n')).setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

/** `/config role set|list`. */
async function handleRole(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'set') {
    const cible = interaction.options.getString('cible', true);
    const role = interaction.options.getRole('role', true);
    await configStore.mutate(() => db.setDiscordRole(cible, role.id));
    await interaction.reply({ content: `✅ Rôle **${cible}** → <@&${role.id}>`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const c = configStore.get();
    const lines = [
      `**admin** : ${c.ADMIN_ROLE_ID ? `<@&${c.ADMIN_ROLE_ID}>` : '_non configuré (permissions Discord natives utilisées)_'}`,
      `**taxes** : ${c.TAXES_ROLE_ID ? `<@&${c.TAXES_ROLE_ID}>` : '_non configuré_'}`,
    ];
    const embed = new EmbedBuilder().setTitle('⚙️ Rôles configurés').setDescription(lines.join('\n')).setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

/** `/config item add|remove|list`. */
async function handleItem(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'add') {
    const nom = interaction.options.getString('nom', true);
    const ventePnj = interaction.options.getBoolean('vente_pnj') ?? false;
    const paiement = interaction.options.getBoolean('paiement') ?? false;
    const groupe = interaction.options.getString('groupe');
    const stockGeneral = interaction.options.getBoolean('stock_general') ?? true;
    const laboLie = interaction.options.getString('labo_lie');
    await configStore.mutate(() => db.upsertItem({ name: nom, stock_group: groupe, vente: ventePnj, vente_paiement: paiement, visible_stock: stockGeneral, labo_lie: laboLie }));
    const laboLabel = laboLie ? configStore.get().ACTIVITY_TYPES[laboLie]?.label : null;
    await interaction.reply({ content: `✅ Item **${nom}** enregistré${groupe ? ` (groupe : ${groupe})` : ''}${ventePnj ? ' — vente PNJ' : ''}${paiement ? ' — paiement' : ''}${!stockGeneral ? ' — masqué du Stock Général (stock toujours suivi)' : ''}${laboLabel ? ` — lié à ${laboLabel}` : ''}.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'remove') {
    const nom = interaction.options.getString('nom', true);
    await configStore.mutate(() => db.deleteItem(nom));
    await interaction.reply({ content: `✅ Item **${nom}** retiré.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const filtre = interaction.options.getString('filtre')?.toLowerCase();
    let items = await db.getAllItems();
    if (filtre) items = items.filter(i => i.name.toLowerCase().includes(filtre));
    if (items.length === 0) {
      await interaction.reply({ content: 'Aucun item trouvé.', flags: MessageFlags.Ephemeral });
      return;
    }
    const activityTypes = configStore.get().ACTIVITY_TYPES;
    const lines = items.slice(0, 60).map(i => {
      const laboLabel = i.laboLie ? activityTypes[i.laboLie]?.label ?? i.laboLie : null;
      return `**${i.name}**${i.stockGroup ? ` _(${i.stockGroup})_` : ''}${i.vente ? ' 💰' : ''}${i.ventePaiement ? ' 🪙' : ''}${!i.visibleStock ? ' 🙈' : ''}${laboLabel ? ` 🧪${laboLabel}` : ''}`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`⚙️ Items suivis (${items.length})`)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: '💰 vente PNJ · 🪙 paiement · 🙈 masqué du Stock Général · 🧪 lié à un labo (vente PNJ exclue si ce labo est actif pour le tier)' })
      .setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

/** `/config quota set|remove|list`. */
async function handleQuota(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'set') {
    const quotaType = interaction.options.getString('quota_type', true);
    const valeur = interaction.options.getInteger('valeur', true);
    await configStore.mutate(() => db.setQuotaTarget(quotaType, valeur));
    await interaction.reply({ content: `✅ Objectif **${quotaType}** → ${valeur}/semaine.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'remove') {
    const quotaType = interaction.options.getString('quota_type', true);
    await configStore.mutate(() => db.deleteQuotaTarget(quotaType));
    await interaction.reply({ content: `✅ Objectif **${quotaType}** retiré.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const targets = await db.getAllQuotaTargets();
    if (targets.length === 0) {
      await interaction.reply({ content: 'Aucun objectif configuré.', flags: MessageFlags.Ephemeral });
      return;
    }
    const lines = targets.map(t => `**${t.quotaType}** : ${t.weeklyTarget}/semaine`);
    const embed = new EmbedBuilder().setTitle('⚙️ Objectifs de quota').setDescription(lines.join('\n')).setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

/** `/config salaire set|remove|list`. */
async function handleSalaire(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'set') {
    const quotaType = interaction.options.getString('quota_type', true);
    const valeur = interaction.options.getNumber('valeur', true);
    await configStore.mutate(() => db.setSalaryRate(quotaType, valeur));
    await interaction.reply({ content: `✅ Taux de paie **${quotaType}** → ${valeur}$/unité.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'remove') {
    const quotaType = interaction.options.getString('quota_type', true);
    await configStore.mutate(() => db.deleteSalaryRate(quotaType));
    await interaction.reply({ content: `✅ Taux de paie **${quotaType}** retiré.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const rates = await db.getAllSalaryRates();
    if (rates.length === 0) {
      await interaction.reply({ content: 'Aucun taux de paie configuré.', flags: MessageFlags.Ephemeral });
      return;
    }
    const lines = rates.map(r => `**${r.quotaType}** : ${r.amount}$/unité`);
    const embed = new EmbedBuilder().setTitle('⚙️ Taux de paie').setDescription(lines.join('\n')).setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

/** `/config type-groupe set|list`. */
async function handleTypeGroupe(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'set') {
    const tier = interaction.options.getString('tier', true) as configStore.GroupTier;
    await configStore.mutate(() => db.setSetting(configStore.TYPE_GROUPE_SETTING_KEY, tier));
    await quotas.updatePermanentMessage(interaction.client);
    // Le tier change VENTE_ITEMS/LABO_ITEMS (voir config-store.ts), qui pilotent
    // les champs "Drogue à vendre"/"Drogue de production" du Stock Général —
    // sans ce refresh, ce message resterait faux jusqu'au prochain mouvement.
    await stocks.updateStockMessage(interaction.client);
    // Le tier change aussi les zones/taxes fixes proposées à la création (voir
    // taxes.ts) — sans ce refresh, le panneau taxes resterait figé sur les
    // boutons de l'ancien tier jusqu'au prochain redémarrage du bot.
    await taxes.initPermanentMessage(interaction.client);
    const label = configStore.GROUP_TIERS.find(t => t.key === tier)?.label ?? tier;
    await interaction.reply({ content: `✅ Type d'organisation → **${label}**. Panneau d'activités, Stock Général et panneau Taxes mis à jour.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const current = configStore.get().TYPE_GROUPE;
    const activityTypes = configStore.get().ACTIVITY_TYPES;
    const lines = configStore.GROUP_TIERS.map(t => {
      const braquage = Object.entries(configStore.BRAQUAGE_LIMITS_BY_TIER[t.key])
        .map(([key, val]) => `${activityTypes[key]?.label ?? key} ${val}`)
        .join(' · ');
      const labos = Object.entries(configStore.LABO_TIERS)
        .filter(([, tiers]) => tiers.includes(t.key))
        .map(([key]) => activityTypes[key]?.label ?? key);
      const marker = t.key === current ? '👉 ' : '';
      return `${marker}**${t.label}**\nBraquages : ${braquage}\nLabos : ${labos.length ? labos.join(', ') : 'aucun'}`;
    });
    const embed = new EmbedBuilder()
      .setTitle("⚙️ Types d'organisation")
      .setDescription(lines.join('\n\n'))
      .setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

/** Autocomplete pour les options `nom`/`cle` des sous-commandes `remove`. */
export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup();
  const focused = interaction.options.getFocused(true);
  const query = focused.value.toLowerCase();

  let source: string[] = [];
  if (group === 'item') source = (await db.getAllItems()).map(i => i.name);

  const results = source.filter(v => v.toLowerCase().includes(query)).slice(0, 25);
  await interaction.respond(results.map(v => ({ name: v, value: v }))).catch(() => null);
}
