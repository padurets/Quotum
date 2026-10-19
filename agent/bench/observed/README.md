# Observed activity checks

The core tests replay `corpus.json` through the production CPU classifier and
cadence controller. Its 41 sanitized counter traces include work, idle, unsent
typing and tools. They contain numeric oracles and original evidence hashes, with
no conversations, credentials, paths, PIDs or native birth tokens. The counter
replay does not reproduce process ownership or prove exact model-generation time.
It compares missed work, false work, unknown time, event recall and signed boundary
errors for a fixed fifteen-second judgement grid, frequent capture and adaptive
capture. Recorded production results are reported separately. Startup, the window
after thirty seconds, available typing phases and post-work tails remain separate.
Existing classifier errors remain visible; passing does not mean all work is found.

From the repository root, build the explicit Linux probe in the Rust development
image with the shared Cargo cache (see CONTRIBUTING.md for the development images):

```sh
docker run --rm --user "$(id -u):$(id -g)" -e CARGO_HOME=/cargo -e CARGO_BUILD_JOBS=4 \
  -v quotum-cargo:/cargo -v "$PWD":/work -w /work/agent quotum-rust \
  cargo build --release --locked -p quotum-core --features activity-bench --example observed_probe
```

The normal build contains neither this executable nor its measurement counters.
`hub/bench/observed-recovery.ts` runs this queue against a real local HTTP hub and
SQLite, covering delayed work, process death, hub restart, lost acknowledgements,
duplicate batches, rollback and independent clock anchors:

```sh
cd hub
node --import tsx bench/observed-recovery.ts ../agent/target/release/examples/observed_probe
```

`resources.py` runs the real Runner, capture worker, journal and HubSink against a
loopback protocol stand-in. `client.c` supplies native process names, controlled
CPU and a version answer. It never calls a provider. Run in its own PID and network
namespace, without real configuration or credentials mounted, and under a different
UID from any real collector on the host. A parent PID namespace can still see the
container's synthetic `codex` processes; using the collector's UID lets them enter
its real work history as projectless agents. Build as your normal user, then run
the fixture under a separate UID (65534 below). The fixture and probe share that UID
so process discovery inside the container still works. Serialize measured runs with
builds and other heavy checks. For example, from the repository root:

```sh
docker run --rm --network none --user 65534:65534 \
  -v "$PWD":/work -w /work quotum-rust python3 agent/bench/observed/resources.py \
  agent/target/release/examples/observed_probe --children 100
```

The default is six roots, thirty seconds of warm-up and a five-minute acceptance
window. CPU percentages refer to one core. Output separates capture, context,
persistence and control costs, whole-daemon and child CPU, RSS/PSS, journal state,
I/O and delivered periods. It checks stop latency and recent delivery; an idle or
typing workload must credit no positive work. Use `--roots 0`, `--idle`, `--ui`,
`--unrelated 600`, or `--children 100 --churn` for the other workloads. Repeat ordinary
and dense windows rather than averaging away a failure. `--mode slow` uses a real
sixty-second collector delay, five-second version probe and timed-out HTTP response;
capture must keep closing durable intervals while delivery waits.

Discovery samples compare the first captured state with the native process birth,
including pending journal states. Their timestamp precedes the native scan; the
reported capture wall cost bounds the extra time until publication. `--churn` also
reports detection of new roots, independently of HTTP receipt time. Queue file
bytes and allocated filesystem blocks are reported separately.
Churn also records the controlled process creation interval and its offset from
the native birth date, so coarse OS birth timestamps do not inflate detection delay.

`--stall-sync` pauses one durable write for 800 ms, 45 seconds into the runner. The worker must
continue collecting without converting that wait into CPU debt. Progress checks
require actual post-warm-up observations; an empty interval list cannot pass.

`--mode capture --seconds 120` isolates the cost of equal two- and fifteen-second
native looks. A pristine-version adapter can be passed with `--baseline`; its
`cadence SECONDS PERIOD true` command must call that version's `Activity::look`
with project discovery enabled and report the same cost fields. Use matching
release flags, scope and process populations, record both binary hashes, and keep
that comparison separate from savings due to a slower adaptive cadence.
