# The hub uses separate named data and key volumes; see the README's Docker command.
# The first account needs the setup code the hub prints to its log (`docker logs`).

# JavaScript is built once, natively; the image of every platform only copies it (no native modules).
FROM --platform=$BUILDPLATFORM node:24-alpine AS pnpm-base
ARG PNPM_VERSION=12.21.0
RUN npm install -g "pnpm@${PNPM_VERSION}" --ignore-scripts --no-audit --no-fund \
  && set -- /usr/local/lib/node_modules/pnpm/node_modules/@pnpm/exe.*/pnpm \
  && test "$#" -eq 1 && test -x "$1" \
  && ln -sf "$1" /usr/local/bin/pnpm

# Keep the pnpm workspace layout so Node resolves isolated workspace packages cleanly.
FROM pnpm-base AS prod-deps
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hub/package.json ./apps/hub/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter quotum-hub

FROM pnpm-base AS build
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hub/package.json ./apps/hub/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter quotum-hub
COPY apps/hub ./apps/hub
RUN pnpm --filter quotum-hub run build

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
COPY --from=prod-deps /workspace/node_modules /workspace/node_modules
COPY --from=prod-deps /workspace/apps/hub/package.json /workspace/apps/hub/package.json
COPY --from=prod-deps /workspace/apps/hub/node_modules /workspace/apps/hub/node_modules
WORKDIR /workspace/apps/hub
COPY --from=build /workspace/apps/hub/dist ./dist
RUN mkdir -p /data /keys && chmod 700 /keys && chown node:node /data /keys
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.QUOTUM_PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server/index.js"]
