import os
from pathlib import Path
import subprocess
import sys
import time
import unittest

MONITOR = Path(__file__).with_name('monitor.py')


class MonitorTests(unittest.TestCase):
    def run_script(self, script, grace=3):
        return subprocess.run([sys.executable, str(MONITOR), '--grace', str(grace), '--',
                               sys.executable, '-c', script], capture_output=True, text=True, timeout=10)

    def test_keeps_the_apps_exit_code(self):
        self.assertEqual(self.run_script('pass').returncode, 0)
        self.assertEqual(self.run_script('raise SystemExit(7)').returncode, 7)

    def test_waits_for_a_child_after_its_parent_exits(self):
        start = time.monotonic()
        result = self.run_script("import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(0.2)'])")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreaterEqual(time.monotonic() - start, 0.2)

    def test_leftover_process_fails_and_is_terminated(self):
        result = self.run_script("import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])", grace=0.1)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('outlived the app', result.stderr)

    @unittest.skipUnless(os.environ.get('QUOTUM_TEST_FAULT') == '1', 'intentional faults belong in CI')
    def test_a_crash_after_the_parent_exits_is_not_hidden_by_its_zero_status(self):
        child = 'import os,signal,time,resource; resource.setrlimit(resource.RLIMIT_CORE,(0,0)); time.sleep(0.2); os.kill(os.getpid(),signal.SIGSEGV)'
        result = self.run_script(f'import subprocess,sys; subprocess.Popen([sys.executable,"-c",{child!r}])')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('SIGSEGV', result.stderr)


if __name__ == '__main__':
    unittest.main()
