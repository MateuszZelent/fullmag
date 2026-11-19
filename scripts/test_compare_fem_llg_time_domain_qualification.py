from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
COMPARATOR_PATH = ROOT / "scripts" / "compare_fem_llg_time_domain_qualification.py"


def load_comparator():
    spec = importlib.util.spec_from_file_location("fem_llg_comparator", COMPARATOR_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


comparator = load_comparator()
SOURCE_HASH = "a" * 64


def execution_receipt() -> dict[str, object]:
    mask = sum(comparator.GPU_OPERATOR_BITS.values())
    return {
        "schema_version": "fullmag.fem_gpu_execution_receipt.native_projection.v1",
        "native_abi_version": 1,
        "native_struct_size": 136,
        "rust_projection": "FemGpuExecutionReceipt.v1",
        "requested": "strict_device",
        "resolved": "device_resident",
        "executed": "cuda_fem",
        "execution_class": "device_resident",
        "device_ordinal": 0,
        "precision": "double",
        "integrator": "rk45",
        "required_operator_mask": mask,
        "resolved_device_operator_mask": mask,
        "resolved_host_operator_mask": 0,
        "resolved_unknown_operator_mask": 0,
        "executed_device_operator_mask": mask,
        "executed_host_operator_mask": 0,
        "executed_unknown_operator_mask": 0,
        "fallback_count": 0,
        "accepted_step_count": 1,
        "rejected_attempt_count": 0,
        "failed_attempt_count": 0,
        "hot_loop_compute_h2d_bytes": 0,
        "hot_loop_compute_d2h_bytes": 0,
        "hot_loop_compute_host_sync_count": 0,
        "accounting_valid": True,
        "operator_ids": list(comparator.GPU_OPERATOR_BITS),
    }


def qualification(device: str) -> dict[str, object]:
    document: dict[str, object] = {
        "schema_version": "fem_llg_time_domain_qualification.v1",
        "status": "pass",
        "backend": "fem",
        "device": device,
        "source_identity": {"source_snapshot_sha256": SOURCE_HASH},
        "precision": "fp64",
        "integrator": "rk45",
        "energy_balance": {
            "energy_balance_kind": "undriven_dissipative",
            "energy_balance_validator": "undriven_dissipative_energy_balance.v1",
        },
        "macrospin": [
            {"alpha": 0.1, "time_s": 1.0e-12, "m": [1.0, 0.0, 0.0]}
        ],
        "exchange_eigenmode": {
            "dt_study": [
                {
                    "dt_s": 1.0e-15,
                    "time_s": 1.0e-12,
                    "mode": [1.0, 0.0],
                }
            ]
        },
        "relax_to_run": {"endpoint_m": [1.0, 0.0, 0.0]},
    }
    if device == "gpu":
        document["qualification_mode"] = "strict"
        document["execution_receipt"] = execution_receipt()
    return document


def run_cli(
    tmp_path: Path,
    cpu: dict[str, object],
    gpu: dict[str, object],
) -> subprocess.CompletedProcess[str]:
    cpu_path = tmp_path / "cpu.json"
    gpu_path = tmp_path / "gpu.json"
    output_path = tmp_path / "parity.json"
    cpu_path.write_text(json.dumps(cpu), encoding="utf-8")
    gpu_path.write_text(json.dumps(gpu), encoding="utf-8")
    return subprocess.run(
        [
            sys.executable,
            str(COMPARATOR_PATH),
            "--cpu",
            str(cpu_path),
            "--gpu",
            str(gpu_path),
            "--output",
            str(output_path),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


class ComparatorBehaviorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="fem-llg-comparator-")
        self.tmp_path = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_cli_accepts_complete_versioned_receipt(self) -> None:
        result = run_cli(
            self.tmp_path, qualification("cpu"), qualification("gpu")
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        output = json.loads(
            (self.tmp_path / "parity.json").read_text(encoding="utf-8")
        )
        self.assertEqual(output["gpu_execution_receipt"], execution_receipt())

    def test_function_accepts_complete_versioned_receipt(self) -> None:
        gpu = qualification("gpu")
        self.assertEqual(
            comparator.validate_gpu_execution_receipt(gpu), execution_receipt()
        )

    def test_function_rejects_missing_or_unknown_top_level_schema_on_either_lane(
        self,
    ) -> None:
        for lane in ("cpu", "gpu"):
            for schema in (None, "unknown.qualification.v2"):
                with self.subTest(lane=lane, schema=schema):
                    document = qualification(lane)
                    if schema is None:
                        document.pop("schema_version")
                    else:
                        document["schema_version"] = schema
                    with self.assertRaisesRegex(
                        RuntimeError,
                        rf"{lane.upper()} qualification schema_version must equal "
                        r"fem_llg_time_domain_qualification\.v1",
                    ):
                        comparator.validate_qualification_document(
                            document, lane.upper()
                        )

    def test_cli_rejects_missing_or_unknown_top_level_schema_on_either_input(
        self,
    ) -> None:
        for lane in ("cpu", "gpu"):
            for schema in (None, "unknown.qualification.v2"):
                with self.subTest(lane=lane, schema=schema):
                    cpu = qualification("cpu")
                    gpu = qualification("gpu")
                    document = cpu if lane == "cpu" else gpu
                    if schema is None:
                        document.pop("schema_version")
                    else:
                        document["schema_version"] = schema
                    result = run_cli(self.tmp_path, cpu, gpu)
                    self.assertEqual(result.returncode, 1)
                    self.assertIn(
                        f"FAIL: {lane.upper()} qualification schema_version must equal "
                        "fem_llg_time_domain_qualification.v1",
                        result.stdout,
                    )

    def test_cli_rejects_missing_hybrid_incomplete_or_malformed_receipt(self) -> None:
        cases = [
            (
                lambda gpu: gpu.pop("execution_receipt"),
                "GPU qualification execution_receipt is required",
            ),
            (
                lambda gpu: gpu["execution_receipt"].__setitem__(
                    "execution_class", "hybrid_cpu_poisson"
                ),
                "hybrid execution cannot satisfy strict qualification",
            ),
            (
                lambda gpu: gpu["execution_receipt"]["operator_ids"].pop(),
                "GPU execution receipt operator_ids are incomplete",
            ),
            (
                lambda gpu: gpu["execution_receipt"].pop("schema_version"),
                "GPU execution receipt fields must match native projection v1",
            ),
            (
                lambda gpu: gpu["execution_receipt"].pop("accounting_valid"),
                "GPU execution receipt fields must match native projection v1",
            ),
            (
                lambda gpu: gpu["execution_receipt"].__setitem__("unexpected", 1),
                "GPU execution receipt fields must match native projection v1",
            ),
            (
                lambda gpu: gpu["execution_receipt"].__setitem__(
                    "accepted_step_count", True
                ),
                "GPU execution receipt counters and masks must be integers",
            ),
        ]
        for mutation, message in cases:
            with self.subTest(message=message):
                gpu = qualification("gpu")
                mutation(gpu)
                result = run_cli(self.tmp_path, qualification("cpu"), gpu)
                self.assertEqual(result.returncode, 1)
                self.assertIn(f"FAIL: {message}", result.stdout)

    def test_cli_rejects_source_snapshot_mismatch(self) -> None:
        gpu = qualification("gpu")
        gpu["source_identity"] = {"source_snapshot_sha256": "b" * 64}
        result = run_cli(self.tmp_path, qualification("cpu"), gpu)
        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "FAIL: CPU/GPU source snapshot hashes must match", result.stdout
        )

    def test_function_rejects_invalid_versioned_projection_semantics(self) -> None:
        cases = [
            ("schema_version", "unknown.v2", "unsupported GPU execution receipt schema"),
            ("native_abi_version", 2, "GPU execution receipt must use native ABI v1"),
            ("native_abi_version", True, "GPU execution receipt must use native ABI v1"),
            ("native_struct_size", 128, "GPU execution receipt must use native ABI v1"),
            ("native_struct_size", 136.0, "GPU execution receipt must use native ABI v1"),
            ("rust_projection", "OtherReceipt.v1", "unsupported Rust receipt projection"),
            ("requested", "auto", "GPU execution receipt requested mode must be strict_device"),
            ("resolved", "cpu", "GPU execution receipt resolution is not device_resident"),
            ("executed", "none", "GPU execution receipt did not execute cuda_fem"),
            ("device_ordinal", -1, "GPU execution receipt device_ordinal must be non-negative"),
            ("precision", "single", "GPU execution receipt precision must be double"),
            ("integrator", "heun", "GPU execution receipt integrator must match qualification"),
            ("accounting_valid", False, "GPU execution receipt accounting is invalid"),
            ("rejected_attempt_count", -1, "GPU execution receipt counters must be non-negative"),
            ("failed_attempt_count", -1, "GPU execution receipt counters must be non-negative"),
        ]
        for field, value, message in cases:
            with self.subTest(field=field):
                gpu = qualification("gpu")
                gpu["execution_receipt"][field] = value
                with self.assertRaisesRegex(RuntimeError, message):
                    comparator.validate_gpu_execution_receipt(gpu)


class NativeContractRecipeTests(unittest.TestCase):
    def test_semantic_checks_use_repo_python_before_native_configuration(self) -> None:
        recipes = (ROOT / "justfile").read_text(encoding="utf-8")
        recipe_start = recipes.index("verify-fem-time-domain-native-contract:")
        recipe_end = recipes.index("\nverify-fem-mesh-runner-abi-contract:", recipe_start)
        recipe = recipes[recipe_start:recipe_end]

        expected_steps = (
            "just ensure-python",
            'PYTHONDONTWRITEBYTECODE=1 "{{repo_python}}" scripts/check_llg_time_domain_contract_docs.py',
            'PYTHONDONTWRITEBYTECODE=1 "{{repo_python}}" scripts/test_compare_fem_llg_time_domain_qualification.py',
            "docker compose --profile fem-gpu run",
            "cmake -S native",
        )
        positions = [recipe.find(step) for step in expected_steps]
        self.assertNotIn(-1, positions)
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn("\n    python3 scripts/check_llg_time_domain_contract_docs.py", recipe)


if __name__ == "__main__":
    unittest.main()
