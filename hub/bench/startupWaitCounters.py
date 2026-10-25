"""Read only the supplied owned tracer identities and their live BPF fdinfo."""
import json
import os
import pathlib
import re
import sys
import time

PROC = pathlib.Path("/proc")
NAME = "folio_wait_bit_common"
KEYS = ("pid", "birth", "group", "session", "uid")


class Unknown(Exception):
    pass


def need(value, reason):
    if not value:
        raise Unknown(reason)


def read(file):
    fd = os.open(file, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        value = os.read(fd, 4097)
        need(len(value) <= 4096, "fd-cap")
        return value.decode("ascii")
    finally:
        os.close(fd)


def decimal(value):
    need(type(value) is int and 0 <= value < 2**64 or
         type(value) is str and re.fullmatch(r"0|[1-9][0-9]{0,19}", value), "guard")
    number = int(value)
    need(number < 2**64, "guard")
    return str(number)


def identity(wanted):
    pid = wanted["pid"]
    fields = read(PROC / pid / "stat").rsplit(") ", 1)[1].split()
    uid = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$",
                    read(PROC / pid / "status"), re.M)
    need(uid is not None and all(value == wanted["uid"] for value in uid.groups()), "identity")
    got = dict(zip(KEYS, (pid, fields[19], fields[2], fields[3], wanted["uid"])))
    need(got == wanted, "identity")
    return got


def fields(text):
    result = {}
    wanted = {"link_type", "link_id", "prog_id", "kprobe_cnt", "missed",
              "prog_type", "recursion_misses", "run_cnt"}
    for key, value in re.findall(r"^([a-z_]+):\s+([0-9]+)$", text, re.M):
        if key not in wanted:
            continue
        need(key not in result, "duplicate-field")
        result[key] = decimal(value)
    return result


def table(directory):
    values = sorted(os.listdir(directory), key=lambda value: int(value))
    need(len(values) <= 256 and all(re.fullmatch(r"0|[1-9][0-9]{0,6}", value) for value in values), "fd-cap")
    return values


def holder(wanted):
    identity(wanted)
    directory = PROC / wanted["pid"] / "fdinfo"
    before = table(directory)
    links, programs = {}, {}
    for fd in before:
        text = read(directory / fd)
        row = fields(text)
        if row.get("link_type") == "8":  # BPF_LINK_TYPE_KPROBE_MULTI, Linux UAPI.
            need(row.get("kprobe_cnt") == "1" and "missed" in row, "not-multi")
            need(len(re.findall(r"^\s*[0-9]+\s+folio_wait_bit_common(?:\+0x[0-9a-fA-F]+/0x[0-9a-fA-F]+)?\s*$", text, re.M)) == 1, "function")
            need("link_id" in row and "prog_id" in row, "missing-counters")
            key = row["link_id"]
            value = {"fd": int(fd), "linkId": key, "progId": row["prog_id"],
                     "kprobeCount": 1, "missed": row["missed"]}
            need(key not in links, "duplicate-link")
            links[key] = value
        elif "prog_type" in row and row.get("prog_type") == "2":
            need(all(key in row for key in ("prog_id", "recursion_misses", "run_cnt")), "missing-counters")
            key = row["prog_id"]
            need(key not in programs, "duplicate-program")
            programs[key] = {"fd": int(fd), "progId": key, "progType": 2,
                             "runCount": row["run_cnt"], "recursionMisses": row["recursion_misses"]}
    need(table(directory) == before and identity(wanted) == wanted, "identity")
    if not links:
        return None
    need(len(links) == 2 and len({value["progId"] for value in links.values()}) == 2, "missing-counters")
    needed = {value["progId"] for value in links.values()}
    need(needed <= programs.keys(), "missing-counters")
    return {"holder": wanted, "links": sorted(links.values(), key=lambda value: int(value["linkId"])),
            "programs": sorted((programs[key] for key in needed), key=lambda value: int(value["progId"]))}


def collect(config):
    started = time.monotonic_ns()
    result = {"status": "unknown", "reason": "guard", "statsEnabled": None}
    try:
        need(os.geteuid() == 0 and type(config) is dict and
             set(config) == {"owned", "expectedFunction"} and config["expectedFunction"] == NAME, "guard")
        need(type(config["owned"]) is list and 0 < len(config["owned"]) <= 16, "guard")
        wanted = []
        for value in config["owned"]:
            need(type(value) is dict and set(value) == set(KEYS), "guard")
            row = {key: decimal(value[key]) for key in KEYS}
            need(row["uid"] == "0" and all(int(row[key]) > 0 for key in KEYS[:-1]) and int(row["pid"]) < 2**31, "guard")
            wanted.append(row)
        need(len({row["pid"] for row in wanted}) == len(wanted), "guard")
        states = [value for row in wanted if (value := holder(row)) is not None]
        need(len(states) == 1, "holder-ambiguous")
        result.update(states[0])
        try:
            enabled = read(PROC / "sys/kernel/bpf_stats_enabled").strip()
            if enabled in ("0", "1"):
                result["statsEnabled"] = int(enabled)
        except OSError:
            pass
        # Miss counters are maintained even when optional run-time statistics are off.
        need(all(value["missed"] == "0" for value in result["links"]) and
             all(value["recursionMisses"] == "0" for value in result["programs"]), "kernel-misses")
        result.update(status="observed", reason="zero-kernel-misses")
    except Unknown as error:
        result["reason"] = error.args[0]
    except Exception:
        result["reason"] = "unavailable"
    result["elapsedNs"] = str(time.monotonic_ns() - started)
    return result


if __name__ == "__main__":
    try:
        need(len(sys.argv) == 2 and len(sys.argv[1]) <= 8192, "guard")
        output = collect(json.loads(sys.argv[1]))
    except Exception:
        output = {"status": "unknown", "reason": "guard", "elapsedNs": "0", "statsEnabled": None}
    print(json.dumps(output, separators=(",", ":")))
