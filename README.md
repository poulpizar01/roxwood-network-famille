# Bot Famille — Bot Discord RP FiveM (illégal), 100% configurable

Bot Discord (TypeScript / discord.js v14 / PostgreSQL via Prisma) pour la gestion d'une organisation RP FiveM illégale : stocks de coffre, quotas hebdomadaires, braquages, cooldowns, taxes & racket, armurerie (armes + munitions), fourrière véhicules, cycle de vente de drogue, synchronisation optionnelle vers un site web.

Contrairement à un bot figé pour un serveur précis, **toute la structure métier est configurable depuis Discord** via la commande `/config` : items suivis, activités déclarables (quotas, cooldowns, limites de braquage, labos), objectifs de quota, types d'armes, salons, rôles, salaire, plafonds de munitions, amende de fourrière. Aucune de ces valeurs n'est codée en dur — un changement prend effet immédiatement, sans redémarrage.

Le bot reste **mono-serveur** (un déploiement = un serveur Discord), mais devient réutilisable pour n'importe quelle organisation RP illégale sans toucher au code : après avoir invité le bot, tout se configure via `/config`.

---

## Prérequis

- **Node.js** ≥ 18
- **PostgreSQL** ≥ 14 (local ou hébergé — Supabase, Neon, Railway, RDS…)
- Un bot Discord avec les permissions :
  - `Send Messages`, `Embed Links`, `Read Message History`
  - `Manage Channels` (renommage des salons "labo" selon disponibilité)
  - `View Channel` sur tous les salons surveillés

---

## Installation

```bash
git clone <url-de-ce-repo>
cd bot-famille

npm install

cp .env.example .env
# Éditer .env : TOKEN, CLIENT_ID, GUILD_ID, DATABASE_URL

# Crée les tables dans la base PostgreSQL
npx prisma migrate dev --name init

npm run build
npm start
```

En développement : `npm run dev` (tsx, rechargement à chaud, pas de build).

En production, le bot peut tourner via un service systemd :
```bash
sudo systemctl restart bot-famille.service
sudo journalctl -u bot-famille.service -n 50 --no-pager
```
Après toute mise à jour du code : `npm run build` (ou `git pull && npm install && npx prisma migrate deploy && npm run build`) puis redémarrage du service.

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
- `/config item add <nom> [vente] [paiement] [groupe]` — `vente` = déclarable en vente de drogue, `paiement` = compte comme règlement d'une vente, `groupe` = libellé de regroupement dans le message de stock (ex. "Drogue à vendre").
- `/config item remove <nom>` (autocomplete) / `/config item list [filtre]`

### `/config activite`
Registre des activités déclarables dans le panneau de quotas : chaque activité définit son libellé, sa catégorie de quota, un cooldown personnel optionnel, une limite hebdomadaire partagée (braquage), un mode "labo" (minuterie + renommage de salon 🔴/🟢), et un champ quantité optionnel.
- `/config activite add <cle> <label> [quota_type] [cooldown_heures] [partenaires] [limite_braquage] [labo_salon] [quantite] [sans_bouton]`
- `/config activite remove <cle>` (autocomplete) / `/config activite list`

Un joueur progresse dans la catégorie de quota `quota_type` d'une activité à chaque déclaration — c'est cette option qui décide entièrement quelles activités comptent dans quel quota, pas une règle cachée dans le code. `sans_bouton` sert aux activités créditées par un autre module plutôt que par un bouton du panneau (ex. `vente`, créditée automatiquement par le cycle de vente).

### `/config quota`
Objectif hebdomadaire par catégorie de quota (les catégories sont celles utilisées par `/config activite`, par exemple `vente`, `labos`, `actions`, `recolte` — libres, ce sont juste des exemples). **Une catégorie sans objectif défini n'apparaît dans aucun affichage de quota** (panneau perso, `/listquota`, paie hebdomadaire) même si des activités lui sont rattachées — seul le détail par activité la montre encore.
- `/config quota set <quota_type> <valeur>` / `remove` / `list`

### `/config arme`
Types d'armes proposés dans l'armurerie.
- `/config arme add <cle> <label>` / `remove` (autocomplete) / `list`

### `/config salaire`, `/config munitions`, `/config fourriere`
Scalaires : salaire ($) par unité de drogue vendue, plafonds indicatifs hebdomadaires de munitions (fabrication/vente), amende ($) par mise en fourrière.

---

## Modules

### `src/modules/stocks.ts` — Stocks de coffre
Parse les logs des salons de coffre suivis, met à jour la table `stocks` et le message permanent du salon `stock_general`. Gère le rattrapage au démarrage et un resync complet à la demande (`/sync-stock`). `/set-stock` et `/historique-stock` utilisent l'autocomplete (la liste d'items peut dépasser la limite de 25 choix Discord).

### `src/modules/quotas.ts` — Activités & quotas hebdomadaires
Panneau de boutons **généré dynamiquement** à partir des activités configurées (`/config activite`) : jusqu'à 3 rangées de boutons directs, un menu déroulant de repli au-delà, puis la rangée fixe des vues (mon quota, ma paie, classement, bilan, minuterie). Reset automatique chaque dimanche 19h (bilan + paie envoyés, stats remises à zéro), auto-réparant si le bot était arrêté au moment du cron.

### `src/modules/alertes.ts` — Cooldowns, braquages, statut labo
Notifie l'expiration des cooldowns personnels, publie la disponibilité des slots de braquage, renomme les salons "labo" (🔴/🟢) selon disponibilité — pour toute activité configurée avec `labo_salon`, pas seulement les labos d'origine.

### `src/modules/garages.ts` — Fourrière véhicules
Déduit les mises en fourrière à partir des logs du salon garages (aucune mise en fourrière n'est loggée explicitement) : si un véhicule ressort de la fourrière, le dernier joueur à l'avoir sorti sans l'avoir rangé est facturé (montant configurable via `/config fourriere`).

### `src/modules/taxes.ts` — Taxes & racket
Types fixes avec leur propre bouton : `sporex`, `heroine`, `vente`, `fertilisant`. Plus un bouton **Taxe Zone** qui demande d'abord de choisir une zone (Roxwood Village, Grapeseed Valley, Richman, Cinéma, Hawick, Carson) avant d'afficher le même formulaire — le nom de la zone est directement stocké comme `type` de la taxe (une seule taxe active par zone à la fois). Ces types restent codés en dur (contrairement à items/activités/quotas) car chacun a des champs de modal hétérogènes — les rendre dynamiques demanderait un moteur de formulaire générique, hors du périmètre de généralisation de ce projet. Seuls le salon, le rôle d'accès et les échéances sont configurables.

### `src/modules/armurerie.ts` — Armurerie & munitions
Inventaire d'armes individuelles (nom, référence unique, statut `en_stock`/`pretee`/`perdue`), types configurables via `/config arme`. Munitions : ligne de stock + deux déclarations indicatives (Fabrication / Vente) avec compteur hebdomadaire, plafonds configurables via `/config munitions`.

### `src/modules/ventes.ts` — Cycle de vie des ventes de drogue
Un retrait de coffre sur un item marqué `vente: true` crée une vente en attente et alerte dans le salon `ventes_drogue`. Confirmation automatique dès le dépôt d'un item marqué `paiement: true` (fenêtre de 3h), log dans `log_ventes`, mise à jour des stats/quota.

---

## Base de données

PostgreSQL via [Prisma](https://www.prisma.io/) (`prisma/schema.prisma`). Voir `npx prisma studio` pour explorer les données, `npx prisma migrate dev` pour appliquer une évolution de schéma en développement, `npx prisma migrate deploy` en production.

Tables de configuration (pilotées par `/config`) : `channels` (rôle fonctionnel → salon(s)), `discord_roles` (admin/taxes → rôle Discord), `items`, `activity_types`, `quota_targets`, `arme_types`, et `settings` pour les scalaires isolés (salaire, plafonds munitions, amende fourrière).
Tables métier (génériques) : `stocks`, `stock_history`, `transactions`, `stats`, `cooldowns`, `braquages`, `taxes`, `armurerie`, `user_mapping`, `pending_sales`, `vehicules`, `fourrieres`, `munitions_ventes`.

---

## Structure des fichiers

```
bot-famille/
├── src/
│   ├── index.ts           # Point d'entrée, client Discord, routage, cron jobs
│   ├── config-store.ts    # Cache de config en mémoire, rechargé par /config
│   ├── db.ts               # Couche d'accès Prisma/PostgreSQL
│   ├── permissions.ts      # Vérification admin partagée
│   └── modules/
│       ├── config.ts       # Commande /config (toute la configuration)
│       ├── stocks.ts
│       ├── quotas.ts
│       ├── alertes.ts
│       ├── garages.ts
│       ├── taxes.ts
│       ├── armurerie.ts
│       └── ventes.ts
├── prisma/schema.prisma
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
