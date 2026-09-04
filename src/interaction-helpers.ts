/**
 * @file src/interaction-helpers.ts
 * @description Helpers de réponse partagés par les modules à boutons/selects
 * éphémères (armurerie, taxes, quotas) — évite de dupliquer la même logique
 * dans chaque module avec le risque de dérive que ça implique (avant
 * extraction, la version de quotas.ts ajoutait la réaction 🗑️ mais pas les
 * deux autres, sans que ce soit une différence voulue).
 */
import type { RepliableInteraction, InteractionReplyOptions, MessageComponentInteraction } from 'discord.js';

/**
 * Répond à une interaction et ajoute 🗑️ sur la réponse si elle n'a pas de
 * composants interactifs (permet à l'utilisateur de la supprimer lui-même
 * sans la permission "Gérer les messages" — pas de 🗑️ tant qu'un composant
 * est actif, pour ne pas orpheliner une interaction en cours). Supprime aussi
 * automatiquement la réponse après `deleteAfterMs`, si fourni.
 */
export async function replyAutoDelete(
  interaction: RepliableInteraction,
  payload: string | InteractionReplyOptions,
  options: { deleteAfterMs?: number } = {},
): Promise<void> {
  const p: InteractionReplyOptions = typeof payload === 'string' ? { content: payload } : payload;
  const { resource } = await interaction.reply({ ...p, withResponse: true });
  const message = resource?.message;

  if (!p.components?.length) message?.react('🗑️').catch(() => null);

  if (options.deleteAfterMs && options.deleteAfterMs > 0 && message) {
    setTimeout(() => { message.delete().catch(() => null); }, options.deleteAfterMs);
  }
}

/** Met à jour le message d'une interaction bouton/select (remplace son contenu en place). */
export async function updateAutoDelete(interaction: MessageComponentInteraction, payload: string | Record<string, unknown>): Promise<void> {
  const p = typeof payload === 'string' ? { content: payload } : payload;
  await interaction.update(p as Parameters<MessageComponentInteraction['update']>[0]);
}
