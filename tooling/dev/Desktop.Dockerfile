FROM node:24-bookworm AS node
FROM rust:1-bookworm
RUN rustup component add clippy rustfmt && apt-get update && apt-get install -y --no-install-recommends \
    libssl-dev libgtk-3-dev unzip ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN curl -fsSL https://ziglang.org/download/0.14.1/zig-x86_64-linux-0.14.1.tar.xz -o /tmp/zig.tar.xz && \
    echo '24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c  /tmp/zig.tar.xz' | sha256sum -c - && \
    mkdir /opt/zig && tar -xf /tmp/zig.tar.xz --strip-components=1 -C /opt/zig && \
    ln -s /opt/zig/zig /usr/local/bin/zig && rm /tmp/zig.tar.xz
RUN CARGO_BUILD_JOBS=4 cargo install cargo-zigbuild --version 0.23.4 --locked && \
    rustup target add x86_64-unknown-linux-musl x86_64-pc-windows-gnu
