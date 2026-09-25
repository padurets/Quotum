import os
from pathlib import Path
import subprocess
import sys
import time
import unittest

MONITOR = Path(__file__).with_name('monitor.py')


class MonitorTests(unittest.TestCase):
    def run_script(self, script, grace=3, expected_exits=()):
        expected = [part for code in expected_exits for part in ['--expect-exit', str(code)]]
        return subprocess.run([sys.executable, str(MONITOR), '--grace', str(grace), *expected, '--',
                               sys.executable, '-c', script], capture_output=True, text=True, timeout=10)

    def test_keeps_the_apps_exit_code(self):
        self.assertEqual(self.run_script('pass').returncode, 0)
        self.assertEqual(self.run_script('raise SystemExit(7)').returncode, 7)

    def test_waits_for_a_child_after_its_parent_exits(self):
        start = time.monotonic()
        result = self.run_script("import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(0.2)'])")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreaterEqual(time.monotonic() - start, 0.2)

    def test_waits_for_children_when_the_wrapper_reports_an_abort(self):
        start = time.monotonic()
        result = self.run_script("import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(0.2)']); raise SystemExit(134)", expected_exits=(127, 134))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreaterEqual(time.monotonic() - start, 0.2)

    def test_expected_wrapper_status_does_not_accept_other_failures(self):
        self.assertEqual(self.run_script('raise SystemExit(127)', expected_exits=(127, 134)).returncode, 0)
        self.assertEqual(self.run_script('raise SystemExit(1)', expected_exits=(127, 134)).returncode, 1)

    def test_leftover_process_fails_and_is_terminated(self):
        result = self.run_script("import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])", grace=0.1)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('outlived the app', result.stderr)

    @unittest.skipUnless(os.environ.get('QUOTUM_TEST_FAULT') == '1', 'intentional faults belong in CI')
    def test_a_crash_after_the_parent_exits_is_not_hidden_by_its_zero_status(self):
        child = 'import os,signal,time,resource; resource.setrlimit(resource.RLIMIT_CORE,(0,0)); time.sleep(0.2); os.kill(os.getpid(),signal.SIGSEGV)'
        for code, expected in [(0, ()), (134, (127, 134))]:
            result = self.run_script(f'import subprocess,sys; subprocess.Popen([sys.executable,"-c",{child!r}]); raise SystemExit({code})', expected_exits=expected)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn('SIGSEGV', result.stderr)

    @unittest.skipUnless(os.environ.get('QUOTUM_TEST_FAULT') == '1', 'intentional faults belong in CI')
    def test_only_the_expected_wrapper_signal_is_allowed(self):
        script = 'import os,signal,resource; resource.setrlimit(resource.RLIMIT_CORE,(0,0)); os.kill(os.getpid(),signal.SIGABRT)'
        self.assertEqual(self.run_script(script, expected_exits=(134,)).returncode, 0)
        self.assertEqual(self.run_script(script).returncode, 1)


if __name__ == '__main__':
    unittest.main()
