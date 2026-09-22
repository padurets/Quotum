# Quotum

Quotum shows how much of your coding-agent subscriptions is left — Claude Code, Codex
and Antigravity — on every machine you work on, in one place.

This package is the Quotum agent: a small native program that asks the agents' own
command-line clients for their limits. It never reads your tokens and makes no model
requests.

```sh
npx quotum                        # measure once and print this machine's limits
npx quotum connect https://hub…   # connect this machine to a Quotum hub with a one-time code
npx quotum run                    # keep measuring and deliver to the hub
npx quotum --help
```

Prebuilt for Linux (x64, arm64, any distribution), macOS (Intel, Apple silicon) and
Windows (x64); npm installs only the binary for your platform.

The dashboard (the hub), how it works and why: https://github.com/padurets/quotum
