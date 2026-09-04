/**
 * @file src/modules/config.ts
 * @description Commande `/config` — toute la configuration métier du bot
 * (salons, rôles, items, activités déclarables, objectifs de quota, types
 * d'armes, salaire, plafonds munitions) se fait depuis Discord, en base,
 * sans jamais éditer de fichier ni redémarrer le process.
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

const ROLE_TARGETS = [
  { name: 'Rôle admin (commandes sensibles)', value: 'admin' },
  { name: 'Rôle accès taxes (back-office web)', value: 'taxes' },
];

/**
 * Convertit une clé libre (nom d'activité, d'arme…) en identifiant stable :
 * minuscules, espaces → underscores, caractères non alphanumériques retirés.
 */
function slugify(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

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
      .addBooleanOption(o => o.setName('vente').setDescription('Déclarable en vente de drogue (défaut : non)').setRequired(false))
      .addBooleanOption(o => o.setName('paiement').setDescription('Compte comme paiement de vente (défaut : non)').setRequired(false))
      .addStringOption(o => o.setName('groupe').setDescription('Libellé de regroupement dans le message de stock (optionnel)').setRequired(false)))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription('Retire un item suivi')
      .addStringOption(o => o.setName('nom').setDescription('Item à retirer').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('Liste les items suivis')
      .addStringOption(o => o.setName('filtre').setDescription('Filtrer par sous-chaîne (optionnel)').setRequired(false))));

  cmd.addSubcommandGroup(g => g
    .setName('activite')
    .setDescription('Activités déclarables (quotas, cooldowns, braquages, labos)')
    .addSubcommand(s => s
      .setName('add')
      .setDescription('Ajoute ou remplace une activité déclarable')
      .addStringOption(o => o.setName('cle').setDescription('Identifiant court (ex: fleeca, atm)').setRequired(true))
      .addStringOption(o => o.setName('label').setDescription('Libellé affiché').setRequired(true))
      .addStringOption(o => o.setName('quota_type').setDescription('Catégorie de quota (ex: actions, vente) — vide = aucun quota').setRequired(false))
      .addNumberOption(o => o.setName('cooldown_heures').setDescription('Cooldown personnel en heures (vide = aucun)').setRequired(false).setMinValue(0))
      .addBooleanOption(o => o.setName('partenaires').setDescription('Demande un sélecteur de participants (défaut : non)').setRequired(false))
      .addIntegerOption(o => o.setName('limite_braquage').setDescription('Limite hebdo partagée (slots de braquage) — vide = aucune').setRequired(false).setMinValue(1))
      .addChannelOption(o => o.setName('labo_salon').setDescription('Salon renommé 🔴/🟢 selon disponibilité (active le mode labo)').setRequired(false)
        .addChannelTypes(ChannelType.GuildText))
      .addBooleanOption(o => o.setName('quantite').setDescription('Demande une quantité dans le modal (défaut : non)').setRequired(false))
      .addBooleanOption(o => o.setName('sans_bouton').setDescription("N'affiche pas de bouton dans le panneau quotas (activité créditée par un autre module, ex: vente — défaut : non)").setRequired(false)))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription('Retire une activité déclarable')
      .addStringOption(o => o.setName('cle').setDescription('Activité à retirer').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('list').setDescription('Liste les activités configurées')));

  cmd.addSubcommandGroup(g => g
    .setName('quota')
    .setDescription('Objectifs hebdomadaires par catégorie de quota')
    .addSubcommand(s => s
      .setName('set')
      .setDescription("Fixe l'objectif hebdomadaire d'une catégorie de quota")
      .addStringOption(o => o.setName('quota_type').setDescription('Catégorie de quota (voir /config activite list)').setRequired(true))
      .addIntegerOption(o => o.setName('valeur').setDescription('Objectif hebdomadaire').setRequired(true).setMinValue(0)))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription("Retire l'objectif d'une catégorie de quota (reste suivie, sans cible)")
      .addStringOption(o => o.setName('quota_type').setDescription('Catégorie de quota').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('Liste les objectifs configurés')));

  cmd.addSubcommandGroup(g => g
    .setName('arme')
    .setDescription("Types d'armes proposés dans l'armurerie")
    .addSubcommand(s => s
      .setName('add')
      .setDescription("Ajoute ou remplace un type d'arme")
      .addStringOption(o => o.setName('cle').setDescription('Identifiant court').setRequired(true))
      .addStringOption(o => o.setName('label').setDescription('Libellé affiché').setRequired(true)))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription("Retire un type d'arme")
      .addStringOption(o => o.setName('cle').setDescription('Type à retirer').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('list').setDescription("Liste les types d'armes configurés")));

  cmd.addSubcommandGroup(g => g
    .setName('salaire')
    .setDescription('Paie')
    .addSubcommand(s => s
      .setName('set')
      .setDescription('Fixe le salaire ($) par unité de drogue vendue')
      .addNumberOption(o => o.setName('valeur').setDescription('Montant en $').setRequired(true).setMinValue(0))));

  cmd.addSubcommandGroup(g => g
    .setName('fourriere')
    .setDescription('Amende de mise en fourrière')
    .addSubcommand(s => s
      .setName('set')
      .setDescription('Fixe le montant ($) facturé par mise en fourrière')
      .addIntegerOption(o => o.setName('valeur').setDescription('Montant en $').setRequired(true).setMinValue(0))));

  cmd.addSubcommandGroup(g => g
    .setName('munitions')
    .setDescription('Plafonds indicatifs hebdomadaires de munitions')
    .addSubcommand(s => s
      .setName('set')
      .setDescription('Fixe un plafond indicatif hebdomadaire de munitions')
      .addStringOption(o => o.setName('type').setDescription('Fabrication ou vente').setRequired(true)
        .addChoices({ name: 'Fabrication', value: 'fabrication' }, { name: 'Vente', value: 'vente' }))
      .addIntegerOption(o => o.setName('valeur').setDescription('Plafond hebdomadaire').setRequired(true).setMinValue(0))));

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
  if (group === 'activite') return handleActivite(interaction, sub);
  if (group === 'quota') return handleQuota(interaction, sub);
  if (group === 'arme') return handleArme(interaction, sub);
  if (group === 'salaire') return handleSalaire(interaction, sub);
  if (group === 'fourriere') return handleFourriere(interaction, sub);
  if (group === 'munitions') return handleMunitions(interaction, sub);
}

async function handleChannel(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'set') {
    const role = interaction.options.getString('role', true);
    const salon = interaction.options.getChannel('salon', true);
    await db.setSetting(`channel:${role}`, salon.id);
    await configStore.reload();
    await interaction.reply({ content: `✅ Salon **${role}** → <#${salon.id}>`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'add-log-coffre' || sub === 'remove-log-coffre') {
    const salon = interaction.options.getChannel('salon', true);
    const current = configStore.get().CHANNELS.logs_coffres;
    const next = sub === 'add-log-coffre'
      ? [...new Set([...current, salon.id])]
      : current.filter(id => id !== salon.id);
    await db.setSetting('channel:logs_coffres', JSON.stringify(next));
    await configStore.reload();
    await interaction.reply({ content: `✅ Logs de coffre : ${next.length} salon(s) surveillé(s).`, flags: MessageFlags.Ephemeral });
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

async function handleRole(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'set') {
    const cible = interaction.options.getString('cible', true);
    const role = interaction.options.getRole('role', true);
    await db.setSetting(`role:${cible}`, role.id);
    await configStore.reload();
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

async function handleItem(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'add') {
    const nom = interaction.options.getString('nom', true);
    const vente = interaction.options.getBoolean('vente') ?? false;
    const paiement = interaction.options.getBoolean('paiement') ?? false;
    const groupe = interaction.options.getString('groupe');
    await db.upsertItem({ name: nom, stock_group: groupe, vente, vente_paiement: paiement });
    await configStore.reload();
    await interaction.reply({ content: `✅ Item **${nom}** enregistré${groupe ? ` (groupe : ${groupe})` : ''}${vente ? ' — vente' : ''}${paiement ? ' — paiement' : ''}.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'remove') {
    const nom = interaction.options.getString('nom', true);
    await db.deleteItem(nom);
    await configStore.reload();
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
    const lines = items.slice(0, 60).map(i => `**${i.name}**${i.stockGroup ? ` _(${i.stockGroup})_` : ''}${i.vente ? ' 💰' : ''}${i.ventePaiement ? ' 🪙' : ''}`);
    const embed = new EmbedBuilder()
      .setTitle(`⚙️ Items suivis (${items.length})`)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: '💰 vente · 🪙 paiement' })
      .setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

async function handleActivite(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'add') {
    const cle = slugify(interaction.options.getString('cle', true));
    const label = interaction.options.getString('label', true);
    const quotaType = interaction.options.getString('quota_type');
    const cooldownHeures = interaction.options.getNumber('cooldown_heures');
    const partenaires = interaction.options.getBoolean('partenaires') ?? false;
    const limiteBraquage = interaction.options.getInteger('limite_braquage');
    const laboSalon = interaction.options.getChannel('labo_salon');
    const quantite = interaction.options.getBoolean('quantite') ?? false;
    const sansBouton = interaction.options.getBoolean('sans_bouton') ?? false;
    if (!cle) {
      await interaction.reply({ content: '❌ Clé invalide.', flags: MessageFlags.Ephemeral });
      return;
    }
    await db.upsertActivityType({
      key: cle, label, quota_type: quotaType,
      cooldown_ms: cooldownHeures != null ? Math.round(cooldownHeures * 3_600_000) : null,
      partners: partenaires,
      braquage_weekly_limit: limiteBraquage,
      labo: !!laboSalon,
      labo_channel_id: laboSalon?.id ?? null,
      quantity: quantite,
      panel_button: !sansBouton,
    });
    await configStore.reload();
    await interaction.reply({ content: `✅ Activité **${cle}** (${label}) enregistrée.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'remove') {
    const cle = interaction.options.getString('cle', true);
    await db.deleteActivityType(cle);
    await configStore.reload();
    await interaction.reply({ content: `✅ Activité **${cle}** retirée.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const rows = await db.getAllActivityTypes();
    if (rows.length === 0) {
      await interaction.reply({ content: 'Aucune activité configurée.', flags: MessageFlags.Ephemeral });
      return;
    }
    const lines = rows.map(r => {
      const bits: string[] = [];
      if (r.quotaType) bits.push(`quota:${r.quotaType}`);
      if (r.cooldownMs) bits.push(`cooldown:${(r.cooldownMs / 3_600_000).toFixed(1)}h`);
      if (r.partners) bits.push('partenaires');
      if (r.braquageWeeklyLimit) bits.push(`braquage:${r.braquageWeeklyLimit}/sem`);
      if (r.labo) bits.push(`labo:<#${r.laboChannelId}>`);
      if (r.quantity) bits.push('quantité');
      if (!r.panelButton) bits.push('sans bouton');
      return `**${r.key}** — ${r.label}${bits.length ? ` _(${bits.join(', ')})_` : ''}`;
    });
    const embed = new EmbedBuilder().setTitle(`⚙️ Activités configurées (${rows.length})`).setDescription(lines.join('\n').slice(0, 4000)).setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

async function handleQuota(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'set') {
    const quotaType = interaction.options.getString('quota_type', true);
    const valeur = interaction.options.getInteger('valeur', true);
    await db.setQuotaTarget(quotaType, valeur);
    await configStore.reload();
    await interaction.reply({ content: `✅ Objectif **${quotaType}** → ${valeur}/semaine.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'remove') {
    const quotaType = interaction.options.getString('quota_type', true);
    await db.deleteQuotaTarget(quotaType);
    await configStore.reload();
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

async function handleArme(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'add') {
    const cle = slugify(interaction.options.getString('cle', true));
    const label = interaction.options.getString('label', true);
    if (!cle) {
      await interaction.reply({ content: '❌ Clé invalide.', flags: MessageFlags.Ephemeral });
      return;
    }
    await db.upsertArmeType({ key: cle, label });
    await configStore.reload();
    await interaction.reply({ content: `✅ Type d'arme **${label}** enregistré.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'remove') {
    const cle = interaction.options.getString('cle', true);
    await db.deleteArmeType(cle);
    await configStore.reload();
    await interaction.reply({ content: `✅ Type d'arme **${cle}** retiré.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === 'list') {
    const rows = await db.getAllArmeTypes();
    if (rows.length === 0) {
      await interaction.reply({ content: "Aucun type d'arme configuré.", flags: MessageFlags.Ephemeral });
      return;
    }
    const embed = new EmbedBuilder().setTitle("⚙️ Types d'armes").setDescription(rows.map(r => `**${r.key}** — ${r.label}`).join('\n')).setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

async function handleSalaire(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'set') {
    const valeur = interaction.options.getNumber('valeur', true);
    await db.setSetting('salaire_par_vente', valeur);
    await configStore.reload();
    await interaction.reply({ content: `✅ Salaire par vente → ${valeur}$.`, flags: MessageFlags.Ephemeral });
  }
}

async function handleFourriere(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'set') {
    const valeur = interaction.options.getInteger('valeur', true);
    await db.setSetting('fourriere_montant', valeur);
    await configStore.reload();
    await interaction.reply({ content: `✅ Amende de fourrière → ${valeur}$.`, flags: MessageFlags.Ephemeral });
  }
}

async function handleMunitions(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub === 'set') {
    const type = interaction.options.getString('type', true);
    const valeur = interaction.options.getInteger('valeur', true);
    await db.setSetting(`munitions_${type}_quota_hebdo`, valeur);
    await configStore.reload();
    await interaction.reply({ content: `✅ Plafond munitions (${type}) → ${valeur}/semaine.`, flags: MessageFlags.Ephemeral });
  }
}

/** Autocomplete pour les options `nom`/`cle` des sous-commandes `remove`. */
export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup();
  const focused = interaction.options.getFocused(true);
  const query = focused.value.toLowerCase();

  let source: string[] = [];
  if (group === 'item') source = (await db.getAllItems()).map(i => i.name);
  if (group === 'activite') source = (await db.getAllActivityTypes()).map(a => a.key);
  if (group === 'arme') source = (await db.getAllArmeTypes()).map(a => a.key);

  const results = source.filter(v => v.toLowerCase().includes(query)).slice(0, 25);
  await interaction.respond(results.map(v => ({ name: v, value: v }))).catch(() => null);
}
