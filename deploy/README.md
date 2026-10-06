# Server deployment

`compose.yaml` runs the hub behind Caddy. Set `QUOTUM_DOMAIN` to its domain and run
`docker compose up -d`; `docker compose logs hub` shows the first-account setup code.
The hub creates its trusted-credential encryption key automatically in the separate
`quotum-keys:/keys` volume, beside `quotum:/data`. Both named volumes survive container
recreation. Keep the key volume's backup separate from the database backup. A backup
of both stores or the whole host can decrypt credentials; a data-only backup cannot.

When upgrading an existing direct Docker installation, add `-v quotum-keys:/keys`.
Automatic storage refuses a missing mount, a key directory inside data, or another mount
of the same data-volume backing directory. Distinct named volumes on one filesystem
are supported. Anonymous volumes do not provide the documented recreation guarantee.
Existing explicit key inputs remain authoritative and are not copied into this volume.

On POSIX standalone, the default is `<real dataDir>.keys/current.key`. The directory
must belong to the hub user with mode 0700, the key with mode 0600; automatic storage
rejects symlinks and unsafe parent permissions. `QUOTUM_SECRET_DIR` can select another
separate persistent directory. On Windows standalone, a protected, nonvolatile
`HKCU\\Software\\Quotum\\HubKeys\\v1\\<managedKeyId>` branch holds the binary key. The
UUID is stored in database metadata. A bounded packaged PowerShell helper uses a
cross-session native mutex, a private current-user/SYSTEM DACL, `RegFlushKey` and
read-back. Blocked PowerShell or an inaccessible service profile leaves trusted keys
unavailable; it never falls back to a file inside data. Desktop local mode keeps its
own native controller and does not use server automatic storage.

Restore the database and its matching key store as a pair. Missing key storage or a
wrong pair preserves encrypted access and reports a safe error. The hub never creates
a replacement for established key metadata, even if there are no credentials left.
For Windows, keep a protected export of the instance's UUID registry branch outside
data. Restore it under the original instance UUID and intended user, with a protected
DACL granting only that user and SYSTEM; a registry export alone does not preserve
permissions. Never print its values or commit the export. An operator can keep using
an explicit matching key instead of importing it into automatic storage.

To use an explicit operator-managed key, generate 32 random bytes and encode them as
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
key first. Removing an explicit override after rotation does not update an older
automatic key: restore matching automatic material or keep the explicit input.
To deliberately discard credentials, supply an explicit new key, stop the hub and run the one-shot command
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
