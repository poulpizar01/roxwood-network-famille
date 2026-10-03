/**
 * @file src/permanent-message.ts
 * @description Création/édition des messages permanents (Stock Général,
 * panneau d'activités, armurerie, taxes), partagée par tous les modules qui
 * en ont un.
 *
 * Un message permanent est retrouvé par son ID stocké en base, puis, à
 * défaut, par le titre de son embed parmi les derniers messages du salon :
 * un arrêt du process entre l'envoi et l'écriture de l'ID ne laisse donc pas
 * un panneau orphelin doublé d'un second. Seule l'erreur Discord "message
 * inconnu" vaut suppression — une erreur passagère (5xx, timeout) remonte à
 * l'appelant au lieu de faire recréer un panneau qui existe toujours. Les
 * rafraîchissements d'un même panneau sont exécutés l'un après l'autre.
 */
import { DiscordAPIError, RESTJSONErrorCodes, type Message, type SendableChannels, type BaseMessageOptions } from 'discord.js';
import * as db from './db';

const RECENT_MESSAGES_SCANNED = 50;

const chains = new Map<string, Promise<void>>();

/** Récupère un message par ID — `null` s'il a été supprimé, erreur propagée dans tous les autres cas. */
export async function fetchMessageOrNull(channel: SendableChannels, messageId: string): Promise<Message | null> {
  try {
    return await channel.messages.fetch(messageId);
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage) return null;
    throw err;
  }
}

/**
 * Édite le message permanent identifié par `settingKey` (ID stocké) ou par
 * `title` (titre de son premier embed), ou le crée s'il n'existe plus.
 * `build` est appelé au moment de l'écriture, pas à la mise en file : le
 * contenu publié reflète l'état le plus récent.
 */
export function upsertPanel(
  channel: SendableChannels, guildId: string, settingKey: string, title: string, build: () => Promise<BaseMessageOptions>,
): Promise<void> {
  const chainKey = `${guildId}:${settingKey}`;
  const previous = chains.get(chainKey) ?? Promise.resolve();
  const run = previous.then(async () => {
    const payload = await build();
    const storedId = await db.getSetting(guildId, settingKey);
    let message = storedId ? await fetchMessageOrNull(channel, storedId) : null;

    if (!message) {
      const recent = await channel.messages.fetch({ limit: RECENT_MESSAGES_SCANNED });
      message = recent.find(m => m.author.id === channel.client.user.id && m.embeds[0]?.title === title) ?? null;
      if (message) await db.setSetting(guildId, settingKey, message.id);
    }

    if (message) {
      await message.edit(payload);
      return;
    }
    const created = await channel.send(payload);
    await db.setSetting(guildId, settingKey, created.id);
  });
  const tail = run.then(() => undefined, () => undefined);
  chains.set(chainKey, tail);
  void tail.then(() => { if (chains.get(chainKey) === tail) chains.delete(chainKey); });
  return run;
}
