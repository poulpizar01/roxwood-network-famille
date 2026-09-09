-- DropIndex
DROP INDEX "armurerie_reference_key";

-- DropIndex
DROP INDEX "braquages_action_timestamp_idx";

-- DropIndex
DROP INDEX "stock_history_item_idx";

-- DropIndex
DROP INDEX "transactions_action_idx";

-- DropIndex
DROP INDEX "transactions_timestamp_idx";

-- AlterTable
ALTER TABLE "armurerie" ALTER COLUMN "guild_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "braquages" ALTER COLUMN "guild_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "channels" DROP CONSTRAINT "channels_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "channels_pkey" PRIMARY KEY ("guild_id", "role", "channel_id");

-- AlterTable
ALTER TABLE "coffre_stocks" DROP CONSTRAINT "coffre_stocks_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "coffre_stocks_pkey" PRIMARY KEY ("guild_id", "channel_id", "item");

-- AlterTable
ALTER TABLE "cooldowns" DROP CONSTRAINT "cooldowns_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "cooldowns_pkey" PRIMARY KEY ("guild_id", "user_id", "action");

-- AlterTable
ALTER TABLE "discord_roles" DROP CONSTRAINT "discord_roles_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "discord_roles_pkey" PRIMARY KEY ("guild_id", "target");

-- AlterTable
ALTER TABLE "fourrieres" ALTER COLUMN "guild_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "items" DROP CONSTRAINT "items_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "items_pkey" PRIMARY KEY ("guild_id", "name");

-- AlterTable
ALTER TABLE "munitions_ventes" ALTER COLUMN "guild_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "pending_sales" ALTER COLUMN "guild_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "quota_targets" DROP CONSTRAINT "quota_targets_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "quota_targets_pkey" PRIMARY KEY ("guild_id", "quota_type");

-- AlterTable
ALTER TABLE "salary_rates" DROP CONSTRAINT "salary_rates_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "salary_rates_pkey" PRIMARY KEY ("guild_id", "quota_type");

-- AlterTable
ALTER TABLE "settings" DROP CONSTRAINT "settings_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "settings_pkey" PRIMARY KEY ("guild_id", "key");

-- AlterTable
ALTER TABLE "stats" DROP CONSTRAINT "stats_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "stats_pkey" PRIMARY KEY ("guild_id", "user_id", "action");

-- AlterTable
ALTER TABLE "stock_history" ALTER COLUMN "guild_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "stocks" DROP CONSTRAINT "stocks_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "stocks_pkey" PRIMARY KEY ("guild_id", "item");

-- AlterTable
ALTER TABLE "taxes" ALTER COLUMN "guild_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "transactions" ALTER COLUMN "guild_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "user_mapping" DROP CONSTRAINT "user_mapping_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "user_mapping_pkey" PRIMARY KEY ("guild_id", "game_name", "discord_id");

-- AlterTable
ALTER TABLE "vehicules" DROP CONSTRAINT "vehicules_pkey",
ALTER COLUMN "guild_id" SET NOT NULL,
ADD CONSTRAINT "vehicules_pkey" PRIMARY KEY ("guild_id", "plaque");

-- CreateIndex
CREATE UNIQUE INDEX "armurerie_guild_id_reference_key" ON "armurerie"("guild_id", "reference");

-- CreateIndex
CREATE INDEX "braquages_guild_id_action_timestamp_idx" ON "braquages"("guild_id", "action", "timestamp");

-- CreateIndex
CREATE INDEX "fourrieres_guild_id_timestamp_idx" ON "fourrieres"("guild_id", "timestamp");

-- CreateIndex
CREATE INDEX "munitions_ventes_guild_id_timestamp_idx" ON "munitions_ventes"("guild_id", "timestamp");

-- CreateIndex
CREATE INDEX "pending_sales_guild_id_statut_idx" ON "pending_sales"("guild_id", "statut");

-- CreateIndex
CREATE INDEX "stock_history_guild_id_item_idx" ON "stock_history"("guild_id", "item");

-- CreateIndex
CREATE INDEX "taxes_guild_id_actif_idx" ON "taxes"("guild_id", "actif");

-- CreateIndex
CREATE INDEX "transactions_guild_id_action_idx" ON "transactions"("guild_id", "action");

-- CreateIndex
CREATE INDEX "transactions_guild_id_timestamp_idx" ON "transactions"("guild_id", "timestamp");

