"""Read the frozen two-function experiment's receipts; no application mode."""
import hashlib
import json
import sys
from pathlib import Path
from temporal_ranges import classify, decode, require


def read_json(path, limit):
    data = path.read_bytes()
    require(len(data) <= limit, 'input byte cap')
    return json.loads(data)


def main(directory):
    inputs = read_json(directory / 'mapping-input.json', 65536)
    samples = read_json(directory / 'samples.json', 2 * 1024 * 1024)
    require(0 < len(samples) <= 8192, 'sample cap')
    binding = inputs['binding']
    trace = binding['codeTrace']
    require(trace['complete'] is True and trace['dataLossOccurred'] is False and trace['streamFormat'] == 'proto', 'incomplete capture')
    wire = (directory / 'code-trace.pftrace').read_bytes()
    require(0 < len(wire) <= 2 * 1024 * 1024 and len(wire) == trace['bytes'] and hashlib.sha256(wire).hexdigest() == trace['sha256'], 'trace identity')
    collection = trace['collection']
    require(collection['clock'] == 'CLOCK_MONOTONIC' and collection['perfettoClockId'] == 3, 'collection clock')
    bounds = (int(collection['from']), int(collection['to']))
    require(0 < bounds[0] < bounds[1], 'collection bounds')
    pid = binding['frame']['pid']
    require(pid == binding['process']['pid'] == binding['process']['mainTid'], 'sample process')
    source = binding['source']
    require(len(source['parsed']) == 1 and source['sha256'] == source['receivedHash'] == source['parsed'][0]['hash'], 'source identity')
    script_id = int(source['parsed'][0]['scriptId'])
    require(script_id > 0, 'script identity')
    expected = {phase: (script_id, source['url'], 'calibration' + phase, source['locations'][phase]['line'], source['locations'][phase]['column']) for phase in ['A', 'B']}
    ranges = decode(wire, pid)
    isolates = {r.isolate for r in ranges if r.function in expected.values()}
    require(len(isolates) == 1, 'ambiguous or absent synthetic isolate')
    isolate = isolates.pop()
    classified = []
    last = 0
    for sample in samples:
        require(sample['phase'] in expected and sample['pid'] == sample['tid'] == pid and int(sample['period']) == 250000, 'sample ownership/period')
        timestamp = int(sample['time'])
        require(last <= timestamp and bounds[0] < timestamp < bounds[1], 'sample chronology/collection')
        last = timestamp
        owner = classify(ranges, pid, timestamp, int(sample['ip'], 16), expected_isolate=isolate, collection=bounds)
        name = next((phase for phase, function in expected.items() if owner == function), None)
        classified.append({'phase': sample['phase'], 'time': sample['time'], 'ip': sample['ip'], 'name': name})
    require([phase['phase'] for phase in inputs['phases']] == ['A', 'B'], 'phase order')
    phases = []
    for phase in ['A', 'B']:
        bucket = [sample for sample in classified if sample['phase'] == phase]
        known = sum(sample['name'] == phase for sample in bucket)
        wrong = sum(sample['name'] is not None and sample['name'] != phase for sample in bucket)
        original = next(item for item in inputs['phases'] if item['phase'] == phase)['stopped']
        require(len(bucket) == original['samples'] and known >= 20 and wrong == 0, 'original mapping acceptance')
        phases.append({'phase': phase, 'total': len(bucket), 'known': known, 'wrong': wrong, 'unknown': len(bucket) - known - wrong})
    report = {'status': 'qualified-synthetic-container-mapping', 'pid': pid, 'isolate': isolate, 'phases': phases, 'applicationAdmission': False, 'exclusiveSelfCpu': False}
    (directory / 'classified.json').open('x').write(json.dumps(classified, indent=2) + '\n')
    (directory / 'mapping-result.json').open('x').write(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main(Path(sys.argv[1]))
