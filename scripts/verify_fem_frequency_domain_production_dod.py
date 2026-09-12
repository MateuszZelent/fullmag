#!/usr/bin/env python3
"""Fail-closed validation for the Chapter-24 frequency-domain promotion contract.

This module intentionally validates the immutable identity layer before any
metrics are consumed.  It is usable as a library by artifact validators and as
a small command-line gate for a production-DOD record.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9._:/+-]*$")
SHA256_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
SCHEMA = "frequency_domain_validation_scope.v1"
CATALOG_SCHEMA = "scope_catalog.v1"
BINDING_SCHEMA = "validation_scope_binding.v1"
SIDECAR_SCHEMA = "validation_artifact_manifest.v1"
PRODUCTION_DOD_SCHEMA = "frequency_domain_production_dod.v1"
ALL_DOD_IDS = tuple(f"DOD-{index:02d}" for index in range(1, 15))
VERIFIER_PROOF_KEYS = {
    "id",
    "version",
    "result",
    "command",
    "exit_code",
    "stdout_path",
    "stdout_sha256",
    "stderr_path",
    "stderr_sha256",
    "executed_at",
    "scope_id",
    "scope_catalog_sha256",
    "runtime_fullmag_commit",
    "runtime_build_id",
}
RFC3339_UTC = re.compile(
    r"^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$"
)
SET_COMPARISON_PATHS = frozenset(
    {
        "/physics_scope/included_interactions",
        "/physics_scope/excluded_interactions",
        "/problem_scope/mode_scope/class_ids",
        "/problem_scope/mode_scope/response_observable_ids",
        "/problem_scope/boundary_scope/periodic_directions",
        "/problem_scope/boundary_scope/open_directions",
        "/problem_scope/operator_scope/included_terms",
        "/problem_scope/operator_scope/excluded_terms",
        "/solver_scope/block_residual_contract/required_blocks",
        "/solver_scope/accepted_stop_reasons",
        "/material_scope/class_ids",
        "/geometry_scope/periodic_cell_policy/directions",
    }
)


class ValidationError(ValueError):
    """Raised when an immutable production identity or evidence contract is invalid."""


def _fail(path: str, message: str) -> None:
    raise ValidationError(f"{path}: {message}")


def _closed(value: Any, keys: set[str], path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    missing = sorted(keys.difference(value))
    extra = sorted(set(value).difference(keys))
    if missing:
        _fail(path, f"missing required fields {missing!r}")
    if extra:
        _fail(path, f"unknown fields {extra!r}")
    return value


def _string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value:
        _fail(path, "must be a non-empty string")
    return value


def _identifier(value: Any, path: str) -> str:
    result = _string(value, path)
    if IDENTIFIER.fullmatch(result) is None:
        _fail(path, "must match the Identifier grammar")
    return result


def _sha(value: Any, path: str) -> str:
    result = _string(value, path)
    if SHA256_ID.fullmatch(result) is None:
        _fail(path, "must be a lowercase sha256:<64 hex chars> token")
    return result


def _finite(value: Any, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "must be a finite JSON number")
    result = float(value)
    if not math.isfinite(result) or (result == 0.0 and math.copysign(1.0, result) < 0):
        _fail(path, "must be finite and not negative zero")
    return result


def _positive(value: Any, path: str) -> float:
    result = _finite(value, path)
    if result <= 0:
        _fail(path, "must be greater than zero")
    return result


def _nonnegative_int(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _fail(path, "must be a non-negative integer")
    return value


def _positive_int(value: Any, path: str) -> int:
    result = _nonnegative_int(value, path)
    if result < 1:
        _fail(path, "must be a positive integer")
    return result


def _enum(value: Any, allowed: set[str], path: str) -> str:
    result = _string(value, path)
    if result not in allowed:
        _fail(path, f"must be one of {sorted(allowed)!r}")
    return result


def _closed_interval(value: Any, path: str, *, positive: bool = False) -> None:
    item = _closed(value, {"minimum", "maximum", "unit"}, path)
    minimum = _positive(item["minimum"], f"{path}.minimum") if positive else _finite(item["minimum"], f"{path}.minimum")
    maximum = _positive(item["maximum"], f"{path}.maximum") if positive else _finite(item["maximum"], f"{path}.maximum")
    if minimum > maximum:
        _fail(path, "minimum must not exceed maximum")
    _identifier(item["unit"], f"{path}.unit")


def _integer_interval(value: Any, path: str) -> None:
    item = _closed(value, {"minimum", "maximum"}, path)
    minimum = _nonnegative_int(item["minimum"], f"{path}.minimum")
    maximum = _nonnegative_int(item["maximum"], f"{path}.maximum")
    if minimum > maximum:
        _fail(path, "minimum must not exceed maximum")


def _identifier_array(value: Any, path: str, *, allow_empty: bool = False) -> None:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        _fail(path, "must be an array of identifiers")
    if not allow_empty and not value:
        _fail(path, "must be non-empty")
    for index, item in enumerate(value):
        _identifier(item, f"{path}[{index}]")
    if len(value) != len(set(value)):
        _fail(path, "must not contain duplicates")
    if value != sorted(value):
        _fail(path, "must be sorted by UTF-8 byte order")


def _ordered_identifier_array(value: Any, path: str, *, allow_empty: bool = False) -> None:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        _fail(path, "must be an array of identifiers")
    if not allow_empty and not value:
        _fail(path, "must be non-empty")
    for index, item in enumerate(value):
        _identifier(item, f"{path}[{index}]")
    if len(value) != len(set(value)):
        _fail(path, "must not contain duplicates")


def _identity_ref(value: Any, path: str) -> None:
    item = _closed(value, {"id", "version", "sha256"}, path)
    _identifier(item["id"], f"{path}.id")
    _identifier(item["version"], f"{path}.version")
    _sha(item["sha256"], f"{path}.sha256")


def _identity_array(value: Any, path: str) -> None:
    if not isinstance(value, list) or not value:
        _fail(path, "must be a non-empty array")
    seen: set[tuple[str, str, str]] = set()
    for index, item in enumerate(value):
        _identity_ref(item, f"{path}[{index}]")
        ref = (item["id"], item["version"], item["sha256"])
        if ref in seen:
            _fail(path, "must not contain duplicate identity references")
        seen.add(ref)


def _parameter_bounds(value: Any, path: str) -> None:
    if not isinstance(value, list) or not value:
        _fail(path, "must be a non-empty array")
    names: list[str] = []
    for index, raw in enumerate(value):
        item = _closed(raw, {"name", "bounds"}, f"{path}[{index}]")
        name = _identifier(item["name"], f"{path}[{index}].name")
        _closed_interval(item["bounds"], f"{path}[{index}].bounds")
        names.append(name)
    if len(names) != len(set(names)):
        _fail(path, "parameter names must be unique")
    if names != sorted(names):
        _fail(path, "parameter bounds must be sorted by name")


def _dimension_bounds(value: Any, path: str) -> None:
    if not isinstance(value, list) or not value:
        _fail(path, "must be a non-empty array")
    names: list[str] = []
    for index, raw in enumerate(value):
        item = _closed(raw, {"name", "bounds"}, f"{path}[{index}]")
        names.append(_identifier(item["name"], f"{path}[{index}].name"))
        _closed_interval(item["bounds"], f"{path}[{index}].bounds")
    if len(names) != len(set(names)):
        _fail(path, "dimension names must be unique")
    if names != sorted(names):
        _fail(path, "dimension bounds must be sorted by name")


def _validate_certificate_references(value: Any, path: str) -> None:
    if not isinstance(value, list) or not value:
        _fail(path, "must be a non-empty array")
    seen: set[tuple[str, str, str, str]] = set()
    for index, raw in enumerate(value):
        item = _closed(raw, {"type", "certificate_id", "artifact_uri", "sha256"}, f"{path}[{index}]")
        key = (
            _identifier(item["type"], f"{path}[{index}].type"),
            _identifier(item["certificate_id"], f"{path}[{index}].certificate_id"),
            _string(item["artifact_uri"], f"{path}[{index}].artifact_uri"),
            _sha(item["sha256"], f"{path}[{index}].sha256"),
        )
        if key in seen:
            _fail(path, "certificate references must be unique")
        seen.add(key)


def validate_scope(scope: Any) -> dict[str, Any]:
    """Validate the closed Chapter-24 scope and return it unchanged."""
    root = _closed(
        scope,
        {
            "schema", "study_product", "discretization", "physics_scope", "problem_scope",
            "solver_scope", "runtime_scope", "device_scope", "material_scope", "geometry_scope",
            "fixture_ids", "oracle_ids",
        },
        "scope",
    )
    if root["schema"] != SCHEMA:
        _fail("scope.schema", f"must equal {SCHEMA!r}")
    _enum(root["study_product"], {"modal_eigen", "driven_response"}, "scope.study_product")
    if root["discretization"] != "fem":
        _fail("scope.discretization", "must equal 'fem'")

    physics = _closed(
        root["physics_scope"],
        {
            "equation_set", "phasor_convention", "dynamic_field_convention", "equilibrium_class",
            "included_interactions", "excluded_interactions", "damping_policy", "nonconservative_policy",
        },
        "scope.physics_scope",
    )
    for key in ("equation_set", "phasor_convention", "dynamic_field_convention", "damping_policy", "nonconservative_policy"):
        _identifier(physics[key], f"scope.physics_scope.{key}")
    _enum(physics["equilibrium_class"], {"uniform", "relaxed", "nonuniform"}, "scope.physics_scope.equilibrium_class")
    _identifier_array(physics["included_interactions"], "scope.physics_scope.included_interactions")
    _identifier_array(physics["excluded_interactions"], "scope.physics_scope.excluded_interactions", allow_empty=True)
    if set(physics["included_interactions"]) & set(physics["excluded_interactions"]):
        _fail("scope.physics_scope", "an interaction cannot be both included and excluded")

    problem = _closed(
        root["problem_scope"],
        {
            "mode_scope", "k_scope", "dynamic_demag_scope", "equilibrium_scope", "boundary_scope",
            "gauge_scope", "fe_scope", "problem_size_scope", "operator_scope", "damping_scope",
        },
        "scope.problem_scope",
    )
    mode = _closed(
        problem["mode_scope"],
        {
            "kind", "branch_policy", "class_ids", "requested_count", "spectral_window_rad_per_s",
            "multiplicity_policy", "tracking_policy", "response_observable_ids", "drive_scope",
        },
        "scope.problem_scope.mode_scope",
    )
    mode_kind = _enum(mode["kind"], {"modal", "driven"}, "scope.problem_scope.mode_scope.kind")
    for key in ("branch_policy", "multiplicity_policy", "tracking_policy", "drive_scope"):
        _identifier(mode[key], f"scope.problem_scope.mode_scope.{key}")
    _identifier_array(mode["class_ids"], "scope.problem_scope.mode_scope.class_ids")
    _integer_interval(mode["requested_count"], "scope.problem_scope.mode_scope.requested_count")
    if mode["spectral_window_rad_per_s"] != "not_applicable":
        _closed_interval(mode["spectral_window_rad_per_s"], "scope.problem_scope.mode_scope.spectral_window_rad_per_s")
    else:
        if mode_kind == "modal":
            _fail("scope.problem_scope.mode_scope.spectral_window_rad_per_s", "modal scope requires a window")
    _identifier_array(mode["response_observable_ids"], "scope.problem_scope.mode_scope.response_observable_ids", allow_empty=True)
    if mode_kind == "modal":
        if mode["response_observable_ids"] or mode["drive_scope"] != "not_applicable":
            _fail("scope.problem_scope.mode_scope", "modal response fields must be not_applicable/empty")
    else:
        if mode["requested_count"] != {"minimum": 0, "maximum": 0}:
            _fail("scope.problem_scope.mode_scope.requested_count", "driven scope must use a zero interval")

    k_scope = problem["k_scope"]
    if not isinstance(k_scope, dict):
        _fail("scope.problem_scope.k_scope", "must be an object")
    k_kind = k_scope.get("kind")
    if k_kind == "k0":
        _closed(k_scope, {"kind", "gamma_tolerance_rad_per_m"}, "scope.problem_scope.k_scope")
        _positive(k_scope["gamma_tolerance_rad_per_m"], "scope.problem_scope.k_scope.gamma_tolerance_rad_per_m")
    elif k_kind == "nonzero_k":
        _closed(k_scope, {"kind", "path_id", "samples_rad_per_m", "domain_rad_per_m", "gamma_tolerance_rad_per_m"}, "scope.problem_scope.k_scope")
        _identifier(k_scope["path_id"], "scope.problem_scope.k_scope.path_id")
        samples = k_scope["samples_rad_per_m"]
        if not isinstance(samples, list) or not samples:
            _fail("scope.problem_scope.k_scope.samples_rad_per_m", "must be a non-empty ordered array")
        for index, sample in enumerate(samples):
            if not isinstance(sample, list) or len(sample) != 3:
                _fail(f"scope.problem_scope.k_scope.samples_rad_per_m[{index}]", "must be a 3-vector")
            for component_index, component in enumerate(sample):
                _finite(component, f"scope.problem_scope.k_scope.samples_rad_per_m[{index}][{component_index}]")
        _closed_interval(k_scope["domain_rad_per_m"], "scope.problem_scope.k_scope.domain_rad_per_m")
        _positive(k_scope["gamma_tolerance_rad_per_m"], "scope.problem_scope.k_scope.gamma_tolerance_rad_per_m")
    else:
        _fail("scope.problem_scope.k_scope.kind", "must be 'k0' or 'nonzero_k'")

    demag = _enum(problem["dynamic_demag_scope"], {"none", "periodic_airbox_k0", "floquet_airbox_nonzero_k"}, "scope.problem_scope.dynamic_demag_scope")
    if demag == "periodic_airbox_k0" and k_kind != "k0":
        _fail("scope.problem_scope.dynamic_demag_scope", "periodic_airbox_k0 requires k_scope.kind=k0")
    if demag == "floquet_airbox_nonzero_k" and k_kind != "nonzero_k":
        _fail("scope.problem_scope.dynamic_demag_scope", "floquet_airbox_nonzero_k requires k_scope.kind=nonzero_k")
    if k_kind == "k0" and demag == "floquet_airbox_nonzero_k":
        _fail("scope.problem_scope.k_scope", "k0 cannot use Floquet dynamic demag")

    equilibrium = _closed(root["problem_scope"]["equilibrium_scope"], {"acceptance_policy", "torque_tolerance", "norm_tolerance", "artifact_policy", "signature_policy"}, "scope.problem_scope.equilibrium_scope")
    for key in ("acceptance_policy", "artifact_policy", "signature_policy"):
        _identifier(equilibrium[key], f"scope.problem_scope.equilibrium_scope.{key}")
    _positive(equilibrium["torque_tolerance"], "scope.problem_scope.equilibrium_scope.torque_tolerance")
    _positive(equilibrium["norm_tolerance"], "scope.problem_scope.equilibrium_scope.norm_tolerance")

    boundary = _closed(root["problem_scope"]["boundary_scope"], {"magnetic_bc", "periodic_directions", "pairing_policy", "open_directions", "scalar_outer_bc", "robin_beta_per_m"}, "scope.problem_scope.boundary_scope")
    for key in ("magnetic_bc", "pairing_policy", "scalar_outer_bc"):
        _identifier(boundary[key], f"scope.problem_scope.boundary_scope.{key}")
    _identifier_array(boundary["periodic_directions"], "scope.problem_scope.boundary_scope.periodic_directions", allow_empty=True)
    _identifier_array(boundary["open_directions"], "scope.problem_scope.boundary_scope.open_directions", allow_empty=True)
    if set(boundary["periodic_directions"]) & set(boundary["open_directions"]):
        _fail("scope.problem_scope.boundary_scope", "periodic/open directions must be disjoint")
    if boundary["robin_beta_per_m"] != "not_applicable":
        _closed_interval(boundary["robin_beta_per_m"], "scope.problem_scope.boundary_scope.robin_beta_per_m")
    if demag == "periodic_airbox_k0" and boundary["periodic_directions"] != ["x", "y"]:
        _fail("scope.problem_scope.boundary_scope.periodic_directions", "K0 airbox scope requires sorted [x,y]")

    gauge = _closed(root["problem_scope"]["gauge_scope"], {"policy", "augmentation", "nullspace_tolerance", "constraint_tolerance"}, "scope.problem_scope.gauge_scope")
    for key in ("policy", "augmentation"):
        _identifier(gauge[key], f"scope.problem_scope.gauge_scope.{key}")
    _positive(gauge["nullspace_tolerance"], "scope.problem_scope.gauge_scope.nullspace_tolerance")
    _positive(gauge["constraint_tolerance"], "scope.problem_scope.gauge_scope.constraint_tolerance")

    fe = _closed(root["problem_scope"]["fe_scope"], {"magnetic_space", "magnetic_order", "scalar_space", "scalar_order", "quadrature_rule", "mesh_quality", "refinement_policy"}, "scope.problem_scope.fe_scope")
    for key in ("magnetic_space", "scalar_space", "quadrature_rule", "refinement_policy"):
        _identifier(fe[key], f"scope.problem_scope.fe_scope.{key}")
    _positive_int(fe["magnetic_order"], "scope.problem_scope.fe_scope.magnetic_order")
    _positive_int(fe["scalar_order"], "scope.problem_scope.fe_scope.scalar_order")
    _closed_interval(fe["mesh_quality"], "scope.problem_scope.fe_scope.mesh_quality")

    size = _closed(root["problem_scope"]["problem_size_scope"], {"magnetic_dofs", "scalar_dofs", "total_dofs", "largest_memory_bytes", "largest_runtime_seconds"}, "scope.problem_scope.problem_size_scope")
    for key in ("magnetic_dofs", "scalar_dofs", "total_dofs"):
        _integer_interval(size[key], f"scope.problem_scope.problem_size_scope.{key}")
    _nonnegative_int(size["largest_memory_bytes"], "scope.problem_scope.problem_size_scope.largest_memory_bytes")
    _positive(size["largest_runtime_seconds"], "scope.problem_scope.problem_size_scope.largest_runtime_seconds")

    operator = _closed(root["problem_scope"]["operator_scope"], {"included_terms", "excluded_terms", "assembly_kind", "scalar_representation"}, "scope.problem_scope.operator_scope")
    _identifier_array(operator["included_terms"], "scope.problem_scope.operator_scope.included_terms")
    _identifier_array(operator["excluded_terms"], "scope.problem_scope.operator_scope.excluded_terms", allow_empty=True)
    if set(operator["included_terms"]) & set(operator["excluded_terms"]):
        _fail("scope.problem_scope.operator_scope", "a term cannot be included and excluded")
    _identifier(operator["assembly_kind"], "scope.problem_scope.operator_scope.assembly_kind")
    _identifier(operator["scalar_representation"], "scope.problem_scope.operator_scope.scalar_representation")
    damping = _closed(root["problem_scope"]["damping_scope"], {"alpha", "nonnormal_policy"}, "scope.problem_scope.damping_scope")
    _closed_interval(damping["alpha"], "scope.problem_scope.damping_scope.alpha")
    _identifier(damping["nonnormal_policy"], "scope.problem_scope.damping_scope.nonnormal_policy")

    solver = _closed(root["solver_scope"], {"engine", "rtol", "max_iterations", "restart", "linear_solver_family", "preconditioner", "spectral_transform", "target_representation", "device_residency", "precision", "block_residual_contract", "certificate_references", "fallback_policy", "accepted_stop_reasons"}, "scope.solver_scope")
    _identifier(solver["engine"], "scope.solver_scope.engine")
    rtol = _positive(solver["rtol"], "scope.solver_scope.rtol")
    if rtol >= 1:
        _fail("scope.solver_scope.rtol", "must be less than one")
    max_iterations = _positive_int(solver["max_iterations"], "scope.solver_scope.max_iterations")
    restart = _positive_int(solver["restart"], "scope.solver_scope.restart")
    if restart > max_iterations:
        _fail("scope.solver_scope.restart", "must not exceed max_iterations")
    _identifier(solver["linear_solver_family"], "scope.solver_scope.linear_solver_family")
    preconditioner = _closed(solver["preconditioner"], {"family", "variant", "setup_policy", "reuse_policy"}, "scope.solver_scope.preconditioner")
    for key in ("family", "variant", "setup_policy", "reuse_policy"):
        _identifier(preconditioner[key], f"scope.solver_scope.preconditioner.{key}")
    if preconditioner["family"] == "none" and any(preconditioner[key] != "none" for key in ("variant", "setup_policy", "reuse_policy")):
        _fail("scope.solver_scope.preconditioner", "none family requires all members to be none")
    spectral = _closed(solver["spectral_transform"], {"family", "shift_rad_per_s"}, "scope.solver_scope.spectral_transform")
    _identifier(spectral["family"], "scope.solver_scope.spectral_transform.family")
    if spectral["shift_rad_per_s"] != "not_applicable":
        _finite(spectral["shift_rad_per_s"], "scope.solver_scope.spectral_transform.shift_rad_per_s")
    target = _closed(solver["target_representation"], {"family", "target_rad_per_s", "window_rad_per_s", "sweep_hz"}, "scope.solver_scope.target_representation")
    _identifier(target["family"], "scope.solver_scope.target_representation.family")
    if target["target_rad_per_s"] != "not_applicable":
        _finite(target["target_rad_per_s"], "scope.solver_scope.target_representation.target_rad_per_s")
    if target["window_rad_per_s"] != "not_applicable":
        _closed_interval(target["window_rad_per_s"], "scope.solver_scope.target_representation.window_rad_per_s")
    if not isinstance(target["sweep_hz"], list):
        _fail("scope.solver_scope.target_representation.sweep_hz", "must be an ordered array")
    for index, value in enumerate(target["sweep_hz"]):
        _positive(value, f"scope.solver_scope.target_representation.sweep_hz[{index}]")
    residency = _closed(solver["device_residency"], {"operator", "krylov_vectors", "basis", "preconditioner", "per_iteration_h2d_max", "per_iteration_d2h_max", "hidden_host_solves_allowed"}, "scope.solver_scope.device_residency")
    for key in ("operator", "krylov_vectors", "basis", "preconditioner"):
        _enum(residency[key], {"host", "device", "mixed", "not_applicable"}, f"scope.solver_scope.device_residency.{key}")
    _nonnegative_int(residency["per_iteration_h2d_max"], "scope.solver_scope.device_residency.per_iteration_h2d_max")
    _nonnegative_int(residency["per_iteration_d2h_max"], "scope.solver_scope.device_residency.per_iteration_d2h_max")
    if not isinstance(residency["hidden_host_solves_allowed"], bool):
        _fail("scope.solver_scope.device_residency.hidden_host_solves_allowed", "must be boolean")
    _enum(solver["precision"], {"double", "single"}, "scope.solver_scope.precision")
    residual = _closed(solver["block_residual_contract"], {"operator_form", "norm", "required_blocks", "aggregation", "denominator_policy", "absolute_scale_floor", "acceptance_tolerance"}, "scope.solver_scope.block_residual_contract")
    if residual["operator_form"] != "original_unscaled" or residual["norm"] != "l2" or residual["aggregation"] != "max":
        _fail("scope.solver_scope.block_residual_contract", "must use original_unscaled/l2/max")
    _identifier_array(residual["required_blocks"], "scope.solver_scope.block_residual_contract.required_blocks")
    _identifier(residual["denominator_policy"], "scope.solver_scope.block_residual_contract.denominator_policy")
    _positive(residual["absolute_scale_floor"], "scope.solver_scope.block_residual_contract.absolute_scale_floor")
    _positive(residual["acceptance_tolerance"], "scope.solver_scope.block_residual_contract.acceptance_tolerance")
    _validate_certificate_references(solver["certificate_references"], "scope.solver_scope.certificate_references")
    _identifier(solver["fallback_policy"], "scope.solver_scope.fallback_policy")
    _identifier_array(solver["accepted_stop_reasons"], "scope.solver_scope.accepted_stop_reasons")

    runtime = _closed(root["runtime_scope"], {"fullmag_commit", "build_id", "native_abi", "dependency_versions", "managed_route"}, "scope.runtime_scope")
    if not isinstance(runtime["fullmag_commit"], str) or re.fullmatch(r"[0-9a-f]{40}", runtime["fullmag_commit"]) is None:
        _fail("scope.runtime_scope.fullmag_commit", "must be exactly 40 lowercase hex characters")
    _identifier(runtime["build_id"], "scope.runtime_scope.build_id")
    _positive_int(runtime["native_abi"], "scope.runtime_scope.native_abi")
    _identifier(runtime["managed_route"], "scope.runtime_scope.managed_route")
    dependencies = runtime["dependency_versions"]
    if not isinstance(dependencies, list) or not dependencies:
        _fail("scope.runtime_scope.dependency_versions", "must be non-empty")
    dependency_names: list[str] = []
    for index, raw in enumerate(dependencies):
        item = _closed(raw, {"name", "version"}, f"scope.runtime_scope.dependency_versions[{index}]")
        dependency_names.append(_identifier(item["name"], f"scope.runtime_scope.dependency_versions[{index}].name"))
        _identifier(item["version"], f"scope.runtime_scope.dependency_versions[{index}].version")
    if dependency_names != sorted(dependency_names) or len(set(dependency_names)) != len(dependency_names):
        _fail("scope.runtime_scope.dependency_versions", "names must be unique and sorted")

    device = _closed(root["device_scope"], {"requested", "resolved", "family", "architecture", "driver", "runtime"}, "scope.device_scope")
    _enum(device["requested"], {"cpu", "gpu", "auto"}, "scope.device_scope.requested")
    _enum(device["resolved"], {"cpu", "gpu"}, "scope.device_scope.resolved")
    for key in ("family", "architecture", "driver", "runtime"):
        _identifier(device[key], f"scope.device_scope.{key}")
    if device["requested"] == "gpu" and device["resolved"] != "gpu":
        _fail("scope.device_scope", "strict GPU request cannot resolve to CPU")

    material = _closed(root["material_scope"], {"class_ids", "region_policy", "parameter_bounds"}, "scope.material_scope")
    _identifier_array(material["class_ids"], "scope.material_scope.class_ids")
    _identifier(material["region_policy"], "scope.material_scope.region_policy")
    _parameter_bounds(material["parameter_bounds"], "scope.material_scope.parameter_bounds")

    geometry = _closed(root["geometry_scope"], {"family", "dimension_bounds", "periodic_cell_policy", "airbox_policy"}, "scope.geometry_scope")
    _identifier(geometry["family"], "scope.geometry_scope.family")
    _dimension_bounds(geometry["dimension_bounds"], "scope.geometry_scope.dimension_bounds")
    periodic = _closed(geometry["periodic_cell_policy"], {"directions", "cell_id"}, "scope.geometry_scope.periodic_cell_policy")
    _identifier_array(periodic["directions"], "scope.geometry_scope.periodic_cell_policy.directions", allow_empty=True)
    _identifier(periodic["cell_id"], "scope.geometry_scope.periodic_cell_policy.cell_id")
    airbox = _closed(geometry["airbox_policy"], {"kind", "top_padding_m", "bottom_padding_m", "symmetry"}, "scope.geometry_scope.airbox_policy")
    for key in ("kind", "symmetry"):
        _identifier(airbox[key], f"scope.geometry_scope.airbox_policy.{key}")
    for key in ("top_padding_m", "bottom_padding_m"):
        if airbox[key] != "not_applicable":
            _closed_interval(airbox[key], f"scope.geometry_scope.airbox_policy.{key}")
    _identity_array(root["fixture_ids"], "scope.fixture_ids")
    _identity_array(root["oracle_ids"], "scope.oracle_ids")

    if root["study_product"] == "modal_eigen" and mode_kind != "modal":
        _fail("scope.study_product", "modal_eigen requires mode_scope.kind=modal")
    if root["study_product"] == "driven_response" and mode_kind != "driven":
        _fail("scope.study_product", "driven_response requires mode_scope.kind=driven")
    return root


def canonical_json_bytes(value: Any) -> bytes:
    """Return the deterministic JSON bytes used by the scope identity contract."""
    def reject_numbers(item: Any, path: str = "value") -> None:
        if isinstance(item, float):
            _finite(item, path)
        elif isinstance(item, dict):
            for key, child in item.items():
                reject_numbers(child, f"{path}.{key}")
        elif isinstance(item, list):
            for index, child in enumerate(item):
                reject_numbers(child, f"{path}[{index}]")

    reject_numbers(value)
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"canonical JSON serialization failed: {exc}") from exc


def scope_id_for(scope: Any) -> str:
    validate_scope(scope)
    return "sha256:" + hashlib.sha256(canonical_json_bytes(scope)).hexdigest()


def validate_scope_catalog(catalog: Any) -> str:
    root = _closed(catalog, {"schema", "scope_schema", "scopes"}, "scope_catalog")
    if root["schema"] != CATALOG_SCHEMA:
        _fail("scope_catalog.schema", f"must equal {CATALOG_SCHEMA!r}")
    if root["scope_schema"] != SCHEMA:
        _fail("scope_catalog.scope_schema", f"must equal {SCHEMA!r}")
    scopes = root["scopes"]
    if not isinstance(scopes, dict) or not scopes:
        _fail("scope_catalog.scopes", "must be a non-empty object")
    for key, scope in scopes.items():
        _sha(key, f"scope_catalog.scopes[{key!r}]")
        computed = scope_id_for(scope)
        if key != computed:
            _fail("scope catalog entry key", f"{key!r} does not match recomputed {computed!r}")
    return "sha256:" + hashlib.sha256(canonical_json_bytes(root)).hexdigest()


def _json_pointer_get(value: Any, pointer: str, path: str) -> Any:
    if pointer == "":
        return value
    if not pointer.startswith("/"):
        _fail(path, "must be an RFC 6901 JSON Pointer")
    current = value
    for index, token in enumerate(pointer.split("/")[1:]):
        token_path = f"{path}.tokens[{index}]"
        if "~" in token:
            if re.search(r"~(?![01])", token):
                _fail(token_path, "contains an invalid RFC 6901 escape")
            token = token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            if token not in current:
                _fail(path, f"does not resolve field {pointer!r}")
            current = current[token]
        elif isinstance(current, list):
            if token == "-" or not token.isdigit():
                _fail(path, f"does not resolve array index {token!r}")
            array_index = int(token)
            if array_index >= len(current):
                _fail(path, f"does not resolve array index {array_index}")
            current = current[array_index]
        else:
            _fail(path, f"cannot traverse scalar at token {index}")
    return current


def _canonical_value_equal(left: Any, right: Any) -> bool:
    return canonical_json_bytes(left) == canonical_json_bytes(right)


def _pointer_token(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _comparison_addresses(value: Any, path: str = "") -> set[str]:
    """Return the complete schema-level addresses compared by a coverage rule."""
    if isinstance(value, dict) and set(value) not in (
        {"minimum", "maximum"},
        {"minimum", "maximum", "unit"},
    ):
        addresses: set[str] = set()
        for key, child in value.items():
            addresses.update(
                _comparison_addresses(child, f"{path}/{_pointer_token(key)}")
            )
        return addresses
    return {path}


def _validate_coverage_predicate(
    predicate: dict[str, Any],
    subject_scope: dict[str, Any],
    covered_scope: dict[str, Any],
    path: str,
) -> bool:
    field_path = predicate["field_path"]
    subject_value = _json_pointer_get(subject_scope, field_path, f"{path}.field_path")
    covered_value = _json_pointer_get(covered_scope, field_path, f"{path}.field_path")
    comparator = predicate["comparator"]
    if comparator == "equal":
        if not _canonical_value_equal(subject_value, covered_value):
            _fail(path, f"covered scope value at {field_path!r} is not equal to the subject")
        return False
    if comparator == "set_subset":
        if field_path not in SET_COMPARISON_PATHS:
            _fail(path, "set_subset is not permitted for this schema address")
        if not isinstance(subject_value, list) or not isinstance(covered_value, list):
            _fail(path, "set_subset requires arrays")
        if any(not isinstance(item, str) for item in subject_value + covered_value):
            _fail(path, "set_subset requires arrays of strings")
        if len(subject_value) != len(set(subject_value)) or len(covered_value) != len(set(covered_value)):
            _fail(path, "set_subset arrays must not contain duplicates")
        if not set(covered_value).issubset(subject_value):
            _fail(path, f"covered scope set at {field_path!r} is not a subset of the subject")
        return True
    if comparator == "interval_subset":
        if not isinstance(subject_value, dict) or not isinstance(covered_value, dict):
            _fail(path, "interval_subset requires interval objects")
        if set(subject_value) not in ({"minimum", "maximum"}, {"minimum", "maximum", "unit"}):
            _fail(path, "subject value is not a complete interval")
        if set(covered_value) != set(subject_value):
            _fail(path, "covered interval shape must match the subject")
        subject_min = _finite(subject_value["minimum"], f"{path}.subject.minimum")
        subject_max = _finite(subject_value["maximum"], f"{path}.subject.maximum")
        covered_min = _finite(covered_value["minimum"], f"{path}.covered.minimum")
        covered_max = _finite(covered_value["maximum"], f"{path}.covered.maximum")
        if subject_min > subject_max or covered_min > covered_max:
            _fail(path, "interval minimum must not exceed maximum")
        if "unit" in subject_value:
            _identifier(subject_value["unit"], f"{path}.subject.unit")
            if covered_value["unit"] != subject_value["unit"]:
                _fail(path, "interval units must match")
        if not (subject_min <= covered_min <= covered_max <= subject_max):
            _fail(path, f"covered interval at {field_path!r} is not contained by the subject")
        return True
    _fail(path, f"unsupported comparator {comparator!r}")
    return False


def _validate_coverage_rule(rule: Any, catalog: dict[str, Any]) -> None:
    item = _closed(rule, {"schema", "relation", "subject_scope_id", "covered_scope_ids", "field_predicates"}, "verified_coverage_of.coverage_rule")
    if item["schema"] != "coverage_rule.v1":
        _fail("verified_coverage_of.coverage_rule.schema", "must equal 'coverage_rule.v1'")
    _enum(item["relation"], {"exact", "subset"}, "verified_coverage_of.coverage_rule.relation")
    _sha(item["subject_scope_id"], "verified_coverage_of.coverage_rule.subject_scope_id")
    covered = item["covered_scope_ids"]
    if not isinstance(covered, list) or not covered:
        _fail("verified_coverage_of.coverage_rule.covered_scope_ids", "must be non-empty")
    for index, scope_id in enumerate(covered):
        _sha(scope_id, f"verified_coverage_of.coverage_rule.covered_scope_ids[{index}]")
    if len(covered) != len(set(covered)):
        _fail("verified_coverage_of.coverage_rule.covered_scope_ids", "must not contain duplicates")
    scopes = catalog["scopes"]
    if item["subject_scope_id"] not in scopes:
        _fail("verified_coverage_of.coverage_rule.subject_scope_id", "does not resolve in the catalog")
    for scope_id in covered:
        if scope_id not in scopes:
            _fail("verified_coverage_of.coverage_rule.covered_scope_ids", f"{scope_id!r} does not resolve in the catalog")
    predicates = item["field_predicates"]
    if not isinstance(predicates, list) or not predicates:
        _fail("verified_coverage_of.coverage_rule.field_predicates", "must be non-empty")
    seen: set[tuple[str, str]] = set()
    comparators: list[str] = []
    for index, raw in enumerate(predicates):
        predicate = _closed(raw, {"covered_scope_id", "field_path", "comparator"}, f"verified_coverage_of.coverage_rule.field_predicates[{index}]")
        _sha(predicate["covered_scope_id"], f"...field_predicates[{index}].covered_scope_id")
        if predicate["covered_scope_id"] not in covered:
            _fail(f"...field_predicates[{index}].covered_scope_id", "is not listed in covered_scope_ids")
        field_path = _string(predicate["field_path"], f"...field_predicates[{index}].field_path")
        if not field_path.startswith("/"):
            _fail(f"...field_predicates[{index}].field_path", "must be an RFC 6901 JSON Pointer")
        comparator = _enum(predicate["comparator"], {"equal", "set_subset", "interval_subset"}, f"...field_predicates[{index}].comparator")
        comparators.append(comparator)
        key = (predicate["covered_scope_id"], field_path)
        if key in seen:
            _fail("verified_coverage_of.coverage_rule.field_predicates", "contains duplicate comparison addresses")
        seen.add(key)
    if item["relation"] == "exact" and any(comparator != "equal" for comparator in comparators):
        _fail("verified_coverage_of.coverage_rule", "exact relation requires equal predicates")

    subject_scope = scopes[item["subject_scope_id"]]
    expected_addresses = _comparison_addresses(subject_scope)
    expected_pairs = {
        (covered_scope_id, field_path)
        for covered_scope_id in covered
        for field_path in expected_addresses
    }
    if seen != expected_pairs:
        missing = sorted(expected_pairs.difference(seen))
        extra = sorted(seen.difference(expected_pairs))
        _fail(
            "verified_coverage_of.coverage_rule.field_predicates",
            f"must contain exactly all canonical comparison addresses; missing={missing!r}, extra={extra!r}",
        )
    if item["relation"] == "exact":
        if covered != [item["subject_scope_id"]]:
            _fail("verified_coverage_of.coverage_rule.covered_scope_ids", "exact relation must cover only its subject")
    has_restrictive_predicate = False
    for index, raw in enumerate(predicates):
        predicate = raw
        covered_scope = scopes[predicate["covered_scope_id"]]
        has_restrictive_predicate |= _validate_coverage_predicate(
            predicate,
            subject_scope,
            covered_scope,
            f"verified_coverage_of.coverage_rule.field_predicates[{index}]",
        )
    if item["relation"] == "subset" and not has_restrictive_predicate:
        _fail("verified_coverage_of.coverage_rule", "subset relation requires set_subset or interval_subset")


def validate_scope_binding(binding: Any, catalog: Any, expected_uri: str, expected_catalog_sha256: str) -> None:
    item = _closed(binding, {"schema", "scope_schema", "kind", "scope_catalog_uri", "scope_catalog_sha256", "coverage_rule"}, "verified_coverage_of") if isinstance(binding, dict) and "kind" in binding and binding.get("kind") == "coverage" else None
    if item is None:
        if not isinstance(binding, dict):
            _fail("verified_coverage_of", "must be an object")
        item = _closed(binding, {"schema", "scope_schema", "kind", "scope_id", "scope_catalog_uri", "scope_catalog_sha256"}, "verified_coverage_of")
    if item["schema"] != BINDING_SCHEMA:
        _fail("verified_coverage_of.schema", f"must equal {BINDING_SCHEMA!r}")
    if item["scope_schema"] != SCHEMA:
        _fail("verified_coverage_of.scope_schema", f"must equal {SCHEMA!r}")
    if item["scope_catalog_uri"] != expected_uri:
        _fail("verified_coverage_of.scope_catalog_uri", "does not match the resolved catalog URI")
    if item["scope_catalog_sha256"] != expected_catalog_sha256:
        _fail("verified_coverage_of.scope_catalog_sha256", "does not match the resolved catalog digest")
    scopes = catalog.get("scopes") if isinstance(catalog, dict) else None
    if not isinstance(scopes, dict):
        _fail("scope_catalog.scopes", "must be an object")
    if item["kind"] == "direct":
        scope_id = _sha(item.get("scope_id"), "verified_coverage_of.scope_id")
        if scope_id not in scopes:
            _fail("verified_coverage_of.scope_id", "does not resolve in the catalog")
    elif item["kind"] == "coverage":
        _validate_coverage_rule(item.get("coverage_rule"), catalog)
    else:
        _fail("verified_coverage_of.kind", "must be direct or coverage")


def _validate_binding_covers_scope(
    binding: Any,
    catalog: Any,
    expected_uri: str,
    expected_catalog_sha256: str,
    target_scope_id: str,
) -> None:
    validate_scope_binding(binding, catalog, expected_uri, expected_catalog_sha256)
    if binding["kind"] == "direct":
        covers_target = binding["scope_id"] == target_scope_id
    else:
        covers_target = target_scope_id in binding["coverage_rule"]["covered_scope_ids"]
    if not covers_target:
        _fail("verified_coverage_of", "does not cover the production scope")


def _zarr_tree_digest(path: Path) -> str:
    if not path.is_dir():
        _fail("artifact", "Zarr store must be a directory")
    digest = hashlib.sha256()
    for child in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = child.relative_to(path).as_posix().encode("utf-8")
        payload = child.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return "sha256:" + digest.hexdigest()


def validate_artifact_sidecar(
    artifact: Path,
    sidecar_path: Path,
    sidecar: Any,
    catalog: Any,
    expected_uri: str,
    expected_catalog_sha256: str,
    expected_artifact_uri: str | None = None,
    target_scope_id: str | None = None,
) -> None:
    if not sidecar_path.is_file():
        _fail("validation_artifact_manifest", f"missing sidecar {sidecar_path}")
    if not isinstance(sidecar, dict):
        _fail("validation_artifact_manifest", "must be an object")
    base_keys = {"schema", "artifact_kind", "artifact_schema", "artifact_uri", "verified_coverage_of"}
    kind = sidecar.get("artifact_kind")
    hash_keys = {"zarr_tree_sha256"} if kind == "zarr" else {"artifact_sha256"}
    item = _closed(sidecar, base_keys | hash_keys, "validation_artifact_manifest")
    if item["schema"] != SIDECAR_SCHEMA:
        _fail("validation_artifact_manifest.schema", f"must equal {SIDECAR_SCHEMA!r}")
    kind = _enum(item["artifact_kind"], {"csv", "zarr", "binary", "text", "other_non_json"}, "validation_artifact_manifest.artifact_kind")
    _identifier(item["artifact_schema"], "validation_artifact_manifest.artifact_schema")
    artifact_uri = artifact.name if expected_artifact_uri is None else expected_artifact_uri
    if item["artifact_uri"] != artifact_uri:
        _fail("validation_artifact_manifest.artifact_uri", "must name the target artifact")
    if kind == "zarr":
        _sha(item["zarr_tree_sha256"], "validation_artifact_manifest.zarr_tree_sha256")
        if item["zarr_tree_sha256"] != _zarr_tree_digest(artifact):
            _fail("validation_artifact_manifest.zarr_tree_sha256", "does not match the Zarr tree")
    else:
        expected = "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()
        if item["artifact_sha256"] != expected:
            _fail("validation_artifact_manifest.artifact_sha256", "does not match artifact bytes")
    if target_scope_id is None:
        validate_scope_binding(item["verified_coverage_of"], catalog, expected_uri, expected_catalog_sha256)
    else:
        _validate_binding_covers_scope(
            item["verified_coverage_of"],
            catalog,
            expected_uri,
            expected_catalog_sha256,
            target_scope_id,
        )


def _resolve_bundle_path(bundle_root: Path, raw_path: Any, path: str) -> Path:
    relative = _string(raw_path, path)
    candidate = (bundle_root / relative).resolve()
    try:
        candidate.relative_to(bundle_root.resolve())
    except ValueError:
        _fail(path, "must remain inside the evidence bundle")
    if not candidate.exists():
        _fail(path, f"missing evidence artifact {candidate}")
    return candidate


def _validate_verifier_execution_proof(
    verifier: Any,
    *,
    bundle_root: Path,
    catalog: Any,
    expected_uri: str,
    expected_catalog_sha256: str,
    scope: dict[str, Any],
    target_scope_id: str,
    gate_id: str,
) -> None:
    """Validate an independently captured verifier invocation.

    A verifier name and a declared ``result=pass`` are not evidence of an
    executed gate.  The proof therefore binds the invocation to the exact
    scope/catalog/runtime and hashes immutable stdout/stderr files that are
    materialized in the bundle.  The files are also required to carry the
    normal validation sidecars, so the proof cannot silently point outside the
    artifact contract.
    """

    item = _closed(
        verifier,
        VERIFIER_PROOF_KEYS,
        f"production_record.item_evidence.{gate_id}.verifier",
    )
    _identifier(item["id"], f"...{gate_id}.verifier.id")
    _identifier(item["version"], f"...{gate_id}.verifier.version")
    if item["result"] != "pass":
        _fail(f"...{gate_id}.verifier.result", "must be 'pass'")
    command = item["command"]
    if (
        not isinstance(command, list)
        or not command
        or any(not isinstance(part, str) or not part or "\x00" in part for part in command)
    ):
        _fail(f"...{gate_id}.verifier.command", "must be a non-empty argv array")
    if isinstance(item["exit_code"], bool) or not isinstance(item["exit_code"], int):
        _fail(f"...{gate_id}.verifier.exit_code", "must be an integer")
    if item["exit_code"] != 0:
        _fail(f"...{gate_id}.verifier.exit_code", "must be zero for a passing gate")
    if not isinstance(item["executed_at"], str) or RFC3339_UTC.fullmatch(item["executed_at"]) is None:
        _fail(f"...{gate_id}.verifier.executed_at", "must be an RFC3339 UTC timestamp")
    try:
        datetime.fromisoformat(item["executed_at"].replace("Z", "+00:00"))
    except ValueError as exc:
        _fail(f"...{gate_id}.verifier.executed_at", f"is not a valid timestamp: {exc}")
    if item["scope_id"] != target_scope_id:
        _fail(f"...{gate_id}.verifier.scope_id", "does not match the production scope")
    if item["scope_catalog_sha256"] != expected_catalog_sha256:
        _fail(
            f"...{gate_id}.verifier.scope_catalog_sha256",
            "does not match the resolved scope catalog",
        )
    if item["runtime_fullmag_commit"] != scope["runtime_scope"]["fullmag_commit"]:
        _fail(
            f"...{gate_id}.verifier.runtime_fullmag_commit",
            "does not match validated_scope.runtime_scope.fullmag_commit",
        )
    if item["runtime_build_id"] != scope["runtime_scope"]["build_id"]:
        _fail(
            f"...{gate_id}.verifier.runtime_build_id",
            "does not match validated_scope.runtime_scope.build_id",
        )

    for stream in ("stdout", "stderr"):
        path_key = f"{stream}_path"
        digest_key = f"{stream}_sha256"
        artifact = _resolve_bundle_path(
            bundle_root,
            item[path_key],
            f"...{gate_id}.verifier.{path_key}",
        )
        if not artifact.is_file():
            _fail(f"...{gate_id}.verifier.{path_key}", "must name a regular file")
        digest = "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()
        if item[digest_key] != digest:
            _fail(
                f"...{gate_id}.verifier.{digest_key}",
                f"does not match {digest}",
            )
        sidecar = artifact.with_name(artifact.name + ".validation_manifest.v1.json")
        if not sidecar.is_file():
            _fail(
                f"...{gate_id}.verifier.{path_key}",
                f"is missing deterministic sidecar {sidecar}",
            )
        try:
            sidecar_value = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            _fail(f"...{gate_id}.verifier.{path_key}", f"sidecar is invalid JSON: {exc}")
        validate_artifact_sidecar(
            artifact,
            sidecar,
            sidecar_value,
            catalog,
            expected_uri,
            expected_catalog_sha256,
            artifact.relative_to(bundle_root.resolve()).as_posix(),
            target_scope_id,
        )


def _artifact_digest(path: Path) -> str:
    if path.is_dir():
        return _zarr_tree_digest(path)
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _optional_identity_array(value: Any, path: str) -> None:
    if not isinstance(value, list):
        _fail(path, "must be an array of identity references")
    seen: set[tuple[str, str, str]] = set()
    for index, item in enumerate(value):
        _identity_ref(item, f"{path}[{index}]")
        key = (item["id"], item["version"], item["sha256"])
        if key in seen:
            _fail(path, "must not contain duplicate identity references")
        seen.add(key)


def _validate_json_object_binding(
    artifact: Path,
    catalog: Any,
    expected_uri: str,
    expected_catalog_sha256: str,
    target_scope_id: str,
) -> None:
    try:
        value = json.loads(artifact.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail("production_record.evidence", f"JSON evidence is not valid UTF-8 JSON: {exc}")
    if not isinstance(value, dict):
        _fail("production_record.evidence", "JSON evidence must be a top-level object")
    if "verified_coverage_of" not in value:
        _fail("production_record.evidence", "JSON evidence is missing verified_coverage_of")
    _validate_binding_covers_scope(
        value["verified_coverage_of"],
        catalog,
        expected_uri,
        expected_catalog_sha256,
        target_scope_id,
    )


def _validate_one_evidence_artifact(
    raw: Any,
    bundle_root: Path,
    catalog: Any,
    expected_uri: str,
    expected_catalog_sha256: str,
    gate_id: str,
    target_scope_id: str,
) -> str:
    item = _closed(
        raw,
        {"path", "sha256", "sidecar_path", "sidecar_sha256"},
        f"production_record.item_evidence.{gate_id}.evidence",
    )
    artifact = _resolve_bundle_path(
        bundle_root,
        item["path"],
        f"production_record.item_evidence.{gate_id}.evidence.path",
    )
    digest = _artifact_digest(artifact)
    if item["sha256"] != digest:
        _fail(
            f"production_record.item_evidence.{gate_id}.evidence.sha256",
            f"does not match {digest}",
        )

    sidecar = artifact.with_name(artifact.name + ".validation_manifest.v1.json")
    if artifact.is_dir() or artifact.suffix.lower() not in {".json"}:
        if not sidecar.is_file():
            _fail(
                f"production_record.item_evidence.{gate_id}.evidence.sidecar_path",
                f"missing deterministic sidecar {sidecar}",
            )
        if item["sidecar_path"] != str(sidecar.relative_to(bundle_root.resolve())):
            _fail(
                f"production_record.item_evidence.{gate_id}.evidence.sidecar_path",
                "must use the deterministic sidecar path",
            )
        sidecar_digest = "sha256:" + hashlib.sha256(sidecar.read_bytes()).hexdigest()
        if item["sidecar_sha256"] != sidecar_digest:
            _fail(
                f"production_record.item_evidence.{gate_id}.evidence.sidecar_sha256",
                f"does not match {sidecar_digest}",
            )
        try:
            sidecar_value = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            _fail(
                f"production_record.item_evidence.{gate_id}.evidence.sidecar_path",
                f"is not valid JSON: {exc}",
            )
        validate_artifact_sidecar(
            artifact,
            sidecar,
            sidecar_value,
            catalog,
            expected_uri,
            expected_catalog_sha256,
            artifact.relative_to(bundle_root.resolve()).as_posix(),
            target_scope_id,
        )
    else:
        if item["sidecar_path"] is not None or item["sidecar_sha256"] is not None:
            _fail(
                f"production_record.item_evidence.{gate_id}.evidence",
                "JSON object evidence must bind at top level, not through a sidecar",
            )
        _validate_json_object_binding(
            artifact,
            catalog,
            expected_uri,
            expected_catalog_sha256,
            target_scope_id,
        )
    return artifact.relative_to(bundle_root.resolve()).as_posix()


def _validate_pass_item_evidence(
    gate_id: str,
    raw: Any,
    bundle_root: Path,
    catalog: Any,
    expected_uri: str,
    expected_catalog_sha256: str,
    target_scope_id: str,
) -> None:
    item = _closed(
        raw,
        {
            "gate_id",
            "verified_coverage_of",
            "evidence",
            "fixture_ids",
            "oracle_ids",
            "metrics",
            "tolerances",
            "verifier",
            "implementation_state",
            "validation_state_before_promotion",
            "open_blockers",
        },
        f"production_record.item_evidence.{gate_id}",
    )
    if item["gate_id"] != gate_id:
        _fail(f"production_record.item_evidence.{gate_id}.gate_id", "does not match the item key")
    _validate_binding_covers_scope(
        item["verified_coverage_of"],
        catalog,
        expected_uri,
        expected_catalog_sha256,
        target_scope_id,
    )
    evidence = item["evidence"]
    if not isinstance(evidence, list) or not evidence:
        _fail(f"production_record.item_evidence.{gate_id}.evidence", "must be non-empty")
    seen_paths: set[str] = set()
    for artifact in evidence:
        path = _validate_one_evidence_artifact(
            artifact,
            bundle_root,
            catalog,
            expected_uri,
            expected_catalog_sha256,
            gate_id,
            target_scope_id,
        )
        if path in seen_paths:
            _fail(f"production_record.item_evidence.{gate_id}.evidence", "contains duplicate paths")
        seen_paths.add(path)
    _optional_identity_array(item["fixture_ids"], f"production_record.item_evidence.{gate_id}.fixture_ids")
    _optional_identity_array(item["oracle_ids"], f"production_record.item_evidence.{gate_id}.oracle_ids")
    if not isinstance(item["metrics"], dict):
        _fail(f"production_record.item_evidence.{gate_id}.metrics", "must be an object")
    if not isinstance(item["tolerances"], dict):
        _fail(f"production_record.item_evidence.{gate_id}.tolerances", "must be an object")
    _validate_verifier_execution_proof(
        item["verifier"],
        bundle_root=bundle_root,
        catalog=catalog,
        expected_uri=expected_uri,
        expected_catalog_sha256=expected_catalog_sha256,
        scope=catalog["scopes"][target_scope_id],
        target_scope_id=target_scope_id,
        gate_id=gate_id,
    )
    _enum(
        item["implementation_state"],
        {"absent", "contract_only", "source_visible", "executable"},
        f"production_record.item_evidence.{gate_id}.implementation_state",
    )
    _enum(
        item["validation_state_before_promotion"],
        {"unvalidated", "algebra_validated", "physics_validated", "production_qualified"},
        f"production_record.item_evidence.{gate_id}.validation_state_before_promotion",
    )
    blockers = item["open_blockers"]
    if not isinstance(blockers, list) or blockers:
        _fail(f"production_record.item_evidence.{gate_id}.open_blockers", "must be an empty array for a pass")


def validate_production_record(record: Any, bundle_root: Path) -> None:
    root = _closed(record, {"schema", "scope_schema", "scope_id", "validated_scope", "scope_catalog_uri", "scope_catalog_sha256", "implementation_state", "validation_state_before_promotion", "items", "item_evidence", "not_applicable_reasons", "open_blockers", "promotion_decision"}, "production_record")
    if root["schema"] != PRODUCTION_DOD_SCHEMA:
        _fail("production_record.schema", f"must equal {PRODUCTION_DOD_SCHEMA!r}")
    if root["scope_schema"] != SCHEMA:
        _fail("production_record.scope_schema", f"must equal {SCHEMA!r}")
    scope_id = scope_id_for(root["validated_scope"])
    if root["scope_id"] != scope_id:
        _fail("production_record.scope_id", "does not match validated_scope")
    catalog_uri = _string(root["scope_catalog_uri"], "production_record.scope_catalog_uri")
    catalog_path = (bundle_root / catalog_uri).resolve()
    if bundle_root.resolve() not in catalog_path.parents:
        _fail("production_record.scope_catalog_uri", "escapes bundle root")
    if not catalog_path.is_file():
        _fail("production_record.scope_catalog_uri", f"missing catalog {catalog_path}")
    catalog_bytes = catalog_path.read_bytes()
    try:
        catalog = json.loads(catalog_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail("production_record.scope_catalog_uri", f"catalog is not valid UTF-8 JSON: {exc}")
    catalog_digest = validate_scope_catalog(catalog)
    if catalog_bytes != canonical_json_bytes(catalog):
        _fail(
            "production_record.scope_catalog_uri",
            "catalog bytes must use the canonical JSON serialization",
        )
    if root["scope_catalog_sha256"] != catalog_digest:
        _fail("production_record.scope_catalog_sha256", "does not match catalog bytes")
    if scope_id not in catalog["scopes"]:
        _fail("production_record.scope_id", "validated scope is absent from catalog")
    if root["implementation_state"] != "executable":
        _fail("production_record.implementation_state", "must be executable for promotion")
    _enum(
        root["validation_state_before_promotion"],
        {"unvalidated", "algebra_validated", "physics_validated", "production_qualified"},
        "production_record.validation_state_before_promotion",
    )
    items = _closed(root["items"], set(ALL_DOD_IDS), "production_record.items")
    for gate_id in ALL_DOD_IDS:
        _enum(items[gate_id], {"pass", "fail", "not_applicable"}, f"production_record.items.{gate_id}")
    _closed(root["item_evidence"], set(ALL_DOD_IDS), "production_record.item_evidence")
    reasons = root["not_applicable_reasons"]
    if not isinstance(reasons, dict):
        _fail("production_record.not_applicable_reasons", "must be an object")
    for gate_id in ALL_DOD_IDS:
        state = items[gate_id]
        evidence = root["item_evidence"][gate_id]
        if state == "pass":
            _validate_pass_item_evidence(
                gate_id,
                evidence,
                bundle_root,
                catalog,
                catalog_uri,
                catalog_digest,
                scope_id,
            )
        elif state == "not_applicable":
            reason = reasons.get(gate_id)
            if not isinstance(reason, str) or not reason:
                _fail(
                    "production_record.not_applicable_reasons",
                    f"missing machine-readable reason for {gate_id}",
                )
            device = root["validated_scope"]["device_scope"]["resolved"]
            if not (
                gate_id == "DOD-12"
                and device == "cpu"
                and reason == "validated_scope.device=cpu excludes GPU"
            ):
                _fail(
                    f"production_record.not_applicable_reasons.{gate_id}",
                    "gate is applicable to the validated production scope",
                )
            if not isinstance(evidence, dict):
                _fail(f"production_record.item_evidence.{gate_id}", "must be an object")
        elif not isinstance(evidence, dict):
            _fail(f"production_record.item_evidence.{gate_id}", "must be an object")
    unexpected_reasons = sorted(set(reasons).difference(
        gate_id for gate_id in ALL_DOD_IDS if items[gate_id] == "not_applicable"
    ))
    if unexpected_reasons:
        _fail(
            "production_record.not_applicable_reasons",
            f"contains reasons for applicable gates {unexpected_reasons!r}",
        )
    blockers = root["open_blockers"]
    if not isinstance(blockers, list) or any(not isinstance(item, str) or not item for item in blockers):
        _fail("production_record.open_blockers", "must be an array of strings")
    expected_decision = "production_qualified" if all(items[gate_id] in {"pass", "not_applicable"} for gate_id in ALL_DOD_IDS) and not blockers else "blocked"
    if root["promotion_decision"] != expected_decision:
        _fail("production_record.promotion_decision", f"must be {expected_decision!r} for current gate states")


def _cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, help="validate a scope_catalog.v1 JSON file")
    parser.add_argument("--record", type=Path, help="validate a frequency_domain_production_dod.v1 record")
    parser.add_argument("--bundle-root", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    try:
        if args.catalog is not None:
            catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
            print(validate_scope_catalog(catalog))
        if args.record is not None:
            validate_production_record(json.loads(args.record.read_text(encoding="utf-8")), args.bundle_root)
        if args.catalog is None and args.record is None:
            parser.error("one of --catalog or --record is required")
    except (OSError, json.JSONDecodeError, ValidationError) as exc:
        print(f"invalid frequency-domain production contract: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
