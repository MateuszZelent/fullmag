"""Exercise the fullmag console recipe at the real just shell boundary."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SHELL = ROOT / "scripts" / "just_storage_shell.sh"
LAUNCHER = ROOT / "scripts" / "fullmag_console.py"


@unittest.skipUnless(os.name == "posix", "POSIX executable shell fixture")
class FullmagConsoleShellTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fullmag-console-shell-")
        directory = Path(self.temp.name)
        self.probe = directory / "python-probe"
        self.probe_log = directory / "probe.jsonl"
        self.probe.write_text(
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            "if sys.argv[1:2] == ['-c']:\n"
            "    raise SystemExit(0)\n"
            "with open(os.environ['FULLMAG_STORAGE_PROBE_LOG'], 'a', encoding='utf-8') as stream:\n"
            "    stream.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "print(json.dumps(sys.argv[1:]))\n",
            encoding="utf-8",
        )
        self.probe.chmod(0o700)

    def tearDown(self):
        self.temp.cleanup()

    def render(self, *arguments):
        result = subprocess.run(
            ["just", "--justfile", str(ROOT / "justfile"), "--dry-run", "fullmag", *arguments],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        rendered = result.stderr.strip() or result.stdout.strip()
        self.assertTrue(rendered, "just --dry-run must render the recipe command")
        return rendered

    def dispatch(self, recipe):
        self.probe_log.write_text("", encoding="utf-8")
        result = subprocess.run(
            ["bash", str(SHELL), recipe],
            cwd=ROOT,
            env={**os.environ,
                 "FULLMAG_STORAGE_PYTHON": str(self.probe),
                 "FULLMAG_STORAGE_PROBE_LOG": str(self.probe_log)},
            capture_output=True,
            text=True,
            timeout=15,
        )
        calls = []
        if self.probe_log.exists():
            calls = [json.loads(line) for line in self.probe_log.read_text(encoding="utf-8").splitlines()]
        return result, calls

    def assert_dispatch(self, arguments, expected):
        recipe = self.render(*arguments)
        result, calls = self.dispatch(recipe)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), expected)
        self.assertEqual(calls, [expected])

    def test_two_argument_form_defaults_to_gui_with_empty_script_option(self):
        self.assert_dispatch(
            ("master", "examples/model.py"),
            ["-B", str(LAUNCHER), "--repo-root", str(ROOT),
             "--mode-or-source", "master", "--source-or-script", "examples/model.py",
             "--script", "", "--gpu-access", "auto"],
        )

    def test_explicit_gui_and_headless_preserve_arguments_and_optional_port(self):
        source = "/selected/$(printf literal);worktree with spaces"
        script = "examples/$(printf literal);study model.py"
        cases = (
            (("gui", source, script, "3241", "required"),
             ["gui", source, script, "3241", "required"]),
            (("headless", "codex/feature-branch", script, "", "disabled"),
             ["headless", "codex/feature-branch", script, "", "disabled"]),
        )
        for arguments, values in cases:
            with self.subTest(arguments=arguments):
                mode, selector, program, port, gpu_access = values
                expected = ["-B", str(LAUNCHER), "--repo-root", str(ROOT),
                            "--mode-or-source", mode, "--source-or-script", selector,
                            "--script", program]
                if port:
                    expected.extend(["--port", port])
                expected.extend(["--gpu-access", gpu_access])
                self.assert_dispatch(arguments, expected)

    def test_shell_rejects_malformed_arguments_and_gpu_alias(self):
        valid = self.render("headless", "master", "examples/model.py")
        malformed = (
            valid.replace("--source-or-script 'master' ", ""),
            valid.replace("--gpu-access 'auto'", "--gpu-access 'gpu'"),
            valid + " --unexpected 'value'",
            valid + "; printf injected",
            valid + " && printf injected",
            valid + "\nprintf injected",
        )
        for recipe in malformed:
            with self.subTest(recipe=recipe):
                result, calls = self.dispatch(recipe)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("invalid fullmag console recipe", result.stderr)
                self.assertEqual(calls, [])
                self.assertNotIn("injected", result.stdout + result.stderr)

    def test_dispatch_precedes_resolver_and_legacy_reference_stays_private(self):
        shell_source = SHELL.read_text(encoding="utf-8")
        dispatch = shell_source.index('  *"scripts/fullmag_console.py"*)')
        self.assertLess(dispatch, shell_source.rindex('"${resolver}" run'))

        summary = subprocess.run(
            ["just", "--justfile", str(ROOT / "justfile"), "--summary"],
            cwd=ROOT, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(summary.returncode, 0, summary.stderr)
        self.assertIn("fullmag", summary.stdout.split())
        self.assertNotIn("fullmag-reference", summary.stdout.split())

        legacy = subprocess.run(
            ["just", "--justfile", str(ROOT / "justfile"), "--dry-run", "fullmag-reference",
             "fem", "cpu", "examples/fem_fmr_free_demag_airbox_smoke.py"],
            cwd=ROOT, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(legacy.returncode, 0, legacy.stderr)
        self.assertIn("bash -euo pipefail -c", legacy.stderr)

    def test_recipe_ports_and_gpu_access_use_one_canonical_argument_order(self):
        recipe = self.render("headless", "master", "examples/model.py", "3277", "disabled")
        self.assertRegex(
            recipe,
            r"--mode-or-source 'headless' --source-or-script 'master' --script 'examples/model\.py' "
            r"--port '3277' --gpu-access 'disabled'$",
        )
        result, calls = self.dispatch(recipe)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[0][-6:], ["--script", "examples/model.py", "--port", "3277",
                                         "--gpu-access", "disabled"])


if __name__ == "__main__":
    unittest.main()
