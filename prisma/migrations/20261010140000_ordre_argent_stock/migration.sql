-- Stock Général : l'argent avant les munitions. Seuls les items encore à leur
-- valeur d'ordre par défaut (négative) sont repositionnés.
UPDATE "items" SET "display_order" = CASE lower("name")
    WHEN 'argent' THEN -5
    WHEN 'argent sale' THEN -4
    WHEN 'munition de pistolet' THEN -3
    WHEN 'boîte mun. pistolet' THEN -2
  END
WHERE lower("name") IN ('argent', 'argent sale', 'munition de pistolet', 'boîte mun. pistolet')
  AND "display_order" < 0;
