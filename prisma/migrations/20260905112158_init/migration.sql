-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "channels" (
    "role" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("role","channel_id")
);

-- CreateTable
CREATE TABLE "discord_roles" (
    "target" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "discord_roles_pkey" PRIMARY KEY ("target")
);

-- CreateTable
CREATE TABLE "items" (
    "name" TEXT NOT NULL,
    "stock_group" TEXT,
    "vente" BOOLEAN NOT NULL DEFAULT false,
    "vente_paiement" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "visible_stock" BOOLEAN NOT NULL DEFAULT true,
    "labo_lie" TEXT,

    CONSTRAINT "items_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "quota_targets" (
    "quota_type" TEXT NOT NULL,
    "weekly_target" INTEGER NOT NULL,

    CONSTRAINT "quota_targets_pkey" PRIMARY KEY ("quota_type")
);

-- CreateTable
CREATE TABLE "salary_rates" (
    "quota_type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "salary_rates_pkey" PRIMARY KEY ("quota_type")
);

-- CreateTable
CREATE TABLE "stocks" (
    "item" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "stocks_pkey" PRIMARY KEY ("item")
);

-- CreateTable
CREATE TABLE "stock_history" (
    "id" SERIAL NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joueur" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "stock_avant" INTEGER NOT NULL,
    "stock_apres" INTEGER NOT NULL,

    CONSTRAINT "stock_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
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
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "count" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "stats_pkey" PRIMARY KEY ("user_id","action")
);

-- CreateTable
CREATE TABLE "cooldowns" (
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "notified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "cooldowns_pkey" PRIMARY KEY ("user_id","action")
);

-- CreateTable
CREATE TABLE "braquages" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "braquages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxes" (
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
    "game_name" TEXT NOT NULL,
    "discord_id" TEXT NOT NULL,

    CONSTRAINT "user_mapping_pkey" PRIMARY KEY ("game_name","discord_id")
);

-- CreateTable
CREATE TABLE "pending_sales" (
    "id" SERIAL NOT NULL,
    "joueur" TEXT NOT NULL,
    "discord_id" TEXT,
    "item" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "montant" INTEGER,
    "prix_pochon" DOUBLE PRECISION,
    "message_id" TEXT,
    "channel_id" TEXT,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pending_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicules" (
    "plaque" TEXT NOT NULL,
    "modele" TEXT,
    "discord_id" TEXT,
    "joueur" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicules_pkey" PRIMARY KEY ("plaque")
);

-- CreateTable
CREATE TABLE "fourrieres" (
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
CREATE INDEX "stock_history_item_idx" ON "stock_history"("item");

-- CreateIndex
CREATE INDEX "transactions_action_idx" ON "transactions"("action");

-- CreateIndex
CREATE INDEX "transactions_timestamp_idx" ON "transactions"("timestamp");

-- CreateIndex
CREATE INDEX "braquages_action_timestamp_idx" ON "braquages"("action", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "armurerie_reference_key" ON "armurerie"("reference");
