"""Owned tmpfs controller. Run under a fixture UID, with only synthetic clients."""
import errno
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time

binary, url, mode = sys.argv[1:4]
root = pathlib.Path("/fixture/run")
for name in ["state", "home", "work"]:
    (root / name).mkdir(parents=True, exist_ok=True)
filler = pathlib.Path("/fixture/filler")
ticks = os.sysconf("SC_CLK_TCK")


def fill():
    try:
        with filler.open("ab", buffering=0) as file:
            while True:
                file.write(bytes(4096))
    except OSError as error:
        assert error.errno == errno.ENOSPC
        return error.errno


def status(child, log):
    queue = None
    for _ in range(3):
        try:
            manifests = list((root / "state/activity").glob("*/manifest.json"))
            queue = None
            if manifests:
                manifest = json.loads(manifests[0].read_text())
                queue = dict(id=manifest["queue_id"], next=manifest["next_seq"], ack=manifest["ack"])
                ends = []
                metadata = json.loads(manifests[0].with_name("metadata.json").read_text())
                for segment in manifest["segments"]:
                    with manifests[0].with_name(f'{segment["first"]:016x}.segment').open("rb") as file:
                        while file.tell() < segment["bytes"]:
                            size = int.from_bytes(file.read(4), "big")
                            payload = file.read(size)
                            assert hashlib.sha256(payload).digest() == file.read(32)
                            record = json.loads(payload)
                            if "seq" in record and record["seq"] <= segment["last"]:
                                anchor = metadata["clocks"].get(record["clockEpoch"], {}).get("anchor")
                                if anchor:
                                    ends.append(anchor["anchorAt"] + record["toTick"] - anchor["anchorTick"])
                queue["end"] = max(ends, default=None)
            break
        except FileNotFoundError:
            continue
    fields = pathlib.Path(f"/proc/{child.pid}/stat").read_text().rsplit(")", 1)[1].split()
    threads = []
    for entry in pathlib.Path(f"/proc/{child.pid}/task").glob("*/comm"):
        try:
            threads.append(entry.read_text().strip())
        except FileNotFoundError:
            pass
    text = log.read_text()
    return dict(pid=child.pid, alive=child.poll() is None, queue=queue,
                capture="quotum-activity" in threads,
                cpuMs=(int(fields[11]) + int(fields[12]) + int(fields[13]) + int(fields[14])) * 1000 / ticks,
                failures=text.count("activity: retrying") + text.count("capture is unavailable"),
                recoveries=text.count("activity: recovered"),
                recovering=text.rfind("activity: retrying") > text.rfind("activity: recovered") or "capture is unavailable" in text,
                at=int(time.time() * 1000))


with tempfile.TemporaryDirectory(prefix="quotum-storage-fixture-") as temporary:
    fixture = pathlib.Path(temporary)
    client = fixture / "codex"
    subprocess.run(["cc", "-O2", str(pathlib.Path(__file__).with_name("client.c")), "-o", str(client)], check=True)
    clients = [subprocess.Popen([str(client), "0"], cwd=fixture) for _ in range(6)]
    collector = fixture / "client-answer"
    collector.write_text('''#!/usr/bin/env python3
import json, sys, time
if "--version" in sys.argv:
    print("codex-cli 0.0.0")
    sys.exit(0)
for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    if method == "initialized":
        continue
    if method == "initialize":
        result = {"userAgent": "codex/0.0.0"}
    elif method == "account/rateLimits/read":
        result = {"accountId": "storage-fixture", "rateLimits": {"planType": "plus", "primary": {
            "usedPercent": 10, "windowDurationMins": 300, "resetsAt": int(time.time()) + 18000}}}
    else:
        raise ValueError("unexpected fixture method")
    print(json.dumps({"id": request["id"], "result": result}), flush=True)
''')
    collector.chmod(0o755)
    log = fixture / "runner.log"
    env = dict(os.environ, QUOTUM_CONFIG=str(fixture / "config.toml"), QUOTUM_STATE_DIR=str(root / "state"),
               QUOTUM_HUB_URL=url, QUOTUM_HUB_TOKEN=os.environ["OBSERVED_TEST_TOKEN"])
    (fixture / "config.toml").write_text(
        'sessions=true\n[clients.codex]\npath=' + json.dumps(str(collector)) + '\n'
        '[clients.claude]\nenabled=false\n[clients.antigravity]\nenabled=false\n[clients.opencode]\nenabled=false\n'
        '[providers.codex]\nenabled=true\n[providers.claude]\nenabled=false\n[providers.antigravity]\nenabled=false\n')
    if mode == "initial":
        fill()
    command = [binary, "run"] if mode != "initial" else [binary, "run", "600", str(root), url, str(client), "1"]
    with log.open("w") as output:
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=output, stderr=output, env=env)
        try:
            for line in sys.stdin:
                op = json.loads(line)["op"]
                if op == "fill":
                    reply = dict(errno=fill(), at=int(time.time() * 1000))
                elif op == "repair":
                    filler.unlink()
                    reply = dict(at=int(time.time() * 1000))
                elif op == "replace":
                    for previous in clients[3:]:
                        previous.terminate()
                        previous.wait(timeout=5)
                    clients[3:] = [subprocess.Popen([str(client), "0"], cwd=fixture, env=dict(os.environ, OBSERVED_IDLE="1")) for _ in range(3)]
                    reply = dict(at=int(time.time() * 1000))
                elif op == "status":
                    reply = status(child, log)
                elif op == "stop":
                    before = time.monotonic()
                    if mode == "initial":
                        child.stdin.write(b"stop\n")
                        child.stdin.flush()
                    else:
                        child.send_signal(signal.SIGTERM)
                    child.wait(timeout=8)
                    reply = dict(stopMs=(time.monotonic() - before) * 1000, code=child.returncode)
                else:
                    raise ValueError("unknown controller operation")
                print(json.dumps(reply), flush=True)
                if op == "stop":
                    break
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=8)
            for client in clients:
                client.terminate()
            for client in clients:
                client.wait(timeout=5)
