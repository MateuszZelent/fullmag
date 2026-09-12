#!/usr/bin/env python3
"""Compare exact-scope CPU/GPU K0 periodic-airbox modal artifacts.

The verifier intentionally consumes both execution manifests and per-sample
native diagnostics.  A matching frequency alone is not enough: the two
bundles must describe the same FEM operator, accepted residual contract, and
strict device lanes, with no hidden CPU fallback in the GPU result.  CPU and
GPU may materialize independently converged floating-point equilibrium and
tangent-frame artifacts; those identities remain provenance fields and the
accepted state is compared with an explicit physical tolerance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any


class ParityError(ValueError):
    """Raised when a CPU/GPU parity contract is not satisfied."""


def _fail(message: str) -> None:
    raise ParityError(message)


def _json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail(f"cannot read {path}: {exc}")
    if not isinstance(value, dict):
        _fail(f"{path} must contain a JSON object")
    return value


def _finite(value: Any, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{path} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        _fail(f"{path} must be a finite number")
    return result


def _nonnegative_finite(value: Any, path: str) -> float:
    result = _finite(value, path)
    if result < 0.0:
        _fail(f"{path} must be non-negative")
    return result


def _positive_integer(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        _fail(f"{path} must be a positive integer")
    return value


def _sha256_identity(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.startswith("sha256:") or len(value) != 71:
        _fail(f"{path} must be a sha256 identity")
    try:
        int(value[7:], 16)
    except ValueError:
        _fail(f"{path} must be a sha256 identity")
    return value


def _state_values(root: Path) -> list[tuple[float, float, float]]:
    path = root / "m_initial.json"
    payload = _json(path)
    if payload.get("observable") != "m":
        _fail(f"{root}: m_initial.json observable must be m")
    raw = payload.get("values")
    if not isinstance(raw, list) or not raw:
        _fail(f"{root}: m_initial.json values are required")
    values: list[tuple[float, float, float]] = []
    for index, vector in enumerate(raw):
        if not isinstance(vector, list) or len(vector) != 3:
            _fail(f"{root}: m_initial.json values[{index}] must be a 3-vector")
        values.append(
            tuple(
                _finite(component, f"{root} m_initial.json values[{index}][{axis}]")
                for axis, component in enumerate(vector)
            )
        )
    return values


def _validate_state_sidecars(
    root: Path,
    sample_index: int,
    diagnostics: dict[str, Any],
    sample_count: int,
) -> dict[str, str]:
    """Bind accepted v6 state sidecars to the sample diagnostic identities."""

    names = {
        "equilibrium_artifact_sha256": (
            "equilibrium_artifact.v6.json",
            "equilibrium_artifact.v6",
            "accepted_for_linearization",
        ),
        "linearization_state_sha256": (
            "linearization_state.v6.json",
            "LinearizationState.v6",
            "accepted_for_frequency_operator",
        ),
    }
    result: dict[str, str] = {}
    for digest_key, (basename, schema, acceptance_key) in names.items():
        sample_path = root / "eigen" / "metadata" / f"sample_{sample_index:04d}" / basename
        candidates = [sample_path]
        if sample_count == 1:
            candidates.append(root / "eigen" / "metadata" / basename)
        path = next((candidate for candidate in candidates if candidate.is_file()), None)
        if path is None:
            _fail(f"{root}: sample {sample_index} is missing {basename}")
        payload = _json(path)
        if payload.get("schema_version") != schema:
            _fail(f"{path}: unexpected schema_version")
        if payload.get(acceptance_key) is not True:
            _fail(f"{path}: {acceptance_key}=true is required")
        expected_digest = _sha256_identity(
            diagnostics.get(digest_key), f"{root} sample {sample_index} {digest_key}"
        )
        if payload.get("content_sha256") != expected_digest:
            _fail(f"{path}: content_sha256 does not match {digest_key}")
        result[digest_key] = str(path.relative_to(root))
    return result


def _native_operator_contract(diagnostics: dict[str, Any], root: Path) -> dict[str, Any]:
    """Validate the identity and residual contract for one native sample."""

    expected_strings = {
        "assembly_kind": "mfem_weak_form_shared_domain",
        "demag_kind": "periodic_airbox_k0",
        "matrix_equation": "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q",
        "physics_contract_version": "micromagnetics_frequency_domain_v5",
        "operator_dictionary_version": "FrequencyOperatorDictionary.v1",
        "phasor_convention": "exp_plus_i_omega_t",
        "eigenvalue_mapping": "lambda_imag_positive_frequency",
        "outer_boundary_kind": "poisson_robin",
        "gauge_policy": "none",
        "gauge_reason": "coercive_outer_boundary",
    }
    for key, expected in expected_strings.items():
        if diagnostics.get(key) != expected:
            _fail(f"{root}: native operator contract {key} must be {expected!r}")
    if diagnostics.get("production_implication") is not True:
        _fail(f"{root}: native operator contract must carry production_implication=true")
    q_dof_count = _positive_integer(diagnostics.get("q_dof_count"), f"{root} q_dof_count")
    phi_dof_count = _positive_integer(
        diagnostics.get("phi_dof_count"), f"{root} phi_dof_count"
    )
    robin_beta = _finite(diagnostics.get("robin_beta"), f"{root} robin_beta")
    if robin_beta <= 0.0:
        _fail(f"{root}: robin_beta must be positive")
    boundary = diagnostics.get("boundary_gauge")
    if not isinstance(boundary, dict):
        _fail(f"{root}: boundary_gauge is required")
    if boundary.get("magnetostatic_bc") != "periodic_airbox_k0":
        _fail(f"{root}: boundary_gauge magnetostatic_bc is not periodic_airbox_k0")
    if boundary.get("outer_boundary_kind") != "poisson_robin":
        _fail(f"{root}: boundary_gauge outer_boundary_kind is not poisson_robin")
    if boundary.get("gauge_policy") != "none":
        _fail(f"{root}: boundary_gauge gauge_policy is not none")
    if boundary.get("gauge_reason") != "coercive_outer_boundary":
        _fail(f"{root}: boundary_gauge gauge_reason is not coercive_outer_boundary")
    if boundary.get("robin_beta_unit") != "1/m":
        _fail(f"{root}: boundary_gauge robin_beta_unit must be 1/m")
    boundary_beta = _finite(boundary.get("robin_beta"), f"{root} boundary_gauge.robin_beta")
    if abs(boundary_beta - robin_beta) > max(1.0e-15, 1.0e-12 * robin_beta):
        _fail(f"{root}: flat and nested Robin coefficients differ")

    block = diagnostics.get("block_residuals")
    if not isinstance(block, dict):
        _fail(f"{root}: block_residuals is required")
    residuals = {
        key: _nonnegative_finite(block.get(key), f"{root} block_residuals.{key}")
        for key in ("eps_q", "eps_phi", "eps_gauge", "eps_full")
    }
    tolerance = _finite(
        block.get("certification_tolerance"),
        f"{root} block_residuals.certification_tolerance",
    )
    if tolerance <= 0.0 or block.get("certified") is not True:
        _fail(f"{root}: block residuals are not certified")
    if any(value > tolerance for value in residuals.values()):
        _fail(f"{root}: a block residual exceeds certification_tolerance")
    certification = diagnostics.get("certification")
    if not isinstance(certification, dict) or certification.get("full_residual_certified") is not True:
        _fail(f"{root}: full residual certification is required")

    action_count = _positive_integer(
        diagnostics.get("action_residual_evaluated_count"),
        f"{root} action_residual_evaluated_count",
    )
    accepted_count = _positive_integer(
        diagnostics.get("full_residual_accepted_count"),
        f"{root} full_residual_accepted_count",
    )
    identity = {
        key: _sha256_identity(diagnostics.get(key), f"{root} {key}")
        for key in (
            "periodic_mesh_certificate_sha256",
            "periodic_modal_equivalence_map_binding_sha256",
            "operator_input_signature_sha256",
            "phase_constraint_sha256",
            "equilibrium_artifact_sha256",
            "linearization_state_sha256",
        )
    }
    return {
        "assembly_kind": diagnostics["assembly_kind"],
        "demag_kind": diagnostics["demag_kind"],
        "matrix_equation": diagnostics["matrix_equation"],
        "physics_contract_version": diagnostics["physics_contract_version"],
        "operator_dictionary_version": diagnostics["operator_dictionary_version"],
        "phasor_convention": diagnostics["phasor_convention"],
        "eigenvalue_mapping": diagnostics["eigenvalue_mapping"],
        "outer_boundary_kind": diagnostics["outer_boundary_kind"],
        "gauge_policy": diagnostics["gauge_policy"],
        "gauge_reason": diagnostics["gauge_reason"],
        "q_dof_count": q_dof_count,
        "phi_dof_count": phi_dof_count,
        "robin_beta": robin_beta,
        "residual_tolerance": tolerance,
        **identity,
    }


def _sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _resolved_device(manifest: dict[str, Any], expected: str, root: Path) -> dict[str, Any]:
    requested = manifest.get("requested_execution")
    resolved = manifest.get("resolved_execution")
    if not isinstance(requested, dict) or not isinstance(resolved, dict):
        _fail(f"{root}: requested_execution and resolved_execution are required")
    if requested.get("backend") != "fem" or requested.get("device") != expected:
        _fail(f"{root}: requested execution is not strict FEM {expected}")
    if requested.get("precision") != "double" or requested.get("include_demag") is not True:
        _fail(f"{root}: requested execution is not double-precision dynamic-demag")
    if resolved.get("backend") != "fem" or resolved.get("device") != expected:
        _fail(f"{root}: resolved execution is not FEM {expected}")
    if resolved.get("precision") != "double":
        _fail(f"{root}: resolved precision is not double")
    valid_engines = {
        "cpu": {
            "cpu_slepc_schur_targeted",
            "k0_poisson_airbox_cpu_petsc_slepc",
        },
        "gpu": {
            "gpu_petsc_slepc_cuda",
            "k0_poisson_airbox_gpu_petsc_slepc",
        },
    }[expected]
    if resolved.get("engine") not in valid_engines:
        _fail(f"{root}: resolved engine is not a K0 Poisson-airbox engine")
    expected_implementation = f"k0_poisson_airbox_{expected}_schur_slepc" if expected == "cpu" else "k0_poisson_airbox_gpu_petsc_slepc"
    implementation = resolved.get("implementation_id")
    if implementation is not None and implementation != expected_implementation:
        _fail(f"{root}: resolved implementation_id is not {expected_implementation!r}")
    if resolved.get("fallback_used") is True:
        _fail(f"{root}: fallback_used=true")
    if resolved.get("status") not in (None, "ok", "ready", "complete"):
        _fail(f"{root}: resolved execution status is {resolved.get('status')!r}")
    return resolved


def _sample_diagnostics(diagnostics: dict[str, Any], root: Path) -> dict[int, dict[str, Any]]:
    raw = diagnostics.get("sample_solver_diagnostics")
    if not isinstance(raw, list) or not raw:
        _fail(f"{root}: sample_solver_diagnostics is required")
    result: dict[int, dict[str, Any]] = {}
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            _fail(f"{root}: sample_solver_diagnostics[{index}] must be an object")
        sample_index = item.get("sample_index")
        if isinstance(sample_index, bool) or not isinstance(sample_index, int) or sample_index < 0:
            _fail(f"{root}: sample_solver_diagnostics[{index}].sample_index is invalid")
        if sample_index in result:
            _fail(f"{root}: duplicate sample diagnostic {sample_index}")
        nested = item.get("diagnostics")
        if not isinstance(nested, dict):
            _fail(f"{root}: sample {sample_index} is missing diagnostics")
        result[sample_index] = nested
    return result


def _bundle(root: Path, expected_device: str) -> dict[str, Any]:
    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    spectrum_path = root / "eigen" / "spectrum.v2.json"
    diagnostics_path = root / "eigen" / "diagnostics" / "solver.v1.json"
    manifest = _json(manifest_path)
    if manifest.get("schema_version") != "frequency_domain_manifest.v1":
        _fail(f"{root}: unexpected manifest schema")
    if manifest.get("study_product") != "modal_eigen":
        _fail(f"{root}: study_product must be modal_eigen")
    physics = manifest.get("physics")
    if not isinstance(physics, dict):
        _fail(f"{root}: manifest.physics is required")
    validation = manifest.get("validation")
    if not isinstance(validation, dict):
        _fail(f"{root}: validation object is required")
    kittel = validation.get("k0_kittel_validation")
    if isinstance(kittel, dict):
        if kittel.get("demag_kind") != "periodic_airbox_k0":
            _fail(f"{root}: periodic_airbox_k0 validation scope is required")
        if physics.get("spin_wave_bc") != "periodic":
            _fail(f"{root}: periodic spin-wave physics is required")
    else:
        # The direct production fixture intentionally carries no analytical
        # Kittel payload.  It is still a valid parity subject when the
        # manifest identifies the exact shared-domain production scope.  Do
        # not synthesize a validation object here: the native operator and
        # residual checks below remain the authority for this lane.
        if manifest.get("validated_scope") not in {
            "fem_k0_periodic_airbox_p1_double_cpu_slepc",
            "fem_k0_periodic_airbox_p1_double_gpu_device_krylov",
        }:
            _fail(
                f"{root}: either a periodic_airbox_k0 Kittel validation scope "
                "or an exact direct-production validated_scope is required"
            )
    resolved = _resolved_device(manifest, expected_device, root)
    spectrum = _json(spectrum_path)
    spectrum_phase_convention = spectrum.get("phase_convention")
    if spectrum_phase_convention is None and not isinstance(kittel, dict):
        # Direct production spectrum stores the convention on every accepted
        # mode rather than duplicating it at the document root.
        mode_conventions = {
            mode.get("phasor_convention")
            for sample in spectrum.get("samples", [])
            if isinstance(sample, dict)
            for mode in sample.get("modes", [])
            if isinstance(mode, dict)
        }
        if len(mode_conventions) == 1:
            spectrum_phase_convention = next(iter(mode_conventions))
    if spectrum_phase_convention not in {
        "exp_minus_i_k_dot_delta_r",
        "exp_plus_i_k_dot_delta_r",
        "exp_plus_i_omega_t",
        "exp_i_omega_t",
    }:
        _fail(f"{root}: unsupported modal phasor convention")
    samples = spectrum.get("samples")
    if not isinstance(samples, list) or not samples:
        _fail(f"{root}: spectrum samples are required")
    diagnostics = _json(diagnostics_path)
    if diagnostics.get("production_periodic_airbox_claim") is not True:
        _fail(f"{root}: production_periodic_airbox_claim must be true")
    if diagnostics.get("execution_lane") != f"production_{expected_device}":
        _fail(f"{root}: diagnostics execution lane does not match {expected_device}")
    sample_diagnostics = _sample_diagnostics(diagnostics, root)
    equilibrium_state = _state_values(root)
    state_sidecars = {
        sample_index: _validate_state_sidecars(
            root,
            sample_index,
            nested,
            len(sample_diagnostics),
        )
        for sample_index, nested in sample_diagnostics.items()
    }
    operator_contracts = [
        _native_operator_contract(nested, root)
        for nested in sample_diagnostics.values()
    ]
    varying_per_sample_keys = {
        "operator_input_signature_sha256",
        "phase_constraint_sha256",
        "equilibrium_artifact_sha256",
        "linearization_state_sha256",
    }
    operator_contract = {
        key: value
        for key, value in operator_contracts[0].items()
        if key not in varying_per_sample_keys
    }
    if any(
        {
            key: value
            for key, value in contract.items()
            if key not in varying_per_sample_keys
        }
        != operator_contract
        for contract in operator_contracts[1:]
    ):
        _fail(f"{root}: native operator identity or residual contract changes between samples")
    residual_contracts = {
        sample_index: {
            key: nested["block_residuals"][key]
            for key in ("eps_q", "eps_phi", "eps_gauge", "eps_full")
        }
        | {
            "action_residual_evaluated_count": nested["action_residual_evaluated_count"],
            "full_residual_accepted_count": nested["full_residual_accepted_count"],
        }
        for sample_index, nested in sample_diagnostics.items()
    }
    if expected_device == "gpu":
        for sample_index, nested in sample_diagnostics.items():
            transfer = nested.get("device_transfer_audit")
            if not isinstance(transfer, dict):
                _fail(f"{root}: sample {sample_index} is missing device_transfer_audit")
            if nested.get("fallback_used") is True or nested.get("cpu_fallback") not in (None, "disabled"):
                _fail(f"{root}: sample {sample_index} reports a CPU fallback")
            if transfer.get("device_resident_claim") is not True:
                _fail(f"{root}: sample {sample_index} lacks device_resident_claim")
            for key in ("hot_loop_h2d_bytes", "hot_loop_d2h_bytes", "hot_loop_host_sync_count"):
                if _finite(transfer.get(key), f"{root} sample {sample_index} {key}") != 0.0:
                    _fail(f"{root}: sample {sample_index} has non-zero {key}")

    normalized_samples: dict[int, list[dict[str, float]]] = {}
    for index, sample in enumerate(samples):
        if not isinstance(sample, dict):
            _fail(f"{root}: spectrum samples[{index}] must be an object")
        sample_index = sample.get("sample_index", index)
        if isinstance(sample_index, bool) or not isinstance(sample_index, int) or sample_index < 0:
            _fail(f"{root}: spectrum samples[{index}].sample_index is invalid")
        modes = sample.get("modes")
        if not isinstance(modes, list) or not modes:
            _fail(f"{root}: spectrum sample {sample_index} has no modes")
        if sample_index in normalized_samples:
            _fail(f"{root}: duplicate spectrum sample {sample_index}")
        normalized_modes: list[dict[str, float]] = []
        for mode_index, mode in enumerate(modes):
            if not isinstance(mode, dict):
                _fail(f"{root}: sample {sample_index} mode {mode_index} must be an object")
            frequency = mode.get("frequency_hz", mode.get("frequency_real_hz"))
            residual = mode.get("residual_relative_l2", mode.get("residual_norm"))
            normalized_modes.append(
                {
                    "frequency_hz": _finite(frequency, f"{root} sample {sample_index} mode {mode_index} frequency"),
                    "residual": _finite(residual, f"{root} sample {sample_index} mode {mode_index} residual"),
                }
            )
        normalized_samples[sample_index] = normalized_modes

    return {
        "root": str(root),
        "manifest_sha256": _sha256(manifest_path),
        "spectrum_sha256": _sha256(spectrum_path),
        "resolved_execution": resolved,
        "operator_contract": operator_contract,
        "sample_operator_contracts": {
            sample_index: contract
            for sample_index, contract in zip(sample_diagnostics, operator_contracts, strict=True)
        },
        "residual_contracts": residual_contracts,
        "samples": normalized_samples,
        "sample_diagnostics": sample_diagnostics,
        "equilibrium_state": equilibrium_state,
        "state_sidecars": state_sidecars,
    }


def compare_bundles(
    cpu_root: Path,
    gpu_root: Path,
    *,
    frequency_relative_tolerance: float = 1.0e-8,
    residual_absolute_tolerance: float = 1.0e-8,
    state_absolute_tolerance: float = 1.0e-9,
) -> dict[str, Any]:
    if (
        frequency_relative_tolerance <= 0.0
        or residual_absolute_tolerance <= 0.0
        or state_absolute_tolerance <= 0.0
    ):
        _fail("parity tolerances must be positive")
    cpu = _bundle(cpu_root, "cpu")
    gpu = _bundle(gpu_root, "gpu")
    if cpu["operator_contract"] != gpu["operator_contract"]:
        _fail("CPU/GPU operator identity or residual contract differs")
    if set(cpu["samples"]) != set(gpu["samples"]):
        _fail("CPU and GPU sample indices differ")
    max_frequency_abs = 0.0
    max_frequency_relative = 0.0
    max_residual_abs = 0.0
    max_block_residual_abs = 0.0
    max_state_component_abs = 0.0
    max_state_vector_l2 = 0.0
    if len(cpu["equilibrium_state"]) != len(gpu["equilibrium_state"]):
        _fail("CPU and GPU accepted equilibrium state sizes differ")
    for index, (cpu_vector, gpu_vector) in enumerate(
        zip(cpu["equilibrium_state"], gpu["equilibrium_state"], strict=True)
    ):
        component_delta = max(
            abs(cpu_vector[axis] - gpu_vector[axis]) for axis in range(3)
        )
        vector_delta = math.sqrt(
            sum((cpu_vector[axis] - gpu_vector[axis]) ** 2 for axis in range(3))
        )
        max_state_component_abs = max(max_state_component_abs, component_delta)
        max_state_vector_l2 = max(max_state_vector_l2, vector_delta)
        if component_delta > state_absolute_tolerance:
            _fail(
                f"accepted equilibrium state node {index} component difference "
                f"{component_delta:.3e} exceeds {state_absolute_tolerance:.3e}"
            )
    comparison_count = 0
    lane_specific_identity_keys = {
        "phase_constraint_sha256",
        "equilibrium_artifact_sha256",
        "linearization_state_sha256",
    }
    for sample_index in sorted(cpu["samples"]):
        cpu_sample_contract = cpu["sample_operator_contracts"].get(sample_index)
        gpu_sample_contract = gpu["sample_operator_contracts"].get(sample_index)
        if cpu_sample_contract is None or gpu_sample_contract is None:
            _fail(f"sample {sample_index}: CPU/GPU operator identity is missing")
        if cpu_sample_contract["operator_input_signature_sha256"] != gpu_sample_contract[
            "operator_input_signature_sha256"
        ]:
            _fail(f"sample {sample_index}: CPU/GPU operator input signature differs")
        cpu_lane_independent = {
            key: value
            for key, value in cpu_sample_contract.items()
            if key not in lane_specific_identity_keys | {"operator_input_signature_sha256"}
        }
        gpu_lane_independent = {
            key: value
            for key, value in gpu_sample_contract.items()
            if key not in lane_specific_identity_keys | {"operator_input_signature_sha256"}
        }
        if cpu_lane_independent != gpu_lane_independent:
            _fail(f"sample {sample_index}: CPU/GPU operator identity differs")
        cpu_modes = cpu["samples"][sample_index]
        gpu_modes = gpu["samples"][sample_index]
        for key in ("eps_q", "eps_phi", "eps_gauge", "eps_full"):
            block_delta = abs(
                cpu["residual_contracts"][sample_index][key]
                - gpu["residual_contracts"][sample_index][key]
            )
            max_block_residual_abs = max(max_block_residual_abs, block_delta)
            if block_delta > residual_absolute_tolerance:
                _fail(
                    f"sample {sample_index}: {key} difference {block_delta:.3e} "
                    f"exceeds {residual_absolute_tolerance:.3e}"
                )
        if len(cpu_modes) != len(gpu_modes):
            _fail(f"sample {sample_index}: CPU/GPU mode counts differ")
        for mode_index, (cpu_mode, gpu_mode) in enumerate(zip(cpu_modes, gpu_modes)):
            cpu_frequency = cpu_mode["frequency_hz"]
            gpu_frequency = gpu_mode["frequency_hz"]
            frequency_abs = abs(cpu_frequency - gpu_frequency)
            frequency_relative = frequency_abs / max(abs(cpu_frequency), abs(gpu_frequency), 1.0)
            max_frequency_abs = max(max_frequency_abs, frequency_abs)
            max_frequency_relative = max(max_frequency_relative, frequency_relative)
            if frequency_relative > frequency_relative_tolerance:
                _fail(f"sample {sample_index} mode {mode_index}: frequency relative error {frequency_relative:.3e} exceeds {frequency_relative_tolerance:.3e}")
            residual_abs = abs(cpu_mode["residual"] - gpu_mode["residual"])
            max_residual_abs = max(max_residual_abs, residual_abs)
            if residual_abs > residual_absolute_tolerance:
                _fail(f"sample {sample_index} mode {mode_index}: residual difference {residual_abs:.3e} exceeds {residual_absolute_tolerance:.3e}")
            comparison_count += 1
    return {
        "schema_version": "fem_k0_modal_cpu_gpu_parity.v1",
        "status": "passed",
        "cpu": {"bundle": str(cpu_root), "manifest_sha256": cpu["manifest_sha256"], "spectrum_sha256": cpu["spectrum_sha256"]},
        "gpu": {"bundle": str(gpu_root), "manifest_sha256": gpu["manifest_sha256"], "spectrum_sha256": gpu["spectrum_sha256"]},
        "comparison_count": comparison_count,
        "sample_count": len(cpu["samples"]),
        "max_frequency_absolute_hz": max_frequency_abs,
        "max_frequency_relative": max_frequency_relative,
        "max_residual_absolute": max_residual_abs,
        "max_block_residual_absolute": max_block_residual_abs,
        "max_equilibrium_component_absolute": max_state_component_abs,
        "max_equilibrium_vector_l2": max_state_vector_l2,
        "tolerances": {
            "frequency_relative": frequency_relative_tolerance,
            "residual_absolute": residual_absolute_tolerance,
            "state_absolute": state_absolute_tolerance,
        },
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cpu", type=Path, required=True)
    parser.add_argument("--gpu", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--frequency-relative-tolerance", type=float, default=1.0e-8)
    parser.add_argument("--residual-absolute-tolerance", type=float, default=1.0e-8)
    parser.add_argument("--state-absolute-tolerance", type=float, default=1.0e-9)
    args = parser.parse_args(argv)
    try:
        result = compare_bundles(
            args.cpu,
            args.gpu,
            frequency_relative_tolerance=args.frequency_relative_tolerance,
            residual_absolute_tolerance=args.residual_absolute_tolerance,
            state_absolute_tolerance=args.state_absolute_tolerance,
        )
        payload = json.dumps(result, indent=2, sort_keys=True) + "\n"
        if args.output is not None:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(payload, encoding="utf-8")
        print(payload, end="")
    except (OSError, ParityError) as exc:
        print(f"invalid FEM K0 CPU/GPU parity: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
