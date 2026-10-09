import os
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import tempfile
import unittest
from unittest.mock import patch
from native_evidence import Evidence, identity, paused


class PauseTests(unittest.TestCase):
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
