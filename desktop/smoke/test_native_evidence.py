import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from native_evidence import identity, paused


class PauseTests(unittest.TestCase):
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
