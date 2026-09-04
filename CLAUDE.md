# Contexte projet — Bot Famille (bot Discord RP FiveM générique)

Notes de conventions et de pièges pour un agent Claude Code reprenant ce projet (ou un projet similaire : bot Discord + FiveM RP + PostgreSQL/Prisma + TypeScript).

## Stack & déploiement

- TypeScript (compilé en CommonJS via `tsc`, pas d'ESM), discord.js v14, Prisma/PostgreSQL, `node-cron`, `dotenv`.
- `npm run dev` (tsx, à chaud) en développement ; `npm run build && npm start` en production.
- Process géré par systemd de préférence (pas de PM2/Docker imposé) :
  - Après un déploiement : `git pull && npm install && npx prisma migrate deploy && npm run build && sudo systemctl restart bot-famille.service`
  - Logs : `sudo journalctl -u bot-famille.service -n 50 --no-pager`
  - Toujours `npx tsc --noEmit` avant de redémarrer, pour attraper les erreurs de type/syntaxe sans faire planter le service.
- Le langage de toutes les interactions Discord (embeds, messages, boutons) et de la conversation avec l'utilisateur est le **français**.

## Le modèle de configuration — piège n°1 : orthographe des items FiveM

Toute la configuration métier (items, activités, quotas, salons, rôles…) vit en base et se pilote via `/config` (voir `src/modules/config.ts`), **jamais** dans un fichier de code. `config-store.ts` maintient un cache en mémoire rechargé par `configStore.reload()` à chaque écriture `/config` — toujours utiliser `configStore.get()` (jamais mettre son résultat en cache dans une variable de module chargée une seule fois, sinon les changements de config ne seraient visibles qu'après redémarrage).

`/config item add <nom>` doit correspondre **exactement** (accents, casse) à ce qu'écrit le bot de jeu FiveM dans les logs de coffre. Tout item absent de la liste est **silencieusement ignoré** — pas d'erreur, pas de warning, juste des mouvements de stock qui n'apparaissent jamais. C'est la source de bug la plus fréquente sur ce type de projet.

**Ne jamais deviner/renommer un nom d'item sans vérification.** Avant tout ajout, aller lire les vrais logs récents du salon coffre concerné pour confirmer l'orthographe exacte utilisée en jeu (voir « Scripts d'investigation » ci-dessous).

## Portée de la généralisation (décisions de conception)

- **Configurables via `/config`** : items, activités déclarables (quotas/cooldowns/limites de braquage/labos), objectifs de quota, types d'armes, salons, rôles, salaire, plafonds munitions, amende fourrière.
- **Restent fixes dans le code** : les 4 types de taxe (`roxwood`/`sporex`/`vente`/`fertilisant`), car chacun a des champs de modal hétérogènes (Roxwood a téléphone+mot de passe, les autres non) — les rendre dynamiques demanderait un moteur de formulaire générique. Seuls salon/rôle/échéances sont configurables pour les taxes.
- **Le rappel de quota du dimanche** (`quotas.checkQuotaReminder`) reste spécifique à la catégorie de quota `vente` (couplé au cycle de vente de drogue) — pas de règle non-arbitraire pour généraliser à "n'importe quelle catégorie".
- Le bot reste **mono-serveur** (un déploiement = un serveur Discord) mais réutilisable pour n'importe quelle organisation RP illégale sans toucher au code, via `/config`.

Avant de "generaliser encore plus" une de ces zones volontairement fixes, vérifier avec l'utilisateur que ça vaut la complexité ajoutée (moteur de formulaire générique, etc.).

## Scripts d'investigation & de correction ponctuelle

Pattern établi pour toute opération ad hoc (backfill, vérification de logs, correction manuelle de données) :

1. Écrire un script TS autonome à la racine ou dans `scripts/`, préfixé `_` (ex. `_check-logs.ts`) — jamais dans `src/modules/`.
2. Il importe `./src/db`, `./src/config-store` (avec `await configStore.reload()` avant tout usage), et si besoin un client Discord (`new Client({...}); await client.login(...)`).
3. Vérifier avec `npx tsc --noEmit`, puis exécuter avec `npx tsx script.ts`.
4. **Toujours supprimer le script après usage** — jamais de résidu dans le repo (déjà exclu par `.gitignore` : `_*.ts`).
5. Pour scanner un salon complet, paginer avec `channel.messages.fetch({ limit: 100, before })`, tant que `batch.size === 100`. Un scan complet peut prendre plusieurs minutes → lancer en tâche de fond plutôt que bloquer.
6. Un message peut contenir plusieurs embeds : toujours `msg.embeds.flatMap/map(e => e.description)`, jamais juste `embeds[0]`.

**Ne jamais modifier des données réelles (stock, taxes, stats…) sans confirmation explicite de l'utilisateur.** Une « analyse » ou un mot comme « ponctuel » signifie lecture seule.

## Rafraîchir un message permanent après une correction manuelle en base

Chaque module avec un message permanent (stock, quotas, armurerie, taxes) expose une fonction de refresh (`updateStockMessage`, `initPermanentMessage`/`updatePermanentMessage`…). Après une correction directe en base via un script `_*.ts`, toujours appeler cette fonction dans un mini-script avec client Discord pour que le message affiché reflète le changement immédiatement.

## Discord : limites à connaître

- **25 choix max** sur un `.addChoices()` de slash command → passer en `.setAutocomplete(true)` + handler `interactionCreate` (`isAutocomplete()`) dès que la liste peut dépasser 25 (ex. items, activités, types d'armes).
- **25 options max** sur un `StringSelectMenuBuilder` → pattern « modal de recherche avant select » (armurerie, taxes) : demander un texte de recherche optionnel, filtrer, puis afficher le select avec au plus 25 résultats.
- **5 boutons max par `ActionRow`, 5 rows max par message** → le panneau de quotas (`quotas.ts`, `buildButtonRows`) gère ça dynamiquement : jusqu'à 3 rangées de boutons directs (15 activités), un menu déroulant de repli au-delà (`act_more_select`, 25 de plus), puis la rangée fixe des vues. Si `/config activite` dépasse ces capacités (40 activités avec bouton), les activités en trop n'apparaissent plus dans le panneau — un `console.warn` le signale.
- Un renommage de salon est limité à 2 fois / 10 min / salon (statut labo 🔴/🟢, voir `alertes.ts`).
- Éditer un message (`msg.edit`) remplace entièrement ses `components` — pas besoin de « reconstruire » le message pour qu'un changement de couleur de bouton soit pris en compte.

## Robustesse

- Le process peut planter sur un événement `error` non catché du WebSocket Discord — un service systemd avec `Restart=` relance automatiquement en quelques secondes. Ce n'est pas un bug de code, vérifier `journalctl` avant de chercher plus loin.
- Pattern de reset hebdomadaire auto-réparant : au lieu de compter sur un cron qui tombe pile à l'heure, vérifier à chaque démarrage **et** toutes les 15 min si le reset attendu (dimanche 19h Europe/Paris) est en retard, et le déclencher si oui (`quotas.checkWeeklyReset`). Évite de perdre un reset si le bot était down au moment du cron.
- Identifier un message applicatif (rappel, message permanent) par le **titre de son embed**, pas seulement par un ID stocké en base — évite une course entre `channel.send()` qui résout et l'écriture en base qui suit.

## Sécurité / secrets

- `.env` (TOKEN, DATABASE_URL) ne doit **jamais** être committé (déjà dans `.gitignore`).
- `/config` est toujours réservée à la permission Discord native `Administrator`, indépendamment du rôle `ADMIN_ROLE_ID` configurable — évite un problème d'œuf-et-poule sur un serveur fraîchement configuré (voir docstring en tête de `src/modules/config.ts`).

## Conventions de code

- Pas de commentaires « ce que fait le code » (les noms suffisent) — seulement le « pourquoi » quand c'est non évident (contrainte Discord, incident passé, choix métier).
- Chaque module expose `initPermanentMessage`/`updatePermanentMessage`, `handleButton`, `handleModal`, `handleSelect`, `getCommands()` selon ses besoins ; le routage des `customId` se fait par préfixe dans `src/index.ts`.
- Toutes les fonctions de `src/db.ts` sont **asynchrones** (Prisma) et acceptent/retournent des nombres pour les timestamps (millisecondes epoch) — la conversion vers/depuis `Date` (colonnes `TIMESTAMPTZ`) se fait uniquement à l'intérieur de `db.ts`, jamais dans les modules métier.
- Toute nouvelle table/fonction de compteur « indicatif » (ex. munitions fabrication/vente) réutilise le pattern : timestamp automatique, somme filtrée par `>= last_weekly_reset` pour un total « cette semaine » qui se remet à zéro tout seul, sans job de reset dédié.
