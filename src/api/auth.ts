/**
 * @file src/api/auth.ts
 * @description Connexion via Discord (OAuth2 « Authorization Code ») pour
 * l'API en lecture seule (voir src/api/server.ts) : un outil externe (ex. un
 * site web) redirige l'utilisateur vers `/auth/login?guild=<guildId>`, qui le
 * renvoie vers Discord, qui renvoie vers `/auth/callback` avec un `code`. On
 * échange ce code contre l'identité Discord de l'utilisateur (scope
 * `identify` uniquement — pas besoin de `guilds.members.read`), puis on
 * résout ses rôles via LE CLIENT DU BOT lui-même (`client.guilds.cache` /
 * `member.roles`) plutôt qu'un second aller-retour à l'API Discord : ça
 * réutilise `permissions.isAdmin()` telle quelle, donc les mêmes règles
 * qu'en Discord (permission `Administrator` native OU `ADMIN_ROLE_ID`), pas
 * une logique dupliquée et potentiellement divergente.
 *
 * **Multi-tenant** : un site externe est toujours lié à UNE guilde précise
 * (`?guild=` sur `/auth/login`). Ce `guildId` est porté par le paramètre
 * `state` OAuth (déjà utilisé comme anti-CSRF) jusqu'à `/auth/callback`, qui
 * vérifie que la guilde est connue (`guild-registry.ts`) avant de résoudre
 * quoi que ce soit — un JWT n'est donc jamais signé pour une guilde qui n'a
 * jamais invité le bot. Le résultat (identité + rôles + `guildId`) est signé
 * dans un JWT (voir {@link API_TOKEN_TTL}) et renvoyé au site externe via un
 * fragment d'URL (`${frontendUrl}#token=...`, propre à cette guilde — voir
 * `Guild.frontendUrl`) — jamais en query string (finirait dans des logs de
 * serveur) ni en cookie (le site externe n'est pas censé être sur le même
 * domaine que cette API).
 *
 * Aucune écriture ici : l'API entière est en lecture seule pour l'instant
 * (voir docstring de server.ts) — ce module ne fait qu'authentifier.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import type { Client } from 'discord.js';
import * as configStore from '../config-store';
import * as guildRegistry from '../guild-registry';
import { isAdmin } from '../permissions';

const API_JWT_SECRET = process.env.API_JWT_SECRET;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const API_BASE_URL = process.env.API_BASE_URL;

/** Durée de validité d'un token émis — l'utilisateur doit se reconnecter via Discord après ça (pas de refresh token : simplicité, API en lecture seule). */
const API_TOKEN_TTL = '7d';

/** Nom du cookie court-terme (anti-CSRF) posé par `/auth/login`, vérifié puis effacé par `/auth/callback`. */
const STATE_COOKIE = 'oauth_state';

export interface ApiUser {
  id: string;
  username: string;
  isAdmin: boolean;
  isTaxes: boolean;
  /** Guilde à laquelle ce token donne accès — chaque route API doit filtrer ses requêtes `db.*` par CETTE valeur, jamais une autre (voir src/api/routes/*.ts). */
  guildId: string;
}

declare global {
  namespace Express {
    interface Request {
      apiUser?: ApiUser;
    }
  }
}

/** Lit un cookie précis depuis l'en-tête `Cookie` brut — pas besoin du paquet `cookie-parser` pour un seul cookie court-terme. */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Vérifie au démarrage que les variables d'environnement requises par l'auth API sont présentes — échoue vite et clairement plutôt que silencieusement au premier login. `FRONTEND_URL` n'en fait plus partie : c'est un réglage PAR GUILDE (`Guild.frontendUrl`, voir `/config`), plus une variable d'env globale. */
export function assertAuthEnv(): void {
  const missing = ['API_JWT_SECRET', 'DISCORD_CLIENT_SECRET', 'API_BASE_URL']
    .filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`[api/auth] Variable(s) d'environnement manquante(s) : ${missing.join(', ')} (voir .env.example)`);
  }
}

/**
 * Démarre le flux OAuth2 Discord pour la guilde donnée en `?guild=` : pose un
 * cookie anti-CSRF court-terme, porte le `guildId` dans le paramètre `state`
 * (un snowflake Discord ne contient jamais de `.`, découpage sans ambiguïté
 * dans `handleCallback`), puis redirige vers Discord.
 */
export async function handleLogin(req: Request, res: Response): Promise<void> {
  const guildId = req.query.guild as string | undefined;
  if (!guildId || !(await guildRegistry.isKnownGuild(guildId))) {
    res.status(400).send('Paramètre ?guild= manquant ou invalide — cette guilde n\'a jamais invité le bot.');
    return;
  }

  const csrf = crypto.randomBytes(16).toString('hex');
  const state = `${csrf}.${guildId}`;
  res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: API_BASE_URL!.startsWith('https'), maxAge: 5 * 60 * 1000 });

  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.searchParams.set('client_id', process.env.CLIENT_ID!);
  url.searchParams.set('redirect_uri', `${API_BASE_URL}/auth/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
}

/**
 * Retour de Discord après connexion : échange le `code`, identifie
 * l'utilisateur, résout ses rôles via le client du bot pour LA GUILDE portée
 * par `state` (pas de guilde/pas membre = refusé), signe un JWT scopé à
 * cette guilde, puis redirige vers son site externe (`Guild.frontendUrl`)
 * avec ce token en fragment d'URL.
 */
export function handleCallback(client: Client): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    const stateParam = req.query.state as string | undefined;
    const stateCookie = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE);

    if (!stateParam || !stateCookie || stateParam !== stateCookie) {
      res.status(400).send('État OAuth invalide ou expiré — relance la connexion.');
      return;
    }

    const dotIndex = stateParam.indexOf('.');
    const guildId = dotIndex >= 0 ? stateParam.slice(dotIndex + 1) : '';
    if (!guildId || !(await guildRegistry.isKnownGuild(guildId))) {
      res.status(400).send('Guilde invalide ou plus active — relance la connexion depuis le site.');
      return;
    }

    const authCode = req.query.code as string | undefined;
    if (!authCode) {
      res.status(400).send('Code OAuth manquant.');
      return;
    }

    try {
      const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.CLIENT_ID!,
          client_secret: DISCORD_CLIENT_SECRET!,
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: `${API_BASE_URL}/auth/callback`,
        }),
        // Sans timeout, un Discord qui traîne laisse la requête /auth/callback
        // pendue indéfiniment côté navigateur (fetch/undici attend par défaut
        // bien au-delà de ce qui est raisonnable pour un flux de connexion).
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenResp.ok) {
        res.status(502).send('Échange du code OAuth refusé par Discord.');
        return;
      }
      const { access_token } = await tokenResp.json() as { access_token: string };

      const meResp = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!meResp.ok) {
        res.status(502).send('Impossible de récupérer ton identité Discord.');
        return;
      }
      const me = await meResp.json() as { id: string; username: string };

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        res.status(503).send('Le bot Discord n\'est pas encore prêt sur cette guilde — réessaie dans quelques secondes.');
        return;
      }
      const member = await guild.members.fetch(me.id).catch(() => null);
      if (!member) {
        res.status(403).send('Tu n\'es pas membre du serveur Discord de cette organisation.');
        return;
      }

      const admin = isAdmin(guildId, member);
      const taxesRoleId = configStore.get(guildId).TAXES_ROLE_ID;
      const taxes = admin || (!!taxesRoleId && member.roles.cache.has(taxesRoleId));

      const user: ApiUser = { id: me.id, username: me.username, isAdmin: admin, isTaxes: taxes, guildId };
      const token = jwt.sign(user, API_JWT_SECRET!, { expiresIn: API_TOKEN_TTL });

      const frontendUrl = await guildRegistry.getGuildFrontendUrl(guildId);
      if (!frontendUrl) {
        res.status(500).send('Aucun site externe configuré pour cette guilde (voir /config site-externe).');
        return;
      }
      res.redirect(`${frontendUrl}#token=${encodeURIComponent(token)}`);
    } catch (err) {
      console.error('[api/auth] handleCallback:', (err as Error).message);
      res.status(500).send('Erreur interne pendant la connexion.');
    }
  };
}

/** Middleware : exige un JWT valide (`Authorization: Bearer <token>`), attache l'utilisateur résolu (guilde incluse) à `req.apiUser`. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) {
    res.status(401).json({ error: 'Authentification requise (voir /auth/login).' });
    return;
  }
  try {
    req.apiUser = jwt.verify(token, API_JWT_SECRET!) as ApiUser;
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré — reconnecte-toi via /auth/login.' });
  }
}

/** Middleware à chaîner après `requireAuth` : exige en plus l'accès "taxes" (rôle `TAXES_ROLE_ID` ou admin — même règle que `isAdmin()` partout ailleurs dans le bot). */
export function requireTaxesAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.apiUser?.isTaxes) {
    res.status(403).json({ error: 'Accès réservé au rôle taxes (ou admin).' });
    return;
  }
  next();
}
