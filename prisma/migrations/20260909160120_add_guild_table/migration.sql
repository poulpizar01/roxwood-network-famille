-- CreateTable
CREATE TABLE "guilds" (
    "guild_id" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "frontend_url" TEXT,
    "cors_origin" TEXT,

    CONSTRAINT "guilds_pkey" PRIMARY KEY ("guild_id")
);
