/**
 * @file src/modules/argent.ts
 * @description Argent sale et propre, purement indicatif (n'affecte ni le
 * stock réel ni la paie) :
 *  - montant saisi à la déclaration d'une action ou d'une vente de drogue,
 *    quand l'option correspondante est active (`/config option`) ;
 *  - évolution du stock d'argent entre deux frontières hebdomadaires, à
 *    partir d'instantanés exacts pris au dimanche 19h.
 * Le bilan hebdomadaire (`quotas.ts`) et l'API (`/api/argent`) lisent le même
 * résumé, {@link getArgentSummaryForRange}.
 */
import { ActionRowBuilder, TextInputBuilder, TextInputStyle, type ModalSubmitInteraction } from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';
import type { ActivityTypeConfig } from '../config-store';
import { parseEntier } from '../parse';

export type TypeArgent = 'sale' | 'propre';

/**
 * Noms EXACTS (accents, casse — piège n°1) des items d'argent dans les logs
 * de coffre, vérifiés avec l'utilisateur (voir `default-items.ts`). "Argent
 * Sale" est aussi l'item qui confirme une vente (`ventes.CONFIRME_VENTE_ITEM`).
 */
export const ARGENT_ITEMS: Record<TypeArgent, string> = { sale: 'Argent Sale', propre: 'Argent' };

/** Type d'argent d'un item de coffre (comparaison insensible à la casse, comme partout pour un item), `null` si ce n'est pas de l'argent. */
export function typeArgent(item: string): TypeArgent | null {
  const key = item.toLowerCase();
  if (key === ARGENT_ITEMS.sale.toLowerCase()) return 'sale';
  if (key === ARGENT_ITEMS.propre.toLowerCase()) return 'propre';
  return null;
}

/** Plafond d'un montant saisi — `Transaction.montant`/`PendingSale.montant` sont des colonnes `Int`. */
export const MAX_MONTANT = 100_000_000;

/** Vrai si cette action demande le montant à la déclaration, pour la config ACTUELLE (à revérifier à la soumission : l'option a pu changer entre-temps). */
export function demandeMontantAction(guildId: string, cfg: ActivityTypeConfig): boolean {
  return !!cfg.montant && configStore.get(guildId).OPTIONS.saisie_argent_actions;
}

/** Vrai si "Déclarer la Vente" demande le montant, pour la config ACTUELLE. */
export function demandeMontantVente(guildId: string): boolean {
  return configStore.get(guildId).OPTIONS.saisie_argent_ventes;
}

/** Champ de modal "Argent sale gagné", toujours obligatoire quand il est affiché. */
export function montantRow(label = 'Argent sale gagné ($)'): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId('montant').setLabel(label)
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(13)
      .setPlaceholder(`Montant total, ${MAX_MONTANT.toLocaleString('fr-FR')} $ au plus`),
  );
}

/**
 * Lit le montant d'un modal soumis. `absent` : le modal a été ouvert sans le
 * champ (option activée entre l'ouverture et la soumission) — l'appelant
 * refuse alors la déclaration plutôt que de l'enregistrer sans montant.
 */
export function lireMontant(interaction: ModalSubmitInteraction): number | 'absent' | 'invalide' {
  let raw: string;
  try {
    raw = interaction.fields.getTextInputValue('montant');
  } catch {
    return 'absent';
  }
  return parseEntier(raw, MAX_MONTANT) ?? 'invalide';
}

/** Message de refus correspondant à un résultat non numérique de {@link lireMontant}. */
export function refusMontant(resultat: 'absent' | 'invalide'): string {
  return resultat === 'absent'
    ? "❌ La saisie de l'argent vient d'être activée : relance la déclaration pour indiquer le montant."
    : `❌ Montant invalide (nombre entier de dollars, ${MAX_MONTANT.toLocaleString('fr-FR')} au plus).`;
}

/** Argent sale saisi, sur les actions (détail par action) et sur les ventes. */
export interface ArgentSaisi {
  /** Seules les actions ayant un montant sur la période figurent dans `parAction`. */
  actions: { total: number; parAction: Array<{ action: string; label: string; total: number }> };
  ventes: { total: number };
}

export interface ArgentSummary extends ArgentSaisi {
  /** Stock de tous les coffres suivis, coffres admin compris. */
  stocks: Record<TypeArgent, db.ArgentStockComparison | null>;
}

/** Regroupe des montants (une ligne par déclaration ou par part de déclaration) en {@link ArgentSaisi}. */
function regrouperMontants(guildId: string, montants: Array<{ action: string; total: number }>): ArgentSaisi {
  const activityTypes = configStore.get(guildId).ACTIVITY_TYPES;
  const parCle = new Map<string, number>();
  for (const m of montants) parCle.set(m.action, (parCle.get(m.action) ?? 0) + m.total);
  const vente = parCle.get('vente');
  parCle.delete('vente');
  const parAction = [...parCle.entries()]
    .map(([action, total]) => ({ action, label: activityTypes[action]?.label ?? action, total }))
    .sort((a, b) => (activityTypes[a.action]?.displayOrder ?? Infinity) - (activityTypes[b.action]?.displayOrder ?? Infinity));
  return {
    actions: { total: parAction.reduce((sum, a) => sum + a.total, 0), parAction },
    ventes: { total: vente ?? 0 },
  };
}

/** Résumé de l'argent sur `[since, until)` — source unique du bilan hebdomadaire et de `/api/argent`. */
export async function getArgentSummaryForRange(
  guildId: string, range: { since: number; until: number }, currentEnd = false,
): Promise<ArgentSummary> {
  const [stocks, montants] = await Promise.all([
    db.getArgentStockComparisons(guildId, range.since, range.until, currentEnd, configStore.coffreChannelIds(guildId)),
    db.getMontants(guildId, range.since, range.until),
  ]);
  return {
    stocks,
    ...regrouperMontants(guildId, montants.map(m => ({ action: m.action, total: m.montant }))),
  };
}

/**
 * Parts d'un montant entre participants (déclarant en premier), à parts
 * égales en dollars entiers : le reste de la division revient au déclarant,
 * pour que la somme des parts soit EXACTEMENT le montant déclaré — jamais
 * le montant compté une fois par participant.
 */
export function repartirMontant(montant: number, participants: string[]): Array<{ userId: string; part: number }> {
  const base = Math.floor(montant / participants.length);
  const reste = montant - base * participants.length;
  return participants.map((userId, i) => ({ userId, part: base + (i === 0 ? reste : 0) }));
}

/**
 * Argent sale saisi par joueur sur `[since, until)`, trié par total
 * décroissant — `userId` pour un seul joueur. Le montant d'un braquage à
 * plusieurs est partagé entre tous ses participants ({@link repartirMontant}) :
 * la somme des joueurs est toujours égale au total du groupe. Les
 * évolutions de stock ne sont pas suivies par joueur.
 */
export async function getArgentParJoueurForRange(
  guildId: string, range: { since: number; until: number }, userId?: string,
): Promise<Array<{ userId: string; total: number } & ArgentSaisi>> {
  const parJoueur = new Map<string, Array<{ action: string; total: number }>>();
  for (const m of await db.getMontants(guildId, range.since, range.until)) {
    const participants = [m.userId, ...m.partenaires.filter(p => p !== m.userId)];
    for (const { userId: id, part } of repartirMontant(m.montant, participants)) {
      if (userId && id !== userId) continue;
      (parJoueur.get(id) ?? parJoueur.set(id, []).get(id)!).push({ action: m.action, total: part });
    }
  }
  return [...parJoueur.entries()]
    .map(([id, montants]) => {
      const saisi = regrouperMontants(guildId, montants);
      return { userId: id, total: saisi.actions.total + saisi.ventes.total, ...saisi };
    })
    .sort((a, b) => b.total - a.total);
}
