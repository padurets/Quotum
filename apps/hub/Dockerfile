# The hub uses separate named data and key volumes; see the README's Docker command.
# The first account needs the setup code the hub prints to its log (`docker logs`).

# Production dependencies are installed cleanly without workspace symlinks.
FROM --platform=$BUILDPLATFORM node:24-alpine AS prod-deps
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/hub/package.json ./apps/hub/package.json
RUN npm ci --omit=dev --workspace=apps/hub --ignore-scripts --no-audit --no-fund \
    && rm -rf node_modules/quotum-hub node_modules/.package-lock.json apps/hub/node_modules/.package-lock.json \
    && mkdir -p /prod-node_modules \
    && if [ -d node_modules ]; then cp -a node_modules/. /prod-node_modules/; fi \
    && if [ -d apps/hub/node_modules ]; then cp -a apps/hub/node_modules/. /prod-node_modules/; fi

# JavaScript is built once, natively; the image of every platform only copies it (no native modules).
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/hub/package.json ./apps/hub/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/hub ./apps/hub
RUN npm --workspace=apps/hub run build

FROM node:24-alpine
LABEL org.opencontainers.image.title="Quotum hub" \
      org.opencontainers.image.description="The dashboard of coding-agent subscription limits: agents on your machines push measurements, the hub keeps and shows them." \
      org.opencontainers.image.source="https://github.com/padurets/quotum" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    QUOTUM_BIND=0.0.0.0 \
    QUOTUM_PORT=8080 \
    QUOTUM_DATA_DIR=/data \
    QUOTUM_SECRET_DIR=/keys \
    QUOTUM_MANAGED_CONTAINER=1 \
    QUOTUM_ALLOWED_HOSTS=*
WORKDIR /hub
COPY --from=prod-deps /workspace/apps/hub/package.json ./
COPY --from=prod-deps /prod-node_modules ./node_modules
COPY --from=build /workspace/apps/hub/dist ./dist
RUN mkdir -p /data /keys && chmod 700 /keys && chown node:node /data /keys
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.QUOTUM_PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server/index.js"]
