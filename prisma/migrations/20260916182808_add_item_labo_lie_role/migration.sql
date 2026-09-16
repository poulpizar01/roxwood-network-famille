-- AlterTable
ALTER TABLE "items" ADD COLUMN     "labo_lie_role" TEXT;

UPDATE "items" SET "labo_lie_role" = 'produit' WHERE "labo_lie" IS NOT NULL;
