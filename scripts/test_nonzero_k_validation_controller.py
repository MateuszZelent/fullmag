import unittest
from pathlib import Path
import run_nonzero_k_validation_controller as controller


def write_pinned_controller(storage, job):
    pinned = storage / job["payload"]["capsule_relative"] / "tree/scripts/run_nonzero_k_validation_controller.py"
    pinned.parent.mkdir(parents=True)
    pinned.write_bytes(b"# Capsule uses LF, independent of Windows checkout line endings.\npass\n")
    return pinned


class ControllerTests(unittest.TestCase):
    def test_hash_bound_controller_checkout_matches_commit_and_capsule_bytes(self):
        import hashlib
        import subprocess
        import tempfile

        repository = Path(__file__).resolve().parents[1]
        relative = "scripts/run_nonzero_k_validation_controller.py"
        attributes = subprocess.run(
            ["git", "check-attr", "eol", "--", relative],
            cwd=repository,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(attributes.stdout.strip(), f"{relative}: eol: lf")

        committed = subprocess.run(
            ["git", "show", f"HEAD:{relative}"],
            cwd=repository,
            check=True,
            capture_output=True,
        ).stdout
        executing_path = Path(controller.__file__).resolve()
        self.assertEqual(executing_path.read_bytes(), committed)

        with tempfile.TemporaryDirectory() as temporary:
            capsule = Path(temporary) / "capsule"
            pinned = capsule / relative
            pinned.parent.mkdir(parents=True)
            pinned.write_bytes(committed)
            config = {"controller_sha256": hashlib.sha256(committed).hexdigest()}
            controller.validate_controller_source(config, capsule, executing_path)

    def test_execution_rejects_modified_controller_before_running_pilots(self):
        import hashlib
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executing = root / "executing.py"
            executing.write_bytes(b"pinned controller\n")
            pinned = root / "capsule/scripts/run_nonzero_k_validation_controller.py"
            pinned.parent.mkdir(parents=True)
            pinned.write_bytes(executing.read_bytes())
            config = {"controller_sha256": hashlib.sha256(executing.read_bytes()).hexdigest()}
            controller.validate_controller_source(config, root / "capsule", executing)
            for path in (executing, pinned):
                original = path.read_bytes()
                path.write_bytes(original + b"modified")
                with self.subTest(path=path), self.assertRaises(ValueError):
                    controller.validate_controller_source(config, root / "capsule", executing)
                path.write_bytes(original)

    def test_nearest_series_runs_both_gamma_and_actual_signed_cases(self):
        cases = controller.validation_cases("nearest-single-k")
        self.assertEqual(len(cases), 6)
        self.assertEqual({pilot for _, pilot, _ in cases}, {
            "de-smoke-k0", "de-smoke-bv-k0", "de-smoke-k2", "de-smoke-k-2",
            "de-smoke-bv-k2", "de-smoke-bv-k-2"})
        self.assertTrue(all(layers == "3" for _, _, layers in cases))
        targets = {pilot: 9.0 for _, pilot, _ in cases}
        targets["de-smoke-k2"] = 10.0
        config = {"series": "nearest-single-k", "nearest_targets_ghz": targets}
        self.assertEqual(controller.selected_only_arguments(config, "de-smoke-k2"),
                         ["--spectral-target", "nearest", "--nearest-target-frequency-ghz", "10"])
        self.assertEqual(controller.selected_only_arguments({"series": "signed-13"}, "de-smoke-k2"), [])

    def test_nearest_series_rejects_unpinned_or_invalid_shifts(self):
        pilots = [pilot for _, pilot, _ in controller.validation_cases("nearest-single-k")]
        for targets in (None, {}, {pilot: 9.0 for pilot in pilots[:-1]}):
            with self.subTest(targets=targets), self.assertRaises(ValueError):
                controller.selected_only_arguments({"series": "nearest-single-k", "nearest_targets_ghz": targets}, pilots[0])
        for bad in (True, float("nan"), float("inf"), 1e308, 10**400, 0, -9, "9"):
            targets = {pilot: 9.0 for pilot in pilots}
            targets[pilots[-1]] = bad
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                controller.selected_only_arguments({"series": "nearest-single-k", "nearest_targets_ghz": targets}, pilots[0])

    def test_python_children_disable_bytecode(self):
        command = controller.python_command(Path("capsule/script.py"), "--job-id", "123")
        self.assertEqual(command[1], "-B")
        self.assertEqual(controller.child_environment()["PYTHONDONTWRITEBYTECODE"], "1")

    def test_import_does_not_mutate_immutable_source_tree(self):
        import tempfile
        import subprocess
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "dependency.py").write_text("value = 42", encoding="utf-8")
            entry = root / "entry.py"
            entry.write_text("import dependency; assert dependency.value == 42", encoding="utf-8")
            before = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            result = subprocess.run(controller.python_command(entry), env=controller.child_environment(), capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            after = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            self.assertEqual(before, after)
            self.assertFalse((root / "__pycache__").exists())

    def test_blocked_is_terminal_and_source_identity_must_match(self):
        config = {"job_id": "one", "source_digest": "pinned"}
        data = {**config, "state": "blocked"}
        self.assertIn(controller.build_state(data, config), controller.TERMINAL_FAILURES)
        for key in ("job_id", "source_digest"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                controller.build_state({**data, key: "different"}, config)

    def test_config_preparation_never_creates_coordinator_job_root(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            storage = Path(temporary)
            layout = {"storage_root": str(storage), "repo_root": str(storage / "checkout"),
                      "worktree_id": "worktree-test"}
            job = {"job_id": "a" * 32, "source_digest": "b" * 64,
                   "worktree_id": "worktree-test", "payload": {"capsule_relative":
                   "runs/worktree-test/" + "c" * 32 + "/source"}}
            write_pinned_controller(storage, job)
            config = controller.prepare_controller_config(job, layout, "d" * 40)
            self.assertTrue(config.is_file())
            self.assertFalse((storage / "runs/worktree-test" / job["job_id"]).exists())
            self.assertEqual(controller.validate_observer_root(config, layout, job["job_id"]), config.parent)
            with self.assertRaises(ValueError):
                controller.validate_observer_root(storage / "runs/worktree-test" / job["job_id"] / "controller-config.json", layout, job["job_id"])

    def test_nearest_preparation_pins_shifts_in_saved_configuration(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            storage = Path(temporary)
            layout = {"storage_root": str(storage), "repo_root": str(storage / "checkout"),
                      "worktree_id": "worktree-test"}
            job = {"job_id": "a" * 32, "source_digest": "b" * 64,
                   "worktree_id": "worktree-test", "payload": {"capsule_relative":
                   "runs/worktree-test/" + "c" * 32 + "/source"}}
            pinned = write_pinned_controller(storage, job)
            path = controller.prepare_controller_config(job, layout, "d" * 40, "nearest-single-k")
            config = json.loads(path.read_text(encoding="utf-8"))
            import hashlib
            self.assertEqual(config["controller_sha256"], hashlib.sha256(pinned.read_bytes()).hexdigest())
            controller.validate_controller_source(config, pinned.parents[1], pinned)
            self.assertEqual(config["series"], "nearest-single-k")
            self.assertEqual(config["model_ref"], "d" * 40)
            for _, pilot, _ in controller.validation_cases(config["series"]):
                arguments = controller.selected_only_arguments(config, pilot)
                self.assertEqual(arguments[:2], ["--spectral-target", "nearest"])
                expected = "10" if pilot in {"de-smoke-k2", "de-smoke-k-2"} else "9"
                self.assertEqual(arguments[-1], expected)
            self.assertFalse((storage / "runs/worktree-test" / job["job_id"]).exists())

    def test_preparation_rejects_missing_pinned_source_without_writing_config(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            storage = Path(temporary)
            layout = {"storage_root": str(storage), "repo_root": str(storage / "checkout"),
                      "worktree_id": "worktree-test"}
            job = {"job_id": "a" * 32, "source_digest": "b" * 64,
                   "worktree_id": "worktree-test", "payload": {"capsule_relative":
                   "runs/worktree-test/" + "c" * 32 + "/source"}}
            with self.assertRaisesRegex(ValueError, "controller source in pinned capsule"):
                controller.prepare_controller_config(job, layout, "d" * 40, "nearest-single-k")
            self.assertEqual(list(storage.iterdir()), [])

    def test_config_preparation_rejects_job_identity_and_path_traversal(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            storage = Path(temporary)
            layout = {"storage_root": str(storage), "repo_root": str(storage), "worktree_id": "wt"}
            for job in ({"job_id": "../job", "worktree_id": "wt"},
                        {"job_id": "a" * 32, "worktree_id": "different"}):
                with self.subTest(job=job), self.assertRaises(ValueError):
                    controller.prepare_controller_config(job, layout, "b" * 40)
            self.assertEqual(list(storage.iterdir()), [])

    def test_success_requires_exit_zero(self):
        config = {"job_id": "one", "source_digest": "pinned"}
        for code in (None, 1):
            with self.subTest(code=code), self.assertRaises(ValueError):
                controller.build_state({**config, "state": "succeeded", "exit_code": code}, config)
        self.assertEqual(controller.build_state({**config, "state": "succeeded", "exit_code": 0}, config), "succeeded")


if __name__ == "__main__": unittest.main()
