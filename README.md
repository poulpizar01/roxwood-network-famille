# Bot Famille — Bot Discord RP FiveM (illégal), 100% configurable

Bot Discord (TypeScript / discord.js v14 / PostgreSQL via Prisma) pour la gestion d'une organisation RP FiveM illégale : stocks de coffre, quotas hebdomadaires, braquages, cooldowns, taxes & racket, armurerie (armes + munitions), fourrière véhicules, cycle de vente de drogue — plus une API REST optionnelle pour exposer ces données à un outil externe (site web, dashboard…).

Contrairement à un bot figé pour un serveur précis, **toute la structure métier est configurable depuis Discord** via la commande `/config` : items suivis, activités déclarables (quotas, cooldowns, limites de braquage, labos), objectifs de quota, taux de paie, salons, rôles, et le **type d'organisation** (Indépendant/Petite Frappe/Gang/Organisation, `/config type-groupe`) qui fait varier les limites de braquage, les labos accessibles et les taxes/zones de vente sans toucher au code. Aucune de ces valeurs n'est codée en dur — un changement prend effet immédiatement, sans redémarrage (jamais besoin de relancer le bot après une écriture `/config`, voir "Robustesse & fiabilité" plus bas). À l'inverse, certaines valeurs restent volontairement fixes dans le code car elles ne bougent jamais une fois le bot déployé pour une organisation donnée : types d'armes, types de taxe, plafonds de munitions, amende de fourrière (voir "Modules" plus bas).

**Multi-tenant** : un seul déploiement (un process, une base) peut servir plusieurs serveurs Discord à la fois, chacun avec des données totalement étanches — inviter le bot sur un nouveau serveur suffit à l'enregistrer, aucun redéploiement nécessaire. Réutilisable pour n'importe quelle organisation RP illégale sans toucher au code : après avoir invité le bot, tout se configure via `/config`. Voir la section [Plusieurs guildes](#plusieurs-guildes--multi-tenant) pour le détail.

## Sommaire

- [Prérequis](#prérequis) ([Créer l'application Discord](#créer-lapplication-discord))
- [Installation](#installation) ([Via systemd](#via-systemd-production-sans-docker), [Via Docker](#via-docker))
- [Plusieurs guildes — multi-tenant](#plusieurs-guildes--multi-tenant)
- [Interopérabilité — API REST](#interopérabilité--api-rest-optionnelle)
- [Configuration — `/config`](#configuration--tout-se-fait-depuis-discord-via-config)
- [Modules](#modules)
- [Robustesse & fiabilité](#robustesse--fiabilité)
- [Base de données](#base-de-données)
- [Structure des fichiers](#structure-des-fichiers)
- [Dépannage](#dépannage)

---

## Prérequis

- **Node.js** ≥ 18
- **PostgreSQL** ≥ 14 (local, hébergé — Supabase, Neon, Railway, RDS… — ou via Docker, voir plus bas)
- Une application Discord avec un bot configuré (voir juste en dessous) — token, permissions et intents privilégiés.

### Créer l'application Discord

Étape à faire une seule fois, avant toute installation :

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → lui donner un nom.
2. Onglet **Bot** (menu de gauche) :
   - **Reset Token** → copier la valeur, ce sera `TOKEN` dans `.env`. Discord ne la réaffiche plus jamais après — la garder de côté (jamais commitée, voir "Sécurité" dans `CLAUDE.md`).
   - Section **Privileged Gateway Intents**, activer **Server Members Intent** et **Message Content Intent**. **Obligatoire** : le bot lit le contenu des messages de logs coffre et résout les membres du serveur pour l'API — sans ces deux cases cochées, il plante au démarrage avec une erreur `DisallowedIntents`.
   - **Public Bot** : décoché = seul toi peux l'inviter (une seule organisation) ; coché = n'importe qui peut l'inviter sur son propre serveur (voir "Plusieurs guildes" plus bas — chaque serveur s'enregistre tout seul, rien à faire côté bot).
3. Onglet **General Information** : copier l'**Application ID**, ce sera `CLIENT_ID` dans `.env`.
4. Onglet **OAuth2 → URL Generator** :
   - Scopes : cocher `bot` et `applications.commands` (indispensable pour que les commandes `/` apparaissent).
   - Bot Permissions : `Send Messages`, `Embed Links`, `Read Message History`, `View Channels`, `Manage Channels` (renommage des salons "labo" 🔴/🟢).
   - Copier l'URL générée en bas de page — c'est cette même URL qu'on réutilise pour inviter le bot sur chaque serveur (voir "Plusieurs guildes" plus bas), pas besoin d'en régénérer une par organisation.

À la fin de cette étape, on a les deux valeurs `TOKEN`, `CLIENT_ID` nécessaires à `.env`. Chaque serveur qui invite le bot s'enregistre lui-même (voir "Plusieurs guildes").

---

## Installation

```bash
git clone https://github.com/poulpizar01/roxwood-network-famille.git
cd roxwood-network-famille

npm install

cp .env.example .env
# Éditer .env : TOKEN, CLIENT_ID (voir "Créer l'application Discord" ci-dessus), DATABASE_URL

# Applique les migrations existantes à la base PostgreSQL
npx prisma migrate deploy

npm run build
npm start
```

`DATABASE_URL` pointe vers un PostgreSQL déjà accessible : un service hébergé (Supabase, Neon, Railway, RDS…), ou une instance locale sur le VPS lui-même — sur une base Debian/Ubuntu fraîche, par exemple :
```bash
sudo apt install -y postgresql
sudo -u postgres psql -c "CREATE USER roxwood_network_famille WITH PASSWORD 'change_me';"
sudo -u postgres psql -c "CREATE DATABASE roxwood_network_famille OWNER roxwood_network_famille;"
# DATABASE_URL=postgresql://roxwood_network_famille:change_me@localhost:5432/roxwood_network_famille
```

En développement : `npm run dev` (tsx, rechargement à chaud, pas de build).

### Via systemd (production, sans Docker)

Un modèle de service est fourni dans `deploy/roxwood-network-famille.service` — à adapter (chemins, utilisateur système) puis installer :
```bash
sudo cp deploy/roxwood-network-famille.service /etc/systemd/system/
sudo nano /etc/systemd/system/roxwood-network-famille.service   # remplacer les champs REMPLACER_...
sudo systemctl daemon-reload
sudo systemctl enable --now roxwood-network-famille.service
```

Ensuite, pour piloter le service :
```bash
sudo systemctl restart roxwood-network-famille.service
sudo journalctl -u roxwood-network-famille.service -n 50 --no-pager
```
Après toute mise à jour du code : `git pull && npm install && npx prisma migrate deploy && npm run build` (toujours vérifier `npx tsc --noEmit` avant, pour attraper une erreur sans faire planter le service en cours) puis `sudo systemctl restart roxwood-network-famille.service`.

### Via Docker

`docker-compose.yml` fournit le bot **et** PostgreSQL (volume nommé `db_data`, migrations appliquées automatiquement au démarrage du conteneur — voir `docker-entrypoint.sh`).

```bash
cp .env.example .env
# Éditer .env : TOKEN, CLIENT_ID, POSTGRES_PASSWORD
# (DATABASE_URL est recalculé par docker-compose pour pointer vers le service "db" — inutile de l'éditer)

docker compose up -d --build
docker compose logs -f roxwood-network-famille
```
Mise à jour après un `git pull` : `docker compose up -d --build`. Le port `5432` du service `db` est publié sur l'hôte par défaut (pratique pour `prisma studio`/`psql` en local) — à retirer ou restreindre par pare-feu sur un déploiement exposé publiquement.

Les deux services ont une rotation de logs (`max-size: 10m`, `max-file: 3` — sinon le driver `json-file` par défaut grossit indéfiniment sur le disque de l'hôte) ; le service `roxwood-network-famille` a en plus une limite mémoire (`mem_limit: 512m`, large pour un bot Discord + petite API — à ajuster si `docker stats` montre un dépassement). Nommé ainsi (pas juste `bot`) pour rester identifiable sans ambiguïté si un second bot tourne sur le même hôte.

Si `docker compose build` échoue avec `invalid file request` (observé sur Windows + OneDrive avec BuildKit sur ce projet), désactiver BuildKit pour ce build : `set DOCKER_BUILDKIT=0 && docker compose build` (PowerShell : `$env:DOCKER_BUILDKIT=0`).

---

## Plusieurs guildes — multi-tenant

Un seul déploiement (un process, une base Postgres) peut servir **plusieurs serveurs Discord à la fois**, chacun avec ses propres salons, items, quotas, taxes, etc. — totalement étanches d'un serveur à l'autre. Rien à faire côté infra pour ajouter une organisation : inviter le bot sur un nouveau serveur suffit.

### Inviter le bot sur un serveur (le premier, ou un suivant)

1. Générer l'URL d'invitation une seule fois (voir "Créer l'application Discord" ci-dessus, étape OAuth2 → URL Generator).
2. Ouvrir cette URL, choisir le serveur Discord, valider — c'est la **même URL** pour chaque nouveau serveur, pas besoin d'en régénérer une par organisation.
3. Le bot s'enregistre automatiquement (`guildCreate`) : commandes slash déployées sur ce serveur en quelques secondes, panneaux prêts à être mis en place via `/config category set` ou `/config channel set`.

Si le bot était hors ligne au moment de l'invitation, il rattrape au démarrage suivant (boucle sur tous les serveurs dans lesquels il se trouve).

### Ce qui est isolé par serveur

Tout : salons, rôles, items suivis, objectifs de quota, taux de paie, type d'organisation, stocks, taxes, armurerie, ventes, historique. Un même joueur (même ID Discord) peut avoir des quotas/paie totalement différents sur deux serveurs — aucune donnée ne fuite de l'un à l'autre.

### Si le bot quitte un serveur

Retirer le bot d'un serveur ne supprime **jamais** ses données (`guildDelete` marque juste ce serveur comme inactif — plus aucun cron/commande ne s'exécute pour lui). Le réinviter plus tard restaure exactement l'état où on l'avait laissé.

### Site externe par serveur (voir Interopérabilité ci-dessous)

Si l'API REST est activée (`API_PORT`, voir plus bas), chaque serveur configure **son propre** site externe autorisé à s'y connecter — pas une URL globale pour tout le monde :
```
/config site-externe set <url_du_site>
```
Un admin peut aussi consulter (`/config site-externe list`) ou retirer (`/config site-externe remove`) le site configuré pour son serveur.

---

## Interopérabilité — API REST (optionnelle)

Une petite API REST **en lecture seule**, dans le même process que le bot (`src/api/`), permet à un outil externe (ex. un site web) de récupérer les données du bot. **Désactivée par défaut** — n'existe que si `API_PORT` est défini dans `.env` ; sinon aucun port n'est ouvert, comportement inchangé.

### Mise en place

1. Dans le [Discord Developer Portal](https://discord.com/developers/applications), onglet **OAuth2** de l'application du bot : noter le **Client Secret**, et ajouter une **Redirect URI** = `<API_BASE_URL>/auth/callback` (ex. `http://localhost:3001/auth/callback` en dev, l'URL publique réelle en prod).
2. Renseigner dans `.env` : `API_PORT`, `DISCORD_CLIENT_SECRET`, `API_JWT_SECRET` (une longue chaîne aléatoire, à générer une fois), `API_BASE_URL` — voir `.env.example`. Rien à renseigner de plus par site externe : chaque **serveur Discord** configure le sien directement depuis Discord, voir `/config site-externe set` (chapitre "Plusieurs guildes" ci-dessus).
3. Démarrer/redémarrer le bot : `✅ API REST en écoute sur le port <API_PORT>` dans les logs confirme que c'est actif.

### Authentification — connexion via Discord

Pas de clé API statique : l'utilisateur se connecte avec son compte Discord, et l'accès est dérivé de ses rôles sur **le serveur Discord auquel ce site est rattaché** (multi-tenant — un site externe sert toujours un seul serveur à la fois) — les mêmes règles qu'en Discord, pas une logique dupliquée.

1. Le site externe redirige le navigateur vers `<API_BASE_URL>/auth/login?guild=<ID_DU_SERVEUR>` (l'ID du serveur Discord concerné — refusé si ce serveur n'a jamais invité le bot, ou si aucun site n'y est configuré via `/config site-externe`).
2. Après connexion Discord, l'utilisateur revient sur `<url_du_site>#token=<jwt>` (l'URL configurée via `/config site-externe set` PAR CE SERVEUR) — le site récupère ce token côté client (fragment d'URL, jamais envoyé à un serveur) et le stocke.
3. Chaque appel à `/api/*` doit inclure `Authorization: Bearer <jwt>`. Le token expire au bout de 7 jours (pas de refresh token — se reconnecter via `/auth/login`) et reste scopé au serveur choisi à l'étape 1 : impossible de l'utiliser pour lire les données d'un autre serveur.

Deux niveaux d'accès : **membre du serveur Discord** (suffit pour `/api/stocks`, `/api/quotas`, `/api/armurerie`, `/api/ventes`) et **rôle taxes ou admin** (requis en plus pour `/api/taxes` — le rôle `TAXES_ROLE_ID` de `/config role`, jusqu'ici sans utilisateur réel, sert enfin à ça).

### Endpoints disponibles

| Endpoint | Accès | Retourne |
|----------|-------|----------|
| `GET /api/me` | Membre | Identité résolue (id, username, isAdmin, isTaxes) |
| `GET /api/stocks` | Membre | Stock actuel de chaque item suivi, tous coffres confondus |
| `GET /api/stocks/:channelId` | Membre | Stock actuel de chaque item pour UN coffre précis |
| `GET /api/stocks/history?item=&channelId=&limit=` | Membre | Derniers mouvements, filtrables par item et/ou coffre (défaut 20, max 200) |
| `GET /api/quotas?week=` | Membre | Quota (somme par catégorie + détail brut) de tous les joueurs suivis |
| `GET /api/quotas/:userId?week=` | Membre | Quota d'un joueur précis |
| `GET /api/quotas/pay?week=` | Membre | Paie de tous les joueurs suivis, y compris à 0$ |
| `GET /api/quotas/pay/:userId?week=` | Membre | Paie d'un joueur précis |
| `GET /api/quotas/ranking?week=` | Membre | Classement groupe : paie triée décroissante, uniquement > 0$ |
| `GET /api/quotas/summary?week=` | Membre | Bilan groupe : total par activité |
| `GET /api/armurerie?status=` | Membre | Armes, filtrables par statut (`in_stock`/`loaned`/`lost` — sans filtre : tout sauf perdues) |
| `GET /api/armurerie/search?q=` | Membre | Recherche par nom ou référence (sous-chaîne) |
| `GET /api/armurerie/ammo` | Membre | Stock + compteurs hebdomadaires munitions |
| `GET /api/armurerie/ammo/history` | Membre | Ventes de munitions depuis le dernier reset hebdomadaire (dimanche 19h) |
| `GET /api/ventes?week=` | Membre | Total vendu par joueur sur la plage (trié décroissant) + total du groupe |
| `GET /api/ventes/:userId?week=` | Membre | Ventes d'un joueur précis : total + détail par drogue vendue |
| `GET /api/taxes?type=&status=` | Taxes/Admin | Taxes filtrables par type (fixe, `zone` = toutes les zones groupées, ou la clé d'une zone précise) et statut (`active`/`expired`, défaut `active`) |
| `GET /api/taxes/search?type=&q=` | Taxes/Admin | Recherche par nom dans un type donné (`type` requis) |

Lecture seule pour l'instant — pas d'écriture depuis l'extérieur (voir docstring de `src/api/server.ts` pour pourquoi).

### Naviguer sur une semaine passée (`?week=`)

Les 6 endpoints `/api/quotas*` et les 2 endpoints `/api/ventes*` acceptent un paramètre `week` (semaine ISO 8601, ex. `2026-W37`, lundi 00:00 UTC → lundi suivant, résolu par `src/api/week.ts`) — sans ce paramètre, ils portent sur la semaine en cours (depuis le dernier reset hebdomadaire). Reconstruit depuis la table `transactions` (jamais purgée, une ligne par déclaration) plutôt que le cache `stats` (vidé entièrement à chaque reset) — voir les fonctions `*ForRange` dans `modules/quotas.ts` et `getVenteTotalsForRange`/`getVenteDetailForUser` dans `db.ts`. Une vente confirmée écrit une `transaction` (`action: 'vente'`) comme n'importe quelle activité, donc le `total` de `/api/ventes` est toujours identique au `vente` d'un quota pour la même plage — une seule vérité.

**Limite à connaître** : les objectifs (`/config quota`) et taux de paie (`/config salaire`) ne sont **pas historisés** — seule la valeur actuelle existe en base. Une requête sur une semaine passée applique donc les objectifs/taux *actuels* à l'activité de cette semaine-là, pas ceux réellement en vigueur à l'époque si l'admin les a changés depuis (n'affecte pas `/api/ventes`, qui ne dépend d'aucun taux). Si ça devient un problème pour `/api/quotas*`, il faudrait historiser `QuotaTarget`/`SalaryRate` (nouvelle table, logique de résolution "valeur en vigueur à telle date") — pas fait pour l'instant.

### Types de taxe (`?type=`)

Valeurs acceptées : les types fixes (`sporex`, `heroine`, `vente`, `fertilisant`, `cannabis`, `mexicana`, `cocaine`), le type fictif `zone` qui regroupe **toutes** les zones (Petite Frappe en a 6, Gang/Organisation en partagent 18 — voir chapitre Taxes plus bas) sous une seule valeur filtrable, ou la clé d'**une** zone précise (ex. `roxwood_village`) pour ne remonter que celle-là. `type` est requis sur `/search`, optionnel sur la liste (omis = tous types confondus).

---

## Configuration — tout se fait depuis Discord via `/config`

Contrairement à un `config.js` à éditer, **toute la configuration métier vit en base et se pilote avec la commande `/config`**, réservée aux administrateurs Discord natifs (permission `Administrator` — volontairement indépendante du rôle admin configurable, pour éviter un problème d'œuf-et-poule sur un serveur tout juste configuré).

### `/config channel`
Associe un salon Discord à un rôle fonctionnel du bot (`stock_general`, `quotas`, `armurerie`, `taxes`, `admin`, …) ou gère les listes de salons de logs de coffre surveillés — `logs_coffres` (coffres normaux) et `logs_coffres_admin` (coffres admin de l'organisation, marqués 🛡️ dans `historique_stock` ; plusieurs salons possibles pour l'un comme pour l'autre). `set` crée/rafraîchit immédiatement le panneau concerné (stock, armurerie, quotas, taxes) plutôt que d'attendre un événement indirect — pas besoin de redémarrer le bot après coup.
- `/config channel set <role> <#salon>`
- `/config channel add-log-coffre <#salon>` / `remove-log-coffre`
- `/config channel add-log-coffre-admin <#salon>` / `remove-log-coffre-admin`
- `/config channel list`

### `/config category` — création automatique des salons
`/config category set <catégorie>` crée en une fois, dans la catégorie Discord donnée, un salon pour chaque rôle fonctionnel pas encore configuré (nom par défaut dérivé du rôle, ex. `stock`, `armurerie`, `alertes-braquages`), les associe automatiquement, puis rafraîchit les panneaux comme `channel set`. Exclut volontairement les salons alimentés par le bot de jeu FiveM (`logs_garages`, et les logs de coffre gérés séparément via `add-log-coffre`/`add-log-coffre-admin`) : ceux-là doivent pointer vers un salon de logs déjà existant, jamais un salon vide fraîchement créé. Un rôle déjà configuré n'est jamais recréé — ré-exécutable sans risque de doublons.

### `/config role`
Associe un rôle Discord à un usage (`admin` : commandes sensibles ; `taxes` : accès back-office taxes).
- `/config role set <cible> <@rôle>` / `list`

### `/config item`
Items de coffre suivis. **L'orthographe doit correspondre exactement** (accents, casse) à ce qu'écrit le bot de jeu FiveM — tout item absent de cette liste est silencieusement ignoré lors du parsing des logs. C'est la source de bug la plus fréquente sur ce type de bot : avant d'ajouter un item, vérifier l'orthographe exacte dans les logs récents du salon coffre.
- `/config item add <nom> [vente_pnj] [groupe] [stock_general] [labo_lie] [multiplicateur]`
  - `vente_pnj` : déclarable en vente aux PNJ (marché noir) — pas une vente entre joueurs.
  - `groupe` : libellé de regroupement dans le message Stock Général (ex. "Munitions").
  - `stock_general` : afficher dans le message Stock Général (défaut oui — le stock reste suivi même à non).
  - `labo_lie` : ce labo produit cet item ? Exclut alors la vente PNJ pour tout tier ayant ce labo actif (voir `/config type-groupe` ci-dessous).
  - `multiplicateur` : unités de base par unité de cet item dans son `groupe` (défaut 1) — ex. 24 pour une boîte de munitions qui en contient 24, pour que le total du groupe reste exact plutôt que de compter 1 boîte comme 1 balle.
- `/config item remove <nom>` (autocomplete) / `/config item list [filtre]`

Pas d'option pour désigner l'item qui confirme une vente de drogue (voir `/config item list`, badge 🪙) : un seul item joue ce rôle en pratique, fixé en dur (`CONFIRME_VENTE_ITEM` dans `modules/ventes.ts`, "Argent Sale" par défaut — même principe que `MUNITIONS_STOCK_GROUP` pour les munitions dans `armurerie.ts`) plutôt qu'un flag à poser à la main sur chaque item.

Cinq items sont pré-remplis s'ils sont absents (`src/default-items.ts`) : **Munition de pistolet** et **Boîte mun. pistolet** (même `groupe: "Munition de pistolet"`, alimentent ensemble le compteur de l'armurerie — la boîte a `multiplicateur: 24`, voir `/config item` ci-dessous), **Munition de SMG** (simple item de stock, aucun groupe, mais affiché séparément dans l'armurerie via `MUNITIONS_SMG_ITEM`), **Argent Sale** (= `CONFIRME_VENTE_ITEM`, confirme les ventes en attente) et **Argent** (simple item de stock, distinct de l'Argent Sale). Déclenché au démarrage du bot ET à chaque usage de `/config` (pas seulement au tout premier démarrage — un bot déjà en cours d'exécution en profite dès la prochaine commande `/config`). Un item déjà configuré n'est jamais écrasé — ce n'est qu'un point de départ, modifiable/supprimable ensuite comme n'importe quel autre item via `/config item`.

### `/config type-groupe` — type d'organisation
Le déploiement passe par 4 tiers — **Indépendant / Petite Frappe / Gang / Organisation** — qui font varier deux choses sans toucher au code :
- Les limites hebdomadaires de braquage (Fleeca, Armurerie, Bijouterie, Pinebank, Human Labs) : plus le tier est élevé, plus la limite est haute (`0` pour un tier sans accès à l'activité).
- Les labos accessibles (Indépendant : aucun ; Petite Frappe : Héroïne + Sporex ; Gang : Mexicana + Cannabis ; Organisation : Mexicana + Cocaïne) — un labo hors barème du tier disparaît du panneau, et toute drogue liée (`labo_lie`) devient indisponible en vente PNJ mais apparaît dans la section "🧪 Drogue de production" du Stock Général (voir plus bas).
- `/config type-groupe set <tier>` / `list` (affiche le barème complet des 4 tiers)

Tant qu'aucun tier n'a jamais été choisi, le bot se comporte comme `Petite Frappe` par défaut.

### `/config quota`
Objectif hebdomadaire par catégorie de quota (`actions`, `vente`, `recolte`, `labos` — celles utilisées par le registre d'activités décrit dans "Modules" plus bas). C'est la seule partie du système de quotas qui reste pilotable depuis Discord, parce que les objectifs peuvent être renégociés. **Une catégorie sans objectif défini n'apparaît dans aucun affichage de quota** (panneau perso, `/listquota`, paie hebdomadaire) même si des activités lui sont rattachées — seul le détail par activité la montre encore.
- `/config quota set <quota_type> <valeur>` / `remove` / `list`

### `/config salaire`
Taux de paie ($ par unité) par catégorie de quota — mêmes catégories que `/config quota`. **Une catégorie sans taux configuré ne génère aucune paie**, même si des activités lui sont rattachées : "Ma Paie", le classement de groupe et la paie hebdomadaire n'affichent que les catégories ayant un taux.
- `/config salaire set <quota_type> <valeur>` / `remove` / `list`

Exemple : `/config salaire set vente 30` → chaque unité vendue rapporte 30$. On peut faire pareil pour `labos`, `recolte`, etc. — indépendamment des objectifs fixés par `/config quota` (une catégorie peut avoir un objectif sans taux de paie, un taux sans objectif, ou les deux).

### `/config site-externe` — site web autorisé à utiliser l'API REST
Uniquement pertinent si l'API REST est activée (`API_PORT`, voir "Interopérabilité" plus haut). Chaque serveur Discord (guilde) configure le sien indépendamment.
- `/config site-externe set <url>` — autorise ce site (ex. `https://mon-site.exemple.com`) ; l'origine CORS acceptée est dérivée automatiquement de cette URL.
- `/config site-externe remove` — retire le site autorisé (l'API refuse alors toute connexion pour ce serveur).
- `/config site-externe list` — affiche le site actuellement configuré.

---

## Modules

### `src/modules/stocks.ts` — Stocks de coffre
Parse les logs des salons de coffre suivis, met à jour la table `stocks` (total global, celui du panneau Discord) et le message permanent du salon `stock_general`. Met aussi à jour `coffre_stocks`, le détail par coffre (par salon `logs_coffres`) — pas affiché en Discord, exposé uniquement via l'API (voir section Interopérabilité plus haut) ; les deux sont toujours mis à jour ensemble, jamais l'un sans l'autre. Gère le rattrapage au démarrage et un resync complet à la demande (`/sync-stock`). `/config item add`/`remove` rafraîchit ce panneau immédiatement, sans attendre le prochain mouvement de coffre. `/set-stock` et `/historique-stock` utilisent l'autocomplete (la liste d'items peut dépasser la limite de 25 choix Discord). Le Stock Général affiche en plus deux sections dynamiques (dépendantes du tier, voir `/config type-groupe`) : **💊 Drogue à vendre** (total seul, détail via `/drogues-a-vendre`) et **🧪 Drogue de production** (détail par item). Dès qu'un mouvement de coffre (retrait ou dépôt, n'importe quel item) concerne un joueur sans compte Discord mappé, une alerte est postée dans `admin` (voir `/adduser`).

### `src/modules/quotas.ts` — Activités & quotas hebdomadaires
Panneau de boutons **généré dynamiquement** à partir du registre fixe `ACTIVITY_TYPES` (`src/config-store.ts`) : jusqu'à 3 rangées de boutons directs, un menu déroulant de repli au-delà, puis la rangée fixe des vues (mon quota, ma paie, classement, bilan, minuterie). Reset automatique chaque dimanche 19h (bilan + paie envoyés, stats remises à zéro), auto-réparant si le bot était arrêté au moment du cron.

### `src/modules/alertes.ts` — Cooldowns, braquages, statut labo
Notifie l'expiration des cooldowns personnels, publie la disponibilité des slots de braquage, renomme les salons "labo" (🔴/🟢) selon disponibilité — pour toute activité marquée `labo: true` dans le registre `ACTIVITY_TYPES_FIXED` (`config-store.ts`), pas seulement les labos d'origine. Un labo restauré au démarrage (timer en mémoire perdu, date de fin persistée en base) ne touche pas au salon d'un labo devenu indisponible pour le tier courant entre-temps.

### `src/modules/garages.ts` — Fourrière véhicules
Déduit les mises en fourrière à partir des logs du salon garages (aucune mise en fourrière n'est loggée explicitement) : si un véhicule ressort de la fourrière, le dernier joueur à l'avoir sorti sans l'avoir rangé est enregistré comme responsable — un montant fixe (350$, dans le code) est affiché à titre indicatif, sans aucune facturation automatique. Le classement cumulé se consulte à la demande via `/fourrieres` (admin) et reste posté en archive hebdomadaire dans `bilan`.

### `src/modules/taxes.ts` — Taxes & racket
Types fixes avec leur propre bouton, **dépendants du type d'organisation** (`/config type-groupe`, même principe que les labos) : Petite Frappe a `sporex`, `heroine`, `fertilisant` ; Gang a `cannabis` ; Organisation a `mexicana` et `cocaine` — indépendamment de qui produit quoi via les labos (Mexicana est produite par Gang **et** Organisation, mais sa taxe reste réservée à Organisation, décision métier). `vente` est universelle (tous tiers, y compris Indépendant). Plus un bouton **Taxe Zone** qui demande d'abord de choisir une zone avant d'afficher le même formulaire — le nom de la zone est directement stocké comme `type` de la taxe. Petite Frappe a 6 zones (Roxwood Village, Grapeseed Valley, Richman, Cinéma, Hawick, Carson) ; Gang et Organisation partagent les 18 mêmes zones de vente (New Cayo Perico, Paleto, Sandy Shores, Grapeseed, Vinewood, Aéroport, Wardog, Mirror Park, Fête Foraine, Barillo Plage, Del Perro, Roxwood Est, Eclypse Tower, Vespucci, Roxwood Ouest, Terrain de cross, Champ d'éolienne, Cayo Perico) — pas de découpage entre les deux, contrairement aux labos. Indépendant n'a ni taxe fixe ni zone. Une seule taxe active à la fois par type (zones incluses) — une taxe expirée mais pas supprimée ne bloque pas une nouvelle création. Ces types restent codés en dur (contrairement à items/activités/quotas) car chacun a des champs de modal hétérogènes — les rendre dynamiques demanderait un moteur de formulaire générique, hors du périmètre de généralisation de ce projet. Seuls le salon, le rôle d'accès et les échéances sont configurables.

### `src/modules/armurerie.ts` — Armurerie & munitions
Inventaire d'armes individuelles (nom, référence unique, statut `en_stock`/`pretee`/`perdue`). Types d'armes fixes dans le code (constante `ARME_TYPES` en tête de fichier — pas de `/config` dédié, cette liste ne bouge jamais une fois posée), regroupés en 4 catégories (armes de poing, fusils à pompe, armes automatiques, armes lourdes) avec plus de 25 modèles : l'ajout d'une arme passe donc par un modal de recherche avant le select (limite Discord de 25 options). Munitions de pistolet : ligne de stock + deux déclarations indicatives (Fabrication / Vente) avec compteur hebdomadaire — Fabrication a un plafond fixe (5000) dans le code, Vente n'a volontairement aucun plafond (juste le total suivi). Munitions de SMG : juste le stock brut, sans quota de fabrication ni compteur de vente.

Le stock réel de munitions de pistolet affiché en tête du panneau vient des items suivis comme les autres, associés via leur `groupe` à la constante `MUNITIONS_STOCK_GROUP` (`"Munition de pistolet"`, câblée dans `armurerie.ts`) — items pré-remplis automatiquement (voir `/config item` ci-dessus), donc plus besoin d'y penser. Un item d'un groupe peut représenter plusieurs unités de base ("Boîte mun. pistolet" = 24 "Munition de pistolet") via son `multiplicateur` (`/config item add`, défaut 1) : `armurerie.weightedStockSum` pondère chaque item avant de sommer un groupe, aussi bien pour ce total armurerie que pour les sections `STOCK_GROUPS` du Stock Général. Le stock de munitions SMG affiché juste en dessous vient d'un item unique sans groupe (`MUNITIONS_SMG_ITEM`, `"Munition de SMG"`), lu directement (pas de pondération). Le panneau armurerie n'est rafraîchi à chaque mouvement de coffre que si l'item déplacé appartient à l'un de ces deux (voir `stocks.updateStockMessage`) — pas à chaque mouvement, quel qu'il soit, pour éviter des requêtes et des éditions Discord inutiles.

### `src/modules/ventes.ts` — Cycle de vie des ventes de drogue
Un retrait de coffre sur un item marqué `vente_pnj: true` crée une vente en attente et alerte dans le salon `ventes_drogue`. Confirmation automatique dès le dépôt de l'item `CONFIRME_VENTE_ITEM` (fixé en dur dans `ventes.ts`, "Argent Sale" par défaut — fenêtre de 3h), log dans `log_ventes`, mise à jour des stats/quota. `/adduser`, `/removeuser` et `/listusers` gèrent les associations nom en jeu ↔ compte Discord, utilisées ici comme par l'alerte "joueur non mappé" de `stocks.ts`.

---

## Robustesse & fiabilité

- **Aucun redémarrage requis après une écriture `/config`** : chaque sous-commande qui touche un panneau permanent (salon, item, type d'organisation…) rafraîchit explicitement le message concerné dans son propre handler, plutôt que de compter sur le prochain mouvement de coffre ou une déclaration d'activité pour le déclencher indirectement.
- **Reset hebdomadaire auto-réparant** : plutôt que de compter sur un cron qui tombe pile à l'heure, le bot vérifie à chaque démarrage *et* toutes les 15 minutes si le reset attendu (dimanche 19h Europe/Paris) est en retard, et le déclenche si besoin — un redémarrage pendant la fenêtre de reset ne fait pas perdre le cycle.
- **Crash-restart** : le process peut s'arrêter sur un événement `error` non catché du WebSocket Discord (rare, pas un bug applicatif) — un service systemd avec `Restart=` (déjà dans le déploiement documenté plus haut) le relance automatiquement en quelques secondes. En Docker, `restart: unless-stopped` fait pareil.
- **Purge automatique des données opérationnelles obsolètes** : un cron quotidien (4h Europe/Paris) supprime les ventes en attente **terminées** (confirmée/reposée/ignorée/expirée — jamais une vente encore en cours) et les ventes de munitions de plus de 30 jours — pur historique de workflow sans valeur une fois le cycle clos. **`transactions`** (le journal de toute activité déclarée, y compris les ventes confirmées) n'est en revanche **jamais purgée** : c'est ce qui permet à `/api/quotas`/`/api/ventes` de remonter une semaine passée via `?week=` (voir Interopérabilité) — une purge casserait cette navigation.
- **Cron sans chevauchement** : `node-cron` ne protège pas nativement contre une exécution qui démarre alors que la précédente tourne encore. Le cron le plus fréquent (vérification des cooldowns expirés, toutes les minutes) a un verrou en mémoire pour éviter qu'un batch particulièrement long fasse partir un second passage sur les mêmes lignes (ex. double notification).
- **Mémoire** : le cache de messages de discord.js est vidé au bout d'une heure (`sweepers`, sans impact sur les panneaux permanents — toujours re-récupérés par ID, jamais lus depuis ce cache) ; en Docker, `mem_limit: 512m` sur le bot évite qu'une fuite mémoire fasse tomber tout l'hôte plutôt que le seul conteneur (voir "Via Docker").

---

## Base de données

PostgreSQL via [Prisma](https://www.prisma.io/) (`prisma/schema.prisma`, migrations dans `prisma/migrations/`). Voir `npx prisma studio` pour explorer les données, `npx prisma migrate dev` pour créer une nouvelle migration en développement (après une modif de `schema.prisma`), `npx prisma migrate deploy` pour appliquer les migrations existantes (production, ou premier lancement).

**Multi-tenant** : toutes les tables métier ci-dessous ont une colonne `guild_id` qui fait partie de leur clé primaire/unique — chaque ligne appartient à un seul serveur Discord, jamais partagée entre deux. La table `guilds` (voir `src/guild-registry.ts`) est à part : c'est le registre des serveurs connus (actif/inactif, site externe autorisé), pas une table de config métier.

Tables de configuration (pilotées par `/config`) : `channels` (rôle fonctionnel → salon(s)), `discord_roles` (admin/taxes → rôle Discord), `items` (nom, groupe, `vente`/`visibleStock`/`laboLie`), `quota_targets`, `salary_rates`. Le type d'organisation (`/config type-groupe`) est stocké comme un `Setting` scalaire (clé `type_groupe`). Le registre des activités déclarables et les barèmes par tier (braquage, labos) n'ont pas de table — ce sont des constantes fixes dans `src/config-store.ts` (voir plus haut).
Tables métier (génériques) : `stocks` (total global), `coffre_stocks` (détail par coffre, voir section Interopérabilité), `stock_history`, `transactions`, `stats`, `cooldowns`, `braquages`, `taxes`, `armurerie`, `user_mapping`, `pending_sales`, `vehicules`, `fourrieres`, `munitions_ventes`.

---

## Structure des fichiers

```
roxwood-network-famille/
├── src/
│   ├── index.ts               # Point d'entrée, client Discord, routage, cron jobs
│   ├── config-store.ts        # Cache de config en mémoire PAR GUILDE, rechargé par /config
│   ├── guild-registry.ts       # Registre des guildes connues (multi-tenant, voir "Plusieurs guildes")
│   ├── db.ts                   # Couche d'accès Prisma/PostgreSQL (chaque fonction prend un guildId)
│   ├── permissions.ts          # Vérification admin partagée
│   ├── interaction-helpers.ts  # Helpers de réponse partagés (réaction 🗑️, auto-suppression)
│   ├── default-items.ts        # Préremplissage d'items connus (voir CLAUDE.md)
│   ├── modules/
│   │   ├── config.ts       # Commande /config (toute la configuration)
│   │   ├── stocks.ts
│   │   ├── quotas.ts
│   │   ├── alertes.ts
│   │   ├── garages.ts
│   │   ├── taxes.ts
│   │   ├── armurerie.ts
│   │   └── ventes.ts
│   └── api/                    # API REST optionnelle (voir "Interopérabilité")
│       ├── server.ts
│       ├── auth.ts             # Connexion via Discord (OAuth2)
│       ├── week.ts             # Résolution de ?week= (semaine ISO 8601)
│       └── routes/
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── scripts/
│   └── backfill-guild-id.ts    # One-off migration multi-tenant (voir historique du projet)
├── deploy/
│   └── roxwood-network-famille.service  # Modèle de service systemd (voir "Via systemd")
├── Dockerfile
├── docker-compose.yml
├── docker-entrypoint.sh        # Applique les migrations puis démarre le bot (voir "Via Docker")
├── .env / .env.example
├── package.json / tsconfig.json
└── README.md
```

---

## Dépannage

| Problème | Solution |
|----------|----------|
| Erreur `Used disallowed intents` / le bot ne se connecte pas du tout | Les intents privilégiés **Server Members** et **Message Content** ne sont pas activés dans le Developer Portal (onglet Bot) — voir "Créer l'application Discord" |
| Le message permanent n'apparaît pas | Vérifier `/config channel list` et la permission `Send Messages` |
| Les commandes slash ne s'affichent pas sur un serveur | Attendre quelques secondes après l'invitation du bot (déploiement par `guildCreate`), ou vérifier `CLIENT_ID` |
| `/auth/login` refuse la connexion (`?guild= invalide`) | Le bot n'a jamais été invité sur ce serveur, ou aucun site n'y est configuré — voir `/config site-externe set` |
| Un mouvement de coffre est ignoré | L'item n'est probablement pas dans `/config item list`, ou son orthographe (accents/casse) diffère du log FiveM |
| Erreur `Cannot rename channel` | Le bot a besoin de la permission `Manage Channels` sur les salons "labo" |
| Erreur Prisma au démarrage | Vérifier `DATABASE_URL` dans `.env` et que PostgreSQL est accessible ; `npx prisma migrate deploy` |
| `docker compose build` échoue avec `invalid file request` | Bug BuildKit observé sur Windows + OneDrive sur ce projet — désactiver BuildKit : `set DOCKER_BUILDKIT=0 && docker compose build` |
| `could not parse schema engine response` dans le conteneur | OpenSSL manquant dans l'image (déjà installé dans le `Dockerfile` fourni — si modifié, garder `RUN apk add --no-cache openssl`) |
