#!/bin/sh
# A successful parent can hide a crashing WebKit child, especially at window teardown.
# Trace exit signals only; this is a lifecycle check, never a performance measurement.
set -eu
log=$1
shift
status=0
strace -f -q -e trace=process -o "$log" "$@" || status=$?
if grep -Eq '\+\+\+ killed by SIG(SEGV|ABRT|BUS|ILL|FPE|TRAP|SYS|QUIT)' "$log"; then
  grep 'killed by SIG' "$log" >&2
  echo 'smoke: a child process crashed' >&2
  exit 1
fi
exit "$status"
