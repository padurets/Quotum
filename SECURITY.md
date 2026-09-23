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
