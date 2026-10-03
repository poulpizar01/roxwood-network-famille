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
 *  - "sorti de la fourrière" → si un responsable était déjà enregistré, un
 *    événement de fourrière est enregistré à son nom ; le montant fixe
 *    {@link MONTANT_FOURRIERE} est purement indicatif (aucune facturation
 *    automatique, ni ici ni dans le classement) ; puis le responsable devient
 *    celui qui vient de la récupérer.
 *
 * Le classement de la semaine se consulte à la demande via la commande
 * `/fourrieres` (admin), et est posté en archive dans `bilan` au reset
 * hebdomadaire (voir `resetFourrieresHebdo`).
 *
 * Comme pour les coffres, tout traitement de message tourne dans la file de
 * la guilde (`guild-queue.ts`, voir `index.ts`).
 */
import { EmbedBuilder, SlashCommandBuilder, MessageFlags, type Client, type Message, type ChatInputCommandInteraction } from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';
import { isAdmin } from '../permissions';
import { buildChunkedEmbeds } from '../embed-chunks';
import { isGameLogMessage } from './stocks';
import { fetchPage, fetchPagesAfter, sortById, type HistoryChannel } from '../discord-fetch';
import { sendOnce } from '../permanent-message';

/** Amende indicative par mise en fourrière — valeur fixe, ne bouge jamais. Exportée pour `/api/garages/impounds`, qui réutilise cette même valeur plutôt que de la dupliquer. */
export const MONTANT_FOURRIERE = 350;

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
async function traiterLigne(guildId: string, ligne: string, chargerAmendes: boolean): Promise<Facturation | null> {
  let m: RegExpMatchArray | null;

  if ((m = ligne.match(RE_SORTIE_FOURRIERE))) {
    const [, joueurBrut, modele, plaque] = m;
    const joueur = joueurBrut.trim();
    const precedent = await db.getVehiculeEtat(guildId, plaque);

    let facturation: Facturation | null = null;
    if (chargerAmendes && precedent && (precedent.discordId || precedent.joueur)) {
      const discordIds = await db.getUserMappings(guildId, precedent.joueur || '');
      const discordId = precedent.discordId || (discordIds.length === 1 ? discordIds[0] : null);
      await db.addFourriere(guildId, {
        discord_id: discordId,
        joueur: precedent.joueur!,
        plaque,
        modele: precedent.modele || modele,
        timestamp: Date.now(),
      });
      facturation = { discordId, joueur: precedent.joueur!, plaque, modele: precedent.modele || modele };
    }

    const discordIdsActuel = await db.getUserMappings(guildId, joueur);
    await db.setVehiculeEtat(guildId, {
      plaque, modele,
      discord_id: discordIdsActuel.length === 1 ? discordIdsActuel[0] : null,
      joueur,
    });

    return facturation;
  }

  if ((m = ligne.match(RE_SORTIE_GARAGE))) {
    const [, joueurBrut, modele, plaque] = m;
    const joueur = joueurBrut.trim();
    const discordIds = await db.getUserMappings(guildId, joueur);
    await db.setVehiculeEtat(guildId, {
      plaque, modele,
      discord_id: discordIds.length === 1 ? discordIds[0] : null,
      joueur,
    });
    return null;
  }

  if ((m = ligne.match(RE_RANGEMENT))) {
    const [, , , plaque] = m;
    await db.clearVehiculeEtat(guildId, plaque);
    return null;
  }

  return null;
}

/**
 * Point d'entrée temps réel : traite un nouveau message posté dans le salon
 * `logs_garages`. Un message dont l'ID n'est pas postérieur au curseur a
 * déjà été appliqué par `catchUpMissedMessages` — le rejouer ici fausserait
 * l'état : une ligne "sorti de la fourrière" déjà appliquée a fait du joueur
 * qui l'a récupéré le responsable courant, et serait facturée à lui-même.
 * Sans curseur (salon configuré à chaud, jamais rattrapé), rien n'est créé
 * ici : c'est son absence qui déclenche la reconstruction complète de l'état
 * depuis l'historique au prochain rattrapage.
 */
export async function handleMessage(message: Message): Promise<void> {
  const guildId = message.guildId;
  if (!guildId || message.channelId !== configStore.get(guildId).CHANNELS.logs_garages) return;

  // Rattrapage précédent interrompu : appliquer ce message directement ferait
  // avancer le curseur au-delà des messages jamais récupérés. Le rattrapage,
  // relancé ici, le récupère avec eux.
  if (catchUpPending.has(guildId)) {
    await catchUpMissedMessages(message.client, guildId);
    return;
  }

  const cursor = await db.getSetting(guildId, 'last_garages_msg');
  if (cursor && BigInt(message.id) <= BigInt(cursor)) return;

  try {
    for (const ligne of extractLignes(message)) {
      const facturation = await traiterLigne(guildId, ligne, true);
      if (facturation) await notifierFourriere(message.client, guildId, facturation);
    }
    // Curseur avancé APRÈS application : un arrêt au milieu laisse le message
    // à rejouer par le rattrapage (sans amende rétroactive) plutôt que perdu.
    if (cursor) await db.setSetting(guildId, 'last_garages_msg', message.id);
  } catch (err) {
    // Sans ça, le message suivant ferait avancer le curseur par-dessus celui-ci, jamais rejoué.
    catchUpPending.add(guildId);
    throw err;
  }
}

/** Guildes dont les garages sont à rattraper : rattrapage ou écriture en échec, coupure de connexion à Discord (voir `handleMessage`). */
const catchUpPending = new Set<string>();

/** Marque les garages d'une guilde à rattraper — à appeler dès qu'une coupure de connexion à Discord est détectée (même principe que `stocks.markForCatchUp`). */
export function markForCatchUp(guildId: string): void {
  if (configStore.get(guildId).CHANNELS.logs_garages) catchUpPending.add(guildId);
}

/**
 * Rattrapage au démarrage : reconstruit l'état "qui a sorti quoi en dernier"
 * depuis l'historique du salon, SANS facturer de fourrière rétroactive.
 * @returns Nombre de lignes traitées.
 */
export async function catchUpMissedMessages(client: Client, guildId: string): Promise<number> {
  const channelId = configStore.get(guildId).CHANNELS.logs_garages;
  if (!channelId) { catchUpPending.delete(guildId); return 0; }

  // Marqué avant de lire le salon : un échec de lecture, quel qu'il soit, laisse les garages à rattraper.
  catchUpPending.add(guildId);
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) return 0;
    const total = await rejouerHistorique(channel, guildId);
    catchUpPending.delete(guildId);
    return total;
  } catch (err) {
    console.error(`[garages] Rattrapage interrompu (${guildId}) — repris au prochain message :`, (err as Error).message);
    return 0;
  }
}

/** Corps de `catchUpMissedMessages` : propage toute erreur de lecture (voir `fetchPage`). */
async function rejouerHistorique(channel: HistoryChannel, guildId: string): Promise<number> {
  const lastId = await db.getSetting(guildId, 'last_garages_msg');
  let total = 0;

  if (!lastId) {
    const HISTORIQUE_MAX = 500;
    const collected: Message[] = [];
    let before: string | undefined;
    while (collected.length < HISTORIQUE_MAX) {
      const batch = await fetchPage(channel, { limit: 100, ...(before ? { before } : {}) });
      if (!batch.size) break;
      collected.push(...batch.values());
      before = sortById(batch.values())[0].id;
      if (batch.size < 100) break;
    }

    const sortedInit = sortById(collected);
    for (const msg of sortedInit) {
      // Un message humain ne doit jamais être rejoué comme un événement de
      // garage, même en historique — même règle qu'en temps réel (voir
      // `handleMessage`) : un membre pouvant écrire/ajouter un webhook dans
      // `logs_garages` pourrait sinon forger un état véhicule.
      if (!isGameLogMessage(msg)) continue;
      for (const ligne of extractLignes(msg)) {
        await traiterLigne(guildId, ligne, false);
        total++;
      }
    }
    if (sortedInit.length) await db.setSetting(guildId, 'last_garages_msg', sortedInit[sortedInit.length - 1].id);
    console.log(`[garages] Premier démarrage (${guildId}) : ${total} ligne(s) sur ${sortedInit.length} message(s) d'historique traitée(s) pour reconstruire l'état (aucune amende rétroactive).`);
    return total;
  }

  for await (const page of fetchPagesAfter(channel, lastId)) {
    for (const msg of page) {
      if (isGameLogMessage(msg)) {
        for (const ligne of extractLignes(msg)) {
          await traiterLigne(guildId, ligne, false);
          total++;
        }
      }
      await db.setSetting(guildId, 'last_garages_msg', msg.id);
    }
  }

  if (total > 0) console.log(`[garages] Rattrapage (${guildId}) : ${total} ligne(s) traitée(s) (état reconstruit, aucune amende rétroactive).`);
  return total;
}

const FOURRIERE_NOTIF_TITLE = '🚗 Mise en fourrière';

/** Identifie une notification de mise en fourrière par le titre de son embed (voir convention "Robustesse" du projet) — sert à l'exclure de la réaction 🗑️ automatique (voir `index.ts`) sans exclure tout le salon `admin`, partagé avec d'autres alertes qui restent, elles, supprimables par réaction. */
export function isFourriereNotification(message: Message): boolean {
  return message.embeds?.[0]?.title === FOURRIERE_NOTIF_TITLE;
}

/** Envoie une notification immédiate dans `admin` quand une fourrière est facturée. */
async function notifierFourriere(client: Client, guildId: string, facturation: Facturation): Promise<void> {
  const c = configStore.get(guildId);
  if (!c.CHANNELS.admin) return;
  const channel = await client.channels.fetch(c.CHANNELS.admin).catch(() => null);
  if (!channel || !channel.isSendable()) return;

  const montant = MONTANT_FOURRIERE;
  const qui = facturation.discordId ? `<@${facturation.discordId}>` : `**${facturation.joueur}**`;
  const embed = new EmbedBuilder()
    .setTitle(FOURRIERE_NOTIF_TITLE)
    .setColor(0xED4245)
    .setDescription(`${qui} a laissé un véhicule finir en fourrière.`)
    .addFields(
      { name: 'Véhicule', value: facturation.modele || '?', inline: true },
      { name: 'Plaque', value: facturation.plaque, inline: true },
      { name: 'Coût indicatif', value: `${montant.toLocaleString('fr-FR')} $`, inline: true },
    )
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => null);
}

// ─── CLASSEMENT ────────────────────────────────────────────────────────────────

const CLASSEMENT_TITLE = '🚗 Classement des fourrières';

/**
 * Construit le(s) embed(s) du classement : nombre de fourrières par
 * personne, du plus élevé au moins élevé. Purement informatif — personne
 * n'est facturé, le montant configuré n'est affiché qu'à titre indicatif
 * (footer). `title` distinct entre l'usage à la demande (`/fourrieres`) et
 * l'archive hebdomadaire postée dans `bilan` (voir `resetFourrieresHebdo`).
 * Un joueur = une ligne, jamais purgé : sur un serveur actif de longue date,
 * ça peut dépasser le seuil de rendu Discord (voir src/embed-chunks.ts),
 * d'où le découpage en plusieurs embeds plutôt qu'un seul `setDescription`.
 */
async function buildClassementEmbeds(guildId: string, title: string, untilTs?: number): Promise<EmbedBuilder[]> {
  const montant = MONTANT_FOURRIERE;
  const classement = await db.getFourriereClassement(guildId, untilTs);

  const lignes = classement.map((c, i) => {
    const qui = c.discord_id ? `<@${c.discord_id}>` : `**${c.joueur}**`;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} ${qui} — **${c.total}** fourrière${c.total > 1 ? 's' : ''}`;
  });

  return buildChunkedEmbeds([{ lines: lignes }], {
    title,
    color: 0xED4245,
    emptyDescription: '*Aucune fourrière enregistrée pour le moment.*',
    footer: (i, total) => i === total - 1 ? `Coût indicatif : ${montant.toLocaleString('fr-FR')}$ par fourrière — aucune facturation automatique` : null,
  });
}

/** Déclare la commande `/fourrieres`. */
export function getCommands() {
  return [
    { data: new SlashCommandBuilder().setName('fourrieres').setDescription('Classement des fourrières (admin)') },
  ];
}

/** Gère la commande `/fourrieres` (admin) : affiche le classement à la demande. */
export async function handleClassementCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  if (!isAdmin(guildId, interaction.member)) {
    await interaction.reply({ content: '❌ Commande réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ embeds: await buildClassementEmbeds(guildId, CLASSEMENT_TITLE), flags: MessageFlags.Ephemeral });
}

/**
 * Reset hebdomadaire du classement des fourrières, appelé par la publication
 * de fin de semaine (`quotas.checkWeeklyReset`, même moment que le
 * bilan/paie). Poste une archive des fourrières antérieures à `untilTs` (la
 * fin de la semaine close) dans `bilan`, puis les retire — celles de la
 * semaine en cours restent, même si la publication est en retard. L'état
 * courant des véhicules n'est pas affecté. Une erreur d'envoi remonte, sans
 * rien retirer : l'étape est retentée au passage suivant, sans reposter
 * l'archive (voir `permanent-message.sendOnce`).
 */
export async function resetFourrieresHebdo(client: Client, guildId: string, entete: string, untilTs: number): Promise<void> {
  const c = configStore.get(guildId);
  if (c.CHANNELS.bilan) {
    const channel = await client.channels.fetch(c.CHANNELS.bilan).catch(() => null);
    if (channel && channel.isSendable()) {
      const title = `📊 Bilan fourrières — ${entete}`;
      const embeds = await buildClassementEmbeds(guildId, title, untilTs);
      // Un message par embed : Discord plafonne aussi le total des embeds d'un même message.
      await sendOnce(channel, embeds.map(embed => ({ embeds: [embed] })), title);
    }
  }

  await db.clearFourrieres(guildId, untilTs);
  console.log(`[garages] Classement des fourrières remis à zéro (${guildId}) — ${entete}.`);
}
