#!/bin/sh
set -e

# Applique les migrations en attente avant de démarrer le bot — équivalent
# conteneurisé de `npx prisma migrate deploy` dans le pipeline de déploiement
# documenté (voir CLAUDE.md). Idempotent : ne fait rien si tout est déjà à jour.
npx prisma migrate deploy

exec "$@"
