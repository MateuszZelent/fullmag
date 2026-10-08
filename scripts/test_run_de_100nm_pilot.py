"""Regression checks for the immutable DE pilot execution route."""
import contextlib
from dataclasses import dataclass
import hashlib
import io
import os
import runpy
import sys
import types
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import json
import zipfile
import yaml
import run_de_100nm_pilot as pilot


class _ComposeOverrideLoader(yaml.SafeLoader):
    pass


_ComposeOverrideLoader.add_constructor(
    "!reset", lambda loader, node: loader.construct_sequence(node, deep=True)
)


class _FixtureDslRecorder:
    def __init__(self):
        self.mesh_calls = []
        self.runtime_metadata = []


@dataclass(frozen=True)
class _FixtureFieldAutosave:
    quantity: str
    every: object = None
    every_steps: int | None = None


@dataclass(frozen=True)
class _FixtureStageAutosave:
    target: str = "main"
    layout: str = "continuous"
    format: str = "zarr"
    table: object | None = None
    fields: tuple[_FixtureFieldAutosave, ...] = ()


class _FixtureDslNode:
    def __init__(self, recorder, path):
        object.__setattr__(self, "_recorder", recorder)
        object.__setattr__(self, "_path", path)

    def __getattr__(self, name):
        return _FixtureDslNode(self._recorder, f"{self._path}.{name}")

    def __setattr__(self, name, value):
        if name.startswith("_"):
            object.__setattr__(self, name, value)

    def __call__(self, *args, **kwargs):
        if self._path == "study().universe.mesh":
            self._recorder.mesh_calls.append(kwargs)
        elif self._path == "study().runtime_metadata":
            self._recorder.runtime_metadata.append(args[1])
        return _FixtureDslNode(self._recorder, self._path + "()")


def _write_fms_fixture(
    root, *, session_id="session-1", snapshot_session_id=None,
    snapshot_run_id="run-1", manifest_run_id=None,
    archive_dispersion=b"dispersion", local_dispersion=b"dispersion",
):
    root = Path(root)
    case = root / "case"
    (case / "eigen").mkdir(parents=True, exist_ok=True)
    (case / "metadata.json").write_bytes(b"metadata")
    (case / "eigen/dispersion.csv").write_bytes(local_dispersion)
    archive_path = root / "pilot.fms"
    manifest_run_id = manifest_run_id or snapshot_run_id
    snapshot_session_id = snapshot_session_id or session_id
    run_ref = f"runs/{snapshot_run_id}/run_manifest.json"
    main_script = b"print('ok')\n"
    session_manifest = {
        "format": "fullmag.session.v1",
        "session_id": session_id,
        "name": "DE smoke",
        "profile": "archive",
        "created_by_version": "0.0.0-test",
        "created_at": "2026-10-02T00:00:00Z",
        "saved_at": "2026-10-02T00:00:00Z",
        "run_refs": [run_ref],
        "workspace_ref": "manifest/workspace.json",
        "export_profile_ref": "manifest/export_profile.json",
    }
    workspace_manifest = {
        "workspace_id": "local-live",
        "problem_name": "DE smoke",
        "project_ref": "project/",
        "script_ref": "project/main.py",
        "script_sha256": hashlib.sha256(main_script).hexdigest(),
        "ui_state_ref": "project/ui_state.json",
        "scene_document_ref": "project/scene_document.json",
        "script_builder_ref": "project/script_builder.json",
    }
    export_profile = {
        "profile": "archive",
        "include_fields": "all_registered",
        "include_artifacts": "all",
        "include_meshes": True,
        "include_logs": True,
        "include_source_files": True,
        "compression": "balanced",
    }
    snapshot = {
        "session": {
            "session_id": snapshot_session_id,
            "run_id": snapshot_run_id,
            "requested_backend": "fem",
            "precision": "double",
        },
        "run": {"run_id": snapshot_run_id},
    }
    run_manifest = {
        "run_id": manifest_run_id,
        "status": "completed",
        "backend": "fem",
        "precision": "double",
    }
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("manifest/session.json", json.dumps(session_manifest))
        archive.writestr("manifest/workspace.json", json.dumps(workspace_manifest))
        archive.writestr("manifest/export_profile.json", json.dumps(export_profile))
        archive.writestr("project/main.py", main_script)
        archive.writestr("project/ui_state.json", b"{}")
        archive.writestr(
            "project/current_live_snapshot.json", json.dumps(snapshot)
        )
        archive.writestr(run_ref, json.dumps(run_manifest))
        archive.writestr(
            f"runs/{snapshot_run_id}/artifacts/metadata.json", b"metadata"
        )
        archive.writestr(
            f"runs/{snapshot_run_id}/artifacts/eigen/dispersion.csv",
            archive_dispersion,
        )
    status = {
        "session": {"session_id": session_id, "session_epoch": "epoch-1"},
        "run": {"run_id": snapshot_run_id},
        "domain": {"cell_count": 12},
        "resources": {"field_catalog_revision": 3},
    }
    return archive_path, case, {
        "schema": "fullmag.live-export-receipt.v1",
        "solver_exit_code": 0,
        "before_status": status,
        "after_status": json.loads(json.dumps(status)),
    }


def _schur_action_fixture(*, status="measured"):
    diagnostic = {
        "schema_version": "floquet_schur_action_diagnostic.v1",
        "status": status,
        "reason": "bounded_action_and_matshell_observation" if status == "measured" else "diagnostic_not_reached_before_solver_setup_failure",
        "available": status == "measured",
        "pre_eps_only": True,
        "dense_materialization": False,
        "measurement_phase": "before_eps_solve",
        "workspace_scope": "isolated_clone_of_production_context",
    }
    if status == "measured":
        diagnostic.update({
            "q_complex_dof_count": 32,
            "real_split_dimension": 64,
            "context_phase_sign": -1,
            "action_count": 9,
            "expected_action_count": 9,
            "nonzero_signal_count": 9,
            "operator_normalization_scale": 1.0,
            "preconditioner_normalization_scale": 1.0,
            **{name: 0.0 for name in pilot.SCHUR_ACTION_DIAGNOSTIC_DEFECT_FIELDS},
        })
    return diagnostic


def _build_context_for_container_cleanup(root: Path) -> pilot.managed.BuildContext:
    root = Path(root)
    job_id = "a" * 32
    worktree_id = "worktree-a"
    run_root = root / "runs" / worktree_id / job_id
    artifacts = run_root / "artifacts"
    capsule = run_root / "source"
    source_tree = capsule / "tree"
    runtime_root = artifacts / "outputs" / ".fullmag" / "local"
    repo_root = root / "repo"
    source_tree.mkdir(parents=True, exist_ok=True)
    runtime_root.mkdir(parents=True, exist_ok=True)
    repo_root.mkdir(parents=True, exist_ok=True)

    job = {
        "job_id": job_id,
        "worktree_id": worktree_id,
        "profile": "fem-cpu-slepc-runtime-v1",
        "source_digest": "b" * 64,
        "payload": {"capsule_relative": f"runs/{worktree_id}/{job_id}/source"},
    }
    native_identity = {
        "schema": "fullmag.source-snapshot.v2",
        "head_commit_full": "d" * 40,
        "source_snapshot_sha256": "e" * 64,
    }
    return pilot.managed.BuildContext(
        layout={"storage_root": str(root), "repo_root": str(repo_root), "env": {}},
        job=job,
        manifest={"resolved_commit": native_identity["head_commit_full"], "files": []},
        native_identity=native_identity,
        receipt={"artifact_hashes": {}},
        run_root=run_root,
        artifacts=artifacts,
        capsule=capsule,
        source_tree=source_tree,
        runtime_root=runtime_root,
    )


_FIXTURE_MODEL_SHA256 = "a" * 64


def _fixture_runtime_artifacts(root, case):
    run_id, session_id = "run-session-17", "session-17"
    workspace = root / f"{case}-{run_id}-0"
    artifacts = workspace / "artifacts"
    artifacts.mkdir(parents=True)
    log_root = root / case
    log_root.mkdir(exist_ok=True)
    container = "/workspace/benchmark-output/" + workspace.name
    summary = {"status": "completed", "backend": "fem", "mode": "strict", "precision": "double",
               "workspace_dir": container, "artifact_dir": container + "/artifacts",
               "run_id": run_id, "session_id": session_id}
    manifest = {"schema": "fullmag.run_manifest.v1", "status": "completed", "exit_code": 0,
                "source": {"sha256": _FIXTURE_MODEL_SHA256}, "run_id": run_id, "session_id": session_id,
                "outputs": [{"path": "artifacts/metadata.json", "kind": "metadata"}]}
    storage = {"schema": "fullmag.output_storage.resolved.v1", "state": "succeeded",
               "resolved": {"output_dir": container, "run_id": run_id}}
    metadata = {"source_hash": _FIXTURE_MODEL_SHA256,
                "problem_meta": {"runtime_metadata": {"producer_run_id": run_id}}}
    for path, value in [(log_root / "runtime.log", summary), (workspace / "fullmag-run.json", manifest),
                        (workspace / "output-storage.json", storage), (artifacts / "metadata.json", metadata)]:
        path.write_text(json.dumps(value), encoding="utf-8")
    return artifacts


_real_container_cleanup = pilot.managed._cleanup_benchmark_container


def _fixture_container_cleanup(context, output, **kwargs):
    # Exercise real ownership/mount validation with an absent fixture container.
    docker_absent = lambda *args, **kw: SimpleNamespace(
        returncode=1, stdout="", stderr="Error: No such object: fixture-container"
    )
    return _real_container_cleanup(
        context, output, run=docker_absent, **kwargs
    )


class PilotTests(unittest.TestCase):
    def test_requires_pilot_from_build_capsule(self):
        with TemporaryDirectory() as tmp:
            context = SimpleNamespace(source_tree=Path(tmp), manifest={"files": []})
            with self.assertRaises(pilot.managed.BenchmarkError):
                pilot.validate_model(context)

    def test_rejects_modified_pilot(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / pilot.MODEL
            path.parent.mkdir()
            path.write_bytes(b"changed")
            context = SimpleNamespace(source_tree=root, manifest={"files": [
                {"path": pilot.MODEL, "sha256": hashlib.sha256(b"original").hexdigest()}
            ]})
            with self.assertRaises(pilot.managed.BenchmarkError):
                pilot.validate_model(context)

    def test_successful_execution_remains_scientifically_unqualified(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            case_dir = _fixture_runtime_artifacts(root, "de100")
            context = _build_context_for_container_cleanup(root)
            request = {"source": {}, "job": {}, "runtime": {}}
            with patch.object(pilot.managed, "_run_request", return_value=request), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}) as compose_env, \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={"case": "c1"}), \
                 patch.object(pilot.managed, "_cleanup_benchmark_container", side_effect=_fixture_container_cleanup), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], _FIXTURE_MODEL_SHA256), 0)
            compose_env.assert_called_once_with(context.layout, context.image_digest)
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(result["status"], "completed_unqualified")
            self.assertEqual(result["qualification"], "NOT VERIFIED")
            self.assertEqual(result["artifacts"]["case"], "de100")

    def test_process_failure_records_terminal_result(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = SimpleNamespace(
                layout={"repo_root": str(root)}, image_digest="sha256:test"
            )
            request = {"source": {}, "job": {}, "runtime": {}}
            with patch.object(pilot.managed, "_run_request", return_value=request), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=7)), \
                 patch.object(pilot.managed, "_cleanup_benchmark_container", return_value={"status": "absent"}), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], "abc"), 1)
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(result["return_code"], 7)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_timeout_and_interrupt_cleanup_and_record_failure(self):
        for failure in (pilot.subprocess.TimeoutExpired("docker", 3), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__), TemporaryDirectory() as tmp:
                root = Path(tmp)
                context = SimpleNamespace(
                    layout={"repo_root": str(root)}, image_digest="sha256:test"
                )
                request = {"source": {}, "job": {}, "runtime": {}}
                with patch.object(pilot.managed, "_run_request", return_value=request), \
                     patch.object(pilot.managed, "_compose_environment", return_value={}), \
                     patch.object(pilot.subprocess, "run", side_effect=failure) as run, \
                     patch.object(pilot.managed, "_cleanup_benchmark_container", return_value={"status": "stopped"}) as cleanup, \
                     patch("builtins.print"):
                    self.assertEqual(pilot.execute(context, root, ["docker"], "abc", timeout_seconds=3), 1)
                cleanup.assert_called_once_with(context, root)
                self.assertEqual(run.call_args.kwargs["timeout"], 3 + pilot.managed.CONTAINER_TIMEOUT_GRACE_SECONDS + pilot.managed.HOST_COMPOSE_GRACE_SECONDS)
                result = json.loads((root / "run-result.json").read_text())
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["container_cleanup"]["status"], "stopped")
                self.assertIn("error", result)

    def test_smoke_sampling_is_explicit_and_capsule_bound(self):
        for name, sampling in (("de-smoke-two", "two"), ("de-smoke-five", "five")):
            with self.subTest(pilot=name), TemporaryDirectory() as tmp:
                root = Path(tmp)
                model = pilot.pilot_model(name)
                path = root / model
                path.parent.mkdir()
                path.write_bytes(b"frozen model")
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                context = SimpleNamespace(source_tree=root, runtime_root=Path("/runtime"),
                    image_digest="sha256:test", job={"job_id": "b" * 32, "profile": "fem-cpu-slepc-runtime-v1"},
                    manifest={"files": [{"path": model, "sha256": digest}]})
                self.assertEqual(pilot.validate_model(context, name), digest)
                command = pilot.compose_command(context, Path("/outputs"), pilot=name)
                self.assertIn("export FULLMAG_DE_SMOKE_SAMPLING=" + sampling, command[-1])
                self.assertIn("case_dir=/workspace/benchmark-output/" + name, command[-1])
                self.assertIn("source_script=/workspace/capsule/" + model, command[-1])
                path.write_bytes(b"mutated")
                with self.assertRaises(pilot.managed.BenchmarkError):
                    pilot.validate_model(context, name)

    def test_unknown_pilot_cannot_inject_shell_or_path(self):
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot.compose_command(None, Path("/outputs"), pilot="../other; echo bad")

    def test_smoke_receipt_and_artifacts_remain_separate(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            case_dir = _fixture_runtime_artifacts(root, "de-smoke-two")
            context = _build_context_for_container_cleanup(root)
            with patch.object(pilot.managed, "_run_request", return_value={"source": {}, "job": {}, "runtime": {}}), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={}) as validate, \
                 patch.object(pilot, "validate_rows", return_value={"qualification": "NOT VERIFIED", "sample_count": 2}) as row_check, \
                 patch.object(pilot, "validate_smoke_potential_fields", return_value={"qualification": "NOT VERIFIED"}) as field_check, \
                 patch.object(pilot.managed, "_cleanup_benchmark_container", side_effect=_fixture_container_cleanup), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], _FIXTURE_MODEL_SHA256, pilot="de-smoke-two"), 0)
            validate.assert_called_once_with(case_dir, "c1")
            row_check.assert_called_once_with(
                case_dir / "eigen/dispersion.csv", "two",
                case_dir / "eigen/diagnostics/solver.v1.json",
                case_dir / "metadata.json")
            field_check.assert_called_once_with(case_dir, 2)
            request = json.loads((root / "run-request.json").read_text())
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(request["schema"], "fullmag.de-smoke.request.v1")
            self.assertEqual(request["sampling"], "two")
            self.assertEqual(request["public_model"], pilot.pilot_model("de-smoke-two"))
            self.assertEqual(result["qualification"], "NOT VERIFIED")
            self.assertEqual(result["artifacts"]["case"], "de-smoke-two")

    def test_smoke_invalid_rows_cannot_be_completed(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            case_dir = _fixture_runtime_artifacts(root, "de-smoke-two")
            context = _build_context_for_container_cleanup(root)
            with patch.object(pilot.managed, "_run_request", return_value={"source": {}, "job": {}, "runtime": {}}), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={}), \
                 patch.object(pilot, "validate_rows", side_effect=ValueError("missing DE-SMOKE samples")), \
                 patch.object(pilot.managed, "_cleanup_benchmark_container", side_effect=_fixture_container_cleanup), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], _FIXTURE_MODEL_SHA256, pilot="de-smoke-two"), 1)
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["return_code"], 0)
            self.assertIn("missing DE-SMOKE samples", result["error"])

    def test_potential_reconstruction_requires_every_published_mode(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "metadata.json").write_text("{}")
            for index in range(2):
                mode = root / f"eigen/mode_fields/sample_{index:04}/mode_0000"
                mode.mkdir(parents=True)
                (mode / "vector.bin").write_bytes(b"mode")
                (mode / "physical_potential.v1.json").write_text("{}")
                published = root / f"eigen/modes/sample_{index:04}/mode_0000.json"
                published.parent.mkdir(parents=True)
                published.write_text("{}")
            with patch.object(pilot, "validate_physical_potential", return_value={
                "status": "consistent", "reconstruction_agreement": True,
                "identity_binding": {"status": "consistent"},
                "source_mesh_binding": {"status": "consistent"},
                "qualification": "NOT VERIFIED"}) as validate:
                result = pilot.validate_smoke_potential_fields(root, 2)
            self.assertEqual(validate.call_count, 2)
            self.assertEqual(result["mode_count"], 2)
            self.assertEqual(result["qualification"], "NOT VERIFIED")
            (root / "eigen/mode_fields/sample_0001/mode_0000/vector.bin").unlink()
            with self.assertRaisesRegex(pilot.managed.BenchmarkError, "cover samples"):
                pilot.validate_smoke_potential_fields(root, 2)
            (mode / "physical_potential.v1.json").unlink()
            with patch.object(pilot, "validate_physical_potential", return_value={
                "status": "consistent", "reconstruction_agreement": True}):
                with self.assertRaises(pilot.managed.BenchmarkError):
                    pilot.validate_smoke_potential_fields(root, 2)

    def test_potential_reconstruction_rejects_missing_mode_in_same_sample(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "metadata.json").write_text("{}")
            field = root / "eigen/mode_fields/sample_0000/mode_0000"
            field.mkdir(parents=True)
            (field / "vector.bin").write_bytes(b"mode")
            (field / "physical_potential.v1.json").write_text("{}")
            published = root / "eigen/modes/sample_0000"
            published.mkdir(parents=True)
            for index in (0, 1):
                (published / f"mode_{index:04}.json").write_text("{}")
            with patch.object(pilot, "validate_physical_potential", return_value={
                "status": "consistent", "reconstruction_agreement": True,
                "identity_binding": {"status": "consistent"},
                "source_mesh_binding": {"status": "consistent"}}):
                with self.assertRaisesRegex(pilot.managed.BenchmarkError, "published mode.*field"):
                    pilot.validate_smoke_potential_fields(root, 1)
                # Conversely, a field may not silently introduce an unpublished mode.
                (published / "mode_0001.json").unlink()
                extra = root / "eigen/mode_fields/sample_0000/mode_0001"
                extra.mkdir()
                (extra / "vector.bin").write_bytes(b"unpublished mode")
                with self.assertRaisesRegex(pilot.managed.BenchmarkError, "unpublished fields"):
                    pilot.validate_smoke_potential_fields(root, 1)

    def test_smoke_rejects_correct_gradient_with_wrong_mode_phase_identity(self):
        from test_de_physical_potential import PhysicalPotentialFixture
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = PhysicalPotentialFixture(root)
            (fixture.mode_dir / "vector.bin").write_bytes(b"published mode")
            identities = {key: "sha256:" + char * 64 for key, char in (
                ("source_mesh_topology_sha256", "a"),
                ("operator_input_signature_sha256", "b"),
                ("phase_constraint_sha256", "c"))}
            manifest = json.loads(fixture.manifest_path.read_text())
            manifest.update(sample_index=0, mode_index=0, **identities)
            fixture.manifest_path.write_text(json.dumps(manifest))
            mode = root / "eigen/modes/sample_0000/mode_0000.json"
            mode.parent.mkdir(parents=True)
            data = {"sample_index": 0, "raw_mode_index": 0, **identities}
            data["phase_constraint_sha256"] = "sha256:" + "f" * 64
            mode.write_text(json.dumps(data))
            # Its gradient is correct; its producer identity belongs elsewhere.
            self.assertTrue(pilot.validate_physical_potential(
                fixture.manifest_path, fixture.metadata_path)["reconstruction_agreement"])
            with self.assertRaisesRegex(ValueError, "phase_constraint_sha256"):
                pilot.validate_smoke_potential_fields(root, 1)

    def test_smoke_sample_count_rejects_bool(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            mode = root / "eigen/mode_fields/sample_0000/mode_0000"
            mode.mkdir(parents=True)
            (mode / "vector.bin").write_bytes(b"mode")
            with self.assertRaisesRegex(pilot.managed.BenchmarkError, "expected samples"):
                pilot.validate_smoke_potential_fields(root, True)

    def test_smoke_inconsistent_field_cannot_be_completed_after_exit_zero(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            case_dir = _fixture_runtime_artifacts(root, "de-smoke-two")
            context = _build_context_for_container_cleanup(root)
            with patch.object(pilot.managed, "_run_request", return_value={"source": {}, "job": {}, "runtime": {}}), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={}), \
                 patch.object(pilot, "validate_rows", return_value={"sample_count": 2}), \
                 patch.object(pilot, "validate_smoke_potential_fields", side_effect=ValueError("gradient mismatch")), \
                 patch.object(pilot.managed, "_cleanup_benchmark_container", side_effect=_fixture_container_cleanup), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], _FIXTURE_MODEL_SHA256, pilot="de-smoke-two"), 1)
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["return_code"], 0)
            self.assertIn("gradient mismatch", result["error"])

    def test_command_selects_numerical_pilot_without_case_override(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v1"})
        command = pilot.compose_command(context, Path("/outputs"))
        shell = command[-1]
        self.assertIn("/workspace/capsule/" + pilot.MODEL, shell)
        self.assertNotIn("FULLMAG_COMSOL_DISPERSION_CASE", shell)
        self.assertIn("--backend fem --mode strict --precision double", shell)
        self.assertIn(str(Path("/outputs")) + ":/workspace/benchmark-output:rw", command)
        self.assertIn(str(Path("/capsule")) + ":/workspace/capsule:ro", command)
        self.assertNotIn("build", command)

    def test_schur_action_diagnostic_is_opt_in_and_scoped(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v1"})
        default_shell = pilot.compose_command(
            context, Path("/outputs"), pilot="de-smoke-k2"
        )[-1]
        self.assertNotIn("FULLMAG_FLOQUET_SCHUR_ACTION_DIAGNOSTIC", default_shell)
        diagnostic_shell = pilot.compose_command(
            context, Path("/outputs"), pilot="de-smoke-k2",
            schur_action_diagnostic=True,
        )[-1]
        self.assertIn("export FULLMAG_FLOQUET_SCHUR_ACTION_DIAGNOSTIC=1", diagnostic_shell)
        with self.assertRaisesRegex(pilot.managed.BenchmarkError, "non-parallel DE-SMOKE"):
            pilot.compose_command(
                context, Path("/outputs"), pilot="de100",
                schur_action_diagnostic=True,
            )
        with self.assertRaisesRegex(pilot.managed.BenchmarkError, "non-parallel DE-SMOKE"):
            pilot.compose_command(
                context, Path("/outputs"), pilot=pilot.PARALLEL_PROBE_PILOT,
                schur_action_diagnostic=True,
            )

    def test_schur_action_diagnostic_validator_preserves_native_states(self):
        with TemporaryDirectory() as tmp:
            case = Path(tmp) / "case"
            diagnostics = case / "eigen/diagnostics"
            diagnostics.mkdir(parents=True)
            path = diagnostics / "solver.v1.json"
            path.write_text(json.dumps({
                "floquet_schur_action_diagnostic": _schur_action_fixture(),
            }), encoding="utf-8")
            measured = pilot.validate_schur_action_diagnostic(case)
            self.assertEqual(measured["status"], "measured")
            self.assertEqual(measured["validation_status"], "pass")
            self.assertFalse(measured["physical_certificate"])

            unavailable_native = _schur_action_fixture(status="unavailable")
            unavailable_native.update({
                "q_complex_dof_count": None,
                "real_split_dimension": None,
                "max_potential_relative_residual": None,
            })
            path.write_text(json.dumps({
                "floquet_schur_action_diagnostic": unavailable_native,
            }), encoding="utf-8")
            unavailable = pilot.validate_schur_action_diagnostic(case)
            self.assertEqual(unavailable["status"], "unavailable")
            self.assertEqual(unavailable["validation_status"], "preserved")

            path.write_text(json.dumps({
                "floquet_schur_action_diagnostic": _schur_action_fixture(status="failed"),
            }), encoding="utf-8")
            failed = pilot.validate_schur_action_diagnostic(case)
            self.assertEqual(failed["status"], "failed")
            self.assertEqual(failed["validation_status"], "preserved")

            malformed = _schur_action_fixture()
            for invalid_count in (10, 9.5, True, -1, 8):
                with self.subTest(invalid_count=invalid_count):
                    malformed["action_count"] = invalid_count
                    path.write_text(json.dumps({
                        "floquet_schur_action_diagnostic": malformed,
                    }), encoding="utf-8")
                    invalid = pilot.validate_schur_action_diagnostic(case)
                    self.assertEqual(invalid["status"], "measured")
                    self.assertEqual(invalid["validation_status"], "failed")
                    self.assertIn("action_count", invalid["validation_errors"])

            partial = _schur_action_fixture(status="failed")
            partial["action_count"] = 0
            path.write_text(json.dumps({
                "floquet_schur_action_diagnostic": partial,
            }), encoding="utf-8")
            partial_report = pilot.validate_schur_action_diagnostic(case)
            self.assertEqual(partial_report["status"], "failed")
            self.assertEqual(partial_report["validation_status"], "preserved")

    def test_schur_action_reads_every_indexed_native_window(self):
        with TemporaryDirectory() as tmp:
            case = Path(tmp) / "case"
            diagnostics = case / "eigen/diagnostics"
            diagnostics.mkdir(parents=True)
            path = diagnostics / "solver.v1.json"
            windows = [{"index": index,
                        "floquet_schur_action_diagnostic": _schur_action_fixture()}
                       for index in range(3)]
            payload = {"schema_version": "frequency_domain_modal_solver_diagnostics.v1",
                       "sample_solver_diagnostics": [{"sample_index": 0, "diagnostics": {
                           "k_vector_len": 3, "k_vector_rad_m": [0, -25e6, 0], "subwindows": windows}}]}
            path.write_text(json.dumps(payload), encoding="utf-8")
            result = pilot.validate_schur_action_diagnostic(case)
            self.assertEqual(result["validation_status"], "pass")
            self.assertEqual(result["observation_count"], 3)
            self.assertEqual([item["window_index"] for item in result["observations"]], [0, 1, 2])
            self.assertFalse(result["physical_certificate"])
            del windows[1]["floquet_schur_action_diagnostic"]
            path.write_text(json.dumps(payload), encoding="utf-8")
            result = pilot.validate_schur_action_diagnostic(case)
            self.assertEqual(result["validation_status"], "unavailable")
            windows[1]["floquet_schur_action_diagnostic"] = _schur_action_fixture(status="failed")
            path.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(pilot.validate_schur_action_diagnostic(case)["status"], "failed")

    def test_schur_indexed_identity_rejects_unknown_schema_and_invalid_vectors(self):
        with TemporaryDirectory() as tmp:
            case = Path(tmp) / "case"
            diagnostics = case / "eigen/diagnostics"
            diagnostics.mkdir(parents=True)
            path = diagnostics / "solver.v1.json"
            good_sample = {"k_vector_len": 3, "k_vector_rad_m": [0, -25e6, 0],
                           "subwindows": [{"index": 0,
                             "floquet_schur_action_diagnostic": _schur_action_fixture()}]}
            for schema in (None, [], "unknown.v9"):
                payload = {"schema_version": schema, "sample_solver_diagnostics": [
                    {"sample_index": 0, "diagnostics": good_sample}]}
                path.write_text(json.dumps(payload), encoding="utf-8")
                self.assertEqual(pilot.validate_schur_action_diagnostic(case)["validation_status"], "failed")
            for bad_vector in (None, [], [0, 1], [0, True, 0], [0, float("inf"), 0], [0, 10**1000, 0]):
                payload = {"schema_version": "frequency_domain_modal_solver_diagnostics.v1",
                           "sample_solver_diagnostics": [{"sample_index": 0, "diagnostics": {
                               **good_sample, "k_vector_rad_m": bad_vector}}]}
                path.write_text(json.dumps(payload), encoding="utf-8")
                self.assertEqual(pilot.validate_schur_action_diagnostic(case)["validation_status"], "failed")

    def test_schur_action_diagnostic_exports_unavailable_after_solver_failure(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = SimpleNamespace(
                layout={"repo_root": str(root)}, image_digest="sha256:test"
            )
            request = {"source": {}, "job": {}, "runtime": {}}
            with patch.object(pilot.managed, "_run_request", return_value=request), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=7)), \
                 patch.object(pilot.managed, "_cleanup_benchmark_container", return_value={"status": "absent"}), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(
                    context, root, ["docker"], "abc", pilot="de-smoke-k2",
                    schur_action_diagnostic=True,
                ), 1)
            result = json.loads((root / "run-result.json").read_text())
            self.assertTrue(result["schur_action_diagnostic_requested"])
            self.assertEqual(
                result["artifacts"]["floquet_schur_action_diagnostic"]["status"],
                "unavailable",
            )

    def test_schur_action_failure_does_not_block_solver_artifact_export(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            case_dir = _fixture_runtime_artifacts(root, "de-smoke-k2")
            case = case_dir / "eigen/diagnostics"
            case.mkdir(parents=True)
            (case / "solver.v1.json").write_text(json.dumps({
                "floquet_schur_action_diagnostic": _schur_action_fixture(status="failed"),
            }), encoding="utf-8")
            context = _build_context_for_container_cleanup(root)
            request = {"source": {}, "job": {}, "runtime": {}}
            with patch.object(pilot.managed, "_run_request", return_value=request), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={}), \
                 patch.object(pilot, "validate_rows", return_value={"sample_count": 1}), \
                 patch.object(pilot, "validate_smoke_potential_fields", return_value={}), \
                 patch.object(pilot.managed, "_cleanup_benchmark_container", side_effect=_fixture_container_cleanup), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(
                    context, root, ["docker"], _FIXTURE_MODEL_SHA256, pilot="de-smoke-k2",
                    schur_action_diagnostic=True,
                ), 0)
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(result["status"], "completed_unqualified")
            self.assertEqual(
                result["artifacts"]["floquet_schur_action_diagnostic"]["status"],
                "failed",
            )
            self.assertEqual(
                result["artifacts"]["floquet_schur_action_diagnostic"]["validation_status"],
                "preserved",
            )

    def test_frequency_window_override_is_paired_and_explicit(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v1"})
        shell = pilot.compose_command(
            context, Path("/outputs"), pilot="de-smoke-two",
            frequency_min_ghz="10.9", frequency_max_ghz="11.5",
        )[-1]
        self.assertIn("FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ=10.9", shell)
        self.assertIn("FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ=11.5", shell)
        for minimum, maximum in (
            ("10.9", None), (None, "11.5"), ("11.5", "10.9"),
            ("nan", "11.5"), ("10.9", "inf"),
        ):
            with self.subTest(minimum=minimum, maximum=maximum), self.assertRaises(
                pilot.managed.BenchmarkError
            ):
                pilot.compose_command(
                    context, Path("/outputs"), pilot="de-smoke-two",
                    frequency_min_ghz=minimum, frequency_max_ghz=maximum,
                )
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot.compose_command(
                context, Path("/outputs"), pilot="de-smoke-two",
                spectral_target="nearest", frequency_min_ghz="10.9",
                frequency_max_ghz="11.5",
            )
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot.compose_command(
                context, Path("/outputs"), pilot="de100",
                frequency_min_ghz="10.9", frequency_max_ghz="11.5",
            )

    def test_with_ui_keeps_solver_resources_and_publishes_real_workspace(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v1"})
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "output"
            output.mkdir()
            web = root / "web"
            web.mkdir()
            (web / "index.html").write_text("<html></html>", encoding="utf-8")
            command = pilot.compose_command(
                context, output, pilot="de-smoke-two", ui_web_root=web,
                ui_host_port=18181,
            )
            shell = command[-1]
            override = (output / "compose.benchmark.override.yaml").read_text()
            document = yaml.load(override, Loader=_ComposeOverrideLoader)
            service = document["services"]["fem-modal-cpu"]
            self.assertIn("--publish 127.0.0.1:18181:8081", " ".join(command))
            self.assertIn(
                "      - /workspace/fullmag-ui-workspace:rw,nosuid,nodev,size=1g",
                override,
            )
            self.assertEqual(
                service["tmpfs"],
                ["/workspace/fullmag-ui-workspace:rw,nosuid,nodev,size=1g"],
            )
            self.assertEqual(service["volumes"], [])
            self.assertNotIn("--tmpfs", " ".join(command))
            self.assertIn("FULLMAG_REPO_ROOT=/workspace/fullmag-ui-workspace", " ".join(command))
            self.assertIn("FULLMAG_STATE_ROOT=/workspace/fullmag-ui-workspace/.fullmag", " ".join(command))
            self.assertIn("FULLMAG_SKIP_CONTROL_ROOM=1", shell)
            self.assertIn("FULLMAG_DISABLE_PREVIEW_3D=0", shell)
            self.assertIn("FULLMAG_DISABLE_CHARTS=0", shell)
            self.assertIn("v2/sessions/current/status", shell)
            self.assertIn("v2/platform/openapi.json", shell)
            self.assertNotIn("v1/openapi.json", shell)
            self.assertIn("x-fullmag-session-scope", shell)
            self.assertIn("resources.get('field_catalog_revision')", shell)
            self.assertIn("type(field_catalog_revision) is not int", shell)
            self.assertIn("if error.code != 404:", shell)
            self.assertNotIn("error.code not in (404, 409)", shell)
            self.assertNotIn("--headless", shell)
            self.assertTrue((output / "compose.benchmark.override.yaml").is_file())

    def test_cleanup_mount_contract_includes_model_ui_tmpfs_and_web_bind(self):
        with TemporaryDirectory() as tmp:
            output = Path(tmp) / "output"
            web = output / "ui-web"
            web.mkdir(parents=True)
            mounts = pilot._cleanup_extra_mounts(
                output,
                model_identity={"sha256": "a" * 64},
                ui_enabled=True,
                ui_web_root=web,
            )
            by_destination = {mount["destination"]: mount for mount in mounts}
            self.assertEqual(
                by_destination["/workspace/benchmark-model.py"]["source"],
                str((output / "model-input.py").resolve()),
            )
            self.assertEqual(
                by_destination[pilot.UI_WORKSPACE_ROOT]["type"], "tmpfs"
            )
            self.assertEqual(
                by_destination[pilot.UI_WORKSPACE_ROOT]["mode"],
                "rw,nosuid,nodev,size=1g",
            )
            self.assertEqual(
                by_destination[pilot.UI_WEB_ROOT]["source"],
                str(web.resolve()),
            )

    def test_runtime_capsule_signature_ignores_only_declared_non_runtime_paths(self):
        base = {
            "files": [
                {"path": "src/runtime.rs", "type": "file", "mode": "100644",
                 "size": 1, "sha256": "a"},
                {"path": "apps/control-room/src/App.tsx", "type": "file", "mode": "100644",
                 "size": 1, "sha256": "b"},
                {"path": "docs/design.md", "type": "file", "mode": "100644",
                 "size": 1, "sha256": "c"},
            ]
        }
        frontend = {
            "files": [
                base["files"][0],
                {"path": "apps/control-room/src/App.tsx", "type": "file", "mode": "100644",
                 "size": 2, "sha256": "changed"},
                {"path": "docs/design.md", "type": "file", "mode": "100644",
                 "size": 2, "sha256": "changed"},
            ]
        }
        self.assertEqual(
            pilot._runtime_capsule_signature(base),
            pilot._runtime_capsule_signature(frontend),
        )
        frontend["files"][0] = {**frontend["files"][0], "sha256": "changed-runtime"}
        self.assertNotEqual(
            pilot._runtime_capsule_signature(base),
            pilot._runtime_capsule_signature(frontend),
        )

    def test_openapi_contract_signature_is_exact_even_inside_frontend_tree(self):
        manifest = {
            "files": [
                {"path": path, "type": "file", "mode": "100644",
                 "size": index + 1, "sha256": str(index)}
                for index, path in enumerate(pilot.OPENAPI_CONTRACT_PATHS)
            ]
        }
        same = pilot._exact_openapi_contract_signature(manifest, "runtime")
        changed = {**manifest, "files": [*manifest["files"]]}
        changed["files"][0] = {**changed["files"][0], "sha256": "changed"}
        self.assertNotEqual(
            same, pilot._exact_openapi_contract_signature(changed, "frontend")
        )
        with self.assertRaisesRegex(pilot.managed.BenchmarkError, "missing generated"):
            pilot._exact_openapi_contract_signature(
                {"files": manifest["files"][1:]}, "frontend"
            )

    def test_fms_archive_binds_session_run_and_local_artifact_hashes(self):
        with TemporaryDirectory() as tmp:
            archive_path, case, receipt = _write_fms_fixture(Path(tmp))
            report = pilot.validate_fms_archive(
                archive_path, status_receipt=receipt, case_dir=case,
                solver_exit_code=0,
            )
            self.assertEqual(report["artifact_entry_count"], 2)
            self.assertEqual(report["session_id"], "session-1")
            self.assertEqual(report["run_id"], "run-1")
            self.assertTrue(report["status_scope_stable"])

    def test_fms_archive_requires_the_complete_api_export_layout(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive_path, case, receipt = _write_fms_fixture(root)
            stripped = root / "stripped.fms"
            with zipfile.ZipFile(archive_path) as source, zipfile.ZipFile(stripped, "w") as target:
                for info in source.infolist():
                    if info.filename == "manifest/export_profile.json":
                        continue
                    target.writestr(info, source.read(info))
            with self.assertRaisesRegex(pilot.managed.BenchmarkError, "API export manifest"):
                pilot.validate_fms_archive(
                    stripped, status_receipt=receipt, case_dir=case,
                    solver_exit_code=0,
                )

    def test_fms_archive_rejects_wrong_run_snapshot_and_stale_artifacts(self):
        cases = (
            ("wrong run manifest", {"manifest_run_id": "run-2"}, "run manifest"),
            ("wrong snapshot", {"snapshot_session_id": "old-session"}, "snapshot session_id"),
            ("stale archive", {"archive_dispersion": b"old", "local_dispersion": b"new"}, "artifact hash"),
        )
        for label, options, message in cases:
            with self.subTest(label=label), TemporaryDirectory() as tmp:
                archive_path, case, receipt = _write_fms_fixture(Path(tmp), **options)
                with self.assertRaisesRegex(pilot.managed.BenchmarkError, message):
                    pilot.validate_fms_archive(
                        archive_path, status_receipt=receipt, case_dir=case,
                        solver_exit_code=0,
                    )

    def test_fms_archive_rejects_scope_change_and_nonzero_solver(self):
        with TemporaryDirectory() as tmp:
            archive_path, case, receipt = _write_fms_fixture(Path(tmp))
            receipt["after_status"]["session"]["session_epoch"] = "epoch-2"
            with self.assertRaisesRegex(pilot.managed.BenchmarkError, "scope identity"):
                pilot.validate_fms_archive(
                    archive_path, status_receipt=receipt, case_dir=case,
                    solver_exit_code=0,
                )
            archive_path, case, receipt = _write_fms_fixture(Path(tmp), session_id="session-2")
            with self.assertRaisesRegex(pilot.managed.BenchmarkError, "zero solver"):
                pilot.validate_fms_archive(
                    archive_path, status_receipt=receipt, case_dir=case,
                    solver_exit_code=7,
                )

    def test_status_identity_accepts_serialized_scope_envelope(self):
        status = {
            "data": {
                "session": {
                    "session_id": "session-1",
                    "request_scope_epoch": {"value": "scope-1"},
                },
                "domain": {"cell_count": 2},
                "resources": {"field_catalog_revision": 4},
            }
        }
        identity = pilot._status_identity(status)
        self.assertEqual(identity["scope_field"], "request_scope_epoch")
        self.assertEqual(identity["scope"], "scope-1")

    def test_capture_session_is_api_only_and_allows_missing_managed_run(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v1"})
        with TemporaryDirectory() as tmp:
            output = Path(tmp) / "output"
            output.mkdir()
            command = pilot.compose_command(
                context, output, pilot="de-smoke-two", capture_session=True,
            )
            shell = command[-1]
            command_text = " ".join(command)
            override = (output / "compose.benchmark.override.yaml").read_text()
            document = yaml.load(override, Loader=_ComposeOverrideLoader)
            service = document["services"]["fem-modal-cpu"]
            self.assertIn("network_mode: none", override)
            self.assertIn("tmpfs:", override)
            self.assertIn(
                f"      - {pilot.UI_WORKSPACE_ROOT}:rw,nosuid,nodev,size=1g",
                override,
            )
            self.assertEqual(
                service["tmpfs"],
                ["/workspace/fullmag-ui-workspace:rw,nosuid,nodev,size=1g"],
            )
            self.assertNotIn("--tmpfs", command_text)
            self.assertNotIn("--publish 127.0.0.1", command_text)
            self.assertNotIn("FULLMAG_WEB_STATIC_DIR", shell)
            self.assertIn("--headless --json --output-dir", shell)
            self.assertIn("manifest/session.json", shell)
            self.assertIn('"/workspace/benchmark-output/fullmag-api.log"', shell)
            self.assertNotIn('"$case_dir/fullmag-api.log"', shell)
            status = {
                "session": {"session_id": "session-1", "session_epoch": "epoch-1"},
                "domain": {"cell_count": 1},
                "resources": {"field_catalog_revision": 1},
            }
            receipt = {
                "schema": "fullmag.live-export-receipt.v1",
                "solver_exit_code": 0,
                "before_status": status,
                "after_status": json.loads(json.dumps(status)),
            }
            receipt["before_status"]["run"] = None
            receipt["after_status"]["run"] = None
            archive_path, case, _ = _write_fms_fixture(output)
            self.assertEqual(
                pilot.validate_fms_archive(
                    archive_path, status_receipt=receipt, case_dir=case,
                    solver_exit_code=0,
                )["run_id"],
                "run-1",
            )
            with self.assertRaises(pilot.managed.BenchmarkError):
                pilot.compose_command(
                    context, output, pilot="de-smoke-two",
                    ui_web_root=output, capture_session=True,
                )


    def test_signed_fifteen_uses_grouped_adaptive_execution(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v2"})
        with TemporaryDirectory() as temporary:
            output = Path(temporary)
            command = pilot.compose_command(context, output,
                pilot=pilot.SIGNED_FIFTEEN_PILOT, external_model=True,
                parallel_mode="adaptive", mesh_level="L2", thickness_layers="3")
            shell = command[-1]
            self.assertIn("FULLMAG_DE_SMOKE_SAMPLING=signed-fifteen", shell)
            self.assertIn("FULLMAG_DE_SMOKE_PARALLEL_MODE=adaptive", shell)
            self.assertIn("OMP_NUM_THREADS=1", shell)
            self.assertNotIn("FULLMAG_PROBE_PARALLEL_MODE", shell)
            self.assertNotIn("FULLMAG_DE_SMOKE_SOLVER_RTOL", shell)
            override = (output / "compose.benchmark.override.yaml").read_text(encoding="utf-8")
            self.assertIn("cpus: 4.0", override)
            self.assertIn("mem_limit: 8g", override)
            for kwargs in ({"external_model": False, "parallel_mode": "adaptive"},
                           {"external_model": True, "parallel_mode": None},
                           {"external_model": True, "parallel_mode": "adaptive;bad"},
                           {"external_model": True, "parallel_mode": "adaptive", "probe_input_dir": output}):
                with self.assertRaises(pilot.managed.BenchmarkError):
                    pilot.compose_command(context, output, pilot=pilot.SIGNED_FIFTEEN_PILOT, **kwargs)

    def test_adaptive_report_binding_rejects_policy_and_sample_drift(self):
        from test_validate_parallel_execution_report import _adaptive_report, _policy
        with TemporaryDirectory() as temporary:
            case = Path(temporary)
            (case / "eigen").mkdir()
            path = case / "eigen/parallel_execution.v1.json"
            path.write_text(json.dumps(_adaptive_report()["report"]), encoding="utf-8")
            artifacts = {"required_artifact_hashes": {}}
            pilot.bind_parallel_report(case, artifacts, expected_policy=_policy(), expected_indices=range(3))
            self.assertEqual(artifacts["required_artifact_hashes"]["eigen/parallel_execution.v1.json"]["sha256"],
                             hashlib.sha256(path.read_bytes()).hexdigest())
            with self.assertRaises(pilot.managed.BenchmarkError):
                pilot.bind_parallel_report(case, artifacts, expected_policy={**_policy(), "max_cpu_percent": 80}, expected_indices=range(3))
            with self.assertRaises(pilot.managed.BenchmarkError):
                pilot.bind_parallel_report(case, artifacts, expected_policy=_policy(), expected_indices=range(1, 4))

    def test_signed_fifteen_preserves_actual_model_commit_identity(self):
        identity = {"kind": "versioned_standalone_input", "commit": "a" * 40, "sha256": "b" * 64}
        campaign = pilot.signed_fifteen_campaign_identity(identity, "adaptive")
        self.assertEqual(campaign["model_source_commit"], identity["commit"])
        self.assertEqual(campaign["model_sha256"], identity["sha256"])
        for mutation in ({**identity, "commit": None}, {**identity, "sha256": None},
                         {"kind": identity["kind"], "source_commit": identity["commit"], "sha256": identity["sha256"]}):
            with self.assertRaises(pilot.managed.BenchmarkError):
                pilot.signed_fifteen_campaign_identity(mutation, "adaptive")

    def test_signed_fifteen_cli_requires_pinned_policy_and_build(self):
        for options in ([], ["--parallel-mode", "adaptive"],
                        ["--parallel-mode", "adaptive", "--model-ref", "a" * 40],
                        ["--parallel-mode", "adaptive", "--model-ref", "a" * 40,
                         "--probe-build-source-digest", "b" * 64, "--probe-root", "bad"]):
            with patch.object(pilot.managed.fullmag_storage, "resolve_layout") as resolve:
                self.assertEqual(pilot.main(["--job-id", "a" * 32,
                    "--pilot", pilot.SIGNED_FIFTEEN_PILOT, *options]), 2)
                resolve.assert_not_called()

    def test_signed_path_exports_common_tuning_for_gamma_and_matching_legacy_aliases(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v2"})
        command = pilot.compose_command(context, Path("/outputs"),
            pilot="de-smoke-signed-eleven", eps_prefilter="1e-9",
            shifted_ksp_rtol="1e-9", shifted_ksp_type="fgmres", gmres_restart="8")
        values = pilot._modal_krylov_environment(command)
        self.assertEqual(values, {
            "FULLMAG_MODAL_EPS_PREFILTER_ABS": "1e-9",
            "FULLMAG_MODAL_SHIFTED_KSP_RTOL": "1e-9",
            "FULLMAG_MODAL_SHIFTED_KSP_TYPE": "fgmres",
            "FULLMAG_MODAL_GMRES_RESTART": "8"})
        for name, value in values.items():
            self.assertIn("export " + name.replace("MODAL", "FLOQUET") + "=" + value,
                          command[-1].splitlines())
        self.assertNotIn("FULLMAG_DE_SMOKE_SOLVER_RTOL", command[-1])

    def test_common_tuning_receipt_reads_actual_command_and_preserves_unset_defaults(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v2"})
        command = pilot.compose_command(context, Path("/outputs"), pilot="de-smoke-k25")
        self.assertEqual(pilot._modal_krylov_environment(command), {})
        self.assertEqual(pilot._modal_krylov_environment([
            "bash", "-lc", "export FULLMAG_MODAL_EPS_PREFILTER_ABS=1e-9\n"
            "export FULLMAG_MODAL_GMRES_RESTART=8\n"]), {
                "FULLMAG_MODAL_EPS_PREFILTER_ABS": "1e-9",
                "FULLMAG_MODAL_GMRES_RESTART": "8"})

    def test_common_tuning_receipt_rejects_invalid_or_conflicting_exports(self):
        for shell in ("export FULLMAG_MODAL_SHIFTED_KSP_TYPE=cg",
                      "export FULLMAG_MODAL_GMRES_RESTART=",
                      "export FULLMAG_MODAL_UNKNOWN=8",
                      "export FULLMAG_MODAL_GMRES_RESTART=8\n"
                      "export FULLMAG_MODAL_GMRES_RESTART=10"):
            with self.subTest(shell=shell), self.assertRaises(pilot.managed.BenchmarkError):
                pilot._modal_krylov_environment(["bash", "-lc", shell])

    def test_signed_path_prefilter_diagnostic_keeps_physical_tolerance_unchanged(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v1"})
        shell = pilot.compose_command(context, Path("/outputs"),
                                      pilot="de-smoke-signed-eleven",
                                      eps_prefilter="1e-10")[-1]
        self.assertIn("export FULLMAG_FLOQUET_EPS_PREFILTER_ABS=1e-10", shell)
        self.assertIn("export FULLMAG_DE_SMOKE_SAMPLING=signed-eleven", shell)
        self.assertNotIn("FULLMAG_DE_SMOKE_SOLVER_RTOL", shell)
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot.compose_command(context, Path("/outputs"), pilot="de100",
                                  eps_prefilter="1e-10")
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot.compose_command(context, Path("/outputs"),
                                  pilot="de-smoke-signed-eleven", solver_rtol="1e-7")

    def test_air_growth_rate_is_single_k_versioned_non_parallel_de_smoke_only(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v1"})
        for rate in pilot.AIR_GROWTH_RATE_CHOICES:
            with self.subTest(rate=rate):
                shell = pilot.compose_command(
                    context, Path("/outputs"), pilot="de-smoke-k10", external_model=True,
                    air_growth_rate=rate,
                )[-1]
                self.assertIn(f"export FULLMAG_DE_SMOKE_AIR_GROWTH_RATE={rate}", shell)
        default_shell = pilot.compose_command(
            context, Path("/outputs"), pilot="de-smoke-k10", external_model=True,
        )[-1]
        self.assertNotIn("FULLMAG_DE_SMOKE_AIR_GROWTH_RATE", default_shell)

        rejected = (
            ("de100", True, None),
            ("de-smoke-two", True, None),
            ("de-smoke-signed-eleven", True, None),
            (pilot.SIGNED_FIFTEEN_PILOT, True, "serial"),
            (pilot.PARALLEL_PROBE_PILOT, True, "serial"),
            ("de-smoke-bv-k10", True, None),
            ("de-smoke-k10", False, None),
            ("de-smoke-k10", True, "adaptive"),
        )
        for pilot_name, external_model, parallel_mode in rejected:
            with self.subTest(pilot=pilot_name, external_model=external_model,
                              parallel_mode=parallel_mode), self.assertRaises(pilot.managed.BenchmarkError):
                pilot.compose_command(
                    context, Path("/outputs"), pilot=pilot_name,
                    external_model=external_model, parallel_mode=parallel_mode,
                    air_growth_rate="1.15",
                )
        for unsupported in ("1.2", "1.0750", "1.0375;echo bad", 1.15, True):
            with self.subTest(unsupported=unsupported), self.assertRaises(pilot.managed.BenchmarkError):
                pilot.compose_command(
                    context, Path("/outputs"), pilot="de-smoke-k10", external_model=True,
                    air_growth_rate=unsupported,
                )

    def test_air_growth_rate_input_support_and_preview_are_version_bound(self):
        fixture_path = Path(__file__).resolve().parents[1] / "examples" / "fem_de_smoke_numeric.py"
        source = fixture_path.read_bytes().replace(b"\r\n", b"\n")
        pilot._validate_air_growth_rate_model_input(source)
        for rate in pilot.AIR_GROWTH_RATE_CHOICES:
            with self.subTest(rate=rate):
                pilot._validate_air_growth_rate_model_input(source, rate)

        mapping = (
            b'_AIR_GROWTH_RATE_VALUES = {\n'
            b'    "1.3": 1.3,\n'
            b'    "1.15": 1.15,\n'
            b'    "1.075": 1.075,\n'
            b'    "1.0375": 1.0375,\n'
            b'}'
        )
        self.assertIn(mapping, source)
        old_source = source.replace(
            mapping,
            b'_AIR_GROWTH_RATE_VALUES = {"1.3": 1.3, "1.15": 1.15}',
        )
        pilot._validate_air_growth_rate_model_input(old_source)
        pilot._validate_air_growth_rate_model_input(old_source, "1.15")
        for rate in ("1.075", "1.0375"):
            with self.subTest(old_model_rate=rate), self.assertRaisesRegex(
                pilot.managed.BenchmarkError, "does not declare"
            ):
                pilot._validate_air_growth_rate_model_input(old_source, rate)

        malformed_mappings = (
            mapping.replace(b'"1.075": 1.075', b'1.075: 1.075'),
            mapping.replace(b'"1.075": 1.075', b'"1.075": 1.0751'),
            mapping.replace(b'"1.075": 1.075', b'"1.075": True'),
            mapping.replace(b'"1.075": 1.075', b'"1.075": 1e999'),
            mapping.replace(b'"1.075": 1.075', b'"1.075": 1.075 + 0'),
            mapping.replace(b'"1.075": 1.075,\n', b''),
        )
        for bad_mapping in malformed_mappings:
            bad_source = source.replace(mapping, bad_mapping)
            with self.subTest(mapping=bad_mapping), self.assertRaises(
                pilot.managed.BenchmarkError
            ):
                pilot._validate_air_growth_rate_model_input(bad_source, "1.075")

        old_source = source.replace(
            b"FULLMAG_DE_SMOKE_AIR_GROWTH_RATE",
            b"FULLMAG_DE_SMOKE_AIR_GROWTH_RATE_UNSUPPORTED",
        )
        with self.assertRaisesRegex(pilot.managed.BenchmarkError, "applies"):
            pilot._validate_air_growth_rate_model_input(old_source)

        layout = {"storage_root": Path("C:/storage"), "worktree_id": "worktree"}
        identity = {"kind": "versioned_standalone_input", "sha256": "a" * 64}
        preview = pilot._dry_run_output_dir(layout, "b" * 32, "de-smoke-k10", identity)
        self.assertEqual(
            preview,
            Path("C:/storage/runs/worktree") / ("b" * 32) / ("de-smoke-k10-preview-" + "a" * 64),
        )
        self.assertNotEqual(
            preview,
            pilot._dry_run_output_dir(layout, "b" * 32, "de-smoke-k10", None),
        )

    def test_air_growth_rate_metadata_requires_matching_declaration_and_mesh_receipt(self):
        def metadata_for(rate):
            return {
                "problem_meta": {"runtime_metadata": {
                    "de_smoke": {"air_growth_rate": rate},
                    "study_universe": {"airbox_growth_rate": rate},
                    "domain_frame": {"declared_universe": {"airbox_growth_rate": rate}},
                }},
                "mesh": {"mesh_build_report": {
                    "effective_airbox_target": {"growth_rate": rate},
                }},
            }

        def set_path(payload, path, value):
            target = payload
            for part in path[:-1]:
                target = target[part]
            target[path[-1]] = value

        paths = (
            ("problem_meta", "runtime_metadata", "de_smoke", "air_growth_rate"),
            ("problem_meta", "runtime_metadata", "study_universe", "airbox_growth_rate"),
            ("problem_meta", "runtime_metadata", "domain_frame", "declared_universe", "airbox_growth_rate"),
            ("mesh", "mesh_build_report", "effective_airbox_target", "growth_rate"),
        )
        with TemporaryDirectory() as temporary:
            case = Path(temporary)
            metadata_path = case / "metadata.json"
            for requested in ("1.075", "1.0375"):
                resolved = float(requested)
                metadata_path.write_text(json.dumps(metadata_for(resolved)), encoding="utf-8")
                record = pilot.validate_air_growth_rate_metadata(case, requested)
                self.assertEqual(record["requested"], requested)
                self.assertEqual(record["resolved"], resolved)
                self.assertEqual(
                    record["resolved_metadata_path"],
                    "mesh.mesh_build_report.effective_airbox_target.growth_rate",
                )
                for path in paths:
                    with self.subTest(requested=requested, path=path):
                        payload = metadata_for(resolved)
                        set_path(payload, path, 1.3)
                        metadata_path.write_text(json.dumps(payload), encoding="utf-8")
                        with self.assertRaisesRegex(pilot.managed.BenchmarkError, "ignored or changed"):
                            pilot.validate_air_growth_rate_metadata(case, requested)
                for invalid in (True, str(resolved), float("nan")):
                    payload = metadata_for(resolved)
                    set_path(payload, paths[-1], invalid)
                    metadata_path.write_text(json.dumps(payload), encoding="utf-8")
                    with self.subTest(requested=requested, invalid=invalid), self.assertRaises(
                        pilot.managed.BenchmarkError
                    ):
                        pilot.validate_air_growth_rate_metadata(case, requested)

    def test_air_growth_rate_is_recorded_in_the_run_request(self):
        with TemporaryDirectory() as temporary:
            output = Path(temporary)
            model_bytes = b"versioned standalone test input"
            identity = {
                "kind": "versioned_standalone_input",
                "commit": "c" * 40,
                "sha256": hashlib.sha256(model_bytes).hexdigest(),
            }
            pilot.model_input.stage_model(output, model_bytes)
            context = SimpleNamespace(
                layout={"repo_root": Path(__file__).resolve().parents[1]},
                image_digest="sha256:test",
            )
            request = {"job": {}, "source": {}, "runtime": {}}
            command = ["docker", "compose", "run", "placeholder",
                       "export FULLMAG_DE_SMOKE_AIR_GROWTH_RATE=1.15"]
            with self.assertRaisesRegex(pilot.managed.BenchmarkError, "dispatch environment"):
                pilot.execute(
                    context, output, ["docker", "compose", "run", "placeholder"],
                    identity["sha256"], pilot="de-smoke-k10", model_identity=identity,
                    air_growth_rate="1.15",
                )
            with patch.object(pilot.managed, "_run_request", return_value=request), \
                    patch.object(pilot.managed, "_compose_environment", return_value={}), \
                    patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=1)), \
                    patch.object(pilot, "_cleanup_extra_mounts", return_value=[]), \
                    patch.object(pilot.managed, "_cleanup_benchmark_container",
                                 return_value={"status": "not_running"}), \
                    contextlib.redirect_stdout(io.StringIO()):
                status = pilot.execute(
                    context, output, command, identity["sha256"],
                    pilot="de-smoke-k10", model_identity=identity,
                    air_growth_rate="1.15",
                )
            stored_request = json.loads((output / "run-request.json").read_text(encoding="utf-8"))
            self.assertEqual(status, 1)
            self.assertEqual(stored_request["air_growth_rate_requested"], "1.15")
            self.assertEqual(stored_request["model_source"]["sha256"], identity["sha256"])

    def test_de_smoke_fixture_air_growth_rate_is_interpreted_and_fail_closed(self):
        fixture_path = Path(__file__).resolve().parents[1] / "examples" / "fem_de_smoke_numeric.py"

        def run_fixture(environment):
            recorder = _FixtureDslRecorder()
            fullmag = types.ModuleType("fullmag")
            for name in ("study", "ParallelExecutionPolicy", "Box", "KPoint", "KPath",
                         "PeriodicBC", "FloquetBC"):
                setattr(fullmag, name, _FixtureDslNode(recorder, name))
            fullmag.FieldAutosave = _FixtureFieldAutosave
            fullmag.StageAutosave = _FixtureStageAutosave
            fullmag.init = _FixtureDslNode(recorder, "init")
            with patch.dict(os.environ, environment, clear=True), \
                    patch.dict(sys.modules, {"fullmag": fullmag}):
                runpy.run_path(str(fixture_path), run_name="__main__")
            return recorder

        baseline = run_fixture({})
        baseline_metadata = dict(baseline.runtime_metadata[0])
        baseline_metadata.pop("air_growth_rate")
        for requested in pilot.AIR_GROWTH_RATE_CHOICES:
            environment = {"FULLMAG_DE_SMOKE_AIR_GROWTH_RATE": requested}
            expected = float(requested)
            with self.subTest(environment=environment):
                recorder = run_fixture(environment)
                self.assertEqual(len(recorder.mesh_calls), 1)
                self.assertEqual(recorder.mesh_calls[0]["maximum_element_size"], 100e-9)
                self.assertEqual(recorder.mesh_calls[0]["maximum_element_growth_rate"], expected)
                self.assertEqual(recorder.mesh_calls[0]["grading"], "geometric")
                self.assertEqual(recorder.runtime_metadata[0]["air_growth_rate"], expected)
                metadata = dict(recorder.runtime_metadata[0])
                metadata.pop("air_growth_rate")
                self.assertEqual(metadata, baseline_metadata)
        with self.assertRaisesRegex(ValueError, "FULLMAG_DE_SMOKE_AIR_GROWTH_RATE"):
            run_fixture({"FULLMAG_DE_SMOKE_AIR_GROWTH_RATE": "1.2"})

    def test_air_growth_rate_cli_help_lists_exact_control_sequence(self):
        with contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_info:
                pilot.main(["--help"])
        self.assertEqual(exit_info.exception.code, 0)
        help_text = output.getvalue()
        expected = "--air-growth-rate {" + ",".join(pilot.AIR_GROWTH_RATE_CHOICES) + "}"
        self.assertIn(expected, help_text)

    def test_mesh_level_is_recorded_and_ignored_setting_is_rejected(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v1"})
        shell = pilot.compose_command(context, Path("/outputs"), pilot="de-smoke-k25",
                                      external_model=True, mesh_level="L1")[-1]
        self.assertIn("export FULLMAG_DE_SMOKE_MESH_LEVEL=L1", shell)
        self.assertNotIn("FULLMAG_DE_SMOKE_SOLVER_RTOL", shell)
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot.compose_command(context, Path("/outputs"), pilot="de-smoke-k25", mesh_level="L9")
        with TemporaryDirectory() as temporary:
            case = Path(temporary)
            metadata = {"problem_meta": {"runtime_metadata": {
                "de_smoke": {"mesh_level": "L0", "magnetic_element_size_m": 10e-9},
                "mesh_workflow": {"per_geometry": [{"hmax": 10e-9}]},
            }}}
            (case / "metadata.json").write_text(json.dumps(metadata))
            with self.assertRaises(pilot.managed.BenchmarkError):
                pilot.validate_mesh_level_metadata(case, "L1")
            metadata["problem_meta"]["runtime_metadata"]["de_smoke"].update(
                mesh_level="L1", magnetic_element_size_m=7.5e-9)
            metadata["problem_meta"]["runtime_metadata"]["mesh_workflow"]["per_geometry"][0]["hmax"] = 7.5e-9
            (case / "metadata.json").write_text(json.dumps(metadata))
            self.assertEqual(pilot.validate_mesh_level_metadata(case, "L1")["resolved_level"], "L1")
            for malformed in ({}, {"problem_meta": None},
                              {"problem_meta": {"runtime_metadata": []}}):
                with self.subTest(metadata=malformed):
                    (case / "metadata.json").write_text(json.dumps(malformed))
                    with self.assertRaisesRegex(pilot.managed.BenchmarkError, "malformed"):
                        pilot.validate_mesh_level_metadata(case, "L1")
            (case / "metadata.json").unlink()
            with self.assertRaisesRegex(pilot.managed.BenchmarkError, "missing"):
                pilot.validate_mesh_level_metadata(case, "L1")



    def test_single_nonzero_k_pilot_is_separate_from_two_point_path(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v1"})
        single = pilot.compose_command(context, Path("/outputs"), pilot="de-smoke-k2", external_model=True)[-1]
        self.assertIn("export FULLMAG_DE_SMOKE_SAMPLING=k2", single)
        self.assertIn("export FULLMAG_GMSH_THREADS=1", single)
        self.assertIn("case_dir=/workspace/benchmark-output/de-smoke-k2", single)

    def test_gamma_krylov_trial_admits_only_frequency_window_de_smoke(self):
        pilot._validate_shifted_ksp_trial_request(
            "de-smoke-k0", "fgmres", None, "frequency_window")
        rejected = (
            ("de-smoke-k0", "11", "nearest", False),
            ("de-smoke-k0", None, "frequency_window", True),
            ("de100", None, "frequency_window", False),
        )
        for pilot_name, nearest, target, dense in rejected:
            with self.subTest(pilot=pilot_name, nearest=nearest, target=target, dense=dense):
                with self.assertRaises(pilot.managed.BenchmarkError):
                    pilot._validate_shifted_ksp_trial_request(
                        pilot_name, "fgmres", nearest, target, dense_oracle=dense)

    def test_nearest_shifted_ksp_trial_admission_is_single_nonzero_native_only(self):
        for name in ("de-smoke-k10", "de-smoke-k-10", "de-smoke-bv-k25", pilot.NEAREST_PILOT):
            for method in ("gmres", "fgmres"):
                with self.subTest(pilot=name, method=method):
                    pilot._validate_shifted_ksp_trial_request(name, method, "11.2", "nearest")
        for name in ("de-smoke-k0", "de-smoke-bv-k0", "de-smoke-two", "de-smoke-positive-six"):
            with self.subTest(pilot=name), self.assertRaises(pilot.managed.BenchmarkError):
                pilot._validate_shifted_ksp_trial_request(name, "fgmres", "11.2", "nearest")
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot._validate_shifted_ksp_trial_request(
                "de-smoke-k10", "fgmres", "11.2", "nearest", dense_oracle=True)

    def test_nearest_krylov_receipt_receives_target_and_integer_restart(self):
        with patch.object(pilot, "validate_gamma_krylov_trial") as gamma, \
                patch.object(pilot, "validate_shifted_ksp_trial", return_value={"scope": "selected_only"}) as floquet:
            artifacts = pilot._validate_krylov_trials(
                Path("case"), "k-10", "fgmres", "1e-9", "1e-9", "8",
                spectral_target="nearest", target_frequency_hz=11.2e9)
            gamma.assert_not_called()
            floquet.assert_called_once_with(
                Path("case"), "k-10", "fgmres", "1e-9", spectral_target="nearest",
                target_frequency_hz=11.2e9, gmres_restart=8)
            self.assertEqual(set(artifacts), {"shifted_ksp_trial"})

    def test_nearest_krylov_receipt_rejects_gamma_grouped_and_unknown_selection(self):
        for sampling, selection in (("k0", "nearest"), ("two", "nearest"),
                                    ("k2", "invalid")):
            with self.subTest(sampling=sampling, selection=selection), \
                    patch.object(pilot, "validate_shifted_ksp_trial") as floquet, \
                    self.assertRaises(pilot.managed.BenchmarkError):
                pilot._validate_krylov_trials(
                    Path("case"), sampling, "fgmres", "1e-9", "1e-9", "8",
                    spectral_target=selection, target_frequency_hz=11.2e9)
            floquet.assert_not_called()

    def test_nearest_krylov_receipt_propagates_unavailable_measurement(self):
        with patch.object(pilot, "validate_shifted_ksp_trial",
                          side_effect=ValueError("KSP diagnostics unavailable")), \
                self.assertRaisesRegex(ValueError, "unavailable"):
            pilot._validate_krylov_trials(
                Path("case"), "k10", "fgmres", "1e-9", "1e-9", None,
                spectral_target="nearest", target_frequency_hz=11.2e9)

    def test_nearest_fgmres_compose_preserves_explicit_selection_and_controls(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v2"})
        with patch.object(pilot.managed, "_compose_command",
                          return_value=["docker", "run", "placeholder"]):
            shell = pilot.compose_command(
                context, Path("/outputs"), pilot="de-smoke-k-10", external_model=True,
                spectral_target="nearest", nearest_target_frequency_ghz="11.2",
                shifted_ksp_type="fgmres", shifted_ksp_rtol="1e-9", gmres_restart="8")[-1]
        self.assertIn("export FULLMAG_DE_SMOKE_MODAL_TARGET=nearest", shell)
        self.assertIn("export FULLMAG_DE_SMOKE_SAMPLING=k-10", shell)
        self.assertIn("export FULLMAG_MODAL_SHIFTED_KSP_TYPE=fgmres", shell)
        self.assertIn("export FULLMAG_MODAL_GMRES_RESTART=8", shell)
        target_export = next(line for line in shell.splitlines()
                             if line.startswith("export FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ="))
        self.assertAlmostEqual(float(target_export.split("=", 1)[1]), 11.2)

    def test_gamma_and_nonzero_krylov_receipt_gates_are_separate(self):
        cases = (
            ("k0", {"gamma_krylov_trial"}),
            ("two", {"gamma_krylov_trial", "shifted_ksp_trial"}),
            ("k2", {"shifted_ksp_trial"}),
        )
        for sampling, expected_keys in cases:
            with self.subTest(sampling=sampling), \
                    patch.object(pilot, "validate_gamma_krylov_trial", return_value={"gate": "gamma"}) as gamma, \
                    patch.object(pilot, "validate_shifted_ksp_trial", return_value={"gate": "floquet"}) as floquet:
                artifacts = pilot._validate_krylov_trials(
                    Path("case"), sampling, "fgmres", "1e-9", "1e-9", "10")
                self.assertEqual(set(artifacts), expected_keys)
                self.assertEqual(gamma.call_count, int("gamma_krylov_trial" in expected_keys))
                self.assertEqual(floquet.call_count, int("shifted_ksp_trial" in expected_keys))

    def test_ui_seven_nearest_krylov_admission_is_pinned_and_does_not_weaken_legacy_paths(self):
        pilot._validate_shifted_ksp_trial_request(
            pilot.UI_SEVEN_PILOT, "fgmres", None, "nearest")
        pilot._validate_ui_seven_krylov_request(
            pilot.UI_SEVEN_PILOT, "fgmres", "1e-9", "1e-9", "30",
            None, "nearest")
        for pilot_name in ("de-smoke-two", "de-smoke-positive-six"):
            with self.subTest(pilot=pilot_name), self.assertRaises(pilot.managed.BenchmarkError):
                pilot._validate_shifted_ksp_trial_request(
                    pilot_name, "fgmres", "10", "nearest")
        for requested_type, rtol, eps, restart, target in (
                ("gmres", "1e-9", "1e-9", "30", "nearest"),
                ("fgmres", "1e-8", "1e-9", "30", "nearest"),
                ("fgmres", "1e-9", None, "30", "nearest"),
                ("fgmres", "1e-9", "1e-9", "8", "nearest"),
                ("fgmres", "1e-9", "1e-9", "30", "frequency_window"),
        ):
            with self.subTest(request=(requested_type, rtol, eps, restart, target)), \
                    self.assertRaises(pilot.managed.BenchmarkError):
                pilot._validate_ui_seven_krylov_request(
                    pilot.UI_SEVEN_PILOT, requested_type, rtol, eps, restart,
                    None, target)
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot._validate_window_policy_request(
                pilot.UI_SEVEN_PILOT, "bounded_double_nev_v1", "fgmres")

    def test_ui_seven_dispatch_binds_modal_and_floquet_exports_to_the_request(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v2"})
        with patch.object(pilot.managed, "_compose_command",
                          return_value=["docker", "run", "placeholder"]):
            command = pilot.compose_command(
                context, Path("/outputs"), pilot=pilot.UI_SEVEN_PILOT,
                shifted_ksp_type="fgmres", shifted_ksp_rtol="1e-9",
                eps_prefilter="1e-9", gmres_restart="30")
        shell = command[-1]
        pilot._validate_ui_seven_dispatch(
            command, 10e9, "fgmres", "1e-9", "1e-9", "30")
        for export in (
                "export FULLMAG_MODAL_SHIFTED_KSP_TYPE=fgmres",
                "export FULLMAG_FLOQUET_SHIFTED_KSP_TYPE=fgmres"):
            mutated = "\n".join(line for line in shell.splitlines() if line != export)
            with self.subTest(export=export), self.assertRaises(pilot.managed.BenchmarkError):
                pilot._validate_ui_seven_dispatch(
                    [*command[:-1], mutated], 10e9,
                    "fgmres", "1e-9", "1e-9", "30")

    def test_nearest_pilot_is_single_k_selected_only_and_fail_closed(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v1"})
        with patch.object(pilot.managed, "_compose_command",
                          return_value=["docker", "run", "placeholder"]):
            shell = pilot.compose_command(
                context, Path("/outputs"), pilot=pilot.NEAREST_PILOT)[-1]
            self.assertIn("export FULLMAG_DE_SMOKE_SAMPLING=k2", shell)
            self.assertIn("export FULLMAG_DE_SMOKE_MODAL_TARGET=nearest", shell)
            self.assertIn("export FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ=10", shell)
            custom = pilot.compose_command(
                context, Path("/outputs"), pilot=pilot.NEAREST_PILOT,
                nearest_target_frequency_ghz="12.5")[-1]
            self.assertIn("export FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ=12.5", custom)
            for value in ("0", "-1", "nan", "inf", "-inf", "1e308", "bad"):
                with self.subTest(value=value), self.assertRaises(pilot.managed.BenchmarkError):
                    pilot.compose_command(
                        context, Path("/outputs"), pilot=pilot.NEAREST_PILOT,
                        nearest_target_frequency_ghz=value)
            with self.assertRaisesRegex(pilot.managed.BenchmarkError, "single-k"):
                pilot.compose_command(
                    context, Path("/outputs"), pilot="de-smoke-two",
                    nearest_target_frequency_ghz="10")
            for single_pilot in ("de-smoke-k0", "de-smoke-k-25", "de-smoke-bv-k25"):
                with self.subTest(single_pilot=single_pilot):
                    shell = pilot.compose_command(
                        context, Path("/outputs"), pilot=single_pilot,
                        spectral_target="nearest", nearest_target_frequency_ghz="11.25")[-1]
                    self.assertIn("export FULLMAG_DE_SMOKE_MODAL_TARGET=nearest", shell)
                    self.assertIn("export FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ=11.25", shell)
            with self.assertRaisesRegex(pilot.managed.BenchmarkError, "spectral-target"):
                pilot.compose_command(
                    context, Path("/outputs"), pilot="de-smoke-k2",
                    nearest_target_frequency_ghz="10")

    def test_ui_seven_pilot_uses_nearest_selected_only_and_records_ui_diagnostic(self):
        self.assertEqual(pilot.PILOTS[pilot.UI_SEVEN_PILOT][1], "ui-seven")
        self.assertFalse(pilot._is_single_k_pilot(pilot.UI_SEVEN_PILOT))
        request = {"source": {}, "job": {}, "runtime": {}}

        with TemporaryDirectory() as tmp:
            output = Path(tmp)
            context = _build_context_for_container_cleanup(output)
            with patch.object(
                pilot.managed,
                "_compose_command",
                return_value=["docker", "compose", "run", "fem-modal-cpu", "placeholder"],
            ):
                command = pilot.compose_command(
                    context, output, pilot=pilot.UI_SEVEN_PILOT)
                shell = command[-1]
                self.assertIn("export FULLMAG_DE_SMOKE_SAMPLING=ui-seven", shell)
                self.assertIn("export FULLMAG_DE_SMOKE_MODAL_TARGET=nearest", shell)
                self.assertIn("export FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ=10", shell)
                self.assertIn("export FULLMAG_DE_SMOKE_SOLVER_RTOL=1e-8", shell)
                self.assertNotIn("FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ", shell)
                self.assertNotIn("FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ", shell)
                with self.assertRaisesRegex(pilot.managed.BenchmarkError, "nearest pilot cannot request frequency_window"):
                    pilot.compose_command(
                        context, output, pilot=pilot.UI_SEVEN_PILOT,
                        spectral_target="frequency_window")
                with self.assertRaisesRegex(pilot.managed.BenchmarkError, "solver rtol sweep"):
                    pilot.compose_command(
                        context, output, pilot=pilot.UI_SEVEN_PILOT,
                        solver_rtol="1e-7")
                for legacy_path in ("de-smoke-two", "de-smoke-positive-six"):
                    with self.subTest(legacy_path=legacy_path), self.assertRaisesRegex(
                        pilot.managed.BenchmarkError, "single-k"):
                        pilot.compose_command(
                            context, output, pilot=legacy_path,
                            spectral_target="nearest")

            with patch.object(pilot.managed, "_run_request", return_value=request), \
                    patch.object(pilot.managed, "_compose_environment", return_value={}), \
                    patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                    patch.object(pilot, "resolve_runtime_artifact_root",
                                 return_value=(output / "de-smoke-ui-seven", {"binding": "fixture"})), \
                    patch.object(pilot.managed, "_validate_case_artifacts", return_value={}), \
                    patch.object(pilot, "validate_rows", return_value={
                        "selection_scope": "selected_only", "sample_count": 7,
                        "qualification": "NOT VERIFIED"}) as row_check, \
                    patch.object(pilot, "validate_smoke_potential_fields", return_value={}), \
                    patch.object(pilot, "validate_selected_only_metadata", return_value={
                        "selection_scope": "selected_only", "window_complete": False,
                        "qualification": "NOT VERIFIED", "sample_count": 7}), \
                    patch.object(pilot.managed, "_cleanup_benchmark_container",
                                 side_effect=_fixture_container_cleanup), \
                    patch("builtins.print"):
                self.assertEqual(pilot.execute(
                    context, output, command, "a" * 64, pilot=pilot.UI_SEVEN_PILOT), 0)
            row_check.assert_called_once()
            self.assertEqual(row_check.call_args.kwargs["selection_scope"], "selected_only")
            stored_request = json.loads((output / "run-request.json").read_text())
            result = json.loads((output / "run-result.json").read_text())
            self.assertEqual(stored_request["selection_scope"], "selected_only")
            self.assertIs(stored_request["window_complete"], False)
            self.assertEqual(stored_request["qualification"], "NOT VERIFIED")
            self.assertEqual(stored_request["purpose"], "ui_diagnostic")
            self.assertEqual(stored_request["branch_continuity"], "NOT VERIFIED")
            self.assertEqual(result["status"], "completed_unqualified")
            self.assertEqual(result["qualification"], "NOT VERIFIED")
            self.assertEqual(result["artifacts"]["row_preflight"]["sample_count"], 7)

    def test_selected_only_metadata_validator_does_not_claim_window(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            metadata = {"problem_meta": {"runtime_metadata": {"de_smoke": {
                "schema": "fullmag.de-smoke.v1",
                "modal_target": "nearest",
                "target_frequency_hz": 12.5e9,
                "selection_scope": "selected_only",
                "window_complete": False,
                "sampling": "k2",
                "requested_mode_count": 1,
                "k_vectors_rad_per_m": [[0.0, 2.0e6, 0.0]],
            }}}}
            (root / "metadata.json").write_text(json.dumps(metadata))
            diagnostics = root / "eigen/diagnostics"
            diagnostics.mkdir(parents=True)
            (diagnostics / "solver.v1.json").write_text(json.dumps({
                "target_kind": "nearest_frequency",
                "spectrum_completeness": "selected_only",
                "window_complete": False,
                "target_omega_rad_s": 12.5e9 * 2.0 * 3.141592653589793,
            }))
            report = pilot.validate_selected_only_metadata(root, 12.5e9, "k2")
            self.assertEqual(report["selection_scope"], "selected_only")
            self.assertIs(report["window_complete"], False)
            self.assertEqual(report["qualification"], "NOT VERIFIED")
            self.assertEqual(report["native_diagnostics"]["target_kind"], "nearest_frequency")
            metadata["problem_meta"]["runtime_metadata"]["de_smoke"]["window_complete"] = True
            (root / "metadata.json").write_text(json.dumps(metadata))
            with self.assertRaisesRegex(pilot.managed.BenchmarkError, "window_complete"):
                pilot.validate_selected_only_metadata(root, 12.5e9)


    def test_ui_seven_selected_only_metadata_crosschecks_all_native_sample_identity(self):
        target_hz = 10e9
        ky_values = (-25e6, -15e6, -5e6, 0.0, 5e6, 15e6, 25e6)
        vectors = [[0.0, value, 0.0] for value in ky_values]

        def write_case(root, *, metadata_mutation=None, native_mutation=None):
            root = Path(root)
            model = {
                "schema": "fullmag.de-smoke.v1",
                "sampling": "ui-seven",
                "orientation": "M0=x,k=y,normal=z",
                "modal_target": "nearest",
                "target_frequency_hz": target_hz,
                "selection_scope": "selected_only",
                "window_complete": False,
                "requested_mode_count": 1,
                "eigen_solver_rtol": 1e-8,
                "k_vectors_rad_per_m": [list(vector) for vector in vectors],
                "purpose": "ui_diagnostic",
                "branch_continuity": "NOT VERIFIED",
            }
            if metadata_mutation == "wrong_target":
                model["target_frequency_hz"] = target_hz + 1e9
            elif metadata_mutation == "window_complete":
                model["window_complete"] = True
            elif metadata_mutation == "wrong_vector":
                model["k_vectors_rad_per_m"][0][1] = -24e6
            elif metadata_mutation == "wrong_count":
                model["requested_mode_count"] = 2
            elif metadata_mutation == "wrong_rtol":
                model["eigen_solver_rtol"] = 1e-7
            elif metadata_mutation == "wrong_purpose":
                model["purpose"] = "scientific_result"
            elif metadata_mutation == "branch_verified":
                model["branch_continuity"] = "verified"
            (root / "metadata.json").write_text(json.dumps({
                "problem_meta": {"runtime_metadata": {"de_smoke": model}},
            }))

            records = []
            for sample_index, vector in enumerate(vectors):
                sample_target = target_hz + 1e9 if (
                    native_mutation == "wrong_target" and sample_index == 4) else target_hz
                sample_scope = "complete_window" if (
                    native_mutation == "wrong_scope" and sample_index == 4) else "selected_only"
                sample_window = True if (
                    native_mutation == "window_complete" and sample_index == 4) else False
                sample_count = 2 if (
                    native_mutation == "wrong_count" and sample_index == 4) else 1
                record_vector = [0.0, 4e6, 0.0] if (
                    native_mutation == "wrong_vector" and sample_index == 4) else list(vector)
                records.append({
                    "sample_index": sample_index,
                    "k_vector": record_vector,
                    "diagnostics": {
                        "target_kind": "nearest_frequency",
                        "target_frequency_hz": sample_target,
                        "spectrum_completeness": sample_scope,
                        "window_complete": sample_window,
                        "requested_mode_count": sample_count,
                        "k_vector_rad_m": list(record_vector),
                    },
                })
            if native_mutation == "missing_record":
                records.pop(2)
            elif native_mutation == "duplicate_record":
                records[-1]["sample_index"] = 5
            native = {
                "sample_count": 7,
                "requested_mode_count": 1,
                "target_kind": "nearest_frequency",
                "target_frequency_hz": target_hz,
                "spectrum_completeness": "selected_only",
                "window_complete": False,
                "sample_solver_diagnostics": records,
            }
            if native_mutation == "root_only":
                native.pop("sample_solver_diagnostics")
            diagnostics = root / "eigen/diagnostics"
            diagnostics.mkdir(parents=True)
            (diagnostics / "solver.v1.json").write_text(json.dumps(native))

        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_case(root)
            report = pilot.validate_selected_only_metadata(
                root, target_hz, pilot.UI_SEVEN_SAMPLING)
            self.assertEqual(report["sampling"], pilot.UI_SEVEN_SAMPLING)
            self.assertEqual(report["sample_count"], 7)
            self.assertEqual(report["mode_count"], 1)
            self.assertEqual(report["selection_scope"], "selected_only")
            self.assertIs(report["window_complete"], False)
            self.assertEqual(report["qualification"], "NOT VERIFIED")
            self.assertEqual(report["native_diagnostics"]["sample_indices"], list(range(7)))
            self.assertEqual(report["native_diagnostics"]["k_vectors_rad_per_m"], vectors)

        for mutation, message in (
            ("wrong_target", "target frequency"),
            ("window_complete", "window_complete"),
            ("wrong_vector", "signed k vectors"),
            ("wrong_count", "exactly one mode"),
            ("wrong_rtol", "exactly 1e-8"),
            ("wrong_purpose", "purpose=ui_diagnostic"),
            ("branch_verified", "branch continuity"),
        ):
            with TemporaryDirectory() as temporary, self.subTest(metadata_mutation=mutation):
                root = Path(temporary)
                write_case(root, metadata_mutation=mutation)
                with self.assertRaisesRegex(pilot.managed.BenchmarkError, message):
                    pilot.validate_selected_only_metadata(root, target_hz, pilot.UI_SEVEN_SAMPLING)

        for mutation in (
            "missing_record", "duplicate_record", "wrong_target", "wrong_scope",
            "window_complete", "wrong_vector", "wrong_count", "root_only",
        ):
            with TemporaryDirectory() as temporary, self.subTest(native_mutation=mutation):
                root = Path(temporary)
                write_case(root, native_mutation=mutation)
                with self.assertRaisesRegex(
                    pilot.managed.BenchmarkError, "native diagnostics are missing or inconsistent"):
                    pilot.validate_selected_only_metadata(root, target_hz, pilot.UI_SEVEN_SAMPLING)



    def test_thickness_request_is_explicit_and_checked_against_mesh_authoring(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  image_digest="sha256:test",
                                  job={"job_id": "a" * 32, "profile": "fem-cpu-slepc-runtime-v1"})
        shell = pilot.compose_command(context, Path("/outputs"), pilot="de-smoke-k25",
                                      external_model=True, thickness_layers="6")[-1]
        self.assertIn("export FULLMAG_DE_SMOKE_THICKNESS_LAYERS=6", shell)
        self.assertNotIn("FULLMAG_DE_SMOKE_SOLVER_RTOL", shell)
        for value in ("4", "6.0", "6;echo BAD", 6, True):
            with self.subTest(value=value), self.assertRaises(pilot.managed.BenchmarkError):
                pilot.compose_command(context, Path("/outputs"), pilot="de-smoke-k25", thickness_layers=value)
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot.compose_command(context, Path("/outputs"), pilot="de100", thickness_layers="6")
        with TemporaryDirectory() as temporary:
            case = Path(temporary)
            metadata = {"problem_meta": {"runtime_metadata": {
                "de_smoke": {"through_thickness_elements": 6, "film_thickness_m": 10e-9},
                "mesh_workflow": {"per_geometry": [{"through_thickness_elements": 6}]}}}}
            nodes, cells = [], []
            for layer in range(6):
                z = -5e-9 + layer * 10e-9 / 6
                start = len(nodes)
                nodes.extend([[0, 0, z], [1e-9, 0, z], [0, 1e-9, z], [0, 0, z + 10e-9/6]])
                cells.append(list(range(start, start + 4)))
            metadata["execution_plan"] = {"backend_plan": {
                "kind": "fem_eigen", "mesh": {"nodes": nodes, "elements": cells}}}
            path = case / "metadata.json"
            path.write_text(json.dumps(metadata))
            report = pilot.validate_thickness_layers_metadata(case, "6")
            self.assertTrue(report["thickness_resolution_verified"])
            self.assertEqual(report["declared_layers"], 6)
            # Metadata can claim six layers while the mesh still crosses the full film.
            metadata["execution_plan"]["backend_plan"]["mesh"] = {
                "nodes": [[0,0,-5e-9],[1e-9,0,-5e-9],[0,1e-9,-5e-9],[0,0,5e-9]],
                "elements": [[0,1,2,3]]}
            path.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(pilot.managed.BenchmarkError, "realized tetra mesh"):
                pilot.validate_thickness_layers_metadata(case, "6")
            for value in (3, 6.0, True):
                metadata["problem_meta"]["runtime_metadata"]["mesh_workflow"]["per_geometry"][0]["through_thickness_elements"] = value
                path.write_text(json.dumps(metadata))
                with self.subTest(value=value), self.assertRaises(pilot.managed.BenchmarkError):
                    pilot.validate_thickness_layers_metadata(case, "6")
            path.write_text("{}")
            with self.assertRaises(pilot.managed.BenchmarkError):
                pilot.validate_thickness_layers_metadata(case, "6")

if __name__ == "__main__":
    unittest.main()
