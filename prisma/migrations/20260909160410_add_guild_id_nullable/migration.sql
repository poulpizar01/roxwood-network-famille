-- AlterTable
ALTER TABLE "armurerie" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "braquages" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "coffre_stocks" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "cooldowns" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "discord_roles" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "fourrieres" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "munitions_ventes" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "pending_sales" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "quota_targets" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "salary_rates" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "stats" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "stock_history" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "stocks" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "taxes" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "user_mapping" ADD COLUMN     "guild_id" TEXT;

-- AlterTable
ALTER TABLE "vehicules" ADD COLUMN     "guild_id" TEXT;
