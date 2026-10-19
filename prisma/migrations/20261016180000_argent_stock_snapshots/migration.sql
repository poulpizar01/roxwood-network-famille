CREATE TABLE "argent_stock_snapshots" (
    "guild_id" TEXT NOT NULL,
    "semaine" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,

    CONSTRAINT "argent_stock_snapshots_pkey" PRIMARY KEY ("guild_id", "semaine", "type")
);

CREATE INDEX "argent_stock_snapshots_guild_id_type_semaine_idx"
ON "argent_stock_snapshots"("guild_id", "type", "semaine");

-- `argent_semaines` reste volontairement en place pour conserver l'ancien
-- historique. Le code ne l'alimente et ne le lit plus.
