"""Bounded native smoke evidence and birth-checked pause ownership on Linux."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import uuid


def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return dict(pid=pid, parent=int(fields[1]), state=fields[0], birth=int(fields[19]))
    except (OSError, ValueError, IndexError):
        return None


def belongs(pid, owner):
    if not owner:
        return False
    current = identity(pid)
    for _ in range(32):
        if not current:
            return False
        if current['pid'] == owner['pid']:
            return current['birth'] == owner['birth']
        current = identity(current['parent']) if current['parent'] > 1 else None
    return False


@contextmanager
def paused(process, owner, record=lambda *args, **kwargs: None):
    """A pidfd keeps resume attached to exactly the process that was stopped."""
    if not process or not belongs(process['pid'], owner):
        raise RuntimeError('pause target ownership unavailable')
    fd = os.pidfd_open(process['pid'])
    stopped = False
    try:
        current = identity(process['pid'])
        if not current or current['birth'] != process['birth'] or not belongs(process['pid'], owner):
            raise RuntimeError('pause target identity changed')
        signal.pidfd_send_signal(fd, signal.SIGSTOP)
        stopped = True
        record('paused', process=process)
        yield
    finally:
        try:
            if stopped:
                try:
                    signal.pidfd_send_signal(fd, signal.SIGCONT)
                except ProcessLookupError:
                    pass
                record('resumed', process=process)
        finally:
            os.close(fd)


class Evidence:
    def __init__(self, executable):
        root = os.environ.get('QUOTUM_SMOKE_DIAGNOSTICS_DIR')
        self.directory = Path(root) / str(uuid.uuid4()) if root else None
        self.started = time.monotonic()
        self.records = []
        self.omitted = 0
        self.status = 'running'
        try:
            self.sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True, stderr=subprocess.DEVNULL, timeout=1).strip()
        except (OSError, subprocess.SubprocessError):
            self.sha = None
        self.errors = []
        self.package = None
        if self.directory:
            self.directory.mkdir(parents=True, exist_ok=True)
        self.save()
        try:
            with open(executable, 'rb') as source:
                digest = hashlib.sha256()
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(chunk)
                self.package = digest.hexdigest()
        except OSError:
            self.errors.append('package hash unavailable')
        self.save()

    def record(self, stage, **values):
        if len(self.records) < 1000:
            self.records.append(dict(stage=stage, ms=round((time.monotonic()-self.started)*1000, 3), **values))
        else:
            self.omitted += 1
        self.save()

    def product(self, root):
        # Fixed numeric messages only; arbitrary controller/provider logs stay private.
        path = root / 'app/logs/hub.log'
        try:
            with path.open('rb') as stream:
                size = path.stat().st_size
                stream.seek(max(0, size-131072))
                lines = stream.read(131072).decode(errors='replace').splitlines()
            events = []
            patterns = [('engine-start', r'app: Chromium starts \(pid (\d+)\)'),
                        ('main-accepted', r'app: main window request (\d+)'),
                        ('panel-painted', r'app: panel (\d+) painted \(window (\d+)\)'),
                        ('panel-visible', r'app: panel (\d+) visible'),
                        ('panel-closed', r'app: panel (\d+) closed \(blur (true|false)\)')]
            for line in lines:
                for stage, pattern in patterns:
                    match = re.search(pattern + r'$', line)
                    if match:
                        events.append(dict(stage=stage, values=[int(v) if v.isdigit() else v == 'true' for v in match.groups()]))
                        break
            self.record('product-events', events=events[-256:], truncated=size > 131072 or len(events) > 256)
        except OSError:
            self.record('product-evidence-unavailable')

    def save(self):
        if not self.directory:
            return
        try:
            data = json.dumps(dict(records=self.records, omitted=self.omitted)).encode()
            if len(data) > 1048576:
                data = b'{"status":"insufficient-evidence","reason":"size limit"}'
            temporary = self.directory / 'timeline.json.tmp'
            temporary.write_bytes(data)
            temporary.replace(self.directory / 'timeline.json')
            manifest = dict(schemaVersion=1, status=self.status, sha=self.sha,
                            run=os.environ.get('GITHUB_RUN_ID'), attempt=os.environ.get('GITHUB_RUN_ATTEMPT'),
                            platform='linux', packageHash=self.package, errors=self.errors,
                            files=[dict(name='timeline.json', bytes=len(data), sha256=hashlib.sha256(data).hexdigest())])
            temporary = self.directory / 'manifest.json.tmp'
            temporary.write_text(json.dumps(manifest))
            temporary.replace(self.directory / 'manifest.json')
        except OSError:
            self.errors = ['evidence write failed']

    def finish(self, status):
        self.status = status
        self.save()
