"""Isolated Linux stand-ins. Run in a PID/network namespace, never against real clients."""
import argparse
import hashlib
import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument("probe", type=pathlib.Path)
parser.add_argument("--mode", choices=["capture", "adaptive", "slow"], default="adaptive")
parser.add_argument("--seconds", type=int, default=300)
parser.add_argument("--warmup", type=int, default=30)
parser.add_argument("--roots", type=int, default=6)
parser.add_argument("--children", type=int, default=0)
parser.add_argument("--baseline", action="store_true")
parser.add_argument("--churn", action="store_true")
parser.add_argument("--idle", action="store_true")
parser.add_argument("--ui", action="store_true")
parser.add_argument("--unrelated", type=int, default=0)
parser.add_argument("--restore-after", type=int)
parser.add_argument("--stall-sync", action="store_true")
args = parser.parse_args()
probe = args.probe.resolve()
fixture = pathlib.Path(__file__).with_name("client.c")
ticks = os.sysconf("SC_CLK_TCK")


def cgroup_limit(name):
    try:
        return pathlib.Path('/sys/fs/cgroup',name).read_text().strip()
    except FileNotFoundError:
        return None


class Server(http.server.ThreadingHTTPServer):
    def handle_error(self, request, address):
        # A five-second client deadline can close a keep-alive socket during a fixture delay.
        if not isinstance(sys.exception(), (BrokenPipeError, ConnectionResetError)):
            Hub.errors.append(type(sys.exception()).__name__)
            super().handle_error(request, address)


class Hub(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    cursor = 0
    witness = None
    queue = None
    periods = []
    requests = {}
    delayed = False
    errors = []
    operations = []
    latest_history_tick = 0
    positive_context_ms = 0
    unknown_context_ms = 0
    context_counts = []
    started = 0.0
    restoration = None
    slow_enabled = False
    started_wall = 0
    captured_roots = {}
    birth_events = []
    first_capture = None
    discovery_dropped = 0

    @classmethod
    def observe(cls, state, at):
        if state is None or at < cls.started_wall or not cls.started_wall:
            return
        cls.first_capture = at if cls.first_capture is None else min(at, cls.first_capture)
        for context in state["contexts"]:
            identity = context.get("sessionId") or (context["clientId"], context["startedAt"], context["ordinal"])
            previous = cls.captured_roots.get(identity)
            if previous is not None and previous[0] <= at:
                continue
            if previous is None and len(cls.captured_roots) >= 4096:
                cls.discovery_dropped += 1
                continue
            cls.captured_roots[identity] = (at, context["startedAt"])

    @classmethod
    def discovery(cls):
        pending=list(enumerate(cls.birth_events));controlled=[];offsets=[];uncertainty=[];unmatched=0
        for at,birth in sorted(cls.captured_roots.values(),key=lambda row:row[1]):
            if birth<cls.started_wall:
                continue
            nearest=min(pending,key=lambda row:abs(sum(row[1])/2-birth),default=None)
            if nearest is None or abs(sum(nearest[1])/2-birth)>2000:
                unmatched+=1
                continue
            pending.remove(nearest)
            before,after=nearest[1];middle=(before+after)/2
            controlled.append(at-middle);offsets.append(birth-middle);uncertainty.append(after-before)
        return dict(firstCaptureAfterStartMs=None if cls.first_capture is None else cls.first_capture-cls.started_wall,
                    existingRootCaptureMs=sorted(at-cls.started_wall for at,birth in cls.captured_roots.values() if birth<cls.started_wall),
                    newRootBirthToCaptureMs=sorted(at-birth for at,birth in cls.captured_roots.values() if birth>=cls.started_wall),
                    controlledNewRootCaptureMs=sorted(controlled),nativeBirthOffsetMs=offsets,
                    controlledSpawnUncertaintyMs=uncertainty,unmatchedNewRoots=unmatched,
                    dropped=cls.discovery_dropped,basis="capture timestamp before native scan")

    def log_message(self, *_):
        pass

    def do_POST(self):
        size = int(self.headers["content-length"])
        assert size <= 512 * 1024
        body = json.loads(self.rfile.read(size))
        Hub.requests[self.path] = Hub.requests.get(self.path, 0) + 1
        if self.path == "/v1/activity":
            if args.restore_after is not None and Hub.restoration is None and body["op"]=="batch" and time.monotonic()-Hub.started>=args.restore_after:
                Hub.restoration=dict(oldCursor=Hub.cursor,declaredLoss=0)
                Hub.cursor=0
                Hub.latest_history_tick=0
                Hub.positive_context_ms=0
                Hub.unknown_context_ms=0
            states=[body.get("checkpoint"),(body.get("latest") or {}).get("state")]
            states.extend(frame.get("nextState") for frame in body.get("frames",[]))
            Hub.context_counts.extend(len(state["contexts"]) for state in states if state is not None)
            Hub.operations.append(dict(atMs=int(time.monotonic()*1000),op=body["op"],seq=[f["seq"] for f in body.get("frames",[])],latestTick=(body.get("latest") or {}).get("tick")))
            Hub.queue = body["queueId"]
            if body.get("latest") and body.get("clockAnchor"):
                anchor=body["clockAnchor"];latest=body["latest"]
                Hub.observe(latest["state"],anchor["anchorAt"]+latest["tick"]-anchor["anchorTick"])
            scope = body.get("tracking")
            if body["op"] == "hello":
                if body["acknowledgedThrough"]>Hub.cursor:
                    return self.reply({"error":"activity_sequence","expectedSeq":Hub.cursor+1},409)
                digest = hashlib.sha256(json.dumps([scope["clients"], scope["routeDisabled"]], separators=(",", ":")).encode()).hexdigest()
                if Hub.witness is None:
                    Hub.witness = dict(id="c" * 32, topologyVersion=1, scopeDigest=digest, issuedAt=int(time.time() * 1000))
                answer = dict(version=1, protocol="observed-intervals", hubId="a" * 32, deviceId="b" * 32,
                              queueId=Hub.queue, authorityEpoch="d" * 32, floorAt=0, acknowledgedThrough=Hub.cursor,
                              serverTime=int(time.time() * 1000), topologyVersion=1, topologyWitness=Hub.witness)
            else:
                if body["op"] == "batch":
                    state = body.get("checkpoint")
                    if body.get("skip"):
                        if Hub.restoration is not None:
                            Hub.restoration["declaredLoss"]+=max(0,body["skip"]["lastSeq"]-Hub.cursor)
                        Hub.cursor = max(Hub.cursor, body["skip"]["lastSeq"])
                    if body["frames"] and body["frames"][0]["seq"]>Hub.cursor+1:
                        return self.reply({"error":"activity_sequence","expectedSeq":Hub.cursor+1},409)
                    for frame in body["frames"]:
                        Hub.observe(state,frame["fromAt"])
                        Hub.observe(frame.get("nextState"),frame["toAt"])
                        if frame["seq"] <= Hub.cursor:
                            state = frame.get("nextState") or state
                            continue
                        assert frame["seq"] == Hub.cursor + 1
                        Hub.cursor = frame["seq"]
                        Hub.latest_history_tick = max(Hub.latest_history_tick, frame["toTick"])
                        Hub.periods.append(frame["toTick"] - frame["fromTick"])
                        if state:
                            duration=frame["toTick"]-frame["fromTick"]
                            Hub.positive_context_ms+=duration*sum(c["working"] is True for c in state["contexts"])
                            Hub.unknown_context_ms+=duration*sum(c["working"] is None for c in state["contexts"])
                        state=frame.get("nextState") or state
                    if args.mode == "slow" and Hub.slow_enabled and not Hub.delayed:
                        Hub.delayed = True
                        time.sleep(5.5)
                answer = dict(version=1, queueId=Hub.queue, authorityEpoch="d" * 32, acknowledgedThrough=Hub.cursor,
                              releasedWitnesses=body.get("releaseWitnesses", []), topologyVersion=1,
                              coverageRefreshRequired=False, presenceAccepted="latest" in body)
        elif self.path == "/v1/checkin":
            answer = {"subscriptions": [{"measure": True} for _ in body.get("subscriptions", [])]}
        else:
            answer = {"accepted": 0, "version": 1}
        self.reply(answer)

    def reply(self,answer,status=200):
        data = json.dumps(answer).encode()
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def snapshot(pid):
    process = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    threads = {}
    for task in pathlib.Path(f"/proc/{pid}/task").iterdir():
        try:
            stat = (task / "stat").read_text().rsplit(")", 1)[1].split()
            name = (task / "comm").read_text().strip()
            threads[name] = threads.get(name, 0) + (int(stat[11]) + int(stat[12])) / ticks
        except FileNotFoundError:
            pass
    io = {k: int(v) for k, v in (line.split(":") for line in pathlib.Path(f"/proc/{pid}/io").read_text().splitlines())}
    memory = {line.split(":")[0]: int(line.split()[1]) for line in pathlib.Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines() if line.startswith(("Pss:", "Rss:"))}
    return dict(threads=threads, io=io, memoryKiB=memory,
                cpuSeconds=(int(process[11])+int(process[12]))/ticks,
                childCPUSeconds=(int(process[13])+int(process[14]))/ticks)


def journal(root, manifest):
    periods = []
    known = []
    for segment in manifest["segments"]:
        with (root / f'{segment["first"]:016x}.segment').open("rb") as source:
            state = None
            while length := source.read(4):
                length = int.from_bytes(length, "big")
                assert length <= 512 * 1024
                payload = source.read(length)
                assert hashlib.sha256(payload).digest() == source.read(32)
                record = json.loads(payload)
                if state is None:
                    state = record["state"]
                    continue
                if record["seq"] > segment["last"]:
                    break
                periods.append(record["toTick"] - record["fromTick"])
                flags = [c["working"] for c in state["contexts"]]
                Hub.observe(state,record["fromWall"])
                Hub.observe(record.get("nextState"),record["toWall"])
                known.append([record["fromTick"], record["toTick"], flags.count(True), flags.count(False), flags.count(None)])
                state = record.get("nextState") or state
    return dict(pendingPeriodsMs=periods, pendingStates=known)


with tempfile.TemporaryDirectory(prefix="observed-resources-") as temporary:
    root = pathlib.Path(temporary)
    client = root / "codex"
    subprocess.run(["cc", "-O2", "-o", str(client), str(fixture)], check=True)
    (root / "home").mkdir()
    clients = []
    try:
        client_env = dict(os.environ, **({"OBSERVED_IDLE": "1"} if args.idle else {}),**({"OBSERVED_UI":"1"} if args.ui else {}))
        clients = [subprocess.Popen([str(client), str(args.children)], cwd=root, env=client_env) for _ in range(args.roots)]
        clients.extend(subprocess.Popen([str(client), "--noise", str(min(100, args.unrelated - i))], cwd=root, env=dict(os.environ, OBSERVED_IDLE="1")) for i in range(0,args.unrelated,100))
        time.sleep(args.warmup)
        common = dict(mode=args.mode, roots=args.roots, ownedDescendants=args.roots * args.children,
                      warmupSeconds=args.warmup,requestedSeconds=args.seconds,churn=args.churn,stallSync=args.stall_sync,
                      binarySHA256=hashlib.sha256(probe.read_bytes()).hexdigest(), idle=args.idle, uiBursts=args.ui, unrelatedDescendants=args.unrelated,
                      environment=dict(kernel=os.uname().release,clockTicks=ticks,
                          cgroupCPU=cgroup_limit('cpu.max'),cgroupMemory=cgroup_limit('memory.max')))
        if args.mode == "capture":
            for period in [2, 15]:
                command = [str(probe), "cadence", str(args.seconds), str(period), "true"] if args.baseline else [str(probe), "capture", str(args.seconds), str(period), str(root / "home")]
                row = json.loads(subprocess.check_output(command, text=True))
                assert row["sessionCountMin"] == args.roots == row["sessionCountMax"]
                print(json.dumps(dict(common, periodSeconds=period, measurements=row)), flush=True)
        else:
            server = Server(("127.0.0.1", 0), Hub)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            # Keep both CPU sample endpoints inside a complete acceptance window.
            duration = args.seconds + args.warmup + 2
            command = [str(probe), "run", str(duration), str(root / "daemon"), f"http://127.0.0.1:{server.server_port}", str(client), "60000" if args.mode == "slow" else "0"]
            env = dict(os.environ, OBSERVED_VERSION_MS="5000" if args.mode == "slow" else "0")
            if args.stall_sync:
                env["OBSERVED_SYNC_DELAY_MS"]="800"
            bootstrap = None
            if args.mode == "slow":
                initial = command.copy()
                initial[2] = "5"
                initial[-1] = "0"
                bootstrap = json.loads(subprocess.check_output(initial, text=True, env=dict(os.environ, OBSERVED_VERSION_MS="0")))
                manifests=list((root / "daemon/state/activity").glob("*/manifest.json"))
                assert len(manifests)==1 and json.loads(manifests[0].read_text())["binding"] is not None
                Hub.slow_enabled=True
            Hub.started=time.monotonic()
            Hub.started_wall=int(time.time()*1000)
            child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            origin = time.monotonic()
            samples = []
            fixture_cpu = []
            churn_at = 30.0
            while child.poll() is None:
                if args.churn and clients and time.monotonic() - origin >= churn_at:
                    clients[0].terminate()
                    clients[0].wait(timeout=10)
                    before_birth=int(time.time()*1000)
                    clients[0] = subprocess.Popen([str(client), str(args.children)], cwd=root, env=client_env)
                    Hub.birth_events.append((before_birth,int(time.time()*1000)))
                    churn_at += 30.0
                try:
                    samples.append((time.monotonic() - origin, snapshot(child.pid)))
                    if (args.idle or args.ui) and len(fixture_cpu) < 4096:
                        counters = []
                        for client_process in clients[:args.roots]:
                            fields = pathlib.Path(f"/proc/{client_process.pid}/stat").read_text().rsplit(")", 1)[1].split()
                            counters.append((int(fields[11]) + int(fields[12])) * 1000 / ticks)
                        fixture_cpu.append([round((time.monotonic() - origin) * 1000), counters])
                except (FileNotFoundError, ProcessLookupError):
                    pass
                time.sleep(1)
            stdout, stderr = child.communicate(timeout=10)
            assert child.returncode == 0, stderr
            result = json.loads(stdout)
            steady = [s for s in samples if s[0] >= args.warmup]
            assert len(steady) >= args.seconds - 3
            a, b = steady[0], steady[-1]
            seconds = b[0] - a[0]
            assert seconds >= args.seconds, (seconds,args.seconds)
            cpu = {name: (value - a[1]["threads"].get(name, 0)) / seconds * 100 for name, value in b[1]["threads"].items()}
            queue = list((root / "daemon/state/activity").glob("*/manifest.json"))
            assert len(queue) == 1, stderr
            manifest = json.loads(queue[0].read_text())
            row = dict(common, seconds=seconds, bootstrap=bootstrap,steadyThreadCPUPercent=cpu,
                       wholeRun=result, ioDelta={key: value - a[1]["io"].get(key, 0) for key, value in b[1]["io"].items()},
                       maxSteadyMemoryKiB={key: max(s[1]["memoryKiB"][key] for s in steady) for key in ["Rss", "Pss"]},
                       queue=dict(nextSeq=manifest["next_seq"], acknowledgedThrough=manifest["ack"], segments=len(manifest["segments"]), losses=len(manifest["losses"])),
                       journal=journal(queue[0].parent,manifest),
                       requests=Hub.requests, operations=Hub.operations, restoration=Hub.restoration,serverErrors=Hub.errors, deliveredPeriodsMs=Hub.periods,
                       deliveredContextMs=dict(positive=Hub.positive_context_ms,unknown=Hub.unknown_context_ms),stopDelaySeconds=result["wallSeconds"] - duration)
            row["observedContextCounts"]=sorted(set(Hub.context_counts))
            row["fixtureCPUSamplesMs"]=fixture_cpu
            row["discovery"]=Hub.discovery()
            files=[p for p in (root/"daemon/state/activity").rglob('*') if p.is_file()]
            row["queue"]["fileBytes"]=sum(p.stat().st_size for p in files)
            row["queue"]["allocatedBytes"]=sum(p.stat().st_blocks*512 for p in files)
            row["steadyOneCoreCPUPercent"] = 100 * (b[1]["cpuSeconds"]-a[1]["cpuSeconds"] + b[1]["childCPUSeconds"]-a[1]["childCPUSeconds"])/seconds
            row["cpuCeilingPercent"] = 0.1 if args.roots==0 else 1.0 if args.roots>=128 or args.roots*(args.children+1)>=256 else 0.5
            assert Hub.context_counts and max(Hub.context_counts)==args.roots, row
            assert not Hub.errors, row
            assert result["cadenceCostUsesCPU"],row
            assert manifest["next_seq"] > 1, row
            assert row["stopDelaySeconds"] < 6, row
            # Startup calibration repays its cost separately from the acceptance window.
            assert result["costs"]["capture"]["count"] >= int(args.seconds/15), row
            periods=[period for at,period in result["costs"]["capture"]["periodsMs"] if at-period>=args.warmup*1000]
            row["steadyPeriodsMs"]=periods
            assert len(periods)>=max(1,int(args.seconds/15)-1),row
            assert max(periods)<=16_000, row
            if args.stall_sync:
                assert result["syncDelayInjected"] and result["cadenceCostUsesCPU"],row
                assert max(result["costs"][k]["wallMs"]["max"] for k in ["capture","control"])>=750,row
            if args.churn:
                expected=max(0,int((duration-16)/30))
                assert len(row["discovery"]["controlledNewRootCaptureMs"])>=expected and not row["discovery"]["dropped"] and not row["discovery"]["unmatchedNewRoots"],row
            if args.mode == "adaptive" and args.seconds >= 300:
                assert Hub.latest_history_tick >= duration * 1000 - 35_000, row
                assert row["steadyOneCoreCPUPercent"] <= row["cpuCeilingPercent"], row
                if args.roots and not args.idle and not args.ui and args.restore_after is None:
                    assert Hub.positive_context_ms >= (duration-60)*1000*args.roots*0.7, row
            if args.idle or args.ui:
                assert Hub.positive_context_ms == 0, row
                assert all(state[2] == 0 for state in row["journal"]["pendingStates"]), row
            if args.restore_after is not None:
                assert Hub.restoration and Hub.restoration["declaredLoss"]>0,row
            print(json.dumps(row), flush=True)
            server.shutdown()
    finally:
        for child in clients:
            child.terminate()
        for child in clients:
            child.wait(timeout=10)
