#!/bin/sh
# Installs the Quotum agent, the `quotum` command, from GitHub Releases:
#
#   curl -fsSL https://github.com/padurets/quotum/releases/latest/download/install.sh | sh
#
# It downloads the binary for this machine, checks it against the release's SHA256SUMS and
# puts it in ~/.local/bin. Nothing else is touched and nothing runs as root. Settings:
#   QUOTUM_INSTALL_DIR   where to put `quotum` (default: ~/.local/bin)
#   QUOTUM_VERSION       a version to install, e.g. 0.3.0 (default: the latest)
#   QUOTUM_RELEASES_URL  where the releases are (default: GitHub)
# Later, `quotum update` keeps it up to date.
#
# Everything is in main, called on the last line: a download cut short runs nothing.

set -eu

say() { printf 'quotum: %s\n' "$*" >&2; }
fail() { say "$*"; exit 1; }

fetch() { # url file
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "needs curl or wget"
  fi
}

# The latest version, from where releases/latest redirects to (…/tag/v0.3.0).
latest() {
  if command -v curl >/dev/null 2>&1; then
    location=$(curl -fsSI -o /dev/null -w '%{redirect_url}' "$1/latest") || fail "cannot reach $1"
  else
    location=$(wget -q -S --max-redirect=0 -O /dev/null "$1/latest" 2>&1 | sed -n 's/^ *[Ll]ocation: *//p' | tr -d '\r' | tail -n 1)
  fi
  version=${location##*/}
  version=${version#v}
  case $version in
    [0-9]*.[0-9]*.[0-9]*) printf '%s\n' "$version" ;;
    *) fail "cannot tell the latest version from $1/latest" ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "needs sha256sum or shasum to check the download"
  fi
}

main() {
  releases=${QUOTUM_RELEASES_URL:-https://github.com/padurets/quotum/releases}
  releases=${releases%/}
  dir=${QUOTUM_INSTALL_DIR:-$HOME/.local/bin}

  case $(uname -s) in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    *) fail "no build for $(uname -s): on Windows use install.ps1, elsewhere build from source" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "no build for $(uname -m)" ;;
  esac
  asset=quotum-cli-$os-$arch

  version=${QUOTUM_VERSION:-$(latest "$releases")}
  version=${version#v}
  say "installing $version ($os-$arch) into $dir"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  fetch "$releases/download/v$version/$asset" "$tmp/quotum"
  fetch "$releases/download/v$version/SHA256SUMS" "$tmp/SHA256SUMS"
  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print tolower($1) }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS of $version has no $asset"
  [ "$(sha256 "$tmp/quotum")" = "$expected" ] || fail "the download does not match its checksum; nothing was installed"

  chmod 755 "$tmp/quotum"
  "$tmp/quotum" --version >/dev/null 2>&1 || fail "the downloaded program does not start on this machine; nothing was installed"
  mkdir -p "$dir"
  # Renamed into place, so a running agent keeps its file and an interrupted install leaves none half-written.
  mv -f "$tmp/quotum" "$dir/.quotum-install.$$"
  mv -f "$dir/.quotum-install.$$" "$dir/quotum"

  say "installed $("$dir/quotum" --version)"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) say "$dir is not on your PATH: add it (e.g. in ~/.profile: export PATH=\"$dir:\$PATH\") or run $dir/quotum" ;;
  esac
  say "next: \`quotum\` shows the limits here; \`quotum connect <hub>\` and \`quotum start\` deliver them to a hub"
}

main "$@"
