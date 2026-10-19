ALTER TABLE "transactions" ADD COLUMN "montant" INTEGER;

CREATE TABLE "argent_semaines" (
    "guild_id" TEXT NOT NULL,
    "semaine" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "depose" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "retire" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "argent_semaines_pkey" PRIMARY KEY ("guild_id", "semaine", "type")
);
