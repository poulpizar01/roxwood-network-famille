-- CreateTable
CREATE TABLE "item_salary_rates" (
    "guild_id" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "item_salary_rates_pkey" PRIMARY KEY ("guild_id","item")
);

-- CreateTable
CREATE TABLE "classement_rates" (
    "guild_id" TEXT NOT NULL,
    "quota_type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "classement_rates_pkey" PRIMARY KEY ("guild_id","quota_type")
);

-- CreateTable
CREATE TABLE "activity_classement_rates" (
    "guild_id" TEXT NOT NULL,
    "activity_key" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "activity_classement_rates_pkey" PRIMARY KEY ("guild_id","activity_key")
);
