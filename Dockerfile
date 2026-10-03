ARG NODE_VERSION=22

# ---------- build: install deps, compile ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG WEB_PI_BASE=/
RUN WEB_PI_BASE="${WEB_PI_BASE}" npm run build

# ---------- runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux git ripgrep ca-certificates \
      build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir /app && chown node:node /app

COPY --from=build /repo /opt/web-pi
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && chown -R node:node /opt/web-pi

USER node
WORKDIR /app
VOLUME /app
EXPOSE 3000
ENV NODE_ENV=production
ENV WEB_PI_HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PI_PORT||'3000')+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist-server/server/main.js"]
