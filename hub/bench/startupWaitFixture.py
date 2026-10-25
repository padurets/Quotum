"""One owned-file fault-touch and paired-read batch; no kernel-wait claim."""
import ctypes
import fcntl
import json
import mmap
import os
import re
import stat
import sys
import threading

FD, SIZE, PAGE = 3, 16 * 1024**2, 4096
FIELDS = ("dev", "ino", "size", "mtimeNs", "ctimeNs", "uid")


class Unknown(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Unknown(reason)


def identity(value):
    return dict(zip(FIELDS, map(str, (value.st_dev, value.st_ino, value.st_size,
                    value.st_mtime_ns, value.st_ctime_ns, value.st_uid))))


def run():
    require(len(sys.argv) == 2 and len(sys.argv[1]) <= 2048, "arguments")
    wanted = json.loads(sys.argv[1])
    require(type(wanted) is dict and set(wanted) == set(FIELDS), "identity")
    require(all(type(v) is int and v >= 0 or type(v) is str and
                re.fullmatch(r"0|[1-9][0-9]{0,19}", v) for v in wanted.values()), "identity")
    wanted = {k: str(v) for k, v in wanted.items()}
    with open("/proc/self/status", encoding="ascii") as source:
        uid = re.search(r"^Uid:\s+\d+\s+\d+\s+\d+\s+(\d+)$", source.read(16384), re.M)
    with open("/proc/self/stat", encoding="ascii") as source:
        birth = source.read(4096).rsplit(") ", 1)[1].split()[19]
    before = os.fstat(FD)
    flags = fcntl.fcntl(FD, fcntl.F_GETFL)
    require(stat.S_ISREG(before.st_mode) and before.st_size == SIZE and
            identity(before) == wanted, "identity")
    require(uid is not None and int(uid[1]) == before.st_uid, "owner")
    require(flags & os.O_ACCMODE == os.O_RDONLY and
            not flags & getattr(os, "O_DIRECT", 0), "descriptor")
    require(threading.get_native_id() == os.getpid(), "main-thread")
    require(sys.stdin.buffer.readline(6) == b"start\n", "gate")
    position, page_size = os.lseek(FD, 0, os.SEEK_CUR), os.sysconf("SC_PAGE_SIZE")
    require(page_size > 0 and SIZE % page_size == 0, "page-size")
    os.posix_fadvise(FD, 0, SIZE, os.POSIX_FADV_DONTNEED)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int,
                          ctypes.c_int, ctypes.c_int, ctypes.c_long]
    libc.mmap.restype = ctypes.c_void_p
    libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
    libc.mincore.restype = ctypes.c_int
    libc.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    libc.munmap.restype = ctypes.c_int
    address = libc.mmap(None, SIZE, 0, 2, FD, 0)  # PROT_NONE, MAP_PRIVATE.
    require(address != ctypes.c_void_p(-1).value, "mapping")
    try:
        vector = (ctypes.c_ubyte * (SIZE // page_size))()
        require(libc.mincore(address, SIZE, vector) == 0, "mincore")
        resident = sum(v & 1 for v in vector)
    finally:
        require(libc.munmap(address, SIZE) == 0, "unmap")
    require(identity(os.fstat(FD)) == wanted, "identity-changed")
    require(resident == 0, "resident-pages")
    mapped_touches = 0
    with mmap.mmap(FD, SIZE, access=mmap.ACCESS_READ) as mapped:
        for offset in range(0, SIZE, 1024**2):
            require(mapped[offset] != 0, "read")
            mapped_touches += 1
    require(mapped_touches == 16, "read")
    barrier, counts, errors = threading.Barrier(2), [0, 0], []

    def reads(slot):
        try:
            for offset in range(0, SIZE, 1024**2):
                barrier.wait()
                data = os.pread(FD, PAGE, offset)
                require(len(data) == PAGE and any(data), "read")
                counts[slot] += 1
                barrier.wait()
        except Exception:
            errors.append(True)
            barrier.abort()

    worker = threading.Thread(target=reads, args=(1,))
    worker.start()
    reads(0)
    worker.join()
    require(not errors and counts == [16, 16], "read")
    require(identity(os.fstat(FD)) == wanted and
            os.lseek(FD, 0, os.SEEK_CUR) == position, "identity-changed")
    print(json.dumps({"status": "fixture-read-complete", "pid": os.getpid(),
          "birth": birth, "group": os.getpgrp(), "session": os.getsid(0),
          "owner": int(uid[1]), "fdmeta": wanted, "mainReads": counts[0],
          "threadReads": counts[1], "mappedTouches": mapped_touches,
          "offsets": 16, "pageBytes": PAGE,
          "fdPosition": str(position), "coldstats": {"adviceCalls": 1,
          "mincoreCalls": 1, "pages": SIZE // page_size, "residentPages": resident}},
          separators=(",", ":")), flush=True)
    sys.stdin.buffer.readline(1)  # Parent keeps stdin open, then sends owned SIGTERM.
    return 3


try:
    sys.exit(run())
except Exception as error:
    print(json.dumps({"status": "unknown", "reason": str(error) if
          isinstance(error, Unknown) else "unavailable"}, separators=(",", ":")), flush=True)
    sys.exit(2)
