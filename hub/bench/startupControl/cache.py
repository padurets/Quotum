#!/usr/bin/python3
"""Once-per-arm target-file advice. Never run on a shared or local machine."""
import ctypes
import json
import mmap
import os
import pathlib
import stat
import sys
import time

root = pathlib.Path(sys.argv[1])
c = json.loads((root / 'config.json').read_text())
out = {'status': 'unavailable', 'reason': 'qualification-not-established', 'adviceCalls': 0,
       'mincoreCalls': 0, 'isolatedCiAttested': c.get('isolatedCiAttested') is True}

def ident(s):
    return dict(zip(('dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'),
                    map(str, (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns))))

try:
    if not (os.environ.get('CI') == 'true' and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.geteuid() == 0 and c.get('isolatedCiAttested') is True
            and c['elf'] == '/opt/google/chrome/chrome'):
        raise RuntimeError('scope-or-permission')
    fd = os.open(c['elf'], os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or ident(s) != c['expected'] or not 0 < s.st_size <= 1024**3:
            raise RuntimeError('identity-or-owner')
        page = os.sysconf('SC_PAGE_SIZE'); length = ((s.st_size + page - 1) // page) * page
        out.update(pages=length // page, beforeNs=str(time.monotonic_ns()))
        os.posix_fadvise(fd, 0, length, os.POSIX_FADV_DONTNEED); out['adviceCalls'] = 1
        lib = ctypes.CDLL(None, use_errno=True)
        lib.mmap.restype = ctypes.c_void_p
        lib.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
        lib.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
        lib.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        address = lib.mmap(None, length, 0, mmap.MAP_PRIVATE, fd, 0)
        if address == ctypes.c_void_p(-1).value:
            raise RuntimeError('mapping-unavailable')
        try:
            vec = (ctypes.c_ubyte * (length // page))()
            out['mincoreCalls'] = 1
            if lib.mincore(address, length, vec) != 0:
                raise RuntimeError('mincore-unavailable')
            out['residentPages'] = sum(value & 1 for value in vec)
        finally:
            if lib.munmap(address, length) != 0:
                raise RuntimeError('unmap-unconfirmed')
        if ident(os.fstat(fd)) != c['expected'] or ident(os.stat(c['elf'], follow_symlinks=False)) != c['expected']:
            raise RuntimeError('identity-change')
        out.update(afterNs=str(time.monotonic_ns()), status='cold-snapshot' if out['residentPages'] == 0 else 'unavailable',
                   reason='snapshot-only' if out['residentPages'] == 0 else 'resident-pages')
    finally:
        os.close(fd)
except RuntimeError as error:
    if error.args and error.args[0] in ('scope-or-permission', 'identity-or-owner', 'mapping-unavailable',
                                        'mincore-unavailable', 'unmap-unconfirmed', 'identity-change'):
        out['reason'] = error.args[0]
except Exception:
    # No raw errors/paths, retry, extra advice, install, or fallback.
    pass
print(json.dumps(out, separators=(',', ':')))
