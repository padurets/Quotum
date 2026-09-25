#!/usr/bin/env python3
"""Wait for orphaned browser children without ptrace, which interferes with sandboxing.

Live child failures are reported by Electron to the controller. This supervisor also
adopts children that outlive it, checks their exit signals and refuses leftover processes.
It is a lifecycle check, not part of performance measurements.
"""
import argparse
import ctypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

FAULTS = {signal.SIGSEGV, signal.SIGABRT, signal.SIGBUS, signal.SIGILL,
          signal.SIGFPE, signal.SIGTRAP, signal.SIGSYS, signal.SIGQUIT}


def children():
    """Only our own adopted children; never inspect other programs' command lines."""
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[1]) == os.getpid():
                found.append(int(entry.name))
        except (OSError, ValueError, IndexError):
            pass
    return found


def monitor(command, grace, expected_exits=None):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER, for this process only.
        raise OSError(ctypes.get_errno(), 'cannot become a child subreaper')
    process = subprocess.Popen(command, start_new_session=True)
    ended = None
    failure = False
    timed_out = False
    cleanup = None
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid:
            code = os.waitstatus_to_exitcode(status)
            if pid == process.pid:
                process.returncode = code
                ended = time.monotonic()
            if os.WIFSIGNALED(status) and os.WTERMSIG(status) in FAULTS:
                if pid != process.pid or expected_exits is None or 128 - code not in expected_exits:
                    print(f'smoke: process {pid} died from {signal.Signals(os.WTERMSIG(status)).name}', file=sys.stderr)
                    failure = True
            continue
        if ended is not None and time.monotonic() - ended > grace:
            if not timed_out:
                print('smoke: child processes outlived the app', file=sys.stderr)
                timed_out = failure = True
                cleanup = time.monotonic()
            # These are still unreaped direct children, so their PIDs cannot be reused.
            for child in children():
                try:
                    os.kill(child, signal.SIGTERM if time.monotonic() - cleanup < 1 else signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if time.monotonic() - cleanup > 5:
                print('smoke: a child did not respond to termination', file=sys.stderr)
                return 1
        time.sleep(0.01)
    if failure or process.returncode is None:
        return 1
    code = process.returncode if process.returncode >= 0 else 128 - process.returncode
    if expected_exits is not None:
        if code not in expected_exits:
            print(f'smoke: expected wrapper exit {expected_exits}, got {code}', file=sys.stderr)
            return 1
        return 0
    return code


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--grace', type=float, default=10)
    parser.add_argument('--expect-exit', type=int, action='append')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or args.grace <= 0:
        parser.error('a command and a positive grace period are required')
    sys.exit(monitor(command, args.grace, args.expect_exit))
