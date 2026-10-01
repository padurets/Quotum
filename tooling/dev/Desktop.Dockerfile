FROM node:24-bookworm AS node
FROM rust:1-bookworm
RUN rustup component add clippy rustfmt && apt-get update && apt-get install -y --no-install-recommends \
    libssl-dev libgtk-3-dev unzip ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
