#!/usr/bin/env python3
"""Stub-cargo regressions for exact test selection."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HELPER = Path(__file__).with_name("run_exact_cargo_test.py")
NAME = "sample::tests::selected_case"
ARGS = ["--locked", "-p", "sample-crate", "--lib", NAME, "--", "--exact"]
STUB = r"""#!/usr/bin/env python3
import json
import os
import sys

print("stub cargo stdout")
print("args=" + json.dumps(sys.argv[1:]))
print("stub cargo stderr", file=sys.stderr)
mode = os.environ["CARGO_STUB_MODE"]
if mode == "pass":
    print("test " + os.environ["CARGO_STUB_NAME"] + " ... ok")
    print("test result: ok. 1 passed; 0 failed")
elif mode == "zero":
    print("test result: ok. 0 passed; 0 failed")
elif mode == "fail":
    print("stub cargo failed")
    raise SystemExit(23)
"""


class ExactCargoTestTests(unittest.TestCase):
    def run_helper(self, mode):
        with tempfile.TemporaryDirectory() as temp:
            bin_dir = Path(temp) / "bin"
            bin_dir.mkdir()
            cargo = bin_dir / "cargo"
            cargo.write_text(STUB, encoding="utf-8")
            cargo.chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
            env["CARGO_STUB_NAME"] = NAME
            env["CARGO_STUB_MODE"] = mode
            return subprocess.run(
                [sys.executable, "-B", str(HELPER), *ARGS],
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )

    def test_pass_preserves_arguments_and_both_output_streams(self):
        result = self.run_helper("pass")
        self.assertEqual(result.returncode, 0, result.stderr)
        args = next(line[5:] for line in result.stdout.splitlines() if line.startswith("args="))
        self.assertEqual(json.loads(args), ["test", *ARGS])
        self.assertIn("test " + NAME + " ... ok", result.stdout)
        self.assertIn("stub cargo stderr", result.stderr)

    def test_zero_selected_tests_fails_when_cargo_returns_success(self):
        result = self.run_helper("zero")
        self.assertEqual(result.returncode, 1)
        self.assertIn("test result: ok. 0 passed", result.stdout)
        self.assertIn("exact Cargo test did not pass", result.stderr)

    def test_cargo_failure_status_and_output_are_preserved(self):
        result = self.run_helper("fail")
        self.assertEqual(result.returncode, 23)
        self.assertIn("stub cargo failed", result.stdout)
        self.assertIn("stub cargo stderr", result.stderr)


if __name__ == "__main__":
    unittest.main()
