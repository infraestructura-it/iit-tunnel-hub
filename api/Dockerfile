FROM node:22-alpine

ENV NODE_ENV=production \
    DB_PATH=/data/hub.db

ARG FRP_VERSION=0.71.0
ARG TARGETARCH

# Cliente OpenSSH: la IA ejecuta los comandos de la lista blanca por SSH.
# frpc: el hub lo usa como visitante interno para consultar equipos SNMP por túneles privados (sudp).
RUN ARCH="${TARGETARCH:-amd64}" \
 && apk add --no-cache openssh-client ca-certificates \
 && wget -qO- "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz" \
    | tar xz -C /tmp \
 && mv /tmp/frp_${FRP_VERSION}_linux_${ARCH}/frpc /usr/local/bin/frpc \
 && rm -rf /tmp/frp_*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY deps ./deps
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

# --openssl-legacy-provider: habilita DES para equipos SNMPv3 antiguos
CMD ["node", "--disable-warning=ExperimentalWarning", "--openssl-legacy-provider", "src/server.js"]
