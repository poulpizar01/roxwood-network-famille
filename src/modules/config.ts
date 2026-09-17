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
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type Client,
  type Guild,
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
        .addChannelTypes(ChannelType.GuildText))
      .addStringOption(o => o.setName('nom').setDescription('Nom pour distinguer ce coffre des autres (ex. "Coffre principal") — optionnel').setRequired(false)))
    .addSubcommand(s => s
      .setName('remove-log-coffre')
      .setDescription('Retire un salon de la liste des logs de coffre surveillés')
      .addChannelOption(o => o.setName('salon').setDescription('Salon Discord').setRequired(true)
        .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s
      .setName('add-log-coffre-admin')
      .setDescription('Ajoute un salon à la liste des logs de coffre admin surveillés (badge 🛡️)')
      .addChannelOption(o => o.setName('salon').setDescription('Salon Discord').setRequired(true)
        .addChannelTypes(ChannelType.GuildText))
      .addStringOption(o => o.setName('nom').setDescription('Nom pour distinguer ce coffre des autres — optionnel').setRequired(false)))
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
      .addBooleanOption(o => o.setName('visible_stock').setDescription('Afficher dans le message Stock Général (défaut : oui — le stock reste suivi même à non)').setRequired(false))
      .addStringOption(o => o.setName('labo_associe').setDescription('Cet item est lié à ce labo (voir role_labo pour le sens du lien) — optionnel').setRequired(false)
        .addChoices(...Object.entries(configStore.get(guildId).ACTIVITY_TYPES).filter(([, cfg]) => cfg.labo).map(([key, cfg]) => ({ name: cfg.label, value: key }))))
      .addStringOption(o => o.setName('role_labo').setDescription('Sens du lien : drogue produite (exclut vente PNJ) ou matériau consommé (défaut produit)').setRequired(false)
        .addChoices({ name: 'Produit (la drogue que ce labo fabrique)', value: 'produit' }, { name: 'Matériau (consommé par ce labo)', value: 'materiau' }))
      .addIntegerOption(o => o.setName('multiplicateur').setDescription('Unités de base par unité (ex. 24 pour une boîte de munitions — défaut 1)').setRequired(false).setMinValue(1)))
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
      .addNumberOption(o => o.setName('valeur').setDescription('Montant en $ par unité').setRequired(true).setMinValue(0))
      .addStringOption(o => o.setName('item').setDescription('Optionnel — limite ce taux à cette drogue (quota_type doit être "vente")').setRequired(false).setAutocomplete(true)))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription("Retire le taux de paie d'une catégorie de quota (elle ne génère plus de paie)")
      .addStringOption(o => o.setName('quota_type').setDescription('Catégorie de quota').setRequired(true))
      .addStringOption(o => o.setName('item').setDescription('Optionnel — ne retire que le taux spécifique à cette drogue').setRequired(false).setAutocomplete(true)))
    .addSubcommand(s => s.setName('list').setDescription('Liste les taux de paie configurés')));

  cmd.addSubcommandGroup(g => g
    .setName('classement')
    .setDescription('Points de classement (indépendants de la paie) par catégorie de quota')
    .addSubcommand(s => s
      .setName('set')
      .setDescription("Fixe les points de classement d'une catégorie de quota")
      .addStringOption(o => o.setName('quota_type').setDescription('Catégorie de quota (actions, vente, recolte, labos)').setRequired(true))
      .addIntegerOption(o => o.setName('valeur').setDescription('Points par unité').setRequired(true).setMinValue(0))
      .addStringOption(o => o.setName('activite').setDescription('Optionnel — limite ces points à cette activité (quota_type doit être "actions")').setRequired(false)
        .addChoices(...Object.entries(configStore.get(guildId).ACTIVITY_TYPES).filter(([, cfg]) => cfg.quotaType === 'actions').map(([key, cfg]) => ({ name: cfg.label, value: key })))))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription("Retire les points de classement d'une catégorie de quota")
      .addStringOption(o => o.setName('quota_type').setDescription('Catégorie de quota').setRequired(true))
      .addStringOption(o => o.setName('activite').setDescription('Optionnel — ne retire que les points spécifiques à cette activité').setRequired(false)
        .addChoices(...Object.entries(configStore.get(guildId).ACTIVITY_TYPES).filter(([, cfg]) => cfg.quotaType === 'actions').map(([key, cfg]) => ({ name: cfg.label, value: key })))))
    .addSubcommand(s => s.setName('list').setDescription('Liste les points de classement configurés')));

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
  if (group === 'classement') return handleClassement(interaction, guildId, sub);
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
    if (role === 'documentation') await initDocumentationMessage(interaction.client, guildId);
    // Idem pour le préfixe 🟢 d'un salon de labo : sans ça, il resterait sans
    // préfixe (ni rouge ni vert) jusqu'à la première déclaration de ce labo.
    // No-op silencieux si ce labo n'est pas actif pour le tier courant.
    if (role.startsWith('labo_')) await alertes.setLaboStatut(interaction.client, guildId, role, true);
    await interaction.reply({ content: `✅ Salon **${role}** → <#${salon.id}>`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'add-log-coffre' || sub === 'remove-log-coffre' || sub === 'add-log-coffre-admin' || sub === 'remove-log-coffre-admin') {
    const role = sub.endsWith('-admin') ? 'logs_coffres_admin' : 'logs_coffres';
    const otherRole = role === 'logs_coffres_admin' ? 'logs_coffres' : 'logs_coffres_admin';
    const salon = interaction.options.getChannel('salon', true);
    const nom = interaction.options.getString('nom') ?? undefined;
    // Un salon ne peut être que l'un OU l'autre, jamais les deux — sinon
    // coffreLogChannelIds() le traiterait deux fois (stocks.ts) et doublerait
    // ses mouvements à chaque rattrapage/resync.
    if (sub.startsWith('add-') && configStore.get(guildId).CHANNELS[otherRole].includes(salon.id)) {
      const otherLabel = otherRole === 'logs_coffres_admin' ? 'coffre admin' : 'coffre';
      const otherRemoveSub = otherRole === 'logs_coffres_admin' ? 'remove-log-coffre-admin' : 'remove-log-coffre';
      await interaction.reply({
        content: `❌ <#${salon.id}> est déjà configuré comme salon de logs **${otherLabel}** — un salon ne peut être que l'un ou l'autre, jamais les deux. Retire-le d'abord avec \`/config channel ${otherRemoveSub}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await configStore.mutate(guildId, () => sub.startsWith('add-')
      ? db.addChannelToRole(guildId, role, salon.id, nom)
      : db.removeChannelFromRole(guildId, role, salon.id));
    const total = configStore.get(guildId).CHANNELS[role].length;
    const roleLabel = role === 'logs_coffres_admin' ? 'coffre admin' : 'coffre';
    const nomSuffix = sub.startsWith('add-') && nom ? ` — nommé **${nom}**` : '';
    await interaction.reply({ content: `✅ Logs de ${roleLabel} : ${total} salon(s) surveillé(s)${nomSuffix}.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const c = configStore.get(guildId).CHANNELS;
    const lines = configStore.CHANNEL_ROLES.map(role => `**${role}** : ${c[role] ? `<#${c[role]}>` : '_non configuré_'}`);
    const formatCoffres = async (role: 'logs_coffres' | 'logs_coffres_admin') => {
      const salons = await db.getChannelsWithLabel(guildId, role);
      if (!salons.length) return '_aucun_';
      return salons.map(s => `<#${s.channelId}>${s.label ? ` (${s.label})` : ''}`).join(', ');
    };
    lines.push(`**logs_coffres** : ${await formatCoffres('logs_coffres')}`);
    lines.push(`**logs_coffres_admin** : ${await formatCoffres('logs_coffres_admin')}`);
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
    const stockGeneral = interaction.options.getBoolean('visible_stock') ?? true;
    const laboLie = interaction.options.getString('labo_associe');
    const roleLabo = interaction.options.getString('role_labo') as 'produit' | 'materiau' | null;
    const multiplicateur = interaction.options.getInteger('multiplicateur') ?? 1;
    await configStore.mutate(guildId, () => db.upsertItem(guildId, { name: nom, vente: ventePnj, visible_stock: stockGeneral, labo_lie: laboLie, labo_lie_role: roleLabo, stock_multiplier: multiplicateur }));
    // Sans ça, un item tout juste ajouté/masqué/regroupé n'apparaîtrait
    // correctement dans le Stock Général (et l'armurerie, si lié aux
    // munitions) qu'au prochain mouvement de coffre — pas immédiat.
    await stocks.updateStockMessage(interaction.client, guildId);
    const laboLabel = laboLie ? configStore.get(guildId).ACTIVITY_TYPES[laboLie]?.label : null;
    const roleLaboSuffix = laboLie ? (roleLabo === 'materiau' ? ' (matériau)' : ' (produit)') : '';
    await interaction.reply({ content: `✅ Item **${nom}** enregistré${ventePnj ? ' — vente PNJ' : ''}${!stockGeneral ? ' — masqué du Stock Général (stock toujours suivi)' : ''}${laboLabel ? ` — lié à ${laboLabel}${roleLaboSuffix}` : ''}${multiplicateur !== 1 ? ` — ×${multiplicateur} dans son groupe` : ''}.`, flags: MessageFlags.Ephemeral });
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
      const laboEmoji = i.laboLieRole === 'materiau' ? '🧱' : '🧪';
      const confirmeVente = i.name.toLowerCase() === CONFIRME_VENTE_ITEM.toLowerCase();
      return `**${i.name}**${i.stockGroup ? ` _(${i.stockGroup})_` : ''}${i.vente ? ' 💰' : ''}${confirmeVente ? ' 🪙' : ''}${!i.visibleStock ? ' 🙈' : ''}${laboLabel ? ` ${laboEmoji}${laboLabel}` : ''}${i.stockMultiplier !== 1 ? ` ×${i.stockMultiplier}` : ''}`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`⚙️ Items suivis (${items.length})`)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: '💰 vente PNJ · 🪙 confirme les ventes · 🙈 masqué du Stock Général · 🧪 produit d\'un labo (vente PNJ exclue si actif pour le tier) · 🧱 matériau d\'un labo · ×N unités de base par unité dans son groupe' })
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

/** `/config salaire set|remove|list` — `item` optionnel (uniquement avec `quota_type: vente`) fixe/retire un taux spécifique à une drogue, qui remplace le taux général "vente" pour elle seule. */
async function handleSalaire(interaction: ChatInputCommandInteraction, guildId: string, sub: string): Promise<void> {
  if (sub === 'set') {
    const quotaType = interaction.options.getString('quota_type', true);
    const valeur = interaction.options.getNumber('valeur', true);
    const item = interaction.options.getString('item');
    if (item && quotaType !== 'vente') {
      await interaction.reply({ content: "❌ `item` n'est utilisable qu'avec `quota_type: vente`.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (item) {
      await configStore.mutate(guildId, () => db.setItemSalaryRate(guildId, item, valeur));
      await interaction.reply({ content: `✅ Taux de paie **${item}** → ${valeur}$/unité (remplace le taux général "vente" pour cet item).`, flags: MessageFlags.Ephemeral });
    } else {
      await configStore.mutate(guildId, () => db.setSalaryRate(guildId, quotaType, valeur));
      await interaction.reply({ content: `✅ Taux de paie **${quotaType}** → ${valeur}$/unité.`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (sub === 'remove') {
    const quotaType = interaction.options.getString('quota_type', true);
    const item = interaction.options.getString('item');
    if (item) {
      await configStore.mutate(guildId, () => db.deleteItemSalaryRate(guildId, item));
      await interaction.reply({ content: `✅ Taux de paie spécifique de **${item}** retiré (retombe sur le taux général "vente").`, flags: MessageFlags.Ephemeral });
    } else {
      await configStore.mutate(guildId, () => db.deleteSalaryRate(guildId, quotaType));
      await interaction.reply({ content: `✅ Taux de paie **${quotaType}** retiré.`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (sub === 'list') {
    const rates = await db.getAllSalaryRates(guildId);
    const itemRates = await db.getAllItemSalaryRates(guildId);
    if (rates.length === 0 && itemRates.length === 0) {
      await interaction.reply({ content: 'Aucun taux de paie configuré.', flags: MessageFlags.Ephemeral });
      return;
    }
    const lines = [
      ...rates.map(r => `**${r.quotaType}** : ${r.amount}$/unité`),
      ...itemRates.map(r => `**${r.item}** (vente) : ${r.amount}$/unité`),
    ];
    const embed = new EmbedBuilder().setTitle('⚙️ Taux de paie').setDescription(lines.join('\n')).setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

/** `/config classement set|remove|list` — `activite` optionnel (uniquement avec `quota_type: actions`) fixe/retire des points spécifiques à une activité, qui remplacent le nombre général "actions" pour elle seule. */
async function handleClassement(interaction: ChatInputCommandInteraction, guildId: string, sub: string): Promise<void> {
  if (sub === 'set') {
    const quotaType = interaction.options.getString('quota_type', true);
    const valeur = interaction.options.getInteger('valeur', true);
    const activite = interaction.options.getString('activite');
    if (activite && quotaType !== 'actions') {
      await interaction.reply({ content: "❌ `activite` n'est utilisable qu'avec `quota_type: actions`.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (activite) {
      await configStore.mutate(guildId, () => db.setActivityClassementRate(guildId, activite, valeur));
      const label = configStore.get(guildId).ACTIVITY_TYPES[activite]?.label ?? activite;
      await interaction.reply({ content: `✅ Points de classement **${label}** → ${valeur} pt/unité (remplace le nombre général "actions" pour cette activité).`, flags: MessageFlags.Ephemeral });
    } else {
      await configStore.mutate(guildId, () => db.setClassementRate(guildId, quotaType, valeur));
      await interaction.reply({ content: `✅ Points de classement **${quotaType}** → ${valeur} pt/unité.`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (sub === 'remove') {
    const quotaType = interaction.options.getString('quota_type', true);
    const activite = interaction.options.getString('activite');
    if (activite) {
      await configStore.mutate(guildId, () => db.deleteActivityClassementRate(guildId, activite));
      const label = configStore.get(guildId).ACTIVITY_TYPES[activite]?.label ?? activite;
      await interaction.reply({ content: `✅ Points de classement spécifiques de **${label}** retirés (retombent sur le nombre général "actions").`, flags: MessageFlags.Ephemeral });
    } else {
      await configStore.mutate(guildId, () => db.deleteClassementRate(guildId, quotaType));
      await interaction.reply({ content: `✅ Points de classement **${quotaType}** retirés.`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (sub === 'list') {
    const rates = await db.getAllClassementRates(guildId);
    const activityRates = await db.getAllActivityClassementRates(guildId);
    if (rates.length === 0 && activityRates.length === 0) {
      await interaction.reply({ content: 'Aucun point de classement configuré.', flags: MessageFlags.Ephemeral });
      return;
    }
    const activityTypes = configStore.get(guildId).ACTIVITY_TYPES;
    const lines = [
      ...rates.map(r => `**${r.quotaType}** : ${r.amount} pt/unité`),
      ...activityRates.map(r => `**${activityTypes[r.activityKey]?.label ?? r.activityKey}** (actions) : ${r.amount} pt/unité`),
    ];
    const embed = new EmbedBuilder().setTitle('⚙️ Points de classement').setDescription(lines.join('\n')).setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

/** `/config type-groupe set|list`. */
async function handleTypeGroupe(interaction: ChatInputCommandInteraction, guildId: string, sub: string): Promise<void> {
  if (sub === 'set') {
    const tier = interaction.options.getString('tier', true) as configStore.GroupTier;
    // Les salons de labo à créer/supprimer sont des opérations Discord async
    // (peuvent dépasser 3s) — deferReply plutôt qu'un reply direct.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await configStore.mutate(guildId, () => db.setSetting(guildId, configStore.TYPE_GROUPE_SETTING_KEY, tier));
    await quotas.updatePermanentMessage(interaction.client, guildId);
    // Le tier change VENTE_ITEMS/LABO_ITEMS/MATERIAL_ITEMS (voir config-store.ts),
    // qui pilotent les champs "Drogues à vendre"/"Drogues de production"/
    // "Matériaux de production" du Stock Général — sans ce refresh, ce
    // message resterait faux jusqu'au prochain mouvement.
    await stocks.updateStockMessage(interaction.client, guildId);
    // Le tier change aussi les zones/taxes fixes proposées à la création (voir
    // taxes.ts) — sans ce refresh, le panneau taxes resterait figé sur les
    // boutons de l'ancien tier jusqu'au prochain redémarrage du bot.
    await taxes.initPermanentMessage(interaction.client, guildId);
    // Salons de labo : supprime ceux qui ne sont plus valides pour ce tier,
    // crée ceux qui le deviennent (voir docstring de syncLaboChannels).
    await syncLaboChannels(interaction, guildId, tier);
    const label = configStore.GROUP_TIERS.find(t => t.key === tier)?.label ?? tier;
    await interaction.editReply({ content: `✅ Type d'organisation → **${label}**. Panneau d'activités, Stock Général, panneau Taxes et salons de labo mis à jour.` });
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
 * de {@link CATEGORY_EXCLUDED_ROLES} en sont volontairement absents). Préfixe
 * emoji+"・" (séparateur point médian katakana) pour un classement visuel
 * cohérent dans la liste des salons Discord. Les salons de labo n'ont
 * volontairement PAS d'emoji statique ici : le leur (🟢/🔴) est posé
 * dynamiquement par `alertes.setLaboStatut`.
 */
const CHANNEL_NAME_BY_ROLE: Partial<Record<configStore.ChannelRole, string>> = {
  documentation: '📚・documentation',
  stock_general: '📦・stock',
  logs_activites: '📁・logs-activites',
  alertes_braquages: '⏰・alertes-braquages',
  alertes_actions: '⏰・alertes-actions',
  bilan: '📊・bilan',
  paie: '💰・paie',
  armurerie: '🔫・armurerie',
  quotas: '🎮・quotas',
  taxes: '🛃・taxes',
  alertes_taxes: '⏰・alertes-taxes',
  historique_stock: '📁・historique-stock',
  ventes_drogue: '💉・ventes-drogue',
  log_ventes: '📁・logs-ventes',
  admin: '🕵️・admin',
  labo_heroine: 'labo-heroine',
  labo_sporex: 'labo-sporex',
  labo_mexicana: 'labo-mexicana',
  labo_cannabis: 'labo-cannabis',
  labo_cocaine: 'labo-cocaine',
  labo_salvia: 'labo-salvia',
  labo_branche_cannabis: 'labo-branche-cannabis',
};

/**
 * URL du manuel complet, constante en dur — LA documentation de ce
 * déploiement (pas une donnée qui varie par guilde, contrairement à
 * `Guild.frontendUrl`), pointée par le bouton du salon `documentation`.
 */
const MANUEL_URL = 'https://claude.ai/code/artifact/843accbb-86d1-4a5a-ada8-dc38954ae36b';

/**
 * Poste (ou édite si déjà posté — même pattern que les autres panneaux
 * permanents) le message d'accueil du salon `documentation` : résumé du bot
 * + sommaire du manuel + bouton lien vers {@link MANUEL_URL}. Déclenchée
 * depuis `/config channel set role:documentation`, `/config category set`
 * (si le salon vient d'être créé) et `bootstrapGuild` (`index.ts`) au
 * démarrage pour chaque guilde déjà connue.
 */
export async function initDocumentationMessage(client: Client, guildId: string): Promise<void> {
  const channelId = configStore.get(guildId).CHANNELS.documentation;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return;

    const embed = new EmbedBuilder()
      .setTitle("📚 Bienvenue dans le dossier de l'organisation")
      .setColor(0xcf9f2e)
      .setDescription(
        "Ce salon regroupe tout ce qu'il faut savoir sur le bot : comment déclarer une activité, vendre, " +
        "gérer l'armurerie, poser une taxe, et comment un admin reconfigure tout ça depuis Discord.\n\n" +
        '**Au programme du manuel complet :**\n' +
        "🏴 Types d'organisation\n" + '📦 Stock général\n' + '🎮 Activités & quotas\n' +
        '💉 Ventes de drogue\n' + '🔫 Armurerie\n' + '🛃 Taxes & rackets\n' +
        '🚗 Garages & fourrière\n' + '🌿 Labos\n' + '🕵️ Administration',
      )
      .setFooter({ text: 'Mis à jour à chaque évolution du bot' })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel('📖 Ouvrir le manuel complet').setStyle(ButtonStyle.Link).setURL(MANUEL_URL),
    );

    const storedId = await db.getSetting(guildId, 'documentation_message_id');
    if (storedId) {
      const msg = await channel.messages.fetch(storedId).catch(() => null);
      if (msg) { await msg.edit({ embeds: [embed], components: [row] }); return; }
    }
    const newMsg = await channel.send({ embeds: [embed], components: [row] });
    await db.setSetting(guildId, 'documentation_message_id', newMsg.id);
  } catch (err) {
    console.error(`[config] initDocumentationMessage(${guildId}):`, (err as Error).message);
  }
}

/**
 * Ordre de tri des salons auto-créés (rôles absents — logs de coffre,
 * garages — jamais réordonnés). N'a de sens que RELATIVEMENT aux salons
 * d'une même catégorie, pas besoin de filtrer par catégorie.
 */
const CHANNEL_DISPLAY_ORDER: readonly configStore.ChannelRole[] = [
  'documentation',
  'quotas', 'ventes_drogue', 'taxes', 'armurerie',
  'labo_sporex', 'labo_heroine', 'labo_mexicana', 'labo_cannabis', 'labo_cocaine', 'labo_salvia', 'labo_branche_cannabis',
  'stock_general', 'paie', 'bilan',
  'alertes_taxes', 'alertes_braquages', 'alertes_actions',
  'historique_stock', 'log_ventes', 'logs_activites', 'admin',
];

/** Réordonne les salons déjà configurés d'une guilde selon {@link CHANNEL_DISPLAY_ORDER} — best-effort, jamais bloquant (permission "Gérer les salons" manquante possible). */
async function applyChannelOrder(guild: Guild, guildId: string): Promise<void> {
  const existing = configStore.get(guildId).CHANNELS;
  const ordered = CHANNEL_DISPLAY_ORDER.map(role => existing[role]).filter((id): id is string => !!id);
  if (!ordered.length) return;
  try {
    await guild.channels.setPositions(ordered.map((channel, position) => ({ channel, position })));
  } catch (err) {
    console.error('[config] applyChannelOrder :', (err as Error).message);
  }
}

/** Cherche la catégorie d'un salon de labo/panneau déjà existant, pour y créer un nouveau salon de labo au même endroit — `null` si aucun repère (création hors catégorie plutôt que d'échouer). */
async function resolveLaboCategoryId(interaction: ChatInputCommandInteraction, guildId: string): Promise<string | null> {
  const c = configStore.get(guildId).CHANNELS;
  const reperes = [c.labo_heroine, c.labo_sporex, c.labo_mexicana, c.labo_cannabis, c.labo_cocaine, c.labo_salvia, c.labo_branche_cannabis, c.quotas, c.stock_general];
  for (const id of reperes) {
    if (!id) continue;
    const channel = await interaction.guild?.channels.fetch(id).catch(() => null);
    if (channel && 'parentId' in channel && channel.parentId) return channel.parentId;
  }
  return null;
}

/**
 * Synchronise les salons de labo au changement de tier (`/config type-groupe
 * set`) : supprime les salons des labos qui ne sont plus valides pour le
 * nouveau tier, crée ceux des labos désormais valides mais sans salon. Un
 * labo commun à deux tiers garde son salon (jamais détruit puis recréé).
 * **Piège évité** : si la suppression Discord échoue, l'association en base
 * n'est PAS retirée — sinon le salon existe toujours sur Discord mais le bot
 * "l'oublie", et un futur retour à ce tier créerait un doublon.
 */
async function syncLaboChannels(interaction: ChatInputCommandInteraction, guildId: string, tier: configStore.GroupTier): Promise<void> {
  if (!interaction.guild) return;
  const allLabos = Object.keys(configStore.LABO_TIERS) as configStore.ChannelRole[];

  for (const labo of allLabos) {
    const channelId = configStore.get(guildId).CHANNELS[labo];
    if (!channelId || configStore.LABO_TIERS[labo].includes(tier)) continue;
    try {
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (channel) await channel.delete(`Changement de type d'organisation → ${tier}`);
      await configStore.mutate(guildId, () => db.removeChannelFromRole(guildId, labo, channelId));
    } catch (err) {
      console.error(`[config] type-groupe — suppression du salon ${labo} :`, (err as Error).message);
    }
  }

  const manquants = allLabos.filter(labo => configStore.LABO_TIERS[labo].includes(tier) && !configStore.get(guildId).CHANNELS[labo]);
  if (manquants.length) {
    const categoryId = await resolveLaboCategoryId(interaction, guildId);
    for (const labo of manquants) {
      try {
        const channel = await interaction.guild.channels.create({
          name: CHANNEL_NAME_BY_ROLE[labo] ?? labo,
          type: ChannelType.GuildText,
          ...(categoryId ? { parent: categoryId } : {}),
        });
        await configStore.mutate(guildId, () => db.setChannelRole(guildId, labo, channel.id));
        await alertes.setLaboStatut(interaction.client, guildId, labo, true);
      } catch (err) {
        console.error(`[config] type-groupe — création du salon ${labo} :`, (err as Error).message);
      }
    }
  }

  await applyChannelOrder(interaction.guild, guildId);
}

/**
 * `/config category set` : crée dans la catégorie donnée un salon texte pour
 * chaque rôle fonctionnel pas encore configuré (voir {@link
 * CHANNEL_NAME_BY_ROLE}/{@link CATEGORY_EXCLUDED_ROLES}), l'associe en base,
 * puis rafraîchit immédiatement les panneaux concernés — même rattrapage que
 * `/config channel set` (voir `handleChannel`), pour plusieurs salons d'un
 * coup. Un rôle déjà configuré n'est jamais recréé, mais s'il est mal placé
 * (pas dans cette catégorie), il est déplacé (`setParent`, jamais renommé ni
 * recréé). Un salon de labo n'est proposé à la création que s'il est valide
 * pour le tier courant (voir `LABO_TIERS`) — sinon tous les labos de tous les
 * tiers se retrouveraient créés en permanence quel que soit le tier choisi.
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
  const tier = configStore.get(guildId).TYPE_GROUPE;
  const laboValidePourTier = (role: configStore.ChannelRole) => !configStore.LABO_TIERS[role] || configStore.LABO_TIERS[role].includes(tier);
  const toCreate = (Object.entries(CHANNEL_NAME_BY_ROLE) as Array<[configStore.ChannelRole, string]>)
    .filter(([role]) => !CATEGORY_EXCLUDED_ROLES.includes(role) && !existing[role] && laboValidePourTier(role));

  const created: string[] = [];
  const failed: string[] = [];
  const documentationJusteCreee = toCreate.some(([role]) => role === 'documentation');

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
    if (documentationJusteCreee) await initDocumentationMessage(interaction.client, guildId);
    for (const [role] of toCreate) {
      if (role.startsWith('labo_')) await alertes.setLaboStatut(interaction.client, guildId, role, true);
    }
  }

  const alreadyConfigured = (Object.keys(CHANNEL_NAME_BY_ROLE) as configStore.ChannelRole[])
    .filter(role => !CATEGORY_EXCLUDED_ROLES.includes(role) && !!existing[role]);

  const moved: string[] = [];
  for (const role of alreadyConfigured) {
    const channelId = existing[role];
    if (!channelId) continue;
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !('setParent' in channel) || channel.parentId === categorie.id) continue;
    try {
      // `lockPermissions: false` : ne jamais changer qui peut voir le salon
      // en le déplaçant — un salon sensible (admin, taxes...) garde ses
      // permissions propres, pas celles héritées de la nouvelle catégorie.
      await channel.setParent(categorie.id, { lockPermissions: false });
      moved.push(`**${role}** → <#${channelId}>`);
    } catch (err) {
      console.error(`[config] category set — déplacement du salon ${role} :`, (err as Error).message);
    }
  }

  await applyChannelOrder(interaction.guild, guildId);

  const nonDeplaces = alreadyConfigured.filter(role => !moved.some(m => m.includes(`**${role}**`)));
  const lines = [
    created.length ? `✅ **${created.length} salon(s) créé(s)** dans <#${categorie.id}> :\n${created.join('\n')}` : null,
    moved.length ? `📁 **${moved.length} salon(s) déjà configuré(s) rangé(s)** dans <#${categorie.id}> :\n${moved.join('\n')}` : null,
    failed.length ? `⚠️ Échec pour : ${failed.join(', ')} (permission "Gérer les salons" manquante ?)` : null,
    nonDeplaces.length ? `ℹ️ Déjà configurés et déjà bien rangés : ${nonDeplaces.join(', ')}` : null,
  ].filter((l): l is string => l !== null);

  await interaction.editReply({ content: lines.join('\n\n') || 'Rien à faire — tous les salons sont déjà configurés et bien rangés.' });
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

/** Autocomplete pour les options `nom`/`item` des sous-groupes qui en ont besoin. */
export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup();
  const focused = interaction.options.getFocused(true);
  const query = focused.value.toLowerCase();

  let source: string[] = [];
  if (group === 'item') source = (await db.getAllItems(interaction.guildId!)).map(i => i.name);
  if (group === 'salaire') source = configStore.get(interaction.guildId!).VENTE_ITEMS;

  const results = source.filter(v => v.toLowerCase().includes(query)).slice(0, 25);
  await interaction.respond(results.map(v => ({ name: v, value: v }))).catch(() => null);
}
