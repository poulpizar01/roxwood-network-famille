-- Stock detaille par coffre (salon logs_coffres), en plus du total global
-- deja existant (table stocks, inchangee).
CREATE TABLE "coffre_stocks" (
    "channel_id" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "coffre_stocks_pkey" PRIMARY KEY ("channel_id", "item")
);

-- Salon d'origine du mouvement, pour l'historique -- NULL pour les lignes
-- existantes (jamais backfille, l'historique est de toute facon plafonne).
ALTER TABLE "stock_history" ADD COLUMN "channel_id" TEXT;
