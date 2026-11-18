# The agent is a CLI; the hub is the only default development service.
ifeq ($(strip $(app)$(package)),)
override devkit_selected_apps := hub
endif

include .devkit/runtime/devkit.mk

.PHONY: bench bundle-hub prepare-desktop check-desktop

export BENCH_CDP

bench: build-hub
	cd apps/hub && env -i PATH="$$PATH" HOME="$$HOME" TMPDIR="$${TMPDIR:-/tmp}" \
		QUOTUM_CHROME="$$QUOTUM_CHROME" BENCH_CDP="$$BENCH_CDP" \
		QUOTUM_BENCH_DIAGNOSTICS_DIR="$$QUOTUM_BENCH_DIAGNOSTICS_DIR" \
		QUOTUM_BENCH_DIAGNOSE_NATIVE="$$QUOTUM_BENCH_DIAGNOSE_NATIVE" \
		QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL="$$QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL" \
		sh -c 'if [ -n "$$BENCH_CDP" ]; then set -- --cdp "$$BENCH_CDP"; fi; exec npm run bench -- --ci "$$@"'

bundle-hub: build-hub
	@sh $(devkit_loader) exec --component apps/hub -- npm run bundle

prepare-desktop: bundle-hub
	node desktop/prepare.mjs --no-build

check-desktop: prepare-desktop
	cd desktop && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
