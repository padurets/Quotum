FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# Match the Debian snapshot used to produce the pinned Node base image.
# Signed Release metadata is still verified; only the archival expiry is ignored.
RUN printf '%s\n' \
    'Types: deb' \
    'URIs: http://snapshot.debian.org/archive/debian/20261020T213255Z/' \
    'Suites: bookworm bookworm-updates' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    'Check-Valid-Until: no' \
    '' \
    'Types: deb' \
    'URIs: http://snapshot.debian.org/archive/debian-security/20261020T213255Z/' \
    'Suites: bookworm-security' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    'Check-Valid-Until: no' \
    > /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libdrm2 \
      libx11-xcb1 libxshmfence1 libatk1.0-0 libatk-bridge2.0-0 \
      libatspi2.0-0 libxrandr2 libxkbcommon0 libcups2 \
      fonts-liberation xvfb xauth util-linux tar gzip \
    && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /workspace
