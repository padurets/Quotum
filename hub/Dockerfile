# The Quotum hub in one image: `docker run -p 8080:8080 -v quotum:/data ghcr.io/padurets/quotum-hub`.
# The first account needs the setup code the hub prints to its log (`docker logs`).

# JavaScript is built once, natively; the image of every platform only copies it (no native modules).
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /hub
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-alpine
LABEL org.opencontainers.image.title="Quotum hub" \
      org.opencontainers.image.description="The dashboard of coding-agent subscription limits: agents on your machines push measurements, the hub keeps and shows them." \
      org.opencontainers.image.source="https://github.com/padurets/quotum" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    QUOTUM_BIND=0.0.0.0 \
    QUOTUM_PORT=8080 \
    QUOTUM_DATA_DIR=/data \
    QUOTUM_ALLOWED_HOSTS=*
WORKDIR /hub
COPY --from=build /hub/package.json ./
COPY --from=build /hub/node_modules ./node_modules
COPY --from=build /hub/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server/index.js"]
