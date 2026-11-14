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
    def execute(self, relative, original, actual, previous_source=None, *, include_generated=True):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        workspace = root / "workspace"
        target = workspace / relative
        target.parent.mkdir(parents=True)
        target.write_bytes(actual)
        digest = lambda value: hashlib.sha256(value).hexdigest()
        accepted = _next_generated_seed_variants(relative, original)
        if previous_source is not None:
            accepted |= _next_generated_seed_variants(relative, previous_source)
        request = {"files": [{"relative": relative, "data": base64.b64encode(original).decode(),
            "generated_sha256": [digest(value) for value in accepted]}],
            "inputs": {}, "previous_inputs": {"files": [{"relative": relative, "sha256": digest(original)}]},
            "group_storage": True}
        if not include_generated:
            request["files"][0].pop("generated_sha256")
        # The generation-aware guest derives workspace/cache from the /data
        # root. Redirect that root as well as descendants into this tempdir.
        script = seed_transaction().replace("'/data", repr(str(root))[:-1])
        result = subprocess.run([sys.executable, "-B", "-I", "-c", script],
            input=json.dumps(request).encode(), capture_output=True, timeout=15)
        return result, target

    def test_controller_reads_old_variants_only_from_the_active_generation(self):
        from types import SimpleNamespace
        from unittest import mock
        import docker_development_inputs as metadata
        import docker_volume_dev as dev
        import docker_group_storage as group_storage
        from bootstrap_docker_toolchain import control_volume_name

        relative = "apps/control-room/next-env.d.ts"
        previous = b'import "./.next/types/routes.d.ts";\n'
        current = previous + b"// changed metadata\n"
        old_inputs = {"source_commit": "a"*40, "files": [
            {"relative": relative, "sha256": hashlib.sha256(previous).hexdigest()}]}
        inputs = {"source_commit": "b"*40, "files": [
            {"relative": relative, "sha256": hashlib.sha256(current).hexdigest()}]}
        generation = "d"*32
        namespace = "namespaces/" + "e"*32
        expected_relative = "private/frontend/generations/" + generation + "/frozen-inputs/" + relative
        for authenticated in (True, False):
            reads, requests = [], []
            def read_bytes(path, optional=False):
                reads.append(path)
                return previous if authenticated else b"untrusted frozen source"
            control = SimpleNamespace(project="own", volume=control_volume_name("own"), image="helper-image",
                namespace=namespace, subpath=lambda p: namespace + "/" + p,
                read=lambda p,optional=False: old_inputs,
                read_bytes=read_bytes, write=lambda p,v: None,
                helper_args=lambda command: ["docker","run","--entrypoint","python","helper-image"])
            operation = {"root": "development/attempts/" + "f"*32, "receipt": {
                "attempt": "f"*32, "private_group_storage": "group-volume-v1",
                "frontend_generation_id": generation,
                "frontend_generation_subpath": group_storage.frontend_generation_subpath(control, generation)}}
            def seed(source, state, port, *, write_file):
                write_file(relative, current)
                return inputs
            def capture(args, *, data, timeout):
                requests.append(json.loads(data))
                result = {"state": "seeded", "inputs": inputs,
                          "frontend_generation": {"mode":"active","generation_id":generation}}
                return SimpleNamespace(returncode=0, stdout=json.dumps(result).encode(), stderr=b"")
            with self.subTest(authenticated=authenticated), \
                 mock.patch.object(metadata, "seed", side_effect=seed), \
                 mock.patch.object(metadata, "metadata_cache_key", return_value="metadata-key"), \
                 mock.patch.object(dev, "bounded_capture", side_effect=capture):
                dev._frontend(control, operation, Path("/selected"), Path("/state"), 3243, "frontend-image")
                self.assertEqual(reads, [expected_relative])
                self.assertEqual(requests[0]["frontend_generation"], {"mode":"active","generation_id":generation})
                hashes = set(requests[0]["files"][0]["generated_sha256"])
                old_hashes = {hashlib.sha256(value).hexdigest() for value in _next_generated_seed_variants(relative, previous)}
                current_hashes = {hashlib.sha256(value).hexdigest() for value in _next_generated_seed_variants(relative, current)}
                self.assertTrue(current_hashes <= hashes)
                self.assertEqual(old_hashes <= hashes, authenticated)

    def test_known_next_generated_file_is_reseeded_before_fresh_input_freeze(self):
        relative = "apps/control-room/next-env.d.ts"
        original = b'import "./.next/types/routes.d.ts";\n'
        generated = next(value for value in _next_generated_seed_variants(relative, original) if value != original)
        result, target = self.execute(relative, original, generated)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(target.read_bytes(), original)

    def test_changed_seed_accepts_only_authenticated_variants_of_previous_seed(self):
        relative = "apps/control-room/next-env.d.ts"
        previous = b'import "./.next/types/routes.d.ts";\n'
        current = previous + b"// changed source metadata\n"
        generated = next(value for value in _next_generated_seed_variants(relative, previous) if value != previous)
        result, target = self.execute(relative, current, generated, previous_source=previous)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(target.read_bytes(), current)

    def test_missing_generated_variant_proof_is_retained_and_rejected(self):
        original = b"source seed"
        result, target = self.execute("apps/control-room/next-env.d.ts", original, original,
                                      include_generated=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"Frontend metadata has unknown changes", result.stderr)
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
