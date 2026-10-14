import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

class SourceRecipeTests(unittest.TestCase):
    def run_recipe(self, suffix="", route="generate-client"):
        bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path(shutil.which("bash") or "/missing")
        if not bash.is_file():
            self.skipTest("Bash unavailable")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stub = root / "python3"
            stub.write_text('#!/bin/sh\nif [ "$1" != "-c" ]; then printf "%s\\n" "$@"; fi\nexit 0\n', encoding="utf-8")
            stub.chmod(0o755)
            repo = Path(__file__).resolve().parents[1]
            recipe = f'python "{repo.as_posix()}/scripts/verify_control_room_sources.py" --route {route} --repo-root "{repo.as_posix()}"' + suffix
            return subprocess.run([str(bash), "-c", 'PATH="$(cygpath -u "$1" 2>/dev/null || printf "%s" "$1"):/usr/bin:/bin"; export PATH; exec bash "$2" "$3"', "test", str(root), str(repo/"scripts/just_storage_shell.sh"), recipe], capture_output=True, text=True, timeout=20)

    def test_default_route_remains_supported(self):
        result = self.run_recipe()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--route\ngenerate-client", result.stdout)

    def test_dependency_argument_is_forwarded_as_one_literal_argument(self):
        value = "C:/owned sources/workspace$(echo DO_NOT_EXECUTE)"
        result = self.run_recipe(f' --dependency-workspace "{value}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--dependency-workspace\n"+value+"\n", result.stdout)

    def test_composite_commands_cannot_reach_evaluation(self):
        for suffix in [' && printf UNAUTHORIZED_SOURCE_COMMAND', ' # fullmag_storage.py resolve', ' --dependency-workspace "C:/workspace" && printf UNAUTHORIZED_SOURCE_COMMAND']:
            with self.subTest(suffix=suffix):
                result = self.run_recipe(suffix)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("invalid lightweight frontend recipe", result.stderr)
                self.assertNotIn("UNAUTHORIZED_SOURCE_COMMAND", result.stdout)

    def test_dependency_argument_is_rejected_for_other_routes(self):
        result = self.run_recipe(' --dependency-workspace "C:/workspace"', "lint")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("dependency workspace", result.stderr)
