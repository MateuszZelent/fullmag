"""Collect actual signed-k FEM pilots; never infer samples by reflection."""
from __future__ import annotations
import argparse
import csv
import json
import math
from pathlib import Path
import re
from collect_de_bv_thickness_comparison import collect_record, collect_control, read_json
from compare_de_bv_mode_profiles import load_record, sha256
from run_nonzero_k_validation_controller import validation_cases
from validate_de_smoke_rows import SAMPLING, validate_rows, validate_selected_only_diagnostics
from verify_fem_frequency_domain_eigen_artifacts import kalinikos_slab_n0_frequency_hz
from finite_dirichlet_thin_film_oracle import n0_reference_frequencies


def _positive(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"selected-only record has invalid {name}")
    try:
        value = float(value)
    except (OverflowError, ValueError) as error:
        raise ValueError(f"selected-only record has invalid {name}") from error
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"selected-only record has invalid {name}")
    return value


def _attach_n0_references(record, model):
    """Attach resolved open-film and finite-airbox n=0 references.

    The historical ``analytic_frequency_hz`` field is preserved.  New fields
    use the resolved model metadata, including the actual air padding, and
    fail closed when that identity is unavailable.
    """
    parameters = record.get("parameters")
    if not isinstance(parameters, dict):
        raise ValueError("n=0 reference requires model parameters")
    mu0 = _positive(model.get("mu0_t_m_a"), "mu0_t_m_a")
    external_induction = _positive(
        model.get("external_induction_t"), "external_induction_t"
    )
    padding = _positive(
        model.get("air_padding_each_side_m"), "air_padding_each_side_m"
    )
    if "air_padding_each_side_m" in record:
        declared_padding = _positive(
            record.get("air_padding_each_side_m"), "air_padding_each_side_m"
        )
        if not math.isclose(declared_padding, padding, rel_tol=1e-12, abs_tol=0.0):
            raise ValueError("record air padding differs from resolved model metadata")
    resolved_bindings = (
        ("film_thickness_m", "film_thickness_m"),
        ("exchange_stiffness_j_per_m", "exchange_stiffness_j_per_m"),
        ("saturation_magnetisation_a_per_m", "saturation_magnetization_a_per_m"),
        ("gamma0_rad_s_per_a_m", "gamma0_m_per_a_s"),
    )
    for parameter_name, model_name in resolved_bindings:
        if parameter_name in parameters:
            declared = _positive(parameters.get(parameter_name), parameter_name)
            actual = _positive(model.get(model_name), model_name)
            if not math.isclose(declared, actual, rel_tol=1e-12, abs_tol=0.0):
                raise ValueError(
                    f"record {parameter_name} differs from resolved model metadata"
                )
    resolved_bias = external_induction / mu0
    if "bias_field_a_per_m" in parameters:
        declared_bias = _positive(
            parameters.get("bias_field_a_per_m"), "bias_field_a_per_m"
        )
        if not math.isclose(declared_bias, resolved_bias, rel_tol=1e-12, abs_tol=0.0):
            raise ValueError(
                "resolved external_induction_t, mu0_t_m_a and bias_field_a_per_m disagree"
            )
    else:
        parameters["bias_field_a_per_m"] = resolved_bias
    parameters["mu0_t_m_a"] = mu0
    parameters["external_induction_t"] = external_induction
    common = {
        "k_rad_m": record["k_rad_per_m"],
        "geometry": record["geometry"],
        "bias_field_a_per_m": _positive(
            parameters.get("bias_field_a_per_m"), "bias_field_a_per_m"
        ),
        "film_thickness_m": _positive(
            parameters.get("film_thickness_m"), "film_thickness_m"
        ),
        "air_padding_each_side_m": padding,
        "exchange_stiffness_j_per_m": _positive(
            parameters.get("exchange_stiffness_j_per_m"),
            "exchange_stiffness_j_per_m",
        ),
        "saturation_magnetisation_a_per_m": _positive(
            parameters.get("saturation_magnetisation_a_per_m"),
            "saturation_magnetisation_a_per_m",
        ),
        "gamma0_rad_s_per_a_m": _positive(
            parameters.get("gamma0_rad_s_per_a_m"), "gamma0_rad_s_per_a_m"
        ),
        "mu0_t_m_a": mu0,
    }
    references = n0_reference_frequencies(**common)
    open_frequency = references["open_film_n0_frequency_hz"]
    finite_frequency = references["finite_dirichlet_n0_frequency_hz"]
    record["analytic_open_film_n0_frequency_hz"] = open_frequency
    record["analytic_finite_dirichlet_n0_frequency_hz"] = finite_frequency
    record["difference_from_open_film_n0_percent"] = 100.0 * (
        record["frequency_hz"] / open_frequency - 1.0
    )
    record["difference_from_finite_dirichlet_n0_percent"] = 100.0 * (
        record["frequency_hz"] / finite_frequency - 1.0
    )
    record["analytic_references"] = {
        "open_film_n0": {
            "boundary": "open_magnetostatic_free",
            "frequency_hz": open_frequency,
            **references["open_film_n0_demag_factors"],
        },
        "finite_dirichlet_n0": {
            "status": "available",
            "boundary": "scalar_potential_dirichlet",
            "air_padding_each_side_m": padding,
            "frequency_hz": finite_frequency,
            **references["finite_dirichlet_n0_demag_factors"],
        },
    }
    return record


def _reference_summary(records):
    """Return explicit availability metadata without inventing a padding."""
    references = []
    for record in records:
        reference_container = record.get("analytic_references", {})
        references.append(
            reference_container.get("finite_dirichlet_n0")
            if isinstance(reference_container, dict)
            else None
        )
    if not references or any(
        not isinstance(reference, dict) or reference.get("status") != "available"
        for reference in references
    ):
        return {
            "status": "NOT_AVAILABLE",
            "reason": "resolved air_padding_each_side_m is absent from one or more records",
        }
    padding = references[0].get("air_padding_each_side_m")
    if any(reference.get("air_padding_each_side_m") != padding for reference in references):
        return {
            "status": "NOT_AVAILABLE",
            "reason": "records use different resolved airbox padding values",
        }
    return {
        "status": "available",
        "finite_dirichlet_n0": {
            "boundary": "scalar_potential_dirichlet",
            "air_padding_each_side_m": padding,
        },
        "open_film_n0": {"boundary": "open_magnetostatic_free"},
    }


def _selected_sampling(pilot, request):
    if pilot == "de-smoke-nearest-k2":
        sampling = request.get("sampling")
        if sampling != "k2":
            raise ValueError("nearest-k2 alias must preserve the DE k2 sampling")
    elif isinstance(pilot, str) and pilot.startswith("de-smoke-"):
        sampling = pilot.removeprefix("de-smoke-")
    else:
        sampling = None
    if (not isinstance(sampling, str) or re.fullmatch(r"(?:bv-)?k-?\d+", sampling) is None
            or sampling not in SAMPLING or len(SAMPLING[sampling]) != 1):
        raise ValueError("selected-only record must identify one single-k DE/BV sampling")
    geometry = "backward_volume" if sampling.startswith("bv-") else "damon_eshbach"
    orientation = "M0=x,k=x,normal=z" if sampling.startswith("bv-") else "M0=x,k=y,normal=z"
    return sampling, geometry, orientation


def _collect_selected_record(run, expected_job, model_ref):
    """Collect one real nearest-mode output without applying a window gate."""
    run = Path(run).resolve()
    request, result = read_json(run / "run-request.json"), read_json(run / "run-result.json")
    if (request.get("schema") != "fullmag.de-smoke.request.v1" or
            result.get("schema") != "fullmag.de-smoke.result.v1" or
            result.get("status") != "completed_unqualified" or
            type(result.get("return_code")) is not int or result["return_code"] != 0):
        raise ValueError("expected a completed selected-only numerical pilot")
    if request.get("job") != expected_job or result.get("job") != expected_job:
        raise ValueError("selected-only receipt job identity differs from controller")
    for key in ("source", "model_source", "model_sha256"):
        if not request.get(key) or request[key] != result.get(key):
            raise ValueError("selected-only receipt identity mismatch: " + key)
    pilot = result.get("pilot")
    sampling, geometry, orientation = _selected_sampling(pilot, request)
    if (request.get("sampling") != sampling or request.get("cases") != [pilot]
            or request.get("operation") != pilot + "-numerical-pilot"):
        raise ValueError("selected-only request sampling differs from pilot")
    if request.get("modal_target") != "nearest" or request.get("spectral_target") != "nearest":
        raise ValueError("selected-only request does not declare nearest target")
    if request.get("selection_scope") != "selected_only" or request.get("window_complete") is not False:
        raise ValueError("selected-only request has an invalid completeness declaration")
    if request.get("thickness_layers_requested") != "3":
        raise ValueError("selected-only comparison requires the published three-layer mesh input")
    target_hz = _positive(request.get("target_frequency_hz"), "target_frequency_hz")
    case = run / pilot
    metadata_path = case / "metadata.json"
    metadata = read_json(metadata_path)
    model = metadata["problem_meta"]["runtime_metadata"]["de_smoke"]
    if (model.get("schema") != "fullmag.de-smoke.v1" or model.get("sampling") != sampling or
            model.get("orientation") != orientation or model.get("outer_boundary_kind") != "poisson_dirichlet" or
            model.get("modal_target") != "nearest" or model.get("selection_scope") != "selected_only" or
            model.get("window_complete") is not False):
        raise ValueError("selected-only model metadata disagrees with the request")
    if not math.isclose(_positive(model.get("target_frequency_hz"), "model target_frequency_hz"),
                        target_hz, rel_tol=1e-12, abs_tol=1e-6):
        raise ValueError("selected-only model target differs from the request")
    if result.get("model_source", {}).get("commit") != model_ref:
        raise ValueError("selected-only model source mismatch")
    bias_t = _positive(model["external_induction_t"], "external_induction_t")
    mu0 = _positive(model["mu0_t_m_a"], "mu0_t_m_a")
    bias_h = bias_t / mu0

    diagnostics_path = case / "eigen/diagnostics/solver.v1.json"
    native_target = validate_selected_only_diagnostics(diagnostics_path, target_hz)
    validate_rows(case / "eigen/dispersion.csv", sampling, diagnostics_path, metadata_path,
                  selection_scope="selected_only")
    with (case / "eigen/dispersion.csv").open(encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))
    # The nearest authoring fixture requests exactly one OutputIR mode index;
    # the current native producer therefore publishes raw mode 0 and the shared
    # artifact loader binds mode_0000.json. A future nonzero selected index needs
    # an explicit loader/schema extension instead of silently accepting mode 0.
    if len(rows) != 1 or rows[0].get("sample_index") != "0" or rows[0].get("raw_mode_index") != "0":
        raise ValueError("selected-only comparison requires exactly one sample and mode")
    row = rows[0]
    k_text = row["ky_rad_per_m"] if geometry == "damon_eshbach" else row["kx_rad_per_m"]
    try:
        k = float(k_text)
    except (TypeError, ValueError) as error:
        raise ValueError("selected-only wavevector is invalid") from error
    if not math.isfinite(k):
        raise ValueError("selected-only wavevector is nonfinite")
    if not math.isclose(k, SAMPLING[sampling][0], rel_tol=1e-12, abs_tol=1e-12):
        raise ValueError("selected-only actual wavevector differs from requested sample")
    frequency = _positive(float(row["frequency_hz"]), "frequency_hz")
    mode_path = case / "eigen/modes/sample_0000/mode_0000.json"
    mode = read_json(mode_path)
    blocks = mode.get("block_residuals")
    if (not isinstance(blocks, dict) or blocks.get("full_descriptor_certified") is not True or
            blocks.get("certified") is not True):
        raise ValueError("selected-only mode has no full descriptor certificate")
    residual = blocks.get("eps_full")
    if (isinstance(residual, bool) or not isinstance(residual, (int, float)) or
            not math.isfinite(residual) or not 0 <= residual <= 1e-8):
        raise ValueError("selected-only mode fails original full residual gate")
    files = ["run-request.json", "run-result.json", pilot + "/metadata.json",
             pilot + "/eigen/dispersion.csv", pilot + "/eigen/diagnostics/solver.v1.json",
             pilot + "/eigen/spectrum.v3.json", pilot + "/eigen/modes/sample_0000/mode_0000.json"]
    record = {
        "geometry": geometry, "k_rad_per_m": k, "frequency_hz": frequency,
        "analytic_frequency_hz": kalinikos_slab_n0_frequency_hz(
            k_norm=abs(k), geometry=geometry,
            bias_field_a_per_m=bias_h,
            film_thickness_m=_positive(model["film_thickness_m"], "film_thickness_m"),
            exchange_stiffness_j_per_m=_positive(model["exchange_stiffness_j_per_m"], "exchange_stiffness_j_per_m"),
            saturation_magnetisation_a_per_m=_positive(model["saturation_magnetization_a_per_m"], "saturation_magnetization_a_per_m"),
            gamma0_rad_s_per_a_m=_positive(model["gamma0_m_per_a_s"], "gamma0_m_per_a_s")),
        "parameters": {
            "geometry": geometry,
            "bias_field_a_per_m": bias_h,
            "external_induction_t": bias_t,
            "mu0_t_m_a": mu0,
            "film_thickness_m": _positive(model["film_thickness_m"], "film_thickness_m"),
            "exchange_stiffness_j_per_m": _positive(model["exchange_stiffness_j_per_m"], "exchange_stiffness_j_per_m"),
            "saturation_magnetisation_a_per_m": _positive(model["saturation_magnetization_a_per_m"], "saturation_magnetization_a_per_m"),
            "gamma0_rad_s_per_a_m": _positive(model["gamma0_m_per_a_s"], "gamma0_m_per_a_s")},
        "full_residual": float(residual), "parameters_source": "run metadata",
        "pilot": pilot, "run_path": str(run), "job": expected_job,
        "model_source": result["model_source"], "mesh_level": request.get("mesh_level_requested"),
        "thickness_layers": 3,
        "air_padding_each_side_m": _positive(model["air_padding_each_side_m"], "air_padding_each_side_m"),
        "modal_target": "nearest", "selection_scope": "selected_only", "window_complete": False,
        "target_frequency_hz": target_hz, "native_target_frequency_hz": native_target["target_frequency_hz"],
        "artifact_sha256": {name: sha256(run / name) for name in files}}
    _attach_n0_references(record, model)
    mesh, _, tetra, _, hashes, uniform = load_record(record)
    import numpy as np
    xy = np.unique(np.round(mesh.nodes[np.unique(tetra), :2], 17), axis=0)
    record.update(uniform_projection_squared_consistent_mass=uniform,
                  profile_input_sha256=hashes,
                  magnetic_xy_sha256=sha256_bytes(xy.astype("<f8").tobytes()))
    return record


def sha256_bytes(data):
    import hashlib
    return hashlib.sha256(data).hexdigest()


def _nearest_controller_contract(config):
    """Resolve the six controller cases and their pinned target frequencies."""
    expected = validation_cases("nearest-single-k")
    targets = config.get("nearest_targets_ghz")
    expected_pilots = {pilot for _, pilot, _ in expected}
    if not isinstance(targets, dict) or set(targets) != expected_pilots:
        raise ValueError("nearest controller must pin exactly one target for every expected pilot")
    target_hz = {}
    for _, pilot, _ in expected:
        value = targets[pilot]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("nearest controller target must be finite and positive")
        try:
            value = float(value)
        except (OverflowError, ValueError) as error:
            raise ValueError("nearest controller target must be finite and positive") from error
        if not math.isfinite(value) or value <= 0:
            raise ValueError("nearest controller target must be finite and positive")
        converted = value * 1e9
        if not math.isfinite(converted):
            raise ValueError("nearest controller target overflows when converted to Hz")
        target_hz[pilot] = converted
    return expected, target_hz


def collect_selected_only(control_path, config, control, root, relative, model_ref, declared_controller_hash):
    """Collect explicit nearest runs; no missing negative point is synthesized."""
    rows = control.get("results")
    expected, target_hz_by_pilot = _nearest_controller_contract(config)
    if not isinstance(rows, list) or len(rows) != len(expected):
        raise ValueError("selected-only controller must contain exactly the six expected cases")
    points = []
    seen_cases = set()
    baseline = None
    for result, (expected_case, expected_pilot, expected_layers) in zip(rows, expected):
        if (not isinstance(result, dict) or type(result.get("wrapper_exit")) is not int or
                result["wrapper_exit"] != 0 or not isinstance(result.get("case"), str) or
                result.get("case") != expected_case or
                result["case"] in seen_cases):
            raise ValueError("selected-only controller cases differ from the six expected cases")
        name = result["case"]
        seen_cases.add(name)
        output = result.get("output")
        if (not isinstance(output, str) or not Path(output).is_absolute() or
                Path(output).resolve() != root / name):
            raise ValueError("selected-only case output escapes pinned batch")
        request = read_json(Path(output) / "run-request.json")
        case_job = request.get("job")
        source = request.get("source")
        if (not isinstance(case_job, dict) or case_job.get("job_id") != control["job_id"] or
                case_job.get("source_digest") != control["source_digest"] or
                not isinstance(source, dict) or
                source.get("capsule_relative") != relative.removesuffix("/tree")):
            raise ValueError("selected-only case source identity mismatch")
        record = _collect_selected_record(output, case_job, model_ref)
        if record.get("pilot") != expected_pilot:
            raise ValueError("selected-only controller case is bound to the wrong pilot")
        expected_sampling = expected_pilot.removeprefix("de-smoke-")
        expected_k = SAMPLING[expected_sampling][0]
        expected_geometry = ("backward_volume" if expected_sampling.startswith("bv-")
                             else "damon_eshbach")
        actual_k = record.get("k_rad_per_m")
        if (record.get("geometry") != expected_geometry or
                record.get("thickness_layers") != int(expected_layers) or
                isinstance(actual_k, bool) or not isinstance(actual_k, (int, float)) or
                not math.isfinite(actual_k) or
                not math.isclose(actual_k, expected_k, rel_tol=1e-12, abs_tol=1e-12)):
            raise ValueError("selected-only controller case has the wrong signed wavevector")
        pinned_target_hz = target_hz_by_pilot[expected_pilot]
        for field in ("target_frequency_hz", "native_target_frequency_hz"):
            try:
                actual_target_hz = _positive(record.get(field), field)
            except (TypeError, ValueError) as error:
                raise ValueError("selected-only record is missing the pinned controller target") from error
            if not math.isclose(actual_target_hz, pinned_target_hz, rel_tol=1e-12, abs_tol=1e-6):
                raise ValueError("selected-only record target differs from pinned controller target")
        common = {"job": record["job"], "model_source": record["model_source"],
                  "parameters": {k: v for k, v in record["parameters"].items() if k != "geometry"},
                  "mesh_level": record["mesh_level"],
                  "air_padding_each_side_m": record["air_padding_each_side_m"],
                  "magnetic_xy_sha256": record["magnetic_xy_sha256"]}
        if baseline is None:
            baseline = common
        elif common != baseline:
            raise ValueError("selected-only comparison changes controlled material, mesh or source")
        points.append(record)
    by_geometry = {geometry: [r for r in points if r["geometry"] == geometry]
                   for geometry in ("damon_eshbach", "backward_volume")}
    if any(not values for values in by_geometry.values()):
        raise ValueError("selected-only comparison requires both DE and BV actual samples")
    for geometry, values in by_geometry.items():
        keys = [r["k_rad_per_m"] for r in values]
        if len(set(keys)) != len(keys) or not any(k == 0.0 for k in keys):
            raise ValueError("selected-only comparison requires a unique actual Gamma sample per geometry")
        magnitudes = {abs(k) for k in keys if k != 0.0}
        if not any(m in keys and -m in keys for m in magnitudes):
            raise ValueError("selected-only comparison requires actual positive and negative k samples")
    symmetry = []
    for geometry, values in by_geometry.items():
        by_k = {r["k_rad_per_m"]: r for r in values}
        for magnitude in sorted({abs(k) for k in by_k if k > 0} &
                                {abs(k) for k in by_k if k < 0}):
            positive, negative = by_k[magnitude], by_k[-magnitude]
            mean = (positive["frequency_hz"] + negative["frequency_hz"]) / 2
            symmetry.append({"geometry": geometry, "abs_k_rad_per_m": magnitude,
                "actual_positive_k_rad_per_m": positive["k_rad_per_m"],
                "actual_negative_k_rad_per_m": negative["k_rad_per_m"],
                "f_positive_hz": positive["frequency_hz"], "f_negative_hz": negative["frequency_hz"],
                "signed_difference_hz": positive["frequency_hz"] - negative["frequency_hz"],
                "relative_difference_percent": 100 * (positive["frequency_hz"] - negative["frequency_hz"]) / mean})
    return {"schema": "fullmag.selected-de-bv-nearest.v1", "qualification": "NOT VERIFIED",
            "scope": "actual selected-only nearest samples; no reflected or full-window data",
            "selection_scope": "selected_only", "modal_target": "nearest", "window_complete": False,
            "mirrored_samples": False,
            "records": points, "symmetry_measurements": symmetry,
            "analytic_reference_models": _reference_summary(points),
            "convergence_evidence": {"status": "NOT VERIFIED", "reason": "selected-only diagnostic has no full-window convergence certificate"},
            "controller_source_sha256": declared_controller_hash,
            "collector_source_sha256": sha256(Path(__file__)),
            "controller_sha256": sha256(control_path),
            "controller_config_sha256": sha256(root / "controller-config.json")}


def collect(control_path):
    control_path = Path(control_path).resolve()
    root = control_path.parent
    config = read_json(root / "controller-config.json")
    control = read_json(control_path)
    series = config.get("series")
    if series not in {"signed-13", "nearest-single-k"}:
        raise ValueError("expected pinned signed-13 or nearest-single-k series")
    for key, width in (("job_id", 32), ("source_digest", 64)):
        value = control.get(key)
        if (not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{%d}" % width, value) is None
                or value != config.get(key)):
            raise ValueError("controller identity mismatch")
    model_ref = config.get("model_ref")
    if not isinstance(model_ref, str) or re.fullmatch(r"[a-f0-9]{40}", model_ref) is None:
        raise ValueError("expected full model source commit")
    if (len(root.parents) < 5 or root.name != control["job_id"] or root.parent.name != "nonzero-k-validation"
            or root.parents[1].name != "scientific-batches" or root.parents[3].name != "runs"):
        raise ValueError("controller report is outside its canonical batch")
    capsule = Path(config.get("capsule", "")).resolve()
    storage = root.parents[4]
    expected_prefix = "runs/" + root.parents[2].name + "/"
    try:
        relative = capsule.relative_to(storage).as_posix()
    except ValueError as error:
        raise ValueError("controller capsule escapes batch storage") from error
    if re.fullmatch(re.escape(expected_prefix) + r"[a-f0-9]{32}/source/tree", relative) is None:
        raise ValueError("controller capsule path is not canonical")
    controller_source = capsule / "scripts/run_nonzero_k_validation_controller.py"
    declared_controller_hash = config.get("controller_sha256")
    if (not isinstance(declared_controller_hash, str)
            or re.fullmatch(r"[a-f0-9]{64}", declared_controller_hash) is None
            or not controller_source.is_file() or controller_source.is_symlink()
            or sha256(controller_source) != declared_controller_hash):
        raise ValueError("controller source hash differs from pinned capsule")
    if series == "nearest-single-k":
        return collect_selected_only(control_path, config, control, root, relative,
                                     model_ref, declared_controller_hash)
    expected = validation_cases("signed-13")
    rows = control.get("results")
    if not isinstance(rows, list) or len(rows) != len(expected):
        raise ValueError("signed-k controller is incomplete")
    points = []
    baseline = None
    for result, (name, pilot, layers) in zip(rows, expected):
        if (not isinstance(result, dict) or result.get("case") != name
                or type(result.get("wrapper_exit")) is not int or result["wrapper_exit"] != 0):
            raise ValueError("unsuccessful or reordered signed-k case")
        output = result.get("output")
        if not isinstance(output, str) or not Path(output).is_absolute() or Path(output).resolve() != root / name:
            raise ValueError("case output escapes pinned batch")
        request = read_json(Path(output) / "run-request.json")
        job = request.get("job")
        if (not isinstance(job, dict) or job.get("job_id") != control["job_id"]
                or job.get("source_digest") != control["source_digest"]):
            raise ValueError("case build source identity mismatch")
        source = request.get("source")
        if (not isinstance(source, dict)
                or source.get("capsule_relative") != relative.removesuffix("/tree")):
            raise ValueError("case source capsule differs from pinned controller")
        if layers != "3":
            continue  # Separate thickness collector receives convergence-results.json.
        record = collect_record(output, 3, job, sampling=pilot.removeprefix("de-smoke-"))
        metadata_path = Path(output) / pilot / "metadata.json"
        if metadata_path.is_file():
            model = read_json(metadata_path)["problem_meta"]["runtime_metadata"]["de_smoke"]
            _attach_n0_references(record, model)
        else:
            record["analytic_references"] = {
                "finite_dirichlet_n0": {
                    "status": "NOT_AVAILABLE",
                    "reason": "resolved model metadata is absent",
                },
                "open_film_n0": {"status": "available", "boundary": "open_magnetostatic_free"},
            }
        if record["model_source"].get("commit") != model_ref:
            raise ValueError("case model source mismatch")
        common = {"job": job, "model_source": record["model_source"],
                  "parameters": {k: v for k, v in record["parameters"].items() if k != "geometry"},
                  "mesh_level": record["mesh_level"],
                  "air_padding_each_side_m": record["air_padding_each_side_m"],
                  "magnetic_xy_sha256": record["magnetic_xy_sha256"]}
        if baseline is None:
            baseline = common
        elif common != baseline:
            raise ValueError("signed comparison changes controlled material, mesh or source")
        points.append(record)
    wanted = {0.0, *[sign * magnitude * 1e6 for magnitude in (2, 5, 10, 15, 20, 25) for sign in (-1, 1)]}
    indexed = {}
    for geometry in ("damon_eshbach", "backward_volume"):
        selected = [r for r in points if r["geometry"] == geometry]
        if len(selected) != 13:
            raise ValueError("signed dispersion lacks actual samples")
        by_k = {}
        for expected_k in wanted:
            matches = [r for r in selected if math.isclose(
                r["k_rad_per_m"], expected_k, rel_tol=1e-12, abs_tol=1e-12)]
            if len(matches) != 1:
                raise ValueError("signed dispersion lacks unique actual samples")
            by_k[expected_k] = matches[0]
        indexed[geometry] = by_k
    symmetry = []
    for geometry in ("damon_eshbach", "backward_volume"):
        by_k = indexed[geometry]
        for magnitude in (2, 5, 10, 15, 20, 25):
            positive, negative = by_k[magnitude * 1e6], by_k[-magnitude * 1e6]
            mean = (positive["frequency_hz"] + negative["frequency_hz"]) / 2
            symmetry.append({"geometry": geometry, "abs_k_rad_per_m": magnitude * 1e6,
                "actual_positive_k_rad_per_m": positive["k_rad_per_m"],
                "actual_negative_k_rad_per_m": negative["k_rad_per_m"],
                "f_positive_hz": positive["frequency_hz"], "f_negative_hz": negative["frequency_hz"],
                "signed_difference_hz": positive["frequency_hz"] - negative["frequency_hz"],
                "relative_difference_percent": 100 * (positive["frequency_hz"] - negative["frequency_hz"]) / mean})
    convergence = collect_control(root / "convergence-results.json")
    if convergence.get("controller_config_sha256") != sha256(root / "controller-config.json"):
        raise ValueError("convergence evidence differs from signed controller config")
    return {"schema": "fullmag.signed-de-bv-dispersion.v1", "qualification": "NOT VERIFIED",
            "scope": "actual signed-k samples; convergence and scientific qualification remain separate",
            "records": points, "symmetry_measurements": symmetry,
            "analytic_reference_models": _reference_summary(points),
            "convergence_evidence": convergence,
            "controller_source_sha256": declared_controller_hash,
            "collector_source_sha256": sha256(Path(__file__)),
            "controller_sha256": sha256(control_path),
            "controller_config_sha256": sha256(root / "controller-config.json")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("control", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    report = collect(args.control)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
    print(json.dumps({"output": str(args.output), "actual_numerical_points": len(report["records"])}))


if __name__ == "__main__":
    main()
