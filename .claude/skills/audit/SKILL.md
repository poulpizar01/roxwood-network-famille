---
name: audit
description: Lance un audit du code par angle (fiabilite, securite, multi-tenant, donnees, pieges) a partir des prompts de docs/audits.md. Sans argument, lance les 5 angles en parallele et fusionne les rapports.
argument-hint: "[fiabilite|securite|multi-tenant|donnees|pieges]"
---

# Audit par angle

Les prompts d'audit vivent dans `docs/audits.md` — c'est la seule source. Lis ce fichier à chaque invocation (il a pu changer depuis la dernière fois) ; ne réécris jamais un prompt de mémoire.

## Correspondance argument → section

| Argument | Section de `docs/audits.md` |
|---|---|
| `fiabilite` | 1. Fiabilité (crash, redémarrage) |
| `securite` | 2. Sécurité |
| `multi-tenant` | 3. Isolation multi-tenant |
| `donnees` | 4. Cohérence des données |
| `pieges` | 5. Pièges propres au projet |

Accepte les variantes évidentes (accents, majuscules, `tenant`, `data`…). Si l'argument ne correspond à aucun angle, liste les angles disponibles et arrête-toi. Si une section a été ajoutée à `docs/audits.md` sans figurer ici, elle compte aussi comme un angle (nom = son titre).

## Déroulé

1. Lis `docs/audits.md`.
2. Pour chaque angle demandé (un seul avec argument, tous sans argument), construis le prompt complet : le bloc de la section + le bloc « Format de sortie commun », mot pour mot.
3. Lance un agent `general-purpose` par angle avec ce prompt — tous dans le même message pour qu'ils tournent en parallèle. Un angle seul passe aussi par un agent, pour que l'audit parte d'un contexte neuf, sans les présupposés de la conversation en cours.
4. Quand tous les rapports sont revenus, vérifie toi-même chaque problème « Indispensable avant prod » en relisant le code à la ligne indiquée : écarte ceux qui ne tiennent pas, ou qui contredisent une décision documentée dans CLAUDE.md, et signale-les comme écartés avec la raison.
5. Rends un rapport unique en français :
   - classé par gravité, puis par angle ;
   - doublons entre angles fusionnés (un même fichier:ligne signalé par deux agents = un seul point, en citant les deux angles) ;
   - chaque point : fichier:ligne (lien markdown cliquable), scénario de défaillance, correction proposée ;
   - à la fin : les points écartés à l'étape 4, puis ce qu'aucun angle n'a couvert si tu le remarques.

## Ce que l'audit ne fait pas

Aucune modification de code, de données ou de documentation, aucun commit. Le rapport s'arrête sur une proposition ; l'utilisateur choisit ce qui est corrigé.
