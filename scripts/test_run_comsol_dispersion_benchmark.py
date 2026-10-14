"""Contract checks for the managed COMSOL benchmark runner."""

from __future__ import annotations

from dataclasses import replace
import hashlib
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
import frequency_domain_generation as artifact_generation
import run_comsol_dispersion_benchmark as benchmark
import validate_comsol_dispersion_scientific_gate as scientific_gate


def install_v2_case(case_dir, *, payload_overrides=None, omitted=()):
    payloads = {
        "metadata.json": b"{}",
        "eigen/spectrum.v2.json": json.dumps(
            {"schema_version": "eigen_spectrum.v2", "samples": []}
        ).encode("utf-8"),
        "eigen/branches.v2.json": json.dumps(
            {"schema_version": "eigen_branches.v2", "branches": []}
        ).encode("utf-8"),
        "eigen/dispersion.csv": b"kx_rad_per_m,ky_rad_per_m,frequency_hz\n0,0,1\n",
        "eigen/diagnostics/solver.v1.json": b"{}",
        "eigen/metadata/eigen_summary.json": b"{}",
        "frequency_domain/manifest.v1.json": json.dumps(
            {"schema_version": "frequency_domain_manifest.v1"}
        ).encode("utf-8"),
        "eigen/mode_fields/sample_0000/mode_0000/vector.bin": b"captured-mode-vector",
    }
    payloads.update(payload_overrides or {})
    for relative in omitted:
        payloads.pop(relative, None)
    members = {
        relative: {
            "byte_length": len(payload),
            "sha256": "sha256:" + hashlib.sha256(payload).hexdigest(),
        }
        for relative, payload in payloads.items()
    }
    content = {
        "schema_version": artifact_generation.SCHEMA_V2,
        "producer": None,
        "members": {relative: members[relative] for relative in sorted(members)},
    }
    canonical = json.dumps(
        content, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    generation_id = "sha256:" + hashlib.sha256(canonical).hexdigest()
    member_root = (
        case_dir / artifact_generation.GENERATION_DIRECTORY / generation_id[7:]
    )
    for relative, payload in payloads.items():
        path = member_root.joinpath(*relative.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    marker = json.dumps(
        {"generation_id": generation_id, "content": content},
        ensure_ascii=False,
        indent=2,
        allow_nan=False,
    ).encode("utf-8")
    marker_path = case_dir / artifact_generation.IMMUTABLE_COMMIT_PATH
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    marker_path.write_bytes(marker)
    return generation_id, payloads, member_root


def c0_evidence_for_payloads(payloads):
    binding_paths = {
        "metadata_sha256": "metadata.json",
        "spectrum_v2_sha256": "eigen/spectrum.v2.json",
        "branches_v2_sha256": "eigen/branches.v2.json",
        "dispersion_csv_sha256": "eigen/dispersion.csv",
        "manifest_sha256": "frequency_domain/manifest.v1.json",
        "solver_diagnostics_sha256": "eigen/diagnostics/solver.v1.json",
    }
    return {
        "schema_version": benchmark.EVIDENCE_SCHEMA,
        "case_id": "c0",
        "numeric_run": {
            "frequency_source": "native_solver_attested",
            "analytic_solver_used_for_frequencies": False,
            "dynamic_demag_operator_source": None,
        },
        "artifact_bindings": {
            key: hashlib.sha256(payloads[relative]).hexdigest()
            for key, relative in binding_paths.items()
        },
        "analytic_controls": {},
        "convergence": {
            "mesh": {"status": "pending"},
            "airbox": {"status": "not_applicable"},
            "mode_count": {"status": "pending"},
        },
    }


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

    def test_v2_case_artifacts_use_declared_members_not_stale_root_shadows(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = Path(directory) / "c0"
            generation_id, payloads, _ = install_v2_case(case_dir)
            stale_spectrum = json.dumps(
                {"schema_version": "eigen_spectrum.v2", "samples": [{"stale": True}]}
            ).encode("utf-8")
            stale_path = case_dir / "eigen/spectrum.v2.json"
            stale_path.parent.mkdir(parents=True, exist_ok=True)
            stale_path.write_bytes(stale_spectrum)
            extra_root_vector = case_dir / "eigen/mode_fields/sample_9999/mode_9999/vector.bin"
            extra_root_vector.parent.mkdir(parents=True, exist_ok=True)
            extra_root_vector.write_bytes(b"root-only-stale-vector")

            reader = benchmark.ArtifactBundleReader(case_dir)
            result = benchmark._validate_case_artifacts(
                case_dir, "c0", bundle_reader=reader
            )

            expected_spectrum_hash = hashlib.sha256(
                payloads["eigen/spectrum.v2.json"]
            ).hexdigest()
            self.assertEqual(reader.generation.generation_id, generation_id)
            self.assertEqual(
                result["required_artifact_hashes"]["eigen/spectrum.v2.json"]["sha256"],
                expected_spectrum_hash,
            )
            self.assertNotEqual(expected_spectrum_hash, hashlib.sha256(stale_spectrum).hexdigest())
            self.assertEqual(result["mode_field_count"], 1)

    def test_v2_eigen_summary_uses_shared_reader_cache_and_record(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = Path(directory) / "c0"
            install_v2_case(case_dir)
            reader = benchmark.ArtifactBundleReader(case_dir)
            summary = "eigen/metadata/eigen_summary.json"

            # Seed every declared required input so the patched generation
            # reader can prove validation stays on ArtifactBundleReader APIs.
            for relative in benchmark.REQUIRED_CASE_ARTIFACTS:
                maximum_bytes = (
                    benchmark.MAX_EIGEN_SUMMARY_BYTES
                    if relative == summary
                    else benchmark.MAX_CASE_DISPERSION_CSV_BYTES
                    if relative == "eigen/dispersion.csv"
                    else benchmark.MAX_CASE_JSON_BYTES
                    if relative.endswith(".json")
                    else None
                )
                reader.read_bytes(relative, maximum_bytes=maximum_bytes)

            with patch.object(
                type(reader.generation),
                "read_member",
                side_effect=AssertionError("validation bypassed the shared reader cache"),
            ), patch.object(reader, "read_bytes", wraps=reader.read_bytes) as read_bytes, patch.object(
                reader, "record_for", wraps=reader.record_for
            ) as record_for:
                result = benchmark._validate_case_artifacts(
                    case_dir, "c0", bundle_reader=reader
                )

            read_bytes.assert_any_call(summary, maximum_bytes=benchmark.MAX_EIGEN_SUMMARY_BYTES)
            record_for.assert_any_call(summary)
            summary_record = reader.record_for(summary)
            self.assertEqual(
                result["required_artifact_hashes"][summary]["sha256"],
                summary_record["sha256"].removeprefix("sha256:"),
            )

    def test_v2_missing_or_corrupt_required_member_never_falls_back_to_root(self):
        stale_spectrum = json.dumps(
            {"schema_version": "eigen_spectrum.v2", "samples": []}
        ).encode("utf-8")
        with tempfile.TemporaryDirectory() as directory:
            missing_case = Path(directory) / "missing"
            install_v2_case(
                missing_case,
                omitted=("eigen/spectrum.v2.json",),
            )
            root_spectrum = missing_case / "eigen/spectrum.v2.json"
            root_spectrum.parent.mkdir(parents=True, exist_ok=True)
            root_spectrum.write_bytes(stale_spectrum)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "captured bundle"):
                benchmark._validate_case_artifacts(missing_case, "c0")

            corrupt_case = Path(directory) / "corrupt"
            _, _, member_root = install_v2_case(corrupt_case)
            corrupt_member = member_root / "eigen/spectrum.v2.json"
            corrupt_member.write_bytes(stale_spectrum + b" ")
            root_spectrum = corrupt_case / "eigen/spectrum.v2.json"
            root_spectrum.parent.mkdir(parents=True, exist_ok=True)
            root_spectrum.write_bytes(stale_spectrum)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "captured bundle"):
                benchmark._validate_case_artifacts(corrupt_case, "c0")

    def test_v2_case_artifact_validation_fails_if_final_generation_fence_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = Path(directory) / "c0"
            install_v2_case(case_dir)
            reader = benchmark.ArtifactBundleReader(case_dir)
            marker_path = case_dir / artifact_generation.IMMUTABLE_COMMIT_PATH
            original_fence = reader.ensure_current

            def change_marker_then_fence():
                marker_path.write_bytes(b"{}")
                original_fence()

            with patch.object(reader, "ensure_current", side_effect=change_marker_then_fence):
                with self.assertRaisesRegex(benchmark.BenchmarkError, "final fence failed"):
                    benchmark._validate_case_artifacts(
                        case_dir, "c0", bundle_reader=reader
                    )

    def test_benchmark_and_scientific_gate_share_capture_with_external_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case_dir = root / "c0"
            manifest = {
                "schema_version": "frequency_domain_manifest.v1",
                "validation": {
                    "dispersion_frequency_source": scientific_gate.NUMERIC_FREQUENCY_SOURCE,
                    "dispersion_reference_model": None,
                },
            }
            payload_overrides = {
                "frequency_domain/manifest.v1.json": json.dumps(manifest).encode("utf-8"),
                "eigen/diagnostics/solver.v1.json": json.dumps(
                    {"solver_model": "slepc_multi_shift_invert_production_cpu_dense"}
                ).encode("utf-8"),
            }
            _, _, _ = install_v2_case(case_dir, payload_overrides=payload_overrides)
            reader = benchmark.ArtifactBundleReader(case_dir)
            artifact_result = benchmark._validate_case_artifacts(
                case_dir, "c0", bundle_reader=reader
            )
            benchmark._write_scientific_evidence(
                case_dir, "c0", artifact_result, bundle_reader=reader
            )
            receipt_path = case_dir / benchmark.EVIDENCE_RELATIVE_PATH
            self.assertFalse(
                receipt_path.relative_to(case_dir).as_posix() in reader.generation.members
            )

            parameters_path = root / "parameters.json"
            parameters_path.write_text("{}", encoding="utf-8")
            with patch.object(
                scientific_gate,
                "ArtifactBundleReader",
                side_effect=AssertionError("scientific gate must reuse the supplied reader"),
            ):
                result = scientific_gate.validate_case(
                    case_dir,
                    "c0",
                    parameters_path=parameters_path,
                    bundle_reader=reader,
                )

            coverage = result["artifact_generation_coverage"]
            self.assertEqual(result["artifact_generation"]["generation_id"], reader.generation.generation_id)
            self.assertEqual(result["checks"]["artifact_generation_current_fence"]["status"], "pass")
            self.assertEqual(
                result["checks"]["artifact_binding"]["status"],
                "pass",
                f"evidence binding failed: {result['reasons']!r}",
            )
            self.assertEqual(result["qualification"], "NOT VERIFIED")
            self.assertTrue(coverage["case_local_evidence_loaded"])
            self.assertTrue(coverage["case_local_evidence_descriptor_bound"])
            self.assertEqual(coverage["case_local_evidence_artifact_binding_status"], "pass")
            self.assertFalse(coverage["case_local_evidence_descriptor_in_generation"])
            self.assertEqual(coverage["case_local_evidence_source"], "runner_generated_external_receipt")
            self.assertEqual(
                coverage["case_local_evidence_sha256"],
                hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
            )
            self.assertEqual(coverage["case_local_evidence_byte_length"], receipt_path.stat().st_size)
            self.assertFalse(coverage["referenced_external_evidence_files_in_generation"])

            unrelated_reasons = ["unrelated earlier diagnostic"]
            captured_artifacts = {
                Path(relative): {"sha256": record["sha256"]}
                for relative, record in artifact_result["required_artifact_hashes"].items()
            }
            binding_check = scientific_gate._validate_evidence_binding(
                case_dir,
                json.loads(receipt_path.read_text(encoding="utf-8")),
                captured_artifacts,
                "c0",
                unrelated_reasons,
            )
            self.assertEqual(binding_check["status"], "pass")
            self.assertEqual(unrelated_reasons, ["unrelated earlier diagnostic"])

            for mutation in ("wrong", "missing"):
                tampered_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                if mutation == "wrong":
                    tampered_receipt["artifact_bindings"]["spectrum_v2_sha256"] = "0" * 64
                else:
                    tampered_receipt["artifact_bindings"].pop("metadata_sha256")
                receipt_path.write_text(json.dumps(tampered_receipt), encoding="utf-8")
                with patch.object(
                    scientific_gate,
                    "ArtifactBundleReader",
                    side_effect=AssertionError("scientific gate must reuse the supplied reader"),
                ):
                    tampered_result = scientific_gate.validate_case(
                        case_dir,
                        "c0",
                        parameters_path=parameters_path,
                        bundle_reader=reader,
                    )
                tampered_coverage = tampered_result["artifact_generation_coverage"]
                self.assertTrue(tampered_coverage["case_local_evidence_loaded"])
                self.assertFalse(tampered_coverage["case_local_evidence_descriptor_bound"])
                self.assertEqual(tampered_coverage["case_local_evidence_artifact_binding_status"], "fail")
                self.assertFalse(tampered_coverage["case_local_evidence_descriptor_in_generation"])
                self.assertEqual(tampered_coverage["case_local_evidence_source"], "runner_generated_external_receipt")
                self.assertEqual(
                    tampered_coverage["case_local_evidence_sha256"],
                    hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
                )
                self.assertEqual(tampered_result["checks"]["artifact_generation_current_fence"]["status"], "pass")
                self.assertEqual(tampered_result["qualification"], "NOT VERIFIED")

    def test_declared_scientific_receipt_uses_verified_generation_member(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case_dir = root / "c0"
            _, payloads, _ = install_v2_case(case_dir)
            receipt_bytes = json.dumps(c0_evidence_for_payloads(payloads)).encode("utf-8")
            generation_id, _, member_root = install_v2_case(
                case_dir,
                payload_overrides={benchmark.EVIDENCE_RELATIVE_PATH.as_posix(): receipt_bytes},
            )
            receipt_path = benchmark.EVIDENCE_RELATIVE_PATH
            self.assertIn(receipt_path.as_posix(), benchmark.ArtifactBundleReader(case_dir).generation.members)

            # A conflicting mutable root shadow must not override the declared
            # generation member.
            root_shadow = case_dir / receipt_path
            root_shadow.parent.mkdir(parents=True, exist_ok=True)
            root_shadow.write_text(json.dumps({"case_id": "shadow"}), encoding="utf-8")
            reader = benchmark.ArtifactBundleReader(case_dir)
            parameters_path = root / "parameters.json"
            parameters_path.write_text("{}", encoding="utf-8")
            with patch.object(reader, "read_bytes", wraps=reader.read_bytes) as read_bytes, patch.object(
                reader, "record_for", wraps=reader.record_for
            ) as record_for:
                result = scientific_gate.validate_case(
                    case_dir,
                    "c0",
                    parameters_path=parameters_path,
                    bundle_reader=reader,
                )

            read_bytes.assert_any_call(
                receipt_path.as_posix(),
                maximum_bytes=artifact_generation.DEFAULT_MAX_JSON_BYTES,
            )
            record_for.assert_any_call(receipt_path.as_posix())
            coverage = result["artifact_generation_coverage"]
            captured_bytes = (member_root / receipt_path).read_bytes()
            self.assertEqual(result["artifact_generation"]["generation_id"], generation_id)
            self.assertTrue(coverage["case_local_evidence_loaded"])
            self.assertTrue(coverage["case_local_evidence_descriptor_in_generation"])
            self.assertEqual(coverage["case_local_evidence_source"], "captured_generation_member")
            self.assertEqual(coverage["case_local_evidence_artifact_binding_status"], "pass")
            self.assertEqual(
                coverage["case_local_evidence_sha256"],
                hashlib.sha256(captured_bytes).hexdigest(),
            )
            self.assertEqual(coverage["case_local_evidence_byte_length"], len(captured_bytes))
            self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_corrupt_declared_scientific_receipt_never_falls_back_to_root_shadow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case_dir = root / "c0"
            _, payloads, _ = install_v2_case(case_dir)
            receipt_bytes = json.dumps(c0_evidence_for_payloads(payloads)).encode("utf-8")
            _, _, member_root = install_v2_case(
                case_dir,
                payload_overrides={benchmark.EVIDENCE_RELATIVE_PATH.as_posix(): receipt_bytes},
            )
            receipt_path = benchmark.EVIDENCE_RELATIVE_PATH
            (member_root / receipt_path).write_bytes(receipt_bytes + b" ")
            root_shadow = case_dir / receipt_path
            root_shadow.parent.mkdir(parents=True, exist_ok=True)
            root_shadow.write_bytes(receipt_bytes)

            reader = benchmark.ArtifactBundleReader(case_dir)
            parameters_path = root / "parameters.json"
            parameters_path.write_text("{}", encoding="utf-8")
            result = scientific_gate.validate_case(
                case_dir,
                "c0",
                parameters_path=parameters_path,
                bundle_reader=reader,
            )

            coverage = result["artifact_generation_coverage"]
            self.assertTrue(coverage["case_local_evidence_descriptor_in_generation"])
            self.assertFalse(coverage["case_local_evidence_loaded"])
            self.assertEqual(coverage["case_local_evidence_source"], "captured_generation_member")
            self.assertNotEqual(coverage["case_local_evidence_artifact_binding_status"], "pass")
            self.assertIsNone(coverage["case_local_evidence_sha256"])
            self.assertTrue(
                any("captured scientific receipt could not be read" in reason for reason in result["reasons"])
            )
            self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_numeric_only_frequency_source_is_recorded_as_non_analytic(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = Path(directory) / "c0"
            manifest = {
                "schema_version": "frequency_domain_manifest.v1",
                "validation": {
                    "dispersion_frequency_source": "numeric_modal_solver",
                    "dispersion_reference_model": None,
                },
            }
            payload_overrides = {
                "frequency_domain/manifest.v1.json": json.dumps(manifest).encode("utf-8"),
                "eigen/diagnostics/solver.v1.json": json.dumps(
                    {"solver_model": "slepc_multi_shift_invert_production_cpu_dense"}
                ).encode("utf-8"),
            }
            install_v2_case(case_dir, payload_overrides=payload_overrides)
            reader = benchmark.ArtifactBundleReader(case_dir)
            artifact_result = benchmark._validate_case_artifacts(
                case_dir, "c0", bundle_reader=reader
            )

            benchmark._write_scientific_evidence(
                case_dir, "c0", artifact_result, bundle_reader=reader
            )

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
            shared_readers = []

            def resolver_with_captured_metadata(_output_root, _case, _model_sha, *, metadata_bytes_loader):
                case_dir = output_dir / "c0"
                case_dir.mkdir(parents=True, exist_ok=True)
                (case_dir / "metadata.json").write_bytes(b"{}")
                metadata_bytes_loader(case_dir)
                return case_dir, {"fixture_only": True}

            def validate_artifacts(case_dir, case, *, bundle_reader):
                shared_readers.append(("primary", bundle_reader))
                return {"case": case}

            def write_scientific_evidence(
                case_dir, case, artifact_result, scientific_evidence_root=None, *, bundle_reader
            ):
                shared_readers.append(("receipt", bundle_reader))

            def validate_scientific_case(
                case_dir, case, *, parameters_path, kpath_path=None, bundle_reader
            ):
                shared_readers.append(("scientific", bundle_reader))
                return failed_gate

            with patch.object(
                benchmark.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0),
            ), patch.object(
                benchmark,
                "resolve_runtime_artifact_root",
                side_effect=resolver_with_captured_metadata,
            ), patch.object(
                benchmark,
                "_validate_case_artifacts",
                side_effect=validate_artifacts,
            ), patch.object(
                benchmark,
                "validate_scientific_case",
                side_effect=validate_scientific_case,
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
                side_effect=write_scientific_evidence,
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
            self.assertEqual([name for name, _ in shared_readers], ["primary", "receipt", "scientific"])
            self.assertIs(shared_readers[0][1], shared_readers[1][1])
            self.assertIs(shared_readers[1][1], shared_readers[2][1])

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
