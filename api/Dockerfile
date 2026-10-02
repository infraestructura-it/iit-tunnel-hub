FROM node:22-alpine

ENV NODE_ENV=production \
    DB_PATH=/data/hub.db

# Cliente OpenSSH: la IA ejecuta los comandos de la lista blanca por SSH
RUN apk add --no-cache openssh-client

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
