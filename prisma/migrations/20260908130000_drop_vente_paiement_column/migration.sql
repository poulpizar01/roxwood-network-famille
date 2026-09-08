-- Supprime la colonne vente_paiement (flag par item) : un seul item joue ce
-- rôle en pratique ("Argent Sale"), désormais fixé en dur dans
-- modules/ventes.ts (CONFIRME_VENTE_ITEM) plutôt qu'un flag configurable par
-- item — cf. discussion sur l'incohérence de nommage/conception de ce champ.
ALTER TABLE "items" DROP COLUMN "vente_paiement";
