# Secret Service 5.2.0

Source: the published crates.io package `secret-service` 5.2.0, from
[hwchen/secret-service-rs](https://github.com/hwchen/secret-service-rs), upstream commit
`1fe4fbe405b152bc969deb5de417847e1e4e4c7b`.

Published archive SHA-256:
`5107b24b91445dd2aa449a258a1807b63240942157292354dc5bfdbeb8bc6db8`.

The original package metadata and both upstream licenses are retained. This dependency
is licensed under MIT OR Apache-2.0; see LICENSE-MIT and LICENSE-APACHE.

The local patch adds an asynchronous constructor that takes an observed unique D-Bus
owner and carries that destination through item, collection and prompt proxies. A
returned object path then stays with the process that issued it, even when another
process acquires the well-known service name. The original constructors and blocking
API remain compatible. Session negotiation and cryptographic code are unchanged.
