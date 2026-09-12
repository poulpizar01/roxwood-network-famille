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
import * as guildRegistry from '../guild-registry';
import * as quotas from './quotas';
import * as stocks from './stocks';
import * as taxes from './taxes';
import * as armurerie from './armurerie';
import * as alertes from './alertes';
import { CONFIRME_VENTE_ITEM } from './ventes';
import { seedDefaultItems } from '../default-items';

const ROLE_TARGETS = [
  { name: 'Rôle admin (commandes sensibles)', value: 'admin' },
  { name: 'Rôle accès taxes (back-office web)', value: 'taxes' },
];

/** Déclare la commande `/config` et tous ses sous-groupes (channel, role, item, quota, salaire, type-groupe). `guildId` : les choix de `labo_lie` viennent du registre d'activités de CETTE guilde (déjà chargé en cache à ce stade — voir `bootstrapGuild` dans index.ts, qui appelle `configStore.reload()` avant `deployCommandsForGuild`). */
export function getCommands(guildId: string) {
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
    .addSubcommand(s => s
      .setName('add-log-coffre-admin')
      .setDescription('Ajoute un salon à la liste des logs de coffre admin surveillés (badge 🛡️)')
      .addChannelOption(o => o.setName('salon').setDescription('Salon Discord').setRequired(true)
        .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s
      .setName('remove-log-coffre-admin')
      .setDescription('Retire un salon de la liste des logs de coffre admin surveillés')
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
      .addStringOption(o => o.setName('groupe').setDescription('Libellé de regroupement dans le message de stock (optionnel)').setRequired(false))
      .addBooleanOption(o => o.setName('stock_general').setDescription('Afficher dans le message Stock Général (défaut : oui — le stock reste suivi même à non)').setRequired(false))
      .addStringOption(o => o.setName('labo_lie').setDescription("Ce labo produit cet item ? Exclut alors la vente PNJ pour les tiers ayant ce labo actif (optionnel)").setRequired(false)
        .addChoices(...Object.entries(configStore.get(guildId).ACTIVITY_TYPES).filter(([, cfg]) => cfg.labo).map(([key, cfg]) => ({ name: cfg.label, value: key })))))
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

  cmd.addSubcommandGroup(g => g
    .setName('category')
    .setDescription('Création automatique des salons manquants dans une catégorie')
    .addSubcommand(s => s
      .setName('set')
      .setDescription('Crée dans cette catégorie tous les salons de rôle pas encore configurés, et les associe')
      .addChannelOption(o => o.setName('categorie').setDescription('Catégorie Discord où créer les salons manquants').setRequired(true)
        .addChannelTypes(ChannelType.GuildCategory))));

  cmd.addSubcommandGroup(g => g
    .setName('site-externe')
    .setDescription("Site web externe autorisé à utiliser l'API REST du bot pour cette guilde")
    .addSubcommand(s => s
      .setName('set')
      .setDescription("Autorise ce site à se connecter à l'API (voir README, section Interopérabilité)")
      .addStringOption(o => o.setName('url').setDescription("URL du site (ex. https://mon-site.exemple.com)").setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription("Retire le site externe autorisé (désactive l'API pour cette guilde)"))
    .addSubcommand(s => s.setName('list').setDescription('Affiche le site externe actuellement configuré')));

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
  const guildId = interaction.guildId!;
  if (!isNativeAdmin(interaction)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs Discord.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Pas seulement au démarrage global du process (voir index.ts) : dès que
  // quelqu'un touche /config, quel que soit le moment (y compris un bot déjà
  // en cours d'exécution depuis un moment) — no-op si déjà fait, voir
  // seedDefaultItems.
  await seedDefaultItems(guildId);

  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();

  if (group === 'channel') return handleChannel(interaction, guildId, sub);
  if (group === 'role') return handleRole(interaction, guildId, sub);
  if (group === 'item') return handleItem(interaction, guildId, sub);
  if (group === 'quota') return handleQuota(interaction, guildId, sub);
  if (group === 'salaire') return handleSalaire(interaction, guildId, sub);
  if (group === 'type-groupe') return handleTypeGroupe(interaction, guildId, sub);
  if (group === 'category') return handleCategory(interaction, guildId, sub);
  if (group === 'site-externe') return handleSiteExterne(interaction, guildId, sub);
}

/** `/config channel set|add-log-coffre|remove-log-coffre|add-log-coffre-admin|remove-log-coffre-admin|list`. */
async function handleChannel(interaction: ChatInputCommandInteraction, guildId: string, sub: string): Promise<void> {
  if (sub === 'set') {
    const role = interaction.options.getString('role', true);
    const salon = interaction.options.getChannel('salon', true);
    await configStore.mutate(guildId, () => db.setChannelRole(guildId, role, salon.id));
    // Sans ça, un salon de panneau permanent (quotas/armurerie/taxes/stock)
    // configuré après le démarrage du bot resterait vide jusqu'au prochain
    // événement qui rafraîchit ce panneau (un mouvement de coffre, une
    // déclaration d'activité…) — voire jusqu'à un redémarrage pour `taxes`,
    // qui n'a aucun déclencheur de rafraîchissement indirect. Le bot n'étant
    // pas censé redémarrer une fois lancé, on crée/rafraîchit le panneau
    // immédiatement ici plutôt que de compter sur un événement indirect.
    if (role === 'stock_general') await stocks.updateStockMessage(interaction.client, guildId);
    if (role === 'armurerie') await armurerie.updatePermanentMessage(interaction.client, guildId);
    if (role === 'quotas') await quotas.updatePermanentMessage(interaction.client, guildId);
    if (role === 'taxes') await taxes.initPermanentMessage(interaction.client, guildId);
    // Idem pour le préfixe 🟢 d'un salon de labo : sans ça, il resterait sans
    // préfixe (ni rouge ni vert) jusqu'à la première déclaration de ce labo.
    // No-op silencieux si ce labo n'est pas actif pour le tier courant.
    if (role.startsWith('labo_')) await alertes.setLaboStatut(interaction.client, guildId, role, true);
    await interaction.reply({ content: `✅ Salon **${role}** → <#${salon.id}>`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'add-log-coffre' || sub === 'remove-log-coffre' || sub === 'add-log-coffre-admin' || sub === 'remove-log-coffre-admin') {
    const role = sub.endsWith('-admin') ? 'logs_coffres_admin' : 'logs_coffres';
    const salon = interaction.options.getChannel('salon', true);
    await configStore.mutate(guildId, () => sub.startsWith('add-')
      ? db.addChannelToRole(guildId, role, salon.id)
      : db.removeChannelFromRole(guildId, role, salon.id));
    const total = configStore.get(guildId).CHANNELS[role].length;
    const label = role === 'logs_coffres_admin' ? 'coffre admin' : 'coffre';
    await interaction.reply({ content: `✅ Logs de ${label} : ${total} salon(s) surveillé(s).`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const c = configStore.get(guildId).CHANNELS;
    const lines = configStore.CHANNEL_ROLES.map(role => `**${role}** : ${c[role] ? `<#${c[role]}>` : '_non configuré_'}`);
    lines.push(`**logs_coffres** : ${c.logs_coffres.length ? c.logs_coffres.map(id => `<#${id}>`).join(', ') : '_aucun_'}`);
    lines.push(`**logs_coffres_admin** : ${c.logs_coffres_admin.length ? c.logs_coffres_admin.map(id => `<#${id}>`).join(', ') : '_aucun_'}`);
    const embed = new EmbedBuilder().setTitle('⚙️ Salons configurés').setDescription(lines.join('\n')).setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

/** `/config role set|list`. */
async function handleRole(interaction: ChatInputCommandInteraction, guildId: string, sub: string): Promise<void> {
  if (sub === 'set') {
    const cible = interaction.options.getString('cible', true);
    const role = interaction.options.getRole('role', true);
    await configStore.mutate(guildId, () => db.setDiscordRole(guildId, cible, role.id));
    await interaction.reply({ content: `✅ Rôle **${cible}** → <@&${role.id}>`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const c = configStore.get(guildId);
    const lines = [
      `**admin** : ${c.ADMIN_ROLE_ID ? `<@&${c.ADMIN_ROLE_ID}>` : '_non configuré (permissions Discord natives utilisées)_'}`,
      `**taxes** : ${c.TAXES_ROLE_ID ? `<@&${c.TAXES_ROLE_ID}>` : '_non configuré_'}`,
    ];
    const embed = new EmbedBuilder().setTitle('⚙️ Rôles configurés').setDescription(lines.join('\n')).setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

/** `/config item add|remove|list`. */
async function handleItem(interaction: ChatInputCommandInteraction, guildId: string, sub: string): Promise<void> {
  if (sub === 'add') {
    const nom = interaction.options.getString('nom', true);
    const ventePnj = interaction.options.getBoolean('vente_pnj') ?? false;
    const groupe = interaction.options.getString('groupe');
    const stockGeneral = interaction.options.getBoolean('stock_general') ?? true;
    const laboLie = interaction.options.getString('labo_lie');
    await configStore.mutate(guildId, () => db.upsertItem(guildId, { name: nom, stock_group: groupe, vente: ventePnj, visible_stock: stockGeneral, labo_lie: laboLie }));
    // Sans ça, un item tout juste ajouté/masqué/regroupé n'apparaîtrait
    // correctement dans le Stock Général (et l'armurerie, si lié aux
    // munitions) qu'au prochain mouvement de coffre — pas immédiat.
    await stocks.updateStockMessage(interaction.client, guildId);
    const laboLabel = laboLie ? configStore.get(guildId).ACTIVITY_TYPES[laboLie]?.label : null;
    await interaction.reply({ content: `✅ Item **${nom}** enregistré${groupe ? ` (groupe : ${groupe})` : ''}${ventePnj ? ' — vente PNJ' : ''}${!stockGeneral ? ' — masqué du Stock Général (stock toujours suivi)' : ''}${laboLabel ? ` — lié à ${laboLabel}` : ''}.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'remove') {
    const nom = interaction.options.getString('nom', true);
    await configStore.mutate(guildId, () => db.deleteItem(guildId, nom));
    await stocks.updateStockMessage(interaction.client, guildId);
    await interaction.reply({ content: `✅ Item **${nom}** retiré.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const filtre = interaction.options.getString('filtre')?.toLowerCase();
    let items = await db.getAllItems(guildId);
    if (filtre) items = items.filter(i => i.name.toLowerCase().includes(filtre));
    if (items.length === 0) {
      await interaction.reply({ content: 'Aucun item trouvé.', flags: MessageFlags.Ephemeral });
      return;
    }
    const activityTypes = configStore.get(guildId).ACTIVITY_TYPES;
    const lines = items.slice(0, 60).map(i => {
      const laboLabel = i.laboLie ? activityTypes[i.laboLie]?.label ?? i.laboLie : null;
      const confirmeVente = i.name.toLowerCase() === CONFIRME_VENTE_ITEM.toLowerCase();
      return `**${i.name}**${i.stockGroup ? ` _(${i.stockGroup})_` : ''}${i.vente ? ' 💰' : ''}${confirmeVente ? ' 🪙' : ''}${!i.visibleStock ? ' 🙈' : ''}${laboLabel ? ` 🧪${laboLabel}` : ''}`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`⚙️ Items suivis (${items.length})`)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: '💰 vente PNJ · 🪙 confirme les ventes · 🙈 masqué du Stock Général · 🧪 lié à un labo (vente PNJ exclue si ce labo est actif pour le tier)' })
      .setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

/** `/config quota set|remove|list`. */
async function handleQuota(interaction: ChatInputCommandInteraction, guildId: string, sub: string): Promise<void> {
  if (sub === 'set') {
    const quotaType = interaction.options.getString('quota_type', true);
    const valeur = interaction.options.getInteger('valeur', true);
    await configStore.mutate(guildId, () => db.setQuotaTarget(guildId, quotaType, valeur));
    await interaction.reply({ content: `✅ Objectif **${quotaType}** → ${valeur}/semaine.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'remove') {
    const quotaType = interaction.options.getString('quota_type', true);
    await configStore.mutate(guildId, () => db.deleteQuotaTarget(guildId, quotaType));
    await interaction.reply({ content: `✅ Objectif **${quotaType}** retiré.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const targets = await db.getAllQuotaTargets(guildId);
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
async function handleSalaire(interaction: ChatInputCommandInteraction, guildId: string, sub: string): Promise<void> {
  if (sub === 'set') {
    const quotaType = interaction.options.getString('quota_type', true);
    const valeur = interaction.options.getNumber('valeur', true);
    await configStore.mutate(guildId, () => db.setSalaryRate(guildId, quotaType, valeur));
    await interaction.reply({ content: `✅ Taux de paie **${quotaType}** → ${valeur}$/unité.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'remove') {
    const quotaType = interaction.options.getString('quota_type', true);
    await configStore.mutate(guildId, () => db.deleteSalaryRate(guildId, quotaType));
    await interaction.reply({ content: `✅ Taux de paie **${quotaType}** retiré.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const rates = await db.getAllSalaryRates(guildId);
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
async function handleTypeGroupe(interaction: ChatInputCommandInteraction, guildId: string, sub: string): Promise<void> {
  if (sub === 'set') {
    const tier = interaction.options.getString('tier', true) as configStore.GroupTier;
    await configStore.mutate(guildId, () => db.setSetting(guildId, configStore.TYPE_GROUPE_SETTING_KEY, tier));
    await quotas.updatePermanentMessage(interaction.client, guildId);
    // Le tier change VENTE_ITEMS/LABO_ITEMS (voir config-store.ts), qui pilotent
    // les champs "Drogue à vendre"/"Drogue de production" du Stock Général —
    // sans ce refresh, ce message resterait faux jusqu'au prochain mouvement.
    await stocks.updateStockMessage(interaction.client, guildId);
    // Le tier change aussi les zones/taxes fixes proposées à la création (voir
    // taxes.ts) — sans ce refresh, le panneau taxes resterait figé sur les
    // boutons de l'ancien tier jusqu'au prochain redémarrage du bot.
    await taxes.initPermanentMessage(interaction.client, guildId);
    const label = configStore.GROUP_TIERS.find(t => t.key === tier)?.label ?? tier;
    await interaction.reply({ content: `✅ Type d'organisation → **${label}**. Panneau d'activités, Stock Général et panneau Taxes mis à jour.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const current = configStore.get(guildId).TYPE_GROUPE;
    const activityTypes = configStore.get(guildId).ACTIVITY_TYPES;
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

/**
 * Salons de rôle alimentés par le bot de jeu FiveM (pas par ce bot Discord) —
 * exclus de la création automatique (`/config category set`) : ils doivent
 * pointer vers le vrai salon de logs déjà existant, jamais un salon vide
 * fraîchement créé. `logs_coffres`/`logs_coffres_admin` (plusieurs salons
 * possibles chacun, voir `add-log-coffre`/`add-log-coffre-admin`) n'ont de
 * toute façon pas d'entrée dans {@link CHANNEL_NAME_BY_ROLE} donc n'ont pas
 * besoin d'être listés ici.
 */
const CATEGORY_EXCLUDED_ROLES: readonly configStore.ChannelRole[] = ['logs_garages'];

/**
 * Nom de salon par défaut pour chaque rôle auto-créable via `/config category
 * set` — seuls les rôles présents ici sont candidats à la création (les rôles
 * de {@link CATEGORY_EXCLUDED_ROLES} en sont volontairement absents).
 */
const CHANNEL_NAME_BY_ROLE: Partial<Record<configStore.ChannelRole, string>> = {
  stock_general: 'stock',
  logs_activites: 'logs-activites',
  alertes_braquages: 'alertes-braquages',
  alertes_actions: 'alertes-actions',
  bilan: 'bilan',
  paie: 'paie',
  armurerie: 'armurerie',
  quotas: 'quotas',
  taxes: 'taxes',
  alertes_taxes: 'alertes-taxes',
  historique_stock: 'historique-stock',
  ventes_drogue: 'ventes-drogue',
  log_ventes: 'log-ventes',
  admin: 'admin',
  labo_heroine: 'labo-heroine',
  labo_sporex: 'labo-sporex',
  labo_mexicana: 'labo-mexicana',
  labo_cannabis: 'labo-cannabis',
  labo_cocaine: 'labo-cocaine',
};

/**
 * `/config category set` : crée dans la catégorie donnée un salon texte pour
 * chaque rôle fonctionnel pas encore configuré (voir {@link
 * CHANNEL_NAME_BY_ROLE}/{@link CATEGORY_EXCLUDED_ROLES}), l'associe en base,
 * puis rafraîchit immédiatement les panneaux concernés — même rattrapage que
 * `/config channel set` (voir `handleChannel`), pour plusieurs salons d'un
 * coup. Un rôle déjà configuré n'est jamais recréé ni touché (ré-exécutable
 * sans risque de doublons).
 */
async function handleCategory(interaction: ChatInputCommandInteraction, guildId: string, sub: string): Promise<void> {
  if (sub !== 'set') return;

  const categorie = interaction.options.getChannel('categorie', true);
  if (!interaction.guild) {
    await interaction.reply({ content: '❌ Cette commande ne peut être utilisée que dans un serveur.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const existing = configStore.get(guildId).CHANNELS;
  const toCreate = (Object.entries(CHANNEL_NAME_BY_ROLE) as Array<[configStore.ChannelRole, string]>)
    .filter(([role]) => !CATEGORY_EXCLUDED_ROLES.includes(role) && !existing[role]);

  const created: string[] = [];
  const failed: string[] = [];

  for (const [role, name] of toCreate) {
    try {
      const channel = await interaction.guild.channels.create({ name, type: ChannelType.GuildText, parent: categorie.id });
      await configStore.mutate(guildId, () => db.setChannelRole(guildId, role, channel.id));
      created.push(`**${role}** → <#${channel.id}>`);
    } catch (err) {
      console.error(`[config] category set — création du salon ${role} :`, (err as Error).message);
      failed.push(role);
    }
  }

  if (created.length) {
    // Même rattrapage que /config channel set (voir handleChannel) : sans
    // ça, ces panneaux resteraient vides jusqu'au prochain événement
    // indirect (mouvement de coffre, déclaration…), voire jusqu'à un
    // redémarrage pour taxes, qui n'a aucun rattrapage indirect.
    if (!existing.stock_general) await stocks.updateStockMessage(interaction.client, guildId);
    if (!existing.armurerie) await armurerie.updatePermanentMessage(interaction.client, guildId);
    if (!existing.quotas) await quotas.updatePermanentMessage(interaction.client, guildId);
    if (!existing.taxes) await taxes.initPermanentMessage(interaction.client, guildId);
    for (const [role] of toCreate) {
      if (role.startsWith('labo_')) await alertes.setLaboStatut(interaction.client, guildId, role, true);
    }
  }

  const alreadyConfigured = (Object.keys(CHANNEL_NAME_BY_ROLE) as configStore.ChannelRole[])
    .filter(role => !CATEGORY_EXCLUDED_ROLES.includes(role) && !!existing[role]);

  const lines = [
    created.length ? `✅ **${created.length} salon(s) créé(s)** dans <#${categorie.id}> :\n${created.join('\n')}` : null,
    failed.length ? `⚠️ Échec pour : ${failed.join(', ')} (permission "Gérer les salons" manquante ?)` : null,
    alreadyConfigured.length ? `ℹ️ Déjà configurés, non touchés : ${alreadyConfigured.join(', ')}` : null,
  ].filter((l): l is string => l !== null);

  await interaction.editReply({ content: lines.join('\n\n') || 'Rien à faire — tous les salons sont déjà configurés.' });
}

/**
 * `/config site-externe set|remove|list` : autorise (ou retire) un site
 * externe à utiliser l'API REST du bot pour CETTE guilde (voir README,
 * section Interopérabilité, et `guild-registry.setGuildSite`) — self-serve
 * depuis Discord, chaque guilde configure le sien indépendamment.
 */
async function handleSiteExterne(interaction: ChatInputCommandInteraction, guildId: string, sub: string): Promise<void> {
  if (sub === 'set') {
    const url = interaction.options.getString('url', true).trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      await interaction.reply({ content: '❌ URL invalide — attendu une URL complète (ex. https://mon-site.exemple.com).', flags: MessageFlags.Ephemeral });
      return;
    }
    // Un schéma non http(s) (data:, javascript:, file:...) donne une origine
    // OPAQUE — `.origin` vaut alors la CHAÎNE LITTÉRALE "null", pas rejetée
    // par le constructeur URL. Comme `isKnownCorsOrigin` (guild-registry.ts)
    // partage un seul Set entre toutes les guildes, laisser passer "null"
    // ouvrirait le CORS de TOUTES les guildes aux contextes qui envoient un
    // header `Origin: null` littéral (iframe sandboxée, file://...), pas
    // seulement celle mal configurée.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      await interaction.reply({ content: '❌ URL invalide — seuls les schémas http:// et https:// sont acceptés.', flags: MessageFlags.Ephemeral });
      return;
    }
    const origin = parsed.origin;
    await guildRegistry.setGuildSite(guildId, url, origin);
    await interaction.reply({ content: `✅ Site externe autorisé : **${url}**\nOrigine CORS acceptée : \`${origin}\``, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'remove') {
    await guildRegistry.setGuildSite(guildId, null, null);
    await interaction.reply({ content: "✅ Site externe retiré — l'API REST refusera désormais toute connexion pour cette guilde.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const { frontendUrl, corsOrigin } = await guildRegistry.getGuildSite(guildId);
    const embed = new EmbedBuilder()
      .setTitle('⚙️ Site externe')
      .setDescription(frontendUrl
        ? `**Site** : ${frontendUrl}\n**Origine CORS** : \`${corsOrigin}\``
        : "_Aucun site externe configuré — voir `/config site-externe set`._")
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
  if (group === 'item') source = (await db.getAllItems(interaction.guildId!)).map(i => i.name);

  const results = source.filter(v => v.toLowerCase().includes(query)).slice(0, 25);
  await interaction.respond(results.map(v => ({ name: v, value: v }))).catch(() => null);
}
