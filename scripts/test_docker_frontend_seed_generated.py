"""Execute the actual metadata seed transaction against a temporary private workspace."""
import ast
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from docker_development_inputs import _next_generated_seed_variants


def seed_transaction():
    tree = ast.parse(Path(__file__).with_name("docker_volume_dev.py").read_text())
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_frontend")
    return next(n.value.value for n in ast.walk(function) if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "script" for t in n.targets)
                and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str))


class GeneratedFrontendSeedTests(unittest.TestCase):
    def execute(self, relative, original, actual):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        workspace = root / "workspace"
        target = workspace / relative
        target.parent.mkdir(parents=True)
        target.write_bytes(actual)
        digest = lambda value: hashlib.sha256(value).hexdigest()
        request = {"files": [{"relative": relative, "data": base64.b64encode(original).decode(),
            "generated_sha256": [digest(value) for value in _next_generated_seed_variants(relative, original)]}],
            "inputs": {}, "previous_inputs": {"files": [{"relative": relative, "sha256": digest(original)}]},
            "group_storage": True}
        script = seed_transaction().replace("/data/", str(root) + "/")
        result = subprocess.run([sys.executable, "-B", "-I", "-c", script],
            input=json.dumps(request).encode(), capture_output=True, timeout=15)
        return result, target

    def test_known_next_generated_file_is_reseeded_before_fresh_input_freeze(self):
        relative = "apps/control-room/next-env.d.ts"
        original = b'import "./.next/types/routes.d.ts";\n'
        generated = next(value for value in _next_generated_seed_variants(relative, original) if value != original)
        result, target = self.execute(relative, original, generated)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(target.read_bytes(), original)

    def test_unknown_generated_file_is_retained_and_rejected(self):
        actual = b"unknown generated input with local modifications"
        result, target = self.execute("apps/control-room/next-env.d.ts", b"source seed", actual)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_bytes(), actual)

    def test_unknown_dependency_file_is_retained_and_rejected(self):
        actual = b"unknown dependency edits"
        result, target = self.execute("pnpm-lock.yaml", b"original lock", actual)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_bytes(), actual)


if __name__ == "__main__":
    unittest.main()
