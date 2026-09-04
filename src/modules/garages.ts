/**
 * @file src/modules/garages.ts
 * @description Suivi des mises en fourrière des véhicules (contexte RP FiveM).
 *
 * Le bot de jeu poste dans le salon `logs_garages` un embed à chaque
 * sortie/rangement de véhicule. Aucune "mise en fourrière" n'est jamais
 * loggée explicitement — elle se déduit : si un véhicule ressort un jour de
 * la fourrière, c'est qu'il y est entré entre-temps, et le responsable est le
 * dernier joueur à l'avoir sorti sans jamais l'avoir rangé proprement.
 *
 * Logique d'état, par plaque :
 *  - "sorti du garage" / "sorti de son garage public" → responsable = ce joueur.
 *  - "rangé dans le garage" → responsable effacé.
 *  - "sorti de la fourrière" → si un responsable était déjà enregistré, il est
 *    facturé d'une fourrière (montant configurable via `/config fourriere`) ;
 *    puis le responsable devient celui qui vient de la récupérer.
 *
 * Un classement cumulé (jamais remis à zéro tant que non explicitement reset)
 * est maintenu en direct dans le salon `admin`, mettant en avant le top 3.
 */
import { EmbedBuilder, type Client, type Message } from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';

const RE_SORTIE_FOURRIERE = /^\*\*(.+?)\*\* a sorti un\(e\) (.+?) de la fourrière ?: \*\*(.+?)\*\*$/im;
const RE_SORTIE_GARAGE = /^\*\*(.+?)\*\* a sorti un\(e\) (.+?) (?:du garage \d+|de son garage public) ?: \*\*(.+?)\*\*$/im;
const RE_RANGEMENT = /^\*\*(.+?)\*\* a rangé un\(e\) (.+?) dans le garage \d+ ?: \*\*(.+?)\*\*$/im;

interface Facturation {
  discordId: string | null;
  joueur: string;
  plaque: string;
  modele: string;
}

/** Extrait le texte analysable d'un message (un event par embed). */
function extractLignes(message: Message): string[] {
  return message.embeds.map(e => e.description || '').filter(Boolean);
}

/**
 * Traite une ligne de log et met à jour l'état + facture une fourrière si
 * applicable. `chargerAmendes` est false pendant le rattrapage au démarrage
 * (on reconstruit l'état sans facturer de fourrière rétroactive).
 */
async function traiterLigne(ligne: string, chargerAmendes: boolean): Promise<Facturation | null> {
  let m: RegExpMatchArray | null;

  if ((m = ligne.match(RE_SORTIE_FOURRIERE))) {
    const [, joueurBrut, modele, plaque] = m;
    const joueur = joueurBrut.trim();
    const precedent = await db.getVehiculeEtat(plaque);

    let facturation: Facturation | null = null;
    if (chargerAmendes && precedent && (precedent.discordId || precedent.joueur)) {
      const discordIds = await db.getUserMappings(precedent.joueur || '');
      const discordId = precedent.discordId || (discordIds.length === 1 ? discordIds[0] : null);
      await db.addFourriere({
        discord_id: discordId,
        joueur: precedent.joueur!,
        plaque,
        modele: precedent.modele || modele,
        timestamp: Date.now(),
      });
      facturation = { discordId, joueur: precedent.joueur!, plaque, modele: precedent.modele || modele };
    }

    const discordIdsActuel = await db.getUserMappings(joueur);
    await db.setVehiculeEtat({
      plaque, modele,
      discord_id: discordIdsActuel.length === 1 ? discordIdsActuel[0] : null,
      joueur,
    });

    return facturation;
  }

  if ((m = ligne.match(RE_SORTIE_GARAGE))) {
    const [, joueurBrut, modele, plaque] = m;
    const joueur = joueurBrut.trim();
    const discordIds = await db.getUserMappings(joueur);
    await db.setVehiculeEtat({
      plaque, modele,
      discord_id: discordIds.length === 1 ? discordIds[0] : null,
      joueur,
    });
    return null;
  }

  if ((m = ligne.match(RE_RANGEMENT))) {
    const [, , , plaque] = m;
    await db.clearVehiculeEtat(plaque);
    return null;
  }

  return null;
}

/** Point d'entrée temps réel : traite un nouveau message posté dans le salon `logs_garages`. */
export async function handleMessage(message: Message): Promise<void> {
  if (message.channelId !== configStore.get().CHANNELS.logs_garages) return;

  const lignes = extractLignes(message);
  if (!lignes.length) return;

  for (const ligne of lignes) {
    const facturation = await traiterLigne(ligne, true);
    if (facturation) {
      await notifierFourriere(message.client, facturation);
      await updateClassementMessage(message.client);
    }
  }
}

/**
 * Rattrapage au démarrage : reconstruit l'état "qui a sorti quoi en dernier"
 * depuis l'historique du salon, SANS facturer de fourrière rétroactive.
 * @returns Nombre de lignes traitées.
 */
export async function catchUpMissedMessages(client: Client): Promise<number> {
  const channelId = configStore.get().CHANNELS.logs_garages;
  if (!channelId) return 0;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return 0;

  const lastId = await db.getSetting('last_garages_msg');
  let total = 0;

  if (!lastId) {
    const HISTORIQUE_MAX = 500;
    const collected: Message[] = [];
    let before: string | undefined;
    while (collected.length < HISTORIQUE_MAX) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
      if (!batch || !batch.size) break;
      collected.push(...batch.values());
      before = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0].id;
      if (batch.size < 100) break;
    }

    const sortedInit = collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const msg of sortedInit) {
      for (const ligne of extractLignes(msg)) {
        await traiterLigne(ligne, false);
        total++;
      }
    }
    if (sortedInit.length) await db.setSetting('last_garages_msg', sortedInit[sortedInit.length - 1].id);
    console.log(`[garages] Premier démarrage : ${total} ligne(s) sur ${sortedInit.length} message(s) d'historique traitée(s) pour reconstruire l'état (aucune amende rétroactive).`);
    return total;
  }

  let cursor = lastId;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, after: cursor }).catch(() => null);
    if (!batch || !batch.size) break;

    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const msg of sorted) {
      for (const ligne of extractLignes(msg)) {
        await traiterLigne(ligne, false);
        total++;
      }
      await db.setSetting('last_garages_msg', msg.id);
    }
    cursor = sorted[sorted.length - 1].id;
    if (batch.size < 100) break;
  }

  if (total > 0) console.log(`[garages] Rattrapage : ${total} ligne(s) traitée(s) (état reconstruit, aucune amende rétroactive).`);
  return total;
}

/** Envoie une notification immédiate dans `admin` quand une fourrière est facturée. */
async function notifierFourriere(client: Client, facturation: Facturation): Promise<void> {
  const c = configStore.get();
  if (!c.CHANNELS.admin) return;
  const channel = await client.channels.fetch(c.CHANNELS.admin).catch(() => null);
  if (!channel || !channel.isSendable()) return;

  const montant = c.MONTANT_FOURRIERE;
  const qui = facturation.discordId ? `<@${facturation.discordId}>` : `**${facturation.joueur}**`;
  const embed = new EmbedBuilder()
    .setTitle('🚗 Mise en fourrière')
    .setColor(0xED4245)
    .setDescription(`${qui} a laissé un véhicule finir en fourrière — ${montant.toLocaleString('fr-FR')} $ à sa charge.`)
    .addFields(
      { name: 'Véhicule', value: facturation.modele || '?', inline: true },
      { name: 'Plaque', value: facturation.plaque, inline: true },
    )
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => null);
}

// ─── CLASSEMENT PERSISTANT ────────────────────────────────────────────────────

const CLASSEMENT_TITLE = '🚗 Classement des fourrières';

/** Indique si un message Discord est le classement des fourrières (via le titre de son embed). */
export function isClassementMessage(message: Message): boolean {
  return message.embeds?.[0]?.title === CLASSEMENT_TITLE;
}

/** Construit l'embed du classement : top 3 avec le montant à payer (nb × montant configuré). */
async function buildClassementEmbed(): Promise<EmbedBuilder> {
  const montant = configStore.get().MONTANT_FOURRIERE;
  const classement = await db.getFourriereClassement();

  const lignes = classement.map((c, i) => {
    const qui = c.discord_id ? `<@${c.discord_id}>` : `**${c.joueur}**`;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const base = `${medal} ${qui} — **${c.total}** fourrière${c.total > 1 ? 's' : ''}`;
    return i < 3 ? `${base} → amende : **${(c.total * montant).toLocaleString('fr-FR')} $**` : base;
  });

  return new EmbedBuilder()
    .setTitle(CLASSEMENT_TITLE)
    .setColor(0xED4245)
    .setDescription(lignes.length ? lignes.join('\n') : '*Aucune fourrière enregistrée pour le moment.*')
    .setFooter({ text: `${montant}$ par fourrière — seul le top 3 est facturé` })
    .setTimestamp();
}

/** S'assure que le classement existe sur Discord et le retourne, en le recréant s'il a disparu. */
async function ensureClassementMessage(client: Client): Promise<Message | null> {
  const c = configStore.get();
  if (!c.CHANNELS.admin) return null;
  const channel = await client.channels.fetch(c.CHANNELS.admin).catch(() => null);
  if (!channel || !channel.isSendable()) return null;

  const messageId = await db.getSetting('fourriere_classement_message_id');
  if (messageId) {
    const existing = await channel.messages.fetch(messageId).catch(() => null);
    if (existing) return existing;
  }

  const top3 = (await db.getFourriereClassement()).slice(0, 3).filter(x => x.discord_id);
  const content = top3.length ? top3.map(x => `<@${x.discord_id}>`).join(' ') : '';
  const msg = await channel.send({ content, embeds: [await buildClassementEmbed()] });
  await db.setSetting('fourriere_classement_message_id', msg.id);
  return msg;
}

/** Met à jour le classement des fourrières dans `admin` (le crée s'il n'existe pas encore ou a disparu). */
export async function updateClassementMessage(client: Client): Promise<void> {
  try {
    const msg = await ensureClassementMessage(client);
    if (!msg) return;
    const top3 = (await db.getFourriereClassement()).slice(0, 3).filter(x => x.discord_id);
    const content = top3.length ? top3.map(x => `<@${x.discord_id}>`).join(' ') : '';
    await msg.edit({ content, embeds: [await buildClassementEmbed()] });
  } catch (err) {
    console.error('[garages] updateClassementMessage:', (err as Error).message);
  }
}

/**
 * Reset hebdomadaire du classement des fourrières, à appeler depuis
 * `quotas.weeklyReset` (même moment que le bilan/paie). Poste une archive de
 * la semaine écoulée dans `bilan`, puis vide le compteur. L'état courant des
 * véhicules n'est pas affecté, seul le compteur de fourrières l'est.
 */
export async function resetFourrieresHebdo(client: Client, entete: string): Promise<void> {
  try {
    const c = configStore.get();
    if (c.CHANNELS.bilan) {
      const channel = await client.channels.fetch(c.CHANNELS.bilan).catch(() => null);
      if (channel && channel.isSendable()) {
        const embed = (await buildClassementEmbed()).setTitle(`📊 Bilan fourrières — ${entete}`);
        await channel.send({ embeds: [embed] }).catch(() => null);
      }
    }

    await db.clearFourrieres();
    await updateClassementMessage(client);
    console.log(`[garages] Classement des fourrières remis à zéro — ${entete}.`);
  } catch (err) {
    console.error('[garages] resetFourrieresHebdo:', (err as Error).message);
  }
}
