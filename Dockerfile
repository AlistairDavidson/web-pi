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

# ---------- runtime base: app + user, NO compiler toolchain ----------
# Prod never compiles anything (node-pty arrives prebuilt in the seed copy);
# only the dev stage below needs build-essential/python3 for its npm install.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux git ripgrep ca-certificates \
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

# Persist the build-time base as the runtime default, so plain `docker run`
# doesn't have to repeat it (compose env still wins).
ARG WEB_PI_BASE=/
ENV WEB_PI_BASE=${WEB_PI_BASE}

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WEB_PI_PORT||'3000')+(process.env.WEB_PI_BASE||'/').replace(/\\/+$/,'')+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist-server/server/main.js"]

# ---------- dev: runtime + toolchain, for in-container npm install ----------
# Built with `--target dev` (compose's dev profile); the shadow node_modules
# volume compiles node-pty here.
FROM runtime AS dev
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# ---------- prod: default (last) stage ----------
FROM runtime AS prod
