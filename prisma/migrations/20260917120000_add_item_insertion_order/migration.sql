-- AlterTable
ALTER TABLE "items" ADD COLUMN     "id" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "items_id_key" ON "items"("id");
