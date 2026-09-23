# Quotum

Quotum shows how much of your coding-agent subscriptions is left — Claude Code, Codex
and Antigravity — on every machine you work on, in one place: for you alone or for a
whole team, on a dashboard you host yourself.

![The Quotum dashboard](https://raw.githubusercontent.com/padurets/quotum/main/docs/dashboard.png)

This package is the Quotum agent: a small native program that asks the agents' own
command-line clients for their limits. It never reads your tokens or cookies and makes
no model requests.

```sh
npx quotum                        # measure once and print this machine's limits
npx quotum connect https://hub…   # connect this machine to a Quotum hub with a one-time code
npx quotum start                  # keep measuring in the background and deliver to the hub
npx quotum stop                   # stop it
npx quotum --help
```

Prebuilt for Linux (x64, arm64, any distribution), macOS (Intel, Apple silicon) and
Windows (x64); npm installs only the binary for your platform.

The hub (the dashboard, one Docker command), how it works and why:
https://github.com/padurets/quotum
