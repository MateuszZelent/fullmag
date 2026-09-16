#!/usr/bin/env python3
"""Fail-closed scientific gate for the COMSOL-aligned FEM dispersion run.

The managed runner is responsible for source/runtime identity and for checking
that the expected files were written.  This module is the separate scientific
gate.  It consumes the numeric FEM artifacts, recomputes the analytic control
values from the canonical SI parameter file, and requires an explicitly
bound evidence bundle for the mesh, airbox, and requested-mode-count checks.

An analytic reference is allowed as a comparison oracle, but it can never be
accepted as the source of the FEM frequencies.  Missing or incomplete evidence
is reported as ``NOT VERIFIED`` rather than being inferred from file presence.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence

from comsol_n0_field_certificate import measure_n0_field
from verify_fem_frequency_domain_eigen_artifacts import (
    p00_demag_factor,
    require_kalinikos_slab_n0_material_and_bias,
    validate_mode_diagnostics_fields,
)


GATE_SCHEMA = "fullmag.comsol-dispersion-scientific-gate.v2"
EVIDENCE_SCHEMA = "fullmag.comsol-dispersion-scientific-evidence.v2"
EVIDENCE_RELATIVE_PATH = Path("validation/scientific_gate.v1.json")
EXPECTED_CASES = ("c0", "c1", "a1")
PATH_CASES = frozenset(("c1", "a1"))
EXPECTED_PATH_SAMPLE_COUNT = 61
EXPECTED_TARGET_BANDS = 8
EXPECTED_CONTROL_SAMPLES = (0, 10, 20, 30, 40, 50, 60)
KITTEL_RELATIVE_TOLERANCE = 1.0e-3
# Independently verified (see scripts/test_validate_comsol_dispersion_scientific_gate.py
# and the audit note below) with the Kalinikos-Slavin n=0 formula: across the C1
# benchmark's Gamma-X segment (pure backward-volume geometry, k parallel to M), the
# physical dispersion excursion is only ~1.4649% (9.2428 GHz at Gamma-adjacent low-k
# to 9.3782 GHz at X, both slightly below the Gamma value due to the small
# demagnetizing dip before exchange stiffening dominates). A 2.0e-2 (2%) tolerance is
# therefore LARGER than the entire physical signal it is meant to gate: a solver that
# returns a k-independent (flat) frequency at every sample would pass unnoticed. This
# value is chosen to sit at roughly 1/5 of the smallest branch excursion (comfortably
# under the audit's suggested 1/4-1/3 ceiling) while remaining 3x looser than
# KITTEL_RELATIVE_TOLERANCE to allow for legitimate FEM discretization/mesh noise
# accumulated across 61 k-samples and off-axis propagation angles (the single-point
# Gamma Kittel check has no such accumulation).
KS_RELATIVE_TOLERANCE = 3.0e-3
KS_FREQUENCY_CONTINUITY_TOLERANCE = 2.0 * KS_RELATIVE_TOLERANCE
# Independently verified with the finite-Dirichlet-box demagnetizing-factor model
# Nz = 1 - t/(t + 2*a) (t = film thickness, a = airbox half-height): for the C1
# benchmark parameters, the modeled frequency shift between successive airbox sizes
# is ~1.133e-3 (1um->2um) and ~5.675e-4 (2um->4um). The prior 5.0e-3 tolerance is
# therefore looser than the smallest real, modeled convergence increment, so a solver
# with literally no dependence on airbox height (or one whose dependence differs from
# the modeled physics by an amount comparable to or larger than the true effect) would
# still silently pass. 2.0e-4 sits comfortably below the smallest modeled increment
# (~1/3 of 5.675e-4) while leaving headroom for real discretization noise on top of
# the modeled airbox effect.
CONVERGENCE_RELATIVE_TOLERANCE = 2.0e-4
MAX_IMAGINARY_TO_REAL_RATIO = 1.0e-6
MAX_TANGENT_LEAKAGE = 1.0e-6
MAX_EIGEN_RESIDUAL = 1.0e-6
# Keep the scientific gate aligned with the independently recomputed Bloch
# field certificate.  A looser value here would allow a field to pass the
# bundle-level gate after the certificate has rejected the same phase error.
MAX_PHASE_RESIDUAL = 1.0e-8
NUMERIC_FREQUENCY_SOURCE = "numeric_modal_solver_with_analytic_comparison"
PRODUCTION_SOLVER_MODEL = "slepc_multi_shift_invert_production_cpu_dense"
PRODUCTION_SOLVER_MODELS = frozenset(
    {
        # Historical public token retained for existing bundles.
        PRODUCTION_SOLVER_MODEL,
        # Current native PETSc/SLEPc payload identifies the sparse CSR
        # operator actually handed to the managed CPU adapter.
        "slepc_multi_shift_invert_production_cpu_sparse_csr",
        # Native shared-domain production adapters used by the demagnetizing
        # C1/A1 lanes.
        "floquet_airbox_cpu_schur_slepc",
        "k0_poisson_airbox_cpu_schur_slepc",
        "k0_poisson_airbox_cpu_full_coupled_slepc",
    }
)
_REQUIRED_ARTIFACTS = (
    Path("metadata.json"),
    Path("eigen/spectrum.v2.json"),
    Path("eigen/branches.v2.json"),
    Path("eigen/dispersion.csv"),
    Path("frequency_domain/manifest.v1.json"),
    Path("eigen/diagnostics/solver.v1.json"),
)


class ScientificGateError(RuntimeError):
    """Raised only for invalid direct API arguments, never for failed gates."""


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _finite_positive(value: object) -> bool:
    return _finite(value) and float(value) > 0.0


def _relative_error(actual: float, expected: float) -> float:
    scale = max(abs(actual), abs(expected), 1.0e-30)
    return abs(actual - expected) / scale


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_json(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        return None, f"cannot read valid JSON from {path}: {error}"
    if not isinstance(value, dict):
        return None, f"JSON root must be an object: {path}"
    return value, None


def _nested(value: Mapping[str, Any], *keys: str) -> object:
    current: object = value
    for key in keys:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def _is_production_solver_model(value: object) -> bool:
    return isinstance(value, str) and value in PRODUCTION_SOLVER_MODELS


def _number(value: object, label: str, reasons: list[str]) -> float | None:
    if not _finite(value):
        reasons.append(f"{label} is missing or non-finite")
        return None
    return float(value)


def _path_rows(kpath_path: Path) -> tuple[dict[int, tuple[float, float, float]], list[str]]:
    expected: dict[int, tuple[float, float, float]] = {}
    reasons: list[str] = []
    try:
        with kpath_path.open("r", encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                try:
                    index = int(row["jpath"])
                    vector = tuple(float(row[key]) for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m"))
                except (KeyError, TypeError, ValueError) as error:
                    reasons.append(f"canonical k-path contains an invalid row: {error}")
                    continue
                if len(vector) != 3 or not all(math.isfinite(item) for item in vector):
                    reasons.append(f"canonical k-path sample {index} is non-finite")
                    continue
                expected[index] = vector  # type: ignore[assignment]
    except OSError as error:
        reasons.append(f"cannot read canonical k-path {kpath_path}: {error}")
    return expected, reasons


def _load_parameters(parameters_path: Path) -> tuple[dict[str, Any] | None, list[str]]:
    value, error = _load_json(parameters_path)
    if error:
        return None, [error]
    assert value is not None
    required = (
        ("geometry", "film_thickness_m"),
        ("geometry", "air_padding_each_side_m"),
        ("material", "Ms_A_per_m"),
        ("material", "Aex_J_per_m"),
        ("material", "mu0_H_per_m"),
        ("material", "gamma0_m_per_A_s"),
        ("bias_H_A_per_m",),
        ("controls_infinite_film_hz", "no_demag_gamma"),
        ("controls_finite_dirichlet_box", "with_demag_gamma_hz"),
    )
    reasons = []
    for keys in required:
        if _nested(value, *keys) is None:
            reasons.append(f"canonical parameters are missing {'.'.join(keys)}")
    return value, reasons


def _metadata_benchmark_block(metadata: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Return the benchmark contract emitted by the native metadata writer.

    ``metadata.json`` is produced by the runner from ``ProblemIR``.  The
    benchmark authoring contract is therefore read from its real
    ``problem_meta.runtime_metadata`` location; a validator-local copy of the
    material or geometry is deliberately not accepted as provenance.
    """

    runtime = _nested(metadata, "problem_meta", "runtime_metadata")
    if isinstance(runtime, Mapping):
        value = runtime.get("comsol_nonzero_k_dispersion")
        if isinstance(value, Mapping):
            return value
    return None


def _metadata_backend_plan(metadata: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Return the resolved FEM eigen plan emitted by the native runner."""

    value = _nested(metadata, "execution_plan", "backend_plan")
    return value if isinstance(value, Mapping) else None


def _backend_airbox_value(plan: Mapping[str, Any]) -> float | None:
    """Resolve symmetric z padding in metres from the actual domain bounds.

    AirBoxConfig.factor is dimensionless authoring intent, not a measurement
    of the generated domain. This benchmark requires equal padding both sides.
    """
    frame = plan.get("domain_frame")
    if not isinstance(frame, Mapping):
        return None
    bounds = [frame.get(name) for name in (
        "object_bounds_min", "object_bounds_max", "mesh_bounds_min", "mesh_bounds_max",
    )]
    if any(not isinstance(bound, list) or len(bound) != 3 or not all(_finite(value) for value in bound) for bound in bounds):
        return None
    object_min, object_max, mesh_min, mesh_max = bounds
    if any(float(hi) <= float(lo) for lo, hi in zip(object_min, object_max)) or any(float(hi) <= float(lo) for lo, hi in zip(mesh_min, mesh_max)):
        return None
    below = float(object_min[2]) - float(mesh_min[2])
    above = float(mesh_max[2]) - float(object_max[2])
    if not _finite_positive(below) or not _finite_positive(above):
        return None
    if abs(below - above) > 1e-8 * max(below, above):
        return None
    return 0.5 * (below + above)


def _backend_mesh_hmax(plan: Mapping[str, Any]) -> float | None:
    for candidate in (
        plan.get("hmax"),
        _nested(plan, "mesh", "hmax"),
        _nested(plan, "mesh", "maximum_element_size"),
        _nested(plan, "mesh", "interface_hmax"),
    ):
        if _finite_positive(candidate):
            return float(candidate)
    return None


def _validate_resolved_backend_plan(
    metadata: Mapping[str, Any],
    case: str,
    parameters: Mapping[str, Any],
    label: str,
    reasons: list[str],
    *,
    require_uniform_slab: bool,
    allow_airbox_change: bool,
) -> bool:
    """Bind the gate to resolved producer metadata rather than authoring flags."""

    plan = _metadata_backend_plan(metadata)
    if plan is None:
        reasons.append(f"{label} lacks metadata.execution_plan.backend_plan from the native runner")
        return False
    valid = True
    if plan.get("kind") != "fem_eigen":
        reasons.append(f"{label} backend_plan.kind is not fem_eigen")
        valid = False
    canonical_material = parameters.get("material")
    canonical_bias = parameters.get("bias_H_A_per_m")
    if not isinstance(canonical_material, Mapping) or not isinstance(canonical_bias, list):
        reasons.append("canonical parameters cannot provide the resolved backend signature")
        return False
    material = plan.get("material")
    if not isinstance(material, Mapping):
        reasons.append(f"{label} backend_plan.material is missing")
        valid = False
    else:
        for actual_field, canonical_field in (
            ("saturation_magnetisation", "Ms_A_per_m"),
            ("exchange_stiffness", "Aex_J_per_m"),
        ):
            if not _require_metadata_number(
                material.get(actual_field),
                canonical_material.get(canonical_field),
                f"{label}.backend_plan.material.{actual_field}",
                reasons,
            ):
                valid = False
        if material.get("interfacial_dmi") not in (None, 0, 0.0) or material.get("bulk_dmi") not in (None, 0, 0.0):
            reasons.append(f"{label} resolved material enables DMI")
            valid = False
        if any(
            material.get(field) not in (None, 0, 0.0)
            for field in ("uniaxial_anisotropy", "uniaxial_anisotropy_k2", "cubic_anisotropy_kc1", "cubic_anisotropy_kc2", "cubic_anisotropy_kc3")
        ):
            reasons.append(f"{label} resolved material enables anisotropy")
            valid = False
    if not _require_metadata_number(
        plan.get("gyromagnetic_ratio"),
        canonical_material.get("gamma0_m_per_A_s"),
        f"{label}.backend_plan.gyromagnetic_ratio",
        reasons,
    ):
        valid = False
    external_field = plan.get("external_field")
    if not isinstance(external_field, list) or len(external_field) != 3 or len(canonical_bias) != 3:
        reasons.append(f"{label} backend_plan.external_field must be a length-3 vector")
        valid = False
    else:
        for index, (actual, expected) in enumerate(zip(external_field, canonical_bias)):
            if not _require_metadata_number(actual, expected, f"{label}.backend_plan.external_field[{index}]", reasons):
                valid = False
    operator = plan.get("operator")
    expected_demag = case in PATH_CASES
    if not isinstance(operator, Mapping) or operator.get("kind") != "full_2x2" or operator.get("include_demag") is not expected_demag:
        reasons.append(f"{label} backend_plan.operator does not match the {case} full_2x2 demag contract")
        valid = False
    if plan.get("enable_demag") is not expected_demag:
        reasons.append(f"{label} backend_plan.enable_demag does not match case {case}")
        valid = False
    equilibrium = plan.get("equilibrium_magnetization")
    if not isinstance(equilibrium, list) or not equilibrium:
        reasons.append(f"{label} backend_plan.equilibrium_magnetization is missing resolved field samples")
        valid = False
    elif require_uniform_slab:
        for index, vector in enumerate(equilibrium):
            if not isinstance(vector, list) or len(vector) != 3 or not all(_finite(value) for value in vector):
                reasons.append(f"{label} resolved equilibrium vector {index} is invalid")
                valid = False
                continue
            if _relative_error(float(vector[0]), 1.0) > 1.0e-6 or abs(float(vector[1])) > 1.0e-6 or abs(float(vector[2])) > 1.0e-6:
                reasons.append(f"{label} resolved equilibrium is not uniformly x-aligned")
                valid = False
                break
        # Reuse the production oracle's material-field checks.  Scalar
        # saturation/exchange values do not establish a homogeneous slab when
        # the resolved plan also carries spatial overrides such as ms_field or
        # a_field.  The helper deliberately fails closed via SystemExit.
        if valid and isinstance(material, Mapping) and isinstance(equilibrium, list):
            first = equilibrium[0]
            if isinstance(first, list) and len(first) == 3 and all(_finite(value) for value in first):
                norm = math.sqrt(sum(float(value) * float(value) for value in first))
                if norm > 0.0:
                    try:
                        require_kalinikos_slab_n0_material_and_bias(
                            dict(plan),
                            dict(material),
                            tuple(float(value) / norm for value in first),
                        )
                    except (SystemExit, ValueError, TypeError) as error:
                        reasons.append(f"{label} resolved material is outside homogeneous-slab KS applicability: {error}")
                        valid = False
    if plan.get("damping_policy") not in (None, "ignore"):
        reasons.append(f"{label} resolved eigen plan does not disable damping")
        valid = False
    spin_bc = plan.get("spin_wave_bc")
    if expected_demag:
        if not isinstance(spin_bc, Mapping) or spin_bc.get("kind") != "floquet":
            reasons.append(f"{label} resolved spin-wave boundary is not Floquet")
            valid = False
        if plan.get("demag_realization") not in (None, "poisson_dirichlet"):
            reasons.append(f"{label} resolved demag realization is not poisson_dirichlet")
            valid = False
        if _backend_airbox_value(plan) is None:
            reasons.append(f"{label} resolved backend plan has no finite airbox identity")
            valid = False
        frame = plan.get("domain_frame")
        if not isinstance(frame, Mapping):
            reasons.append(f"{label} resolved backend plan has no DomainFrameIR airbox bounds")
            valid = False
        else:
            object_min = frame.get("object_bounds_min")
            object_max = frame.get("object_bounds_max")
            mesh_min = frame.get("mesh_bounds_min")
            mesh_max = frame.get("mesh_bounds_max")
            if not all(
                isinstance(vector, list) and len(vector) == 3 and all(_finite(value) for value in vector)
                for vector in (object_min, object_max, mesh_min, mesh_max)
            ):
                reasons.append(f"{label} DomainFrameIR does not expose finite object and mesh bounds")
                valid = False
            else:
                lower = float(object_min[2]) - float(mesh_min[2])
                upper = float(mesh_max[2]) - float(object_max[2])
                if lower <= 0.0 or upper <= 0.0 or _relative_error(lower, upper) > 1.0e-8:
                    reasons.append(f"{label} DomainFrameIR does not prove symmetric positive z air padding")
                    valid = False
    elif not isinstance(spin_bc, Mapping) or spin_bc.get("kind") not in ("periodic", "periodic_bc"):
        reasons.append(f"{label} resolved C0 spin-wave boundary is not periodic")
        valid = False
    if allow_airbox_change and _backend_airbox_value(plan) is None:
        reasons.append(f"{label} varied airbox run has no resolved airbox value")
        valid = False
    if _backend_mesh_hmax(plan) is None:
        reasons.append(f"{label} resolved backend plan has no finite mesh hmax")
        valid = False
    return valid


def _require_metadata_number(
    value: object,
    expected: object,
    label: str,
    reasons: list[str],
    *,
    tolerance: float = 1.0e-12,
) -> bool:
    if not _finite(value) or not _finite(expected):
        reasons.append(f"{label} is missing or non-finite in native benchmark metadata")
        return False
    if _relative_error(float(value), float(expected)) > tolerance:
        reasons.append(
            f"{label}={float(value)!r} does not match canonical value {float(expected)!r}"
        )
        return False
    return True


def _validate_benchmark_metadata(
    metadata: Mapping[str, Any],
    case: str,
    parameters: Mapping[str, Any],
    label: str,
    reasons: list[str],
    *,
    require_uniform_slab: bool,
    allow_airbox_change: bool = False,
) -> bool:
    """Validate material/geometry/equilibrium from the native metadata graph."""

    benchmark = _metadata_benchmark_block(metadata)
    if benchmark is None:
        reasons.append(f"{label} lacks problem_meta.runtime_metadata.comsol_nonzero_k_dispersion")
        return False
    valid = True
    if benchmark.get("schema_version") != "fullmag.comsol_nonzero_k_benchmark.v1":
        reasons.append(f"{label} has an unsupported benchmark metadata schema")
        valid = False
    if benchmark.get("benchmark_id") != parameters.get("benchmark_id"):
        reasons.append(f"{label} benchmark_id does not match canonical parameters")
        valid = False
    if benchmark.get("case_id") != case:
        reasons.append(f"{label} case_id does not match {case}")
        valid = False

    geometry = benchmark.get("geometry")
    material = benchmark.get("material")
    equilibrium = benchmark.get("equilibrium")
    eigensolve = benchmark.get("eigensolve")
    if not all(isinstance(value, Mapping) for value in (geometry, material, equilibrium, eigensolve)):
        reasons.append(f"{label} is missing native geometry/material/equilibrium/eigensolve metadata")
        return False
    canonical_geometry = parameters.get("geometry")
    canonical_material = parameters.get("material")
    canonical_bias = parameters.get("bias_H_A_per_m")
    if not isinstance(canonical_geometry, Mapping) or not isinstance(canonical_material, Mapping):
        reasons.append("canonical parameters cannot provide a material/geometry signature")
        return False
    if not _validate_resolved_backend_plan(
        metadata,
        case,
        parameters,
        label,
        reasons,
        require_uniform_slab=require_uniform_slab,
        allow_airbox_change=allow_airbox_change,
    ):
        valid = False
    canonical_thickness = canonical_geometry.get("film_thickness_m")
    actual_thickness = geometry.get("film_thickness_m")
    film_size_candidate = geometry.get("film_size_m")
    if actual_thickness is None and isinstance(film_size_candidate, list) and len(film_size_candidate) == 3:
        actual_thickness = film_size_candidate[-1]
    if not _require_metadata_number(actual_thickness, canonical_thickness, f"{label}.geometry.film_thickness_m", reasons):
        valid = False
    airbox = geometry.get("air_padding_each_side_m")
    if allow_airbox_change:
        if not _finite(airbox) or float(airbox) <= 0.0:
            reasons.append(f"{label}.geometry.air_padding_each_side_m must be finite and positive")
            valid = False
    elif not _require_metadata_number(
        airbox,
        canonical_geometry.get("air_padding_each_side_m"),
        f"{label}.geometry.air_padding_each_side_m",
        reasons,
    ):
        valid = False
    if case in PATH_CASES and isinstance(_metadata_backend_plan(metadata), Mapping):
        frame = _metadata_backend_plan(metadata).get("domain_frame")
        if isinstance(frame, Mapping):
            object_min = frame.get("object_bounds_min")
            object_max = frame.get("object_bounds_max")
            mesh_min = frame.get("mesh_bounds_min")
            mesh_max = frame.get("mesh_bounds_max")
            if all(
                isinstance(vector, list) and len(vector) == 3 and all(_finite(value) for value in vector)
                for vector in (object_min, object_max, mesh_min, mesh_max)
            ):
                lower = float(object_min[2]) - float(mesh_min[2])
                upper = float(mesh_max[2]) - float(object_max[2])
                if _finite(airbox) and (_relative_error(lower, float(airbox)) > 1.0e-8 or _relative_error(upper, float(airbox)) > 1.0e-8):
                    reasons.append(f"{label} DomainFrameIR z padding does not match geometry.air_padding_each_side_m")
    film_size = geometry.get("film_size_m")
    thickness = canonical_geometry.get("film_thickness_m")
    if not isinstance(film_size, list) or len(film_size) != 3 or not _finite(film_size[-1]) or not _finite(thickness):
        reasons.append(f"{label}.geometry.film_size_m must expose a finite z thickness")
        valid = False
    elif _relative_error(float(film_size[-1]), float(thickness)) > 1.0e-12:
        reasons.append(f"{label}.geometry.film_size_m[2] does not match canonical film thickness")
        valid = False
    for actual_field, canonical_field in (
        ("Ms_A_per_m", "Ms_A_per_m"),
        ("Aex_J_per_m", "Aex_J_per_m"),
        ("mu0_H_per_m", "mu0_H_per_m"),
        # The public guide calls this gamma_m_per_A_s while the canonical
        # parameter sheet uses the explicit gamma0_m_per_A_s name.
        ("gamma_m_per_A_s", "gamma0_m_per_A_s"),
    ):
        expected = canonical_material.get(canonical_field)
        if not _require_metadata_number(material.get(actual_field), expected, f"{label}.material.{actual_field}", reasons):
            valid = False
    bias = material.get("bias_field_A_per_m")
    if not isinstance(bias, list) or len(bias) != 3 or not isinstance(canonical_bias, list) or len(canonical_bias) != 3:
        reasons.append(f"{label}.material.bias_field_A_per_m must be a canonical length-3 vector")
        valid = False
    else:
        for index, (actual, expected) in enumerate(zip(bias, canonical_bias)):
            if not _require_metadata_number(actual, expected, f"{label}.material.bias_field_A_per_m[{index}]", reasons):
                valid = False
    dmi_disabled = (
        material.get("DMI") is False
        or material.get("dmi") in {"disabled", "off", "none", 0, 0.0}
    )
    surface_anisotropy_disabled = (
        material.get("surface_anisotropy") is False
        or material.get("Ks_surface_A") in (0, 0.0)
    )
    volume_anisotropy_disabled = material.get("K_volume_A_per_m") in (0, 0.0)
    if not dmi_disabled or not surface_anisotropy_disabled or not volume_anisotropy_disabled:
        reasons.append(f"{label} must prove DMI and surface anisotropy are disabled")
        valid = False
    initial_magnetization = equilibrium.get("initial_magnetization")
    if initial_magnetization != [1.0, 0.0, 0.0]:
        reasons.append(f"{label}.equilibrium.initial_magnetization is not the canonical x-aligned state")
        valid = False
    if equilibrium.get("reuse_for_all_k") is not True:
        reasons.append(f"{label}.equilibrium.reuse_for_all_k must be true")
        valid = False
    if eigensolve.get("operator") != "full_2x2" or eigensolve.get("complex_arithmetic") is not True:
        reasons.append(f"{label} does not prove the complex full_2x2 modal operator")
        valid = False
    if eigensolve.get("alpha") != 0 or eigensolve.get("damping_policy") != "ignore":
        reasons.append(f"{label} does not prove the zero-damping eigen solve")
        valid = False
    if require_uniform_slab:
        hole_radius = geometry.get("hole_radius_m")
        if hole_radius is not None:
            reasons.append(f"{label} has a hole and is outside homogeneous-slab analytic applicability")
            valid = False
        if eigensolve.get("magnetostatic_bc") != "floquet_airbox":
            reasons.append(f"{label} does not use the finite Floquet airbox required by C1 KS control")
            valid = False
    if case == "c0" and eigensolve.get("magnetostatic_bc") != "open":
        reasons.append(f"{label} C0 magnetostatic_bc is not open")
        valid = False
    return valid


def _kalinikos_frequency_hz_general_phi(
    k: float,
    sin_squared_phi: float,
    parameters: Mapping[str, Any],
) -> float | None:
    """Kalinikos-Slavin n=0 dipole-exchange dispersion at an arbitrary in-plane
    propagation angle ``phi`` between the wavevector ``k`` and the (in-plane)
    equilibrium magnetization, given here through ``sin_squared_phi = sin(phi)**2``.

    General published form (theta = 90 deg: both M and k in-plane):

        X    = H + omega_M-equivalent exchange field, i.e. (bias + 2*Aex*k^2/(mu0*Ms))
        P00  = p00_demag_factor(k, film_thickness_m)   (0 at k=0, 1 as k*d -> inf)
        F00  = X + Ms*(1 - P00)          (angle-independent factor)
        F90  = X + Ms*P00*sin^2(phi)     (angle-dependent factor)
        omega^2 = F00 * F90

    This reduces EXACTLY (verified numerically to machine precision for many k
    spanning the C1 benchmark's 0..X-point range) to the existing backward-volume
    special case at phi=0 (sin^2(phi)=0, giving omega^2 = X*(X+Ms*(1-P00))) and to
    the existing damon-eshbach special case at phi=pi/2 (sin^2(phi)=1, giving
    omega^2 = (X+Ms*(1-P00))*(X+Ms*P00)) -- i.e. exactly the two dispatched
    formulas this function replaces, for all k, not just in a limit.

    A candidate general formula quoted from an external audit note (of the form
    F00 = P + sin^2(phi)*(1 - P*(1+cos^2(phi)) + omega_M*P*(1-P)*sin^2(phi)/X),
    used as omega^2 = X*(X+omega_M*F00)) was checked numerically against both
    special cases and found NOT to reduce correctly at phi=0 (it collapses to the
    open, no-demag Kittel value instead of the backward-volume value; the diff
    was ~6.5 GHz on this benchmark, nowhere near zero). It was discarded in favor
    of the form implemented here, which does reduce correctly.

    The finite Dirichlet airbox is intentionally not folded into this oracle;
    the angle-independent factor ``F00`` uses the open-film term.
    The finite-airbox offset and its convergence are checked independently by
    the Gamma-point Kittel and airbox controls.  A uniform Nz substitution is
    not an exact finite-airbox Green function, so it must not be presented as a
    nonzero-k analytic reference.
    """
    thickness = _nested(parameters, "geometry", "film_thickness_m")
    ms = _nested(parameters, "material", "Ms_A_per_m")
    aex = _nested(parameters, "material", "Aex_J_per_m")
    mu0 = _nested(parameters, "material", "mu0_H_per_m")
    gamma0 = _nested(parameters, "material", "gamma0_m_per_A_s")
    bias_values = _nested(parameters, "bias_H_A_per_m")
    bias = bias_values[0] if isinstance(bias_values, list) and bias_values else None
    if not all(_finite(value) for value in (k, thickness, ms, aex, mu0, gamma0, bias, sin_squared_phi)):
        return None
    if k < 0.0 or not (-1.0e-9 <= sin_squared_phi <= 1.0 + 1.0e-9):
        return None
    sin_squared_phi = min(max(sin_squared_phi, 0.0), 1.0)
    try:
        p_factor = p00_demag_factor(float(k), float(thickness))
    except ValueError:
        return None
    exchange_field = 2.0 * float(aex) * float(k) * float(k) / (float(mu0) * float(ms))
    common = float(bias) + exchange_field
    angle_independent = common + float(ms) * (1.0 - p_factor)
    angle_dependent = common + float(ms) * p_factor * sin_squared_phi
    if angle_independent <= 0.0 or angle_dependent <= 0.0:
        return None
    return float(gamma0) * math.sqrt(angle_independent * angle_dependent) / (2.0 * math.pi)


def _sin_squared_phi_from_k_vector(vector: Sequence[float]) -> float | None:
    """sin^2(phi) between an in-plane wavevector and the canonical x-aligned
    equilibrium magnetization (validated elsewhere as [1, 0, 0]).  At k=0 the
    angle is undefined but immaterial (both KS factors coincide with the
    Kittel value regardless of phi), so 0.0 is returned.
    """
    if len(vector) != 3 or not all(_finite(value) for value in vector):
        return None
    kx, ky, kz = (float(value) for value in vector)
    in_plane_scale = max(1.0, abs(kx), abs(ky))
    if abs(kz) > 1.0e-8 * in_plane_scale:
        return None
    denominator = kx * kx + ky * ky
    if denominator <= 0.0:
        return 0.0
    return (ky * ky) / denominator


def _kalinikos_frequency_hz(
    k: float,
    geometry: str,
    parameters: Mapping[str, Any],
) -> float | None:
    """Backward-compatible BV/DE dispatch, re-expressed as the two special
    cases (phi=0, phi=pi/2) of :func:`_kalinikos_frequency_hz_general_phi` so
    there is a single implementation of the underlying physics to maintain."""
    if geometry not in {"backward_volume", "damon_eshbach"} or not _finite(k) or k < 0.0:
        return None
    sin_squared_phi = 0.0 if geometry == "backward_volume" else 1.0
    return _kalinikos_frequency_hz_general_phi(k, sin_squared_phi, parameters)


def _new_check(status: str, **values: Any) -> dict[str, Any]:
    return {"status": status, **values}


def _artifact_map(case_dir: Path) -> tuple[dict[Path, dict[str, Any]], list[str]]:
    artifacts: dict[Path, dict[str, Any]] = {}
    reasons: list[str] = []
    for relative in _REQUIRED_ARTIFACTS:
        path = _safe_relative_path(case_dir, relative.as_posix(), f"required artifact {relative.as_posix()}", reasons)
        if path is None:
            continue
        if path.stat().st_size <= 0:
            reasons.append(f"required artifact is empty: {relative.as_posix()}")
            continue
        artifacts[relative] = {"sha256": _sha256(path), "size": path.stat().st_size}
    return artifacts, reasons


def _sample_frequency(sample: Mapping[str, Any], raw_mode_index: int | None = None) -> float | None:
    modes = sample.get("modes")
    if not isinstance(modes, list):
        return None
    candidates = modes
    if raw_mode_index is not None:
        candidates = [mode for mode in modes if isinstance(mode, Mapping) and mode.get("raw_mode_index", mode.get("index")) == raw_mode_index]
    values = []
    for mode in candidates:
        if not isinstance(mode, Mapping):
            continue
        frequency = mode.get("frequency_real_hz", mode.get("frequency_hz"))
        if _finite_positive(frequency):
            values.append(float(frequency))
    return min(values) if values else None


def _phase_residual(mode: Mapping[str, Any]) -> object:
    for key in (
        "phase_constraint_residual",
        "phase_boundary_residual",
        "phase_residual",
    ):
        if key in mode:
            return mode[key]
    phase = mode.get("phase_constraint")
    if isinstance(phase, Mapping):
        for key in ("residual", "residual_abs", "max_residual"):
            if key in phase:
                return phase[key]
    return None


def _validate_modal_quality(mode: Mapping[str, Any], label: str, reasons: list[str]) -> bool:
    """Validate native per-mode diagnostics without defaulting absent values."""

    frequency = mode.get("frequency_real_hz", mode.get("frequency_hz"))
    imaginary = mode.get("frequency_imag_hz")
    valid = True
    if not _finite_positive(frequency):
        reasons.append(f"{label} has a missing or non-positive real frequency")
        return False
    if not _finite(imaginary):
        reasons.append(f"{label} is missing native frequency_imag_hz")
        valid = False
    else:
        ratio = abs(float(imaginary)) / max(abs(float(frequency)), 1.0)
        if ratio >= MAX_IMAGINARY_TO_REAL_RATIO:
            reasons.append(f"{label} has |Im(f)|/max(|Re(f)|,1Hz)={ratio:.6g} >= {MAX_IMAGINARY_TO_REAL_RATIO:.6g}")
            valid = False
    residual = mode.get("residual_relative_l2")
    if not _finite(residual):
        reasons.append(f"{label} is missing native residual_relative_l2")
        valid = False
    elif float(residual) < 0.0 or float(residual) >= MAX_EIGEN_RESIDUAL:
        reasons.append(f"{label} residual_relative_l2={float(residual)!r} is outside the <{MAX_EIGEN_RESIDUAL:.6g} gate")
        valid = False
    tangent = mode.get("tangent_leakage_max_abs")
    if not _finite(tangent):
        reasons.append(f"{label} is missing native tangent_leakage_max_abs")
        valid = False
    elif float(tangent) < 0.0 or float(tangent) >= MAX_TANGENT_LEAKAGE:
        reasons.append(f"{label} tangent_leakage_max_abs={float(tangent)!r} is outside the <{MAX_TANGENT_LEAKAGE:.6g} gate")
        valid = False
    phase = _phase_residual(mode)
    if _finite(phase) and (float(phase) < 0.0 or float(phase) >= MAX_PHASE_RESIDUAL):
        reasons.append(f"{label} phase constraint residual={float(phase)!r} is outside the <{MAX_PHASE_RESIDUAL:.6g} gate")
        valid = False
    try:
        validate_mode_diagnostics_fields(dict(mode), label, float(frequency))
    except (SystemExit, ValueError, TypeError) as error:
        reasons.append(f"{label} fails native modal diagnostics validation: {error}")
        valid = False
    return valid


def _modal_frequency_matches_spectrum(mode, sample, label, reasons):
    matches = [item for item in sample.get("modes", []) if isinstance(item, Mapping)
               and item.get("raw_mode_index") == mode.get("raw_mode_index")]
    if len(matches) != 1:
        reasons.append(f"{label} has no unique spectrum mode")
        return False
    valid = True
    for key in ("frequency_real_hz", "frequency_imag_hz"):
        actual, expected = mode.get(key), matches[0].get(key)
        if not _finite(actual) or not _finite(expected) or abs(actual - expected) > 1e-9 * max(1.0, abs(expected)):
            reasons.append(f"{label} {key} differs from the numeric spectrum")
            valid = False
    return valid


def _validate_exported_mode_fields(
    case_dir: Path,
    case: str,
    branches: Sequence[Mapping[str, Any]],
    sample_map: Mapping[int, Mapping[str, Any]],
    reasons: list[str],
) -> dict[str, Any]:
    """Inspect branch-selected binary fields, independently of solver claims."""
    from comsol_modal_field_certificate import validate_modal_field_certificate

    control_samples = {0} if case == "c0" else {0, 10, 20, 40, 50, 60}
    selections = []
    for branch in branches:
        for point in branch.get("points", []):
            if not isinstance(point, Mapping) or point.get("sample_index") not in control_samples:
                continue
            raw = point.get("raw_mode_index")
            sample = point.get("sample_index")
            if isinstance(raw, int) and not isinstance(raw, bool) and raw >= 0:
                selections.append((sample, raw))
    expected_count = len(control_samples) * (1 if case == "c0" else EXPECTED_TARGET_BANDS)
    if len(set(selections)) != expected_count:
        reasons.append(f"modal field phase requires {expected_count} distinct branch-selected fields")
        return _new_check("fail", expected_mode_count=expected_count)
    certificate = validate_modal_field_certificate(
        case_dir, mode_selections=sorted(selections), phase_tolerance=MAX_PHASE_RESIDUAL,
    )
    if certificate.get("status") != "pass":
        reasons.extend(f"modal field phase: {reason}" for reason in certificate.get("reasons", []))
        reasons.append("modal field phase certificate did not pass")
    from comsol_mesh_identity import mesh_topology_fingerprint_v2
    mesh_signature = None
    try:
        metadata_path = _safe_relative_path(case_dir, "metadata.json", "modal field mesh metadata", reasons)
        if metadata_path is None:
            raise ValueError("unsafe or missing mesh metadata")
        metadata_bytes = metadata_path.read_bytes()
        certified_hashes = {item["path"]: item["sha256"] for item in certificate.get("file_hashes", [])}
        if "sha256:" + hashlib.sha256(metadata_bytes).hexdigest() != certified_hashes.get("metadata.json"):
            raise ValueError("metadata changed after field certification")
        field_metadata = json.loads(metadata_bytes)
        mesh_signature = mesh_topology_fingerprint_v2(field_metadata["execution_plan"]["backend_plan"]["mesh"])
    except (OSError, ValueError, TypeError, KeyError, SystemExit) as error:
        reasons.append(f"modal field mesh identity could not be verified: {error}")
        certificate["status"] = "fail"
        certificate["qualification"] = "NOT VERIFIED"
    for mode in certificate.get("modes", []):
        if mesh_signature is None or mode.get("source_mesh_topology_sha256") != mesh_signature:
            reasons.append("modal field topology differs from the numeric mesh")
            certificate["status"] = "fail"
            certificate["qualification"] = "NOT VERIFIED"
        index = mode.get("sample_index")
        if not _modal_frequency_matches_spectrum(mode, sample_map.get(index, {}), f"modal field sample {index}", reasons):
            certificate["status"] = "fail"
            certificate["qualification"] = "NOT VERIFIED"
        actual = mode.get("k_vector_rad_per_m")
        expected = sample_map.get(index, {}).get("k_vector")
        if not isinstance(actual, list) or not isinstance(expected, list) or len(actual) != 3 or len(expected) != 3 or any(
            not _finite(a) or not _finite(b) or abs(float(a) - float(b)) > 1e-8 * max(1.0, abs(float(b)))
            for a, b in zip(actual, expected)
        ):
            reasons.append(f"modal field sample {index} wavevector differs from the numeric spectrum")
            certificate["status"] = "fail"
            certificate["qualification"] = "NOT VERIFIED"
    return certificate


def _validate_spectrum(
    spectrum: Mapping[str, Any],
    case: str,
    expected_path: Mapping[int, tuple[float, float, float]],
    reasons: list[str],
) -> tuple[dict[int, dict[str, Any]], dict[tuple[int, int], float]]:
    samples = spectrum.get("samples")
    sample_map: dict[int, dict[str, Any]] = {}
    mode_map: dict[tuple[int, int], float] = {}
    if not isinstance(samples, list):
        reasons.append("spectrum.samples is missing or is not an array")
        return sample_map, mode_map
    expected_count = 1 if case == "c0" else EXPECTED_PATH_SAMPLE_COUNT
    if len(samples) != expected_count:
        reasons.append(f"{case} requires {expected_count} spectrum samples, found {len(samples)}")
    declared_count = spectrum.get("sample_count")
    if declared_count != len(samples):
        reasons.append("spectrum.sample_count does not match the serialized sample array")
    for sample in samples:
        if not isinstance(sample, Mapping):
            reasons.append("spectrum contains a non-object sample")
            continue
        index = sample.get("sample_index")
        if not isinstance(index, int) or isinstance(index, bool):
            reasons.append("spectrum sample has no integer sample_index")
            continue
        if index in sample_map:
            reasons.append(f"spectrum contains duplicate sample_index {index}")
            continue
        sample_map[index] = dict(sample)
        vector = sample.get("k_vector")
        if not isinstance(vector, list) or len(vector) != 3 or not all(_finite(item) for item in vector):
            reasons.append(f"spectrum sample {index} has a missing or non-finite k_vector")
        elif case in PATH_CASES and index in expected_path:
            expected = expected_path[index]
            if any(abs(float(actual) - wanted) > 1.0e-8 * max(1.0, abs(wanted)) for actual, wanted in zip(vector, expected)):
                reasons.append(f"spectrum sample {index} k_vector does not match the canonical 61-point k-path")
        modes = sample.get("modes")
        if not isinstance(modes, list) or not modes:
            reasons.append(f"spectrum sample {index} has no modes")
            continue
        for mode in modes:
            if not isinstance(mode, Mapping):
                reasons.append(f"spectrum sample {index} contains a non-object mode")
                continue
            raw = mode.get("raw_mode_index", mode.get("index"))
            if not isinstance(raw, int) or isinstance(raw, bool) or raw < 0:
                reasons.append(f"spectrum sample {index} contains a mode without a valid raw_mode_index")
                continue
            frequency = mode.get("frequency_real_hz", mode.get("frequency_hz"))
            imag = mode.get("frequency_imag_hz")
            if not _finite(frequency) or not _finite(imag):
                reasons.append(f"spectrum sample {index} mode {raw} has a missing or non-finite frequency")
                continue
            key = (index, raw)
            if key in mode_map:
                reasons.append(f"spectrum contains duplicate raw_mode_index {raw} at sample {index}")
                continue
            _validate_modal_quality(mode, f"spectrum sample {index} mode {raw}", reasons)
            mode_map[key] = float(frequency)
    expected_indices = {0} if case == "c0" else set(range(EXPECTED_PATH_SAMPLE_COUNT))
    if set(sample_map) != expected_indices:
        reasons.append(f"spectrum sample indices are {sorted(sample_map)}, expected {sorted(expected_indices)}")
    return sample_map, mode_map


def _validate_branches(
    branches: Mapping[str, Any],
    case: str,
    mode_map: Mapping[tuple[int, int], float],
    reasons: list[str],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    values = branches.get("branches")
    if not isinstance(values, list):
        reasons.append("branches.branches is missing or is not an array")
        return [], _new_check("fail", branch_count=0, target_band_count=0)
    initial_reason_count = len(reasons)
    parsed: list[dict[str, Any]] = []
    seen_branch_ids: set[int] = set()
    for branch in values:
        if not isinstance(branch, Mapping):
            reasons.append("branches contains a non-object branch")
            continue
        branch_id = branch.get("branch_id")
        points = branch.get("points")
        if not isinstance(branch_id, int) or isinstance(branch_id, bool) or not isinstance(points, list):
            reasons.append("branch is missing an integer branch_id or points array")
            continue
        if branch_id < 0 or branch_id in seen_branch_ids:
            reasons.append(f"branch_id {branch_id} must be nonnegative and unique")
            continue
        seen_branch_ids.add(branch_id)
        parsed.append(dict(branch))
    parsed.sort(key=lambda item: int(item["branch_id"]))
    expected_indices = {0} if case == "c0" else set(range(EXPECTED_PATH_SAMPLE_COUNT))
    target = 1 if case == "c0" else EXPECTED_TARGET_BANDS
    complete: list[dict[str, Any]] = []
    seen_mode_bindings: set[tuple[int, int]] = set()
    for branch in parsed:
        branch_id = int(branch["branch_id"])
        point_map: dict[int, Mapping[str, Any]] = {}
        for point in branch["points"]:
            if not isinstance(point, Mapping):
                reasons.append(f"branch {branch_id} contains a non-object point")
                continue
            index = point.get("sample_index")
            if not isinstance(index, int) or isinstance(index, bool):
                reasons.append(f"branch {branch_id} contains a point without integer sample_index")
                continue
            if index in point_map:
                reasons.append(f"branch {branch_id} contains duplicate sample_index {index}")
                continue
            point_map[index] = point
            frequency = point.get("frequency_real_hz", point.get("frequency_hz"))
            imag = point.get("frequency_imag_hz")
            if not _finite_positive(frequency) or not _finite(imag):
                reasons.append(f"branch {branch_id} sample {index} has a missing, non-finite, or non-positive frequency")
            raw = point.get("raw_mode_index")
            if not isinstance(raw, int) or isinstance(raw, bool) or raw < 0:
                reasons.append(f"branch {branch_id} sample {index} has no valid raw_mode_index")
                continue
            binding = (index, raw)
            if binding in seen_mode_bindings:
                reasons.append(f"raw mode {raw} at sample {index} is assigned to multiple tracked branches")
            seen_mode_bindings.add(binding)
            if binding not in mode_map:
                reasons.append(f"branch {branch_id} sample {index} references unknown spectrum raw mode {raw}")
            elif _finite(frequency) and _relative_error(float(frequency), mode_map[binding]) > 1.0e-9:
                reasons.append(f"branch {branch_id} sample {index} disagrees with spectrum for raw mode {raw}")
        if set(point_map) == expected_indices:
            complete.append(branch)
    if len(complete) < target:
        reasons.append(f"only {len(complete)} complete tracked branches are available; {target} are required")
    selected = complete[:target]
    return selected, _new_check(
        "pass" if len(selected) == target and len(reasons) == initial_reason_count else "fail",
        branch_count=len(parsed),
        complete_branch_count=len(complete),
        target_band_count=target,
        sample_count=(1 if case == "c0" else EXPECTED_PATH_SAMPLE_COUNT),
        selected_branch_ids=[int(branch["branch_id"]) for branch in selected],
    )


def _validate_dispersion_csv(
    path: Path,
    case: str,
    expected_path: Mapping[int, tuple[float, float, float]],
    sample_map: Mapping[int, Mapping[str, Any]],
    mode_map: Mapping[tuple[int, int], float],
    selected_branches: Sequence[Mapping[str, Any]],
    reasons: list[str],
) -> dict[str, Any]:
    """Cross-check native dispersion rows against the modal spectrum."""

    expected_indices = {0} if case == "c0" else set(range(EXPECTED_PATH_SAMPLE_COUNT))
    before = len(reasons)
    rows = 0
    sample_indices: set[int] = set()
    seen_modes: set[tuple[int, int]] = set()
    branch_by_mode: dict[tuple[int, int], int] = {}
    expected_pairs: set[tuple[int, int]] = set()
    for branch in selected_branches:
        branch_id = branch.get("branch_id")
        points = branch.get("points")
        if not isinstance(branch_id, int) or not isinstance(points, list):
            continue
        for point in points:
            if isinstance(point, Mapping) and isinstance(point.get("sample_index"), int) and isinstance(point.get("raw_mode_index"), int):
                key = (int(point["sample_index"]), int(point["raw_mode_index"]))
                expected_pairs.add(key)
                branch_by_mode[key] = int(branch_id)
    observed_pairs: set[tuple[int, int]] = set()
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            fieldnames = set(reader.fieldnames or ())
            required = {
                "sample_index",
                "branch_id",
                "raw_mode_index",
                "kx_rad_per_m",
                "ky_rad_per_m",
                "kz_rad_per_m",
            }
            frequency_key = (
                "frequency_real_hz"
                if "frequency_real_hz" in fieldnames
                else "frequency_hz"
            )
            missing = sorted(required - fieldnames)
            if frequency_key not in fieldnames:
                missing.append("frequency_real_hz or frequency_hz")
            if missing:
                reasons.append(f"dispersion.csv is missing columns: {', '.join(missing)}")
                return _new_check("fail", rows=0, sample_count=0, tracked_pairs=0)
            for row_number, row in enumerate(reader, start=1):
                rows += 1
                try:
                    sample_index = int(row["sample_index"])
                    raw_mode_index = int(row["raw_mode_index"])
                except (TypeError, ValueError):
                    reasons.append(f"dispersion.csv row {row_number} has invalid sample_index/raw_mode_index")
                    continue
                sample_indices.add(sample_index)
                key = (sample_index, raw_mode_index)
                if key in seen_modes:
                    reasons.append(f"dispersion.csv contains duplicate sample/raw mode {key}")
                    continue
                seen_modes.add(key)
                try:
                    vector = tuple(float(row[name]) for name in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m"))
                    frequency = float(row[frequency_key])
                except (TypeError, ValueError):
                    reasons.append(f"dispersion.csv row {row_number} has non-numeric k or frequency")
                    continue
                if not all(math.isfinite(value) for value in (*vector, frequency)):
                    reasons.append(f"dispersion.csv row {row_number} has a non-finite k or frequency")
                    continue
                if frequency <= 0.0:
                    reasons.append(f"dispersion.csv row {row_number} has a non-positive frequency")
                sample = sample_map.get(sample_index)
                if sample is None:
                    reasons.append(f"dispersion.csv row {row_number} references unknown sample {sample_index}")
                    continue
                sample_vector = sample.get("k_vector")
                if not isinstance(sample_vector, list) or len(sample_vector) != 3:
                    reasons.append(f"dispersion.csv row {row_number} cannot bind to sample {sample_index} k_vector")
                elif any(abs(actual - float(wanted)) > 1.0e-8 * max(1.0, abs(float(wanted))) for actual, wanted in zip(vector, sample_vector)):
                    reasons.append(f"dispersion.csv row {row_number} k_vector disagrees with spectrum sample {sample_index}")
                if case in PATH_CASES and sample_index in expected_path:
                    expected = expected_path[sample_index]
                    if any(abs(actual - wanted) > 1.0e-8 * max(1.0, abs(wanted)) for actual, wanted in zip(vector, expected)):
                        reasons.append(f"dispersion.csv row {row_number} k_vector disagrees with canonical k-path")
                expected_frequency = mode_map.get(key)
                if expected_frequency is None:
                    reasons.append(f"dispersion.csv row {row_number} references unknown spectrum raw mode {raw_mode_index} at sample {sample_index}")
                elif _relative_error(frequency, expected_frequency) > 1.0e-9:
                    reasons.append(f"dispersion.csv row {row_number} frequency disagrees with spectrum raw mode {raw_mode_index}")
                if "frequency_imag_hz" in fieldnames:
                    try:
                        frequency_imag = float(row["frequency_imag_hz"])
                    except (TypeError, ValueError):
                        frequency_imag = math.nan
                    if not math.isfinite(frequency_imag):
                        reasons.append(f"dispersion.csv row {row_number} has a non-finite frequency_imag_hz")
                raw_branch = row.get("branch_id", "").strip()
                branch_id = None
                if raw_branch:
                    try:
                        branch_id = int(raw_branch)
                    except ValueError:
                        reasons.append(f"dispersion.csv row {row_number} has an invalid branch_id")
                expected_branch = branch_by_mode.get(key)
                if expected_branch is not None:
                    if branch_id != expected_branch:
                        reasons.append(f"dispersion.csv row {row_number} branch_id does not bind tracked raw mode {raw_mode_index} to branch {expected_branch}")
                    else:
                        observed_pairs.add(key)
    except (OSError, UnicodeError) as error:
        reasons.append(f"cannot read dispersion.csv: {error}")
    if sample_indices != expected_indices:
        reasons.append(f"dispersion.csv sample indices are {sorted(sample_indices)}, expected {sorted(expected_indices)}")
    missing_pairs = sorted(expected_pairs - observed_pairs)
    if missing_pairs:
        reasons.append(f"dispersion.csv is missing {len(missing_pairs)} tracked sample/raw-mode rows")
    minimum_modes = 1 if case == "c0" else EXPECTED_TARGET_BANDS
    for index in sorted(expected_indices):
        count = sum(1 for sample, _ in seen_modes if sample == index)
        if count < minimum_modes:
            reasons.append(f"dispersion.csv sample {index} has {count} unique modes; {minimum_modes} are required")
    return _new_check(
        "pass" if len(reasons) == before and bool(expected_pairs) else "fail",
        rows=rows,
        sample_count=len(sample_indices),
        unique_mode_count=len(seen_modes),
        tracked_pairs=len(observed_pairs),
        expected_tracked_pairs=len(expected_pairs),
    )

def _validate_numeric_source(
    manifest: Mapping[str, Any],
    diagnostics: Mapping[str, Any],
    case: str,
    reasons: list[str],
) -> dict[str, Any]:
    before = len(reasons)
    source = _nested(manifest, "validation", "dispersion_frequency_source")
    dynamic_source = _nested(manifest, "validation", "dynamic_demag_operator_source")
    solver_model = diagnostics.get("solver_model")
    native_execution = (
        _is_production_solver_model(solver_model)
        and diagnostics.get("production_native_solver_available") is True
        and diagnostics.get("validation_only") is not True
    )
    native_attested = (
        source is None and native_execution
        and _nested(manifest, "resolved_execution", "reference_or_production") == "production"
    )
    if not native_execution:
        reasons.append("native production solver execution is unavailable or validation-only")
    if source == "analytic_reference_model":
        reasons.append("analytic reference is declared as the frequency source; an analytic source cannot qualify a FEM run")
    elif source != NUMERIC_FREQUENCY_SOURCE and not native_attested:
        reasons.append(f"frequency source {source!r} is neither the numeric comparison source nor a native production attestation")
    if not _is_production_solver_model(solver_model):
        reasons.append(f"solver_model {solver_model!r} is not the managed production SLEPc modal solver")
    if case in {"c1", "a1"} and dynamic_source != "numeric_modal_solver":
        reasons.append("dynamic demagnetization source is not declared as numeric_modal_solver")
    return _new_check(
        "pass" if len(reasons) == before else "fail",
        frequency_source=source,
        dynamic_demag_operator_source=dynamic_source,
        solver_model=solver_model,
        native_production_attestation=native_execution,
    )


def _validate_kittel(
    case: str,
    selected_branches: Sequence[Mapping[str, Any]],
    parameters: Mapping[str, Any],
    reasons: list[str],
) -> dict[str, Any]:
    if case == "a1":
        return _new_check("not_applicable", reason="the antidot breaks the homogeneous-film Kittel control; c0 and c1 must be supplied")
    if not selected_branches:
        reasons.append(f"{case} Kittel control has no selected numeric branch")
        return _new_check("fail")
    point = next((point for point in selected_branches[0].get("points", []) if isinstance(point, Mapping) and point.get("sample_index") == 0), None)
    observed = point.get("frequency_real_hz", point.get("frequency_hz")) if isinstance(point, Mapping) else None
    expected_key = "no_demag_gamma" if case == "c0" else "with_demag_gamma_hz"
    expected = _nested(parameters, "controls_infinite_film_hz", expected_key) if case == "c0" else _nested(parameters, "controls_finite_dirichlet_box", expected_key)
    if not _finite_positive(observed) or not _finite_positive(expected):
        reasons.append(f"{case} Kittel control lacks finite positive observed/expected frequency")
        return _new_check("fail", observed_frequency_hz=observed, expected_frequency_hz=expected)
    relative_error = _relative_error(float(observed), float(expected))
    if relative_error > KITTEL_RELATIVE_TOLERANCE:
        reasons.append(f"{case} Kittel relative error {relative_error:.6g} exceeds {KITTEL_RELATIVE_TOLERANCE:.6g}")
    return _new_check(
        "pass" if relative_error <= KITTEL_RELATIVE_TOLERANCE else "fail",
        observed_frequency_hz=float(observed),
        expected_frequency_hz=float(expected),
        relative_error=relative_error,
        tolerance=KITTEL_RELATIVE_TOLERANCE,
    )


def _validate_dispersion_analytic_coverage(
    case: str,
    selected_branches: Sequence[Mapping[str, Any]],
    expected_path: Mapping[int, tuple[float, float, float]],
    parameters: Mapping[str, Any],
    reasons: list[str],
) -> dict[str, Any]:
    """Compare EVERY canonical k-path sample's fundamental-branch frequency
    against the Kalinikos-Slavin n=0 analytic oracle at that sample's actual
    (possibly oblique) propagation angle.

    Unlike ``_validate_ks`` (which only checks producer-supplied evidence
    samples and can be satisfied by as few as two, from auxiliary runs), this
    check has no external "evidence" dependency: it is self-contained and runs
    against the PRIMARY qualified run's own dispersion.csv/branches.v2.json
    data for every one of the EXPECTED_PATH_SAMPLE_COUNT (61) samples. A
    solver whose dispersion is wrong or constant on any sample of the tracked
    fundamental branch is caught here, regardless of what (if anything) a
    producer chose to supply as separate KS evidence.

    Only applicable to c1: c0 has a single Gamma sample (already covered by
    the Kittel control) and a1's antidot lattice breaks the homogeneous-slab
    analytic applicability (same restriction as ``_validate_kittel``).
    """
    if case != "c1":
        return _new_check(
            "not_applicable",
            reason="the homogeneous slab KS oracle covers c1's full k-path only; c0 has one sample (Kittel) and a1's antidot breaks homogeneous-slab applicability",
        )
    initial_reason_count = len(reasons)
    if not selected_branches:
        reasons.append("dispersion analytic coverage has no selected fundamental branch")
        return _new_check("fail")
    fundamental = selected_branches[0]
    points = fundamental.get("points")
    point_map: dict[int, Mapping[str, Any]] = {
        point["sample_index"]: point
        for point in (points if isinstance(points, list) else [])
        if isinstance(point, Mapping) and isinstance(point.get("sample_index"), int)
    }
    expected_indices = set(range(EXPECTED_PATH_SAMPLE_COUNT))
    missing_samples = sorted(expected_indices - set(point_map))
    if missing_samples:
        reasons.append(f"dispersion analytic coverage is missing fundamental-branch samples {missing_samples}")
    errors: list[tuple[int, float, float, float]] = []
    for index in sorted(expected_indices & set(point_map)):
        point = point_map[index]
        vector = expected_path.get(index)
        if vector is None:
            reasons.append(f"dispersion analytic coverage sample {index} has no canonical k-vector")
            continue
        observed = point.get("frequency_real_hz", point.get("frequency_hz"))
        if not _finite_positive(observed):
            reasons.append(f"dispersion analytic coverage sample {index} has no finite positive fundamental-branch frequency")
            continue
        sin_squared_phi = _sin_squared_phi_from_k_vector(vector)
        if sin_squared_phi is None:
            reasons.append(f"dispersion analytic coverage sample {index} k-vector is not in-plane")
            continue
        k_actual = _vector_norm(vector)
        expected = _kalinikos_frequency_hz_general_phi(k_actual, sin_squared_phi, parameters)
        if not _finite_positive(expected):
            reasons.append(f"dispersion analytic coverage sample {index} has no finite analytic reference")
            continue
        error = _relative_error(float(observed), float(expected))
        errors.append((index, error, float(observed), float(expected)))
        if error > KS_RELATIVE_TOLERANCE:
            reasons.append(
                f"dispersion analytic coverage sample {index} fundamental-branch frequency "
                f"{float(observed):.6g} Hz deviates from the Kalinikos-Slavin n=0 prediction "
                f"{float(expected):.6g} Hz by {error:.6g}, exceeds {KS_RELATIVE_TOLERANCE:.6g}"
            )
    worst = max(errors, key=lambda item: item[1], default=None)
    complete = not missing_samples and len(errors) == EXPECTED_PATH_SAMPLE_COUNT
    return _new_check(
        "pass" if len(reasons) == initial_reason_count and complete else "fail",
        sample_count=len(errors),
        expected_sample_count=EXPECTED_PATH_SAMPLE_COUNT,
        tolerance=KS_RELATIVE_TOLERANCE,
        max_relative_error=worst[1] if worst else None,
        max_error_sample_index=worst[0] if worst else None,
    )


def _safe_relative_path(case_dir: Path, value: object, label: str, reasons: list[str]) -> Path | None:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        reasons.append(f"{label} is not a safe relative path")
        return None
    relative = PurePosixPath(value)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        reasons.append(f"{label} escapes the case output directory")
        return None
    candidate = case_dir.joinpath(*relative.parts)
    for entry in (candidate, *candidate.parents):
        if entry.is_symlink() or (hasattr(entry, "is_junction") and entry.is_junction()):
            reasons.append(f"{label} contains a symlink or junction")
            return None
        if entry == case_dir:
            break
    try:
        resolved_case = case_dir.resolve()
        resolved_candidate = candidate.resolve()
        resolved_candidate.relative_to(resolved_case)
    except (OSError, ValueError):
        reasons.append(f"{label} escapes the case output directory")
        return None
    if candidate.is_symlink() or not candidate.is_file():
        reasons.append(f"{label} is not a regular file")
        return None
    return candidate


def _validate_payload_schemas(bundle: Mapping[str, Any], label: str, reasons: list[str]) -> None:
    for name, expected in (
        ("spectrum", "eigen_spectrum.v2"),
        ("branches", "eigen_branches.v2"),
        ("manifest", "frequency_domain_manifest.v1"),
    ):
        payload = bundle.get(name)
        if not isinstance(payload, Mapping) or payload.get("schema_version") != expected:
            reasons.append(f"{label}.{name} requires schema_version={expected}")


def _load_numeric_bundle(
    case_dir: Path,
    descriptor: object,
    label: str,
    reasons: list[str],
    *,
    require_demag: bool,
) -> dict[str, Any] | None:
    """Load and hash-bind a comparison run referenced by scientific evidence."""

    if not isinstance(descriptor, Mapping):
        reasons.append(f"{label} is missing a numeric run descriptor")
        return None
    root = descriptor.get("root")
    artifacts = descriptor.get("artifacts")
    if not isinstance(root, str) or not root or not isinstance(artifacts, Mapping):
        reasons.append(f"{label} must contain root and artifacts")
        return None
    default_paths = {
        "metadata": "metadata.json",
        "spectrum": "eigen/spectrum.v2.json",
        "branches": "eigen/branches.v2.json",
        "manifest": "frequency_domain/manifest.v1.json",
        "diagnostics": "eigen/diagnostics/solver.v1.json",
    }
    loaded: dict[str, Any] = {}
    metadata_file: Path | None = None
    metadata_hash: str | None = None
    for logical, default_relative in default_paths.items():
        spec = artifacts.get(logical)
        if not isinstance(spec, Mapping):
            reasons.append(f"{label} is missing artifact binding {logical}")
            continue
        relative = spec.get("path", f"{root.rstrip('/')}/{default_relative}")
        path = _safe_relative_path(case_dir, relative, f"{label}.{logical}", reasons)
        expected_hash = spec.get("sha256")
        if path is None:
            continue
        if not isinstance(expected_hash, str) or expected_hash != _sha256(path):
            reasons.append(f"{label}.{logical} SHA256 does not match the referenced artifact")
            continue
        value, error = _load_json(path)
        if error:
            reasons.append(f"{label}.{logical}: {error}")
            continue
        assert value is not None
        loaded[logical] = value
        if logical == "metadata":
            metadata_file, metadata_hash = path, expected_hash
    if set(loaded) != set(default_paths):
        return None
    _validate_payload_schemas(loaded, label, reasons)
    manifest = loaded["manifest"]
    for key, expected in (("analysis_family", "magnetic_frequency_domain"), ("study_product", "modal_eigen")):
        if manifest.get(key) != expected:
            reasons.append(f"{label} manifest {key} must be {expected}")
    diagnostics = loaded["diagnostics"]
    source = _nested(manifest, "validation", "dispersion_frequency_source")
    dynamic_source = _nested(manifest, "validation", "dynamic_demag_operator_source")
    if source != NUMERIC_FREQUENCY_SOURCE:
        native_attested = (
            source is None
            and isinstance(diagnostics, Mapping)
            and _is_production_solver_model(diagnostics.get("solver_model"))
            and diagnostics.get("production_native_solver_available") is True
            and _nested(manifest, "resolved_execution", "reference_or_production") == "production"
        )
        if not native_attested:
            reasons.append(f"{label} frequency source {source!r} is not the numeric FEM source")
    if not isinstance(diagnostics, Mapping) or not _is_production_solver_model(diagnostics.get("solver_model")):
        reasons.append(f"{label} does not identify the managed production SLEPc modal solver")
    if not isinstance(diagnostics, Mapping) or diagnostics.get("production_native_solver_available") is not True:
        reasons.append(f"{label} lacks the native production solver attestation")
    if isinstance(diagnostics, Mapping) and diagnostics.get("validation_only") is True:
        reasons.append(f"{label} is marked validation_only and cannot supply numeric evidence")
    if _nested(manifest, "resolved_execution", "reference_or_production") != "production":
        reasons.append(f"{label} is not bound to a production numeric execution")
    if not isinstance(diagnostics, Mapping) or diagnostics.get("schema_version") != "frequency_domain_modal_solver_diagnostics.v1":
        reasons.append(f"{label} lacks the native modal solver diagnostics schema")
    if (
        not isinstance(diagnostics, Mapping)
        or diagnostics.get("complete") is not True
        or diagnostics.get("status") not in {"ready", "ok"}
    ):
        reasons.append(f"{label} native modal solver diagnostics are not complete and ready")
    if require_demag and dynamic_source != "numeric_modal_solver":
        reasons.append(f"{label} does not identify numeric_modal_solver as dynamic-demag source")
    metadata = loaded.get("metadata")
    if not isinstance(metadata, Mapping):
        reasons.append(f"{label} has no native metadata.json object")
    elif _metadata_backend_plan(metadata) is None:
        reasons.append(f"{label} has no metadata.execution_plan.backend_plan")
    _validate_bundle_modal_payload(loaded, label, reasons)
    _validate_bundle_branches(loaded, label, reasons)
    loaded["_metadata_file"] = str(metadata_file)
    loaded["_metadata_hash"] = metadata_hash
    return loaded


def _validate_bundle_modal_payload(
    bundle: Mapping[str, Any],
    label: str,
    reasons: list[str],
) -> None:
    """Check every numeric comparison mode before it can feed an oracle."""

    spectrum = bundle.get("spectrum")
    diagnostics = bundle.get("diagnostics")
    if not isinstance(spectrum, Mapping) or not isinstance(diagnostics, Mapping):
        return
    samples = spectrum.get("samples")
    if not isinstance(samples, list) or not samples:
        reasons.append(f"{label} spectrum has no samples array")
        return
    mode_count = 0
    seen: set[tuple[int, int]] = set()
    sample_ids: set[int] = set()
    for sample in samples:
        if not isinstance(sample, Mapping) or type(sample.get("sample_index")) is not int or sample.get("sample_index", -1) < 0:
            reasons.append(f"{label} spectrum has an invalid sample")
            continue
        sample_index = int(sample["sample_index"])
        if sample_index in sample_ids:
            reasons.append(f"{label} spectrum contains duplicate sample_index {sample_index}")
        sample_ids.add(sample_index)
        vector = sample.get("k_vector")
        if not isinstance(vector, list) or len(vector) != 3 or not all(_finite(value) for value in vector):
            reasons.append(f"{label} spectrum sample {sample_index} has an invalid k_vector")
        modes = sample.get("modes")
        if not isinstance(modes, list) or not modes:
            reasons.append(f"{label} spectrum sample {sample_index} has no modes array")
            continue
        for mode in modes:
            if not isinstance(mode, Mapping) or type(mode.get("raw_mode_index")) is not int or mode.get("raw_mode_index", -1) < 0:
                reasons.append(f"{label} spectrum sample {sample_index} has an invalid raw mode")
                continue
            raw_mode_index = int(mode["raw_mode_index"])
            key = (sample_index, raw_mode_index)
            if key in seen:
                reasons.append(f"{label} spectrum contains duplicate raw mode {key}")
            seen.add(key)
            mode_count += 1
            _validate_modal_quality(mode, f"{label} spectrum sample {sample_index} mode {raw_mode_index}", reasons)
    for source_name, source in (("spectrum", spectrum), ("solver diagnostics", diagnostics)):
        for key, expected in (("sample_count", len(samples)), ("mode_count", mode_count)):
            if type(source.get(key)) is not int or source[key] != expected:
                reasons.append(f"{label} {source_name} {key} does not match spectrum contents")


def _validate_bundle_branches(bundle, label, reasons):
    """Cross-check every published branch point, not only oracle selections."""
    branches = bundle.get("branches", {}).get("branches")
    samples = bundle.get("spectrum", {}).get("samples")
    if not isinstance(branches, list) or not branches or not isinstance(samples, list):
        reasons.append(f"{label} requires nonempty branches and spectrum samples")
        return
    modes = {(sample.get("sample_index"), mode.get("raw_mode_index")): mode
             for sample in samples if isinstance(sample, Mapping) and type(sample.get("sample_index")) is int
             and isinstance(sample.get("modes"), list)
             for mode in sample["modes"] if isinstance(mode, Mapping) and type(mode.get("raw_mode_index")) is int}
    ids, bindings = set(), set()
    for branch in branches:
        if not isinstance(branch, Mapping):
            reasons.append(f"{label} contains a malformed branch")
            continue
        branch_id = branch.get("branch_id")
        if type(branch_id) is not int or branch_id < 0 or branch_id in ids:
            reasons.append(f"{label} branch_id must be nonnegative and unique")
            continue
        ids.add(branch_id)
        points = branch.get("points")
        if not isinstance(points, list) or not points:
            reasons.append(f"{label} branch {branch_id} has no points")
            continue
        seen_samples = set()
        for point in points:
            if not isinstance(point, Mapping):
                reasons.append(f"{label} contains a malformed branch point")
                continue
            sample, raw = point.get("sample_index"), point.get("raw_mode_index")
            if type(sample) is not int or sample < 0 or type(raw) is not int or raw < 0:
                reasons.append(f"{label} branch point requires nonnegative integer identities")
                continue
            if sample in seen_samples or (sample, raw) in bindings:
                reasons.append(f"{label} contains duplicate branch sample or modal binding")
            seen_samples.add(sample)
            bindings.add((sample, raw))
            reference = modes.get((sample, raw))
            if reference is None:
                reasons.append(f"{label} branch point references an unknown spectrum mode")
                continue
            for key in ("frequency_real_hz", "frequency_imag_hz"):
                a, b = point.get(key), reference.get(key)
                if not _finite(a) or not _finite(b) or abs(a-b) > 1e-9 * max(1.0, abs(b)):
                    reasons.append(f"{label} branch point {key} differs from spectrum")


def _bundle_observation(
    bundle: Mapping[str, Any],
    sample_index: int,
    branch_id: int,
    label: str,
    reasons: list[str],
) -> tuple[float | None, tuple[float, float, float] | None]:
    spectrum = bundle.get("spectrum")
    branches = bundle.get("branches")
    if not isinstance(spectrum, Mapping) or not isinstance(branches, Mapping):
        reasons.append(f"{label} has no spectrum/branches objects")
        return None, None
    samples = spectrum.get("samples")
    vector: tuple[float, float, float] | None = None
    if isinstance(samples, list):
        for sample in samples:
            if isinstance(sample, Mapping) and sample.get("sample_index") == sample_index:
                raw = sample.get("k_vector")
                if isinstance(raw, list) and len(raw) == 3 and all(_finite(item) for item in raw):
                    vector = tuple(float(item) for item in raw)  # type: ignore[assignment]
                break
    if vector is None:
        reasons.append(f"{label} is missing finite k_vector for sample {sample_index}")
    values = branches.get("branches")
    observed: float | None = None
    selected_point: Mapping[str, Any] | None = None
    if isinstance(values, list):
        for branch in values:
            if not isinstance(branch, Mapping) or branch.get("branch_id") != branch_id:
                continue
            points = branch.get("points")
            if isinstance(points, list):
                for point in points:
                    if isinstance(point, Mapping) and point.get("sample_index") == sample_index:
                        value = point.get("frequency_real_hz", point.get("frequency_hz"))
                        if _finite_positive(value):
                            observed = float(value)
                            selected_point = point
                        else:
                            reasons.append(f"{label} branch {branch_id} sample {sample_index} has a non-finite frequency")
                        break
            break
    if observed is None:
        reasons.append(f"{label} is missing branch {branch_id} sample {sample_index}")
    if selected_point is not None:
        raw_mode = selected_point.get("raw_mode_index")
        if not isinstance(raw_mode, int):
            reasons.append(f"{label} branch {branch_id} sample {sample_index} has no raw_mode_index")
        else:
            mode_match: Mapping[str, Any] | None = None
            if isinstance(samples, list):
                for sample in samples:
                    if not isinstance(sample, Mapping) or sample.get("sample_index") != sample_index:
                        continue
                    modes = sample.get("modes")
                    if isinstance(modes, list):
                        mode_match = next(
                            (
                                mode
                                for mode in modes
                                if isinstance(mode, Mapping)
                                and mode.get("raw_mode_index", mode.get("index")) == raw_mode
                            ),
                            None,
                        )
                    break
            mode_frequency = mode_match.get("frequency_real_hz", mode_match.get("frequency_hz")) if mode_match else None
            if not _finite_positive(mode_frequency) or observed is None or _relative_error(observed, float(mode_frequency)) > 1.0e-9:
                reasons.append(f"{label} branch {branch_id} sample {sample_index} is not cross-checked against spectrum raw mode {raw_mode}")
    return observed, vector


def _bundle_branch_is_lowest_positive(
    bundle: Mapping[str, Any],
    sample_index: int,
    branch_id: int,
    label: str,
    reasons: list[str],
) -> bool:
    branches = bundle.get("branches")
    frequencies: list[float] = []
    selected: float | None = None
    if isinstance(branches, Mapping) and isinstance(branches.get("branches"), list):
        for branch in branches["branches"]:
            if not isinstance(branch, Mapping) or not isinstance(branch.get("points"), list):
                continue
            for point in branch["points"]:
                if not isinstance(point, Mapping) or point.get("sample_index") != sample_index:
                    continue
                frequency = point.get("frequency_real_hz", point.get("frequency_hz"))
                if _finite_positive(frequency):
                    value = float(frequency)
                    frequencies.append(value)
                    if branch.get("branch_id") == branch_id:
                        selected = value
                break
    if selected is None or not frequencies:
        reasons.append(f"{label} cannot establish the positive fundamental branch at sample {sample_index}")
        return False
    fundamental = min(frequencies)
    if _relative_error(selected, fundamental) > 1.0e-9:
        reasons.append(f"{label} branch {branch_id} is not the lowest positive branch at sample {sample_index}")
        return False
    return True


def _validate_homogeneous_slab_applicability(
    bundle: Mapping[str, Any],
    label: str,
    parameters: Mapping[str, Any],
    reasons: list[str],
) -> bool:
    metadata = bundle.get("metadata")
    if not isinstance(metadata, Mapping):
        reasons.append(f"{label} has no native metadata for analytic applicability")
        return False
    return _validate_benchmark_metadata(
        metadata,
        "c1",
        parameters,
        label,
        reasons,
        require_uniform_slab=True,
    )


def _vector_norm(vector: Sequence[float]) -> float:
    return math.sqrt(sum(value * value for value in vector))


def _measure_ks_profile(run, sample_index, branch_id, vector, parameters, label, reasons):
    policy = parameters.get("ks_n0_profile")
    keys = ("max_projection_residual", "max_longitudinal_leakage_fraction")
    if not isinstance(policy, Mapping) or any(not _finite(policy.get(key)) or not 0 < policy[key] < 1 for key in keys):
        reasons.append(f"{label} requires explicit finite n0 profile tolerances in (0, 1)")
        return {"status": "unverified"}
    points = [point for branch in run["branches"]["branches"] if isinstance(branch, Mapping) and branch.get("branch_id") == branch_id
              for point in branch.get("points", []) if isinstance(point, Mapping) and point.get("sample_index") == sample_index]
    if len(points) != 1 or type(points[0].get("raw_mode_index")) is not int:
        reasons.append(f"{label} has no unique raw mode for the profile")
        return {"status": "unverified"}
    metadata_file = Path(run["_metadata_file"])
    result = measure_n0_field(metadata_file.parent, sample_index, points[0]["raw_mode_index"], expected_k=vector, equilibrium_manifest=run["manifest"])
    samples = [item for item in run["spectrum"].get("samples", [])
               if isinstance(item, Mapping) and item.get("sample_index") == sample_index]
    if len(samples) != 1:
        reasons.append(f"{label} has no unique spectrum sample for its field")
    else:
        for mode in result.get("phase_certificate", {}).get("modes", []):
            _modal_frequency_matches_spectrum(mode, samples[0], label, reasons)
    hashes = {item["path"]: item["sha256"] for item in result.get("file_hashes", [])}
    if metadata_file.name != "metadata.json" or hashes.get("metadata.json") != "sha256:" + str(run["_metadata_hash"]):
        reasons.append(f"{label} profile metadata is not bound to the numeric run")
    if result.get("status") != "measured":
        reasons.append(f"{label} n0 profile measurement failed: {result.get('reasons')}")
    else:
        metrics = result["metrics"]
        for metric, key in (("projection_residual", keys[0]), ("longitudinal_leakage_fraction", keys[1])):
            if not _finite(metrics.get(metric)) or metrics[metric] > policy[key]:
                reasons.append(f"{label} n0 {metric} exceeds benchmark tolerance {policy[key]}")
    result["acceptance_policy"] = dict(policy)
    return result


def _require_matching_evidence_cell_geometry(
    primary_metadata: Mapping[str, Any] | None,
    run_metadata: Mapping[str, Any] | None,
    label: str,
    reasons: list[str],
) -> None:
    """Reject an auxiliary evidence run whose in-plane simulation cell differs
    from the primary qualified run's own cell.

    Without this, an auxiliary run from a DIFFERENT physical system (a
    different lattice period, hence a different k-path) could be silently
    accepted as Kalinikos-Slavin evidence for an unrelated primary run: only
    material/thickness/airbox were checked against the canonical parameters,
    never the in-plane cell size against the primary run being qualified.
    """
    if not isinstance(primary_metadata, Mapping) or not isinstance(run_metadata, Mapping):
        reasons.append(f"{label} cannot bind evidence cell geometry to the primary run (missing metadata)")
        return
    primary_benchmark = _metadata_benchmark_block(primary_metadata)
    run_benchmark = _metadata_benchmark_block(run_metadata)
    if not isinstance(primary_benchmark, Mapping) or not isinstance(run_benchmark, Mapping):
        reasons.append(f"{label} cannot bind evidence cell geometry to the primary run (missing benchmark metadata)")
        return
    primary_geometry = primary_benchmark.get("geometry")
    run_geometry = run_benchmark.get("geometry")
    if not isinstance(primary_geometry, Mapping) or not isinstance(run_geometry, Mapping):
        reasons.append(f"{label} cannot bind evidence cell geometry to the primary run (missing geometry block)")
        return
    primary_size = primary_geometry.get("film_size_m")
    run_size = run_geometry.get("film_size_m")
    if not isinstance(primary_size, list) or len(primary_size) != 3 or not isinstance(run_size, list) or len(run_size) != 3:
        reasons.append(f"{label} cannot bind evidence cell geometry to the primary run (missing film_size_m)")
        return
    for axis, name in ((0, "x"), (1, "y")):
        _require_metadata_number(
            run_size[axis],
            primary_size[axis],
            f"{label}.geometry.film_size_m[{name}] (in-plane simulation cell size)",
            reasons,
            tolerance=1.0e-8,
        )


def _validate_ks(
    case_dir: Path,
    case: str,
    evidence: Mapping[str, Any] | None,
    parameters: Mapping[str, Any],
    reasons: list[str],
    *,
    primary_metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if case != "c1":
        return _new_check("not_applicable", reason="the homogeneous slab KS control is applicable to c1 only")
    initial_reason_count = len(reasons)
    controls = evidence.get("analytic_controls") if isinstance(evidence, Mapping) else None
    ks = controls.get("kalinikos_slab_n0") if isinstance(controls, Mapping) else None
    if not isinstance(ks, Mapping):
        reasons.append("missing analytic_controls.kalinikos_slab_n0 evidence for c1")
        return _new_check("missing")
    samples = ks.get("samples")
    if not isinstance(samples, list):
        reasons.append("Kalinikos–Slavin evidence has no samples array")
        return _new_check("fail")
    geometries: set[str] = set()
    errors: list[float] = []
    profiles: list[dict[str, Any]] = []
    frequency_rows_by_geometry: dict[str, list[tuple[float, float, float, int]]] = {}
    for index, sample in enumerate(samples):
        if not isinstance(sample, Mapping):
            reasons.append(f"Kalinikos–Slavin sample {index} is not an object")
            continue
        geometry = sample.get("geometry")
        if geometry not in {"backward_volume", "damon_eshbach"}:
            reasons.append(f"Kalinikos–Slavin sample {index} has unsupported geometry {geometry!r}")
            continue
        run = _load_numeric_bundle(case_dir, sample.get("run"), f"Kalinikos–Slavin sample {index}", reasons, require_demag=True)
        if run is None:
            continue
        _validate_homogeneous_slab_applicability(
            run,
            f"Kalinikos–Slavin sample {index}",
            parameters,
            reasons,
        )
        _require_matching_evidence_cell_geometry(
            primary_metadata,
            run.get("metadata"),
            f"Kalinikos–Slavin sample {index}",
            reasons,
        )
        sample_index = sample.get("sample_index")
        branch_id = sample.get("branch_id", 0)
        if type(sample_index) is not int or type(branch_id) is not int or sample_index < 0 or branch_id < 0:
            reasons.append(f"Kalinikos–Slavin sample {index} lacks integer sample_index/branch_id")
            continue
        observed, vector = _bundle_observation(run, sample_index, branch_id, f"Kalinikos–Slavin sample {index}", reasons)
        if observed is None or vector is None:
            continue
        _bundle_branch_is_lowest_positive(
            run,
            sample_index,
            branch_id,
            f"Kalinikos–Slavin sample {index}",
            reasons,
        )
        profiles.append(_measure_ks_profile(run, sample_index, branch_id, vector, parameters, f"Kalinikos–Slavin sample {index}", reasons))
        k_actual = _vector_norm(vector)
        declared_k = sample.get("k_rad_per_m")
        if not _finite(declared_k) or declared_k < 0:
            reasons.append(f"Kalinikos–Slavin sample {index} requires finite nonnegative k_rad_per_m")
        elif _relative_error(k_actual, float(declared_k)) > 1.0e-8:
            reasons.append(f"Kalinikos–Slavin sample {index} declares k inconsistent with the numeric spectrum")
        scale = max(1.0, k_actual)
        if abs(vector[2]) > 1.0e-8 * scale:
            reasons.append(f"Kalinikos–Slavin sample {index} is not an in-plane wavevector")
        if geometry == "backward_volume" and (abs(vector[1]) > 1.0e-8 * scale or abs(vector[0]) <= 1.0e-12 * scale):
            reasons.append(f"Kalinikos–Slavin BV sample {index} is not parallel to the bias axis")
        if geometry == "damon_eshbach" and (abs(vector[0]) > 1.0e-8 * scale or abs(vector[1]) <= 1.0e-12 * scale):
            reasons.append(f"Kalinikos–Slavin DE sample {index} is not perpendicular to the bias axis")
        expected = _kalinikos_frequency_hz(k_actual, geometry, parameters)
        if not _finite_positive(expected):
            reasons.append(f"Kalinikos–Slavin sample {index} has no finite analytic reference")
            continue
        error = _relative_error(observed, float(expected))
        geometries.add(geometry)
        errors.append(error)
        frequency_rows_by_geometry.setdefault(geometry, []).append(
            (k_actual, float(observed), float(expected), index)
        )
        if error > KS_RELATIVE_TOLERANCE:
            reasons.append(f"Kalinikos–Slavin {geometry} sample {index} error {error:.6g} exceeds {KS_RELATIVE_TOLERANCE:.6g}")
    frequency_continuity_errors: list[float] = []
    frequency_continuity_pairs: list[dict[str, Any]] = []
    for geometry, rows in frequency_rows_by_geometry.items():
        rows.sort(key=lambda row: (row[0], row[3]))
        for left, right in zip(rows, rows[1:]):
            expected_delta = right[2] - left[2]
            observed_delta = right[1] - left[1]
            continuity_error = abs(observed_delta - expected_delta) / max(
                abs(left[2]), abs(right[2]), 1.0
            )
            frequency_continuity_errors.append(continuity_error)
            frequency_continuity_pairs.append(
                {
                    "geometry": geometry,
                    "left_sample_index": left[3],
                    "right_sample_index": right[3],
                    "left_k_rad_per_m": left[0],
                    "right_k_rad_per_m": right[0],
                    "relative_error": continuity_error,
                }
            )
            if continuity_error > KS_FREQUENCY_CONTINUITY_TOLERANCE:
                reasons.append(
                    f"Kalinikos–Slavin {geometry} frequency continuity between samples "
                    f"{left[3]} and {right[3]} error {continuity_error:.6g} exceeds "
                    f"{KS_FREQUENCY_CONTINUITY_TOLERANCE:.6g}"
                )
    for geometry in ("backward_volume", "damon_eshbach"):
        if geometry not in geometries:
            reasons.append(f"Kalinikos–Slavin evidence is missing a {geometry} applicability sample")
    if ks.get("status") != "pass":
        reasons.append("Kalinikos–Slavin evidence is not explicitly marked pass")
    maximum = max(errors, default=math.inf)
    maximum_continuity = max(frequency_continuity_errors, default=None)
    return _new_check(
        "pass" if len(reasons) == initial_reason_count and geometries == {"backward_volume", "damon_eshbach"} and errors and maximum <= KS_RELATIVE_TOLERANCE and (maximum_continuity is None or maximum_continuity <= KS_FREQUENCY_CONTINUITY_TOLERANCE) and ks.get("status") == "pass" else "fail",
        sample_count=len(samples),
        n0_profiles=profiles,
        geometries=sorted(geometries),
        max_relative_error=maximum if math.isfinite(maximum) else None,
        tolerance=KS_RELATIVE_TOLERANCE,
        frequency_continuity_pairs=frequency_continuity_pairs,
        max_frequency_continuity_error=maximum_continuity,
        frequency_continuity_tolerance=KS_FREQUENCY_CONTINUITY_TOLERANCE,
    )


def _manifest_identity(bundle: Mapping[str, Any], key: str) -> object:
    manifest = bundle.get("manifest")
    if not isinstance(manifest, Mapping):
        return None
    if key == "mesh":
        for candidate in (manifest.get("mesh_identity"), _nested(manifest, "geometry", "mesh_id"), _nested(manifest, "benchmark", "mesh_id")):
            if candidate is not None:
                return candidate
    if key == "airbox":
        for candidate in (
            _nested(manifest, "geometry", "air_padding_each_side_m"),
            manifest.get("airbox_size_m"),
            _nested(manifest, "benchmark", "air_padding_each_side_m"),
        ):
            if candidate is not None:
                return candidate
    return None


def _bundle_identity(bundle: Mapping[str, Any], key: str) -> object:
    metadata = bundle.get("metadata")
    plan = _metadata_backend_plan(metadata) if isinstance(metadata, Mapping) else None
    diagnostics = bundle.get("diagnostics")
    if not isinstance(plan, Mapping):
        return _manifest_identity(bundle, key)
    if key == "mesh":
        return (
            plan.get("mesh_name") or _nested(plan, "mesh", "mesh_name"),
            _backend_mesh_hmax(plan),
        )
    if key == "airbox":
        return _backend_airbox_value(plan)
    if key == "mode_count":
        return (
            plan.get("count"),
            diagnostics.get("requested_mode_count") if isinstance(diagnostics, Mapping) else None,
        )
    return None


def _uniform_nodal_signature(samples: object) -> object:
    """Represent a constant nodal field without its mesh-dependent repetition.

    Nonuniform fields retain their complete values: they need an independent
    spatial transfer check, not an average that could conceal a changed state.
    """
    if not isinstance(samples, list) or not samples:
        return samples
    first = samples[0]
    finite_first = _finite(first) or (
        isinstance(first, list) and len(first) == 3 and all(_finite(value) for value in first)
    )
    if finite_first and all(value == first for value in samples):
        return {"uniform_value": first}
    return samples


def _backend_signature(metadata: Mapping[str, Any], *, vary: str | None = None) -> str | None:
    """Remove only the inputs intentionally varied by this convergence test."""
    plan = _metadata_backend_plan(metadata)
    if not isinstance(plan, Mapping):
        return None
    value = dict(plan)
    if vary in {"mesh", "airbox"}:
        for key in ("mesh", "mesh_name", "mesh_source", "mesh_build_report"):
            value.pop(key, None)
        value["equilibrium_magnetization"] = _uniform_nodal_signature(value.get("equilibrium_magnetization"))
        material = value.get("material")
        if isinstance(material, Mapping):
            value["material"] = {
                key: _uniform_nodal_signature(field) if key.endswith("_field") else field
                for key, field in material.items()
            }
        segments = value.get("object_segments")
        if isinstance(segments, list):
            value["object_segments"] = [
                {key: field for key, field in segment.items() if key not in {
                    "node_start", "node_count", "element_start", "element_count",
                    "boundary_face_start", "boundary_face_count",
                }} if isinstance(segment, Mapping) else segment
                for segment in segments
            ]
        parts = value.get("mesh_parts")
        if isinstance(parts, list):
            value["mesh_parts"] = [
                {key: field for key, field in part.items() if key not in {
                    "element_selector", "boundary_face_selector", "node_selector",
                    "boundary_face_indices", "node_indices", "facet_global_ordinals",
                    "bounds_min", "bounds_max",
                }} if isinstance(part, Mapping) else part
                for part in parts
            ]
    if vary == "mesh":
        value.pop("hmax", None)
        # h-refinement does not authorize changing finite-element order.
    if vary == "airbox":
        air = value.get("air_box_config")
        if isinstance(air, Mapping):
            value["air_box_config"] = {key: field for key, field in air.items() if key in {
                "bc_kind", "boundary_marker", "robin_beta", "grading", "shape",
            }}
        frame = value.get("domain_frame")
        if isinstance(frame, Mapping):
            value["domain_frame"] = {key: frame.get(key) for key in (
                "object_bounds_min", "object_bounds_max",
            )}
    if vary == "mode_count":
        value.pop("count", None)
        # Same mesh, physical state, target and search window; only count varies.
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError):
        return None


def _validate_convergence_coverage(bundle, case, label, reasons):
    samples = bundle["spectrum"].get("samples", [])
    expected = {0} if case == "c0" else set(range(EXPECTED_PATH_SAMPLE_COUNT))
    actual = {sample.get("sample_index") for sample in samples
              if isinstance(sample, Mapping) and type(sample.get("sample_index")) is int}
    if actual != expected:
        reasons.append(f"{label} does not cover the complete benchmark sample set")
    modes = {(sample["sample_index"], mode["raw_mode_index"]): mode["frequency_real_hz"]
             for sample in samples if isinstance(sample, Mapping) and type(sample.get("sample_index")) is int
             and isinstance(sample.get("modes"), list)
             for mode in sample["modes"] if isinstance(mode, Mapping) and type(mode.get("raw_mode_index")) is int
             and _finite(mode.get("frequency_real_hz"))}
    branch_reasons = []
    _validate_branches(bundle["branches"], case, modes, branch_reasons)
    reasons.extend(f"{label}: {reason}" for reason in branch_reasons)


def _validate_convergence_path(bundle, primary, label, reasons):
    if not isinstance(primary, Mapping):
        reasons.append(f"{label} requires the primary spectrum for path verification")
        return
    reference_samples = primary.get("spectrum", {}).get("samples", [])
    references = {item["sample_index"]: item.get("k_vector") for item in reference_samples
                  if isinstance(item, Mapping) and type(item.get("sample_index")) is int}
    for sample in bundle["spectrum"].get("samples", []):
        if not isinstance(sample, Mapping) or type(sample.get("sample_index")) is not int:
            continue
        index = sample["sample_index"]
        actual, expected = sample.get("k_vector"), references.get(index)
        if not isinstance(actual, list) or not isinstance(expected, list) or len(actual) != 3 or len(expected) != 3 or any(
            not _finite(a) or not _finite(b) or abs(a-b) > 1e-8 * max(1.0, abs(b)) for a, b in zip(actual, expected)
        ):
            reasons.append(f"{label} sample {index} wavevector differs from the primary path")


def _validate_convergence_pair(
    case_dir: Path,
    evidence: Mapping[str, Any] | None,
    key: str,
    case: str,
    primary_metadata: Mapping[str, Any] | None,
    reasons: list[str],
    *,
    primary_bundle: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    reason_count = len(reasons)
    convergence = evidence.get("convergence") if isinstance(evidence, Mapping) else None
    section = convergence.get(key) if isinstance(convergence, Mapping) else None
    if key == "airbox" and case == "c0":
        if isinstance(section, Mapping) and section.get("status") == "not_applicable" and isinstance(section.get("reason"), str) and section["reason"].strip():
            return _new_check("not_applicable", reason=section["reason"])
        reasons.append("c0 airbox convergence must be explicitly marked not_applicable with a reason")
        return _new_check("missing")
    if not isinstance(section, Mapping):
        reasons.append(f"missing convergence.{key} evidence")
        return _new_check("missing")
    if section.get("status") != "pass":
        reasons.append(f"convergence.{key} is not explicitly marked pass")
    runs = section.get("runs")
    if not isinstance(runs, Mapping):
        reasons.append(f"convergence.{key} is missing numeric run bundles")
        return _new_check("missing")
    left_name, right_name = (("coarse", "fine") if key in {"mesh", "airbox"} else ("baseline", "check"))
    left = _load_numeric_bundle(case_dir, runs.get(left_name), f"convergence.{key}.{left_name}", reasons, require_demag=case in PATH_CASES)
    right = _load_numeric_bundle(case_dir, runs.get(right_name), f"convergence.{key}.{right_name}", reasons, require_demag=case in PATH_CASES)
    if left is None or right is None:
        return _new_check("fail")
    _validate_convergence_coverage(left, case, f"convergence.{key}.{left_name}", reasons)
    _validate_convergence_coverage(right, case, f"convergence.{key}.{right_name}", reasons)
    _validate_convergence_path(left, primary_bundle, f"convergence.{key}.{left_name}", reasons)
    _validate_convergence_path(right, primary_bundle, f"convergence.{key}.{right_name}", reasons)
    if key in {"mesh", "airbox"}:
        left_identity = _bundle_identity(left, key)
        right_identity = _bundle_identity(right, key)
        if left_identity is None or right_identity is None:
            reasons.append(f"convergence.{key} native metadata does not expose the varied {key} identity")
        elif left_identity == right_identity:
            reasons.append(f"convergence.{key} runs have identical {key} identities")
        elif key == "mesh":
            left_hmax = left_identity[1] if isinstance(left_identity, tuple) else None
            right_hmax = right_identity[1] if isinstance(right_identity, tuple) else None
            if not _finite_positive(left_hmax) or not _finite_positive(right_hmax) or not float(right_hmax) < float(left_hmax):
                reasons.append("convergence.mesh fine run does not prove a smaller resolved hmax")
        elif key == "airbox":
            if not _finite_positive(left_identity) or not _finite_positive(right_identity) or not float(right_identity) > float(left_identity):
                reasons.append("convergence.airbox fine run does not prove a larger resolved airbox")
    if primary_metadata is None:
        reasons.append(f"convergence.{key} cannot bind comparison runs to the primary native metadata")
    else:
        primary_signature = _backend_signature(primary_metadata, vary=key)
        left_metadata = left.get("metadata")
        right_metadata = right.get("metadata")
        left_signature = _backend_signature(left_metadata, vary=key) if isinstance(left_metadata, Mapping) else None
        right_signature = _backend_signature(right_metadata, vary=key) if isinstance(right_metadata, Mapping) else None
        if primary_signature is None or left_signature != primary_signature or right_signature != primary_signature:
            reasons.append(f"convergence.{key} runs do not hold the resolved FEM physics inputs fixed")
    if key == "mode_count":
        if section.get("baseline_requested_modes") != 24 or section.get("check_requested_modes") != 48:
            reasons.append("mode-count convergence must compare requested modes 24 against 48")
        for name, bundle, expected in ((left_name, left, 24), (right_name, right, 48)):
            actual = _bundle_identity(bundle, "mode_count")
            actual_count = actual[0] if isinstance(actual, tuple) else None
            diagnostics_count = actual[1] if isinstance(actual, tuple) else None
            if actual_count != expected or diagnostics_count != expected:
                reasons.append(f"convergence.mode_count.{name} resolved requested mode count is {(actual_count, diagnostics_count)!r}, expected {expected}")
    comparisons = section.get("comparisons")
    if not isinstance(comparisons, list):
        reasons.append(f"convergence.{key}.comparisons is missing")
        return _new_check("fail")
    expected_pairs = {(sample, band) for sample in (EXPECTED_CONTROL_SAMPLES if case in PATH_CASES else (0,)) for band in range(EXPECTED_TARGET_BANDS if case in PATH_CASES else 1)}
    observed_pairs: set[tuple[int, int]] = set()
    errors: list[float] = []
    changes: dict[str, float] = {}
    for index, comparison in enumerate(comparisons):
        if not isinstance(comparison, Mapping):
            reasons.append(f"convergence.{key} comparison {index} is not an object")
            continue
        sample = comparison.get("sample_index")
        band = comparison.get("branch_id")
        if not isinstance(sample, int) or isinstance(sample, bool) or not isinstance(band, int) or isinstance(band, bool):
            reasons.append(f"convergence.{key} comparison {index} lacks integer sample_index/branch_id")
            continue
        pair = (sample, band)
        if pair in observed_pairs:
            reasons.append(f"convergence.{key} comparison {index} duplicates sample/band pair {pair}")
            continue
        observed_pairs.add(pair)
        coarse, coarse_k = _bundle_observation(left, sample, band, f"convergence.{key}.coarse", reasons)
        fine, fine_k = _bundle_observation(right, sample, band, f"convergence.{key}.fine", reasons)
        if coarse is None or fine is None or coarse_k is None or fine_k is None:
            continue
        if primary_bundle is not None:
            primary, primary_k = _bundle_observation(
                primary_bundle,
                sample,
                band,
                f"convergence.{key}.primary",
                reasons,
            )
            if primary is not None and primary_k is not None:
                if any(
                    abs(a - b) > 1.0e-8 * max(1.0, abs(a), abs(b))
                    for a, b in zip(primary_k, coarse_k)
                ) or any(
                    abs(a - b) > 1.0e-8 * max(1.0, abs(a), abs(b))
                    for a, b in zip(primary_k, fine_k)
                ):
                    reasons.append(
                        f"convergence.{key} comparison {index} does not use the primary k vector"
                    )
                for run_name, observed in (("coarse", coarse), ("fine", fine)):
                    primary_error = _relative_error(observed, primary)
                    if primary_error > CONVERGENCE_RELATIVE_TOLERANCE:
                        reasons.append(
                            f"convergence.{key}.{run_name} comparison {index} differs from the primary numeric spectrum by {primary_error:.6g}"
                        )
        if any(abs(a - b) > 1.0e-8 * max(1.0, abs(a), abs(b)) for a, b in zip(coarse_k, fine_k)):
            reasons.append(f"convergence.{key} comparison {index} uses different k vectors")
        error = _relative_error(coarse, fine)
        errors.append(error)
        changes[f"{sample}:{band}"] = error
        if error > CONVERGENCE_RELATIVE_TOLERANCE:
            reasons.append(f"convergence.{key} comparison {index} change {error:.6g} exceeds {CONVERGENCE_RELATIVE_TOLERANCE:.6g}")
    missing = sorted(expected_pairs - observed_pairs)
    if missing:
        reasons.append(f"convergence.{key} is missing {len(missing)} required sample/band comparisons")
    maximum = max(errors, default=math.inf)
    return _new_check(
        "pass" if len(reasons) == reason_count and section.get("status") == "pass" and not missing and errors and maximum <= CONVERGENCE_RELATIVE_TOLERANCE else "fail",
        relative_changes=changes,
        comparison_count=len(comparisons),
        expected_comparison_count=len(expected_pairs),
        max_relative_change=maximum if math.isfinite(maximum) else None,
        tolerance=CONVERGENCE_RELATIVE_TOLERANCE,
    )


def _validate_convergence(
    case_dir: Path,
    evidence: Mapping[str, Any] | None,
    key: str,
    case: str,
    primary_metadata: Mapping[str, Any] | None,
    reasons: list[str],
    *,
    primary_bundle: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Require three resolved levels and measure both adjacent increments."""
    if key == "mode_count" or (key == "airbox" and case == "c0"):
        return _validate_convergence_pair(
            case_dir, evidence, key, case, primary_metadata, reasons,
            primary_bundle=primary_bundle,
        )
    convergence = evidence.get("convergence") if isinstance(evidence, Mapping) else None
    section = convergence.get(key) if isinstance(convergence, Mapping) else None
    runs = section.get("runs") if isinstance(section, Mapping) else None
    if not isinstance(runs, Mapping) or any(not isinstance(runs.get(name), Mapping) for name in ("coarse", "medium", "fine")):
        reasons.append(f"missing convergence.{key} three-level evidence: coarse, medium, fine numeric bundles are required")
        return _new_check("fail", required_level_count=3)
    initial_reason_count = len(reasons)
    checks = []
    for left_name, right_name in (("coarse", "medium"), ("medium", "fine")):
        pair_section = dict(section)
        pair_section["runs"] = {"coarse": runs[left_name], "fine": runs[right_name]}
        pair_evidence = dict(evidence)
        pair_evidence["convergence"] = {**convergence, key: pair_section}
        check = _validate_convergence_pair(
            case_dir, pair_evidence, key, case, primary_metadata, reasons,
            primary_bundle=primary_bundle,
        )
        check["levels"] = [left_name, right_name]
        checks.append(check)
    first = checks[0].get("relative_changes", {})
    second = checks[1].get("relative_changes", {})
    # This small dimensionless margin avoids treating roundoff-sized variation
    # as divergence. It is not an estimate of continuum or analytic-model error.
    trend_margin = 1.0e-8
    for pair in sorted(first.keys() & second.keys()):
        if second[pair] > first[pair] + trend_margin:
            reasons.append(f"convergence.{key} sample/band {pair} increments grow from {first[pair]:.6g} to {second[pair]:.6g}")
    return _new_check(
        "pass" if len(reasons) == initial_reason_count and all(check["status"] == "pass" for check in checks) else "fail",
        required_level_count=3,
        adjacent_comparisons=checks,
        trend_margin=trend_margin,
        continuum_error_estimate=None,
    )


def _validate_evidence_binding(
    case_dir: Path,
    evidence: Mapping[str, Any] | None,
    artifacts: Mapping[Path, Mapping[str, Any]],
    case: str,
    reasons: list[str],
) -> dict[str, Any]:
    if evidence is None:
        reasons.append(f"missing scientific evidence bundle: {EVIDENCE_RELATIVE_PATH.as_posix()}")
        return _new_check("missing", path=EVIDENCE_RELATIVE_PATH.as_posix())
    if evidence.get("schema_version") != EVIDENCE_SCHEMA:
        reasons.append("scientific evidence bundle has an unsupported schema_version")
    if evidence.get("case_id") != case:
        reasons.append("scientific evidence bundle case_id does not match the output directory")
    numeric = evidence.get("numeric_run")
    if not isinstance(numeric, Mapping):
        reasons.append("scientific evidence is missing numeric_run provenance")
    else:
        if numeric.get("frequency_source") not in {NUMERIC_FREQUENCY_SOURCE, "native_solver_attested"}:
            reasons.append("scientific evidence does not identify the native numeric FEM solver as frequency source")
        if numeric.get("analytic_solver_used_for_frequencies") is not False:
            reasons.append("scientific evidence does not prove that the analytic solver was excluded from FEM frequencies")
        if case in {"c1", "a1"} and numeric.get("dynamic_demag_operator_source") != "numeric_modal_solver":
            reasons.append("scientific evidence does not identify numeric_modal_solver as dynamic-demag source")
    bindings = evidence.get("artifact_bindings")
    if not isinstance(bindings, Mapping):
        reasons.append("scientific evidence is missing artifact_bindings")
    else:
        expected_keys = {
            "metadata.json": "metadata_sha256",
            "eigen/spectrum.v2.json": "spectrum_v2_sha256",
            "eigen/branches.v2.json": "branches_v2_sha256",
            "eigen/dispersion.csv": "dispersion_csv_sha256",
            "frequency_domain/manifest.v1.json": "manifest_sha256",
            "eigen/diagnostics/solver.v1.json": "solver_diagnostics_sha256",
        }
        for relative, key in expected_keys.items():
            actual = artifacts.get(Path(relative), {}).get("sha256")
            if bindings.get(key) != actual:
                reasons.append(f"scientific evidence binding does not match current {relative}")
    return _new_check("pass" if not any("scientific evidence" in reason or "binding" in reason for reason in reasons) else "fail", path=EVIDENCE_RELATIVE_PATH.as_posix())


def validate_case(
    case_dir: Path,
    case: str,
    *,
    parameters_path: Path,
    kpath_path: Path | None = None,
) -> dict[str, Any]:
    """Validate one numeric case and return a JSON-serializable gate report."""

    if case not in EXPECTED_CASES:
        raise ScientificGateError(f"unsupported benchmark case: {case}")
    reasons: list[str] = []
    artifacts, artifact_reasons = _artifact_map(case_dir)
    reasons.extend(artifact_reasons)
    parameters, parameter_reasons = _load_parameters(parameters_path)
    reasons.extend(parameter_reasons)
    expected_path: dict[int, tuple[float, float, float]] = {}
    if kpath_path is None:
        kpath_path = parameters_path.parent / "kpath.csv"
    if case in PATH_CASES:
        expected_path, path_reasons = _path_rows(kpath_path)
        reasons.extend(path_reasons)
        if len(expected_path) != EXPECTED_PATH_SAMPLE_COUNT:
            reasons.append(f"canonical k-path has {len(expected_path)} samples; {EXPECTED_PATH_SAMPLE_COUNT} are required")
    spectrum: dict[str, Any] = {}
    branches: dict[str, Any] = {}
    manifest: dict[str, Any] = {}
    metadata: dict[str, Any] = {}
    diagnostics: dict[str, Any] = {}
    if Path("metadata.json") in artifacts:
        metadata, error = _load_json(case_dir / "metadata.json")
        if error:
            reasons.append(error)
            metadata = {}
    if Path("eigen/spectrum.v2.json") in artifacts:
        spectrum, error = _load_json(case_dir / "eigen/spectrum.v2.json")
        if error:
            reasons.append(error)
            spectrum = {}
    if Path("eigen/branches.v2.json") in artifacts:
        branches, error = _load_json(case_dir / "eigen/branches.v2.json")
        if error:
            reasons.append(error)
            branches = {}
    if Path("frequency_domain/manifest.v1.json") in artifacts:
        manifest, error = _load_json(case_dir / "frequency_domain/manifest.v1.json")
        if error:
            reasons.append(error)
            manifest = {}
    if Path("eigen/diagnostics/solver.v1.json") in artifacts:
        diagnostics, error = _load_json(case_dir / "eigen/diagnostics/solver.v1.json")
        if error:
            reasons.append(error)
            diagnostics = {}
    _validate_payload_schemas(
        {"spectrum": spectrum, "branches": branches, "manifest": manifest}, "primary", reasons,
    )
    sample_map: dict[int, dict[str, Any]] = {}
    mode_map: dict[tuple[int, int], float] = {}
    if spectrum:
        sample_map, mode_map = _validate_spectrum(spectrum, case, expected_path, reasons)
    selected_branches: list[dict[str, Any]] = []
    branch_check = _new_check("missing")
    if branches:
        selected_branches, branch_check = _validate_branches(branches, case, mode_map, reasons)
    csv_check = _new_check("missing")
    if Path("eigen/dispersion.csv") in artifacts:
        csv_check = _validate_dispersion_csv(
            case_dir / "eigen/dispersion.csv",
            case,
            expected_path,
            sample_map,
            mode_map,
            selected_branches,
            reasons,
        )
    source_check = _new_check("missing")
    if manifest and diagnostics:
        source_check = _validate_numeric_source(manifest, diagnostics, case, reasons)
    if parameters and metadata:
        _validate_benchmark_metadata(
            metadata,
            case,
            parameters,
            "primary case",
            reasons,
            require_uniform_slab=case == "c1",
        )
    field_check = _validate_exported_mode_fields(case_dir, case, selected_branches, sample_map, reasons)
    evidence: dict[str, Any] | None = None
    evidence_path = case_dir / EVIDENCE_RELATIVE_PATH
    if evidence_path.is_file():
        evidence, error = _load_json(evidence_path)
        if error:
            reasons.append(error)
            evidence = None
    evidence_check = _validate_evidence_binding(case_dir, evidence, artifacts, case, reasons)
    kittel_check = _validate_kittel(case, selected_branches, parameters or {}, reasons) if parameters else _new_check("missing")
    ks_check = _validate_ks(case_dir, case, evidence, parameters or {}, reasons, primary_metadata=metadata or None) if parameters else _new_check("missing")
    dispersion_analytic_check = (
        _validate_dispersion_analytic_coverage(case, selected_branches, expected_path, parameters or {}, reasons)
        if parameters else _new_check("missing")
    )
    convergence = {
        key: _validate_convergence(
            case_dir,
            evidence,
            key,
            case,
            metadata if metadata else None,
            reasons,
            primary_bundle={
                "metadata": metadata,
                "spectrum": spectrum,
                "branches": branches,
                "manifest": manifest,
                "diagnostics": diagnostics,
            },
        )
        for key in ("mesh", "airbox", "mode_count")
    }
    finite_check = _new_check(
        "pass" if not any("non-finite" in reason for reason in reasons) else "fail",
        sample_count=len(sample_map),
        mode_count=len(mode_map),
    )
    status = "qualified" if not reasons else "not_qualified"
    return {
        "schema_version": GATE_SCHEMA,
        "case_id": case,
        "status": status,
        "qualification": "QUALIFIED" if status == "qualified" else "NOT VERIFIED",
        "reasons": reasons,
        "checks": {
            "artifact_binding": evidence_check,
            "numeric_source": source_check,
            "modal_field_phase": field_check,
            "finite_values": finite_check,
            "spectrum_samples": _new_check("pass" if len(sample_map) == (1 if case == "c0" else EXPECTED_PATH_SAMPLE_COUNT) else "fail", sample_count=len(sample_map)),
            "tracked_branches": branch_check,
            "dispersion_csv": csv_check,
            "kittel": kittel_check,
            "kalinikos_slab_n0": ks_check,
            "dispersion_analytic_coverage": dispersion_analytic_check,
            "mesh_convergence": convergence["mesh"],
            "airbox_convergence": convergence["airbox"],
            "mode_count_convergence": convergence["mode_count"],
        },
        "artifact_bindings": {path.as_posix(): record for path, record in artifacts.items()},
        "evidence_path": EVIDENCE_RELATIVE_PATH.as_posix(),
        "parameters_path": str(parameters_path),
    }


def validate_requested_cases(case_results: Mapping[str, Mapping[str, Any]], cases: Sequence[str]) -> dict[str, Any]:
    """Combine case gates without allowing a partial case selection to qualify."""

    reasons: list[str] = []
    requested = tuple(cases)
    if requested != EXPECTED_CASES:
        reasons.append(f"complete COMSOL qualification requires cases {','.join(EXPECTED_CASES)}; requested {','.join(requested)}")
    for case in requested:
        result = case_results.get(case)
        if not isinstance(result, Mapping):
            reasons.append(f"scientific gate result is missing for case {case}")
        elif result.get("status") != "qualified" or result.get("reasons") != []:
            # A failed/missing status fails independently of optional prose.
            # Empty reasons must never promote an unsuccessful child to pass.
            reasons.append(f"{case}: scientific gate status is {result.get('status')!r}, expected 'qualified' with an empty reason list")
            child_reasons = result.get("reasons")
            if isinstance(child_reasons, list):
                reasons.extend(f"{case}: {reason}" for reason in child_reasons if isinstance(reason, str) and reason)
            elif isinstance(child_reasons, str) and child_reasons:
                reasons.append(f"{case}: {child_reasons}")
    status = "qualified" if not reasons else "not_qualified"
    return {
        "schema_version": GATE_SCHEMA,
        "status": status,
        "qualification": "QUALIFIED" if status == "qualified" else "NOT VERIFIED",
        "requested_cases": list(requested),
        "required_cases": list(EXPECTED_CASES),
        "reasons": reasons,
    }


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case_dir", type=Path)
    parser.add_argument("--case", required=True, choices=EXPECTED_CASES)
    parser.add_argument("--parameters", type=Path, required=True)
    parser.add_argument("--kpath", type=Path)
    args = parser.parse_args(argv)
    report = validate_case(args.case_dir, args.case, parameters_path=args.parameters, kpath_path=args.kpath)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["status"] == "qualified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
