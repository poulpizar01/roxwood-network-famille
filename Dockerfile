FROM node:20-alpine

# Le moteur Prisma a besoin d'OpenSSL, absent de l'image Alpine minimale —
# sans ça, `prisma migrate deploy` échoue au démarrage du conteneur avec une
# erreur de parsing masquant le vrai problème ("could not parse schema engine
# response").
RUN apk add --no-cache openssl

WORKDIR /app

# Installe toutes les dépendances (y compris devDependencies : la CLI `prisma`,
# utilisée par docker-entrypoint.sh pour appliquer les migrations au démarrage
# du conteneur, n'est pas une dépendance de production classique).
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production

# Utilisateur non-root (déjà présent dans l'image officielle node:20-alpine,
# uid/gid 1000) — même exigence que le service systemd (voir
# deploy/roxwood-network-famille.service, User=). Le process n'écrit rien sur
# le disque à l'exécution (logs sur stdout, tout le reste passe par le
# réseau/la DB) : aucun droit d'écriture supplémentaire requis.
USER node

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
