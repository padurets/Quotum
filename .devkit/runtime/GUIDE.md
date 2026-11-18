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
  - Root `package.json` `workspaces` and `package-lock.json` represent the unified Node workspace graph.
- **Owned by the project**: Component `src/**` and `test/**`, Rust `Cargo.toml` and `Cargo.lock`, root `Makefile`, `compose.yaml`, `.npmrc`, and `.env` files.

## Toolchain Rules

1. **Never run bare host `npm install`, `npx`, `cargo`, or `rustup`** to mutate lockfiles or build outputs. Always execute native tools through `make` or `devkit exec`.
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
| `make setup` | Pull/build pinned images and install workspace dependencies into container-compatible paths |
| `make sync [reconcile=1] [preview=1]` | Synchronize workspace projections and `package-lock.json` after manual `package.json` or `.npmrc` edits |
| `make doctor` | Fast (`<200ms`) verification of accepted images, receipts, disk space, and project invariants |
| `make check` | Run typecheck, lint, formatting check, and Rust compile/test-list gates |
| `make fix` | Format source files explicitly using the pinned formatters |
| `make test` | Run native unit and integration test suites offline |
| `make build` | Produce component build artifacts (`dist/` or `target/`) |
| `make package` | Package Electron apps or publishable libraries (`ts-library`, `react-ui`) into `release/` |
| `make dev [app=<name>]` | Start runnable application services and print published `http://127.0.0.1:<port>` URLs |
| `make logs [app=<name>] [follow=1] [tail=100]` | Inspect or stream service logs (`follow=1` releases the checkout lock before streaming) |
| `devkit status [TARGET] [--json]` | Query Compose services, health, published HTTP URLs, and local readiness receipts |
| `devkit doctor [TARGET] [--json]` | Run lock-free host, cgroup v2, DinD, disk, and checkout diagnostics with remediation commands |
| `devkit describe [TARGET] [--json]` | Read offline component metadata, selectors, exposed ports, and local receipts (`0` Docker calls) |

Scope `setup`, `check`, `fix`, `test`, `build`, and `package` with `app=<name>` or `package=<name>` when working on a single component. Read-only commands (`devkit describe`, `devkit status`, `make doctor`, `make status`, `make logs`, and read-only `devkit exec`) share a concurrent read lock, while mutating tasks queue up to `DEVKIT_LOCK_TIMEOUT_MS` (default `120000`).

### Container budgets and Git worktrees

- Devkit automatically sizes container CPU, memory, and worker concurrency from the active cgroup quota (falling back cleanly to in-process toolchain bounds when nested Docker-in-Docker lacks cgroup v2 controller delegation). Override detected ceilings when needed via `DEVKIT_CPUS=<cores>` and `DEVKIT_MEMORY_LIMIT=<bytes>` (for example `DEVKIT_CPUS=2 DEVKIT_MEMORY_LIMIT=4g`).
- Containers bind-mount only the checkout root at `/workspace`. In a linked `git worktree` (where `.git` points to a parent repository outside the checkout directory), run `git` commands on the host rather than inside `devkit exec`.

## Common Workflows

### Add or remove npm dependencies

```sh
devkit exec --component apps/web --write --network bridge -- npm install zod
make setup
make check
```

To add a dependency to a library (`packages/ui`), target `--component packages/ui` (for example `--save-peer` and `--save-dev` for `react-ui` peer libraries).

### Add components and wire workspace libraries

```sh
devkit add-package . --name sdk --template ts-library
devkit add-app . --name web --template react-web --use sdk
make setup
```

### Publishable npm libraries (`ts-library`, `react-ui`)

1. Edit `packages/<slug>/package.json`: set the final `name`, `"private": false`, `exports` (`types` before `import` or `default`), `files` (`["dist"]`), and optional `publishConfig`.
2. Run `devkit sync` to synchronize projections and `package-lock.json`.
3. Bump versions through the pinned Node container:
   ```sh
   devkit exec --component packages/<slug> --write -- npm version 0.2.0 --no-git-tag-version
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

Export `NPM_REGISTRY_TOKEN` (and optional `DEVKIT_CA_CERT=/abs/path/to/ca.pem` for internal HTTPS CAs) when running `make setup`, `devkit sync`, `devkit update`, or `devkit exec --network bridge`. Offline tasks (`check`, `test`, `build`, `package`) never receive registry tokens.

### Environment updates and recovery

```sh
devkit update . --to <version> --preview
devkit update . --to <version>
make setup && make check
```

Pass `--reconcile-lock` when transitive lockfile dependencies require re-resolution across toolchain bumps. If an update is interrupted, run `devkit recover .`.
