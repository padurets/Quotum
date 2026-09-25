"""The smoke supervisor must reject child faults even when their parent returns zero."""
import pathlib
import os
import subprocess
import tempfile
import unittest

TRACE = pathlib.Path(__file__).with_name("trace.sh")


class ProcessStatus(unittest.TestCase):
    def run_trace(self, program):
        with tempfile.TemporaryDirectory(prefix="quotum-trace-") as work:
            return subprocess.run(
                ["sh", str(TRACE.resolve()), str(pathlib.Path(work) / "process.log"), "python3", "-c", program],
                cwd=work,
                capture_output=True,
                text=True,
                timeout=15,
            )

    @unittest.skipUnless(os.environ.get("QUOTUM_TEST_FAULT") == "1", "intentional crash: run only on a CI runner")
    def test_parent_success_does_not_hide_a_child_fault(self):
        for fault in ["SIGSEGV", "SIGTRAP"]:
            with self.subTest(fault=fault):
                result = self.run_trace(f"""
import os, resource, signal
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
pid = os.fork()
if pid == 0:
    os.kill(os.getpid(), getattr(signal, {fault!r}))
os.waitpid(pid, 0)
""")
                self.assertEqual(result.returncode, 1)
                self.assertIn("a child process crashed", result.stderr)

    def test_clean_exit_passes(self):
        self.assertEqual(self.run_trace("pass").returncode, 0)

    def test_command_failure_is_preserved(self):
        self.assertEqual(self.run_trace("raise SystemExit(7)").returncode, 7)

    def test_requested_child_termination_is_not_a_crash(self):
        result = self.run_trace("""
import os, signal
pid = os.fork()
if pid == 0:
    os.kill(os.getpid(), signal.SIGTERM)
os.waitpid(pid, 0)
""")
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
