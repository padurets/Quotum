#!/bin/sh
set -eu

fail() {
  printf 'desktop: %s\n' "$*" >&2
  exit 1
}

require_abs() {
  case "$2" in
    /*) ;;
    *) fail "$1 must be an absolute path: $2" ;;
  esac
}

positive_int() {
  case "$2" in
    ''|*[!0-9]*) fail "$1 must be a positive integer: $2" ;;
    *)
      if [ "$2" -lt 1 ] || [ "$2" -gt 1024 ]; then
        fail "$1 must be between 1 and 1024: $2"
      fi
      printf '%s\n' "$2"
      ;;
  esac
}

network=bridge
while [ "$#" -gt 0 ]; do
  case "$1" in
    --network)
      [ "$#" -ge 2 ] || fail '--network requires a value'
      network=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

[ "$#" -eq 1 ] || fail 'Usage: sh desktop/run-in-container.sh [--network none|bridge] -- <shell command>'
cmd=$1
[ "$(uname -sm)" = 'Linux x86_64' ] || fail 'containerized desktop checks require Linux x86_64'
case "$network" in
  none|bridge) ;;
  *) fail '--network must be none or bridge' ;;
esac

script_dir=${0%/*}
[ "$script_dir" != "$0" ] || script_dir=.
root=$(CDPATH='' cd -- "$script_dir/.." && pwd -P)
dockerfile="$root/desktop/Dockerfile.check"

hash=$(sha256sum -- "$dockerfile" | awk '{print substr($1, 1, 12)}')
image=${QUOTUM_DESKTOP_CHECK_IMAGE:-"quotum-desktop-check:$hash"}
if ! docker image inspect "$image" >/dev/null 2>&1; then
  [ "$network" != none ] || fail "image $image is not built; run make prepare-desktop first"
  # Dockerfile.check copies nothing from the workspace; stream stdin to keep context 0 bytes.
  docker build -t "$image" - < "$dockerfile"
fi

home_dir=${HOME:-}
if [ -n "${XDG_CACHE_HOME:-}" ]; then
  xdg_cache=$XDG_CACHE_HOME
elif [ -n "$home_dir" ]; then
  xdg_cache="$home_dir/.cache"
else
  fail 'HOME or XDG_CACHE_HOME is required'
fi
require_abs XDG_CACHE_HOME "$xdg_cache"

if [ -n "${DEVKIT_CACHE_DIR:-}" ]; then
  devkit_cache=$DEVKIT_CACHE_DIR
else
  devkit_cache="$xdg_cache/docouno/devkit"
fi
require_abs DEVKIT_CACHE_DIR "$devkit_cache"

cargo_cache="$devkit_cache/cargo"
quotum_build_cache="$xdg_cache/quotum-build"
mkdir -p -- "$cargo_cache" "$quotum_build_cache" "$root/desktop/target"

detect_jobs() {
  if [ -n "${DEVKIT_CARGO_BUILD_JOBS:-}" ]; then
    positive_int DEVKIT_CARGO_BUILD_JOBS "$DEVKIT_CARGO_BUILD_JOBS"
    return
  fi
  if [ -n "${DEVKIT_CPUS:-}" ]; then
    cpus=$(positive_int DEVKIT_CPUS "$DEVKIT_CPUS")
    [ "$cpus" -gt 4 ] && cpus=4
    printf '%s\n' "$cpus"
    return
  fi
  if [ -n "${SLOT_CPUS:-}" ]; then
    positive_int SLOT_CPUS "$SLOT_CPUS"
    return
  fi

  cpu_max=''
  if [ -r /proc/self/cgroup ]; then
    cg_rel=$(awk -F: '$1 == "0" && $2 == "" { print $3; exit }' /proc/self/cgroup)
    if [ -n "$cg_rel" ] && [ -r "/sys/fs/cgroup${cg_rel}/cpu.max" ]; then
      cpu_max="/sys/fs/cgroup${cg_rel}/cpu.max"
    fi
  fi
  if [ -z "$cpu_max" ] && [ -r /sys/fs/cgroup/cpu.max ]; then
    cpu_max=/sys/fs/cgroup/cpu.max
  fi
  if [ -n "$cpu_max" ]; then
    read -r quota period < "$cpu_max" || true
    case "$quota:$period" in
      max:*|*:) ;;
      *)
        if [ "$quota" -gt 0 ] 2>/dev/null && [ "$period" -gt 0 ] 2>/dev/null; then
          cpus=$(( (quota + period - 1) / period ))
          [ "$cpus" -lt 1 ] && cpus=1
          [ "$cpus" -gt 4 ] && cpus=4
          printf '%s\n' "$cpus"
          return
        fi
        ;;
    esac
  fi

  cpus=$(nproc 2>/dev/null || printf '2')
  [ "$cpus" -lt 1 ] && cpus=1
  [ "$cpus" -gt 4 ] && cpus=4
  printf '%s\n' "$cpus"
}

jobs=$(detect_jobs)
uid=$(id -u)
gid=$(id -g)

set -- \
  --rm --init \
  --network "$network" \
  --user "$uid:$gid" \
  --tmpfs "/home/quotum:rw,noexec,nosuid,nodev,mode=0700,uid=$uid,gid=$gid" \
  -e HOME=/home/quotum \
  -e QUOTUM_TEST_PRIVATE_DIR=/home/quotum/key-tests \
  -e CARGO_HOME=/cache/cargo \
  -e CARGO_BUILD_JOBS="$jobs" \
  -e XDG_CACHE_HOME=/cache/xdg \
  -e RUSTUP_AUTO_INSTALL=0 \
  -v "$cargo_cache:/cache/cargo"

if [ -d "$devkit_cache/electron" ]; then
  set -- "$@" -v "$devkit_cache/electron:/cache/xdg/electron:ro"
fi

if [ "$network" = none ]; then
  set -- "$@" \
    -e npm_config_cache=/home/quotum/.npm \
    -v "$quotum_build_cache:/cache/xdg/quotum-build:ro" \
    -v "$root:/work:ro" \
    -v "$root/desktop/target:/work/desktop/target"
else
  # prepare.mjs invokes `npx @tauri-apps/cli`, whose binaries and native .node addons execute from npm_config_cache.
  set -- "$@" \
    --tmpfs "/tmp/quotum-npm:rw,exec,nosuid,nodev,mode=0700,uid=$uid,gid=$gid" \
    -e npm_config_cache=/tmp/quotum-npm \
    -v "$quotum_build_cache:/cache/xdg/quotum-build" \
    -v "$root:/work"
fi

exec docker run "$@" -w /work "$image" \
  sh -ceu 'mkdir -m 700 -p /home/quotum/key-tests "$npm_config_cache" && sh -ceu "$1"' _ "$cmd"
