/**
 * @file src/modules/sync-supabase.ts
 * @description Synchronisation optionnelle bot → site web externe (Supabase), en
 * lecture seule côté bot. Copie toutes les 5 minutes : stocks, stats, mapping
 * joueurs (avec accès back-office), armurerie, taxes (hors champs sensibles),
 * historique de coffre, braquages (7j), cooldowns actifs, ventes (7j), bilans
 * hebdomadaires archivés, et éventuellement les annonces d'un salon Discord.
 *
 * Se désactive silencieusement si `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` sont
 * absents du `.env`. Le schéma de tables `bot_*` attendu côté Supabase est
 * spécifique au site web consommateur — à adapter selon votre propre site,
 * ce module ne fait qu'illustrer le pattern de synchronisation.
 */
import { PermissionFlagsBits, type Client } from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const INTERVALLE_MS = 5 * 60 * 1000;

async function requete(methode: string, table: string, filtre: string, corps?: unknown): Promise<void> {
  const url = `${URL_BASE}/rest/v1/${table}${filtre ? `?${filtre}` : ''}`;
  const res = await fetch(url, {
    method: methode,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (!res.ok) throw new Error(`${methode} ${table} — HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function remplacer(table: string, filtreDeleteTout: string, lignes: unknown[]): Promise<void> {
  await requete('DELETE', table, filtreDeleteTout);
  for (let i = 0; i < lignes.length; i += 500) {
    await requete('POST', table, '', lignes.slice(i, i + 500));
  }
}

async function upsert(table: string, colonnesConflit: string, lignes: unknown[]): Promise<void> {
  if (!lignes.length) return;
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?on_conflict=${colonnesConflit}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(lignes),
  });
  if (!res.ok) throw new Error(`UPSERT ${table} — HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

let discordClient: Client | null = null;

/** Accès back-office du site pour un compte Discord : admin complet, ou taxes uniquement. */
async function getAccesBackOffice(discordId: string): Promise<{ is_admin: boolean; is_taxes_manager: boolean }> {
  if (!discordClient) return { is_admin: false, is_taxes_manager: false };
  try {
    const c = configStore.get();
    const guild = discordClient.guilds.cache.first();
    const member = guild ? await guild.members.fetch(discordId).catch(() => null) : null;
    if (!member) return { is_admin: false, is_taxes_manager: false };
    return {
      is_admin: !!(member.permissions.has(PermissionFlagsBits.Administrator) || (c.ADMIN_ROLE_ID && member.roles.cache.has(c.ADMIN_ROLE_ID))),
      is_taxes_manager: !!(c.TAXES_ROLE_ID && member.roles.cache.has(c.TAXES_ROLE_ID)),
    };
  } catch {
    return { is_admin: false, is_taxes_manager: false };
  }
}

async function syncAll(): Promise<void> {
  if (!URL_BASE || !KEY) {
    console.warn('[sync-supabase] SUPABASE_URL / SUPABASE_SERVICE_KEY absents du .env — synchronisation désactivée.');
    return;
  }
  try {
    const c = configStore.get();
    const stocks = await db.getAllStocks();
    const stats = await db.getAllStatsRows();
    const mappingBrute = await db.getAllUserMappings();
    const mapping = await Promise.all(mappingBrute.map(async m => ({
      game_name: m.gameName, discord_id: m.discordId, ...(await getAccesBackOffice(m.discordId)),
    })));
    const armurerie = (await db.getAllArmes()).map(a => ({ id: a.id, nom: a.nom, reference: a.reference, statut: a.statut, pretee_a: a.preteeA }));
    const taxes = (await db.getAllTaxes()).map(t => ({
      id: t.id, nom: t.nom, type: t.type, echeance: new Date(t.echeance).toISOString(), actif: t.actif, paye: t.paye,
    }));

    const stockHistory = (await db.getRecentStockHistory(null, 300)).map(r => ({
      id: r.id, ts: new Date(r.timestamp).toISOString(), joueur: r.joueur, action: r.action,
      item: r.item, quantite: r.quantite, stock_avant: r.stockAvant, stock_apres: r.stockApres,
    }));

    const depuis7j = Date.now() - 7 * 24 * 3600 * 1000;
    const braquages = (await db.getRecentBraquages(depuis7j)).map(r => ({ id: r.id, user_id: r.user_id, action: r.action, ts: new Date(r.timestamp).toISOString() }));

    const cooldowns = (await db.getActiveCooldowns()).map(r => ({ user_id: r.userId, action: r.action, expires_at: new Date(r.expires_at).toISOString() }));

    const ventes = (await db.getRecentPendingSales(depuis7j)).map(r => ({
      id: r.id, joueur: r.joueur, discord_id: r.discordId, item: r.item, quantite: r.quantite,
      ts: new Date(r.timestamp).toISOString(), statut: r.statut, montant: r.montant,
      prix_pochon: r.prixPochon, confirmed: r.confirmed,
    }));

    // Bilan hebdomadaire ARCHIVÉ (semaine du bot : dimanche 19h → dimanche 19h).
    const ref = new Date(Date.now() - 19 * 3600 * 1000);
    ref.setHours(0, 0, 0, 0);
    ref.setDate(ref.getDate() - ref.getDay());
    const semaine = ref.toISOString().slice(0, 10);
    const parJoueur: Record<string, { semaine: string; user_id: string; ventes: number; recolte: number; activites: number; points: number }> = {};
    for (const s of stats) {
      const j = (parJoueur[s.userId] ??= { semaine, user_id: s.userId, ventes: 0, recolte: 0, activites: 0, points: 0 });
      if (s.action === 'vente') j.ventes += s.count || 0;
      else if (s.action === 'recolte') j.recolte += s.count || 0;
      else j.activites += s.count || 0;
      j.points += s.points || 0;
    }
    const bilans = Object.values(parJoueur);

    const meta = [
      { key: 'last_sync', value: new Date().toISOString() },
      { key: 'quotas', value: JSON.stringify(c.QUOTA_TARGETS) },
      { key: 'salaire_par_vente', value: String(c.SALAIRE_PAR_VENTE) },
    ];

    await remplacer('bot_stocks', 'item=neq.__aucun__', stocks);
    await remplacer('bot_stats', 'user_id=neq.__aucun__', stats.map(s => ({ user_id: s.userId, action: s.action, count: s.count, points: s.points })));
    await remplacer('bot_user_mapping', 'discord_id=neq.__aucun__', mapping);
    await remplacer('bot_armurerie', 'id=gte.0', armurerie);
    await remplacer('bot_taxes', 'id=gte.0', taxes);
    await remplacer('bot_stock_history', 'id=gte.0', stockHistory);
    await remplacer('bot_braquages', 'id=gte.0', braquages);
    await remplacer('bot_cooldowns', 'user_id=neq.__aucun__', cooldowns);
    await remplacer('bot_ventes', 'id=gte.0', ventes);
    await upsert('bot_bilans', 'semaine,user_id', bilans);
    await remplacer('bot_meta', 'key=neq.__aucun__', meta);

    console.log(`[sync-supabase] OK — ${stocks.length} stocks, ${stats.length} stats, ${armurerie.length} armes, ${taxes.length} taxes, ${stockHistory.length} mouvements, ${braquages.length} braquages, ${cooldowns.length} cooldowns, ${ventes.length} ventes, ${bilans.length} bilans (${semaine}).`);
  } catch (e) {
    console.error('[sync-supabase] Échec :', (e as Error).message);
  }
}

async function syncAnnonces(): Promise<void> {
  if (!discordClient || !URL_BASE || !KEY) return;
  const chId = process.env.ANNONCES_CHANNEL_ID || '';
  if (!chId) return;
  try {
    const ch = await discordClient.channels.fetch(chId);
    if (!ch?.isTextBased()) return;
    const msgs = await ch.messages.fetch({ limit: 10 });
    const rows = [...msgs.values()]
      .filter(m => m.content?.trim())
      .map(m => ({
        id: m.id,
        auteur: m.member?.displayName || m.author.username,
        texte: m.content.slice(0, 500),
        ts: m.createdAt.toISOString(),
      }));
    await remplacer('bot_annonces', 'id=neq.__aucun__', rows);
  } catch (e) {
    console.error('[sync-supabase] annonces :', (e as Error).message);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Démarre la synchronisation périodique. Passer le client Discord active aussi les annonces. */
export function start(client?: Client): void {
  if (timer) return;
  discordClient = client || null;
  void syncAll();
  void syncAnnonces();
  timer = setInterval(() => { void syncAll(); void syncAnnonces(); }, INTERVALLE_MS);
  console.log('[sync-supabase] Synchronisation vers le site démarrée (toutes les 5 min).');
}
