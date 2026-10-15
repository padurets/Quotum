#!/usr/bin/python3
"""GO-gated startup diagnostic launcher. No cache advice or hashing in this process."""
import json
import os
import pathlib
import stat
import subprocess
import sys
import time

root = pathlib.Path(__file__).absolute().parent
config = json.loads((root / 'config.json').read_text())
if config.get('arm') not in ('A', 'B') or not os.path.isabs(config['launcher']):
    sys.exit(125)

def identity(s):
    return dict(zip(('dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'),
                    map(str, (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns))))

def save(name, value):
    # Four fixed small files at most; neither raw argv nor paths enter these receipts.
    value.update(pid=os.getpid(), parent=os.getppid(), group=os.getpgrp(),
                 session=os.getsid(0), monotonicNs=str(time.monotonic_ns()))
    p = root / (name + '.json')
    with p.open('x') as out:
        json.dump(value, out, separators=(',', ':'))

while True:
    try:
        if (root / 'GO').read_text() == config['nonce']:
            break
    except FileNotFoundError:
        pass
    time.sleep(0.005)

save('wrapper-go', {'stage': 'go-observed'})
save('wrapper-open', {'stage': 'open-start'})  # A FIFO/open stall remains inside the original20 s.
fd = None
try:
    fd = os.open(config['elf'], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    before = os.fstat(fd)
    offset_before = os.lseek(fd, 0, os.SEEK_CUR)
    if not stat.S_ISREG(before.st_mode) or identity(before) != config['expected'] or offset_before != 0:
        save('wrapper-terminal', {'status': 'unavailable', 'reason': 'fd-identity-change'})
        sys.exit(125)
    if config['arm'] == 'B':
        save('wrapper-read', {'stage': 'read-start', 'expectedBytes': before.st_size,
                              'offset': offset_before, 'fdBefore': identity(before)})
        result = subprocess.run(['/usr/bin/cat', '--'], stdin=fd, stdout=subprocess.DEVNULL)
        if result.returncode != 0:
            save('wrapper-terminal', {'status': 'failed', 'reason': 'read-error', 'code': result.returncode})
            sys.exit(125)
    offset_after = os.lseek(fd, 0, os.SEEK_CUR)
    after = identity(os.fstat(fd)); pathname = identity(os.stat(config['elf'], follow_symlinks=False))
    expected_offset = before.st_size if config['arm'] == 'B' else 0
    if after != config['expected'] or pathname != config['expected'] or offset_after != expected_offset:
        save('wrapper-terminal', {'status': 'unavailable', 'reason': 'fd-path-or-offset-change'})
        sys.exit(125)
    result = {'status': 'exec-requested', 'armId': 0 if config['arm'] == 'A' else 1,
              'fdBefore': identity(before), 'fdAfter': after, 'pathAfter': pathname,
              'offsetBefore': offset_before, 'offsetAfter': offset_after, 'size': before.st_size}
except OSError as error:
    save('wrapper-terminal', {'status': 'failed', 'reason': 'open-or-read-error', 'errno': error.errno})
    sys.exit(125)
finally:
    if fd is not None:
        os.close(fd)
save('wrapper-terminal', result)
os.execv(config['launcher'], [config['launcher'], *sys.argv[1:]])
