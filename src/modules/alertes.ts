/**
 * @file src/modules/alertes.ts
 * @description Alertes automatiques : cooldowns personnels expirés, disponibilité
 * des slots de braquage, et statut des salons "labo" (🔴/🟢) — entièrement
 * pilotées par le registre fixe `ACTIVITY_TYPES` (voir src/config-store.ts),
 * pas de valeurs dupliquées ici.
 *
 * Contrainte Discord : les renommages de salon sont limités à 2 toutes les 10
 * minutes par channel. Les vérifications "déjà rouge/vert" et la restauration
 * sans renommage au démarrage (`initLaboTimers`) sont là pour la respecter.
 *
 * Persistence des timers : les `setTimeout` actifs sont en mémoire (perdus au
 * redémarrage) ; la date de fin (`labo_end_<clé>`) est donc persistée en base
 * pour pouvoir les reconstruire (voir `initLaboTimers`).
 */
import { EmbedBuilder, type Client } from 'discord.js';
import * as db from '../db';
import * as configStore from '../config-store';

// ─── COOLDOWNS EXPIRÉS ───────────────────────────────────────────────────────

/**
 * Vérifie les cooldowns expirés non encore notifiés et envoie un rappel au
 * membre concerné dans le salon `alertes_actions`. Appelée périodiquement.
 */
/**
 * Verrou de ré-entrance : ce cron tourne toutes les minutes (voir index.ts)
 * et `node-cron` n'attend pas la fin d'une exécution avant de programmer la
 * suivante — sans ce verrou, un batch de cooldowns expirés qui prend plus
 * d'une minute (beaucoup de notifs + latence API Discord) ferait démarrer un
 * 2ᵉ passage sur les MÊMES lignes pas encore marquées `notified` (le
 * marquage se fait une par une, après l'envoi, dans la boucle ci-dessous) —
 * même membre notifié deux fois pour le même cooldown.
 */
let cooldownCheckRunning = false;

export async function checkExpiredCooldowns(client: Client): Promise<void> {
  if (cooldownCheckRunning) return;
  cooldownCheckRunning = true;
  try {
    const c = configStore.get();
    if (!c.CHANNELS.alertes_actions) return;
    const expired = await db.getExpiredUnnotifiedCooldowns();
    if (!expired.length) return;

    const channel = await client.channels.fetch(c.CHANNELS.alertes_actions).catch(() => null);
    if (!channel || !channel.isSendable()) return;

    for (const row of expired) {
      const rowCfg = c.ACTIVITY_TYPES[row.action];
      const label = rowCfg ? configStore.activityDisplayLabel(rowCfg) : row.action;
      await channel.send({
        content: `<@${row.userId}>`,
        embeds: [
          new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('✅ Cooldown expiré')
            .setDescription(`**${label}** est à nouveau disponible pour toi !`)
            .setTimestamp(),
        ],
      }).catch(() => null);
      await db.markCooldownNotified(row.userId, row.action);
    }
  } catch (err) {
    console.error('[alertes] checkExpiredCooldowns:', (err as Error).message);
  } finally {
    cooldownCheckRunning = false;
  }
}

// ─── ALERTES BRAQUAGES ───────────────────────────────────────────────────────

/**
 * Publie dans `alertes_braquages` la disponibilité des slots pour un type de
 * braquage donné, après qu'un membre en a effectué un. Retourne silencieusement
 * si l'activité n'a pas de limite hebdomadaire configurée.
 */
export async function postBraquageAlert(client: Client, action: string): Promise<void> {
  const c = configStore.get();
  if (!c.CHANNELS.alertes_braquages) return;
  const cfg = c.ACTIVITY_TYPES[action];
  const limit = cfg?.braquageWeeklyLimit;
  if (!limit) return;

  try {
    const channel = await client.channels.fetch(c.CHANNELS.alertes_braquages).catch(() => null);
    if (!channel || !channel.isSendable()) return;

    const used = await db.getBraquageCount(action);
    const remaining = Math.max(0, limit - used);
    const label = configStore.activityDisplayLabel(cfg);

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(remaining > 0 ? 0x57F287 : 0xED4245)
          .setTitle('🔫 Disponibilité Braquages')
          .setDescription(`**${label}** : \`${remaining}/${limit}\` slot${remaining !== 1 ? 's' : ''} disponible${remaining !== 1 ? 's' : ''}`)
          .setTimestamp(),
      ],
    }).catch(() => null);
  } catch (err) {
    console.error('[alertes] postBraquageAlert:', (err as Error).message);
  }
}

// ─── RENOMMAGE SALON LABO ────────────────────────────────────────────────────

/** setTimeout actifs par clé d'activité "labo". Perdus au redémarrage — voir `initLaboTimers`. */
const laboTimers: Record<string, ReturnType<typeof setTimeout>> = {};

/**
 * Nettoie le nom d'un salon Discord en retirant tous les préfixes emoji de
 * statut accumulés (🔴 ou 🟢), y compris chiffres/tirets Discord accumulés
 * après plusieurs renommages successifs.
 */
function stripLaboPrefix(name: string): string {
  let result = name;
  while (/^(\d+[-\s]*)?[🔴🟢]/.test(result)) {
    result = result.replace(/^(\d+[-\s]*)?[🔴🟢][-\s]*/, '');
  }
  return result.trim();
}

/**
 * Met à jour le statut de disponibilité d'un labo (activité avec `labo: true`)
 * en renommant son salon (🟢 disponible / 🔴 indisponible) et en programmant
 * le retour au vert. Le renommage n'est déclenché que si le salon n'a pas déjà
 * le bon préfixe, pour préserver le quota Discord (2 renommages / 10 min).
 */
export async function setLaboStatut(client: Client, laboKey: string, available: boolean, tempsRestantMinutes = 0): Promise<void> {
  const cfg = configStore.get().ACTIVITY_TYPES[laboKey];
  const channelId = cfg?.laboChannelId;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !('setName' in channel) || !channel.name) return;

    const baseName = stripLaboPrefix(channel.name || '');

    if (available) {
      await db.setSetting(`labo_end_${laboKey}`, '0');
      if (!channel.name.startsWith('🟢')) {
        await channel.setName(`🟢 ${baseName}`).catch((err: Error) => console.error('[alertes] rename labo (dispo):', err.message));
      }
    } else {
      const endsAt = tempsRestantMinutes > 0 ? Date.now() + tempsRestantMinutes * 60 * 1000 : 0;
      if (endsAt) await db.setSetting(`labo_end_${laboKey}`, String(endsAt));

      if (!channel.name.startsWith('🔴')) {
        await channel.setName(`🔴 ${baseName}`).catch((err: Error) => console.error('[alertes] rename labo (indispo):', err.message));
      }

      if (laboTimers[laboKey]) clearTimeout(laboTimers[laboKey]);

      if (tempsRestantMinutes > 0) {
        const ms = tempsRestantMinutes * 60 * 1000;
        laboTimers[laboKey] = setTimeout(async () => {
          await setLaboStatut(client, laboKey, true);
          delete laboTimers[laboKey];
        }, ms);
      }
    }
  } catch (err) {
    console.error('[alertes] setLaboStatut:', (err as Error).message);
  }
}

/**
 * Restaure au démarrage les timers de labo en cours avant l'arrêt, pour
 * chaque activité configurée avec `labo: true`, en relisant la date de fin
 * persistée en base (`labo_end_<clé>`). Si absente/dépassée, force le vert ;
 * sinon reprogramme le timer sans renommer immédiatement (économise un slot
 * de rate-limit Discord).
 */
export async function initLaboTimers(client: Client): Promise<void> {
  const activityTypes = configStore.get().ACTIVITY_TYPES;
  for (const [laboKey, cfg] of Object.entries(activityTypes)) {
    // Pas de filtre sur `enabled` ici, volontairement : cette fonction ne
    // fait jamais que ramener au vert (immédiatement ou après le temps
    // restant), jamais l'inverse. Un labo désactivé entre-temps par un
    // changement de tier (voir config-store.ts) alors qu'il tournait encore
    // doit quand même repasser au vert à l'heure prévue — sinon son salon
    // reste bloqué au rouge indéfiniment si le bot redémarre avant
    // l'expiration du timer en mémoire.
    if (!cfg.labo) continue;
    const stored = await db.getSetting(`labo_end_${laboKey}`);
    const endsAt = stored ? parseInt(stored, 10) : 0;
    const remaining = endsAt - Date.now();

    if (!endsAt || remaining <= 0) {
      await setLaboStatut(client, laboKey, true);
    } else {
      if (laboTimers[laboKey]) clearTimeout(laboTimers[laboKey]);
      laboTimers[laboKey] = setTimeout(async () => {
        await setLaboStatut(client, laboKey, true);
        delete laboTimers[laboKey];
      }, remaining);
    }
  }
}
