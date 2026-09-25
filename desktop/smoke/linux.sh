#!/bin/sh
# The app as CI built it, run once end to end with data of its own (see src/smoke.rs):
#
#   linux.sh normal <command…>   --smoke must pass, and no Node of the app is left after it
#   linux.sh crash <command…>    --smoke=crash aborts the app; its Node must go by itself
set -eu

mode=$1
shift
work=$(mktemp -d)
export QUOTUM_APP_DATA_DIR="$work/app" QUOTUM_STATE_DIR="$work/state" QUOTUM_CONFIG="$work/config.toml"
export QUOTUM_RESETS=off
# Only Antigravity, through a stand-in: no real client starts, no account is needed.
cat > "$QUOTUM_CONFIG" <<EOF
sessions = false
[providers.claude]
enabled = false
[providers.codex]
enabled = false
[providers.antigravity]
path = '$(cd "$(dirname "$0")" && pwd)/agy'
EOF

fail() {
  echo "smoke ($mode): $*" >&2
  [ ! -f "$work/output.log" ] || tail -n 40 "$work/output.log" >&2
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    python3 "$(dirname "$0")/diagnostic.py" "$work" "$mode: $*"
  fi
  for log in "$work"/app/logs/*.log; do
    [ -f "$log" ] && { echo "--- $log" >&2; tail -n 40 "$log" >&2; }
  done
  exit 1
}

# No Node of the app is running. Found by its command line: Node 24 names its process
# after its main thread (MainThread), not after the file. The brackets keep the pattern
# from matching a shell that runs this very line.
node_gone() {
  ! pgrep -f '[q]uotum-node .*server\.mjs' >/dev/null
}

node_gone || fail "a quotum-node runs before the app starts"
case $mode in
  normal)
    # The sandbox must remain active. Electron reports live child failures; the
    # subreaper also checks processes that outlive the controller during teardown.
    python3 "$(dirname "$0")/monitor.py" -- \
      timeout -k 10 180 xvfb-run -a "$@" --smoke > "$work/output.log" 2>&1 || fail "the app failed ($?)"
    cat "$work/output.log"
    node_gone || fail "quotum-node outlived the app"
    ;;
  crash)
    status=0
    timeout -k 10 180 xvfb-run -a "$@" --smoke=crash || status=$?
    [ "$status" -ne 0 ] || fail "the app did not crash"
    [ "$status" -ne 124 ] || fail "the app did not crash within 180 s"
    for _ in $(seq 1 20); do
      node_gone && break
      sleep 0.5
    done
    node_gone || fail "quotum-node outlived the crashed app by 10 s"
    ;;
  *) fail "unknown mode" ;;
esac
echo "smoke ($mode): passed"
rm -rf "$work"
