include .devkit/runtime/devkit.mk

.PHONY: bench bundle-hub prepare-desktop check-desktop

bench: build-hub
	cd apps/hub && npm run bench

bundle-hub: build-hub
	@sh $(devkit_loader) exec --component apps/hub -- npm run bundle

prepare-desktop: bundle-hub
	node desktop/prepare.mjs --no-build

check-desktop: prepare-desktop
	cd desktop && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
