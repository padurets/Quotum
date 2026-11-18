import gdb
import json
import os
import re
import stat

EXPECTED_PID = 0
MAX_SAFE_INTEGER = (1 << 53) - 1
MAX_MAP_BYTES = 1024 * 1024
MAX_MAP_ENTRIES = 8192
REASONS = frozenset(("anonymous-executable", "non-executable", "unmapped",
                     "identity-unavailable", "ambiguous", "deleted",
                     "offset-outside-file", "frame-unavailable",
                     "mapping-changed", "unsupported"))


class Unknown(Exception):
    def __init__(self, reason):
        self.reason = reason if reason in REASONS else "unsupported"


def unknown(index, reason):
    return {"index": index, "status": "unknown",
            "reason": reason if reason in REASONS else "unsupported"}


def maps(pid):
    with open("/proc/%d/maps" % pid, "rb") as stream:
        raw = stream.read(MAX_MAP_BYTES + 1)
    if len(raw) > MAX_MAP_BYTES:
        raise Unknown("unsupported")
    lines = raw.decode("utf-8", "strict").splitlines()
    if len(lines) > MAX_MAP_ENTRIES:
        raise Unknown("unsupported")
    found = []
    for line in lines:
        fields = line.split(None, 5)
        if len(fields) < 5:
            raise Unknown("unsupported")
        address, permissions, offset, device, inode = fields[:5]
        if not re.fullmatch(r"[r-][w-][x-][ps]", permissions):
            raise Unknown("unsupported")
        start, end = (int(value, 16) for value in address.split("-"))
        major, minor = (int(value, 16) for value in device.split(":"))
        offset, inode = int(offset, 16), int(inode)
        if start >= end or min(offset, inode, major, minor) < 0:
            raise Unknown("unsupported")
        found.append((start, end, permissions, offset, major, minor, inode,
                      fields[5] if len(fields) == 6 else ""))
    return raw, found


def fingerprint(path):
    real = os.path.realpath(path)
    value = os.stat(path)
    if real != os.path.realpath(path):
        raise Unknown("mapping-changed")
    if not stat.S_ISREG(value.st_mode):
        raise Unknown("identity-unavailable")
    facts = (value.st_dev, value.st_ino, value.st_mode, value.st_size,
             value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)
    return real, facts


def build_id(objfile):
    value = objfile.build_id
    if not isinstance(value, str) or not re.fullmatch(r"(?:[0-9a-fA-F]{2}){4,64}", value):
        raise Unknown("identity-unavailable")
    return value.lower()


def stopped(inferior):
    if not inferior.is_valid() or inferior.pid != EXPECTED_PID:
        return False
    selected = gdb.selected_inferior()
    if selected.num != inferior.num or selected.pid != EXPECTED_PID:
        return False
    threads = inferior.threads()
    return bool(threads) and all(thread.is_valid() and thread.is_stopped()
                                 and thread.ptid[0] == EXPECTED_PID for thread in threads)


def location(index, pc, entries, objfiles, checks):
    candidates = [entry for entry in entries if entry[0] <= pc < entry[1]]
    if not candidates:
        raise Unknown("unmapped")
    if len(candidates) != 1:
        raise Unknown("ambiguous")
    start, end, permissions, offset, major, minor, inode, path = candidates[0]
    if permissions[2] != "x":
        raise Unknown("non-executable")
    if path.endswith(" (deleted)"):
        raise Unknown("deleted")
    if inode <= 0 or not path.startswith("/"):
        raise Unknown("anonymous-executable")
    if "\\" in path or any(ord(character) < 32 or ord(character) == 127 for character in path):
        raise Unknown("identity-unavailable")
    real = os.path.realpath(path)
    matches = [obj for obj in objfiles if obj.is_valid() and obj.owner is None
               and isinstance(obj.filename, str) and os.path.realpath(obj.filename) == real]
    if len(matches) != 1:
        raise Unknown("ambiguous" if matches else "identity-unavailable")
    obj = matches[0]
    mapped, native = fingerprint(path), fingerprint(obj.filename)
    if mapped != native or mapped[0] != real:
        raise Unknown("identity-unavailable")
    facts = mapped[1]
    if os.major(facts[0]) != major or os.minor(facts[0]) != minor or facts[1] != inode:
        raise Unknown("identity-unavailable")
    identity = build_id(obj)
    file_offset = offset + pc - start
    if file_offset < 0 or file_offset > MAX_SAFE_INTEGER or file_offset >= facts[3]:
        raise Unknown("offset-outside-file")
    checks.append((index, path, obj.filename, mapped, obj, identity))
    return {"index": index, "status": "file-location", "buildId": identity,
            "fileOffset": file_offset}


def collect():
    result = {"status": "unavailable", "tid": EXPECTED_PID, "frames": []}
    saved = None
    try:
        if type(EXPECTED_PID) is not int or not 0 < EXPECTED_PID <= (1 << 31) - 1:
            return result
        inferior = gdb.selected_inferior()
        if not stopped(inferior):
            return result
        mains = [thread for thread in inferior.threads()
                 if thread.is_valid() and thread.ptid[:2] == (EXPECTED_PID, EXPECTED_PID)]
        saved = gdb.selected_thread()
        if len(mains) != 1 or saved is None or not saved.is_valid() or saved.ptid[0] != EXPECTED_PID:
            saved = None
            return result
        mains[0].switch()
        before, entries = maps(EXPECTED_PID)
        objfiles = list(inferior.progspace.objfiles())
        frame, checks = gdb.newest_frame(), []
        for index in range(16):
            if frame is None:
                break
            if not stopped(inferior):
                return {"status": "unavailable", "tid": EXPECTED_PID, "frames": []}
            try:
                if not frame.is_valid():
                    raise Unknown("frame-unavailable")
                pc = int(frame.pc())
            except BaseException:
                result["frames"].append(unknown(index, "frame-unavailable"))
            else:
                try:
                    result["frames"].append(location(index, pc, entries, objfiles, checks))
                except Unknown as error:
                    result["frames"].append(unknown(index, error.reason))
                except BaseException:
                    result["frames"].append(unknown(index, "identity-unavailable"))
            if index == 15:
                break
            try:
                frame = frame.older()
            except BaseException:
                result["frames"].append(unknown(index + 1, "frame-unavailable"))
                break
        if not stopped(inferior):
            return {"status": "unavailable", "tid": EXPECTED_PID, "frames": []}
        after, unused = maps(EXPECTED_PID)
        if before != after:
            result["frames"] = [unknown(row["index"], "mapping-changed") for row in result["frames"]]
        else:
            current_objfiles = list(inferior.progspace.objfiles())
            for index, mapped_path, native_path, original, obj, identity in checks:
                try:
                    matches = [value for value in current_objfiles
                               if value.is_valid() and value.owner is None
                               and isinstance(value.filename, str)
                               and os.path.realpath(value.filename) == original[0]]
                    if (len(matches) != 1 or not obj.is_valid() or obj.owner is not None
                            or build_id(obj) != identity or build_id(matches[0]) != identity
                            or fingerprint(mapped_path) != original or fingerprint(native_path) != original):
                        raise Unknown("mapping-changed")
                except BaseException:
                    result["frames"][index] = unknown(index, "mapping-changed")
        if not stopped(inferior):
            return {"status": "unavailable", "tid": EXPECTED_PID, "frames": []}
        if result["frames"]:
            result["status"] = "observed"
    except BaseException:
        result = {"status": "unavailable", "tid": EXPECTED_PID, "frames": []}
    finally:
        if saved is not None:
            try:
                if not saved.is_valid() or saved.ptid[0] != EXPECTED_PID:
                    raise Unknown("unsupported")
                saved.switch()
            except BaseException:
                result = {"status": "unavailable", "tid": EXPECTED_PID, "frames": []}
    return result


try:
    payload = collect()
except BaseException:
    payload = {"status": "unavailable", "tid": EXPECTED_PID, "frames": []}
try:
    gdb.write("QGDB_MAIN " + json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\n")
except BaseException:
    pass
