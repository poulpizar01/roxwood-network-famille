/**
 * @file src/api/server.ts
 * @description API REST en lecture seule pour un outil externe (ex. un site
 * web qui affiche les données du bot) — dans le même process que le bot
 * Discord (cohérent avec l'archi mono-serveur du projet, pas de service
 * supplémentaire à déployer), mais **multi-tenant** : une seule instance sert
 * les sites externes de plusieurs guildes à la fois. Authentification par
 * connexion Discord (voir auth.ts) : chaque route sous `/api` exige un
 * membre de LA guilde portée par le JWT (`req.apiUser.guildId`, résolu au
 * login via `?guild=`), et `/api/taxes` exige en plus le rôle taxes (ou
 * admin) de cette guilde — voir `requireAuth`/`requireTaxesAccess`.
 *
 * Le CORS est décidé sur "cet `Origin` correspond-il au site d'AU MOINS une
 * guilde active connue" (voir `guild-registry.isKnownCorsOrigin`) — grossier
 * par nature, pas par guilde précise : au moment du preflight CORS, le JWT
 * (qui porte le `guildId`) n'existe pas encore. La vraie isolation des
 * données se fait ensuite, à chaque requête, via `req.apiUser.guildId`
 * injecté dans chaque appel `db.*` des fichiers de `src/api/routes/` — un
 * site qui n'est membre d'aucune guilde active ne peut de toute façon jamais
 * obtenir de JWT valide, CORS ou pas.
 *
 * Lecture seule pour l'instant, volontairement : écrire depuis l'extérieur
 * (ex. marquer une taxe payée depuis le web) demanderait de dupliquer ici la
 * validation déjà faite côté Discord (unicité par type, formulaires...) —
 * à envisager plus tard si un vrai besoin se présente, pas par anticipation.
 *
 * Démarré depuis `index.ts` une fois le bot connecté (`clientReady`) : les
 * routes de données n'ont besoin que de la base (déjà prête après
 * `configStore.reload()`/`guildRegistry.warmCorsCache()`), mais
 * `/auth/callback` a besoin du client Discord pour résoudre les rôles de
 * l'utilisateur qui se connecte.
 */
import express from 'express';
import cors from 'cors';
import type { Client } from 'discord.js';
import { assertAuthEnv, handleLogin, handleCallback, requireAuth, requireTaxesAccess } from './auth';
import * as guildRegistry from '../guild-registry';
import stocksRouter from './routes/stocks';
import quotasRouter from './routes/quotas';
import taxesRouter from './routes/taxes';
import armurerieRouter from './routes/armurerie';
import ventesRouter from './routes/ventes';

/** Démarre l'API REST. N'a d'effet que si `API_PORT` est défini dans `.env` — absent = API désactivée, déploiement existant inchangé. */
export function startApiServer(client: Client): void {
  if (!process.env.API_PORT) {
    console.log('[api] API_PORT non défini — API REST désactivée.');
    return;
  }
  assertAuthEnv();
  const API_PORT = Number(process.env.API_PORT) || 3001;

  const app = express();
  // Origine acceptée si elle correspond au site d'au moins une guilde active
  // connue (voir docstring de fichier) — pas de credentials (le JWT voyage en
  // en-tête Authorization, jamais en cookie cross-site).
  app.use(cors({
    origin(origin, callback) {
      if (!origin || guildRegistry.isKnownCorsOrigin(origin)) callback(null, true);
      else callback(null, false);
    },
    credentials: false,
  }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/auth/login', handleLogin);
  app.get('/auth/callback', handleCallback(client));

  const api = express.Router();
  api.use(requireAuth);
  api.get('/me', (req, res) => res.json(req.apiUser));
  api.use('/stocks', stocksRouter);
  api.use('/quotas', quotasRouter);
  api.use('/taxes', requireTaxesAccess, taxesRouter);
  api.use('/armurerie', armurerieRouter);
  api.use('/ventes', ventesRouter);
  app.use('/api', api);

  // Signature à 4 paramètres obligatoire : Express reconnaît un middleware
  // d'erreur par son arité, même si _req/_next ne sont pas utilisés ici.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[api] Erreur non gérée :', err.message);
    res.status(500).json({ error: 'Erreur interne.' });
  });

  app.listen(API_PORT, () => {
    console.log(`✅ API REST en écoute sur le port ${API_PORT}`);
  });
}
