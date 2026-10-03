/**
 * @file src/discord-fetch.ts
 * @description Lecture de l'historique d'un salon Discord, partagée par le
 * rattrapage et la resynchronisation des coffres et des garages, et
 * reconnaissance des erreurs d'accès Discord.
 *
 * Une erreur de lecture est retentée puis PROPAGÉE : s'arrêter en silence
 * ferait passer une lecture partielle pour une lecture complète, et le
 * curseur avancerait ensuite par-dessus les messages jamais lus. Les pages
 * sont lues hors cache discord.js, une à la fois, pour qu'un salon ancien ne
 * se retrouve jamais entièrement en mémoire.
 */
import { DiscordAPIError, RESTJSONErrorCodes, type Message, type TextBasedChannel } from 'discord.js';

export type HistoryChannel = Extract<TextBasedChannel, { messages: unknown }>;

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

/** Une page de messages, retentée puis propagée en cas d'échec. */
export async function fetchPage(channel: HistoryChannel, options: { limit: number; after?: string; before?: string }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await channel.messages.fetch({ ...options, cache: false });
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * Vrai si l'erreur vient d'un accès ou d'une permission manquante sur le
 * salon : réessayer chaque minute ne changera rien, et chaque refus compte
 * dans la limite Discord de requêtes invalides, commune à toutes les guildes
 * du bot. Une boucle d'envoi doit alors s'arrêter pour ce passage.
 */
export function isMissingAccess(err: unknown): boolean {
  return err instanceof DiscordAPIError
    && (err.code === RESTJSONErrorCodes.MissingAccess || err.code === RESTJSONErrorCodes.MissingPermissions);
}

/** Trie des messages du plus ancien au plus récent, par ID (un snowflake est croissant dans le temps). */
export function sortById(messages: Iterable<Message>): Message[] {
  return [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** Pages de messages postérieurs à `afterId`, de la plus ancienne à la plus récente, chacune triée. */
export async function* fetchPagesAfter(channel: HistoryChannel, afterId: string): AsyncGenerator<Message[]> {
  let cursor = afterId;
  while (true) {
    const batch = await fetchPage(channel, { limit: 100, after: cursor });
    if (!batch.size) return;
    const sorted = sortById(batch.values());
    yield sorted;
    if (batch.size < 100) return;
    cursor = sorted[sorted.length - 1].id;
  }
}
