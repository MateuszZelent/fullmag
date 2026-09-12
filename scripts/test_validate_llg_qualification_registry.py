from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


registry_validator = load_module(
    "validate_llg_qualification_registry",
    ROOT / "scripts" / "validate_llg_qualification_registry.py",
)
llg_validator = load_module(
    "validate_fem_llg_time_domain_qualification",
    ROOT / "scripts" / "validate_fem_llg_time_domain_qualification.py",
)
llg_compare = load_module(
    "compare_fem_llg_time_domain_qualification",
    ROOT / "scripts" / "compare_fem_llg_time_domain_qualification.py",
)


SOURCE_HASH = "a" * 64


def qualification_identity(**overrides: str) -> dict[str, str]:
    identity = {
        "capability_id": "llg_td_policy_v1",
        "qualification_id": "explicit_fixed_fem_cpu_double",
        "backend": "fem",
        "device": "cpu",
        "precision": "double",
        "integrator": "rk45",
        "timestep_policy": "fixed",
    }
    identity.update(overrides)
    return identity


def registry_entry(artifact: Path, **overrides: object) -> dict[str, object]:
    entry: dict[str, object] = {
        "key": qualification_identity(),
        "validation_state": "physics_validated",
        "artifact_path": artifact.relative_to(artifact.parents[1]).as_posix(),
        "artifact_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
        "runtime_source_inputs_sha256": SOURCE_HASH,
        "runtime_dirty": False,
        "runtime_dirty_patch_sha256": None,
        "validated_scope": {
            "fixtures": ["macrospin_constant_field", "exchange_eigenmode"],
            "energy_balance_kind": "undriven_dissipative",
            "energy_balance_validator": "undriven_dissipative_energy_balance.v1",
            "power_balance_observables_complete": True,
        },
        "validated_at": "2026-07-31T00:00:00Z",
        "validator_schema": "fullmag.llg_timestep_qualification.validator.v1",
        "completed_gates": ["algebra", "physics"],
        "reason": None,
    }
    entry.update(overrides)
    return entry


def registry(entry: dict[str, object]) -> dict[str, object]:
    return {
        "schema_version": "fullmag.llg_timestep_qualification_registry.v1",
        "entries": [entry],
    }


def write_artifact(tmp_path: Path) -> Path:
    artifact = tmp_path / "artifacts" / "qualification.json"
    artifact.parent.mkdir()
    artifact.write_text(
        json.dumps(
            {
                "schema_version": "fem_llg_time_domain_qualification.v1",
                "status": "pass",
                "backend": "fem",
                "device": "cpu",
                "precision": "fp64",
                "integrator": "rk45",
                "timestep_policies": ["adaptive", "fixed"],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return artifact


def test_accepts_valid_registry_and_resolves_exact_lane(tmp_path: Path) -> None:
    artifact = write_artifact(tmp_path)
    document = registry(registry_entry(artifact))
    registry_validator.validate_registry(document, tmp_path)
    assert registry_validator.resolve_validation_state(
        document, qualification_identity(), SOURCE_HASH, tmp_path
    ) == "physics_validated"


def test_missing_lane_resolves_unvalidated(tmp_path: Path) -> None:
    artifact = write_artifact(tmp_path)
    document = registry(registry_entry(artifact))
    assert registry_validator.resolve_validation_state(
        document,
        qualification_identity(
            device="gpu", qualification_id="explicit_fixed_fem_gpu_double"
        ),
        SOURCE_HASH,
        tmp_path,
    ) == "unvalidated"


def test_stale_runtime_source_hash_resolves_unvalidated(tmp_path: Path) -> None:
    artifact = write_artifact(tmp_path)
    document = registry(registry_entry(artifact))
    assert registry_validator.resolve_validation_state(
        document, qualification_identity(), "b" * 64, tmp_path
    ) == "unvalidated"


def test_unknown_validation_state_is_rejected(tmp_path: Path) -> None:
    artifact = write_artifact(tmp_path)
    document = registry(registry_entry(artifact, validation_state="looks_qualified"))
    with pytest.raises(registry_validator.RegistryError, match="validation_state"):
        registry_validator.validate_registry(document, tmp_path)


def test_artifact_hash_mismatch_is_rejected_and_resolves_unvalidated(
    tmp_path: Path,
) -> None:
    artifact = write_artifact(tmp_path)
    document = registry(registry_entry(artifact, artifact_sha256="f" * 64))
    with pytest.raises(registry_validator.RegistryError, match="artifact_sha256"):
        registry_validator.validate_registry(document, tmp_path)
    assert registry_validator.resolve_validation_state(
        document, qualification_identity(), SOURCE_HASH, tmp_path
    ) == "unvalidated"


def test_promoted_artifact_identity_must_match_registry_lane(tmp_path: Path) -> None:
    artifact = write_artifact(tmp_path)
    artifact.write_text(
        artifact.read_text(encoding="utf-8").replace('"device": "cpu"', '"device": "gpu"'),
        encoding="utf-8",
    )
    entry = registry_entry(artifact)
    entry["artifact_sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
    with pytest.raises(registry_validator.RegistryError, match="device does not match"):
        registry_validator.validate_registry(registry(entry), tmp_path)


def test_promoted_artifact_must_declare_the_registry_timestep_policy(tmp_path: Path) -> None:
    artifact = write_artifact(tmp_path)
    artifact.write_text(
        artifact.read_text(encoding="utf-8").replace('["adaptive", "fixed"]', '["adaptive"]'),
        encoding="utf-8",
    )
    entry = registry_entry(artifact)
    entry["artifact_sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
    with pytest.raises(registry_validator.RegistryError, match="timestep policy"):
        registry_validator.validate_registry(registry(entry), tmp_path)


def test_promoted_artifact_without_identity_schema_is_rejected(tmp_path: Path) -> None:
    artifact = write_artifact(tmp_path)
    artifact.write_text('{"status":"pass"}\n', encoding="utf-8")
    entry = registry_entry(artifact)
    entry["artifact_sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
    with pytest.raises(registry_validator.RegistryError, match="schema"):
        registry_validator.validate_registry(registry(entry), tmp_path)


def test_fem_single_precision_cannot_be_promoted(tmp_path: Path) -> None:
    artifact = write_artifact(tmp_path)
    document = registry(
        registry_entry(
            artifact,
            key=qualification_identity(
                precision="single",
                qualification_id="explicit_fixed_fem_gpu_single",
                device="gpu",
            ),
        )
    )
    with pytest.raises(registry_validator.RegistryError, match="single-precision FEM"):
        registry_validator.validate_registry(document, tmp_path)


def test_unknown_registry_entry_field_is_rejected(tmp_path: Path) -> None:
    artifact = write_artifact(tmp_path)
    entry = registry_entry(artifact)
    entry["unexpected"] = True
    with pytest.raises(registry_validator.RegistryError, match="exact registry fields"):
        registry_validator.validate_registry(registry(entry), tmp_path)


def test_qualification_id_must_match_lane(tmp_path: Path) -> None:
    artifact = write_artifact(tmp_path)
    entry = registry_entry(
        artifact,
        key=qualification_identity(
            qualification_id="explicit_fixed_fem_gpu_double",
        ),
    )
    with pytest.raises(registry_validator.RegistryError, match="does not match its lane"):
        registry_validator.validate_registry(registry(entry), tmp_path)


def test_unvalidated_entry_cannot_carry_promotion_metadata(tmp_path: Path) -> None:
    artifact = write_artifact(tmp_path)
    entry = registry_entry(
        artifact,
        validation_state="unvalidated",
        artifact_path=None,
        artifact_sha256=None,
        runtime_source_inputs_sha256=None,
        runtime_dirty=None,
        runtime_dirty_patch_sha256=None,
        validated_scope=None,
        validated_at=None,
        validator_schema=None,
        completed_gates=[],
        reason="not yet qualified",
    )
    entry["artifact_sha256"] = "a" * 64
    with pytest.raises(registry_validator.RegistryError, match="promotion metadata"):
        registry_validator.validate_registry(registry(entry), tmp_path)


def test_embedded_registry_covers_each_executable_lane() -> None:
    document = json.loads(
        (ROOT / "benchmarks" / "fem-llg" / "qualification-registry-v1.json").read_text(
            encoding="utf-8"
        )
    )
    registry_validator.validate_registry(document, ROOT)
    ids = {entry["key"]["qualification_id"] for entry in document["entries"]}
    assert ids == set(registry_validator.QUALIFICATION_LANES)


def test_externally_driven_artifact_rejects_monotonic_energy_validator() -> None:
    with pytest.raises(
        llg_validator.QualificationError, match="externally_driven_power_balance"
    ):
        llg_validator.validate_energy_balance(
            {
                "energy_balance_kind": "externally_driven",
                "energy_balance_validator": "undriven_dissipative_energy_balance.v1",
                "energy_delta_j": 1.0e-20,
                "source_work_j": 2.0e-20,
                "dissipated_energy_j": 1.0e-20,
                "energy_balance_residual_j": 0.0,
                "energy_balance_tolerance_j": 1.0e-25,
            }
        )


def test_qualification_artifact_requires_explicit_energy_balance_contract() -> None:
    with pytest.raises(llg_validator.QualificationError, match="energy_balance evidence"):
        llg_validator.validate(
            {
                "schema_version": "fem_llg_time_domain_qualification.v1",
                "status": "pass",
                "backend": "fem",
                "device": "cpu",
                "precision": "fp64",
            },
            "cpu",
        )


def test_cpu_gpu_parity_rejects_mismatched_energy_balance_contracts() -> None:
    cpu = {
        "energy_balance": {
            "energy_balance_kind": "undriven_dissipative",
            "energy_balance_validator": "undriven_dissipative_energy_balance.v1",
        }
    }
    gpu = {
        "energy_balance": {
            "energy_balance_kind": "externally_driven",
            "energy_balance_validator": "externally_driven_power_balance.v1",
        }
    }
    with pytest.raises(RuntimeError, match="energy balance contracts must match"):
        llg_compare.validate_parity_energy_contract(cpu, gpu)


def test_cpu_gpu_parity_compares_common_time_increment_not_relaxed_endpoint() -> None:
    cpu = {
        "relax_to_run": {
            "accepted_dt_s": 1.0e-15,
            "handoff_m": [0.0, 0.0, 1.0],
            "endpoint_m": [1.0e-4, 0.0, 1.0],
        }
    }
    gpu = {
        "relax_to_run": {
            "accepted_dt_s": 1.0e-15,
            "handoff_m": [0.2, 0.0, 0.98],
            "endpoint_m": [0.2001, 0.0, 0.98],
        }
    }
    assert (
        llg_compare.validate_relax_to_run_increment_parity(cpu, gpu)
        <= 5.0e-8
    )


def test_cpu_gpu_parity_rejects_common_time_increment_mismatch() -> None:
    cpu = {
        "relax_to_run": {
            "accepted_dt_s": 1.0e-15,
            "handoff_m": [0.0, 0.0, 1.0],
            "endpoint_m": [1.0e-4, 0.0, 1.0],
        }
    }
    gpu = {
        "relax_to_run": {
            "accepted_dt_s": 1.0e-15,
            "handoff_m": [0.2, 0.0, 0.98],
            "endpoint_m": [0.2002, 0.0, 0.98],
        }
    }
    with pytest.raises(RuntimeError, match="common-time increment parity budget"):
        llg_compare.validate_relax_to_run_increment_parity(cpu, gpu)


@pytest.mark.parametrize("kind", ["externally_driven", "spin_torque_driven"])
def test_driven_artifact_without_complete_power_balance_is_rejected(kind: str) -> None:
    validator = {
        "externally_driven": "externally_driven_power_balance.v1",
        "spin_torque_driven": "spin_torque_power_balance.v1",
    }[kind]
    with pytest.raises(llg_validator.QualificationError, match="source_work_j"):
        llg_validator.validate_energy_balance(
            {
                "energy_balance_kind": kind,
                "energy_balance_validator": validator,
                "energy_delta_j": 1.0e-20,
                "dissipated_energy_j": 1.0e-20,
                "energy_balance_residual_j": 0.0,
                "energy_balance_tolerance_j": 1.0e-25,
            }
        )
