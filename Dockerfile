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

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
