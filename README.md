# Bot Famille — Bot Discord RP FiveM (illégal), 100% configurable

Bot Discord (TypeScript / discord.js v14 / PostgreSQL via Prisma) pour la gestion d'une organisation RP FiveM illégale : stocks de coffre, quotas hebdomadaires, braquages, cooldowns, taxes & racket, armurerie (armes + munitions), fourrière véhicules, cycle de vente de drogue.

Contrairement à un bot figé pour un serveur précis, **toute la structure métier est configurable depuis Discord** via la commande `/config` : items suivis, activités déclarables (quotas, cooldowns, limites de braquage, labos), objectifs de quota, taux de paie, salons, rôles, et le **type d'organisation** (Indépendant/Petite Frappe/Gang/Organisation, `/config type-groupe`) qui fait varier les limites de braquage et les labos accessibles sans toucher au code. Aucune de ces valeurs n'est codée en dur — un changement prend effet immédiatement, sans redémarrage. À l'inverse, certaines valeurs restent volontairement fixes dans le code car elles ne bougent jamais une fois le bot déployé pour une organisation donnée : types d'armes, types de taxe, plafonds de munitions, amende de fourrière (voir "Modules" plus bas).

Le bot reste **mono-serveur** (un déploiement = un serveur Discord), mais devient réutilisable pour n'importe quelle organisation RP illégale sans toucher au code : après avoir invité le bot, tout se configure via `/config`.

---

## Prérequis

- **Node.js** ≥ 18
- **PostgreSQL** ≥ 14 (local, hébergé — Supabase, Neon, Railway, RDS… — ou via Docker, voir plus bas)
- Un bot Discord avec les permissions :
  - `Send Messages`, `Embed Links`, `Read Message History`
  - `Manage Channels` (renommage des salons "labo" selon disponibilité)
  - `View Channel` sur tous les salons surveillés

---

## Installation

```bash
git clone https://github.com/poulpizar01/roxwood-network-famille.git
cd roxwood-network-famille

npm install

cp .env.example .env
# Éditer .env : TOKEN, CLIENT_ID, GUILD_ID, DATABASE_URL

# Applique les migrations existantes à la base PostgreSQL
npx prisma migrate deploy

npm run build
npm start
```

En développement : `npm run dev` (tsx, rechargement à chaud, pas de build).

En production, le bot peut tourner via un service systemd :
```bash
sudo systemctl restart roxwood-network-famille.service
sudo journalctl -u roxwood-network-famille.service -n 50 --no-pager
```
Après toute mise à jour du code : `git pull && npm install && npx prisma migrate deploy && npm run build` puis redémarrage du service.

### Via Docker

`docker-compose.yml` fournit le bot **et** PostgreSQL (volume nommé `db_data`, migrations appliquées automatiquement au démarrage du conteneur — voir `docker-entrypoint.sh`).

```bash
cp .env.example .env
# Éditer .env : TOKEN, CLIENT_ID, GUILD_ID, POSTGRES_PASSWORD
# (DATABASE_URL est recalculé par docker-compose pour pointer vers le service "db" — inutile de l'éditer)

docker compose up -d --build
docker compose logs -f bot
```
Mise à jour après un `git pull` : `docker compose up -d --build`. Le port `5432` du service `db` est publié sur l'hôte par défaut (pratique pour `prisma studio`/`psql` en local) — à retirer ou restreindre par pare-feu sur un déploiement exposé publiquement.

Si `docker compose build` échoue avec `invalid file request` (observé sur Windows + OneDrive avec BuildKit sur ce projet), désactiver BuildKit pour ce build : `set DOCKER_BUILDKIT=0 && docker compose build` (PowerShell : `$env:DOCKER_BUILDKIT=0`).

---

## Configuration — tout se fait depuis Discord via `/config`

Contrairement à un `config.js` à éditer, **toute la configuration métier vit en base et se pilote avec la commande `/config`**, réservée aux administrateurs Discord natifs (permission `Administrator` — volontairement indépendante du rôle admin configurable, pour éviter un problème d'œuf-et-poule sur un serveur tout juste configuré).

### `/config channel`
Associe un salon Discord à un rôle fonctionnel du bot (`stock_general`, `quotas`, `armurerie`, `taxes`, `admin`, …) ou gère la liste des salons de logs de coffre surveillés.
- `/config channel set <role> <#salon>`
- `/config channel add-log-coffre <#salon>` / `remove-log-coffre`
- `/config channel list`

### `/config role`
Associe un rôle Discord à un usage (`admin` : commandes sensibles ; `taxes` : accès back-office taxes).
- `/config role set <cible> <@rôle>` / `list`

### `/config item`
Items de coffre suivis. **L'orthographe doit correspondre exactement** (accents, casse) à ce qu'écrit le bot de jeu FiveM — tout item absent de cette liste est silencieusement ignoré lors du parsing des logs. C'est la source de bug la plus fréquente sur ce type de bot : avant d'ajouter un item, vérifier l'orthographe exacte dans les logs récents du salon coffre.
- `/config item add <nom> [vente_pnj] [paiement] [groupe] [stock_general] [labo_lie]`
  - `vente_pnj` : déclarable en vente aux PNJ (marché noir) — pas une vente entre joueurs.
  - `paiement` : un dépôt de cet item confirme automatiquement une vente en attente.
  - `groupe` : libellé de regroupement dans le message Stock Général (ex. "Munitions").
  - `stock_general` : afficher dans le message Stock Général (défaut oui — le stock reste suivi même à non).
  - `labo_lie` : ce labo produit cet item ? Exclut alors la vente PNJ pour tout tier ayant ce labo actif (voir `/config type-groupe` ci-dessous).
- `/config item remove <nom>` (autocomplete) / `/config item list [filtre]`

### `/config type-groupe` — type d'organisation
Le déploiement passe par 4 tiers — **Indépendant / Petite Frappe / Gang / Organisation** — qui font varier deux choses sans toucher au code :
- Les limites hebdomadaires de braquage (Fleeca, Armurerie, Bijouterie, Pinebank, Human Labs) : plus le tier est élevé, plus la limite est haute (`0` pour un tier sans accès à l'activité).
- Les labos accessibles (Indépendant : aucun ; Petite Frappe : Héroïne + Sporex ; Gang : Mexicana + Cannabis ; Organisation : Mexicana + Cocaïne) — un labo hors barème du tier disparaît du panneau, et toute drogue liée (`labo_lie`) devient indisponible en vente PNJ mais apparaît dans la section "🧪 Drogue de production" du Stock Général (voir plus bas).
- `/config type-groupe set <tier>` / `list` (affiche le barème complet des 4 tiers)

Tant qu'aucun tier n'a jamais été choisi, le bot se comporte comme `Petite Frappe` par défaut.

### `/config quota`
Objectif hebdomadaire par catégorie de quota (`actions`, `vente`, `recolte`, `labos` — celles utilisées par le registre d'activités ci-dessus). C'est la seule partie du système de quotas qui reste pilotable depuis Discord, parce que les objectifs peuvent être renégociés. **Une catégorie sans objectif défini n'apparaît dans aucun affichage de quota** (panneau perso, `/listquota`, paie hebdomadaire) même si des activités lui sont rattachées — seul le détail par activité la montre encore.
- `/config quota set <quota_type> <valeur>` / `remove` / `list`

### `/config salaire`
Taux de paie ($ par unité) par catégorie de quota — mêmes catégories que `/config quota`. **Une catégorie sans taux configuré ne génère aucune paie**, même si des activités lui sont rattachées : "Ma Paie", le classement de groupe et la paie hebdomadaire n'affichent que les catégories ayant un taux.
- `/config salaire set <quota_type> <valeur>` / `remove` / `list`

Exemple : `/config salaire set vente 30` → chaque unité vendue rapporte 30$. On peut faire pareil pour `labos`, `recolte`, etc. — indépendamment des objectifs fixés par `/config quota` (une catégorie peut avoir un objectif sans taux de paie, un taux sans objectif, ou les deux).

---

## Modules

### `src/modules/stocks.ts` — Stocks de coffre
Parse les logs des salons de coffre suivis, met à jour la table `stocks` et le message permanent du salon `stock_general`. Gère le rattrapage au démarrage et un resync complet à la demande (`/sync-stock`). `/set-stock` et `/historique-stock` utilisent l'autocomplete (la liste d'items peut dépasser la limite de 25 choix Discord). Le Stock Général affiche en plus deux sections dynamiques (dépendantes du tier, voir `/config type-groupe`) : **💊 Drogue à vendre** (total seul, détail via `/drogues-a-vendre`) et **🧪 Drogue de production** (détail par item). Dès qu'un mouvement de coffre (retrait ou dépôt, n'importe quel item) concerne un joueur sans compte Discord mappé, une alerte est postée dans `admin` (voir `/adduser`).

### `src/modules/quotas.ts` — Activités & quotas hebdomadaires
Panneau de boutons **généré dynamiquement** à partir du registre fixe `ACTIVITY_TYPES` (`src/config-store.ts`) : jusqu'à 3 rangées de boutons directs, un menu déroulant de repli au-delà, puis la rangée fixe des vues (mon quota, ma paie, classement, bilan, minuterie). Reset automatique chaque dimanche 19h (bilan + paie envoyés, stats remises à zéro), auto-réparant si le bot était arrêté au moment du cron.

### `src/modules/alertes.ts` — Cooldowns, braquages, statut labo
Notifie l'expiration des cooldowns personnels, publie la disponibilité des slots de braquage, renomme les salons "labo" (🔴/🟢) selon disponibilité — pour toute activité configurée avec `labo_salon`, pas seulement les labos d'origine.

### `src/modules/garages.ts` — Fourrière véhicules
Déduit les mises en fourrière à partir des logs du salon garages (aucune mise en fourrière n'est loggée explicitement) : si un véhicule ressort de la fourrière, le dernier joueur à l'avoir sorti sans l'avoir rangé est enregistré comme responsable — un montant fixe (350$, dans le code) est affiché à titre indicatif, sans aucune facturation automatique. Le classement cumulé se consulte à la demande via `/fourrieres` (admin) et reste posté en archive hebdomadaire dans `bilan`.

### `src/modules/taxes.ts` — Taxes & racket
Types fixes avec leur propre bouton, **dépendants du type d'organisation** (`/config type-groupe`, même principe que les labos) : Petite Frappe a `sporex`, `heroine`, `fertilisant` ; Gang a `cannabis` ; Organisation a `mexicana` et `cocaine` — indépendamment de qui produit quoi via les labos (Mexicana est produite par Gang **et** Organisation, mais sa taxe reste réservée à Organisation, décision métier). `vente` est universelle (tous tiers, y compris Indépendant). Plus un bouton **Taxe Zone** qui demande d'abord de choisir une zone avant d'afficher le même formulaire — le nom de la zone est directement stocké comme `type` de la taxe. Petite Frappe a 6 zones (Roxwood Village, Grapeseed Valley, Richman, Cinéma, Hawick, Carson) ; Gang et Organisation partagent les 18 mêmes zones de vente (New Cayo Perico, Paleto, Sandy Shores, Grapeseed, Vinewood, Aéroport, Wardog, Mirror Park, Fête Foraine, Barillo Plage, Del Perro, Roxwood Est, Eclypse Tower, Vespucci, Roxwood Ouest, Terrain de cross, Champ d'éolienne, Cayo Perico) — pas de découpage entre les deux, contrairement aux labos. Indépendant n'a ni taxe fixe ni zone. Une seule taxe active à la fois par type (zones incluses) — une taxe expirée mais pas supprimée ne bloque pas une nouvelle création. Ces types restent codés en dur (contrairement à items/activités/quotas) car chacun a des champs de modal hétérogènes — les rendre dynamiques demanderait un moteur de formulaire générique, hors du périmètre de généralisation de ce projet. Seuls le salon, le rôle d'accès et les échéances sont configurables.

### `src/modules/armurerie.ts` — Armurerie & munitions
Inventaire d'armes individuelles (nom, référence unique, statut `en_stock`/`pretee`/`perdue`). Types d'armes fixes dans le code (constante `ARME_TYPES` en tête de fichier — pas de `/config` dédié, cette liste ne bouge jamais une fois posée), regroupés en 4 catégories (armes de poing, fusils à pompe, armes automatiques, armes lourdes) avec plus de 25 modèles : l'ajout d'une arme passe donc par un modal de recherche avant le select (limite Discord de 25 options). Munitions : ligne de stock + deux déclarations indicatives (Fabrication / Vente) avec compteur hebdomadaire — Fabrication a un plafond fixe (5000) dans le code, Vente n'a volontairement aucun plafond (juste le total suivi).

Le stock réel de munitions affiché en tête du panneau vient d'un item suivi comme les autres — il faut l'ajouter via `/config item add nom:"<nom exact des logs FiveM>" groupe:"Munitions de pistolet"` (le libellé de groupe doit correspondre exactement à cette chaîne, câblée dans `armurerie.ts`). Sans cet item configuré, le panneau affiche `0` en stock, silencieusement.

### `src/modules/ventes.ts` — Cycle de vie des ventes de drogue
Un retrait de coffre sur un item marqué `vente_pnj: true` crée une vente en attente et alerte dans le salon `ventes_drogue`. Confirmation automatique dès le dépôt d'un item marqué `paiement: true` (fenêtre de 3h), log dans `log_ventes`, mise à jour des stats/quota. `/adduser`, `/removeuser` et `/listusers` gèrent les associations nom en jeu ↔ compte Discord, utilisées ici comme par l'alerte "joueur non mappé" de `stocks.ts`.

---

## Base de données

PostgreSQL via [Prisma](https://www.prisma.io/) (`prisma/schema.prisma`, migrations dans `prisma/migrations/`). Voir `npx prisma studio` pour explorer les données, `npx prisma migrate dev` pour créer une nouvelle migration en développement (après une modif de `schema.prisma`), `npx prisma migrate deploy` pour appliquer les migrations existantes (production, ou premier lancement).

Tables de configuration (pilotées par `/config`) : `channels` (rôle fonctionnel → salon(s)), `discord_roles` (admin/taxes → rôle Discord), `items` (nom, groupe, `vente`/`ventePaiement`/`visibleStock`/`laboLie`), `quota_targets`, `salary_rates`. Le type d'organisation (`/config type-groupe`) est stocké comme un `Setting` scalaire (clé `type_groupe`). Le registre des activités déclarables et les barèmes par tier (braquage, labos) n'ont pas de table — ce sont des constantes fixes dans `src/config-store.ts` (voir plus haut).
Tables métier (génériques) : `stocks`, `stock_history`, `transactions`, `stats`, `cooldowns`, `braquages`, `taxes`, `armurerie`, `user_mapping`, `pending_sales`, `vehicules`, `fourrieres`, `munitions_ventes`.

---

## Structure des fichiers

```
roxwood-network-famille/
├── src/
│   ├── index.ts               # Point d'entrée, client Discord, routage, cron jobs
│   ├── config-store.ts        # Cache de config en mémoire, rechargé par /config
│   ├── db.ts                   # Couche d'accès Prisma/PostgreSQL
│   ├── permissions.ts          # Vérification admin partagée
│   ├── interaction-helpers.ts  # Helpers de réponse partagés (réaction 🗑️, auto-suppression)
│   └── modules/
│       ├── config.ts       # Commande /config (toute la configuration)
│       ├── stocks.ts
│       ├── quotas.ts
│       ├── alertes.ts
│       ├── garages.ts
│       ├── taxes.ts
│       ├── armurerie.ts
│       └── ventes.ts
├── prisma/
│   ├── schema.prisma
│   └── migrations/
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
| Le message permanent n'apparaît pas | Vérifier `/config channel list` et la permission `Send Messages` |
| Les commandes slash ne s'affichent pas | Attendre ~1 min après le démarrage, ou vérifier `CLIENT_ID`/`GUILD_ID` |
| Un mouvement de coffre est ignoré | L'item n'est probablement pas dans `/config item list`, ou son orthographe (accents/casse) diffère du log FiveM |
| Erreur `Cannot rename channel` | Le bot a besoin de la permission `Manage Channels` sur les salons "labo" |
| Erreur Prisma au démarrage | Vérifier `DATABASE_URL` dans `.env` et que PostgreSQL est accessible ; `npx prisma migrate deploy` |
| `docker compose build` échoue avec `invalid file request` | Bug BuildKit observé sur Windows + OneDrive sur ce projet — désactiver BuildKit : `set DOCKER_BUILDKIT=0 && docker compose build` |
| `could not parse schema engine response` dans le conteneur | OpenSSL manquant dans l'image (déjà installé dans le `Dockerfile` fourni — si modifié, garder `RUN apk add --no-cache openssl`) |
