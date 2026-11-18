FROM rust:1.99.1-slim-bookworm@sha256:86234e857a413004348b471d11a4ebe1aa92d2eae2b6b143cac68fd1ac3c48be

ARG DEVKIT_RECIPE_SHA
LABEL io.docouno.devkit.rust-recipe="${DEVKIT_RECIPE_SHA}"

RUN rustup component add --toolchain 1.99.1 rustfmt clippy

ENV RUSTUP_AUTO_INSTALL=0
