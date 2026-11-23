#!/bin/sh
set -eu

network=bridge
while [ "$#" -gt 0 ]; do
  case "$1" in
    --network)
      [ "$#" -ge 2 ] || { printf 'desktop: --network requires a value\n' >&2; exit 1; }
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

[ "$#" -eq 1 ] || { printf 'Usage: sh desktop/run-in-container.sh [--network none|bridge] -- <shell command>\n' >&2; exit 1; }
[ "$(uname -sm)" = 'Linux x86_64' ] || { printf 'desktop: containerized desktop checks require Linux x86_64\n' >&2; exit 1; }
case "$network" in
  none|bridge) ;;
  *) printf 'desktop: --network must be none or bridge\n' >&2; exit 1 ;;
esac

script_dir=${0%/*}
[ "$script_dir" != "$0" ] || script_dir=.
root=$(CDPATH='' cd -- "$script_dir/.." && pwd -P)
dockerfile="$root/desktop/Dockerfile.check"

hash=$(sha256sum -- "$dockerfile" | awk '{print substr($1, 1, 12)}')
image=${QUOTUM_DESKTOP_CHECK_IMAGE:-"quotum-desktop-check:$hash"}
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build -t "$image" -f "$dockerfile" "$root/desktop"
fi

devkit_cache=${DEVKIT_CACHE_DIR:-"${XDG_CACHE_HOME:-${HOME:?HOME or XDG_CACHE_HOME is required}/.cache}/docouno/devkit"}
cargo_cache="$devkit_cache/cargo"
desktop_home="$devkit_cache/desktop-home"
xdg_cache=${XDG_CACHE_HOME:-"$HOME/.cache"}
npm_cache=${npm_config_cache:-"$HOME/.npm"}
mkdir -p -- "$cargo_cache" "$desktop_home/key-tests" "$xdg_cache" "$npm_cache"
chmod 700 -- "$desktop_home" "$desktop_home/key-tests"

detect_jobs() {
  if [ -n "${DEVKIT_CARGO_BUILD_JOBS:-}" ]; then
    printf '%s\n' "$DEVKIT_CARGO_BUILD_JOBS"
    return
  fi
  if [ -n "${SLOT_CPUS:-}" ]; then
    printf '%s\n' "$SLOT_CPUS"
    return
  fi
  if [ -r /sys/fs/cgroup/cpu.max ]; then
    read -r quota period < /sys/fs/cgroup/cpu.max || true
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

exec docker run --rm --init \
  --network "$network" \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/quotum \
  -e QUOTUM_TEST_PRIVATE_DIR=/home/quotum/key-tests \
  -e CARGO_HOME=/cache/cargo \
  -e CARGO_BUILD_JOBS="$jobs" \
  -e XDG_CACHE_HOME=/cache/xdg \
  -e npm_config_cache=/cache/npm \
  -e RUSTUP_AUTO_INSTALL=0 \
  -v "$desktop_home:/home/quotum" \
  -v "$cargo_cache:/cache/cargo" \
  -v "$xdg_cache:/cache/xdg" \
  -v "$npm_cache:/cache/npm" \
  -v "$root:/work" \
  -w /work \
  "$image" \
  sh -ceu "$1"
