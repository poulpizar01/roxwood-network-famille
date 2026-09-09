/**
 * @file scripts/backfill-guild-id.ts
 * @description Migration multi-tenant, étape 1 : renseigne la colonne
 * `guild_id` (nullable, ajoutée par la migration `add_guild_id_nullable`)
 * sur toutes les lignes existantes des 19 tables métier, avec la valeur de
 * `GUILD_ID` (`.env`) — la seule guilde connue au moment de cette migration.
 *
 * One-off : à exécuter une seule fois par base (dev, puis prod), jamais au
 * démarrage normal du bot. Idempotent (`WHERE guild_id IS NULL`), donc sans
 * risque de le relancer par erreur.
 *
 * Usage : npx tsx scripts/backfill-guild-id.ts
 */
import { prisma } from '../src/db';

/** Nom de table Postgres (voir @@map dans schema.prisma) pour chacune des 19 tables métier concernées par le multi-tenant. */
const TABLES = [
  'settings', 'channels', 'discord_roles', 'items', 'quota_targets', 'salary_rates',
  'stocks', 'coffre_stocks', 'stock_history', 'transactions', 'stats', 'cooldowns',
  'braquages', 'taxes', 'armurerie', 'user_mapping', 'pending_sales', 'vehicules',
  'fourrieres', 'munitions_ventes',
] as const;

async function main(): Promise<void> {
  const guildId = process.env.GUILD_ID;
  if (!guildId) {
    console.error('❌ GUILD_ID manquant dans .env — impossible de backfiller sans savoir à quelle guilde attribuer les lignes existantes.');
    process.exit(1);
  }

  console.log(`Backfill de guild_id = "${guildId}" sur ${TABLES.length} tables...`);
  let total = 0;
  for (const table of TABLES) {
    const affected = await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET guild_id = $1 WHERE guild_id IS NULL`,
      guildId,
    );
    console.log(`  ${table}: ${affected} ligne(s)`);
    total += affected;
  }
  console.log(`✅ Terminé — ${total} ligne(s) mises à jour au total.`);

  const remaining: Array<{ table: string; count: bigint }> = [];
  for (const table of TABLES) {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "${table}" WHERE guild_id IS NULL`,
    );
    if (rows[0].count > 0n) remaining.push({ table, count: rows[0].count });
  }
  if (remaining.length) {
    console.error('❌ Des lignes restent sans guild_id après le backfill :', remaining);
    process.exit(1);
  }
  console.log('✅ Vérifié — plus aucune ligne avec guild_id IS NULL sur les 19 tables.');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
