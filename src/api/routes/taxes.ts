/**
 * @file src/api/routes/taxes.ts
 * @description Lecture seule des taxes — le "back-office web" pour lequel
 * `TAXES_ROLE_ID` (voir `/config role`) a toujours existé sans jamais avoir
 * de consommateur réel jusqu'ici. Monté derrière `requireTaxesAccess` dans
 * server.ts (rôle taxes ou admin), en plus de `requireAuth` (membre du
 * serveur) appliqué à toute l'API.
 *
 * `?type=` accepte, au choix : un type fixe (`sporex`, `heroine`, `vente`,
 * `fertilisant`, `cannabis`, `mexicana`, `cocaine`), le type fictif `zone`
 * qui regroupe TOUTES les zones (une par tier, voir `modules/taxes.ts`), ou
 * la clé d'UNE zone précise (ex. `roxwood_village` — voir
 * `/config channel list` côté Discord, ou `/api/taxes?type=zone` pour lister
 * les zones existantes, n'a pas besoin d'être connue à l'avance).
 */
import { Router } from 'express';
import * as db from '../../db';
import { FIXED_TYPES, ZONE_TYPE_KEYS, isZoneType } from '../../modules/taxes';

const router = Router();

const VALID_TYPES_HINT = `${[...FIXED_TYPES, 'zone'].join(', ')}, ou la clé d'une zone précise (ex. roxwood_village)`;

/** Résout `?type=` : `zone` fictif → toutes les zones, une clé de zone précise → cette zone seule, sinon un type fixe exact — `null` si invalide. */
function resolveTypeFilter(typeParam: string): string[] | null {
  if (typeParam === 'zone') return [...ZONE_TYPE_KEYS];
  if (isZoneType(typeParam)) return [typeParam];
  if ((FIXED_TYPES as readonly string[]).includes(typeParam)) return [typeParam];
  return null;
}

/**
 * GET /api/taxes?type=&status= — liste des taxes, filtrable par type (voir
 * ci-dessus) et par statut (`active`/`expired`, défaut `active` — les taxes
 * expirées mais pas encore renouvelées/supprimées n'apparaissent donc pas
 * sans le demander explicitement).
 */
router.get('/', async (req, res) => {
  let types: string[] | undefined;
  if (req.query.type !== undefined) {
    const resolved = resolveTypeFilter(String(req.query.type));
    if (!resolved) {
      res.status(400).json({ error: `type invalide — attendu : ${VALID_TYPES_HINT}` });
      return;
    }
    types = resolved;
  }

  let expired = false; // défaut : taxes en cours
  if (req.query.status !== undefined) {
    if (req.query.status === 'active') expired = false;
    else if (req.query.status === 'expired') expired = true;
    else {
      res.status(400).json({ error: 'status invalide — attendu : active, expired' });
      return;
    }
  }

  res.json(await db.findTaxes(req.apiUser!.guildId, { types, expired }));
});

/**
 * GET /api/taxes/search?type=&q= — recherche par nom (sous-chaîne,
 * insensible à la casse) DANS un type donné (`type` requis — mêmes valeurs
 * que ci-dessus, `zone` inclus). `q` vide ou omis = toutes les taxes de ce
 * type, actives et expirées confondues (25 max) — même comportement que le
 * modal "Rechercher une taxe" côté Discord.
 */
router.get('/search', async (req, res) => {
  if (req.query.type === undefined) {
    res.status(400).json({ error: `type requis — attendu : ${VALID_TYPES_HINT}` });
    return;
  }
  const types = resolveTypeFilter(String(req.query.type));
  if (!types) {
    res.status(400).json({ error: `type invalide — attendu : ${VALID_TYPES_HINT}` });
    return;
  }

  const query = typeof req.query.q === 'string' ? req.query.q : undefined;
  res.json(await db.findTaxes(req.apiUser!.guildId, { types, query, limit: 25 }));
});

export default router;
