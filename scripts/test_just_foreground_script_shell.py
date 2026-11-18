"""Exercise managed foreground script dispatch at the real just shell boundary."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SHELL = ROOT / "scripts" / "just_storage_shell.sh"


@unittest.skipUnless(os.name == "posix", "POSIX executable shell fixture")
class JustForegroundScriptShellTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fullmag-foreground-shell-")
        directory = Path(self.temp.name)
        self.probe = directory / "python-probe"
        self.probe_log = directory / "probe.jsonl"
        self.probe.write_text(
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            "with open(os.environ['FULLMAG_STORAGE_PROBE_LOG'], 'a', encoding='utf-8') as stream:\n"
            "    stream.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "if sys.argv[1:2] == ['-c']:\n"
            "    raise SystemExit(0)\n"
            "print(json.dumps(sys.argv[1:]))\n",
            encoding="utf-8",
        )
        self.probe.chmod(0o700)

    def tearDown(self):
        self.temp.cleanup()

    def recipe(self, action):
        return (f'python "{ROOT}/scripts/docker_dev.py" --repo-root "{ROOT}" '
                + action)

    def dispatch(self, recipe):
        self.probe_log.write_text("", encoding="utf-8")
        return subprocess.run(
            ["bash", str(SHELL), recipe],
            env={**os.environ,
                 "FULLMAG_STORAGE_PYTHON": str(self.probe),
                 "FULLMAG_STORAGE_PROBE_LOG": str(self.probe_log)},
            capture_output=True,
            text=True,
            timeout=15,
        )

    def calls(self):
        return [json.loads(line) for line in self.probe_log.read_text(encoding="utf-8").splitlines()]

    def test_pinned_run_script_forwards_exact_pins_and_literal_values(self):
        attempt = "a" * 32
        digest = "b" * 64
        source = "/selected/$(printf literal);worktree"
        script = "examples/$(printf literal);study.py"
        for request_id in (None, "stable-request"):
            suffix = f" --request-id '{request_id}'" if request_id else ""
            recipe = self.recipe(
                f"run-script --attempt '{attempt}' --config-sha256 '{digest}' "
                f"--source-root '{source}' --script '{script}'{suffix}"
            )

            with self.subTest(request_id=request_id):
                result = self.dispatch(recipe)
                expected = [
                    str(ROOT / "scripts" / "docker_dev.py"), "--repo-root", str(ROOT),
                    "run-script", "--attempt", attempt, "--config-sha256", digest,
                    "--source-root", source, "--script", script,
                ]
                if request_id:
                    expected.extend(["--request-id", request_id])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), expected)
                self.assertEqual(len(self.calls()), 2)
                self.assertEqual(self.calls()[1], expected)

    def test_unpinned_run_script_supports_fullmag_dev_container_argument_order(self):
        source = "/selected/$(printf literal);worktree"
        cases = (
            ("--script 'examples/model.py'",
             ["--script", "examples/model.py"]),
            ("--script 'examples/model.py' --port '3203'",
             ["--script", "examples/model.py", "--port", "3203"]),
            (f"--script 'examples/model.py'  --source-root '{source}'",
             ["--script", "examples/model.py", "--source-root", source]),
            (f"--script 'examples/model.py' --port '3203' --source-root '{source}'",
             ["--script", "examples/model.py", "--port", "3203", "--source-root", source]),
        )
        for suffix, expected in cases:
            with self.subTest(suffix=suffix):
                result = self.dispatch(self.recipe("run-script " + suffix))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), [
                    str(ROOT / "scripts" / "docker_dev.py"), "--repo-root", str(ROOT),
                    "run-script", *expected,
                ])

    def test_discovery_script_route_remains_managed(self):
        source = "/selected/worktree"
        result = self.dispatch(self.recipe(
            f"script --script 'examples/model.py' --source-root '{source}' "
            "--port '3203' --request-id 'stable-request'"
        ))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [
            str(ROOT / "scripts" / "docker_dev.py"), "--repo-root", str(ROOT),
            "script", "--script", "examples/model.py",
            "--source-root", source, "--port", "3203", "--request-id", "stable-request",
        ])

    def test_incomplete_malformed_or_extended_pins_fail_closed(self):
        attempt = "a" * 32
        digest = "b" * 64
        source = "/selected/worktree"
        script = "examples/model.py"
        base = self.recipe(
            f"run-script --attempt '{attempt}' --config-sha256 '{digest}' "
            f"--source-root '{source}' --script '{script}'"
        )
        malformed = (
            base.replace(f"--attempt '{attempt}' ", ""),
            base.replace(attempt, "z" * 32),
            base.replace(digest, "B" * 64),
            base.replace(f"--config-sha256 '{digest}' ", ""),
            base.replace(f"--source-root '{source}' ", ""),
            base.replace(f"--script '{script}'", ""),
            base + " --unknown 'value'",
            base + " --timeout-seconds '3'",
            base + "; printf injected",
            base + " && printf injected",
            base + "\nprintf injected",
        )
        for recipe in malformed:
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)
                self.assertEqual(len(self.calls()), 1)
                self.assertEqual(self.calls()[0][0], "-c")

    def test_unpinned_run_script_rejects_unknown_arguments_and_composite_shell_syntax(self):
        base = self.recipe("run-script --script 'examples/model.py'")
        for suffix in (" --unknown 'value'", " --port '3203' --source-root '/selected/worktree' --extra",
                       "; printf injected", " && printf injected", "\nprintf injected"):
            with self.subTest(suffix=suffix):
                result = self.dispatch(base + suffix)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)
                self.assertEqual(len(self.calls()), 1)
                self.assertEqual(self.calls()[0][0], "-c")


if __name__ == "__main__":
    unittest.main()
