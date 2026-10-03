/**
 * @file src/serial.ts
 * @description Exécution en série par clé : deux appels avec la même clé
 * s'exécutent l'un après l'autre, des clés différentes restent
 * indépendantes. Base de la file de logs par guilde (`guild-queue.ts`) et
 * des rafraîchissements de messages permanents (`permanent-message.ts`).
 */

export class SerialRunner {
  private readonly tails = new Map<string, Promise<void>>();

  /** Exécute `fn` après tout ce qui est déjà en attente pour `key`. Ne jamais appeler depuis un `fn` déjà en cours pour la même clé (attente infinie). */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return run;
  }

  /** Résolue quand toutes les clés sont au repos. */
  async drain(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }
}
