#!/bin/sh
# Initial transfer and delegation only; all project operations run in the ELF.
set -eu
mode=project
version=0.4.1
expected=206f66322e7ae009bc9368a05df64cfef0285ec30e32e9b9dbf0ffbe1069f929
target=x86_64-unknown-linux-musl
asset=devkit-x86_64-unknown-linux-musl
fail() { printf 'devkit: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s):$(uname -m)" = Linux:x86_64 ] || fail 'this release requires Linux x86_64'
command=${1:-help}
if [ "$mode" = project ] && [ "$command" = help ]; then
  printf '%s\n' \
    'make setup | check | fix | test | build   [app=NAME | package=NAME]' \
    'make dev | up                             [app=NAME] [headless=1]' \
    'make package                              [app=DESKTOP | package=NAME]' \
    'make sync                                 [reconcile=1] [preview=1]' \
    'make status | logs                        [app=NAME] [tail=100] [follow=1]' \
    'make down                                 (stops services; preserves data)' \
    'make doctor                               (fast checkout + image check)' \
    'devkit status [TARGET] [--json]           (live Compose services + HTTP URLs)' \
    'devkit doctor [TARGET] [--json]           (lock-free host/DinD/cgroup diagnostics)' \
    'devkit describe [TARGET] [--json]         (offline component + port metadata)' \
    'devkit exec --component apps/NAME|packages/NAME [--write] [--network none|bridge] [--prepare] -- ARGV' \
    'sh .devkit/runtime/devkit.sh cli ...      (run pinned devkit CLI without global install)'
  exit 0
fi
cache=${DEVKIT_CACHE_DIR:-${XDG_CACHE_HOME:-${HOME:?HOME or XDG_CACHE_HOME is required}/.cache}/docouno/devkit}
case "$cache" in /*) ;; *) fail 'the cache directory must be absolute' ;; esac
cache=$(realpath -ms -- "$cache")
[ "$(realpath -m -- "$cache")" = "$cache" ] || fail 'the cache path contains a symbolic link'
engine=$cache/engines/$target/$version/$expected/devkit
if [ -n "${DEVKIT_ENGINE_PATH:-}" ]; then
  engine=$DEVKIT_ENGINE_PATH
fi
valid_engine() {
  [ -f "$engine" ] && [ ! -L "$engine" ] && [ -x "$engine" ] || return 1
  observed=$(sha256sum -- "$engine")
  [ "${observed%% *}" = "$expected" ]
}
exec_prepare=0
exec_has_root=0
cli_offline=0
if [ "$command" = exec ]; then
  if [ "$#" -eq 1 ] && [ "${DEVKIT_EXEC_PREPARE:-0}" = 1 ]; then
    exec_prepare=1
  elif [ "$#" -gt 1 ]; then
    for arg in "$@"; do
      [ "$arg" != -- ] || break
      [ "$arg" != --prepare ] || exec_prepare=1
      [ "$arg" != --root ] || exec_has_root=1
    done
  fi
elif [ "$command" = cli ]; then
  for arg in "$@"; do
    [ "$arg" != -- ] || break
    [ "$arg" != --offline ] || cli_offline=1
  done
fi
if ! valid_engine; then
  [ ! -e "$engine" ] && [ ! -L "$engine" ] || fail "cached engine integrity differs: $engine"
  [ -z "${DEVKIT_ENGINE_PATH:-}" ] || fail 'DEVKIT_ENGINE_PATH does not select the accepted engine'
  [ "$mode" = bootstrap ] || [ "$command" = setup ] || [ "$command" = setup-node ] || [ "$command" = sync ] || [ "$command" = doctor ] || [ "$command" = status ] || { [ "$command" = cli ] && [ "$cli_offline" = 0 ]; } || [ "$exec_prepare" = 1 ] || fail 'the accepted engine is unavailable; run make setup'
  parent=${engine%/*}
  [ "$(realpath -m -- "$parent")" = "$(realpath -ms -- "$parent")" ] || fail 'the engine cache path contains a symbolic link'
  umask 077
  mkdir -p -- "$parent"
  temporary=$(mktemp "$parent/.engine.XXXXXXXX")
  download_pid=
  cleanup() {
    if [ -n "$download_pid" ]; then
      kill -TERM "$download_pid" 2>/dev/null || :
      wait "$download_pid" 2>/dev/null || :
    fi
    rm -f -- "$temporary"
  }
  trap cleanup 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  curl --disable --fail --silent --show-error --location --max-redirs 5 \
    --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 90 \
    --max-filesize 134217728 --output "$temporary" \
    "https://github.com/docouno/devkit/releases/download/v$version/$asset" &
  download_pid=$!
  if wait "$download_pid"; then
    download_pid=
  else
    status=$?
    download_pid=
    exit "$status"
  fi
  observed=$(sha256sum -- "$temporary")
  [ "${observed%% *}" = "$expected" ] || fail 'downloaded engine checksum differs'
  chmod 755 -- "$temporary"
  # Creating this link is atomic and cannot replace a concurrent installation.
  ln -- "$temporary" "$engine" 2>/dev/null || :
  valid_engine || fail 'the accepted engine could not be installed'
  cleanup
  trap - 0 INT TERM
fi
if [ "$mode" = bootstrap ]; then
  DEVKIT_BOOTSTRAP_INTERACTIVE=1
  export DEVKIT_BOOTSTRAP_INTERACTIVE
  exec "$engine" "$@"
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
if [ "$command" = cli ]; then
  shift
  [ "$#" -gt 0 ] || set -- --help
  exec "$engine" "$@"
fi
if [ "$command" = sync ]; then
  if [ "$#" -gt 1 ]; then
    shift
    exec "$engine" sync "$@"
  fi
  for flag in "${DEVKIT_SYNC_RECONCILE:-0}" "${DEVKIT_SYNC_PREVIEW:-0}"; do
    [ "$flag" = 0 ] || [ "$flag" = 1 ] || fail 'reconcile and preview must be 0 or 1'
  done
  set -- --non-interactive sync "$root"
  [ "${DEVKIT_SYNC_RECONCILE:-0}" = 0 ] || set -- "$@" --reconcile-lock
  [ "${DEVKIT_SYNC_PREVIEW:-0}" = 0 ] || set -- "$@" --preview
  exec "$engine" "$@"
fi
if [ "$command" = exec ]; then
  if [ "$#" -gt 1 ]; then
    shift
    if [ "$exec_has_root" = 1 ]; then
      exec "$engine" exec "$@"
    fi
    exec "$engine" exec --root "$root" "$@"
  fi
  for flag in "${DEVKIT_EXEC_WRITE:-0}" "${DEVKIT_EXEC_PREPARE:-0}"; do
    [ "$flag" = 0 ] || [ "$flag" = 1 ] || fail 'write and prepare must be 0 or 1'
  done
  set -- exec --root "$root" --network "${DEVKIT_EXEC_NETWORK:-none}"
  [ "${DEVKIT_EXEC_WRITE:-0}" = 0 ] || set -- "$@" --write
  [ "${DEVKIT_EXEC_PREPARE:-0}" = 0 ] || set -- "$@" --prepare
  exec "$engine" "$@"
fi
exec "$engine" task "$command" --root "$root"
