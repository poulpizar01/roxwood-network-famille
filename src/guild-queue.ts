/**
 * @file src/guild-queue.ts
 * @description File d'attente par guilde pour tout ce qui lit puis écrit
 * l'état dérivé des salons de logs (coffres, garages).
 *
 * discord.js n'attend pas la fin d'un handler `messageCreate` avant de lancer
 * le suivant : deux messages d'une même guilde seraient sinon traités en
 * parallèle sur des séquences lire-puis-écrire (curseur de salon, vente en
 * attente à cumuler ou à confirmer), avec à la clé des mouvements perdus ou
 * appliqués deux fois. Tout traitement de log d'une guilde passe donc par
 * `runExclusive` — temps réel, rattrapage et `/sync-stock` compris, ce qui
 * suspend aussi le temps réel pendant une resynchronisation. Les guildes
 * restent indépendantes entre elles.
 */

const tails = new Map<string, Promise<void>>();

/** Exécute `fn` après tout ce qui est déjà en file pour cette guilde. Ne jamais appeler depuis un `fn` déjà en file pour la même guilde (attente infinie). */
export function runExclusive<T>(guildId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(guildId) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(() => undefined, () => undefined);
  tails.set(guildId, tail);
  void tail.then(() => { if (tails.get(guildId) === tail) tails.delete(guildId); });
  return run;
}

/** Résolue quand toutes les files sont vides — pour un arrêt propre du process. */
export async function drain(): Promise<void> {
  await Promise.all([...tails.values()]);
}
