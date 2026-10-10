/**
 * @file src/modules/argent.ts
 * @description Argent sale et propre, purement indicatif (n'affecte ni le
 * stock réel ni la paie) :
 *  - montant saisi à la déclaration d'une action ou d'une vente de drogue,
 *    quand l'option correspondante est active (`/config option`) ;
 *  - argent déposé/retiré dans les coffres, cumulé par semaine de paie
 *    (`ArgentSemaine`, voir `db.applyStockMessage`).
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
  actions: { total: number; parAction: Array<{ action: string; label: string; total: number; nombre: number }> };
  ventes: { total: number; nombre: number };
}

export interface ArgentSummary extends ArgentSaisi {
  /** Argent déposé/retiré dans les coffres (tous coffres, admin compris), par type. */
  coffres: Record<TypeArgent, { depose: number; retire: number; solde: number }>;
}

/** Regroupe des montants (une ligne par action, éventuellement de plusieurs joueurs) en {@link ArgentSaisi}. */
function regrouperMontants(guildId: string, montants: Array<{ action: string; total: number; nombre: number }>): ArgentSaisi {
  const activityTypes = configStore.get(guildId).ACTIVITY_TYPES;
  const parCle = new Map<string, { total: number; nombre: number }>();
  for (const m of montants) {
    const cumul = parCle.get(m.action) ?? { total: 0, nombre: 0 };
    parCle.set(m.action, { total: cumul.total + m.total, nombre: cumul.nombre + m.nombre });
  }
  const vente = parCle.get('vente');
  parCle.delete('vente');
  const parAction = [...parCle.entries()]
    .map(([action, m]) => ({ action, label: activityTypes[action]?.label ?? action, ...m }))
    .sort((a, b) => (activityTypes[a.action]?.displayOrder ?? Infinity) - (activityTypes[b.action]?.displayOrder ?? Infinity));
  return {
    actions: { total: parAction.reduce((sum, a) => sum + a.total, 0), parAction },
    ventes: { total: vente?.total ?? 0, nombre: vente?.nombre ?? 0 },
  };
}

/** Résumé de l'argent sur `[since, until)` — source unique du bilan hebdomadaire et de `/api/argent`. */
export async function getArgentSummaryForRange(guildId: string, range: { since: number; until: number }): Promise<ArgentSummary> {
  const [coffres, montants] = await Promise.all([
    db.getArgentCoffres(guildId, range.since, range.until),
    db.getMontants(guildId, range.since, range.until),
  ]);
  const avecSolde = (c: { depose: number; retire: number }) => ({ ...c, solde: c.depose - c.retire });
  return {
    coffres: { sale: avecSolde(coffres.sale), propre: avecSolde(coffres.propre) },
    ...regrouperMontants(guildId, montants),
  };
}

/**
 * Argent sale saisi par joueur sur `[since, until)`, trié par total
 * décroissant — `userId` pour un seul joueur. Les dépôts/retraits de coffre
 * ne sont pas suivis par joueur (voir `ArgentSemaine`).
 */
export async function getArgentParJoueurForRange(
  guildId: string, range: { since: number; until: number }, userId?: string,
): Promise<Array<{ userId: string; total: number } & ArgentSaisi>> {
  const parJoueur = new Map<string, Array<{ action: string; total: number; nombre: number }>>();
  for (const m of await db.getMontants(guildId, range.since, range.until, userId)) {
    (parJoueur.get(m.userId) ?? parJoueur.set(m.userId, []).get(m.userId)!).push(m);
  }
  return [...parJoueur.entries()]
    .map(([id, montants]) => {
      const saisi = regrouperMontants(guildId, montants);
      return { userId: id, total: saisi.actions.total + saisi.ventes.total, ...saisi };
    })
    .sort((a, b) => b.total - a.total);
}
