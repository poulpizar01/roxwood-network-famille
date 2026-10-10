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

export interface ArgentSummary {
  /** Argent déposé/retiré dans les coffres (tous coffres, admin compris), par type. */
  coffres: Record<TypeArgent, { depose: number; retire: number; solde: number }>;
  /** Argent sale saisi sur les actions, total et détail par action (seules les actions ayant un montant sur la période). */
  actions: { total: number; parAction: Array<{ action: string; label: string; total: number; nombre: number }> };
  /** Argent sale saisi sur les ventes de drogue confirmées. */
  ventes: { total: number; nombre: number };
}

/** Résumé de l'argent sur `[since, until)` — source unique du bilan hebdomadaire et de `/api/argent`. */
export async function getArgentSummaryForRange(guildId: string, range: { since: number; until: number }): Promise<ArgentSummary> {
  const [coffres, montants] = await Promise.all([
    db.getArgentCoffres(guildId, range.since, range.until),
    db.getMontantsParAction(guildId, range.since, range.until),
  ]);
  const activityTypes = configStore.get(guildId).ACTIVITY_TYPES;
  const vente = montants.find(m => m.action === 'vente');
  const parAction = montants
    .filter(m => m.action !== 'vente')
    .map(m => ({ ...m, label: activityTypes[m.action]?.label ?? m.action }))
    .sort((a, b) => (activityTypes[a.action]?.displayOrder ?? Infinity) - (activityTypes[b.action]?.displayOrder ?? Infinity));
  const avecSolde = (c: { depose: number; retire: number }) => ({ ...c, solde: c.depose - c.retire });
  return {
    coffres: { sale: avecSolde(coffres.sale), propre: avecSolde(coffres.propre) },
    actions: { total: parAction.reduce((sum, a) => sum + a.total, 0), parAction },
    ventes: { total: vente?.total ?? 0, nombre: vente?.nombre ?? 0 },
  };
}
