# Server deployment

`compose.yaml` runs the hub behind Caddy. Set `QUOTUM_DOMAIN` to its domain and run
`docker compose up -d`; `docker compose logs hub` shows the first-account setup code.
This subscription board needs no trusted-key encryption key.

To enable trusted connector credentials, generate 32 random bytes and encode them as
unpadded base64url (43 characters), into a protected file outside this repository and
the hub volume. Set `QUOTUM_SECRET_KEY_SOURCE` to its absolute path. Never put the
contents into a Compose file or database backup. The optional `compose.secrets.yaml`
grants the file only to the hub, whose user is `node` (UID/GID 1000).

Compose file-backed secrets do not apply `uid`, `gid` or `mode`. Use a source owned by
UID 1000 with mode 0400, or root:1000 with mode 0440, inside a directory private to
its owner. This group grant is an explicit operator choice. On rootless Docker or
with user namespace mappings, verify readability as the container's actual `node`
user; never make the source world-readable to bypass a permission error.

Use the same explicit file set for every operation, from this directory:

```sh
docker compose -f compose.yaml -f compose.secrets.yaml config
docker compose -f compose.yaml -f compose.secrets.yaml up -d hub
```

The merged configuration must contain the `_FILE` input and the secret grant. Back
up the KEK separately from the data. For rotation, add an override granting the old
key as `QUOTUM_SECRET_KEY_PREVIOUS_FILE`; include that override in every command
below too. After startup reports `ok` or `rotated` and unreadable is zero, the old
input can be removed. Retain the old key when unreadable records or backups need it.

A missing or mismatched key leaves saved credentials intact. Recover the matching
key first. To deliberately discard them, stop the hub and run the one-shot command
with the fingerprints in its safe startup report:

```sh
docker compose -f compose.yaml -f compose.secrets.yaml stop hub
docker compose -f compose.yaml -f compose.secrets.yaml run --rm --no-deps hub node dist/server/index.js reset-secret-key --from <stored-or-none> --to <current>
docker compose -f compose.yaml -f compose.secrets.yaml up -d hub
```

The command refuses changed fingerprints. It cannot leave a reset intent behind or
reset a later restored backup. Do not configure it as a restarting service command,
and do not persist a `QUOTUM_SECRET_KEY_RESET` variable on a server.

The shared hub's operator can decrypt its credentials. See [SECURITY.md](../SECURITY.md).
