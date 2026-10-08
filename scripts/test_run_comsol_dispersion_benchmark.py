"""Contract checks for the managed COMSOL benchmark runner."""

from __future__ import annotations

from dataclasses import replace
import json
import ntpath
from pathlib import Path
import sqlite3
import subprocess
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_comsol_dispersion_benchmark as benchmark


class ComsolDispersionBenchmarkTests(unittest.TestCase):
    def test_runtime_evidence_rejects_stale_or_unbound_native_library(self):
        native = {"head_commit_full": "d" * 40, "source_snapshot_sha256": "e" * 64}
        source = {"commit": native["head_commit_full"], "snapshot_sha256": native["source_snapshot_sha256"]}
        runtime = {"schema": "fullmag.fem.slepc_runtime.attestation.v1", "status": "pass", "source": source}
        for profile in (benchmark.RUNTIME_PROFILE, benchmark.CPU_ABI_RUNTIME_PROFILE):
            for stamp in (None, "a" * 64, "e" * 64):
                with self.subTest(profile=profile, stamp=stamp):
                    dependency = {"status": "pass", "source": source, "dependency": {
                        "diagnostics_json": json.dumps({"native_source_snapshot_sha256": stamp})}}
                    cmake = {"mfem_abi": {"path": "/opt/fullmag-mfem-cpu/lib/libmfem.so", "sha256": "f" * 64}}
                    def fixture(path, _label):
                        return {"runtime-attestation.json": runtime,
                                "dependency-attestation.json": dependency,
                                "cmake-attestation.json": cmake}[path.name]
                    with patch.object(benchmark, "_json_file", side_effect=fixture):
                        if stamp == native["source_snapshot_sha256"]:
                            result = benchmark._validated_build_evidence(Path("artifacts"), profile, native)
                            self.assertEqual(result["source"], source)
                        else:
                            with self.assertRaisesRegex(benchmark.BenchmarkError, "native source binding"):
                                benchmark._validated_build_evidence(Path("artifacts"), profile, native)

    def test_cpu_abi_compose_uses_pinned_image_and_cpu_mfem_library(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = self.fake_context(root)
            image = "sha256:" + "f" * 64
            context = replace(
                base,
                job={**base.job, "profile": benchmark.CPU_ABI_RUNTIME_PROFILE},
                image_digest=image,
            )
            command = benchmark._compose_command(context, root / "output", benchmark.CASES)
            self.assertIn("FULLMAG_FEM_GPU_IMAGE=" + image, command)
            self.assertIn(
                "CMAKE_PREFIX_PATH=/opt/fullmag-mfem-cpu:/opt/fullmag-deps",
                command,
            )
            self.assertIn(
                "LD_LIBRARY_PATH=/workspace/.fullmag/local/lib:"
                "/opt/fullmag-mfem-cpu/lib:/usr/local/cuda/compat:/opt/fullmag-deps/lib",
                command,
            )
            self.assertEqual(
                benchmark._compose_environment(context.layout, image)["FULLMAG_FEM_GPU_IMAGE"],
                image,
            )
            self.assertEqual(
                benchmark._container_identity(context, root / "output")["image_digest"],
                image,
            )

    def test_each_profile_requires_operator_pinned_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layout = {"storage_root": str(root)}
            with self.assertRaisesRegex(benchmark.BenchmarkError, "runner build catalog"):
                benchmark._expected_image_digest(
                    layout, benchmark.CPU_ABI_RUNTIME_PROFILE
                )
            catalog = root / "index" / "local-runner-build-config.json"
            catalog.parent.mkdir()
            image = "sha256:" + "a" * 64
            catalog.write_text(json.dumps({"profiles": {
                profile: {"image_digest": image}
                for profile in benchmark.SUPPORTED_PROFILES
            }}), encoding="utf-8")
            for profile in benchmark.SUPPORTED_PROFILES:
                self.assertEqual(
                    benchmark._expected_image_digest(layout, profile), image
                )
            with self.assertRaisesRegex(
                benchmark.BenchmarkError, "unsupported benchmark build profile"
            ):
                benchmark._expected_image_digest(layout, "fem-cpu-release")

    def fake_context(self, root: Path) -> benchmark.BuildContext:
        source = root / "capsule" / "tree"
        runtime = root / "build" / "artifacts" / "outputs" / ".fullmag" / "local"
        run_root = root / "build"
        job = {
            "job_id": "a" * 32,
            "worktree_id": "worktree-a",
            "profile": benchmark.PROFILE,
            "source_digest": "b" * 64,
            "payload": {"capsule_relative": "runs/worktree-a/" + "c" * 32 + "/source"},
        }
        native = {
            "schema": "fullmag.source-snapshot.v2",
            "head_commit_full": "d" * 40,
            "source_snapshot_sha256": "e" * 64,
        }
        layout = {"storage_root": str(root), "repo_root": str(root / "repo"), "env": {}}
        return benchmark.BuildContext(
            layout=layout,
            job=job,
            manifest={"resolved_commit": native["head_commit_full"]},
            native_identity=native,
            receipt={"artifact_hashes": {}},
            run_root=run_root,
            artifacts=run_root / "artifacts",
            capsule=source.parent,
            source_tree=source,
            runtime_root=runtime,
        )

    def test_modal_contract_requires_executed_shared_domain_regression(self):
        # List the required scenarios independently of the client's constants.
        targets = [
            "fem_poisson_airbox_modal_eigen_slepc_contract",
            "fem_floquet_magnetic_operator_contract",
            "fem_floquet_bloch_scalar_contract",
            "fem_floquet_airbox_operator_contract",
            "fem_floquet_dynamic_demag_k_contract",
            "fem_floquet_waveguide_demag_k_contract",
            "fem_floquet_waveguide_cross_section_contract",
            "fem_floquet_modal_solver_contract",
            "fem_poisson_airbox_shared_domain_contract",
        ]
        native = {"head_commit_full": "d" * 40, "source_snapshot_sha256": "e" * 64}
        requested = {"backend": "fem", "device": "cpu", "precision": "double", "slepc": True}
        resolved = {**requested, "fallback_used": False}
        options = {
            "FULLMAG_ENABLE_CUDA": "ON", "FULLMAG_ENABLE_FEM_GPU": "OFF",
            "FULLMAG_USE_MFEM_STACK": "ON", "FULLMAG_FEM_WITH_SLEPC": "ON",
        }
        contract = {
            "schema": benchmark.CONTRACT_SCHEMA, "scenario": "slepc-modal", "status": "pass",
            "source": {"commit": native["head_commit_full"],
                       "snapshot_sha256": native["source_snapshot_sha256"]},
            "requested": requested, "resolved": resolved,
            "build": {
                "modal_target": targets[0], "floquet_targets": targets[1:-1],
                "shared_domain_target": targets[-1],
                "options": [f"-D{name}={value}" for name, value in options.items()],
                "ctest_completed": True, "executed_targets": targets,
            },
            "attestation": {
                "ctest_junit": {
                    "status": "pass", "testcase_count": 9, "skipped_count": 0,
                    "failure_count": 0, "testcases": targets,
                },
                "cmake": {"status": "pass", "options": {
                    name: {"value": value} for name, value in options.items()}},
                "runtime": {"status": "pass", "availability": {"native_fem_cpu_available": True},
                            "startup_stamp": "source snapshot: " + native["source_snapshot_sha256"]},
                "dependency": {"status": "pass", "dependency": {
                    "petsc_available": True, "slepc_available": True,
                    "modal_eigen_native_cpu_slepc_available": True,
                    "petsc_version": "3.24.6", "slepc_version": "3.24.3",
                    "diagnostics": {"native_source_snapshot_sha256": "e" * 64}}},
                "resolution": {"status": "pass", "resolved": resolved, "precision": {
                    "value": "double", "basis": "PETSC_USE_REAL_DOUBLE; sizeof(PetscReal)=8"}},
            },
        }
        with patch.object(benchmark, "_json_file", return_value=contract):
            self.assertEqual(benchmark._validate_contract(Path("contract.json"), native), contract)
        mutations = (
            ("stale native library", ("attestation", "dependency", "dependency", "diagnostics", "native_source_snapshot_sha256"), "b" * 64),
            ("missing native binding", ("attestation", "dependency", "dependency", "diagnostics"), {}),
            ("missing shared-domain metadata", ("build", "shared_domain_target"), None),
            ("old eight-target build", ("build", "executed_targets"), targets[:-1]),
            ("missing shared-domain JUnit case", ("attestation", "ctest_junit", "testcases"), targets[:-1]),
            ("skipped regression", ("attestation", "ctest_junit", "skipped_count"), 1),
            ("stale snapshot", ("source", "snapshot_sha256"), "0" * 64),
        )
        for label, keys, value in mutations:
            with self.subTest(label=label):
                altered = json.loads(json.dumps(contract))
                record = altered
                for key in keys[:-1]:
                    record = record[key]
                record[keys[-1]] = value
                with patch.object(benchmark, "_json_file", return_value=altered):
                    with self.assertRaises(benchmark.BenchmarkError):
                        benchmark._validate_contract(Path("contract.json"), native)

    def test_compose_plan_is_pinned_cpu_slepc_and_has_no_build_or_default_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            command = benchmark._compose_command(context, root / "output", benchmark.CASES)
            self.assertEqual(command[:2], ["docker", "compose"])
            self.assertEqual(command[2], "-f")
            self.assertEqual(command[4], "-f")
            profile_index = command.index("--profile")
            self.assertEqual(command[profile_index : profile_index + 2], ["--profile", "fem-modal-cpu"])
            self.assertIn("--no-deps", command)
            self.assertIn("--pull", command)
            self.assertIn("never", command)
            rendered = " ".join(command)
            self.assertIn(benchmark.EXPECTED_IMAGE_DIGEST, rendered)
            self.assertNotIn("fullmag/fem-gpu:local", rendered)
            self.assertNotIn("cmake", rendered)
            self.assertNotIn("cargo", rendered)
            self.assertNotIn("--gpus", rendered)
            self.assertIn(f"{context.source_tree}:/workspace/capsule:ro", command)
            self.assertIn(f"{context.runtime_root}:/workspace/.fullmag/local:ro", command)
            self.assertIn(f"{root / 'output'}:/workspace/benchmark-output:rw", command)
            identity = benchmark._container_identity(context, root / "output")
            self.assertIn("--name", command)
            self.assertEqual(command[command.index("--name") + 1], identity["name"])
            labels = {
                command[index + 1].split("=", 1)[0]: command[index + 1].split("=", 1)[1]
                for index, token in enumerate(command[:-1])
                if token == "--label"
            }
            self.assertEqual(labels, identity["labels"])
            self.assertIn("timeout", command)
            timeout_index = command.index("timeout")
            self.assertEqual(
                command[timeout_index : timeout_index + 6],
                [
                    "timeout",
                    "--foreground",
                    "--signal=TERM",
                    "--kill-after=30s",
                    "21600",
                    "bash",
                ],
            )
            self.assertIn("--backend fem --mode strict --precision double", rendered)
            self.assertIn("FULLMAG_FEM_EXECUTION=cpu", rendered)
            self.assertIn("FULLMAG_FEM_MFEM_DEVICE=cpu", rendered)
            self.assertIn("FULLMAG_FEM_WITH_SLEPC=ON", rendered)
            self.assertIn("FULLMAG_DISABLE_PREVIEW_3D=1", rendered)
            self.assertIn("FULLMAG_DISABLE_CHARTS=1", rendered)

    def test_case_shell_is_allow_listed_and_runs_each_case_once(self):
        script = benchmark._shell_case_command(("c0", "a1"))
        self.assertEqual(script.count("FULLMAG_COMSOL_DISPERSION_CASE="), 2)
        self.assertEqual(script.count("FULLMAG_COMSOL_DISPERSION_ALL_FIELDS=1"), 2)
        self.assertIn("case_dir=/workspace/benchmark-output/c0", script)
        self.assertIn("case_dir=/workspace/benchmark-output/a1", script)
        self.assertIn("--headless --json --output-dir", script)
        self.assertNotIn("docker", script)
        self.assertNotIn("cmake", script)
        self.assertNotIn("cargo", script)
        with self.assertRaises(benchmark.BenchmarkError):
            benchmark._shell_case_command(("c0", "unknown"))

    def test_image_check_requires_exact_id_and_does_not_accept_tag(self):
        image = "sha256:" + "a" * 64
        called = Mock(
            return_value=SimpleNamespace(
                returncode=0,
                stdout=json.dumps([{"Id": image, "Config": {}}]),
            )
        )
        result = benchmark._inspect_image(image, run=called)
        self.assertEqual(result["id"], image)
        called.assert_called_once()
        self.assertEqual(called.call_args.kwargs["timeout"], benchmark.DOCKER_LIFECYCLE_TIMEOUT_SECONDS)
        with self.assertRaises(benchmark.BenchmarkError):
            benchmark._inspect_image("fullmag/fem-gpu:local", run=called)

    def test_image_check_timeout_is_a_bounded_benchmark_failure(self):
        image = "sha256:" + "a" * 64
        called = Mock(side_effect=benchmark.subprocess.TimeoutExpired(
            ["docker", "image", "inspect", image],
            benchmark.DOCKER_LIFECYCLE_TIMEOUT_SECONDS,
        ))
        with self.assertRaisesRegex(benchmark.BenchmarkError, "exceeded its deadline"):
            benchmark._inspect_image(image, run=called)
        self.assertEqual(called.call_args.kwargs["timeout"], benchmark.DOCKER_LIFECYCLE_TIMEOUT_SECONDS)

    def test_case_artifacts_require_json_csv_mode_and_potential_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for case in ("c0", "c1"):
                case_dir = root / case
                for relative in benchmark.REQUIRED_CASE_ARTIFACTS:
                    path = case_dir / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    if relative == "eigen/spectrum.v2.json":
                        path.write_text(json.dumps({"schema_version": "eigen_spectrum.v2"}), encoding="utf-8")
                    elif relative == "eigen/branches.v2.json":
                        path.write_text(json.dumps({"schema_version": "eigen_branches.v2"}), encoding="utf-8")
                    elif relative == "eigen/dispersion.csv":
                        path.write_text("kx_rad_per_m,ky_rad_per_m,frequency_hz\n0,0,1\n", encoding="utf-8")
                    else:
                        path.write_text("{}", encoding="utf-8")
                mode = case_dir / "eigen/mode_fields/sample_0000/mode_0000/vector.bin"
                mode.parent.mkdir(parents=True, exist_ok=True)
                mode.write_bytes(b"mode")
                if case == "c1":
                    potential = mode.parent / "potential_full.bin"
                    potential.write_bytes(b"potential")
                    (mode.parent / "physical_potential.v1.json").write_text("{}", encoding="utf-8")
                result = benchmark._validate_case_artifacts(case_dir, case)
                self.assertEqual(result["dispersion_rows"], 1)
            with self.assertRaises(benchmark.BenchmarkError):
                benchmark._validate_case_artifacts(root / "c0", "c1")

    def test_numeric_only_frequency_source_is_recorded_as_non_analytic(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = Path(directory) / "c0"
            (case_dir / "frequency_domain").mkdir(parents=True)
            (case_dir / "eigen" / "diagnostics").mkdir(parents=True)
            (case_dir / "frequency_domain" / "manifest.v1.json").write_text(
                json.dumps(
                    {
                        "validation": {
                            "dispersion_frequency_source": "numeric_modal_solver",
                            "dispersion_reference_model": None,
                        }
                    }
                ),
                encoding="utf-8",
            )
            (case_dir / "eigen" / "diagnostics" / "solver.v1.json").write_text(
                json.dumps({"solver_model": "slepc_multi_shift_invert_production_cpu_dense"}),
                encoding="utf-8",
            )
            artifact_result = {
                "required_artifact_hashes": {
                    relative: {"sha256": chr(97 + index) * 64}
                    for index, relative in enumerate(
                        (
                            "metadata.json",
                            "eigen/spectrum.v2.json",
                            "eigen/branches.v2.json",
                            "eigen/dispersion.csv",
                            "frequency_domain/manifest.v1.json",
                            "eigen/diagnostics/solver.v1.json",
                        )
                    )
                }
            }

            benchmark._write_scientific_evidence(case_dir, "c0", artifact_result)

            evidence = json.loads(
                (case_dir / benchmark.EVIDENCE_RELATIVE_PATH).read_text(encoding="utf-8")
            )
            self.assertEqual(
                evidence["numeric_run"]["frequency_source"], "numeric_modal_solver"
            )
            self.assertIs(
                evidence["numeric_run"]["analytic_solver_used_for_frequencies"], False
            )

    def test_external_scientific_evidence_is_staged_and_hash_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case_dir = root / "output" / "c0"
            case_dir.mkdir(parents=True)
            source_case = root / "evidence" / "c0"
            source_validation = source_case / "validation"
            source_validation.mkdir(parents=True)
            bindings = {
                "metadata_sha256": "a" * 64,
                "spectrum_v2_sha256": "b" * 64,
                "branches_v2_sha256": "c" * 64,
                "dispersion_csv_sha256": "d" * 64,
                "manifest_sha256": "e" * 64,
                "solver_diagnostics_sha256": "f" * 64,
            }
            evidence = {
                "schema_version": benchmark.EVIDENCE_SCHEMA,
                "case_id": "c0",
                "numeric_run": {
                    "frequency_source": "native_solver_attested",
                    "analytic_solver_used_for_frequencies": False,
                    "dynamic_demag_operator_source": None,
                },
                "artifact_bindings": bindings,
                "analytic_controls": {"kittel": {"status": "pass"}},
                "convergence": {
                    "mesh": {"status": "pass"},
                    "airbox": {"status": "not_applicable"},
                    "mode_count": {"status": "pass"},
                },
            }
            (source_validation / "scientific_gate.v1.json").write_text(
                json.dumps(evidence), encoding="utf-8"
            )
            comparison = source_case / "validation" / "comparison" / "mesh.json"
            comparison.parent.mkdir(parents=True)
            comparison.write_text("{}", encoding="utf-8")
            staged = benchmark._stage_external_scientific_evidence(
                case_dir, "c0", root / "evidence", bindings
            )
            self.assertEqual(staged["case_id"], "c0")
            self.assertEqual(staged["evidence_provenance"]["copied_file_count"], 1)
            self.assertEqual(
                (case_dir / "validation" / "comparison" / "mesh.json").read_text(), "{}"
            )

    def test_external_scientific_evidence_rejects_stale_primary_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case_dir = root / "output" / "c0"
            case_dir.mkdir(parents=True)
            source_case = root / "evidence" / "c0" / "validation"
            source_case.mkdir(parents=True)
            evidence = {
                "schema_version": benchmark.EVIDENCE_SCHEMA,
                "case_id": "c0",
                "numeric_run": {},
                "artifact_bindings": {"metadata_sha256": "0" * 64},
                "analytic_controls": {},
                "convergence": {},
            }
            (source_case / "scientific_gate.v1.json").write_text(
                json.dumps(evidence), encoding="utf-8"
            )
            with self.assertRaisesRegex(benchmark.BenchmarkError, "binding"):
                benchmark._stage_external_scientific_evidence(
                    case_dir,
                    "c0",
                    root / "evidence",
                    {"metadata_sha256": "1" * 64},
                )

    def test_new_output_is_inside_storage_and_existing_output_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            candidate = benchmark._new_output_dir(context, None)
            self.assertIn(root, candidate.parents)
            candidate.mkdir(parents=True)
            with self.assertRaises(benchmark.BenchmarkError):
                benchmark._new_output_dir(context, str(candidate))

    def _owned_container_payload(self, context, output_dir, *, running=True, labels=None,
                                 extra_mounts=()):
        identity = benchmark._container_identity(context, output_dir)
        expected_mounts = benchmark._expected_container_mounts(
            context, output_dir, extra_mounts=extra_mounts
        )
        mounts = [
            {
                "Type": "bind",
                "Source": mount["source"],
                "Destination": mount["destination"],
                "RW": not mount["read_only"],
            }
            for mount in expected_mounts
            if mount.get("type", "bind") == "bind"
        ]
        tmpfs = {
            mount["destination"]: mount["mode"]
            for mount in expected_mounts
            if mount.get("type") == "tmpfs"
        }
        return {
            "Id": "a" * 64,
            "Name": "/" + identity["name"],
            "Image": benchmark.EXPECTED_IMAGE_DIGEST,
            "Config": {
                "Image": benchmark.EXPECTED_IMAGE_DIGEST,
                "Labels": dict(labels or identity["labels"]),
            },
            "Mounts": mounts,
            "HostConfig": {"Tmpfs": tmpfs},
            "State": {"Running": running, "Status": "running" if running else "exited"},
        }

    def test_cleanup_attests_model_ui_and_tmpfs_mounts_exactly(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            output_dir = root / "output"
            output_dir.mkdir()
            model = output_dir / "model-input.py"
            model.write_text("# model\n", encoding="utf-8")
            web = output_dir / "ui-web"
            web.mkdir()
            (web / "index.html").write_text("<html></html>", encoding="utf-8")
            extras = (
                {"type": "bind", "source": str(model.resolve()),
                 "destination": "/workspace/benchmark-model.py", "read_only": True},
                {"type": "tmpfs", "destination": "/workspace/fullmag-ui-workspace",
                 "read_only": False, "mode": "rw,nosuid,nodev,size=1g"},
                {"type": "bind", "source": str(web.resolve()),
                 "destination": "/workspace/fullmag-web", "read_only": True},
            )
            payload = self._owned_container_payload(
                context, output_dir, extra_mounts=extras, running=False
            )
            calls = []
            inspect_count = 0

            def docker_run(argv, **kwargs):
                nonlocal inspect_count
                calls.append(argv)
                if argv[:4] == ["docker", "container", "inspect", argv[3]]:
                    inspect_count += 1
                    if inspect_count > 1:
                        return SimpleNamespace(returncode=1, stdout="", stderr="No such container")
                    return SimpleNamespace(returncode=0, stdout=json.dumps([payload]), stderr="")
                if argv[:4] == ["docker", "container", "rm", argv[3]]:
                    return SimpleNamespace(returncode=0, stdout="", stderr="")
                return SimpleNamespace(returncode=1, stdout="", stderr="No such container")

            result = benchmark._cleanup_benchmark_container(
                context, output_dir, extra_mounts=extras, run=docker_run
            )
            self.assertEqual(result["status"], "removed")
            self.assertIn(["docker", "container", "rm", "a" * 64], calls)

    def test_cleanup_blocks_unexpected_tmpfs_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            output_dir = root / "output"
            output_dir.mkdir()
            extras = ({
                "type": "tmpfs", "destination": "/workspace/fullmag-ui-workspace",
                "read_only": False, "mode": "rw,nosuid,nodev,size=1g",
            },)
            payload = self._owned_container_payload(
                context, output_dir, extra_mounts=({**extras[0], "mode": "rw"},), running=False
            )

            def docker_run(argv, **kwargs):
                return SimpleNamespace(returncode=0, stdout=json.dumps([payload]), stderr="")

            result = benchmark._cleanup_benchmark_container(
                context, output_dir, extra_mounts=extras, run=docker_run
            )
            self.assertEqual(result["status"], "blocked")
            self.assertIn("tmpfs mode mismatch", result["reason"])

    def test_cleanup_attests_hostconfig_tmpfs_with_equivalent_size_and_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            output_dir = root / "output"
            output_dir.mkdir()
            extras = ({
                "type": "tmpfs", "destination": "/tmp",
                "read_only": False, "mode": "rw,nosuid,nodev,size=1g",
            },)
            payload = self._owned_container_payload(
                context, output_dir, extra_mounts=extras, running=False
            )
            payload["HostConfig"]["Tmpfs"] = {
                "/tmp": "size=1024m,nodev,rw,nosuid"
            }
            inspect_count = 0

            def docker_run(argv, **kwargs):
                nonlocal inspect_count
                if argv[:3] == ["docker", "container", "inspect"]:
                    inspect_count += 1
                    if inspect_count > 1:
                        return SimpleNamespace(
                            returncode=1,
                            stdout="",
                            stderr="No such container",
                        )
                return SimpleNamespace(returncode=0, stdout=json.dumps([payload]), stderr="")

            result = benchmark._cleanup_benchmark_container(
                context, output_dir, extra_mounts=extras, run=docker_run
            )
            self.assertEqual(result["status"], "removed")

    def test_windows_mount_projection_preserves_forward_slashes(self):
        expected = r"C:\git\fullmag\storage\runs\benchmark"
        projected = "/host_mnt/c/git/fullmag/storage/runs/benchmark"
        with patch.object(benchmark.os, "name", "nt"), patch.object(
            benchmark.os, "path", ntpath
        ):
            # This is the Windows behavior that caused the regression: the
            # real ntpath.normcase() turns the canonical slash form back into
            # backslashes, so the helper must apply case folding separately.
            self.assertEqual(ntpath.normcase("C:/git/fullmag/storage/runs/benchmark"), expected.lower())
            self.assertEqual(
                benchmark._normalized_mount_source(expected),
                "c:/git/fullmag/storage/runs/benchmark",
            )
            self.assertTrue(benchmark._mount_source_matches(projected, expected))
            self.assertTrue(benchmark._mount_source_matches(expected, expected))

    def test_cleanup_requires_exact_identity_and_removes_only_owned_container(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            output_dir = root / "output"
            output_dir.mkdir()
            payload = self._owned_container_payload(context, output_dir, running=True)
            calls = []
            inspect_count = 0

            def docker_run(argv, **kwargs):
                nonlocal inspect_count
                calls.append(argv)
                if argv[:4] == ["docker", "container", "inspect", argv[3]]:
                    inspect_count += 1
                    if inspect_count == 1:
                        current = payload
                    elif inspect_count == 2:
                        current = {**payload, "State": {"Running": False, "Status": "exited"}}
                    else:
                        return SimpleNamespace(returncode=1, stdout="", stderr="No such container")
                    return SimpleNamespace(returncode=0, stdout=json.dumps([current]), stderr="")
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            result = benchmark._cleanup_benchmark_container(context, output_dir, run=docker_run)
            self.assertEqual(result["status"], "removed")
            self.assertIn(["docker", "container", "stop", "--time", "10", "a" * 64], calls)
            self.assertIn(["docker", "container", "rm", "a" * 64], calls)

    def test_cleanup_blocks_on_foreign_labels_without_stop_or_remove(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            output_dir = root / "output"
            output_dir.mkdir()
            identity = benchmark._container_identity(context, output_dir)
            foreign = dict(identity["labels"])
            foreign[benchmark.CONTAINER_LABEL_JOB] = "foreign"
            payload = self._owned_container_payload(context, output_dir, labels=foreign)
            calls = []

            def docker_run(argv, **kwargs):
                calls.append(argv)
                return SimpleNamespace(returncode=0, stdout=json.dumps([payload]), stderr="")

            result = benchmark._cleanup_benchmark_container(context, output_dir, run=docker_run)
            self.assertEqual(result["status"], "blocked")
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][:4], ["docker", "container", "inspect", identity["name"]])

    def test_execute_timeout_writes_terminal_result_after_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            output_dir = root / "output"
            timeout = subprocess.TimeoutExpired(["docker", "compose"], timeout=3)
            with patch.object(benchmark.subprocess, "run", side_effect=timeout), patch.object(
                benchmark,
                "_cleanup_benchmark_container",
                return_value={"status": "removed", "verified": True},
            ):
                result_code = benchmark._execute(
                    context,
                    output_dir,
                    ("c1",),
                    ["docker", "compose"],
                    timeout_seconds=30.0,
                )
            self.assertEqual(result_code, 1)
            result = json.loads((output_dir / "run-result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "failed")
            self.assertTrue(result["timed_out"])
            self.assertFalse(result["container_timed_out"])
            self.assertEqual(result["cleanup"]["status"], "removed")
            request = json.loads((output_dir / "run-request.json").read_text(encoding="utf-8"))
            self.assertEqual(request["lifecycle"]["container_timeout_seconds"], 30)
            self.assertEqual(request["lifecycle"]["host_timeout_seconds"], 120)

    def test_execute_start_errors_and_interrupts_still_write_terminal_receipt(self):
        for raised in (OSError("docker unavailable"), KeyboardInterrupt()):
            with self.subTest(exception=type(raised).__name__), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                context = self.fake_context(root)
                output_dir = root / "output"
                with patch.object(benchmark.subprocess, "run", side_effect=raised), patch.object(
                    benchmark,
                    "_cleanup_benchmark_container",
                    return_value={"status": "blocked", "reason": "test"},
                ):
                    result_code = benchmark._execute(
                        context,
                        output_dir,
                        ("c1",),
                        ["docker", "compose"],
                        timeout_seconds=30.0,
                    )
                self.assertEqual(result_code, 1)
                result = json.loads((output_dir / "run-result.json").read_text(encoding="utf-8"))
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["cleanup"]["status"], "blocked")
                if isinstance(raised, KeyboardInterrupt):
                    self.assertTrue(result["interrupted"])
                else:
                    self.assertIn("could not start", result["execution_error"])

    def test_dry_run_output_validation_has_no_persistent_side_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            requested = root / "not-created" / "output"
            with patch.object(benchmark, "register_runtime_reference_root") as register:
                candidate = benchmark._new_output_dir(context, str(requested), persist=False)
                automatic = benchmark._new_output_dir(context, None, persist=False)
                register.assert_not_called()
            self.assertEqual(candidate, requested)
            self.assertFalse(requested.parent.exists())
            self.assertFalse(automatic.parent.exists())
            with self.assertRaises(benchmark.BenchmarkError):
                benchmark._new_output_dir(context, str(root.parent / "foreign-output"), persist=False)
            existing = root / "existing"
            existing.mkdir()
            with self.assertRaises(benchmark.BenchmarkError):
                benchmark._new_output_dir(context, str(existing), persist=False)

    def test_dry_run_rejects_foreign_output_before_compose_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            with patch.object(benchmark.fullmag_storage, "resolve_layout", return_value=context.layout), \
                 patch.object(benchmark, "_read_job", return_value=context.job), \
                 patch.object(benchmark, "_validate_build_context", return_value=context), \
                 patch.object(benchmark, "_compose_command") as compose:
                status = benchmark.main([
                    "--job-id", context.job["job_id"], "--dry-run",
                    "--output-dir", str(root.parent / "foreign-output"),
                ])
                self.assertEqual(status, 2)
                compose.assert_not_called()

    def test_dry_run_does_not_contact_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            layout = {
                "storage_root": str(root),
                "repo_root": str(root / "repo"),
                "worktree_id": "worktree-a",
                "env": {},
            }
            with patch.object(benchmark.fullmag_storage, "resolve_layout", return_value=layout), \
                 patch.object(benchmark, "_read_job", return_value=context.job), \
                 patch.object(benchmark, "_validate_build_context", return_value=context), \
                 patch.object(benchmark, "_compose_command", return_value=["docker", "compose"]), \
                 patch.object(benchmark, "_inspect_image", side_effect=AssertionError("Docker must not be inspected")):
                self.assertEqual(benchmark.main(["--job-id", context.job["job_id"], "--dry-run"]), 0)

    def test_execute_attaches_scientific_gate_and_keeps_unqualified_result_when_gate_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            output_dir = root / "output"
            model = context.source_tree / "tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py"
            model.parent.mkdir(parents=True)
            model.write_text("# lifecycle fixture; no physical solve\n", encoding="utf-8")
            failed_gate = {
                "schema_version": benchmark.SCIENTIFIC_GATE_SCHEMA,
                "status": "not_qualified",
                "qualification": "NOT VERIFIED",
                "reasons": ["missing scientific evidence bundle"],
            }
            with patch.object(
                benchmark.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0),
            ), patch.object(
                benchmark,
                "resolve_runtime_artifact_root",
                return_value=(output_dir / "c0", {"fixture_only": True}),
            ), patch.object(
                benchmark,
                "_validate_case_artifacts",
                side_effect=lambda case_dir, case: {"case": case},
            ), patch.object(
                benchmark,
                "validate_scientific_case",
                return_value=failed_gate,
            ), patch.object(
                benchmark,
                "validate_requested_cases",
                return_value={
                    "schema_version": benchmark.SCIENTIFIC_GATE_SCHEMA,
                    "status": "not_qualified",
                    "qualification": "NOT VERIFIED",
                    "reasons": ["missing scientific evidence bundle"],
                },
            ), patch.object(
                benchmark,
                "_write_scientific_evidence",
                return_value=None,
            ):
                result_code = benchmark._execute(
                    context,
                    output_dir,
                    ("c0",),
                    ["docker", "compose"],
                    timeout_seconds=30.0,
                )
            result = json.loads((output_dir / "run-result.json").read_text(encoding="utf-8"))
            self.assertEqual(result_code, 0, result)
            self.assertEqual(result["status"], "completed_unqualified")
            self.assertEqual(result["qualification"], "NOT VERIFIED")
            self.assertEqual(result["cases"][0]["scientific_gate"], failed_gate)
            self.assertEqual(result["scientific_gate"]["status"], "not_qualified")

    def test_job_reader_requires_succeeded_modal_build_and_canonical_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "repo"
            repo.mkdir()
            (root / "index").mkdir()
            job_id = "a" * 32
            capture_id = "c" * 32
            payload = {
                "origin_repo": str(repo),
                "capture_id": capture_id,
                "capsule_relative": f"runs/worktree-a/{capture_id}/source",
                "native_source_identity": {
                    "schema": "fullmag.source-snapshot.v2",
                    "head_commit_full": "d" * 40,
                    "source_snapshot_sha256": "e" * 64,
                },
            }
            connection = sqlite3.connect(root / "index/runner-jobs.sqlite")
            with connection:
                connection.execute(
                    """
                    CREATE TABLE jobs (
                        job_id TEXT, owner TEXT, worktree_id TEXT,
                        source_digest TEXT, profile TEXT, operation TEXT,
                        payload TEXT, state TEXT, exit_code INTEGER
                    )
                    """
                )
                connection.execute(
                    "INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        job_id,
                        "operator",
                        "worktree-a",
                        "b" * 64,
                        benchmark.PROFILE,
                        "build",
                        json.dumps(payload),
                        "succeeded",
                        0,
                    ),
                )
            connection.close()
            layout = {
                "storage_root": str(root),
                "repo_root": str(repo),
                "worktree_id": "worktree-a",
            }
            job = benchmark._read_job(layout, job_id)
            self.assertEqual(job["profile"], benchmark.PROFILE)
            self.assertEqual(job["payload"]["capture_id"], capture_id)
            connection = sqlite3.connect(root / "index/runner-jobs.sqlite")
            with connection:
                connection.execute("UPDATE jobs SET state='failed'")
            connection.close()
            with self.assertRaises(benchmark.BenchmarkError):
                benchmark._read_job(layout, job_id)


if __name__ == "__main__":
    unittest.main()
