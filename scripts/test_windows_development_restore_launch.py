"""Interpreted checks for preparing a fresh API's private restore input."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

from test_windows_development_handoff import binding as handoff_binding
from windows import development_handoff as capsule
from windows import development_scene_handoff
from windows import development_restore_launch as restore_launch
from windows import runtime_bundle


def _write_candidate(
    runtime_root: Path,
    *,
    workspace_namespace: str = "fixture",
    profile: str = "dev",
    compiler_profile: str | None = None,
    manifest_sha256: str = "b" * 64,
) -> tuple[Path, dict[str, object]]:
    bundle_id = uuid.uuid4().hex
    bundle_root = runtime_root / "native-bundles" / bundle_id
    bin_root = bundle_root / "bin"
    bin_root.mkdir(parents=True)
    hashes: dict[str, str] = {}
    records = []
    for name in runtime_bundle.BINARY_NAMES:
        data = f"fixture executable: {name}".encode("ascii")
        path = bin_root / name
        path.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        hashes[name] = digest
        records.append({"name": name, "path": f"bin/{name}", "sha256": digest,
                        "size_bytes": len(data)})

    source_snapshot = "d" * 64
    source = {
        "compiler_profile": compiler_profile or runtime_bundle.COMPILER_PROFILES[profile],
        "cuda": False,
        "target_triple": "x86_64-pc-windows-msvc",
        "git_commit": "a" * 40,
        "source_snapshot_sha256": source_snapshot,
        "backend_source_sha256": "c" * 64,
        "dependency_source_sha256": "e" * 64,
        "manifest_sha256": manifest_sha256,
        "workspace_namespace": workspace_namespace,
        "build_version": {
            "schema": "fullmag.build-version.v1",
            "git_commit": "a" * 40,
            "source_snapshot_sha256": source_snapshot,
            "product_version": "1.2.3-dev.20261003.gaaaaaaaaaaaa+9750",
        },
        "features": [],
        "executable_sha256": hashes,
    }
    manifest: dict[str, object] = {
        "schema": runtime_bundle.BUNDLE_SCHEMA,
        "schema_version": 1,
        "bundle_id": bundle_id,
        "created_at_utc": "2026-10-03T10:00:00+00:00",
        "profile": profile,
        "compiler_profile": source["compiler_profile"],
        "qualification": "not_assessed",
        "source": source,
        "binaries": records,
    }
    (bundle_root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return bundle_root, manifest


class DevelopmentRestoreLaunchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo = base / "repo"
        self.repo.mkdir()
        self.store = base / "storage"
        self.runtime = self.store / "runtimes" / "fixture"
        self.runtime.mkdir(parents=True)
        self.store.mkdir(exist_ok=True)
        self.layout = {
            "storage_root": str(self.store),
            "runtime_root": str(self.runtime),
            "worktree_id": "fixture",
        }
        self.binding = handoff_binding()
        self.scene_asset = self.store / "runs" / "initial.ovf"
        self.scene_asset.parent.mkdir()
        self.scene_asset.write_bytes(b"verified initial state bytes")
        self.scene = {
            "version": "scene.v2",
            "revision": 5,
            "scene": {"id": "scene-fixture", "name": "Restored scene"},
            "objects": [],
            "magnetization_assets": [{
                "id": "mag-1", "name": "Initial M", "kind": "sampled",
                "source_path": str(self.scene_asset), "source_format": "ovf",
            }],
            "study": {"requested_device": "gpu", "requested_precision": "single"},
        }
        self.manager_payload = {
            "editor": {"draft": {"dirty": True, "value": "Ms=800e3"}},
            "workspace": {"camera": {"zoom": 2.5}},
            "project_document": {"project_id": "project-fixture", "revision": 9},
        }
        self._layout_patch = patch.object(
            capsule._STORAGE, "resolve_layout", return_value=self.layout
        )
        self._roots_patch = patch.object(
            development_scene_handoff, "_roots", return_value=(self.store, self.runtime)
        )
        self._layout_patch.start()
        self._roots_patch.start()
        self.addCleanup(self._layout_patch.stop)
        self.addCleanup(self._roots_patch.stop)

    def _stage(self, *, target_build_id: str | None = None) -> dict[str, str]:
        candidate_target = target_build_id or "b" * 64
        self.binding["target_build_id"] = candidate_target
        return development_scene_handoff.create_scene_handoff(
            str(self.repo), self.binding, self.scene,
            self.manager_payload["editor"], self.manager_payload["workspace"],
            self.manager_payload["project_document"],
        )

    def _stage_empty(self, *, target_build_id: str) -> dict[str, str]:
        self.binding["session_id"] = None
        self.binding["target_build_id"] = target_build_id
        return development_scene_handoff.create_empty_workspace_handoff(
            str(self.repo), self.binding, self.manager_payload["editor"],
            self.manager_payload["workspace"], self.manager_payload["project_document"],
        )

    def _prepare(self, bundle_root: Path, reference: dict[str, str] | None = None):
        reference = reference or self._stage()
        return restore_launch.prepare_development_restore_launch(
            str(self.repo), reference["handoff_id"], self.binding, bundle_root
        )

    def test_prepares_api_envelope_from_verified_binding_and_bundle(self) -> None:
        bundle_root, manifest = _write_candidate(self.runtime)
        reference = self._stage(target_build_id=manifest["source"]["manifest_sha256"])
        result = self._prepare(bundle_root, reference)

        envelope = result["envelope"]
        self.assertEqual(result["workspace_state"], "session")
        self.assertEqual(set(envelope), {
            "schema", "target_build_id", "target_source_sha256", "old_session_id",
            "scene_document",
        })
        self.assertEqual(envelope["schema"], restore_launch.PRELISTEN_RESTORE_SCHEMA)
        self.assertEqual(envelope["target_build_id"], manifest["source"]["build_version"]["product_version"])
        self.assertNotEqual(envelope["target_build_id"], self.binding["target_build_id"])
        self.assertEqual(envelope["target_source_sha256"], manifest["source"]["backend_source_sha256"])
        self.assertEqual(envelope["old_session_id"], self.binding["session_id"])
        rebased_path = Path(envelope["scene_document"]["magnetization_assets"][0]["source_path"])
        self.assertTrue(rebased_path.is_relative_to(self.runtime))
        self.assertEqual(rebased_path.read_bytes(), b"verified initial state bytes")
        self.assertEqual(result["editor"], self.manager_payload["editor"])
        self.assertEqual(result["workspace"], self.manager_payload["workspace"])
        self.assertEqual(result["project_document"], self.manager_payload["project_document"])
        self.assertEqual(result["candidate"]["bundle_id"], manifest["bundle_id"])
        self.assertEqual(result["candidate"]["profile"], "dev")
        self.assertEqual(result["handoff"]["handoff_id"], reference["handoff_id"])
        receipt_path = self.runtime / capsule.HANDOFF_DIRECTORY / reference["handoff_id"] / "receipt.json"
        self.assertEqual(json.loads(receipt_path.read_text(encoding="utf-8"))["state"], "staged")

    def test_empty_workspace_prepares_without_fabricated_prelisten_scene(self) -> None:
        bundle_root, manifest = _write_candidate(self.runtime)
        reference = self._stage_empty(target_build_id=manifest["source"]["manifest_sha256"])
        result = self._prepare(bundle_root, reference)

        self.assertIsNone(result["envelope"])
        self.assertEqual(result["workspace_state"], "no_session")
        self.assertIsNone(self.binding["session_id"])
        self.assertEqual(result["editor"], self.manager_payload["editor"])
        self.assertEqual(result["workspace"], self.manager_payload["workspace"])
        self.assertEqual(result["project_document"], self.manager_payload["project_document"])
        self.assertEqual(result["candidate"]["bundle_id"], manifest["bundle_id"])
        self.assertEqual(result["candidate"]["workspace_namespace"], "fixture")
        self.assertEqual(result["handoff"]["handoff_id"], reference["handoff_id"])
        self.assertEqual(result["handoff"]["snapshot_sha256"], reference["snapshot_sha256"])
        receipt_path = self.runtime / capsule.HANDOFF_DIRECTORY / reference["handoff_id"] / "receipt.json"
        self.assertEqual(json.loads(receipt_path.read_text(encoding="utf-8"))["state"], "staged")

    def test_rejects_empty_workspace_capsule_for_another_candidate_manifest(self) -> None:
        bundle_root, _manifest = _write_candidate(self.runtime, manifest_sha256="b" * 64)
        reference = self._stage_empty(target_build_id="a" * 64)
        with self.assertRaisesRegex(capsule.HandoffError, "target does not match"):
            self._prepare(bundle_root, reference)

    def test_rejects_corrupt_empty_workspace_capsule_before_preparation(self) -> None:
        bundle_root, manifest = _write_candidate(self.runtime)
        reference = self._stage_empty(target_build_id=manifest["source"]["manifest_sha256"])
        snapshot_path = self.runtime / capsule.HANDOFF_DIRECTORY / reference["handoff_id"] / "snapshot.json"
        snapshot_path.write_bytes(snapshot_path.read_bytes() + b" ")
        with self.assertRaises(capsule.HandoffError):
            self._prepare(bundle_root, reference)

    def test_rejects_capsule_for_another_candidate_manifest(self) -> None:
        bundle_root, _manifest = _write_candidate(self.runtime, manifest_sha256="b" * 64)
        reference = self._stage(target_build_id="a" * 64)
        with self.assertRaisesRegex(capsule.HandoffError, "target does not match"):
            self._prepare(bundle_root, reference)

    def test_rejects_candidate_from_another_worktree_namespace(self) -> None:
        bundle_root, manifest = _write_candidate(
            self.runtime, workspace_namespace="another-worktree"
        )
        reference = self._stage(target_build_id=manifest["source"]["manifest_sha256"])
        with self.assertRaisesRegex(capsule.HandoffError, "different workspace namespace"):
            self._prepare(bundle_root, reference)

    def test_rejects_release_candidate_and_bundle_outside_runtime_root(self) -> None:
        release_root, _ = _write_candidate(
            self.runtime, profile="release", compiler_profile="release"
        )
        reference = self._stage()
        with self.assertRaisesRegex(capsule.HandoffError, "bundle verification"):
            self._prepare(release_root, reference)

        other_runtime = Path(self.temp.name) / "other-runtime"
        other_runtime.mkdir()
        external_bundle, _ = _write_candidate(other_runtime)
        with self.assertRaisesRegex(capsule.HandoffError, "bundle verification"):
            self._prepare(external_bundle, reference)

    def test_rejects_capsule_that_does_not_match_manager_binding(self) -> None:
        bundle_root, manifest = _write_candidate(self.runtime)
        reference = self._stage(target_build_id=manifest["source"]["manifest_sha256"])
        wrong_binding = dict(self.binding)
        wrong_binding["session_epoch"] += 1
        with self.assertRaises(capsule.HandoffError):
            restore_launch.prepare_development_restore_launch(
                str(self.repo), reference["handoff_id"], wrong_binding, bundle_root
            )

    def test_rejects_modified_candidate_executable(self) -> None:
        bundle_root, _ = _write_candidate(self.runtime)
        reference = self._stage()
        (bundle_root / "bin" / runtime_bundle.BINARY_NAMES[0]).write_bytes(b"changed")
        with self.assertRaisesRegex(capsule.HandoffError, "bundle verification"):
            self._prepare(bundle_root, reference)

    def test_does_not_prepare_already_restored_capsule(self) -> None:
        bundle_root, _ = _write_candidate(self.runtime)
        reference = self._stage()
        receipt_path = self.runtime / capsule.HANDOFF_DIRECTORY / reference["handoff_id"] / "receipt.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["state"] = "restored"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaises(capsule.HandoffError):
            self._prepare(bundle_root, reference)


if __name__ == "__main__":
    unittest.main()
