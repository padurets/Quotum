# Devkit Project Guide

This repository uses a pinned Devkit development environment. Daily commands run inside digest-pinned containers so builds, checks, tests, and packages remain identical across workstations and CI runners without host language SDKs.

## Repository Layout

- `apps/<name>` (`0..N`): Runnable product entry points (`node-api`, `react-web`, `electron-react`, `rust-api`). Libraries-only repositories may have zero applications.
- `packages/<name>` (`1..M`): Reusable workspace libraries (`ts-library`, `react-ui`, `react-client`).
- `.devkit/`: Pinned runtime scripts, Docker/Compose definitions, `.devkit/manifest.json`, and generated Make/Compose projections.

## File Ownership Boundaries

- **Managed by Devkit (do not edit manually)**: `.devkit/runtime/**`, `.devkit/project.mk`, `.devkit/compose.apps.yaml`, `.devkit/compose.workspace.json`, `.devkit/tooling-profiles.json`, `.devkit/runtime.sha256`, `.devkit/npm/**`, and `{rust-component}/rust-toolchain.toml`.
- **Shared native manifests**:
  - In `apps/*/package.json` and `packages/*/package.json`, Devkit manages only the `toolDependencies` entries inside `devDependencies` (recorded in `.devkit/manifest.json`). Product `name`, `version`, `private`, `exports`, `files`, `publishConfig`, `scripts`, `dependencies`, `peerDependencies`, and extra `devDependencies` belong to the project.
  - Root `pnpm-workspace.yaml` and `pnpm-lock.yaml` represent the unified Node workspace graph; `package.json` has no `workspaces` field.
- **Owned by the project**: Component `src/**` and `test/**`, Rust `Cargo.toml` and `Cargo.lock`, root `Makefile`, `compose.yaml`, `AGENTS.md`, `.npmrc`, and `.env` files.

## Toolchain Rules

1. Use `make exec` to run dependency tools inside the pinned containers.
2. **Read-only gates**: `make check`, `make test`, `make build`, and `make package` mount source and lockfiles read-only with `--network none`. Only `make fix` writes formatting changes back to source files.
3. **Syncing manual manifest edits**: After editing `package.json` metadata (`name`, `"private": false`, `exports`, `files`, `publishConfig`) or `.npmrc`, run:
   ```sh
   make sync
   make setup
   ```
4. **Running the pinned CLI without a global install**: On fresh clones or CI hosts where `devkit` is not installed globally on `PATH`, run any CLI subcommand through the checked-in loader (`sh .devkit/runtime/devkit.sh cli <subcommand> ...`, for example `sh .devkit/runtime/devkit.sh cli doctor . --json` or `sh .devkit/runtime/devkit.sh cli describe . --json`).

## Daily Make Commands

| Command | Purpose |
| --- | --- |
| `make help` | List available commands and registered components without fetching the engine |
| `make setup` | Pull/build pinned images and install workspace dependencies into container-compatible paths |
| `make info [app=NAME] [json=1]` | Show checkout identity, readiness, registered components and stand addresses |
| `make sync [reconcile=1] [preview=1]` | Synchronize workspace projections and `pnpm-lock.yaml` after manual `package.json` or `.npmrc` edits |
| `make doctor` | Fast (`<200ms`) verification of accepted images, receipts, disk space, and project invariants |
| `make check` | Run typecheck, lint, formatting check, and Rust compile/test-list gates |
| `make fix` | Format source files explicitly using the pinned formatters |
| `make test` | Run native unit and integration test suites offline |
| `make build` | Produce component build artifacts (`dist/` or `target/`) |
| `make package` | Package Electron apps or publishable libraries (`ts-library`, `react-ui`) into `release/` |
| `make dev [app=<name>]` | Start runnable application services and print published `http://127.0.0.1:<port>` URLs |
| `make logs [app=<name>] [follow=1] [tail=100]` | Inspect or stream service logs (`follow=1` releases the checkout lock before streaming) |
| `make up [app=NAME]` | Start the stand in the background |
| `make down [cleanup=1]` | Stop services and optionally release leases while preserving data |
| `make exec [app=NAME \| package=NAME \| component=PATH] command=ARGV` | Run a command in the root Node workspace or a component |
| `make add-app`, `make add-package`, `make register` | Generate or register components |
| `make update to=VERSION [preview=1] [reconcile=1]`, `make recover` | Update the accepted release or recover an interrupted update |

Scope `setup`, `check`, `fix`, `test`, `build`, and `package` with `app=<name>` or `package=<name>` when working on a single component. `make info` and its `make status` alias probe the checkout lock without waiting. Read-only `make exec` and `make logs` use shared locks. Mutating tasks queue up to `DEVKIT_LOCK_TIMEOUT_MS` (default `120000`).

### Container budgets and Git worktrees

- Devkit automatically sizes container CPU, memory, and worker concurrency from the active cgroup quota (falling back cleanly to in-process toolchain bounds when nested Docker-in-Docker lacks cgroup v2 controller delegation). Override detected ceilings when needed via `DEVKIT_CPUS=<cores>` and `DEVKIT_MEMORY_LIMIT=<bytes>` (for example `DEVKIT_CPUS=2 DEVKIT_MEMORY_LIMIT=4g`).
- Daily gates bind-mount the checkout at `/workspace`; setup and Node write sessions use a common ancestor mount for hardlinks and mask unrelated siblings and credential files. In a linked `git worktree` (where `.git` points to a parent repository outside the checkout directory), run `git` commands on the host rather than inside `devkit exec`.

## Common Workflows

### Add or remove npm dependencies

```sh
make exec app=web write=1 network=bridge command='pnpm add zod --lockfile-only --ignore-scripts'
make setup
make check
```

Use `package=ui` for `packages/ui` and omit the selector for the root Node workspace (pass `-w` alongside `--lockfile-only --ignore-scripts` when running `pnpm add` or `pnpm remove` in the root Node workspace without `app=` or `package=`). The `command=` and `cmd=` aliases use shellwords quoting and preserve literal dollar signs. Use `write=1` for source changes, `network=bridge` for network access, and `prepare=1` to fetch or build missing tools.

### Add components and wire workspace libraries

```sh
make add-package name=sdk template=ts-library
make add-app name=web template=react-web use=sdk
make setup
```

### Publishable npm libraries (`ts-library`, `react-ui`)

1. Edit `packages/<slug>/package.json`: set the final `name`, `"private": false`, `exports` (`types` before `import` or `default`), `files` (`["dist"]`), and optional `publishConfig`.
2. Run `make sync` to synchronize projections and `pnpm-lock.yaml`.
3. Bump versions through the pinned Node container:
   ```sh
   make exec package=<slug> write=1 command='pnpm version 0.2.0 --no-git-tag-version'
   make setup
   ```
4. Build and validate the publishable tarball (`publint` + `@arethetypeswrong/core`) offline:
   ```sh
   make package package=<slug>
   ```
   Inspect `packages/<slug>/release/<name>-<version>.tgz` and `packages/<slug>/release/package-receipt.json`.

### Private npm registries and custom TLS CAs

Commit scoped registry routing and `${ENV_VAR}` token placeholders in root `.npmrc` (never literal credentials):

```ini
@corp:registry=https://git.example.com/api/v4/projects/7/packages/npm/
//git.example.com/api/v4/projects/7/packages/npm/:_authToken=${NPM_REGISTRY_TOKEN}
//git.example.com/api/v4/projects/7/packages/npm/:always-auth=true
```

Export `NPM_REGISTRY_TOKEN` (and optional `DEVKIT_CA_CERT=/abs/path/to/ca.pem` for HTTPS CAs) when running `make setup`, `make sync`, `make update`, or `make exec network=bridge`. Offline tasks (`check`, `test`, `build`, `package`) never receive registry tokens.

### Environment updates and recovery

```sh
make update to=<version> preview=1
make update to=<version>
make setup && make check
```

Pass `reconcile=1` when transitive locks need to be regenerated. If an update is interrupted, run `make recover`. For a mixed `0.4.x` to `0.5.0` checkout whose loader still comes from `0.4.x`, use the versioned `0.5.0` installer with `recover .` or `npx @docouno/devkit@0.5.0 recover .`.

### Shared caches

`DEVKIT_CACHE_DIR` defaults to `~/.cache/docouno/devkit`. Its `tools`, `pnpm-store`, `pnpm-cache`, `cargo`, and `electron` directories are reusable across repositories and Git worktrees. Node setup lazily verifies the pinned pnpm executable; Rust-only setup does not acquire it. Keep the cache on the checkout filesystem for hardlinks. If the mount differs, the package store falls back to the repository's common Git directory (`devkit-store`) or `.devkit/cache/pnpm-store`. Daily tasks mount the pnpm virtual store read-only.

## Development stand addresses

`make up`/`make dev` retain per-checkout host ports across `make down`; concurrent worktrees get separate automatic leases. `DEVKIT_PORT_RANGE` defaults to `10000-19999`. Use `make down cleanup=1` to release this checkout's ports and unused preview files after verified container cleanup; service data volumes remain.

`DEVKIT_PREVIEW_URL_TEMPLATE` accepts HTTP(S) templates with `{port}`, `{service}`, `{branch}` and `{slug}` for an existing reverse proxy. Devkit checks the process environment and the current checkout's root `.env` in that order. To also use the root `.env` from the worktree on branch `next`, run `git config --local devkit.previewSourceBranch next` once per clone. An empty template disables preview URLs. `make info` reports confirmed leases and observed service state. Use `make --no-print-directory -C PATH info json=1` to read the JSON envelope from another directory. The warm lookup reports `unknown` when the lock is busy, ownership or liveness cannot be verified, or local inputs exceed the inspection budget. A cold lookup may download the pinned executable. Reserve `/run/devkit/preview-hosts.json` or `/devkit/preview-hosts.json` outside source, volume and image symlink namespaces when using custom frontend images.

Worktree scripts can call `sh .devkit/runtime/devkit.sh cli stand reserve .` from the target checkout. The operation can fetch the pinned executable on first use and reserves ports without starting services. `make info` shows the confirmed addresses. Continue with `make up` if early reservation is unavailable.

Call `sh .devkit/runtime/devkit.sh cli stand remove .` in the target checkout before deleting it. The command retires the stand, releases its leases and removes resources it can prove belong to that checkout. Keep the checkout on any nonzero exit, resolve the reported ownership or Docker context issue and retry. A retired checkout can finish cleanup on retry. Put data that outlives the checkout in Compose `external` volumes. Run ordinary `make down` with the original Docker context before updating a live checkout through Git.

`devkit init` creates the project-owned `.config/wt.toml` unless you pass `--no-worktrunk`. Worktrunk runs the approved `pre-start` and `pre-remove` hooks in the target checkout. The start hook reserves the address and reports a recoverable skip if prerequisites are missing. The remove hook forwards cleanup failures to Worktrunk. `DEVKIT_WT_AUTOSTART=1` enables the optional `post-start` hook. Run `wt switch --create BRANCH`, `wt list`, and `wt remove BRANCH` interactively, or pass `--yes` (`wt switch --create --no-cd --yes BRANCH`, `wt remove --foreground --yes BRANCH`, or one-time `wt config approvals add --yes`) in non-interactive and agent PTY sessions so hook approval prompts never block. Worktrunk uses the project config in the invoking checkout. Approve the hooks before using them, and run `stand remove` explicitly if you skip hooks.

`init --preset fullstack-web` creates Rust API + React web. `make add-app template=react-web name=dashboard api=api` connects another frontend to a registered API. Multi-app aggregate development skips Electron without `DISPLAY`. Set `headless=1` to include it using Xvfb.
