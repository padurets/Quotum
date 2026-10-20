"""Pinned inputs for the temporary two-function calibration; no global install."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import stat
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
REVISION = 'd10115a34cfa887efd75606c460f541d1b854e23'


def fetch(url, digest, limit):
    with urllib.request.urlopen(url, timeout=10) as response:
        value = response.read(limit + 1)
    assert len(value) <= limit and hashlib.sha256(value).hexdigest() == digest
    return value


def extract_helper(workflow):
    marker = b'''          cat > "$calibration_dir/perf-sample.c" <<'CALIBRATION_C'\n'''
    assert workflow.count(marker) == 1
    body = workflow.split(marker, 1)[1].split(b'          CALIBRATION_C\n', 1)[0]
    lines = body.splitlines(keepends=True)
    assert all(not line.strip() or line.startswith(b'          ') for line in lines)
    result = b''.join(line[10:] if line.startswith(b'          ') else line for line in lines)
    assert hashlib.sha256(result).hexdigest() == '5bef982336dd5db0a746f2dcb5431c82617fdc40c4411e17eb441dfa4a3dd6f9'
    return result


def main():
    module = fetch(f'https://raw.githubusercontent.com/google/perfetto/{REVISION}/python/perfetto/protos/perfetto/trace/perfetto_trace_pb2.py', '417fe08e53f7753e7254972efc6b4c0c35388d5ade06d022a11757f2b6d34cd4', 1_000_000)
    target = ROOT / 'bindings/perfetto/protos/perfetto/trace/perfetto_trace_pb2.py'
    target.parent.mkdir(parents=True)
    target.open('xb').write(module)
    wheel = fetch('https://files.pythonhosted.org/packages/f7/af/ab3c51ab7507a7325e98ffe691d9495ee3d3aa5f589afad65ec920d39821/protobuf-6.31.1-py3-none-any.whl', '720a6c7e6b77288b85063569baae8536671b39f15cc22037ec7045658d80489e', 1_000_000)
    with zipfile.ZipFile(io.BytesIO(wheel)) as archive:
        members = archive.infolist()
        assert len(members) <= 100 and sum(member.file_size for member in members) <= 3 * 1024 * 1024
        assert len({member.filename for member in members}) == len(members)
        for member in members:
            name = PurePosixPath(member.filename)
            assert not name.is_absolute() and '..' not in name.parts and not stat.S_ISLNK(member.external_attr >> 16)
        archive.extractall(ROOT / 'runtime')
    workflow = fetch('https://raw.githubusercontent.com/padurets/Quotum/475df2b5245054da1b1c5bf110cd52255b06c9f6/.github/workflows/ci.yml', 'b7a1c731ca2f7f4ed182c40e39704a5b3a1d44d496cc00fcbf82bfc75a1c1d89', 100_000)
    (ROOT / 'perf-sample.c').open('xb').write(extract_helper(workflow))
    sources = ['control.mjs', 'temporal_ranges.py', 'map_samples.py', 'test_temporal_ranges.py', 'trace-config-first.json', 'bootstrap.py', 'perf-sample.c']
    receipt = {'mode': 'synthetic-only', 'schemaRevision': REVISION, 'inputs': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sources}, 'moduleSha256': hashlib.sha256(module).hexdigest(), 'runtimeWheelSha256': hashlib.sha256(wheel).hexdigest(), 'helperWorkflowSha256': hashlib.sha256(workflow).hexdigest(), 'applicationAdmission': False}
    (ROOT / 'source-inputs.json').open('x').write(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
