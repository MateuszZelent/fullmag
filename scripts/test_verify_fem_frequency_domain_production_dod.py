from __future__ import annotations

import hashlib
import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from verify_fem_frequency_domain_production_dod import (  # noqa: E402
    ALL_DOD_IDS,
    ValidationError,
    canonical_json_bytes,
    scope_id_for,
    validate_artifact_sidecar,
    validate_production_record,
    validate_scope_catalog,
    validate_scope_binding,
)


def _sha(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode()).hexdigest()}"


def _write_verifier_proof(
    root: Path,
    scope: dict[str, object],
    binding: dict[str, object],
    catalog_digest: str,
) -> dict[str, object]:
    stdout = root / "verifier.stdout.log"
    stderr = root / "verifier.stderr.log"
    stdout.write_text("verifier: pass\n", encoding="utf-8")
    stderr.write_text("", encoding="utf-8")
    for artifact in (stdout, stderr):
        sidecar = artifact.with_name(artifact.name + ".validation_manifest.v1.json")
        sidecar.write_text(
            json.dumps(
                {
                    "schema": "validation_artifact_manifest.v1",
                    "artifact_kind": "text",
                    "artifact_schema": "verifier_log.v1",
                    "artifact_uri": artifact.name,
                    "artifact_sha256": "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest(),
                    "verified_coverage_of": binding,
                }
            ),
            encoding="utf-8",
        )
    scope_id = scope_id_for(scope)
    return {
        "id": "fixture.verifier",
        "version": "v1",
        "result": "pass",
        "command": ["python3", "fixture-verifier.py", "--scope", scope_id],
        "exit_code": 0,
        "stdout_path": stdout.name,
        "stdout_sha256": "sha256:" + hashlib.sha256(stdout.read_bytes()).hexdigest(),
        "stderr_path": stderr.name,
        "stderr_sha256": "sha256:" + hashlib.sha256(stderr.read_bytes()).hexdigest(),
        "executed_at": "2026-08-05T12:00:00Z",
        "scope_id": scope_id,
        "scope_catalog_sha256": catalog_digest,
        "runtime_fullmag_commit": scope["runtime_scope"]["fullmag_commit"],
        "runtime_build_id": scope["runtime_scope"]["build_id"],
    }


def valid_scope() -> dict[str, object]:
    interval = {"minimum": 0.0, "maximum": 1.0, "unit": "dimensionless"}
    identity = {"id": "fixture:k0:uniform", "version": "v1", "sha256": "sha256:" + "1" * 64}
    scope: dict[str, object] = {
        "schema": "frequency_domain_validation_scope.v1",
        "study_product": "modal_eigen",
        "discretization": "fem",
        "physics_scope": {
            "equation_set": "linearized_llg_dynamic_demag_v1",
            "phasor_convention": "exp_minus_i_omega_t",
            "dynamic_field_convention": "delta_m_cartesian_and_delta_h_demag",
            "equilibrium_class": "uniform",
            "included_interactions": ["demag", "exchange"],
            "excluded_interactions": ["dmi"],
            "damping_policy": "alpha_zero",
            "nonconservative_policy": "none",
        },
        "problem_scope": {
            "mode_scope": {
                "kind": "modal",
                "branch_policy": "positive_frequency",
                "class_ids": ["k0_uniform"],
                "requested_count": {"minimum": 1, "maximum": 4},
                "spectral_window_rad_per_s": {
                    "minimum": 1.0,
                    "maximum": 2.0,
                    "unit": "rad_per_s",
                },
                "multiplicity_policy": "cluster",
                "tracking_policy": "overlap_hungarian",
                "response_observable_ids": [],
                "drive_scope": "not_applicable",
            },
            "k_scope": {"kind": "k0", "gamma_tolerance_rad_per_m": 1.0e-9},
            "dynamic_demag_scope": "periodic_airbox_k0",
            "equilibrium_scope": {
                "acceptance_policy": "accepted_equilibrium_v6",
                "torque_tolerance": 1.0e-8,
                "norm_tolerance": 1.0e-8,
                "artifact_policy": "required",
                "signature_policy": "exact_solve_signature",
            },
            "boundary_scope": {
                "magnetic_bc": "periodic_xy_open_z",
                "periodic_directions": ["x", "y"],
                "pairing_policy": "certificate_v6",
                "open_directions": ["z"],
                "scalar_outer_bc": "robin",
                "robin_beta_per_m": {"minimum": 1.0, "maximum": 1.0, "unit": "per_m"},
            },
            "gauge_scope": {
                "policy": "none",
                "augmentation": "not_applicable",
                "nullspace_tolerance": 1.0e-10,
                "constraint_tolerance": 1.0e-10,
            },
            "fe_scope": {
                "magnetic_space": "h1_tangent",
                "magnetic_order": 1,
                "scalar_space": "h1_scalar",
                "scalar_order": 1,
                "quadrature_rule": "mfem_default_exactness_2",
                "mesh_quality": interval,
                "refinement_policy": "uniform",
            },
            "problem_size_scope": {
                "magnetic_dofs": {"minimum": 1, "maximum": 1000},
                "scalar_dofs": {"minimum": 1, "maximum": 1000},
                "total_dofs": {"minimum": 2, "maximum": 2000},
                "largest_memory_bytes": 1_000_000,
                "largest_runtime_seconds": 60.0,
            },
            "operator_scope": {
                "included_terms": ["dynamic_demag", "tangent_llg"],
                "excluded_terms": ["damping"],
                "assembly_kind": "mfem_weak_form_shared_domain",
                "scalar_representation": "real_frequency_rotated",
            },
            "damping_scope": {
                "alpha": interval,
                "nonnormal_policy": "excluded",
            },
        },
        "solver_scope": {
            "engine": "k0_poisson_airbox_cpu_schur_slepc",
            "rtol": 1.0e-10,
            "max_iterations": 100,
            "restart": 20,
            "linear_solver_family": "petsc_ksp",
            "preconditioner": {
                "family": "hypre",
                "variant": "boomeramg",
                "setup_policy": "once_per_operator",
                "reuse_policy": "exact_signature",
            },
            "spectral_transform": {"family": "real_frequency_rotated", "shift_rad_per_s": 1.0},
            "target_representation": {
                "family": "shift_invert",
                "target_rad_per_s": 1.0,
                "window_rad_per_s": {"minimum": 1.0, "maximum": 2.0, "unit": "rad_per_s"},
                "sweep_hz": [],
            },
            "device_residency": {
                "operator": "host",
                "krylov_vectors": "host",
                "basis": "host",
                "preconditioner": "host",
                "per_iteration_h2d_max": 0,
                "per_iteration_d2h_max": 0,
                "hidden_host_solves_allowed": False,
            },
            "precision": "double",
            "block_residual_contract": {
                "operator_form": "original_unscaled",
                "norm": "l2",
                "required_blocks": ["gauge", "phi", "q"],
                "aggregation": "max",
                "denominator_policy": "mass_norm_floor",
                "absolute_scale_floor": 1.0e-30,
                "acceptance_tolerance": 1.0e-8,
            },
            "certificate_references": [
                {
                    "type": "periodic_mesh_certificate.v6",
                    "certificate_id": "cert:k0:mesh",
                    "artifact_uri": "validation/certificates/mesh.v6.json",
                    "sha256": "sha256:" + "2" * 64,
                }
            ],
            "fallback_policy": "strict_no_fallback",
            "accepted_stop_reasons": ["converged", "window_complete"],
        },
        "runtime_scope": {
            "fullmag_commit": "a" * 40,
            "build_id": "managed-fem-runtime-20260803",
            "native_abi": 6,
            "dependency_versions": [
                {"name": "petsc", "version": "3.24.6"},
                {"name": "slepc", "version": "3.24.3"},
            ],
            "managed_route": "container_just_managed_fem",
        },
        "device_scope": {
            "requested": "cpu",
            "resolved": "cpu",
            "family": "x86_64",
            "architecture": "host",
            "driver": "host",
            "runtime": "managed_container",
        },
        "material_scope": {
            "class_ids": ["material:uniform"],
            "region_policy": "fixture_regions",
            "parameter_bounds": [
                {"name": "anisotropy", "bounds": {"minimum": 0.0, "maximum": 1.0e6, "unit": "j_per_m3"}},
                {"name": "damping", "bounds": {"minimum": 0.0, "maximum": 0.0, "unit": "dimensionless"}},
                {"name": "exchange", "bounds": {"minimum": 1.0e-13, "maximum": 1.0e-11, "unit": "j_per_m"}},
                {"name": "gamma", "bounds": {"minimum": 1.0e5, "maximum": 3.0e5, "unit": "rad_per_s_per_t"}},
                {"name": "ms", "bounds": {"minimum": 1.0e5, "maximum": 2.0e6, "unit": "a_per_m"}},
                {"name": "temperature", "bounds": {"minimum": 0.0, "maximum": 0.0, "unit": "k"}},
            ],
        },
        "geometry_scope": {
            "family": "thin_film_periodic_airbox",
            "dimension_bounds": [
                {"name": "cell_x", "bounds": {"minimum": 1.0e-9, "maximum": 1.0e-5, "unit": "m"}},
                {"name": "cell_y", "bounds": {"minimum": 1.0e-9, "maximum": 1.0e-5, "unit": "m"}},
                {"name": "film_thickness", "bounds": {"minimum": 1.0e-9, "maximum": 1.0e-6, "unit": "m"}},
            ],
            "periodic_cell_policy": {"directions": ["x", "y"], "cell_id": "fixture:k0:cell"},
            "airbox_policy": {
                "kind": "open_z",
                "top_padding_m": {"minimum": 1.0e-9, "maximum": 1.0e-5, "unit": "m"},
                "bottom_padding_m": {"minimum": 1.0e-9, "maximum": 1.0e-5, "unit": "m"},
                "symmetry": "none",
            },
        },
        "fixture_ids": [identity],
        "oracle_ids": [{"id": "oracle:k0:cpu", "version": "v1", "sha256": "sha256:" + "3" * 64}],
    }
    return scope


def test_scope_catalog_accepts_canonical_direct_binding() -> None:
    scope = valid_scope()
    scope_id = scope_id_for(scope)
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {scope_id: scope},
    }
    catalog_digest = validate_scope_catalog(catalog)
    binding = {
        "schema": "validation_scope_binding.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "kind": "direct",
        "scope_id": scope_id,
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
    }
    validate_scope_binding(binding, catalog, "validation/scopes/scope_catalog.v1.json", catalog_digest)


def test_scope_catalog_rejects_scope_id_hash_mismatch() -> None:
    scope = valid_scope()
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {"sha256:" + "f" * 64: scope},
    }
    with pytest.raises(ValidationError, match="scope catalog entry key"):
        validate_scope_catalog(catalog)


def test_scope_catalog_rejects_k0_floquet_contradiction() -> None:
    scope = valid_scope()
    scope["problem_scope"]["dynamic_demag_scope"] = "floquet_airbox_nonzero_k"  # type: ignore[index]
    with pytest.raises(ValidationError, match="dynamic_demag_scope"):
        scope_id_for(scope)


def _coverage_catalog() -> tuple[dict[str, object], str, str, str]:
    subject = valid_scope()
    covered = deepcopy(subject)
    covered["problem_scope"]["mode_scope"]["requested_count"] = {"minimum": 2, "maximum": 3}  # type: ignore[index]
    covered["physics_scope"]["included_interactions"] = ["demag"]  # type: ignore[index]
    subject_id = scope_id_for(subject)
    covered_id = scope_id_for(covered)
    catalog: dict[str, object] = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {subject_id: subject, covered_id: covered},
    }
    catalog_digest = validate_scope_catalog(catalog)
    return catalog, subject_id, covered_id, catalog_digest


def _complete_coverage_predicates(
    subject: object,
    covered_id: str,
    *,
    restrictive: dict[str, str],
    path: str = "",
) -> list[dict[str, str]]:
    if isinstance(subject, dict) and set(subject) not in (
        {"minimum", "maximum"},
        {"minimum", "maximum", "unit"},
    ):
        predicates: list[dict[str, str]] = []
        for key in sorted(subject):
            predicates.extend(
                _complete_coverage_predicates(
                    subject[key],
                    covered_id,
                    restrictive=restrictive,
                    path=f"{path}/{key}",
                )
            )
        return predicates
    return [
        {
            "covered_scope_id": covered_id,
            "field_path": path,
            "comparator": restrictive.get(path, "equal"),
        }
    ]


def test_coverage_binding_evaluates_subset_direction() -> None:
    catalog, subject_id, covered_id, catalog_digest = _coverage_catalog()
    subject = catalog["scopes"][subject_id]  # type: ignore[index]
    binding = {
        "schema": "validation_scope_binding.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "kind": "coverage",
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
        "coverage_rule": {
            "schema": "coverage_rule.v1",
            "relation": "subset",
            "subject_scope_id": subject_id,
            "covered_scope_ids": [covered_id],
            "field_predicates": _complete_coverage_predicates(
                subject,
                covered_id,
                restrictive={
                    "/physics_scope/included_interactions": "set_subset",
                    "/problem_scope/mode_scope/requested_count": "interval_subset",
                },
            ),
        },
    }
    validate_scope_binding(
        binding,
        catalog,
        "validation/scopes/scope_catalog.v1.json",
        catalog_digest,
    )


def test_coverage_binding_rejects_widened_interval() -> None:
    catalog, subject_id, covered_id, catalog_digest = _coverage_catalog()
    covered_scope = catalog["scopes"].pop(covered_id)  # type: ignore[index]
    covered_scope["problem_scope"]["mode_scope"]["requested_count"] = {  # type: ignore[index]
        "minimum": 0,
        "maximum": 5,
    }
    covered_id = scope_id_for(covered_scope)
    catalog["scopes"][covered_id] = covered_scope  # type: ignore[index]
    catalog_digest = validate_scope_catalog(catalog)
    subject = catalog["scopes"][subject_id]  # type: ignore[index]
    binding = {
        "schema": "validation_scope_binding.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "kind": "coverage",
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
        "coverage_rule": {
            "schema": "coverage_rule.v1",
            "relation": "subset",
            "subject_scope_id": subject_id,
            "covered_scope_ids": [covered_id],
            "field_predicates": _complete_coverage_predicates(
                subject,
                covered_id,
                restrictive={
                    "/physics_scope/included_interactions": "set_subset",
                    "/problem_scope/mode_scope/requested_count": "interval_subset",
                },
            ),
        },
    }
    with pytest.raises(ValidationError, match="not contained"):
        validate_scope_binding(
            binding,
            catalog,
            "validation/scopes/scope_catalog.v1.json",
            catalog_digest,
        )


def test_coverage_binding_rejects_omitted_comparison_address() -> None:
    catalog, subject_id, covered_id, catalog_digest = _coverage_catalog()
    binding = {
        "schema": "validation_scope_binding.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "kind": "coverage",
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
        "coverage_rule": {
            "schema": "coverage_rule.v1",
            "relation": "subset",
            "subject_scope_id": subject_id,
            "covered_scope_ids": [covered_id],
            "field_predicates": [
                {
                    "covered_scope_id": covered_id,
                    "field_path": "/physics_scope/included_interactions",
                    "comparator": "set_subset",
                },
                {
                    "covered_scope_id": covered_id,
                    "field_path": "/problem_scope/mode_scope/requested_count",
                    "comparator": "interval_subset",
                },
            ],
        },
    }
    with pytest.raises(ValidationError, match="comparison addresses"):
        validate_scope_binding(
            binding,
            catalog,
            "validation/scopes/scope_catalog.v1.json",
            catalog_digest,
        )


def test_file_sidecar_is_required_and_hash_bound(tmp_path: Path) -> None:
    artifact = tmp_path / "points.v2.csv"
    artifact.write_text("sample_index,frequency_hz\n0,1.0\n", encoding="utf-8")
    with pytest.raises(ValidationError, match="sidecar"):
        validate_artifact_sidecar(artifact, tmp_path / "validation_manifest.v1.json", {}, {}, "", "")


def test_file_sidecar_accepts_bound_csv(tmp_path: Path) -> None:
    artifact = tmp_path / "points.v2.csv"
    artifact.write_text("sample_index,frequency_hz\n0,1.0\n", encoding="utf-8")
    scope = valid_scope()
    scope_id = scope_id_for(scope)
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {scope_id: scope},
    }
    catalog_digest = validate_scope_catalog(catalog)
    binding = {
        "schema": "validation_scope_binding.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "kind": "direct",
        "scope_id": scope_id,
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
    }
    sidecar = {
        "schema": "validation_artifact_manifest.v1",
        "artifact_kind": "csv",
        "artifact_schema": "k0_points.v2",
        "artifact_uri": "points.v2.csv",
        "artifact_sha256": "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest(),
        "verified_coverage_of": binding,
    }
    sidecar_path = tmp_path / "points.v2.csv.validation_manifest.v1.json"
    sidecar_path.write_text(json.dumps(sidecar), encoding="utf-8")
    validate_artifact_sidecar(
        artifact,
        sidecar_path,
        sidecar,
        catalog,
        "validation/scopes/scope_catalog.v1.json",
        catalog_digest,
    )


def test_production_record_is_blocked_until_all_gates_pass(tmp_path: Path) -> None:
    scope = valid_scope()
    scope_id = scope_id_for(scope)
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {scope_id: scope},
    }
    catalog_path = tmp_path / "validation" / "scopes" / "scope_catalog.v1.json"
    catalog_path.parent.mkdir(parents=True)
    catalog_path.write_bytes(canonical_json_bytes(catalog))
    catalog_digest = validate_scope_catalog(catalog)
    record = {
        "schema": "frequency_domain_production_dod.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scope_id": scope_id,
        "validated_scope": scope,
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
        "implementation_state": "executable",
        "validation_state_before_promotion": "physics_validated",
        "items": {f"DOD-{index:02d}": "fail" for index in range(1, 15)},
        "item_evidence": {f"DOD-{index:02d}": {} for index in range(1, 15)},
        "not_applicable_reasons": {},
        "open_blockers": ["missing managed release evidence"],
        "promotion_decision": "blocked",
    }
    validate_production_record(record, tmp_path)
    catalog_path.write_text(json.dumps(catalog, indent=2), encoding="utf-8")
    with pytest.raises(ValidationError, match="canonical JSON serialization"):
        validate_production_record(record, tmp_path)
    catalog_path.write_bytes(canonical_json_bytes(catalog))
    record["promotion_decision"] = "production_qualified"
    with pytest.raises(ValidationError, match="promotion_decision"):
        validate_production_record(record, tmp_path)


def test_production_record_rejects_pass_without_bound_evidence(tmp_path: Path) -> None:
    scope = valid_scope()
    scope_id = scope_id_for(scope)
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {scope_id: scope},
    }
    catalog_path = tmp_path / "validation" / "scopes" / "scope_catalog.v1.json"
    catalog_path.parent.mkdir(parents=True)
    catalog_path.write_bytes(canonical_json_bytes(catalog))
    catalog_digest = validate_scope_catalog(catalog)
    record = {
        "schema": "frequency_domain_production_dod.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scope_id": scope_id,
        "validated_scope": scope,
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
        "implementation_state": "executable",
        "validation_state_before_promotion": "physics_validated",
        "items": {f"DOD-{index:02d}": "fail" for index in range(1, 15)},
        "item_evidence": {f"DOD-{index:02d}": {} for index in range(1, 15)},
        "not_applicable_reasons": {},
        "open_blockers": ["missing evidence"],
        "promotion_decision": "blocked",
    }
    record["items"]["DOD-01"] = "pass"  # type: ignore[index]
    with pytest.raises(ValidationError, match="DOD-01.*evidence"):
        validate_production_record(record, tmp_path)


def test_production_record_rejects_not_applicable_without_scope_reason(tmp_path: Path) -> None:
    scope = valid_scope()
    scope_id = scope_id_for(scope)
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {scope_id: scope},
    }
    catalog_path = tmp_path / "validation" / "scopes" / "scope_catalog.v1.json"
    catalog_path.parent.mkdir(parents=True)
    catalog_path.write_bytes(canonical_json_bytes(catalog))
    catalog_digest = validate_scope_catalog(catalog)
    record = {
        "schema": "frequency_domain_production_dod.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scope_id": scope_id,
        "validated_scope": scope,
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
        "implementation_state": "executable",
        "validation_state_before_promotion": "physics_validated",
        "items": {f"DOD-{index:02d}": "not_applicable" for index in range(1, 15)},
        "item_evidence": {f"DOD-{index:02d}": {} for index in range(1, 15)},
        "not_applicable_reasons": {},
        "open_blockers": ["scope excludes all gates"],
        "promotion_decision": "blocked",
    }
    with pytest.raises(ValidationError, match="not_applicable_reasons.*DOD-01"):
        validate_production_record(record, tmp_path)


def test_production_record_accepts_a_bound_pass_item(tmp_path: Path) -> None:
    scope = valid_scope()
    scope_id = scope_id_for(scope)
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {scope_id: scope},
    }
    catalog_path = tmp_path / "validation" / "scopes" / "scope_catalog.v1.json"
    catalog_path.parent.mkdir(parents=True)
    catalog_path.write_bytes(canonical_json_bytes(catalog))
    catalog_digest = validate_scope_catalog(catalog)
    binding = {
        "schema": "validation_scope_binding.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "kind": "direct",
        "scope_id": scope_id,
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
    }
    verifier = _write_verifier_proof(tmp_path, scope, binding, catalog_digest)
    evidence_path = tmp_path / "physics.json"
    evidence = {"verified_coverage_of": binding, "result": "pass"}
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    evidence_sha = "sha256:" + hashlib.sha256(evidence_path.read_bytes()).hexdigest()
    record = {
        "schema": "frequency_domain_production_dod.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scope_id": scope_id,
        "validated_scope": scope,
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
        "implementation_state": "executable",
        "validation_state_before_promotion": "physics_validated",
        "items": {f"DOD-{index:02d}": "fail" for index in range(1, 15)},
        "item_evidence": {f"DOD-{index:02d}": {} for index in range(1, 15)},
        "not_applicable_reasons": {},
        "open_blockers": ["remaining gates"],
        "promotion_decision": "blocked",
    }
    record["items"]["DOD-01"] = "pass"  # type: ignore[index]
    record["item_evidence"]["DOD-01"] = {  # type: ignore[index]
        "gate_id": "DOD-01",
        "verified_coverage_of": binding,
        "evidence": [
            {
                "path": "physics.json",
                "sha256": evidence_sha,
                "sidecar_path": None,
                "sidecar_sha256": None,
            }
        ],
        "fixture_ids": [],
        "oracle_ids": [],
        "metrics": {"relative_error": 0.0},
        "tolerances": {"relative_error": 1.0e-12},
        "verifier": verifier,
        "implementation_state": "executable",
        "validation_state_before_promotion": "physics_validated",
        "open_blockers": [],
    }
    validate_production_record(record, tmp_path)
    verifier["stdout_sha256"] = _sha("tampered")
    with pytest.raises(ValidationError, match="stdout_sha256"):
        validate_production_record(record, tmp_path)


def test_production_record_rejects_pass_bound_to_a_different_scope(tmp_path: Path) -> None:
    scope = valid_scope()
    other_scope = deepcopy(scope)
    other_scope["problem_scope"]["mode_scope"]["requested_count"] = {  # type: ignore[index]
        "minimum": 1,
        "maximum": 2,
    }
    scope_id = scope_id_for(scope)
    other_scope_id = scope_id_for(other_scope)
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {scope_id: scope, other_scope_id: other_scope},
    }
    catalog_path = tmp_path / "validation" / "scopes" / "scope_catalog.v1.json"
    catalog_path.parent.mkdir(parents=True)
    catalog_path.write_bytes(canonical_json_bytes(catalog))
    catalog_digest = validate_scope_catalog(catalog)
    wrong_binding = {
        "schema": "validation_scope_binding.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "kind": "direct",
        "scope_id": other_scope_id,
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
    }
    evidence_path = tmp_path / "physics.json"
    evidence_path.write_text(
        json.dumps({"verified_coverage_of": wrong_binding, "result": "pass"}),
        encoding="utf-8",
    )
    record = {
        "schema": "frequency_domain_production_dod.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scope_id": scope_id,
        "validated_scope": scope,
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
        "implementation_state": "executable",
        "validation_state_before_promotion": "physics_validated",
        "items": {gate_id: "fail" for gate_id in ALL_DOD_IDS},
        "item_evidence": {gate_id: {} for gate_id in ALL_DOD_IDS},
        "not_applicable_reasons": {},
        "open_blockers": ["remaining gates"],
        "promotion_decision": "blocked",
    }
    record["items"]["DOD-01"] = "pass"
    record["item_evidence"]["DOD-01"] = {
        "gate_id": "DOD-01",
        "verified_coverage_of": wrong_binding,
        "evidence": [
            {
                "path": "physics.json",
                "sha256": "sha256:" + hashlib.sha256(evidence_path.read_bytes()).hexdigest(),
                "sidecar_path": None,
                "sidecar_sha256": None,
            }
        ],
        "fixture_ids": [],
        "oracle_ids": [],
        "metrics": {},
        "tolerances": {},
        "verifier": {"id": "fixture.verifier", "version": "v1", "result": "pass"},
        "implementation_state": "executable",
        "validation_state_before_promotion": "physics_validated",
        "open_blockers": [],
    }
    with pytest.raises(ValidationError, match="does not cover the production scope"):
        validate_production_record(record, tmp_path)


def test_production_record_rejects_arbitrary_not_applicable_gate(tmp_path: Path) -> None:
    scope = valid_scope()
    scope_id = scope_id_for(scope)
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {scope_id: scope},
    }
    catalog_path = tmp_path / "validation" / "scopes" / "scope_catalog.v1.json"
    catalog_path.parent.mkdir(parents=True)
    catalog_path.write_bytes(canonical_json_bytes(catalog))
    catalog_digest = validate_scope_catalog(catalog)
    record = {
        "schema": "frequency_domain_production_dod.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scope_id": scope_id,
        "validated_scope": scope,
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_digest,
        "implementation_state": "executable",
        "validation_state_before_promotion": "physics_validated",
        "items": {gate_id: "fail" for gate_id in ALL_DOD_IDS},
        "item_evidence": {gate_id: {} for gate_id in ALL_DOD_IDS},
        "not_applicable_reasons": {
            "DOD-12": "validated_scope.device=cpu excludes GPU"
        },
        "open_blockers": ["remaining gates"],
        "promotion_decision": "blocked",
    }
    record["items"]["DOD-12"] = "not_applicable"
    validate_production_record(record, tmp_path)

    record["items"]["DOD-12"] = "fail"
    record["items"]["DOD-01"] = "not_applicable"
    record["not_applicable_reasons"] = {"DOD-01": "scope excludes feature"}
    with pytest.raises(ValidationError, match="DOD-01.*applicable"):
        validate_production_record(record, tmp_path)
