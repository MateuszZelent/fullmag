"""Regression checks for the immutable DE pilot execution route."""
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import json
import run_de_100nm_pilot as pilot


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
            context = SimpleNamespace(
                layout={"repo_root": str(root)}, image_digest="sha256:test"
            )
            request = {"source": {}, "job": {}, "runtime": {}}
            with patch.object(pilot.managed, "_run_request", return_value=request), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}) as compose_env, \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={"case": "c1"}), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], "abc"), 0)
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
            context = SimpleNamespace(
                layout={"repo_root": str(root)}, image_digest="sha256:test"
            )
            with patch.object(pilot.managed, "_run_request", return_value={"source": {}, "job": {}, "runtime": {}}), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={}) as validate, \
                 patch.object(pilot, "validate_rows", return_value={"qualification": "NOT VERIFIED", "sample_count": 2}) as row_check, \
                 patch.object(pilot, "validate_smoke_potential_fields", return_value={"qualification": "NOT VERIFIED"}) as field_check, \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], "abc", pilot="de-smoke-two"), 0)
            validate.assert_called_once_with(root / "de-smoke-two", "c1")
            row_check.assert_called_once_with(
                root / "de-smoke-two/eigen/dispersion.csv", "two",
                root / "de-smoke-two/eigen/diagnostics/solver.v1.json",
                root / "de-smoke-two/metadata.json")
            field_check.assert_called_once_with(root / "de-smoke-two", 2)
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
            context = SimpleNamespace(
                layout={"repo_root": str(root)}, image_digest="sha256:test"
            )
            with patch.object(pilot.managed, "_run_request", return_value={"source": {}, "job": {}, "runtime": {}}), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={}), \
                 patch.object(pilot, "validate_rows", side_effect=ValueError("missing DE-SMOKE samples")), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], "abc", pilot="de-smoke-two"), 1)
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
            context = SimpleNamespace(
                layout={"repo_root": str(root)}, image_digest="sha256:test"
            )
            with patch.object(pilot.managed, "_run_request", return_value={"source": {}, "job": {}, "runtime": {}}), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={}), \
                 patch.object(pilot, "validate_rows", return_value={"sample_count": 2}), \
                 patch.object(pilot, "validate_smoke_potential_fields", side_effect=ValueError("gradient mismatch")), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], "abc", pilot="de-smoke-two"), 1)
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
