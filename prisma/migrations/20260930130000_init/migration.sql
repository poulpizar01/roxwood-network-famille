-- CreateTable
CREATE TABLE "guilds" (
    "guild_id" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "removed_at" TIMESTAMP(3),
    "frontend_url" TEXT,
    "cors_origin" TEXT,

    CONSTRAINT "guilds_pkey" PRIMARY KEY ("guild_id")
);

-- CreateTable
CREATE TABLE "settings" (
    "guild_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("guild_id","key")
);

-- CreateTable
CREATE TABLE "channels" (
    "guild_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "label" TEXT,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("guild_id","role","channel_id")
);

-- CreateTable
CREATE TABLE "discord_roles" (
    "guild_id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "discord_roles_pkey" PRIMARY KEY ("guild_id","target")
);

-- CreateTable
CREATE TABLE "items" (
    "guild_id" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "stock_group" TEXT,
    "vente" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "visible_stock" BOOLEAN NOT NULL DEFAULT true,
    "labo_lie" TEXT,
    "labo_lie_role" TEXT,
    "stock_multiplier" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "items_pkey" PRIMARY KEY ("guild_id","name")
);

-- CreateTable
CREATE TABLE "quota_targets" (
    "guild_id" TEXT NOT NULL,
    "quota_type" TEXT NOT NULL,
    "weekly_target" INTEGER NOT NULL,

    CONSTRAINT "quota_targets_pkey" PRIMARY KEY ("guild_id","quota_type")
);

-- CreateTable
CREATE TABLE "salary_rates" (
    "guild_id" TEXT NOT NULL,
    "quota_type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "salary_rates_pkey" PRIMARY KEY ("guild_id","quota_type")
);

-- CreateTable
CREATE TABLE "item_salary_rates" (
    "guild_id" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "item_salary_rates_pkey" PRIMARY KEY ("guild_id","item")
);

-- CreateTable
CREATE TABLE "salary_tiers" (
    "guild_id" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "item" TEXT,
    "up_to" INTEGER,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "salary_tiers_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "coffre_stocks" (
    "guild_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "coffre_stocks_pkey" PRIMARY KEY ("guild_id","channel_id","item")
);

-- CreateTable
CREATE TABLE "stock_history" (
    "guild_id" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joueur" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "stock_avant" INTEGER NOT NULL,
    "stock_apres" INTEGER NOT NULL,
    "channel_id" TEXT,

    CONSTRAINT "stock_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "guild_id" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "username" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "quantite" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "type" TEXT,
    "partenaires" TEXT NOT NULL DEFAULT '[]',
    "temps_restant" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_by" TEXT,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stats" (
    "guild_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "count" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "stats_pkey" PRIMARY KEY ("guild_id","user_id","action")
);

-- CreateTable
CREATE TABLE "cooldowns" (
    "guild_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "notified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "cooldowns_pkey" PRIMARY KEY ("guild_id","user_id","action")
);

-- CreateTable
CREATE TABLE "braquages" (
    "guild_id" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "braquages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxes" (
    "guild_id" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "nom" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "telephone" TEXT,
    "echeance" TIMESTAMP(3) NOT NULL,
    "mot_de_passe" TEXT,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "alerte_sent" BOOLEAN NOT NULL DEFAULT false,
    "paye" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "taxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "armurerie" (
    "guild_id" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "nom" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'en_stock',
    "pretee_a" TEXT,
    "type" TEXT,

    CONSTRAINT "armurerie_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_mapping" (
    "guild_id" TEXT NOT NULL,
    "game_name" TEXT NOT NULL,
    "discord_id" TEXT NOT NULL,

    CONSTRAINT "user_mapping_pkey" PRIMARY KEY ("guild_id","game_name","discord_id")
);

-- CreateTable
CREATE TABLE "pending_sales" (
    "guild_id" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "joueur" TEXT NOT NULL,
    "discord_id" TEXT,
    "item" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "quantite_retiree" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "montant" INTEGER,
    "message_id" TEXT,
    "channel_id" TEXT,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pending_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicules" (
    "guild_id" TEXT NOT NULL,
    "plaque" TEXT NOT NULL,
    "modele" TEXT,
    "discord_id" TEXT,
    "joueur" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicules_pkey" PRIMARY KEY ("guild_id","plaque")
);

-- CreateTable
CREATE TABLE "fourrieres" (
    "guild_id" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "discord_id" TEXT,
    "joueur" TEXT NOT NULL,
    "plaque" TEXT NOT NULL,
    "modele" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fourrieres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "munitions_ventes" (
    "guild_id" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vendeur_id" TEXT NOT NULL,
    "vendeur_username" TEXT NOT NULL DEFAULT '',
    "acheteur_id" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "prix" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "munitions_ventes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "items_id_key" ON "items"("id");

-- CreateIndex
CREATE INDEX "salary_tiers_guild_id_item_idx" ON "salary_tiers"("guild_id", "item");

-- CreateIndex
CREATE INDEX "coffre_stocks_guild_id_item_idx" ON "coffre_stocks"("guild_id", "item");

-- CreateIndex
CREATE INDEX "stock_history_guild_id_item_idx" ON "stock_history"("guild_id", "item");

-- CreateIndex
CREATE INDEX "transactions_guild_id_action_idx" ON "transactions"("guild_id", "action");

-- CreateIndex
CREATE INDEX "transactions_guild_id_timestamp_idx" ON "transactions"("guild_id", "timestamp");

-- CreateIndex
CREATE INDEX "braquages_guild_id_action_timestamp_idx" ON "braquages"("guild_id", "action", "timestamp");

-- CreateIndex
CREATE INDEX "taxes_guild_id_actif_idx" ON "taxes"("guild_id", "actif");

-- CreateIndex
CREATE INDEX "taxes_guild_id_type_idx" ON "taxes"("guild_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "armurerie_guild_id_reference_key" ON "armurerie"("guild_id", "reference");

-- CreateIndex
CREATE INDEX "pending_sales_guild_id_statut_idx" ON "pending_sales"("guild_id", "statut");

-- CreateIndex
CREATE INDEX "pending_sales_guild_id_joueur_item_idx" ON "pending_sales"("guild_id", "joueur", "item");

-- CreateIndex
CREATE INDEX "fourrieres_guild_id_timestamp_idx" ON "fourrieres"("guild_id", "timestamp");

-- CreateIndex
CREATE INDEX "munitions_ventes_guild_id_timestamp_idx" ON "munitions_ventes"("guild_id", "timestamp");

