-- CreateTable
CREATE TABLE "salary_tiers" (
    "guild_id" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "item" TEXT,
    "up_to" INTEGER,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "salary_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "salary_tiers_guild_id_item_idx" ON "salary_tiers"("guild_id", "item");
