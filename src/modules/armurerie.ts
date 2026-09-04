/**
 * @file src/modules/armurerie.ts
 * @description Gestion de l'inventaire d'armes de l'organisation (contexte RP FiveM).
 *
 * Chaque arme a un statut ('en_stock' | 'pretee' | 'perdue') et un `type`.
 * Contrairement à items/activités/quotas, les types d'armes restent une
 * liste fixe dans le code ({@link ARME_TYPES} ci-dessous, pas de `/config
 * arme`) — le champ `type` stocké en base est la CLÉ du type, pas son
 * libellé affiché.
 *
 * Un message permanent dans le salon `armurerie` expose : Ajouter, Perdu,
 * Prêter, Rendu, Liste des Pertes, et deux déclarations indicatives de
 * munitions (Fabrication / Vente, plafonds fixes ci-dessous) — Historique.
 */
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  type Client,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';
import { replyAutoDelete, updateAutoDelete } from '../interaction-helpers';

/** Types d'armes proposés à l'ajout — liste fixe (voir docstring de fichier). */
const ARME_TYPES: Array<{ key: string; label: string }> = [
  // À compléter avec la liste fournie par l'utilisateur.
];

/** Plafonds indicatifs hebdomadaires de munitions — valeurs fixes, ne bougent jamais. */
const MUNITIONS_FABRICATION_QUOTA_HEBDO = 5000;
const MUNITIONS_VENTE_QUOTA_HEBDO = 5000;

// ─── STATUT LABELS ───────────────────────────────────────────────────────────

function statutLabel(arme: { statut: string; preteeA?: string | null }): string {
  switch (arme.statut) {
    case 'en_stock': return '🟢 En Stock';
    case 'pretee': return `🟡 Prêtée à ${arme.preteeA || '?'}`;
    case 'perdue': return '🔴 Perdue';
    default: return arme.statut;
  }
}

// ─── TRI NATUREL ──────────────────────────────────────────────────────────────

/** Tri numérique par segment (G2 avant G10) plutôt que lexicographique. */
function comparerNomsNaturel(a: { nom: string }, b: { nom: string }): number {
  const segsA = a.nom.match(/\d+|\D+/g) || [];
  const segsB = b.nom.match(/\d+|\D+/g) || [];
  const len = Math.max(segsA.length, segsB.length);

  for (let i = 0; i < len; i++) {
    const sa = segsA[i] || '';
    const sb = segsB[i] || '';
    const na = Number(sa);
    const nb = Number(sb);

    if (sa !== '' && sb !== '' && !isNaN(na) && !isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa.localeCompare(sb);
    }
  }
  return 0;
}

// ─── EMBED ARMURERIE ─────────────────────────────────────────────────────────

type Arme = Awaited<ReturnType<typeof db.getAllArmes>>[number];

async function buildArmurierieEmbed(armes: Arme[]): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder().setTitle('🔫 Armurerie').setColor(0xFEE75C).setTimestamp().setFooter({ text: 'Mis à jour' });

  const munitions = await db.getStock('munitions de pistolet');
  const sinceReset = Number((await db.getSetting('last_weekly_reset')) || 0);
  const fabriquees = await db.getMunitionsFabriqueesDepuis(sinceReset);
  const vendues = await db.getMunitionsVenduesDepuis(sinceReset);
  const blocs = [
    `__Munitions de pistolet__\n🧰 ${munitions} balles en stock\n🛠️ ${fabriquees} / ${MUNITIONS_FABRICATION_QUOTA_HEBDO} fabriquées cette semaine\n💰 ${vendues} / ${MUNITIONS_VENTE_QUOTA_HEBDO} vendues cette semaine`,
  ];

  if (!armes.length) {
    embed.setDescription(blocs.join('\n\n') + '\n\n*Aucune arme enregistrée*');
    return embed;
  }

  const groupes = new Map<string, Arme[]>();
  for (const t of ARME_TYPES) groupes.set(t.key, []);
  const sansType: Arme[] = [];

  for (const a of armes) {
    if (a.type && groupes.has(a.type)) {
      groupes.get(a.type)!.push(a);
    } else {
      sansType.push(a);
    }
  }

  const ligneArme = (a: Arme) => `**${a.nom}** \`${a.reference}\` — ${statutLabel(a)}`;

  for (const t of ARME_TYPES) {
    const liste = groupes.get(t.key)!;
    if (!liste.length) continue;
    liste.sort(comparerNomsNaturel);
    blocs.push(`__${t.label}__\n${liste.map(ligneArme).join('\n')}`);
  }
  if (sansType.length) {
    sansType.sort(comparerNomsNaturel);
    blocs.push(`__Sans type__\n${sansType.map(ligneArme).join('\n')}`);
  }

  embed.setDescription(blocs.join('\n\n'));
  return embed;
}

// ─── BOUTONS PRINCIPAUX ───────────────────────────────────────────────────────

function buildArmurierieButtons(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('arm_ajouter').setLabel('Ajouter').setStyle(ButtonStyle.Success).setEmoji('➕'),
      new ButtonBuilder().setCustomId('arm_retirer').setLabel('Perdu').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
      new ButtonBuilder().setCustomId('arm_preter').setLabel('Prêter').setStyle(ButtonStyle.Primary).setEmoji('🤝'),
      new ButtonBuilder().setCustomId('arm_rendu').setLabel('Rendu').setStyle(ButtonStyle.Success).setEmoji('✅'),
      new ButtonBuilder().setCustomId('arm_pertes').setLabel('Liste des Pertes').setStyle(ButtonStyle.Secondary).setEmoji('📋'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('arm_fabrication').setLabel('Fabrication').setStyle(ButtonStyle.Secondary).setEmoji('🛠️'),
      new ButtonBuilder().setCustomId('arm_vente_munitions').setLabel('Vente').setStyle(ButtonStyle.Secondary).setEmoji('💰'),
      new ButtonBuilder().setCustomId('arm_historique_munitions').setLabel('Historique').setStyle(ButtonStyle.Secondary).setEmoji('📜'),
    ),
  ];
}

// ─── MESSAGE PERMANENT ────────────────────────────────────────────────────────

export async function updatePermanentMessage(client: Client): Promise<void> {
  const channelId = configStore.get().CHANNELS.armurerie;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return;

    const armes = (await db.getAllArmes()).filter(a => a.statut !== 'perdue');
    const embed = await buildArmurierieEmbed(armes);
    const rows = buildArmurierieButtons();

    const storedId = await db.getSetting('armurerie_message_id');
    if (storedId) {
      const msg = await channel.messages.fetch(storedId).catch(() => null);
      if (msg) { await msg.edit({ embeds: [embed], components: rows }); return; }
    }

    const newMsg = await channel.send({ embeds: [embed], components: rows });
    await db.setSetting('armurerie_message_id', newMsg.id);
  } catch (err) {
    console.error('[armurerie] updatePermanentMessage:', (err as Error).message);
  }
}

export async function initPermanentMessage(client: Client): Promise<void> {
  await updatePermanentMessage(client);
}

// ─── HANDLER BOUTONS ─────────────────────────────────────────────────────────

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId;

  if (id === 'arm_ajouter') {
    const types = ARME_TYPES;
    if (!types.length) {
      return replyAutoDelete(interaction, "❌ Aucun type d'arme défini dans le code (ARME_TYPES est vide dans src/modules/armurerie.ts).");
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId('arm_select_ajouter_type')
      .setPlaceholder("Quel type d'arme ?")
      .addOptions(types.map(t => ({ label: t.label, value: t.key })));

    return replyAutoDelete(interaction, {
      content: "➕ Quel type d'arme veux-tu ajouter ?",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    }, { deleteAfterMs: 60_000 });
  }

  if (id === 'arm_retirer' || id === 'arm_preter' || id === 'arm_rendu') {
    const action = id.replace('arm_', '');
    const titres: Record<string, string> = { retirer: 'Retirer une arme', preter: 'Prêter une arme', rendu: 'Marquer une arme comme rendue' };

    const modal = new ModalBuilder()
      .setCustomId(`modal_arm_recherche_${action}`)
      .setTitle(titres[action])
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('recherche').setLabel('Nom ou référence (vide = tout afficher)')
            .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50),
        ),
      );
    return interaction.showModal(modal);
  }

  if (id === 'arm_fabrication') {
    const modal = new ModalBuilder()
      .setCustomId('modal_arm_fabrication')
      .setTitle('Fabrication de munitions')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('quantite').setLabel('Nombre de munitions fabriquées')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6),
        ),
      );
    return interaction.showModal(modal);
  }

  if (id === 'arm_vente_munitions') {
    const modal = new ModalBuilder()
      .setCustomId('modal_arm_vente_munitions')
      .setTitle('Vente de munitions')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('quantite').setLabel('Nombre de munitions vendues')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('acheteur_id').setLabel("ID unique de l'acheteur")
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('prix').setLabel('Prix total ($)')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10),
        ),
      );
    return interaction.showModal(modal);
  }

  if (id === 'arm_pertes') {
    const pertes = await db.getArmesPerdue();
    const embed = new EmbedBuilder()
      .setTitle('📋 Armes perdues')
      .setColor(0xED4245)
      .setDescription(pertes.length ? pertes.map(a => `**${a.nom}** \`${a.reference}\``).join('\n') : '*Aucune arme perdue*');
    return replyAutoDelete(interaction, { embeds: [embed] });
  }

  if (id === 'arm_historique_munitions') {
    const formatDate = (ts: number) => new Date(ts).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });

    const fabrications = await db.getFabricationMunitionsHistorique(15);
    const ventes = await db.getMunitionsVentesHistorique(15);

    const blocFab = fabrications.length ? fabrications.map(f => `${formatDate(f.timestamp)} — **${f.quantite}** munitions`).join('\n') : '*Aucune déclaration*';
    const blocVente = ventes.length ? ventes.map(v => `${formatDate(v.timestamp)} — **${v.quantite}** munitions à \`${v.acheteur_id}\` pour **${v.prix}$**`).join('\n') : '*Aucune déclaration*';

    const embed = new EmbedBuilder()
      .setTitle('📜 Historique munitions')
      .setColor(0x5865F2)
      .addFields(
        { name: '🛠️ Fabrication (15 dernières)', value: blocFab },
        { name: '💰 Vente (15 dernières)', value: blocVente },
      );
    return replyAutoDelete(interaction, { embeds: [embed] });
  }
}

// ─── HANDLER SELECT MENUS ─────────────────────────────────────────────────────

export async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const id = interaction.customId;

  if (id === 'arm_select_ajouter_type') {
    const typeKey = interaction.values[0];
    const type = ARME_TYPES.find(t => t.key === typeKey);
    if (!type) return updateAutoDelete(interaction, { content: '❌ Type invalide.', components: [] });

    const modal = new ModalBuilder()
      .setCustomId(`modal_arm_ajouter_${typeKey}`)
      .setTitle(`Ajouter : ${type.label}`.slice(0, 45))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('nom').setLabel("Nom de l'arme").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('reference').setLabel('Référence (unique)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30),
        ),
      );
    return interaction.showModal(modal);
  }

  if (id === 'arm_select_retirer') {
    const armeId = parseInt(interaction.values[0], 10);
    const arme = await db.getArme(armeId);
    if (!arme) return updateAutoDelete(interaction, { content: '❌ Arme introuvable.', components: [] });
    await db.updateArmeStatut(armeId, 'perdue', null);
    await updateAutoDelete(interaction, { content: `🔴 **${arme.nom}** (\`${arme.reference}\`) marquée comme **perdue**.`, components: [] });
    await updatePermanentMessage(interaction.client);
    return;
  }

  if (id === 'arm_select_preter') {
    const armeId = interaction.values[0];
    const arme = await db.getArme(parseInt(armeId, 10));
    if (!arme) return updateAutoDelete(interaction, { content: '❌ Arme introuvable.', components: [] });

    const modal = new ModalBuilder()
      .setCustomId(`modal_arm_preter_${armeId}`)
      .setTitle(`Prêter : ${arme.nom}`.slice(0, 45))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('pretee_a').setLabel('Nom de la personne').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50),
        ),
      );
    return interaction.showModal(modal);
  }

  if (id === 'arm_select_rendu') {
    const armeId = parseInt(interaction.values[0], 10);
    const arme = await db.getArme(armeId);
    if (!arme) return updateAutoDelete(interaction, { content: '❌ Arme introuvable.', components: [] });
    await db.updateArmeStatut(armeId, 'en_stock', null);
    await updateAutoDelete(interaction, { content: `✅ **${arme.nom}** (\`${arme.reference}\`) rendue par **${arme.preteeA || '?'}** — remise en stock.`, components: [] });
    await updatePermanentMessage(interaction.client);
  }
}

// ─── HANDLER MODALS ───────────────────────────────────────────────────────────

interface RechercheConfig {
  armes: Arme[];
  selectId: string;
  placeholder: string;
  content: string;
  noneMsg: string;
  description: ((a: Arme) => string) | null;
}

export async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const id = interaction.customId;

  if (id.startsWith('modal_arm_recherche_')) {
    const action = id.replace('modal_arm_recherche_', '');
    const query = interaction.fields.getTextInputValue('recherche').trim().toLowerCase();

    const configs: Record<string, RechercheConfig> = {
      retirer: {
        armes: await db.getAllArmes(),
        selectId: 'arm_select_retirer',
        placeholder: 'Choisir une arme à retirer…',
        content: '🗑️ Quelle arme supprimer ?',
        noneMsg: '❌ Aucune arme en stock.',
        description: (a) => statutLabel(a),
      },
      preter: {
        armes: (await db.getAllArmes()).filter(a => a.statut === 'en_stock'),
        selectId: 'arm_select_preter',
        placeholder: 'Choisir une arme à prêter…',
        content: '🤝 Quelle arme prêter ?',
        noneMsg: '❌ Aucune arme disponible à prêter.',
        description: null,
      },
      rendu: {
        armes: (await db.getAllArmes()).filter(a => a.statut === 'pretee'),
        selectId: 'arm_select_rendu',
        placeholder: 'Quelle arme a été rendue ?',
        content: "✅ Sélectionne l'arme rendue :",
        noneMsg: '❌ Aucune arme actuellement prêtée.',
        description: (a) => `Prêtée à ${a.preteeA || '?'}`,
      },
    };
    const cfg = configs[action];
    if (!cfg) return;

    if (!cfg.armes.length) return replyAutoDelete(interaction, cfg.noneMsg);

    const filtered = query
      ? cfg.armes.filter(a => a.nom.toLowerCase().includes(query) || a.reference.toLowerCase().includes(query))
      : cfg.armes;

    if (!filtered.length) return replyAutoDelete(interaction, `❌ Aucune arme ne correspond à « ${query} ».`);

    const options = filtered.slice(0, 25).map(a => ({
      label: `${a.nom} (${a.reference})`,
      ...(cfg.description ? { description: cfg.description(a) } : {}),
      value: String(a.id),
    }));

    const select = new StringSelectMenuBuilder().setCustomId(cfg.selectId).setPlaceholder(cfg.placeholder).addOptions(options);

    const content = filtered.length > 25
      ? `⚠️ ${filtered.length} résultats, seuls les 25 premiers sont affichés — affine ta recherche.\n${cfg.content}`
      : cfg.content;

    return replyAutoDelete(interaction, {
      content,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    }, { deleteAfterMs: 60_000 });
  }

  if (id.startsWith('modal_arm_ajouter_')) {
    const typeKey = id.replace('modal_arm_ajouter_', '');
    const type = ARME_TYPES.find(t => t.key === typeKey);
    const nom = interaction.fields.getTextInputValue('nom').trim();
    const reference = interaction.fields.getTextInputValue('reference').trim().toUpperCase();

    if (!type) return replyAutoDelete(interaction, '❌ Type invalide.');

    try {
      await db.addArme(nom, reference, type.key);
    } catch {
      return replyAutoDelete(interaction, '❌ Cette référence existe déjà.');
    }

    await replyAutoDelete(interaction, `✅ **${nom}** (\`${reference}\`) — ${type.label} — ajoutée à l'armurerie.`);
    await updatePermanentMessage(interaction.client);
    return;
  }

  if (id.startsWith('modal_arm_preter_')) {
    const armeId = parseInt(id.replace('modal_arm_preter_', ''), 10);
    const arme = await db.getArme(armeId);
    const preteaA = interaction.fields.getTextInputValue('pretee_a').trim();

    if (!arme) return replyAutoDelete(interaction, '❌ Arme introuvable.');

    await db.updateArmeStatut(armeId, 'pretee', preteaA);
    await replyAutoDelete(interaction, `✅ **${arme.nom}** marquée comme prêtée à **${preteaA}**.`);
    await updatePermanentMessage(interaction.client);
    return;
  }

  if (id === 'modal_arm_fabrication') {
    const quantite = parseInt(interaction.fields.getTextInputValue('quantite').trim(), 10);
    if (!Number.isInteger(quantite) || quantite <= 0) return replyAutoDelete(interaction, '❌ Quantité invalide.');

    await db.addTransaction({
      user_id: interaction.user.id,
      username: interaction.member && 'displayName' in interaction.member ? interaction.member.displayName : interaction.user.username,
      action: 'fabrication_munitions',
      quantite,
    });

    await replyAutoDelete(interaction, `🛠️ **${quantite}** munitions déclarées fabriquées.`);
    await updatePermanentMessage(interaction.client);
    return;
  }

  if (id === 'modal_arm_vente_munitions') {
    const quantite = parseInt(interaction.fields.getTextInputValue('quantite').trim(), 10);
    const acheteurId = interaction.fields.getTextInputValue('acheteur_id').trim();
    const prix = parseFloat(interaction.fields.getTextInputValue('prix').trim().replace(',', '.'));

    if (!Number.isInteger(quantite) || quantite <= 0) return replyAutoDelete(interaction, '❌ Quantité invalide.');
    if (!acheteurId) return replyAutoDelete(interaction, '❌ ID acheteur manquant.');
    if (!Number.isFinite(prix) || prix < 0) return replyAutoDelete(interaction, '❌ Prix invalide.');

    await db.addMunitionVente({
      vendeur_id: interaction.user.id,
      vendeur_username: interaction.member && 'displayName' in interaction.member ? interaction.member.displayName : interaction.user.username,
      acheteur_id: acheteurId,
      quantite,
      prix,
    });

    await replyAutoDelete(interaction, `💰 **${quantite}** munitions vendues à \`${acheteurId}\` pour **${prix}$**.`);
    await updatePermanentMessage(interaction.client);
  }
}
