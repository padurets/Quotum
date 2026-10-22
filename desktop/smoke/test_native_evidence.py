import ast
from contextlib import ExitStack
import os
import hashlib
import inspect
import json
from pathlib import Path
import subprocess
import sys
import time
import tempfile
import signal
import native_evidence
import unittest
from unittest.mock import patch
from native_evidence import Evidence, identity, paused


class PauseTests(unittest.TestCase):
    def test_panel_wait_pauses_before_observer_work_and_resumes_after_snapshot_failure(self):
        source = Path(__file__).with_name('panel.py')
        wait = next(node for node in ast.walk(ast.parse(source.read_text()))
                    if isinstance(node, ast.FunctionDef) and node.name == 'wait')
        code = compile(ast.Module(body=[wait], type_ignores=[]), str(source), 'exec')
        for failing_snapshot in (False, True):
            with self.subTest(failing_snapshot=failing_snapshot), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                ready = root / 'ready'
                with patch.dict(os.environ, {'QUOTUM_SMOKE_DIAGNOSTICS_DIR': str(root / 'evidence')}):
                    evidence = Evidence(sys.executable)
                child = subprocess.Popen([sys.executable, '-c',
                    "import sys,time;from pathlib import Path;print('waiting',flush=True);"
                    "sys.stdin.buffer.read(1);Path(sys.argv[1]).write_text('ready');time.sleep(60)",
                    str(ready)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
                try:
                    self.assertEqual(child.stdout.readline(), b'waiting\n')
                    writes = []
                    original = RuntimeError('controlled snapshot failure')
                    write_bytes, write_text = Path.write_bytes, Path.write_text

                    def checked_write(method, path, *args, **kwargs):
                        self.assertEqual(native_evidence._pause_depth, 0, 'evidence published before resume')
                        writes.append(path.name)
                        return method(path, *args, **kwargs)

                    def snapshot(stage):
                        self.assertEqual(writes, [], 'observer writes preceded the engine pause')
                        until = time.monotonic() + 1
                        while identity(child.pid)['state'] != 'T' and time.monotonic() < until:
                            time.sleep(.001)
                        self.assertEqual(identity(child.pid)['state'], 'T')
                        child.stdin.write(b'x')
                        child.stdin.flush()
                        time.sleep(.05)
                        self.assertFalse(ready.exists(), 'observer work let the engine finish before the assertion')
                        evidence.record(stage)
                        if failing_snapshot:
                            raise original

                    context = dict(time=time, inspect=inspect, child=child, evidence=evidence,
                                   snapshot=snapshot, scenario='controlled-panel-wait', paused=paused,
                                   identity=identity, controller=identity(os.getpid()))
                    exec(code, context)

                    def observe():
                        with ExitStack() as pausing:
                            self.assertEqual(context['wait'](lambda: child.pid, pausing), child.pid)
                            self.assertFalse(ready.exists())

                    with patch.object(native_evidence, '_pause_depth', 0), \
                         patch.object(native_evidence, '_resume_failed', False), \
                         patch.object(Path, 'write_bytes', lambda path, *a, **kw: checked_write(write_bytes, path, *a, **kw)), \
                         patch.object(Path, 'write_text', lambda path, *a, **kw: checked_write(write_text, path, *a, **kw)):
                        if failing_snapshot:
                            with self.assertRaisesRegex(RuntimeError, 'controlled snapshot failure') as caught:
                                observe()
                            self.assertIs(caught.exception, original)
                        else:
                            observe()
                    until = time.monotonic() + 1
                    while not ready.exists() and time.monotonic() < until:
                        time.sleep(.001)
                    self.assertTrue(ready.exists(), 'the same engine resumes after observation')
                    self.assertEqual(writes, ['timeline.json.tmp', 'manifest.json.tmp'])
                    saved = json.loads((evidence.directory / 'timeline.json').read_text())
                    self.assertEqual([row['stage'] for row in saved['records']],
                                     ['paused', 'wait-complete', 'resumed'])
                finally:
                    if child.poll() is None:
                        child.send_signal(signal.SIGCONT)
                        child.terminate()
                    child.wait(timeout=3)
                    child.stdin.close()
                    child.stdout.close()

    def test_partial_evidence_hashes_safe_events_before_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            executable = root / 'fixture'
            executable.write_bytes(b'fixture package')
            with patch.dict(os.environ, {'QUOTUM_SMOKE_DIAGNOSTICS_DIR': str(root / 'evidence')}):
                evidence = Evidence(executable)
                self.assertEqual(evidence.package, hashlib.sha256(b'fixture package').hexdigest())
                log = root / 'app/logs/hub.log'
                log.parent.mkdir(parents=True)
                log.write_text('private-canary\napp: Chromium starts (pid 123)\napp: panel 8 visible\n')
                evidence.product(root)
                manifest = json.loads((evidence.directory / 'manifest.json').read_text())
                body = (evidence.directory / 'timeline.json').read_bytes()
                self.assertEqual(manifest['status'], 'running')
                self.assertEqual(manifest['files'][0]['sha256'], hashlib.sha256(body).hexdigest())
                self.assertNotIn(b'private-canary', body)
                self.assertIn(b'123', body)
                evidence.finish('failed')
                self.assertEqual(json.loads((evidence.directory / 'manifest.json').read_text())['status'], 'failed')

    def test_exception_after_stop_always_resumes_the_same_process(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        try:
            def fail(stage, **values):
                if stage == 'paused':
                    raise RuntimeError('controlled evidence failure')
            with self.assertRaisesRegex(RuntimeError, 'controlled evidence'):
                with paused(identity(child.pid), identity(os.getpid()), fail):
                    self.fail('evidence should fail before the scenario')
            until = time.monotonic()+1
            while identity(child.pid)['state'] == 'T' and time.monotonic() < until:
                time.sleep(.01)
            self.assertNotEqual(identity(child.pid)['state'], 'T')
        finally:
            child.terminate()
            child.wait(timeout=3)

    def test_nested_pause_keeps_actual_file_writes_after_outer_resume(self):
        children = [subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']) for _ in range(2)]
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                executable = root / 'fixture'
                executable.write_bytes(b'fixture package')
                with patch.dict(os.environ, {'QUOTUM_SMOKE_DIAGNOSTICS_DIR': str(root / 'evidence')}):
                    evidence = Evidence(executable)
                active = set()
                writes = []
                send = signal.pidfd_send_signal
                write_bytes, write_text = Path.write_bytes, Path.write_text

                def checked_signal(fd, kind, *args, **kwargs):
                    send(fd, kind, *args, **kwargs)
                    if kind == signal.SIGSTOP:
                        active.add(fd)
                    elif kind == signal.SIGCONT:
                        active.remove(fd)

                def checked_write(method, path, *args, **kwargs):
                    self.assertFalse(active, 'filesystem I/O while an owned process is paused')
                    writes.append(path.name)
                    return method(path, *args, **kwargs)

                with patch.object(native_evidence, '_pause_depth', 0, create=True), \
                     patch.object(native_evidence, '_resume_failed', False, create=True), \
                     patch('native_evidence.signal.pidfd_send_signal', checked_signal), \
                     patch.object(Path, 'write_bytes', lambda path, *args, **kwargs: checked_write(write_bytes, path, *args, **kwargs)), \
                     patch.object(Path, 'write_text', lambda path, *args, **kwargs: checked_write(write_text, path, *args, **kwargs)):
                    with self.assertRaisesRegex(RuntimeError, 'original nested scenario'):
                        with paused(identity(children[0].pid), identity(os.getpid()), evidence.record):
                            evidence.record('outer-observation')
                            with paused(identity(children[1].pid), identity(os.getpid()), evidence.record):
                                evidence.record('inner-observation')
                                original = [(row['stage'], row['ms']) for row in evidence.records]
                                raise RuntimeError('original nested scenario')
                    self.assertFalse(active)
                    self.assertEqual(writes, ['timeline.json.tmp', 'manifest.json.tmp'])
                saved = json.loads((evidence.directory / 'timeline.json').read_text())['records']
                self.assertEqual([(row['stage'], row['ms']) for row in saved[:len(original)]], original)
                self.assertEqual([row['stage'] for row in saved[-2:]], ['resumed', 'resumed'])
                manifest = json.loads((evidence.directory / 'manifest.json').read_text())
                self.assertEqual(manifest['files'][0]['sha256'], hashlib.sha256((evidence.directory / 'timeline.json').read_bytes()).hexdigest())
        finally:
            for child in children:
                os.kill(child.pid, signal.SIGCONT)
                child.terminate()
                child.wait(timeout=3)

    def test_pause_bounds_and_failed_flush_preserve_original_scenario(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                executable = root / 'fixture'
                executable.write_bytes(b'fixture package')
                with patch.dict(os.environ, {'QUOTUM_SMOKE_DIAGNOSTICS_DIR': str(root / 'evidence')}):
                    evidence = Evidence(executable)
                send = signal.pidfd_send_signal
                active = set()
                writes = []

                def checked_signal(fd, kind, *args, **kwargs):
                    send(fd, kind, *args, **kwargs)
                    if kind == signal.SIGSTOP:
                        active.add(fd)
                    elif kind == signal.SIGCONT:
                        active.remove(fd)

                def failing_write(path, *args, **kwargs):
                    self.assertFalse(active, 'failed writer entered before resume')
                    writes.append(path.name)
                    raise OSError('controlled unavailable evidence sink')

                with patch.object(native_evidence, '_pause_depth', 0, create=True), \
                     patch.object(native_evidence, '_resume_failed', False, create=True), \
                     patch('native_evidence.signal.pidfd_send_signal', checked_signal), \
                     patch.object(Path, 'write_bytes', failing_write):
                    with self.assertRaisesRegex(RuntimeError, 'original bounded scenario'):
                        with paused(identity(child.pid), identity(os.getpid()), evidence.record):
                            for index in range(1005):
                                evidence.record('bounded-observation', ordinal=index)
                            self.assertEqual(len(evidence.records), 1000)
                            self.assertEqual(evidence.omitted, 6)
                            self.assertEqual(writes, [])
                            raise RuntimeError('original bounded scenario')
                    self.assertFalse(active)
                    self.assertEqual(writes, ['timeline.json.tmp'])
                    self.assertEqual(evidence.omitted, 7)
                    self.assertEqual(evidence.errors, ['evidence write failed'])
        finally:
            os.kill(child.pid, signal.SIGCONT)
            child.terminate()
            child.wait(timeout=3)

    def test_resume_failure_is_unavailable_and_does_not_replace_scenario_failure(self):
        for scenario_fails in (False, True):
            with self.subTest(scenario_fails=scenario_fails):
                child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
                try:
                    with tempfile.TemporaryDirectory() as directory:
                        root = Path(directory)
                        executable = root / 'fixture'
                        executable.write_bytes(b'fixture package')
                        with patch.dict(os.environ, {'QUOTUM_SMOKE_DIAGNOSTICS_DIR': str(root / 'evidence')}):
                            evidence = Evidence(executable)
                        send = signal.pidfd_send_signal

                        def failed_resume(fd, kind, *args, **kwargs):
                            if kind == signal.SIGCONT:
                                raise OSError('controlled resume failure')
                            return send(fd, kind, *args, **kwargs)

                        with patch.object(native_evidence, '_pause_depth', 0, create=True), \
                             patch.object(native_evidence, '_resume_failed', False, create=True), \
                             patch('native_evidence.signal.pidfd_send_signal', failed_resume), \
                             patch.object(Path, 'write_bytes', side_effect=AssertionError('uncertain resume allowed a file write')):
                            expected = 'original scenario' if scenario_fails else 'native resume failed; evidence unavailable'
                            original = RuntimeError('original scenario')
                            with self.assertRaisesRegex(RuntimeError, expected) as caught:
                                with paused(identity(child.pid), identity(os.getpid()), evidence.record):
                                    if scenario_fails:
                                        raise original
                            self.assertTrue(native_evidence._resume_failed)
                            self.assertNotIn('resumed', [row['stage'] for row in evidence.records])
                            self.assertEqual(evidence.records[-1]['stage'], 'resume-failed')
                            if scenario_fails:
                                self.assertIs(caught.exception, original)
                            evidence.finish('failed')
                finally:
                    os.kill(child.pid, signal.SIGCONT)
                    child.terminate()
                    child.wait(timeout=3)

    def test_foreign_and_changed_birth_are_not_signalled(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        try:
            for process, owner in [(identity(os.getpid()), identity(child.pid)),
                                   ({**identity(child.pid), 'birth': 0}, identity(os.getpid()))]:
                with self.assertRaisesRegex(RuntimeError, 'ownership|identity'):
                    with paused(process, owner):
                        self.fail('unowned process was paused')
            self.assertNotEqual(identity(child.pid)['state'], 'T')
        finally:
            child.terminate()
            child.wait(timeout=3)


if __name__ == '__main__':
    unittest.main()
