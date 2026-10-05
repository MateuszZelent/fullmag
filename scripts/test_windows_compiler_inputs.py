"""Interpreted regression checks for the stable Windows compiler-input mirror."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fullmag_storage
from windows import build_snapshot, compiler_inputs, volatile_build_storage


class CompilerInputsChecks(unittest.TestCase):
    def setUp(self):
        # The sandbox permits Git fixtures inside the workspace. Keep them
        # outside managed storage and remove the unique temporary tree at exit.
        temp_root = Path(os.environ.get("FULLMAG_TEST_TEMP_ROOT", Path(__file__).resolve().parent))
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.build = self.root / "build"
        self.build.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "compiler-inputs@example.invalid")
        self.git("config", "user.name", "Compiler Inputs Fixture")
        self.git("config", "core.autocrlf", "false")
        self.rust = self.repo / "crates/demo/src/lib.rs"
        self.rust.parent.mkdir(parents=True)
        self.rust.write_bytes(b"// raw CRLF\r\npub const VALUE: u8 = 1;\r\n")
        (self.repo / "Cargo.toml").write_text("[workspace]\nmembers = []\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.PIPE)

    def make(self):
        metadata = build_snapshot.create_snapshot(self.repo, self.build)
        self.addCleanup(self.writable, Path(metadata["source_root"]).parent)
        return metadata

    def materialize(self, metadata, working_root=None):
        return compiler_inputs.materialize(
            metadata["record_path"], self.build, working_root=working_root
        )

    def make_working_root(self):
        profile = "windows-native-fdm-cpu-dev"
        storage_root = self.root / "storage"
        layout = fullmag_storage.resolve_layout(
            self.repo, profile, environ={"FULLMAG_PROJECT_STORAGE_ROOT": str(storage_root)}
        )
        self.build = Path(layout["build_root"])
        self.build.mkdir(parents=True)
        root = self.root.parent / f"{self.root.name}-ramdisk"
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        project_root = Path(layout["project_root"])
        profile_root = root / "builds" / layout["worktree_id"] / profile
        profile_root.mkdir(parents=True)
        (root / ".fullmag-volatile-root.json").write_text(json.dumps({
            "schema": volatile_build_storage.ROOT_SCHEMA,
            "project_root": str(project_root),
        }))
        profile_marker = profile_root / volatile_build_storage.MARKER
        profile_marker.write_text(json.dumps({
            "schema": volatile_build_storage.PROFILE_SCHEMA,
            "project_root": str(project_root),
            "repo_root": layout["repo_root"],
            "worktree_id": layout["worktree_id"],
            "profile": profile,
            "durable_build_root": layout["build_root"],
        }))
        return root, profile_root / "compiler-inputs", profile_marker, str(storage_root)

    @staticmethod
    def writable(root):
        for path in root.rglob("*"):
            if path.is_file() and not path.is_symlink():
                path.chmod(0o600)

    def test_docs_snapshot_update_keeps_root_and_unchanged_rust_mtime(self):
        timestamp = 1_600_000_000_123_456_700
        os.utime(self.rust, ns=(timestamp, timestamp))
        expected_mtime = self.rust.stat().st_mtime_ns
        first = self.make()
        first_result = self.materialize(first)
        stable_root = Path(first_result["source_root"])
        rust_copy = stable_root / "crates/demo/src/lib.rs"
        stable_mtime = rust_copy.stat().st_mtime_ns
        self.assertEqual(stable_mtime, expected_mtime)
        self.assertEqual(rust_copy.read_bytes(), self.rust.read_bytes())

        document = self.repo / "docs/cache-note.md"
        document.parent.mkdir()
        document.write_text("Documentation changed without changing native inputs.\n")
        second = self.make()
        second_result = self.materialize(second)
        self.assertNotEqual(first["snapshot_id"], second["snapshot_id"])
        self.assertEqual(first["backend_source_sha256"], second["backend_source_sha256"])
        self.assertEqual(Path(second_result["source_root"]), stable_root)
        self.assertEqual(rust_copy.stat().st_mtime_ns, stable_mtime)
        self.assertEqual(rust_copy.read_bytes(), self.rust.read_bytes())
        self.assertEqual((stable_root / "docs/cache-note.md").read_bytes(), document.read_bytes())
        self.assertEqual(second_result["snapshot_source_root"], second["source_root"])
        self.assertEqual(second_result["inventory_sha256"], second["inventory_sha256"])

        changed_time = timestamp + 1_000_000_000
        self.rust.write_bytes(b"pub const VALUE: u8 = 2;\r\n")
        os.utime(self.rust, ns=(changed_time, changed_time))
        third = self.make()
        third_result = self.materialize(third)
        self.assertEqual(Path(third_result["source_root"]), stable_root)
        self.assertNotEqual(third["backend_source_sha256"], second["backend_source_sha256"])
        self.assertEqual(rust_copy.read_bytes(), self.rust.read_bytes())
        self.assertEqual(rust_copy.stat().st_mtime_ns, self.rust.stat().st_mtime_ns)

    def test_removes_only_stale_files_owned_by_the_previous_binding(self):
        removed = self.repo / "crates/demo/src/removed.rs"
        removed.write_bytes(b"pub fn removed() {}\n")
        first = self.make()
        first_result = self.materialize(first)
        mirror = Path(first_result["source_root"])
        stale = mirror / "crates/demo/src/removed.rs"
        self.assertTrue(stale.is_file())

        removed.unlink()
        second = self.make()
        compiler_inputs.materialize(second["record_path"], self.build)
        self.assertFalse(stale.exists())
        self.assertEqual((mirror / "crates/demo/src/lib.rs").read_bytes(), self.rust.read_bytes())

    def test_external_working_root_keeps_snapshot_authority_and_stable_mtime(self):
        timestamp = 1_600_000_000_123_456_700
        os.utime(self.rust, ns=(timestamp, timestamp))
        ram_root, working_root, _, storage_root = self.make_working_root()
        first = self.make()
        with patch.dict(os.environ, {
            volatile_build_storage.ROOT_ENV: str(ram_root),
            "FULLMAG_PROJECT_STORAGE_ROOT": storage_root,
        }):
            first_result = self.materialize(first, working_root)
            mirror = working_root / "source"
            rust_copy = mirror / "crates/demo/src/lib.rs"
            original_mtime = rust_copy.stat().st_mtime_ns
            self.assertEqual(Path(first_result["source_root"]), mirror)
            self.assertEqual(first_result["snapshot_source_root"], first["source_root"])
            self.assertEqual(Path(first_result["record_path"]), Path(first["record_path"]))
            self.assertEqual(Path(first_result["compiler_input_binding"]), working_root / "record.json")

            document = self.repo / "docs/ramdisk-update.md"
            document.parent.mkdir()
            document.write_text("new immutable snapshot\n")
            second = self.make()
            second_result = self.materialize(second, working_root)
            self.assertEqual(Path(second_result["source_root"]), mirror)
            self.assertEqual(rust_copy.stat().st_mtime_ns, original_mtime)
            self.assertEqual(rust_copy.read_bytes(), self.rust.read_bytes())
            self.assertEqual((mirror / "docs/ramdisk-update.md").read_bytes(), document.read_bytes())

            command = [sys.executable, "-B", str(Path(compiler_inputs.__file__))]
            verified = subprocess.run(
                command + ["verify", "--record", second["record_path"], "--build-root", str(self.build),
                           "--working-root", str(working_root)],
                check=True, capture_output=True, text=True,
            )
            self.assertEqual(json.loads(verified.stdout), second_result)
            rematerialized = subprocess.run(
                command + ["materialize", "--record", second["record_path"], "--build-root", str(self.build),
                           "--working-root", str(working_root)],
                check=True, capture_output=True, text=True,
            )
            self.assertEqual(json.loads(rematerialized.stdout), second_result)

    def test_external_working_root_and_marker_mismatch_refuse_before_write(self):
        ram_root, working_root, profile_marker, storage_root = self.make_working_root()
        metadata = self.make()
        with patch.dict(os.environ, {
            volatile_build_storage.ROOT_ENV: str(ram_root),
            "FULLMAG_PROJECT_STORAGE_ROOT": storage_root,
        }):
            with self.assertRaises(compiler_inputs.CompilerInputsError):
                self.materialize(metadata, self.root / "misplaced" / "compiler-inputs")
            self.assertFalse(working_root.exists())

            marker = json.loads(profile_marker.read_text())
            marker["durable_build_root"] = str(self.root / "other-build")
            profile_marker.write_text(json.dumps(marker))
            with self.assertRaises(compiler_inputs.CompilerInputsError):
                self.materialize(metadata, working_root)
            self.assertFalse(working_root.exists())

    def test_existing_unbound_tree_is_not_claimed_or_reconciled(self):
        metadata = self.make()
        root = self.build / "compiler-inputs"
        source = root / "source"
        source.mkdir(parents=True)
        foreign = source / "foreign.txt"
        foreign.write_text("operator data")
        with self.assertRaises(compiler_inputs.CompilerInputsError):
            self.materialize(metadata)
        self.assertEqual(foreign.read_text(), "operator data")

    def test_foreign_file_and_reparse_point_are_rejected(self):
        metadata = self.make()
        result = self.materialize(metadata)
        source = Path(result["source_root"])
        foreign = source / "foreign.txt"
        foreign.write_text("do not absorb")
        with self.assertRaises(build_snapshot.SnapshotError):
            compiler_inputs.verify(metadata["record_path"], self.build)
        foreign.unlink()

        link = source / "linked.rs"
        try:
            link.symlink_to(self.rust)
        except OSError:
            self.skipTest("Host does not permit creating symlinks")
        with self.assertRaises(build_snapshot.SnapshotError):
            compiler_inputs.verify(metadata["record_path"], self.build)

    def test_tampered_binding_is_rejected_before_update(self):
        first = self.make()
        result = self.materialize(first)
        binding_path = Path(result["compiler_input_binding"])
        value = json.loads(binding_path.read_text())
        value["inventory_sha256"] = "0" * 64
        binding_path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")

        document = self.repo / "docs/later.md"
        document.parent.mkdir()
        document.write_text("later snapshot\n")
        later = self.make()
        with self.assertRaises(compiler_inputs.CompilerInputsError):
            self.materialize(later)
        with self.assertRaises(compiler_inputs.CompilerInputsError):
            compiler_inputs.verify(first["record_path"], self.build)

    def test_snapshot_tampering_is_rejected_before_creating_mirror(self):
        metadata = self.make()
        source = Path(metadata["source_root"]) / "crates/demo/src/lib.rs"
        source.chmod(0o600)
        source.write_bytes(b"tampered snapshot")
        with self.assertRaises(build_snapshot.SnapshotError):
            self.materialize(metadata)
        self.assertFalse((self.build / "compiler-inputs").exists())

    def test_noncanonical_tampered_snapshot_record_is_rejected(self):
        metadata = self.make()
        record_path = Path(metadata["record_path"])
        record_path.chmod(0o600)
        value = json.loads(record_path.read_text())
        record_path.write_text(json.dumps(value, indent=2))
        with self.assertRaises(compiler_inputs.CompilerInputsError):
            self.materialize(metadata)
        self.assertFalse((self.build / "compiler-inputs").exists())

    def test_bounded_tauri_outputs_are_allowed_and_left_unchanged(self):
        first = self.make()
        result = self.materialize(first)
        source = Path(result["source_root"])
        generated = source / build_snapshot.TAURI_OUTPUT_DIRECTORY
        generated.mkdir(parents=True)
        contents = {}
        mtimes = {}
        for name in build_snapshot.TAURI_OUTPUT_NAMES:
            output = generated / name
            output.write_text(json.dumps({"generated": name}))
            contents[name] = output.read_bytes()
            mtimes[name] = output.stat().st_mtime_ns
        self.assertEqual(compiler_inputs.verify(first["record_path"], self.build)["snapshot_id"], first["snapshot_id"])

        document = self.repo / "docs/updated.md"
        document.parent.mkdir()
        document.write_text("later snapshot\n")
        second = self.make()
        second_result = self.materialize(second)
        self.assertEqual(Path(second_result["source_root"]), source)
        for name in build_snapshot.TAURI_OUTPUT_NAMES:
            output = generated / name
            self.assertEqual(output.read_bytes(), contents[name])
            self.assertEqual(output.stat().st_mtime_ns, mtimes[name])

        unknown = generated / "extra.json"
        unknown.write_text("{}")
        with self.assertRaises(build_snapshot.SnapshotError):
            compiler_inputs.verify(second["record_path"], self.build)
        unknown.unlink()
        invalid = generated / "capabilities.json"
        invalid.write_text("[]")
        with self.assertRaises(build_snapshot.SnapshotError):
            compiler_inputs.verify(second["record_path"], self.build)

    def test_interrupted_initial_materialization_fails_closed(self):
        metadata = self.make()
        original = compiler_inputs._sync_file

        def interrupted(path):
            original(path)
            raise OSError("simulated interruption after file sync")

        with patch.object(compiler_inputs, "_sync_file", side_effect=interrupted):
            with self.assertRaises(OSError):
                self.materialize(metadata)
        root = self.build / "compiler-inputs"
        self.assertTrue(any((root / "source").iterdir()))
        with self.assertRaises(compiler_inputs.CompilerInputsError):
            compiler_inputs.verify(metadata["record_path"], self.build)
        with self.assertRaises(compiler_inputs.CompilerInputsError):
            self.materialize(metadata)

    def test_interrupted_update_leaves_previous_binding_unusable(self):
        first = self.make()
        first_result = self.materialize(first)
        old_binding = Path(first_result["compiler_input_binding"]).read_bytes()
        document = self.repo / "docs/interrupted.md"
        document.parent.mkdir()
        document.write_text("new input\n")
        second = self.make()
        original = compiler_inputs._sync_file

        def interrupted(path):
            original(path)
            raise OSError("simulated interruption during update")

        with patch.object(compiler_inputs, "_sync_file", side_effect=interrupted):
            with self.assertRaises(OSError):
                self.materialize(second)
        self.assertEqual(Path(first_result["compiler_input_binding"]).read_bytes(), old_binding)
        with self.assertRaises(compiler_inputs.CompilerInputsError):
            compiler_inputs.verify(first["record_path"], self.build)
        with self.assertRaises(compiler_inputs.CompilerInputsError):
            self.materialize(second)

    def test_cli_materialize_and_verify_return_stable_source_root(self):
        metadata = self.make()
        script = Path(compiler_inputs.__file__)
        command = [sys.executable, "-B", str(script)]
        materialized = subprocess.run(
            command + ["materialize", "--record", metadata["record_path"], "--build-root", str(self.build)],
            check=True, capture_output=True, text=True,
        )
        result = json.loads(materialized.stdout)
        self.assertEqual(result["source_root"], str(self.build / "compiler-inputs" / "source"))
        self.assertEqual(result["snapshot_source_root"], metadata["source_root"])
        self.assertEqual(result["snapshot_id"], metadata["snapshot_id"])
        verified = subprocess.run(
            command + ["verify", "--record", metadata["record_path"], "--build-root", str(self.build)],
            check=True, capture_output=True, text=True,
        )
        self.assertEqual(json.loads(verified.stdout), result)

    def test_single_call_scan_reuse_and_binding_publication_readback(self):
        metadata = self.make()
        with patch.object(build_snapshot, "verify_snapshot", wraps=build_snapshot.verify_snapshot) as snapshot_check, \
                patch.object(compiler_inputs, "_verify_tree", wraps=compiler_inputs._verify_tree) as tree_check:
            result = self.materialize(metadata)
        self.assertEqual(snapshot_check.call_count, 1)
        self.assertEqual(tree_check.call_count, 1)

        with patch.object(build_snapshot, "verify_snapshot", wraps=build_snapshot.verify_snapshot) as snapshot_check, \
                patch.object(compiler_inputs, "_verify_tree", wraps=compiler_inputs._verify_tree) as tree_check:
            compiler_inputs.verify(metadata["record_path"], self.build)
        self.assertEqual(snapshot_check.call_count, 1)
        self.assertEqual(tree_check.call_count, 1)

        publish = compiler_inputs._publish_binding

        def mutate_after_publish(root, binding_path, value):
            publish(root, binding_path, value)
            binding_path.write_bytes(b"{}")

        with patch.object(compiler_inputs, "_publish_binding", side_effect=mutate_after_publish):
            with self.assertRaises(compiler_inputs.CompilerInputsError):
                self.materialize(metadata)
        self.assertTrue(Path(result["source_root"]).is_dir())


if __name__ == "__main__":
    unittest.main()
