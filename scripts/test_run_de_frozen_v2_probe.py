from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import mock_open, patch

CANDIDATE_ROOT = Path(__file__).resolve().parent
def _find_repo_root() -> Path:
    override = os.environ.get("FULLMAG_FROZEN_V2_TEST_REPO")
    if override:
        return Path(override).resolve(strict=True)
    for base in (Path.cwd().resolve(), Path(__file__).resolve()):
        for candidate in (base, *base.parents):
            if (candidate / "scripts" / "run_comsol_dispersion_benchmark.py").is_file():
                return candidate
    raise RuntimeError("run this interpreted test from the repository or set FULLMAG_FROZEN_V2_TEST_REPO")


REPO_ROOT = _find_repo_root()
for import_root in (REPO_ROOT / "scripts", CANDIDATE_ROOT):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

def _load_candidate_module(name: str):
    path = CANDIDATE_ROOT / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load candidate module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


validator = _load_candidate_module("validate_de_frozen_v2_probe")
driver = _load_candidate_module("run_de_frozen_v2_probe")
from test_fem_linearization_identity_replay import fixture as identity_fixture
from test_validate_parallel_execution_report import _adaptive_report
import test_verify_fem_frequency_domain_eigen_artifacts as native_eq_fixture


def _receipt_pair(tmp: Path):
    case_dir = tmp / "case"
    case_dir.mkdir()
    request = {
        "schema_version": driver.REQUEST_SCHEMA,
        "status": "prepared",
        "mode": "serial",
        "mode_policy": {"mode": "serial", "sampling": "signed-fifteen"},
        "job": {"job_id": "a" * 32, "source_digest": "b" * 64},
        "source": {"resolved_commit": "c" * 40},
        "bundle": {
            "manifest_sha256": "d" * 64,
            "file_table_sha256": "e" * 64,
            "selected_equilibrium_raw_sha256": "f" * 64,
            "selected_equilibrium_native_content_sha256": "sha256:" + "1" * 64,
            "source_mesh_topology_sha256": "sha256:" + "2" * 64,
            "modal_mesh_topology_fingerprint_v3": "sha256:" + "3" * 64,
            "container_input_root": "/workspace/benchmark-input",
            "selected_equilibrium_bundle_path": "equilibrium/accepted.v7.json",
        },
        "model": {"derived_script_sha256": "4" * 64},
        "numerics": {
            "frequency_window_hz": [8.5e9, 16.0e9],
            "eps_prefilter": "1e-9",
            "shifted_ksp_rtol": "1e-9",
            "gmres_restart": "8",
            "shifted_ksp_type": "fgmres",
        },
        "consumer_hashes": {},
    }
    request_path = tmp / "run-request.json"
    request_raw = json.dumps(request, sort_keys=True, separators=(",", ":")).encode() + b"\n"
    request_path.write_bytes(request_raw)
    result = {
        "schema_version": driver.RESULT_SCHEMA,
        "status": "completed_unqualified",
        "qualification": "NOT VERIFIED",
        "return_code": 0,
        "request_sha256": hashlib.sha256(request_raw).hexdigest(),
        "mode": request["mode"],
        "job": request["job"],
        "source": request["source"],
        "bundle": request["bundle"],
        "model": request["model"],
        "numerics": request["numerics"],
        "mode_policy": request["mode_policy"],
        "artifacts": {
            "case_artifact_hashes": validator.collect_probe_artifact_hashes(case_dir),
            "native_validation": {"status": "pass"},
        },
    }
    result_path = tmp / "run-result.json"
    result_path.write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
    return case_dir, request_path, result_path, request, result


def _native_equilibrium_binding_fixture(tmp: Path):
    case_dir = tmp / "native-case"
    case_dir.mkdir()
    native_eq_fixture.write_eigen_fixture(case_dir)
    source_equilibrium = native_eq_fixture.attach_certified_equilibrium_v7(case_dir)
    bundle_path = tmp / "bundle"
    source_relative = "accepted/equilibrium.v7.json"
    source_path = bundle_path / source_relative
    source_path.parent.mkdir(parents=True)
    source_raw = json.dumps(source_equilibrium, sort_keys=True, separators=(",", ":")).encode("utf-8")
    source_path.write_bytes(source_raw)
    output_relative = "eigen/metadata/sample_0000/equilibrium_artifact.v7.json"
    output_path = case_dir / output_relative
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(source_raw)
    bundle = {
        "path": str(bundle_path),
        "selected_equilibrium_bundle_path": source_relative,
        "selected_equilibrium_raw_sha256": hashlib.sha256(source_raw).hexdigest(),
    }
    identity = {
        "sample_index": 0,
        "equilibrium_artifact_path": output_relative,
        "equilibrium_artifact_schema": source_equilibrium["schema_version"],
        "equilibrium_artifact_sha256": source_equilibrium["content_sha256"],
        "equilibrium_content_sha256": source_equilibrium["content_sha256"],
    }
    return case_dir, bundle, identity, source_equilibrium


class FrozenV2ManagedLaunchTests(unittest.TestCase):
    def test_artifact_growth_hits_streaming_cap_before_another_read(self):
        with tempfile.TemporaryDirectory() as name:
            artifact = Path(name) / "artifact.json"
            artifact.write_bytes(b"initial")
            info = artifact.stat()
            opened = mock_open(read_data=b"x" * 17)
            with patch.object(validator, "_MAX_ARTIFACT_BYTES", 16), \
                 patch.object(Path, "open", opened), \
                 patch.object(validator.os, "fstat", return_value=info):
                with self.assertRaisesRegex(validator.ProbeValidationError, "byte limit while hashing"):
                    validator._sha256_file(artifact)
            self.assertEqual(opened().read.call_count, 1)

    def test_nested_durable_pass_cannot_replace_missing_native_sample_binding(self):
        with tempfile.TemporaryDirectory() as name:
            tmp = Path(name)
            case, request_path, result_path, _, result = _receipt_pair(tmp)
            self.assertEqual(result["status"], "completed_unqualified")
            result["artifacts"]["native_validation"]["status"] = "pass"
            result_path.write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
            with patch.object(validator, "_validate_managed_runtime_identity", return_value={}):
                with self.assertRaisesRegex(validator.ProbeValidationError, "native.*sample 0"):
                    validator.validate_probe_artifacts(case, request_path, result_path)

    def test_exact_identity_preimage_and_consumer_build_source_bind(self):
        snapshot = "a" * 64
        commit = "b" * 40
        identity, sidecar = identity_fixture(
            sample_index=1,
            overrides={
                "consumer_source_snapshot_sha256": snapshot,
                "consumer_build_identity": {
                    "source_snapshot_sha256": snapshot,
                    "git_commit": commit,
                },
            },
        )
        identity_raw = json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        sidecar_raw = json.dumps(sidecar, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        replayed = validator.fem_linearization_identity_replay.replay_identity_preimage(
            identity_raw, sidecar_raw
        )
        self.assertEqual(replayed, identity["content_sha256"])
        binding = validator._validate_consumer_build_identity(
            identity,
            {"source_snapshot_sha256": snapshot, "head_commit_full": commit},
            1,
        )
        self.assertEqual(binding, {"source_snapshot_sha256": snapshot, "git_commit": commit})

    def test_immutable_physical_identity_excludes_mode_policy_and_full_identity_digest(self):
        identity, _ = identity_fixture(
            sample_index=1,
            overrides={
                "consumer_plan_snapshot_sha256": "sha256:" + "1" * 64,
                "recomputed_certificate_preimage_json": json.dumps({
                    "schema_version": "RecomputedFemLinearizationCertificate.v2",
                    "equilibrium_content_sha256": "sha256:" + "2" * 64,
                    "mesh_topology_sha256": "sha256:" + "3" * 64,
                }, sort_keys=True, separators=(",", ":")),
            },
        )
        physical = validator.immutable_physical_identity(identity, 1)
        self.assertNotIn("consumer_plan_snapshot_sha256", physical)
        self.assertNotIn("content_sha256", physical)
        self.assertIn("equilibrium_material_signature", physical)
        self.assertIn("recomputed_certificate_preimage_json", physical)
        other_mode = dict(identity)
        other_mode["consumer_plan_snapshot_sha256"] = "sha256:" + "4" * 64
        other_mode["content_sha256"] = "sha256:" + "5" * 64
        self.assertEqual(physical, validator.immutable_physical_identity(other_mode, 1))

    def test_certificate_preimage_cannot_hide_consumer_plan_from_cross_mode_projection(self):
        identity, _ = identity_fixture(
            sample_index=0,
            overrides={
                "recomputed_certificate_preimage_json": json.dumps({
                    "consumer_plan": {"mode": "adaptive"},
                }, sort_keys=True, separators=(",", ":")),
            },
        )
        with self.assertRaisesRegex(validator.ProbeValidationError, "consumer_plan"):
            validator.immutable_physical_identity(identity, 0)

    def test_request_and_result_cannot_rebind_native_consumer_identity(self):
        snapshot = "a" * 64
        commit = "b" * 40
        identity, _ = identity_fixture(
            sample_index=0,
            overrides={
                "consumer_source_snapshot_sha256": snapshot,
                "consumer_build_identity": {"source_snapshot_sha256": snapshot, "git_commit": commit},
            },
        )
        changed_request = {
            "source": {
                "source_snapshot_sha256": "c" * 64,
                "native_source_identity": {"source_snapshot_sha256": "c" * 64, "head_commit_full": "d" * 40},
            }
        }
        with self.assertRaisesRegex(validator.ProbeValidationError, "consumer build identity"):
            validator._validate_consumer_build_identity(
                identity, changed_request["source"]["native_source_identity"], 0
            )

    def test_linked_linearization_state_is_replayed_after_inventory_changes(self):
        with tempfile.TemporaryDirectory() as name:
            case = Path(name) / "case"
            state_dir = case / "eigen" / "metadata" / "sample_0000"
            state_dir.mkdir(parents=True)
            equilibrium_sha = "sha256:" + "1" * 64
            equilibrium = {
                "schema_version": "equilibrium_artifact.v7",
                "equilibrium_id": "equilibrium_artifact.v7:" + "1" * 64,
                "content_sha256": equilibrium_sha,
            }
            state = {
                "schema_version": "LinearizationState.v6",
                "accepted_for_frequency_operator": True,
                "source_equilibrium_artifact": equilibrium_sha,
                "source_equilibrium_id": equilibrium["equilibrium_id"],
            }
            state_sha = "sha256:" + validator.verify_fem_frequency_domain_eigen_artifacts.linearization_state_v7_digest(state).removeprefix("sha256:")
            state["content_sha256"] = state_sha
            state["linearization_state_id"] = "LinearizationState.v6:" + state_sha.removeprefix("sha256:")
            state_sha = validator.verify_fem_frequency_domain_eigen_artifacts.linearization_state_v7_digest(state)
            state["content_sha256"] = state_sha
            state_path = state_dir / "linearization_state.v6.json"
            state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")), encoding="utf-8")
            identity = {
                "linearization_state_schema": "LinearizationState.v6",
                "linearization_state_path": "eigen/metadata/sample_0000/linearization_state.v6.json",
                "linearization_state_sha256": state_sha,
            }
            validator.collect_probe_artifact_hashes(case)
            self.assertEqual(
                validator._validate_linked_linearization_state(case, identity, 0, equilibrium)["sha256"],
                state_sha,
            )
            state["accepted_for_frequency_operator"] = False
            state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")), encoding="utf-8")
            updated_inventory = validator.collect_probe_artifact_hashes(case)
            self.assertIn("eigen/metadata/sample_0000/linearization_state.v6.json", updated_inventory)
            with self.assertRaisesRegex(validator.ProbeValidationError, "LIN payload|LinearizationState validation"):
                validator._validate_linked_linearization_state(case, identity, 0, equilibrium)

    def test_native_equilibrium_uses_canonical_output_path_and_replays_source_and_sidecar(self):
        with tempfile.TemporaryDirectory() as name:
            case, bundle, identity, source = _native_equilibrium_binding_fixture(Path(name))
            output, binding = validator._validate_native_equilibrium_binding(
                case, identity, 0, bundle, source["content_sha256"]
            )
            self.assertEqual(output, source)
            self.assertEqual(binding["path"], "eigen/metadata/sample_0000/equilibrium_artifact.v7.json")
            self.assertEqual(binding["source_bundle_path"], bundle["selected_equilibrium_bundle_path"])
            self.assertEqual(binding["source_raw_sha256"], bundle["selected_equilibrium_raw_sha256"])
            self.assertEqual(binding["content_sha256"], source["content_sha256"])

    def test_native_equilibrium_rejects_container_input_path_as_output_identity(self):
        with tempfile.TemporaryDirectory() as name:
            case, bundle, identity, source = _native_equilibrium_binding_fixture(Path(name))
            identity["equilibrium_artifact_path"] = "/workspace/benchmark-input/accepted/equilibrium.v7.json"
            with self.assertRaisesRegex(validator.ProbeValidationError, "canonical output sidecar path"):
                validator._validate_native_equilibrium_binding(
                    case, identity, 0, bundle, source["content_sha256"]
                )

    def test_native_equilibrium_rejects_missing_output_sidecar(self):
        with tempfile.TemporaryDirectory() as name:
            case, bundle, identity, source = _native_equilibrium_binding_fixture(Path(name))
            (case / identity["equilibrium_artifact_path"]).unlink()
            with self.assertRaisesRegex(validator.ProbeValidationError, "equilibrium artifact path is missing"):
                validator._validate_native_equilibrium_binding(
                    case, identity, 0, bundle, source["content_sha256"]
                )

    def test_native_equilibrium_rejects_tampered_sidecar_even_with_updated_digest(self):
        with tempfile.TemporaryDirectory() as name:
            case, bundle, identity, source = _native_equilibrium_binding_fixture(Path(name))
            output_path = case / identity["equilibrium_artifact_path"]
            tampered = json.loads(output_path.read_text(encoding="utf-8"))
            tampered["producer_run_id"] = "run:tampered"
            digest = native_eq_fixture.equilibrium_artifact_v7_digest(tampered)
            tampered["content_sha256"] = digest
            tampered["equilibrium_id"] = "equilibrium_artifact.v7:" + digest.removeprefix("sha256:")
            output_path.write_text(json.dumps(tampered, sort_keys=True, separators=(",", ":")), encoding="utf-8")
            with self.assertRaisesRegex(validator.ProbeValidationError, "expected_content_sha256"):
                validator._validate_native_equilibrium_binding(
                    case, identity, 0, bundle, source["content_sha256"]
                )

    def test_native_equilibrium_rejects_source_bundle_bytes_changed_after_request(self):
        with tempfile.TemporaryDirectory() as name:
            case, bundle, identity, source = _native_equilibrium_binding_fixture(Path(name))
            source_path = Path(bundle["path"]) / bundle["selected_equilibrium_bundle_path"]
            source_path.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(validator.ProbeValidationError, "raw bytes differ from the request"):
                validator._validate_native_equilibrium_binding(
                    case, identity, 0, bundle, source["content_sha256"]
                )

    def test_missing_consumer_plan_replay_is_a_failed_gate(self):
        bindings = [
            {"sample_index": index, "consumer_plan_snapshot_sha256": "sha256:" + str(index + 1) * 64}
            for index in validator.EXPECTED_SAMPLE_INDICES
        ]
        positive = {
            "consumer_plan_replay": {
                "status": "consumer_plan_exact_bytes_replayed",
                "raw_sha256_by_sample": {
                    str(item["sample_index"]): item["consumer_plan_snapshot_sha256"]
                    for item in bindings
                },
            }
        }
        self.assertEqual(
            validator._validate_consumer_plan_replay(positive, bindings)["status"],
            "consumer_plan_exact_bytes_replayed",
        )
        missing = {"consumer_plan_replay": {"status": "NOT_VERIFIED", "reason": "exact consumer plan bytes absent"}}
        with self.assertRaisesRegex(validator.ProbeValidationError, "not exactly replayed"):
            validator._validate_consumer_plan_replay(missing, bindings)

    def test_artifact_tree_scan_propagates_unreadable_subdirectory(self):
        with tempfile.TemporaryDirectory() as name:
            case = Path(name) / "case"
            case.mkdir()

            def walk_with_permission_error(root, *, topdown, followlinks, onerror):
                onerror(PermissionError("permission denied for child directory"))
                yield str(root), [], []

            with patch.object(validator.os, "walk", side_effect=walk_with_permission_error):
                with self.assertRaisesRegex(validator.ProbeValidationError, "completely scan.*permission denied"):
                    validator.collect_probe_artifact_hashes(case)

    def test_current_native_files_are_rehashed_against_durable_result(self):
        with tempfile.TemporaryDirectory() as name:
            tmp = Path(name)
            case, request_path, result_path, _, result = _receipt_pair(tmp)
            native = case / "eigen" / "diagnostics" / "solver.v1.json"
            native.parent.mkdir(parents=True)
            native.write_text('{"schema_version":"frequency_domain_modal_solver_diagnostics.v1"}',
                              encoding="utf-8")
            result["artifacts"]["case_artifact_hashes"] = {
                "eigen/diagnostics/solver.v1.json": {
                    "size": native.stat().st_size,
                    "sha256": "0" * 64,
                }
            }
            result_path.write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
            with self.assertRaisesRegex(validator.ProbeValidationError, "artifact hash inventory mismatch"):
                validator.validate_probe_artifacts(case, request_path, result_path)

    def test_request_bytes_are_bound_to_result(self):
        with tempfile.TemporaryDirectory() as name:
            tmp = Path(name)
            case, request_path, result_path, _, result = _receipt_pair(tmp)
            request_path.write_text(request_path.read_text(encoding="utf-8") + " ", encoding="utf-8")
            with self.assertRaisesRegex(validator.ProbeValidationError, "request_sha256"):
                validator.validate_probe_artifacts(case, request_path, result_path)

    def test_command_uses_readonly_bundle_and_derived_source_and_preserves_timeout(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            output = root / "output"
            output.mkdir()
            override = (
                "services:\n"
                "  fem-modal-cpu:\n"
                "    network_mode: none\n"
                "    volumes: !reset []\n"
                "    cpus: 4.0\n"
                "    mem_limit: 8g\n"
            )
            (output / "compose.benchmark.override.yaml").write_text(override, encoding="utf-8")
            storage_root = root / "canonical-storage"
            bundle = storage_root / "scientific-batches" / "accepted" / "campaign" / "bundle"
            bundle.mkdir(parents=True)
            model = root / "frozen-model.py"
            model.write_text("# frozen derived input\n", encoding="utf-8")
            prepared = SimpleNamespace(
                bundle_path=bundle,
                manifest_sha256="a" * 64,
                runtime_script_bytes=b"# frozen derived input\n",
                runtime_script_sha256=hashlib.sha256(b"# frozen derived input\n").hexdigest(),
                environment_for_mode=lambda mode: {
                    "FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ": "8.5",
                    "FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ": "16",
                    "FULLMAG_DE_SMOKE_MESH_LEVEL": "L2",
                    "FULLMAG_DE_SMOKE_THICKNESS_LAYERS": "3",
                    "FULLMAG_DE_SMOKE_SOLVER_RTOL": "1e-8",
                    "FULLMAG_DE_SMOKE_PARALLEL_MODE": mode,
                },
            )
            context = SimpleNamespace()
            values = {
                "eps_prefilter": "1e-9",
                "shifted_ksp_rtol": "1e-9",
                "gmres_restart": "8",
                "shifted_ksp_type": "fgmres",
                "frequency_min_ghz": "8.5",
                "frequency_max_ghz": "16",
                "mesh_level": "L2",
                "thickness_layers": "3",
            }

            def fake_compose(ctx, out, timeout_seconds, **kwargs):
                return [
                    "docker", "compose", "run", "--rm", "-v",
                    f"{out / 'model-input.py'}:/workspace/benchmark-model.py:ro",
                    "fem-modal-cpu", "timeout", str(timeout_seconds), "bash", "-lc",
                    "set -euo pipefail\ncase_dir=/workspace/benchmark-output/de-smoke-signed-fifteen\nmkdir \"$case_dir\"\n",
                ]

            numerics = {
                "frequency_window_hz": [8.5e9, 16e9],
                "eps_prefilter": "1e-9",
                "shifted_ksp_rtol": "1e-9",
                "gmres_restart": "8",
                "shifted_ksp_type": "fgmres",
                "model_metadata": {"through_thickness_elements": 3},
            }
            with patch.object(driver.pilot, "compose_command", side_effect=fake_compose) as called, \
                 patch.object(driver.adapter, "verify_bundle_for_launch", return_value={"runtime_script_sha256": prepared.runtime_script_sha256}) as verify:
                command = driver.compose_probe_command(
                    context, output, prepared, storage_root, model, "serial", numerics, timeout_seconds=37
                )
            self.assertIn(f"{model}:/workspace/benchmark-model.py:ro", command)
            self.assertIn(f"{bundle}:/workspace/benchmark-input:ro", command)
            self.assertNotIn(f"{output / 'model-input.py'}:/workspace/benchmark-model.py:ro", command)
            self.assertIn("resource allocation", command[-1])
            self.assertEqual(called.call_args.kwargs["timeout_seconds"], 37)
            self.assertEqual(called.call_args.kwargs["parallel_mode"], "serial")
            self.assertEqual(called.call_args.kwargs["pilot"], driver.pilot.SIGNED_FIFTEEN_PILOT)
            verify.assert_called_once_with(prepared, storage_root)

    def test_resource_evidence_requires_live_four_cpu_and_eight_gib_cgroup_values(self):
        with tempfile.TemporaryDirectory() as name:
            case = Path(name) / "case"
            path = case / "validation" / "resource_allocation.v1.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({
                "schema_version": driver.RESOURCE_SCHEMA,
                "status": "pass",
                "qualification": "NOT VERIFIED",
                "requested_cpu_cores": 4.0,
                "requested_memory_bytes": 8 * 1024**3,
                "effective_cpu_cores": 4.0,
                "memory_max_bytes": 8 * 1024**3,
                "allocation_sources": ["cgroup_v2_cpu_max", "cgroup_v2_memory_max"],
            }), encoding="utf-8")
            request = {"runtime": {"resource_allocation": {"cpu_cores": 4.0, "memory_bytes": 8 * 1024**3}}}
            self.assertEqual(validator._validate_resource_allocation(case, request)["status"], "pass")
            record = json.loads(path.read_text(encoding="utf-8"))
            record["effective_cpu_cores"] = 3.0
            path.write_text(json.dumps(record), encoding="utf-8")
            with self.assertRaisesRegex(validator.ProbeValidationError, "below four CPU"):
                validator._validate_resource_allocation(case, request)

    def test_embedded_resource_check_writes_parseable_json_record(self):
        shell = driver.RESOURCE_CHECK_SCRIPT
        prefix = "python3 - <<'PY'\n"
        self.assertTrue(shell.startswith(prefix))
        self.assertTrue(shell.endswith("\nPY"))
        source = shell[len(prefix):-len("\nPY")]
        ast.parse(source)

        written = {}

        class FakePath:
            def __init__(self, value):
                self.value = str(value)

            @property
            def parent(self):
                return FakePath(self.value.rsplit("/", 1)[0])

            def read_text(self, encoding=None):
                if self.value.endswith("cpu.max"):
                    return "400000 100000"
                if self.value.endswith("memory.max"):
                    return str(8 * 1024**3)
                raise AssertionError(f"unexpected resource probe path: {self.value}")

            def mkdir(self, parents=False, exist_ok=False):
                self.asserted_mkdir = (parents, exist_ok)

            def write_text(self, value, encoding=None):
                written[self.value] = value

        fake_os = SimpleNamespace(sched_getaffinity=lambda _pid: set(range(4)))
        with patch.object(pathlib, "Path", FakePath), patch.object(driver.os, "sched_getaffinity", fake_os.sched_getaffinity, create=True):
            exec(compile(source, "<managed-resource-check>", "exec"), {"__name__": "__main__", "math": math})
        record_path = "/workspace/benchmark-output/de-smoke-signed-fifteen/validation/resource_allocation.v1.json"
        self.assertEqual(written[record_path][-1], "\n")
        record = json.loads(written[record_path])
        self.assertEqual(record["status"], "pass")
        self.assertEqual(record["effective_cpu_cores"], 4.0)
        self.assertEqual(record["memory_max_bytes"], 8 * 1024**3)

    def test_adaptive_report_positive_fixture_exposes_real_counts_concurrency_and_resources(self):
        with tempfile.TemporaryDirectory() as name:
            case = Path(name) / "case"
            report_path = case / "eigen" / "parallel_execution.v1.json"
            report_path.parent.mkdir(parents=True)
            report = _adaptive_report()
            model_identity = {"kind": "versioned_standalone_input", "commit": "a" * 40, "sha256": "b" * 64}
            policy = driver.pilot.signed_fifteen_campaign_identity(model_identity, "adaptive")
            report_body = report["report"]
            report_body["policy"] = policy
            eq_sha = "sha256:" + "2" * 64
            for item in report_body["inputs"]:
                item["equilibrium_artifact_sha256"] = eq_sha
            report_path.write_text(json.dumps(report, sort_keys=True), encoding="utf-8")
            result = validator._validate_adaptive_report(
                case,
                {"mode": "adaptive", "mode_policy": policy},
                eq_sha,
            )
            self.assertEqual(result["sample_count"], 3)
            self.assertEqual(result["concurrency"]["status"], "observed_from_active_count")
            self.assertIn("resource_quality", result)

    def test_nonzero_exit_and_timeout_trigger_exact_owned_container_cleanup(self):
        with tempfile.TemporaryDirectory() as name:
            output = Path(name) / "output"
            output.mkdir()
            context = SimpleNamespace(layout={"repo_root": output.parent, "env": {}}, image_digest="sha256:test")
            mounts = [{"type": "bind", "source": str(output / "model.py"), "destination": "/workspace/benchmark-model.py", "read_only": True}]
            with patch.object(driver.subprocess, "run", return_value=SimpleNamespace(returncode=7)), \
                 patch.object(driver.managed, "_cleanup_benchmark_container", return_value={"status": "removed"}) as cleanup:
                result = driver._execute_compose(context, output, ["docker", "compose"], mounts, 37)
            self.assertEqual(result["return_code"], 7)
            cleanup.assert_called_once_with(context, output, extra_mounts=mounts)
            self.assertTrue((output / "compose.log").is_file())

        with tempfile.TemporaryDirectory() as name:
            output = Path(name) / "output"
            output.mkdir()
            context = SimpleNamespace(layout={"repo_root": output.parent, "env": {}}, image_digest="sha256:test")
            mounts = [{"type": "bind", "source": str(output / "model.py"), "destination": "/workspace/benchmark-model.py", "read_only": True}]
            with patch.object(driver.subprocess, "run", side_effect=subprocess.TimeoutExpired(["docker"], 10)), \
                 patch.object(driver.managed, "_cleanup_benchmark_container", return_value={"status": "verified_absent"}) as cleanup:
                result = driver._execute_compose(context, output, ["docker", "compose"], mounts, 10)
            self.assertTrue(result["timed_out"])
            self.assertEqual(result["cleanup"]["status"], "verified_absent")
            cleanup.assert_called_once_with(context, output, extra_mounts=mounts)


if __name__ == "__main__":
    unittest.main()
