/**
 * @file src/default-items.ts
 * @description Pré-remplissage d'items connus, s'ils sont absents — évite
 * d'avoir à les taper à la main via `/config item add` pour un déploiement
 * neuf. Appelé à deux endroits (voir `seedDefaultItems`), pas seulement au
 * démarrage global du process : `index.ts` (une fois par démarrage — utile
 * dès le tout premier rendu des panneaux) ET `modules/config.ts` (à chaque
 * usage de `/config` — pour qu'un bot déjà en cours d'exécution depuis un
 * moment se retrouve avec ces items sans attendre un redémarrage). Les deux
 * appels sont sans risque : no-op dès que tout est déjà présent.
 *
 * Ce n'est PAS un registre fixe comme `ACTIVITY_TYPES_FIXED`
 * (config-store.ts) : un item pré-rempli reste ensuite un item de config
 * comme un autre, modifiable ou supprimable via `/config item` — cette liste
 * ne fait qu'insérer une valeur de départ, une seule fois, jamais écraser un
 * item déjà présent (vérifié par nom exact avant toute insertion).
 *
 * **Piège n°1 du projet (voir CLAUDE.md)** : chaque `name` ci-dessous doit
 * être l'orthographe EXACTE (accents, casse) telle qu'écrite par le bot de
 * jeu FiveM dans les logs de coffre — vérifiée par l'admin, jamais devinée.
 * Ne pas ajouter d'entrée ici sans cette confirmation explicite.
 */
import * as db from './db';
import * as configStore from './config-store';
import { MUNITIONS_STOCK_GROUP, MUNITIONS_SMG_ITEM } from './modules/armurerie';
import { CONFIRME_VENTE_ITEM } from './modules/ventes';

// Les 5 premiers items reçoivent un `display_order` négatif explicite, dans
// l'ordre où ils sont déclarés ci-dessous — ce sont les seuls à apparaître
// individuellement dans le corps principal du Stock Général (les items de
// labo plus bas sont masqués, visibles seulement via les champs dynamiques
// Drogues de production/Matériaux, voir stocks.buildStockEmbed). Négatif,
// pas juste 1-5 : garantit qu'ils restent TOUJOURS avant un item ajouté par
// un admin (qui reste au défaut 0), même après une correction manuelle de
// display_order sur un de ces 5 (voir db.upsertItem, qui ne touche plus
// display_order si `display_order` est omis — un simple 1-5 se ferait
// dépasser par le premier item admin qui recevrait un jour un display_order
// positif bas).
const DEFAULT_ITEMS: db.ItemInput[] = [
  { name: 'Munition de pistolet', stock_group: MUNITIONS_STOCK_GROUP, display_order: -5 },
  // Vaut 24x "Munition de pistolet" (stock_multiplier) — même groupe, comptée
  // en conséquence dans le total munitions pondéré (voir armurerie.weightedStockSum).
  { name: 'Boîte mun. pistolet', stock_group: MUNITIONS_STOCK_GROUP, stock_multiplier: 24, display_order: -4 },
  // CONFIRME_VENTE_ITEM (voir ventes.ts) — simple item de stock ici, son rôle
  // de confirmation de vente est fixe dans le code, pas un flag à poser.
  { name: CONFIRME_VENTE_ITEM, display_order: -3 },
  // Distinct de CONFIRME_VENTE_ITEM ("Argent Sale") : simple item de stock,
  // ne joue aucun rôle dans le cycle de vente.
  { name: 'Argent', display_order: -2 },
  // Simple item de stock, sans groupe : affiché dans l'armurerie via
  // MUNITIONS_SMG_ITEM (stock brut uniquement, pas de quota fabrication/vente).
  { name: MUNITIONS_SMG_ITEM, display_order: -1 },
  // Labo Salvia (Indépendant uniquement) — Salvia, contrairement aux autres
  // drogues de labo, n'est volontairement PAS liée à son labo (pas de
  // labo_lie) : elle reste vendable au PNJ même quand ce labo est actif.
  { name: 'Salvia', vente: true },
  { name: 'Feuilles de salvia', labo_lie: 'labo_salvia', labo_lie_role: 'materiau' },
  // Labo Branche De Cannabis (Indépendant uniquement) — ici la drogue produite
  // (Branche de cannabis) EST liée à son labo, donc exclue de la vente PNJ
  // tant que ce labo est actif, contrairement à Salvia ci-dessus.
  { name: 'Branche de cannabis', labo_lie: 'labo_branche_cannabis', labo_lie_role: 'produit' },
  { name: 'Graine de strawberry', labo_lie: 'labo_branche_cannabis', labo_lie_role: 'materiau' },
  { name: 'Pot de plantation', labo_lie: 'labo_branche_cannabis', labo_lie_role: 'materiau' },
  { name: 'Fertilisant', labo_lie: 'labo_branche_cannabis', labo_lie_role: 'materiau' },
  // Matériaux du labo Spore X (déjà existant).
  { name: 'Psilocybe Rouge', labo_lie: 'labo_sporex', labo_lie_role: 'materiau' },
  { name: 'Psilocybe Vert', labo_lie: 'labo_sporex', labo_lie_role: 'materiau' },
  { name: 'Psilocybe Violet', labo_lie: 'labo_sporex', labo_lie_role: 'materiau' },
  { name: 'Poudre à canon', labo_lie: 'labo_sporex', labo_lie_role: 'materiau' },
  { name: 'Fragment de métal', labo_lie: 'labo_sporex', labo_lie_role: 'materiau' },
  // Matériaux du labo Héroïne (déjà existant).
  { name: 'Datura', labo_lie: 'labo_heroine', labo_lie_role: 'materiau' },
  { name: 'Morphine', labo_lie: 'labo_heroine', labo_lie_role: 'materiau' },
];

/**
 * Insère chaque item de {@link DEFAULT_ITEMS} qui n'existe pas encore dans la
 * config actuelle (comparaison par nom exact) — ne touche jamais à un item
 * déjà configuré, même si ses options diffèrent de la valeur par défaut ici.
 * Idempotent — safe à appeler à répétition (voir docstring de fichier).
 */
export async function seedDefaultItems(guildId: string): Promise<void> {
  const existing = configStore.get(guildId).ITEMS_BY_NAME;
  let inserted = false;

  for (const item of DEFAULT_ITEMS) {
    if (existing[item.name]) continue;
    await db.upsertItem(guildId, item);
    inserted = true;
    console.log(`[default-items] Item pré-rempli (${guildId}) : ${item.name}`);
  }

  if (inserted) await configStore.reload(guildId);
}
