-- Taxes Salvia et Fertilisant et labo Salvia retirés : leurs données n'ont plus de bouton ni d'affichage.
-- L'item "Fertilisant" (matériau du labo Branche De Cannabis) n'est pas concerné.
DELETE FROM "taxes" WHERE "type" IN ('salvia', 'fertilisant');
DELETE FROM "channels" WHERE "role" = 'labo_salvia';
DELETE FROM "cooldowns" WHERE "action" = 'labo_salvia';
DELETE FROM "settings" WHERE "key" = 'labo_end_labo_salvia';
DELETE FROM "items" WHERE lower("name") IN ('salvia', 'feuilles de salvia');
DELETE FROM "coffre_stocks" WHERE lower("item") IN ('salvia', 'feuilles de salvia');
DELETE FROM "item_salary_rates" WHERE lower("item") IN ('salvia', 'feuilles de salvia');
DELETE FROM "salary_tiers" WHERE lower("item") IN ('salvia', 'feuilles de salvia');
DELETE FROM "pending_sales" WHERE lower("item") IN ('salvia', 'feuilles de salvia');
