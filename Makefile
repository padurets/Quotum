.PHONY: prepare dev info logs down dev-test check-hub check-agent check-desktop bench install-dev

prepare dev info logs down install-dev:
	node tooling/dev/cli.mjs $@

dev-test:
	node --test tooling/dev/test/*.test.mjs

check-hub check-agent check-desktop bench:
	node tooling/dev/checks.mjs $@
