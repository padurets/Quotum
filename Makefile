# The agent is a CLI; the hub is the only default development service.
ifneq ($(wildcard .devkit/project.mk),)
ifeq ($(strip $(app)$(package)),)
override devkit_selected_apps := hub
endif
endif

include .devkit/runtime/devkit.mk

.PHONY: bench bundle-hub prepare-desktop check-desktop

export BENCH_CDP QUOTUM_CHROME QUOTUM_BENCH_DIAGNOSTICS_DIR QUOTUM_BENCH_DIAGNOSE_NATIVE QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL

bench: build-hub
	cd apps/hub && env -i PATH="$$PATH" HOME="$$HOME" TMPDIR="$${TMPDIR:-/tmp}" \
		QUOTUM_CHROME="$$QUOTUM_CHROME" BENCH_CDP="$$BENCH_CDP" \
		QUOTUM_BENCH_DIAGNOSTICS_DIR="$$QUOTUM_BENCH_DIAGNOSTICS_DIR" \
		QUOTUM_BENCH_DIAGNOSE_NATIVE="$$QUOTUM_BENCH_DIAGNOSE_NATIVE" \
		QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL="$$QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL" \
		sh -c 'if [ -n "$$BENCH_CDP" ]; then set -- --cdp "$$BENCH_CDP"; fi; exec node --import tsx bench/index.ts --ci "$$@"'

bundle-hub: build-hub
	@sh $(devkit_loader) exec --component apps/hub -- pnpm run bundle

prepare-desktop: bundle-hub
	@sh desktop/run-in-container.sh --network bridge -- \
		'node desktop/prepare.mjs --no-build && cargo fetch --locked --manifest-path desktop/Cargo.toml'

check-desktop: prepare-desktop
	@sh desktop/run-in-container.sh --network none -- \
		'node --test desktop/prepare-node.test.mjs desktop/linux-metadata.test.mjs desktop/electron/policy.test.cjs && cd desktop && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked'
