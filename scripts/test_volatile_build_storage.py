"""Behavioral checks for explicit volatile build scratch enrollment."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import fullmag_storage as storage
import volatile_build_storage as scratch


class VolatileBuildStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.project = self.base / "project"
        self.project.mkdir()
        self.durable = self.project / "storage"
        self.durable.mkdir()
        self.durable_marker = {
            "schema": storage.SCHEMA,
            "project_root": str(self.project),
        }
        storage.atomic_json(self.durable / scratch.DURABLE_MARKER_NAME, self.durable_marker)
        self.scratch_parent = self.base / "ram"
        self.scratch_parent.mkdir()
        self.scratch_root = self.scratch_parent / "fullmag-builds"
        self.checkout = self.project / "checkout"
        self.checkout.mkdir()

    def test_active_build_blocks_reset_and_rejects_lost_generation(self):
        evidence = self.register()
        marker = self.scratch_root / scratch.SCRATCH_MARKER_NAME
        with self.assertRaises(storage.StorageError):
            with scratch.scratch_build_lease(self.durable, self.scratch_root, evidence):
                marker.unlink()
                with self.assertRaisesRegex(storage.StorageError, "gate already exists"):
                    scratch.resolve_scratch_root(self.durable, self.scratch_root, initialize=True)
        self.assertFalse((self.durable / scratch.GATE_RELATIVE_PATH).exists())
        rebuilt = scratch.resolve_scratch_root(self.durable, self.scratch_root, initialize=True)
        self.assertNotEqual(rebuilt["generation"], evidence["generation"])
        with self.assertRaisesRegex(storage.StorageError, "before build admission"):
            with scratch.scratch_build_lease(self.durable, self.scratch_root, evidence):
                self.fail("Stale generation must not launch a build")

    def register(self, root=None):
        return scratch.register_scratch_root(
            self.durable,
            root or self.scratch_root,
            forbidden_roots=(self.checkout,),
        )

    def container_view(self, *, create_root=True):
        view = self.base / "container-view" / "scratch"
        view.parent.mkdir(exist_ok=True)
        if create_root:
            view.mkdir(exist_ok=True)
        return view

    def resolve_view(self, view, **kwargs):
        return scratch.resolve_scratch_root(
            self.durable,
            view,
            host_root=str(self.scratch_root),
            forbidden_roots=(self.checkout,),
            **kwargs,
        )

    def test_registration_is_explicit_and_repeat_is_idempotent(self):
        evidence = self.register()
        registry_path = self.durable / scratch.REGISTRY_RELATIVE_PATH
        marker_path = self.scratch_root / scratch.SCRATCH_MARKER_NAME
        registry_before = registry_path.read_bytes()
        marker_before = marker_path.read_bytes()

        repeated = self.register()

        self.assertEqual(repeated, evidence)
        self.assertEqual(registry_path.read_bytes(), registry_before)
        self.assertEqual(marker_path.read_bytes(), marker_before)
        self.assertEqual(evidence["scratch_root"], str(self.scratch_root))
        self.assertEqual(evidence["host_scratch_root"], str(self.scratch_root))
        self.assertEqual(evidence["scratch_id"], json.loads(registry_before)["scratch_id"])
        self.assertEqual(evidence["generation"], json.loads(marker_before)["generation"])
        self.assertEqual(
            evidence["durable_marker_sha256"],
            hashlib.sha256(json.dumps(
                self.durable_marker, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode("utf-8")).hexdigest(),
        )

    def test_resolve_requires_explicit_registration_without_writing(self):
        self.scratch_root.mkdir()

        with self.assertRaises(storage.StorageError):
            scratch.resolve_scratch_root(self.durable, self.scratch_root)

        self.assertEqual(list(self.scratch_root.iterdir()), [])
        self.assertFalse((self.durable / "index").exists())

    def test_unregistered_nonempty_and_foreign_roots_are_preserved_and_rejected(self):
        self.scratch_root.mkdir()
        canary = self.scratch_root / "operator-data.bin"
        canary.write_bytes(b"keep me")
        with self.assertRaises(storage.StorageError):
            self.register()
        self.assertEqual(canary.read_bytes(), b"keep me")
        self.assertFalse((self.durable / scratch.REGISTRY_RELATIVE_PATH).exists())

        foreign_root = self.scratch_parent / "foreign"
        foreign_root.mkdir()
        foreign_marker = foreign_root / scratch.SCRATCH_MARKER_NAME
        foreign_marker.write_text('{"schema":"foreign"}\n', encoding="utf-8")
        with self.assertRaises(storage.StorageError):
            self.register(foreign_root)
        self.assertEqual(foreign_marker.read_text(encoding="utf-8"), '{"schema":"foreign"}\n')
        self.assertFalse((self.durable / scratch.REGISTRY_RELATIVE_PATH).exists())

    def test_relative_root_filesystem_root_and_overlapping_roots_are_rejected(self):
        with self.assertRaises(storage.StorageError):
            scratch.register_scratch_root(Path("."), self.scratch_root)
        with self.assertRaises(storage.StorageError):
            scratch.register_scratch_root(self.durable, Path(self.scratch_root.anchor))
        with self.assertRaises(storage.StorageError):
            scratch.register_scratch_root(self.durable, self.durable)

        nested_checkout_root = self.checkout / "scratch"
        nested_checkout_root.mkdir()
        with self.assertRaises(storage.StorageError):
            self.register(nested_checkout_root)
        self.assertFalse((self.durable / scratch.REGISTRY_RELATIVE_PATH).exists())

    def test_registered_root_cannot_be_replaced_by_a_conflicting_root(self):
        self.register()
        other = self.scratch_parent / "other"
        other.mkdir()
        with self.assertRaises(storage.StorageError):
            self.register(other)
        self.assertEqual(list(other.iterdir()), [])
        self.assertTrue((self.scratch_root / scratch.SCRATCH_MARKER_NAME).is_file())

    def test_symlinked_scratch_root_is_rejected_when_host_supports_link_creation(self):
        target = self.scratch_parent / "target"
        target.mkdir()
        link = self.scratch_parent / "redirected"
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"Host cannot create a directory symlink: {error}")

        with self.assertRaises(storage.StorageError):
            self.register(link)
        self.assertEqual(list(target.iterdir()), [])

    def test_existing_unknown_gate_blocks_registration_without_touching_contents(self):
        index = self.durable / "index"
        index.mkdir()
        gate = index / scratch.GATE_RELATIVE_PATH.name
        gate.mkdir()
        unknown_owner = gate / "unknown-owner.json"
        unknown_owner.write_text('{"owner":"other"}\n', encoding="utf-8")
        before = unknown_owner.read_bytes()

        with self.assertRaises(storage.StorageError):
            self.register()

        self.assertEqual(unknown_owner.read_bytes(), before)
        self.assertEqual(list(gate.iterdir()), [unknown_owner])
        self.assertFalse((self.durable / scratch.REGISTRY_RELATIVE_PATH).exists())
        self.assertFalse(self.scratch_root.exists())

    def test_existing_unknown_gate_blocks_reset_without_touching_contents(self):
        self.register()
        view = self.container_view(create_root=False)
        gate = self.durable / scratch.GATE_RELATIVE_PATH
        gate.mkdir()
        unknown_owner = gate / "unknown-owner.json"
        unknown_owner.write_text('{"owner":"other"}\n', encoding="utf-8")
        before = unknown_owner.read_bytes()

        with self.assertRaises(storage.StorageError):
            self.resolve_view(view, initialize=True)

        self.assertEqual(unknown_owner.read_bytes(), before)
        self.assertEqual(list(gate.iterdir()), [unknown_owner])
        self.assertFalse(view.exists())

    def test_gate_is_exclusive_and_releases_its_owner_on_exception(self):
        self.register()
        gate = self.durable / scratch.GATE_RELATIVE_PATH
        tokens = []

        with self.assertRaisesRegex(RuntimeError, "exercise cleanup"):
            with scratch._registry_gate(self.durable):
                owner_path = gate / "owner.json"
                owner = json.loads(owner_path.read_text(encoding="utf-8"))
                self.assertTrue(owner["token"])
                self.assertTrue(owner["host"])
                self.assertEqual(owner["pid"], os.getpid())
                tokens.append(owner["token"])
                with self.assertRaises(storage.StorageError):
                    with scratch._registry_gate(self.durable):
                        pass
                self.assertTrue(gate.is_dir())
                raise RuntimeError("exercise cleanup")

        self.assertFalse(gate.exists())
        with scratch._registry_gate(self.durable):
            owner = json.loads((gate / "owner.json").read_text(encoding="utf-8"))
            tokens.append(owner["token"])
        self.assertFalse(gate.exists())
        self.assertNotEqual(tokens[0], tokens[1])

    def test_gate_release_keeps_unknown_data_and_owner_when_gate_is_not_empty(self):
        self.register()
        gate = self.durable / scratch.GATE_RELATIVE_PATH
        unexpected = gate / "unexpected.json"

        with self.assertRaises(storage.StorageError):
            with scratch._registry_gate(self.durable):
                unexpected.write_text('{"keep":true}\n', encoding="utf-8")

        self.assertEqual(unexpected.read_text(encoding="utf-8"), '{"keep":true}\n')
        owner = json.loads((gate / "owner.json").read_text(encoding="utf-8"))
        self.assertTrue(owner["token"])
        self.assertTrue(gate.is_dir())

    def test_missing_marker_read_is_read_only_and_never_falls_back(self):
        evidence = self.register()
        registry_path = Path(evidence["registration_path"])
        registry_before = registry_path.read_bytes()
        view = self.container_view()

        with self.assertRaises(storage.StorageError):
            self.resolve_view(view, initialize=False)

        self.assertEqual(list(view.iterdir()), [])
        self.assertEqual(registry_path.read_bytes(), registry_before)
        self.assertFalse((view / "fallback").exists())

    def test_initialize_after_empty_ram_reset_changes_generation_only(self):
        initial = self.register()
        registry_path = Path(initial["registration_path"])
        registry_before = registry_path.read_bytes()
        durable_marker_path = self.durable / scratch.DURABLE_MARKER_NAME
        durable_marker_before = durable_marker_path.read_bytes()
        durable_canary = self.durable / "operator-data.json"
        durable_canary.write_text('{"keep":true}\n', encoding="utf-8")
        view = self.container_view(create_root=False)

        initialized = self.resolve_view(view, initialize=True)

        self.assertEqual(initialized["scratch_id"], initial["scratch_id"])
        self.assertNotEqual(initialized["generation"], initial["generation"])
        self.assertEqual(initialized["durable_marker_sha256"], initial["durable_marker_sha256"])
        self.assertEqual(registry_path.read_bytes(), registry_before)
        self.assertEqual(durable_marker_path.read_bytes(), durable_marker_before)
        self.assertEqual(durable_canary.read_text(encoding="utf-8"), '{"keep":true}\n')
        self.assertEqual(
            json.loads((view / scratch.SCRATCH_MARKER_NAME).read_text(encoding="utf-8"))["generation"],
            initialized["generation"],
        )

    def test_initialize_refuses_nonempty_unmarked_root_and_preserves_user_data(self):
        self.register()
        view = self.container_view()
        canary = view / "operator-data.bin"
        canary.write_bytes(b"keep me")

        with self.assertRaises(storage.StorageError):
            self.resolve_view(view, initialize=True)

        self.assertEqual(canary.read_bytes(), b"keep me")
        self.assertFalse((view / scratch.SCRATCH_MARKER_NAME).exists())

    def test_trusted_container_alias_must_match_registered_host_root(self):
        original = self.register()
        view = self.container_view()
        shutil.copyfile(original["marker_path"], view / scratch.SCRATCH_MARKER_NAME)

        resolved = self.resolve_view(view)
        self.assertEqual(resolved["scratch_root"], str(view))
        self.assertEqual(resolved["host_scratch_root"], str(self.scratch_root))

        with self.assertRaises(storage.StorageError):
            scratch.resolve_scratch_root(
                self.durable,
                view,
                host_root=str(self.scratch_parent / "wrong-host-root"),
                forbidden_roots=(self.checkout,),
            )

    def test_wrong_durable_marker_invalidates_enrollment(self):
        self.register()
        changed = {**self.durable_marker, "project_root": str(self.base / "other-project")}
        storage.atomic_json(self.durable / scratch.DURABLE_MARKER_NAME, changed)

        with self.assertRaises(storage.StorageError):
            scratch.resolve_scratch_root(self.durable, self.scratch_root)

    def test_windows_host_path_alias_comparison_is_os_independent(self):
        self.assertEqual(
            scratch._portable_path_key(r"R:\volatile\Fullmag", "host root"),
            scratch._portable_path_key(r"r:/VOLATILE/fullmag", "host root"),
        )


if __name__ == "__main__":
    unittest.main()
