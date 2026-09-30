# Security

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/padurets/quotum/security/advisories/new)**
(the *Security* tab of this repository). Don't open a public issue for them.

Most interesting are:

- the hub: signing in, sessions, invite links, machine and device tokens, and what one
  person can see or change of another's data or boards;
- the agent: anything that makes it send more than the [spec](spec/ingest-v1.md#privacy)
  says, read credentials, or run something it shouldn't;
- the release: the workflow that builds and publishes the binaries, the npm packages
  and the image.

Fixes go into the latest release; there are no older lines to patch.

## Trusted credentials

Quotum's agent asks the installed coding clients for limits. It never reads provider
tokens, cookies or credential files, and provider clients inherit none of Quotum's
environment variables. The hub's trusted connector credentials use a separate,
write-only path: AES-256-GCM encryption before database writes, with its encryption key
(KEK) outside the database and data directory. No production provider uses this path
yet.

On a server, configure `QUOTUM_SECRET_KEY` or `QUOTUM_SECRET_KEY_FILE`; without it,
ordinary subscriptions still work, but connecting with a trusted key is unavailable.
The app chooses its system password store when it can use one, and a private file
outside its data directory only when the store is known to be unavailable on first
use. A locked, denied or inconclusive store leaves it waiting; it does not prove that
a key was lost.

| KEK storage | Protection and limits |
|---|---|
| Server environment or separate secret file | Keep the KEK out of database and volume backups. The hub operator can decrypt the credentials. |
| Windows Credential Manager or Linux Secret Service | Protection is the same as for other passwords in that store. It depends on the store's protection, often the login password; Quotum does not know that password. |
| Private file | File permissions protect against other ordinary OS users. A home or profile backup containing this file and the database can reveal the saved credentials. |

A copy of the database, WAL or data volume cannot reveal the credentials without the
separate KEK. Back up the KEK separately: losing it makes its credentials unreadable.
The operator of a shared hub can decrypt its credentials. Encryption does not protect
against that operator, an administrator, the same operating-system user, captured
process memory, or a compromised running hub.

Credentials are visible only to their owner as safe record details. Saved keys cannot
be read back through an API, event or app bridge. This limits what an XSS can read from
stored credentials; an XSS can still see a key as it is entered and invoke authorized
replace, delete or reset actions. Connectors send credentials only to destinations
fixed in their code, over validated HTTPS, without redirects or environment proxies.

Missing or mismatched KEKs never erase credentials. Rotation needs the matching
previous KEK. An explicit one-shot reset discards saved credentials and is bound to
the old and new key fingerprints; restoring a backup does not repeat that reset.
Authenticated decryption failure marks a record unreadable. Recovery from damaged
ciphertext is not guaranteed.

When a usable system store appears, the app stages a fresh KEK and rotates the
credentials on the next app start. It removes the old file only after the hub confirms
the matching rotation and WAL cleanup, with no unreadable records. Found keys outside
that recorded transition are kept, including leftover files. Moving to the system
store protects new data; old home backups can still reveal previously saved access.
Replace or revoke those keys at their provider to invalidate that access. A retained
old KEK may also be needed to restore its matching database backup.

Secure deletion and verified WAL truncation remove the hub's old live ciphertext;
they do not erase SSD remnants, snapshots or backups, and do not revoke a provider's
key. Revoke or replace it at the provider when that is needed.

Please include a reproducible case without a real credential in a vulnerability report.
