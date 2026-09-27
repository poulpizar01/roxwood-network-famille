-- Le total global n'est plus stocké séparément : il se recalcule à la
-- lecture comme la somme de `coffre_stocks` pour chaque item (voir
-- docstring de section STOCKS dans src/db.ts). L'ancienne table `stocks`
-- pouvait diverger de cette somme au fil du temps (chaque table plafonnait
-- sa propre valeur à 0 indépendamment, même à l'intérieur d'une transaction).

-- DropTable
DROP TABLE "stocks";

-- CreateIndex
CREATE INDEX "coffre_stocks_guild_id_item_idx" ON "coffre_stocks"("guild_id", "item");
