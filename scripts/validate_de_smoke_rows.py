"""Strict numerical-row preflight for DE-SMOKE; not a scientific certificate.

T4, field/profile identity and convergence remain separate requirements even
when this check passes. Frequencies are never replaced by a reference model.
"""
from __future__ import annotations
import csv
import json
import math
from pathlib import Path

SAMPLING = {
    "two": (0.0, 2e6),
    "five": (0.0, 1e6, 2e6, 3e6, 5e6),
    "k2": (2e6,),
    "k25": (25e6,),
    "bv-k25": (25e6,),
    "positive-six": (2e6, 5e6, 10e6, 15e6, 20e6, 25e6),
    "bv-positive-six": (2e6, 5e6, 10e6, 15e6, 20e6, 25e6),
    "k0": (0.0,),
    "positive-26": tuple(k * 1e6 for k in range(26)),
    "bv-positive-26": tuple(k * 1e6 for k in range(26)),
    "signed-eleven": (-3e6, -2e6, -1.5e6, -1e6, -0.5e6, 0.0,
                      0.5e6, 1e6, 1.5e6, 2e6, 3e6),
}
for _prefix in ("", "bv-"):
    for _k_um in range(-25, 26):
        SAMPLING.setdefault(f"{_prefix}k{_k_um}", (_k_um * 1e6,))
DENSE_SAMPLING = frozenset(("positive-26", "bv-positive-26"))
DENSE_CERTIFICATION_TOLERANCE = 1e-8
MAX_PROBE_RELATIVE_TOLERANCE = 1e-8
GAMMA_NZ_RELATIVE_TOLERANCE = 5e-3
GAMMA_NY_ABSOLUTE_TOLERANCE = 5e-3
GEOMETRY_RELATIVE_TOLERANCE = 1e-6


def load_solver_diagnostics(path: Path):
    try:
        diagnostics = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("missing or invalid DE-SMOKE solver diagnostics") from error
    if not isinstance(diagnostics, dict):
        raise ValueError("DE-SMOKE solver diagnostics must be an object")
    return diagnostics


def diagnostics_by_sample(diagnostics, required_sample_indices, fallback_probe_key):
    sample_records = diagnostics.get("sample_solver_diagnostics")
    by_sample = {}
    if sample_records is None:
        if len(required_sample_indices) != 1 or fallback_probe_key not in diagnostics:
            raise ValueError(f"per-sample {fallback_probe_key} diagnostics are required")
        by_sample[required_sample_indices[0]] = diagnostics
        return by_sample
    if not isinstance(sample_records, list):
        raise ValueError("sample_solver_diagnostics must be a list")
    for position, record in enumerate(sample_records):
        if not isinstance(record, dict):
            raise ValueError(f"sample_solver_diagnostics[{position}] must be an object")
        sample_index = record.get("sample_index")
        if isinstance(sample_index, bool) or not isinstance(sample_index, int) or sample_index < 0:
            raise ValueError(f"sample_solver_diagnostics[{position}].sample_index is invalid")
        sample_diagnostics = record.get("diagnostics")
        if not isinstance(sample_diagnostics, dict):
            raise ValueError(f"sample_solver_diagnostics[{position}].diagnostics must be an object")
        if sample_index in by_sample:
            raise ValueError(f"duplicate solver diagnostics for sample {sample_index}")
        by_sample[sample_index] = sample_diagnostics
    return by_sample


def load_spectrum_v3_modes(path: Path):
    """Load per-mode relative residuals and their native block scope."""
    try:
        spectrum = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("missing or invalid native eigen_spectrum.v3 artifact") from error
    if not isinstance(spectrum, dict) or spectrum.get("schema_version") != "eigen_spectrum.v3":
        raise ValueError("native spectrum must use eigen_spectrum.v3")
    samples = spectrum.get("samples")
    if not isinstance(samples, list) or not samples:
        raise ValueError("native eigen_spectrum.v3 must contain samples")

    declared_count = spectrum.get("sample_count")
    if (isinstance(declared_count, bool) or not isinstance(declared_count, int) or
            declared_count != len(samples)):
        raise ValueError("native spectrum sample_count disagrees with its samples")
    sample_indices = set()
    result = {}
    for sample_position, sample in enumerate(samples):
        if not isinstance(sample, dict):
            raise ValueError(f"spectrum sample {sample_position} must be an object")
        sample_index = sample.get("sample_index")
        if isinstance(sample_index, bool) or not isinstance(sample_index, int) or sample_index < 0:
            raise ValueError(f"spectrum sample {sample_position} has invalid sample_index")
        if sample_index in sample_indices:
            raise ValueError(f"duplicate sample in native spectrum for sample {sample_index}")
        sample_indices.add(sample_index)
        modes = sample.get("modes")
        if not isinstance(modes, list) or not modes:
            raise ValueError(f"spectrum sample {sample_index} has no modes")
        for mode_position, mode in enumerate(modes):
            if not isinstance(mode, dict):
                raise ValueError(f"spectrum sample {sample_index} mode {mode_position} must be an object")
            mode_sample = mode.get("sample_index", sample_index)
            raw_mode_index = mode.get("raw_mode_index", mode.get("index"))
            if (isinstance(mode_sample, bool) or not isinstance(mode_sample, int) or
                    mode_sample != sample_index):
                raise ValueError(f"spectrum sample {sample_index} mode has mismatched sample_index")
            if (isinstance(raw_mode_index, bool) or not isinstance(raw_mode_index, int) or
                    raw_mode_index < 0):
                raise ValueError(f"spectrum sample {sample_index} mode has invalid raw_mode_index")
            key = (sample_index, raw_mode_index)
            if key in result:
                raise ValueError(f"duplicate mode in native spectrum for sample {sample_index}")

            residual = mode.get("residual_relative_l2")
            if (isinstance(residual, bool) or not isinstance(residual, (int, float)) or
                    not math.isfinite(residual) or residual < 0):
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} has invalid residual_relative_l2")
            frequency = mode.get("frequency_hz")
            if (isinstance(frequency, bool) or not isinstance(frequency, (int, float)) or
                    not math.isfinite(frequency) or frequency <= 0):
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} has invalid frequency_hz")

            block = mode.get("block_residuals")
            if not isinstance(block, dict):
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} is missing block_residuals")
            scope = block.get("scope")
            if scope not in (
                    "native_descriptor",
                    "reduced_original_blocks_only",
                    "full_projected_weak_form_and_periodic_seams"):
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} has unsupported residual scope")

            def residual_value(container, name, *, required=True):
                value = container.get(name)
                if value is None and not required:
                    return None
                if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                        not math.isfinite(value) or value < 0):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} has invalid {name}")
                return float(value)

            eps_q = residual_value(block, "eps_q")
            eps_phi = residual_value(block, "eps_phi")
            eps_gauge = residual_value(
                block, "eps_gauge", required=(scope == "native_descriptor"))
            reduced_values = [eps_q, eps_phi]
            if eps_gauge is not None:
                reduced_values.append(eps_gauge)
            reduced_max = max(reduced_values)

            certification_tolerance = block.get("certification_tolerance")
            if (isinstance(certification_tolerance, bool) or
                    not isinstance(certification_tolerance, (int, float)) or
                    not math.isfinite(certification_tolerance) or certification_tolerance <= 0):
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} has invalid certification_tolerance")
            certification_tolerance = float(certification_tolerance)
            full_certified = block.get("full_descriptor_certified")
            reduced_certified = block.get("reduced_pencil_certified")
            declared_reduced = residual_value(
                block, "eps_reduced", required=(scope != "native_descriptor"))
            declared_full = residual_value(
                block, "eps_full", required=(scope in (
                    "native_descriptor", "full_projected_weak_form_and_periodic_seams")))

            if scope == "native_descriptor":
                if block.get("certified") is not True or full_certified is not True:
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} has an incomplete full descriptor certificate")
                expected_residual = reduced_max
                if declared_full is None or not math.isclose(
                        declared_full, expected_residual, rel_tol=1e-12, abs_tol=1e-30):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_full is inconsistent")
            elif scope == "reduced_original_blocks_only":
                if (reduced_certified is not True or full_certified is not False or
                        block.get("certified") is not False):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} has an incomplete reduced-pencil certificate")
                if (declared_full is not None or declared_reduced is None or not math.isclose(
                        declared_reduced, reduced_max, rel_tol=1e-12, abs_tol=1e-30)):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_reduced is inconsistent")
                expected_residual = reduced_max
            else:
                if (block.get("certified") is not True or reduced_certified is not True or
                        full_certified is not True):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} has an incomplete Floquet full-descriptor certificate")
                if (declared_reduced is None or not math.isclose(
                        declared_reduced, reduced_max, rel_tol=1e-12, abs_tol=1e-30)):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_reduced is inconsistent")
                if eps_gauge is not None:
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} reports a gauge residual without a nonzero-k gauge equation")
                if (mode.get("potential_representation") != "complex_coefficients" or
                        mode.get("gauge_constraint_policy") != "nonzero_k_poisson_without_mean_constraint" or
                        mode.get("gauge_constraint_backward_error") is not None or
                        mode.get("floquet_descriptor_certified") is not True or
                        mode.get("floquet_full_descriptor_certified") is not True or
                        mode.get("floquet_seam_frame_certified") is not True or
                        mode.get("floquet_gauge_policy_satisfied") is not True or
                        not isinstance(mode.get("poisson_boundary_kind"), str) or
                        not mode["poisson_boundary_kind"] or
                        not isinstance(mode.get("poisson_gauge_policy"), str) or
                        not mode["poisson_gauge_policy"]):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} has inconsistent Floquet boundary or gauge provenance")

                full_values = [
                    residual_value(mode, "floquet_full_magnetic_relative_residual"),
                    residual_value(mode, "floquet_full_potential_relative_residual"),
                ]
                expected_full = max(full_values)
                if declared_full is None or not math.isclose(
                        declared_full, expected_full, rel_tol=1e-12, abs_tol=1e-30):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_full is inconsistent")
                if not math.isclose(
                        eps_q, residual_value(mode, "magnetic_relative_residual"),
                        rel_tol=1e-12, abs_tol=1e-30):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_q disagrees with magnetic residual")
                if not math.isclose(
                        eps_phi, residual_value(mode, "potential_relative_residual"),
                        rel_tol=1e-12, abs_tol=1e-30):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_phi disagrees with potential residual")
                seam_values = [residual_value(mode, name) for name in (
                    "floquet_scalar_phase_seam_relative_residual",
                    "floquet_tangent_frame_seam_relative_residual",
                    "floquet_cartesian_magnetic_seam_relative_residual",
                    "floquet_equilibrium_pair_relative_residual",
                )]
                expected_residual = max(reduced_max, expected_full, *seam_values)

            if expected_residual > certification_tolerance:
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} exceeds its block certification tolerance")
            if not math.isclose(float(residual), expected_residual, rel_tol=1e-12, abs_tol=1e-30):
                raise ValueError(
                    f"mode {raw_mode_index} residual_relative_l2 does not match its certified residual scope")

            result[key] = {
                "frequency_hz": float(frequency),
                "residual_relative_l2": float(residual),
                "residual_scope": scope,
                "full_descriptor_certified": full_certified,
                "certification_tolerance": certification_tolerance,
                "block_residuals": block,
                "poisson_boundary_kind": mode.get("poisson_boundary_kind"),
                "poisson_gauge_policy": mode.get("poisson_gauge_policy"),
            }
    return result


def _validate_dynamic_demag_probe(sample_index, probe, *, subwindow_index=None):
    context = f"sample {sample_index}"
    if subwindow_index is not None:
        context += f" subwindow {subwindow_index}"
    if not isinstance(probe, dict):
        raise ValueError(f"{context} is missing dynamic_demag_operator_probe")
    if probe.get("schema_version") != "floquet_dynamic_demag_operator_probe.v1":
        raise ValueError(f"{context} has an unsupported dynamic demag probe schema")
    if probe.get("status") != "passed":
        raise ValueError(f"{context} dynamic demag probe did not pass")
    if probe.get("potential_equation") != "P_phi_plus_A_phiq_q_equals_zero":
        raise ValueError(f"{context} dynamic demag probe equation is invalid")
    if probe.get("potential_coefficient_unit") != "A" or probe.get("energy_unit") != "J":
        raise ValueError(f"{context} dynamic demag probe units are invalid")

    tolerance = probe.get("relative_tolerance")
    if (isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)) or
            not math.isfinite(tolerance) or tolerance <= 0 or
            tolerance > MAX_PROBE_RELATIVE_TOLERANCE):
        raise ValueError(f"{context} dynamic demag probe tolerance is invalid")
    hermitian_defect = probe.get("hermitian_relative_defect")
    if (isinstance(hermitian_defect, bool) or not isinstance(hermitian_defect, (int, float)) or
            not math.isfinite(hermitian_defect) or hermitian_defect < 0 or
            hermitian_defect > tolerance):
        raise ValueError(f"{context} dynamic demag Hermitian defect exceeds tolerance")

    energy_values = []
    direction_reports = {}
    for direction in ("global_y", "global_z"):
        direction_sample = probe.get(direction)
        if (not isinstance(direction_sample, dict) or
                direction_sample.get("attempted") is not True or
                direction_sample.get("passed") is not True):
            raise ValueError(f"{context} dynamic demag {direction} probe is incomplete")
        q_norm = direction_sample.get("q_l2_norm")
        potential_residual = direction_sample.get("potential_relative_residual")
        energy_defect = direction_sample.get("energy_form_relative_defect")
        energy_self = direction_sample.get("self_energy_j")
        energy_potential = direction_sample.get("potential_energy_j")
        metrics = {
            "q_l2_norm": q_norm,
            "potential_relative_residual": potential_residual,
            "energy_form_relative_defect": energy_defect,
            "self_energy_j": energy_self,
            "potential_energy_j": energy_potential,
        }
        for name, value in metrics.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{context} dynamic demag {direction}.{name} is invalid")
        if q_norm <= 0 or potential_residual < 0 or potential_residual > tolerance:
            raise ValueError(f"{context} dynamic demag {direction} residual is invalid")
        if energy_defect < 0 or energy_defect > tolerance:
            raise ValueError(f"{context} dynamic demag {direction} energy mismatch exceeds tolerance")
        energy_values.extend((energy_self, energy_potential))
        direction_reports[direction] = {
            "q_l2_norm": q_norm,
            "potential_relative_residual": potential_residual,
            "energy_form_relative_defect": energy_defect,
        }

    energy_scale = max((abs(value) for value in energy_values), default=0.0)
    energy_floor = tolerance * energy_scale
    if any(value < -energy_floor for value in energy_values):
        raise ValueError(f"{context} dynamic demag energy is negative")
    report = {
        "hermitian_relative_defect": hermitian_defect,
        "directions": direction_reports,
    }
    if subwindow_index is not None:
        report["subwindow_index"] = subwindow_index
    return report


def validate_dynamic_demag_probes(path: Path, required_sample_indices):
    diagnostics = load_solver_diagnostics(path)
    by_sample = diagnostics_by_sample(
        diagnostics,
        required_sample_indices,
        "dynamic_demag_operator_probe")

    accepted = []
    for sample_index in required_sample_indices:
        sample_diagnostics = by_sample.get(sample_index)
        if sample_diagnostics is None:
            raise ValueError(f"missing solver diagnostics for nonzero-k sample {sample_index}")
        subwindows = sample_diagnostics.get("subwindows")
        if subwindows is None:
            probe_report = _validate_dynamic_demag_probe(
                sample_index,
                sample_diagnostics.get("dynamic_demag_operator_probe"))
            accepted.append({
                "sample_index": sample_index,
                "status": "passed",
                **probe_report,
            })
            continue
        if not isinstance(subwindows, list) or not subwindows:
            raise ValueError(f"sample {sample_index} has invalid dynamic demag subwindows")

        subwindow_reports = []
        seen_subwindow_indices = set()
        for position, subwindow in enumerate(subwindows):
            if not isinstance(subwindow, dict):
                raise ValueError(f"sample {sample_index} subwindow record {position} is invalid")
            subwindow_index = subwindow.get("index")
            if (isinstance(subwindow_index, bool) or not isinstance(subwindow_index, int) or
                    subwindow_index < 0):
                raise ValueError(f"sample {sample_index} subwindow record {position} has invalid index")
            if subwindow_index in seen_subwindow_indices:
                raise ValueError(f"sample {sample_index} has duplicate subwindow index {subwindow_index}")
            seen_subwindow_indices.add(subwindow_index)
            subwindow_reports.append(_validate_dynamic_demag_probe(
                sample_index,
                subwindow.get("dynamic_demag_operator_probe"),
                subwindow_index=subwindow_index))
        accepted.append({
            "sample_index": sample_index,
            "status": "passed",
            "subwindow_count": len(subwindow_reports),
            "subwindows": subwindow_reports,
        })
    return accepted


def validate_gamma_demag_probe(
    solver_diagnostics_path: Path,
    metadata_path: Path,
    gamma_sample_index: int):
    diagnostics = load_solver_diagnostics(solver_diagnostics_path)
    by_sample = diagnostics_by_sample(
        diagnostics,
        [gamma_sample_index],
        "poisson_airbox_k0_demag_operator_probe")
    sample_diagnostics = by_sample.get(gamma_sample_index)
    if sample_diagnostics is None:
        raise ValueError(f"missing Gamma solver diagnostics for sample {gamma_sample_index}")
    probe = sample_diagnostics.get("poisson_airbox_k0_demag_operator_probe")
    if not isinstance(probe, dict):
        raise ValueError("Gamma sample is missing poisson_airbox_k0_demag_operator_probe")
    if probe.get("schema_version") != "poisson_airbox_k0_demag_operator_probe.v1":
        raise ValueError("Gamma sample has an unsupported K0 demag probe schema")
    if probe.get("status") != "passed":
        raise ValueError("Gamma K0 demag probe did not pass")
    if probe.get("potential_equation") != "P_phi_plus_A_phiq_q_equals_zero":
        raise ValueError("Gamma K0 demag probe equation is invalid")
    if (probe.get("potential_coefficient_unit") != "A" or
            probe.get("field_unit") != "A/m" or probe.get("energy_unit") != "J"):
        raise ValueError("Gamma K0 demag probe units are invalid")
    if probe.get("outer_boundary_kind") != "poisson_dirichlet":
        raise ValueError("Gamma K0 demag probe must use the declared Dirichlet airbox")
    beta = probe.get("robin_beta")
    if isinstance(beta, bool) or not isinstance(beta, (int, float)) or beta != 0.0:
        raise ValueError("Gamma K0 demag probe has unexpected Robin data")
    tolerance = probe.get("relative_tolerance")
    if (isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)) or
            not math.isfinite(tolerance) or tolerance <= 0 or
            tolerance > MAX_PROBE_RELATIVE_TOLERANCE):
        raise ValueError("Gamma K0 demag probe tolerance is invalid")

    try:
        metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("missing or invalid DE-SMOKE run metadata") from error
    try:
        model = metadata["problem_meta"]["runtime_metadata"]["de_smoke"]
    except (KeyError, TypeError) as error:
        raise ValueError("run metadata is missing the frozen DE-SMOKE model parameters") from error
    if not isinstance(model, dict) or model.get("schema") != "fullmag.de-smoke.v1":
        raise ValueError("run metadata has an unsupported DE-SMOKE model descriptor")
    if model.get("orientation") not in ("M0=x,k=y,normal=z", "M0=x,k=x,normal=z"):
        raise ValueError("Gamma demag reference requires M0=x and film normal z")
    if model.get("outer_boundary_kind") != "poisson_dirichlet":
        raise ValueError("DE-SMOKE metadata does not declare the tested Dirichlet boundary")

    def positive_model_value(name):
        value = model.get(name)
        if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                not math.isfinite(value) or value <= 0):
            raise ValueError(f"DE-SMOKE metadata field {name} must be finite and positive")
        return float(value)

    thickness = positive_model_value("film_thickness_m")
    period = positive_model_value("cell_period_m")
    padding = positive_model_value("air_padding_each_side_m")
    expected_ms = positive_model_value("saturation_magnetization_a_per_m")
    expected_mu0 = positive_model_value("mu0_t_m_a")
    expected_volume = period * period * thickness
    expected_nz = 2.0 * padding / (2.0 * padding + thickness)
    volume = probe.get("magnetic_volume_m3")
    mu0 = probe.get("mu0_t_m_a")
    for name, value in (("magnetic_volume_m3", volume), ("mu0_t_m_a", mu0)):
        if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                not math.isfinite(value) or value <= 0):
            raise ValueError(f"Gamma K0 demag probe {name} is invalid")
    if abs(volume - expected_volume) > GEOMETRY_RELATIVE_TOLERANCE * expected_volume:
        raise ValueError("Gamma K0 demag probe magnetic volume disagrees with the declared geometry")
    if abs(mu0 - expected_mu0) > 1e-12 * expected_mu0:
        raise ValueError("Gamma K0 demag probe mu0 disagrees with the declared SI convention")

    directions = {}
    for direction in ("global_y", "global_z"):
        sample = probe.get(direction)
        if (not isinstance(sample, dict) or sample.get("attempted") is not True or
                sample.get("passed") is not True):
            raise ValueError(f"Gamma K0 {direction} probe is incomplete")
        metrics = (
            "q_l2_norm", "potential_relative_residual", "gauge_constraint_abs",
            "mean_field_a_per_m", "mean_magnetization_a_per_m", "demag_factor",
            "potential_energy_j", "magnetic_energy_j", "energy_form_relative_defect")
        values = {}
        for name in metrics:
            value = sample.get(name)
            if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                    not math.isfinite(value)):
                raise ValueError(f"Gamma K0 {direction}.{name} is invalid")
            values[name] = float(value)
        if values["q_l2_norm"] <= 0 or values["potential_relative_residual"] < 0 or \
                values["potential_relative_residual"] > tolerance:
            raise ValueError(f"Gamma K0 {direction} potential residual is invalid")
        if values["gauge_constraint_abs"] < 0:
            raise ValueError(f"Gamma K0 {direction} gauge residual is invalid")
        if values["energy_form_relative_defect"] < 0 or \
                values["energy_form_relative_defect"] > tolerance:
            raise ValueError(f"Gamma K0 {direction} energy identity exceeds tolerance")
        energy_scale = max(abs(values["potential_energy_j"]),
                           abs(values["magnetic_energy_j"]), 1e-300)
        if min(values["potential_energy_j"], values["magnetic_energy_j"]) < \
                -tolerance * energy_scale:
            raise ValueError(f"Gamma K0 {direction} magnetostatic energy is negative")
        if abs(values["mean_magnetization_a_per_m"] - expected_ms) > \
                GEOMETRY_RELATIVE_TOLERANCE * expected_ms:
            raise ValueError(f"Gamma K0 {direction} perturbation magnetization disagrees with Ms")
        reconstructed_factor = -values["mean_field_a_per_m"] / \
            values["mean_magnetization_a_per_m"]
        if not math.isclose(values["demag_factor"], reconstructed_factor,
                            rel_tol=1e-8, abs_tol=1e-10):
            raise ValueError(f"Gamma K0 {direction} demag factor does not match its measured field")
        directions[direction] = {
            "demag_factor": values["demag_factor"],
            "mean_field_a_per_m": values["mean_field_a_per_m"],
            "mean_magnetization_a_per_m": values["mean_magnetization_a_per_m"],
            "potential_relative_residual": values["potential_relative_residual"],
            "energy_form_relative_defect": values["energy_form_relative_defect"],
        }

    if abs(directions["global_y"]["demag_factor"]) > GAMMA_NY_ABSOLUTE_TOLERANCE:
        raise ValueError("Gamma in-plane probe has nonzero demag for the ideal film")
    measured_nz = directions["global_z"]["demag_factor"]
    if abs(measured_nz - expected_nz) / expected_nz > GAMMA_NZ_RELATIVE_TOLERANCE:
        raise ValueError("Gamma out-of-plane demag disagrees with the finite Dirichlet airbox")
    return {
        "sample_index": gamma_sample_index,
        "status": "passed",
        "expected_nz_from_geometry": expected_nz,
        "measured_nz": measured_nz,
        "relative_nz_error": abs(measured_nz - expected_nz) / expected_nz,
        "magnetic_volume_m3": volume,
        "outer_boundary_kind": probe["outer_boundary_kind"],
        "directions": directions,
    }


def validate_rows(path: Path, sampling: str, solver_diagnostics_path: Path,
                  metadata_path: Path | None = None):
    if sampling not in SAMPLING:
        raise ValueError("unsupported DE-SMOKE sampling")
    expected = SAMPLING[sampling]
    required_probe_samples = [index for index, wavevector in enumerate(expected) if wavevector != 0.0]
    if not required_probe_samples and sampling not in ("k0", "bv-k0"):
        raise ValueError("DE-SMOKE sampling must include a nonzero-k probe")
    probe_reports = (validate_dynamic_demag_probes(solver_diagnostics_path, required_probe_samples)
                     if required_probe_samples else [])
    gamma_indices = [index for index, wavevector in enumerate(expected) if wavevector == 0.0]
    gamma_report = None
    if gamma_indices:
        if metadata_path is None:
            raise ValueError("DE-SMOKE Gamma validation requires run metadata with geometry parameters")
        gamma_report = validate_gamma_demag_probe(
            solver_diagnostics_path, metadata_path, gamma_indices[0])
    if metadata_path is None:
        raise ValueError("DE-SMOKE residual validation requires model metadata")
    try:
        metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
        model = metadata["problem_meta"]["runtime_metadata"]["de_smoke"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise ValueError("run metadata is missing the DE-SMOKE solver tolerance") from error
    if not isinstance(model, dict) or model.get("schema") != "fullmag.de-smoke.v1":
        raise ValueError("run metadata has an unsupported DE-SMOKE model descriptor")
    expected_orientation = "M0=x,k=x,normal=z" if sampling.startswith("bv-") else "M0=x,k=y,normal=z"
    if sampling not in ("two", "five", "k0", "k2", "signed-eleven"):
        if model.get("orientation") != expected_orientation or model.get("sampling") != sampling:
            raise ValueError("DE/BV geometry metadata disagrees with the requested sampling")
        expected_vectors = [[k, 0.0, 0.0] if sampling.startswith("bv-") else [0.0, k, 0.0] for k in expected]
        if model.get("k_vectors_rad_per_m") != expected_vectors:
            raise ValueError("DE/BV wavevector metadata disagrees with the requested sampling")
    solver_rtol = model.get("eigen_solver_rtol") if isinstance(model, dict) else None
    if (isinstance(solver_rtol, bool) or not isinstance(solver_rtol, (int, float)) or
            not math.isfinite(solver_rtol) or solver_rtol <= 0):
        raise ValueError("DE-SMOKE eigen_solver_rtol must be finite and positive")
    native_modes = load_spectrum_v3_modes(Path(path).parent / "spectrum.v3.json")
    if sampling in DENSE_SAMPLING:
        if ({sample for sample, _ in native_modes} != set(range(len(expected))) or
                len(native_modes) != len(expected)):
            raise ValueError("dense DE/BV spectrum requires exactly one mode for each requested sample")
        for (sample, _), mode in native_modes.items():
            required_scope = ("native_descriptor" if expected[sample] == 0.0 else
                              "full_projected_weak_form_and_periodic_seams")
            if mode["residual_scope"] != required_scope:
                raise ValueError("dense DE/BV full descriptor scope disagrees with Gamma/nonzero-k operator")
            if expected[sample] != 0.0 and (
                    mode["poisson_boundary_kind"] != "poisson_dirichlet" or
                    mode["poisson_gauge_policy"] != "none"):
                raise ValueError("dense DE/BV nonzero-k certificate has unexpected Poisson boundary or gauge")

    rows = []
    seen = set()
    seen_branch = set()
    with Path(path).open(encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            indices = {}
            for key in ("sample_index", "raw_mode_index", "branch_id"):
                text = row.get(key, "")
                if not isinstance(text, str) or not text.isascii() or not text.isdecimal():
                    raise ValueError(f"invalid {key}")
                indices[key] = int(text)
            sample = indices["sample_index"]
            if sample >= len(expected):
                raise ValueError("sample index outside the requested path")
            values = {}
            for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", "frequency_hz"):
                try:
                    values[key] = float(row[key])
                except (KeyError, TypeError, ValueError) as error:
                    raise ValueError(f"missing or invalid {key}") from error
                if not math.isfinite(values[key]):
                    raise ValueError(f"nonfinite {key}")
            absolute_residual_text = row.get("residual_norm")
            if absolute_residual_text is None or absolute_residual_text.strip() == "":
                values["residual_norm"] = None
            else:
                try:
                    values["residual_norm"] = float(absolute_residual_text)
                except (TypeError, ValueError) as error:
                    raise ValueError("invalid absolute residual_norm") from error
                if not math.isfinite(values["residual_norm"]):
                    raise ValueError("nonfinite residual_norm")
                if values["residual_norm"] < 0:
                    raise ValueError("absolute residual must be nonnegative")
            transverse_key = "ky_rad_per_m" if sampling.startswith("bv-") else "kx_rad_per_m"
            propagation_key = "kx_rad_per_m" if sampling.startswith("bv-") else "ky_rad_per_m"
            if values[transverse_key] != 0 or values["kz_rad_per_m"] != 0:
                raise ValueError("wavevector is outside the requested propagation direction")
            if not math.isclose(values[propagation_key], expected[sample], rel_tol=1e-12, abs_tol=1e-12):
                raise ValueError("wavevector does not match its sample index")
            frequency_min = 12e9 if sampling in ("k25", "k-25") else 8.5e9
            wide_de_window = (sampling in ("positive-six", "positive-26") or
                              (not sampling.startswith("bv-") and len(expected) == 1 and abs(expected[0]) >= 15e6))
            frequency_max = 16e9 if wide_de_window else 12e9
            if not frequency_min <= values["frequency_hz"] <= frequency_max:
                raise ValueError("frequency outside the frozen DE-SMOKE window")
            mode_key = (sample, indices["raw_mode_index"])
            mode = native_modes.get(mode_key)
            if sampling in DENSE_SAMPLING and mode is not None and not mode["full_descriptor_certified"]:
                raise ValueError("dense DE/BV path requires full descriptor certification for every sample")
            if mode is None:
                raise ValueError(
                    f"spectrum.v3.json is missing sample {sample} mode {indices['raw_mode_index']}")
            if not math.isclose(
                    values["frequency_hz"], mode["frequency_hz"],
                    rel_tol=1e-12, abs_tol=1e-6):
                raise ValueError("dispersion CSV frequency disagrees with native spectrum mode")
            block = mode["block_residuals"]
            effective_tolerance = min(
                float(solver_rtol), mode["certification_tolerance"])
            if sampling in DENSE_SAMPLING:
                effective_tolerance = min(effective_tolerance, DENSE_CERTIFICATION_TOLERANCE)
            if mode["residual_relative_l2"] > effective_tolerance:
                raise ValueError(
                    f"mode residual_relative_l2={mode['residual_relative_l2']:.6g} exceeds solver tolerance {effective_tolerance:.6g}")
            for name in ("eps_q", "eps_phi", "eps_gauge"):
                if block[name] is not None and block[name] > effective_tolerance:
                    raise ValueError(
                        f"mode block residual {name}={block[name]:.6g} exceeds solver tolerance {effective_tolerance:.6g}")
            key = (sample, indices["raw_mode_index"])
            branch_key = (sample, indices["branch_id"])
            if key in seen or branch_key in seen_branch:
                raise ValueError("duplicate mode or branch in a sample")
            seen.add(key)
            seen_branch.add(branch_key)
            rows.append({
                **indices,
                **values,
                "residual_relative_l2": mode["residual_relative_l2"],
                "residual_scope": mode["residual_scope"],
                "full_descriptor_certified": mode["full_descriptor_certified"],
            })
    if sampling in DENSE_SAMPLING and len(rows) != len(expected):
        raise ValueError("dense DE/BV rows require exactly one mode for each requested sample")
    if {r["sample_index"] for r in rows} != set(range(len(expected))):
        raise ValueError("missing DE-SMOKE samples")
    pending_requirements = [
        "numeric-source attestation",
        "complex fields, Bloch phase and mesh identity",
        "explicit n0 branch identification and analytical comparison",
        "mesh, airbox and mode-count convergence"]
    if not all(row["full_descriptor_certified"] for row in rows):
        pending_requirements.insert(1, "full descriptor and Floquet phase/frame seam certification")
    if sampling in ("k0", "bv-k0"):
        pending_requirements.insert(1, "Gamma mode profile and finite-box frequency comparison")
    elif gamma_report is None:
        pending_requirements.insert(1, "T4 Gamma operator probe and finite-box Nz comparison")
    else:
        pending_requirements.insert(1, "T4 nonzero-k field/phase and independent 1D comparison")
    residual_scopes = {row["residual_scope"] for row in rows}
    absolute_residuals = [row["residual_norm"] for row in rows
                          if row["residual_norm"] is not None]
    return {"schema": "fullmag.de-smoke-row-preflight.v2", "status": "pass",
            "qualification": "NOT VERIFIED", "sampling": sampling,
            "mode_rows": len(rows), "sample_count": len(expected),
            "max_absolute_residual_norm": max(absolute_residuals) if absolute_residuals else None,
            "max_relative_residual_l2": max(r["residual_relative_l2"] for r in rows),
            "residual_scope": next(iter(residual_scopes)) if len(residual_scopes) == 1 else "mixed",
            "full_descriptor_certified": all(r["full_descriptor_certified"] for r in rows),
            "gamma_demag_operator_probe": gamma_report,
            "dynamic_demag_operator_probes": probe_reports,
            "pending_requirements": pending_requirements}
