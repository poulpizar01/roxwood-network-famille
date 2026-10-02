# Prompts d'audit

Une revue généraliste (« est-ce prêt pour la prod ? ») trouve surtout un type de problème et passe à côté des autres. Ces prompts découpent l'audit en **angles indépendants**, à lancer séparément (une conversation ou un agent par angle) avant une mise en prod, après une grosse fonctionnalité, ou périodiquement.

Chaque prompt se colle tel quel dans Claude Code à la racine du projet. Le format de sortie commun permet de comparer et de fusionner les rapports.

## Format de sortie commun

À ajouter à la fin de chaque prompt :

```
Lis CLAUDE.md avant de commencer : les règles qui y figurent sont des décisions déjà prises, ne les remets pas en cause et ne signale pas comme défaut un comportement qui y est documenté comme volontaire.

Pour chaque problème trouvé :
- fichier:ligne
- scénario concret de défaillance (quelles entrées / quel état → quel résultat faux, crash ou fuite)
- correction proposée
- gravité : Indispensable avant prod / Fortement conseillé / Mineur

Classe les problèmes par gravité. Ne signale rien que tu n'as pas vérifié dans le code. N'écris aucune modification : rapport uniquement, en français.
```

## 1. Fiabilité (crash, redémarrage)

```
Audite uniquement la fiabilité en exploitation de ce bot Discord multi-tenant.
Cherche :
- toute erreur non attrapée qui peut arrêter le process ou interrompre le traitement des autres guildes (handlers d'événements, crons, callbacks, promesses non attendues) ;
- les crons qui peuvent se chevaucher avec eux-mêmes ;
- ce qui se passe si le bot redémarre au milieu d'une opération, ou si des messages arrivent pendant le rattrapage au démarrage (double application, message perdu) ;
- toute écriture sur le disque local (le conteneur tourne en non-root, /app non inscriptible) ;
- les dépendances au démarrage (base injoignable, variable d'env manquante, port occupé) : échec clair ou état bancal ?
- ce qui grossit sans limite (tables, caches mémoire, logs).
```

## 2. Sécurité

```
Audite uniquement la sécurité de ce bot Discord et de son API REST (src/api/).
Cherche :
- les moyens d'appeler l'API sans token valide, ou d'obtenir un token sans être membre de la guilde ;
- les secrets (JWT, OAuth, token bot) : présence, solidité, fuite possible dans les logs, les URL ou les réponses ;
- les actions Discord (boutons, modals, selects, commandes) déclenchables par un membre qui ne devrait pas en avoir le droit, y compris en rejouant un customId ;
- les messages forgés dans les salons de logs (coffres, garages) qui pourraient déclencher un mouvement de stock ou une vente ;
- les injections (SQL brut, contenu utilisateur réinjecté dans un embed ou une URL de redirection) ;
- l'exposition réseau (adresses d'écoute, ports publiés par Docker, CORS).
```

## 3. Isolation multi-tenant

```
Audite uniquement l'étanchéité entre guildes de ce bot multi-tenant.
Cherche :
- toute requête Prisma (src/db.ts et ailleurs) qui ne filtre pas par guildId, en particulier les update/delete par id seul et les purges/resets ;
- toute route API qui lit un guildId ailleurs que dans req.apiUser.guildId ;
- tout usage de client.guilds.cache.first() ou d'un guildId en dur ;
- tout cache ou variable de module partagé entre guildes ;
- tout modèle Prisma sans guildId dans sa clé primaire/unique.
Pour chaque cas, décris comment une guilde A pourrait lire, modifier ou effacer une donnée de la guilde B.
```

## 4. Cohérence des données

```
Audite uniquement la cohérence des données métier : stock, ventes en attente, quotas, paie, taxes.
Cherche :
- les saisies utilisateur (modals, options) non bornées côté serveur par une donnée réelle ;
- les états revérifiés à l'ouverture d'un modal mais pas à sa soumission ;
- les calculs dupliqués qui peuvent diverger (panneau Discord vs API, semaine en cours vs semaine passée) ;
- les compteurs qui peuvent devenir négatifs, être appliqués deux fois ou jamais ;
- les écritures en plusieurs étapes sans transaction, qui laissent un état incohérent si l'une échoue ;
- les resets hebdomadaires : ce qui est remis à zéro, ce qui ne l'est pas, et ce qui se passe si le reset est manqué.
```

## 5. Pièges propres au projet

```
Vérifie uniquement le respect des pièges documentés dans CLAUDE.md.
Cherche :
- les noms d'items FiveM codés en dur ou devinés (piège n°1), y compris dans src/default-items.ts ;
- les tests de limite qui confondent 0 et null (braquageWeeklyLimit et similaires) ;
- les handlers /config qui modifient un panneau sans appeler sa fonction de refresh ;
- les écritures de config qui n'utilisent pas configStore.mutate ;
- les résultats de configStore.get() gardés dans une variable de module ;
- les descriptions de commandes ou d'options slash de plus de 100 caractères ;
- les commentaires qui narrent une modification passée au lieu de décrire l'invariant actuel ;
- un comportement visible ajouté sans mise à jour du manuel, du README ou de CLAUDE.md.
```
