/**
 * @file src/api/server.ts
 * @description API REST en lecture seule pour un outil externe (ex. un site
 * web qui affiche les données du bot) — dans le même process que le bot
 * Discord (cohérent avec l'archi mono-serveur du projet, pas de service
 * supplémentaire à déployer), mais **multi-tenant** : une seule instance sert
 * les sites externes de plusieurs guildes à la fois. Authentification par
 * connexion Discord (voir auth.ts) : chaque route sous `/api` exige un
 * membre de LA guilde portée par le JWT (`req.apiUser.guildId`, résolu au
 * login via `?guild=`) — voir `requireAuth`.
 * L'appartenance et les rôles sont revérifiés à chaque requête via le client
 * du bot (d'où `requireAuth(client)`), pas seulement au login — un retrait
 * de rôle ou une expulsion prend effet immédiatement, pas 7 jours plus tard.
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
import rateLimit from 'express-rate-limit';
import type { Client } from 'discord.js';
import { assertAuthEnv, handleLogin, handleCallback, requireAuth } from './auth';
import { prisma } from '../db';
import * as guildRegistry from '../guild-registry';
import stocksRouter from './routes/stocks';
import quotasRouter from './routes/quotas';
import taxesRouter from './routes/taxes';
import armurerieRouter from './routes/armurerie';
import ventesRouter from './routes/ventes';
import usersRouter from './routes/users';
import garagesRouter from './routes/garages';

/** Démarre l'API REST. N'a d'effet que si `API_PORT` est défini dans `.env` — absent = API désactivée, déploiement existant inchangé. */
export function startApiServer(client: Client): void {
  if (!process.env.API_PORT) {
    console.log('[api] API_PORT non défini — API REST désactivée.');
    return;
  }
  assertAuthEnv();
  const API_PORT = Number(process.env.API_PORT) || 3001;

  const app = express();
  // `1` = un seul saut de confiance (le reverse proxy HTTPS en frontal sur la
  // même machine, voir README section API REST) : Express lit `req.ip` depuis
  // `X-Forwarded-For` posé par CE proxy plutôt que l'adresse de connexion TCP
  // brute (celle du proxy pour TOUTES les requêtes). Sans ça, express-rate-limit
  // (voir plus bas) bucket sur une seule IP partagée par tous les visiteurs —
  // dégradation silencieuse, pas d'erreur. `1`, pas `true` : `true` ferait
  // confiance à un `X-Forwarded-For` fourni par n'importe quel client direct
  // si jamais `<API_PORT>` était accidentellement exposé malgré la consigne
  // pare-feu du README.
  app.set('trust proxy', 1);
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

  // Ping DB léger en plus de la vivacité du process — un supervisor externe
  // (uptime monitor) doit voir un `/health` en échec si Postgres est
  // injoignable, pas un `{ok:true}` qui ne reflète que "Express répond".
  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // Par IP, pas par guilde (le JWT n'existe pas encore à ce stade). Une
  // limite dédiée et plus stricte sur /auth/login, séparée de l'API : pas de
  // brute-force utile ici (même message d'erreur guilde inconnue/inactive),
  // mais évite un DoS applicatif par répétition de requêtes.
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
  // Par guilde, APRÈS requireAuth (le JWT, donc `req.apiUser.guildId`, n'existe
  // qu'à partir de là) — en plus de `apiLimiter` (par IP, avant requireAuth,
  // première ligne de défense contre un abus non authentifié). Plusieurs
  // sites externes de guildes différentes peuvent partager la même IP
  // sortante (même reverse proxy) : sans ce second palier, ils partageraient
  // aussi le même quota `apiLimiter`, et un tenant très actif épuiserait
  // celui des autres.
  const guildLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.apiUser!.guildId,
  });

  app.get('/auth/login', authLimiter, handleLogin);
  app.get('/auth/callback', authLimiter, handleCallback(client));

  const api = express.Router();
  api.use(apiLimiter);
  api.use(requireAuth(client));
  api.use(guildLimiter);
  api.get('/me', (req, res) => res.json(req.apiUser));
  api.use('/users', usersRouter);
  api.use('/stocks', stocksRouter);
  api.use('/quotas', quotasRouter);
  api.use('/taxes', taxesRouter);
  api.use('/armurerie', armurerieRouter);
  api.use('/ventes', ventesRouter);
  api.use('/garages', garagesRouter);
  app.use('/api', api);

  // Signature à 4 paramètres obligatoire : Express reconnaît un middleware
  // d'erreur par son arité, même si _req/_next ne sont pas utilisés ici.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[api] Erreur non gérée :', err.message);
    res.status(500).json({ error: 'Erreur interne.' });
  });

  // Loopback par défaut : le reverse proxy HTTPS tourne sur la même machine
  // (voir deploy/nginx-roxwood-network-famille.conf). En Docker, l'interface
  // du conteneur n'est pas le loopback de l'hôte : docker-compose.yml passe
  // `API_HOST=0.0.0.0` et restreint lui-même la publication du port à
  // 127.0.0.1 côté hôte.
  const API_HOST = process.env.API_HOST || '127.0.0.1';

  // Express 5 transmet l'erreur d'écoute (port déjà pris…) à ce callback —
  // seule l'API est alors indisponible, le bot Discord continue.
  app.listen(API_PORT, API_HOST, (err?: Error) => {
    if (err) {
      console.error(`❌ API REST indisponible (${API_HOST}:${API_PORT}) :`, err.message);
      return;
    }
    console.log(`✅ API REST en écoute sur ${API_HOST}:${API_PORT}`);
  });
}
