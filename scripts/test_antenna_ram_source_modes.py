"""Interpreted source/package binding regression; never launches Docker."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import run_managed_antenna_ram as launcher
from local_runner.build_entrypoint import required_outputs_for_profile
from local_runner.worker_entrypoint import SCHEMA, canonical


class AntennaRamSourceModesTests(unittest.TestCase):
    def fixture(self, root, *, mode, dirty, resolved="a" * 40):
        capsule = root / "capsule"
        tree = capsule / "tree"
        tree.mkdir(parents=True)
        (tree / "fixture.py").write_bytes(b"x")
        core = {"schema_version": SCHEMA, "source_mode": mode,
            "resolved_commit": resolved, "files": [{"path": "fixture.py",
                "type": "file", "mode": "100644", "size": 1,
                "sha256": hashlib.sha256(b"x").hexdigest()}],
            "deleted": [], "included_untracked": [], "excluded": []}
        digest = hashlib.sha256(canonical(core)).hexdigest()
        (capsule / "manifest.json").write_text(json.dumps({**core, "source_digest": digest}))
        build = root / ("1" * 32)
        trusted = build / "trusted"
        trusted.mkdir(parents=True)
        native = {"head_commit_full": "a" * 40, "source_snapshot_dirty": dirty,
            "source_snapshot_sha256": "e" * 64}
        context = {"job_id": build.name, "source_digest": digest,
            "profile": "fem-cpu-release", "image_digest": "sha256:" + "d" * 64,
            "native_source_identity": native}
        (trusted / "context.json").write_text(json.dumps(context))
        for name in ("build_entrypoint.py", "worker_entrypoint.py"):
            (trusted / name).write_text("trusted fixture, not executable")
        journal = {**context, "phase": "terminal", "state": "succeeded", "exit_code": 0,
            "trusted_hashes": {p.name: launcher.digest(p) for p in trusted.iterdir()},
            "mounts": [["bind", str(capsule), "/source", False]]}
        (build / "receipt.json").write_text(json.dumps(journal))
        artifacts = build / "artifacts"
        entries = []
        for name in required_outputs_for_profile("fem-cpu-release"):
            path = artifacts / "outputs/.fullmag/local" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"integrity fixture, not executable")
            entries.append({"path": path.relative_to(artifacts).as_posix(),
                "size": path.stat().st_size, "sha256": launcher.digest(path)})
        built = {**context, "schema": "fullmag.local-runner.build.v1", "state": "succeeded",
            "qualification": "NOT VERIFIED", "artifacts": entries,
            "native_source_identity_sha256": hashlib.sha256(canonical(native)).hexdigest(),
            "stages": [{"name": name, "exit_code": 0} for name in
                ("native-build", "frontend-dependencies", "frontend-build")]}
        (artifacts / "build-receipt.json").write_text(json.dumps(built))
        return build, capsule, digest

    def resolve(self, root, build, digest, *, commit="a" * 40, snapshot="e" * 64):
        layout = {"storage_root": str(root), "runs_root": str(root)}
        with patch.object(launcher.storage, "resolve_layout", return_value=layout), \
                patch.object(launcher, "docker", side_effect=AssertionError("No Docker in binding")):
            return launcher.resolved_build(root, build.name, commit, digest, snapshot)

    def test_clean_commit_and_clean_or_dirty_snapshot_use_full_binding(self):
        for mode, dirty in (("commit", False), ("snapshot", False), ("snapshot", True)):
            with self.subTest(mode=mode, dirty=dirty), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                build, capsule, digest = self.fixture(root, mode=mode, dirty=dirty)
                _, actual_build, context, built, actual_capsule, _ = self.resolve(root, build, digest)
                self.assertEqual((actual_build, actual_capsule), (build, capsule))
                self.assertEqual(context["native_source_identity"]["source_snapshot_dirty"], dirty)
                self.assertEqual(built["qualification"], "NOT VERIFIED")

    def test_commit_capsule_must_be_clean_and_resolve_to_requested_commit(self):
        for dirty, resolved in ((True, "a" * 40), (False, "b" * 40)):
            with self.subTest(dirty=dirty, resolved=resolved), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                build, _, digest = self.fixture(root, mode="commit", dirty=dirty, resolved=resolved)
                with self.assertRaisesRegex(ValueError, "snapshot|commit|capsule"):
                    self.resolve(root, build, digest)

    def test_commit_still_refuses_wrong_pins_and_same_size_byte_mutations(self):
        for mutation in ("commit", "digest", "snapshot", "source", "package", "trusted"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                build, capsule, digest = self.fixture(root, mode="commit", dirty=False)
                commit, snapshot = "a" * 40, "e" * 64
                if mutation == "commit": commit = "b" * 40
                elif mutation == "digest": digest = "f" * 64
                elif mutation == "snapshot": snapshot = "f" * 64
                elif mutation == "source": (capsule / "tree/fixture.py").write_bytes(b"y")
                else:
                    path = build / ("trusted/build_entrypoint.py" if mutation == "trusted"
                        else "artifacts/outputs/.fullmag/local/bin/fullmag-bin")
                    original = path.read_bytes()
                    path.write_bytes(b"X" + original[1:])
                with self.assertRaises(ValueError):
                    self.resolve(root, build, digest, commit=commit, snapshot=snapshot)


if __name__ == "__main__":
    unittest.main()
