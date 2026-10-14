"""Shape validation for antenna records embedded in SceneDocument.

These IR records contain typed identifiers, references, and scalar parameters,
not source-file paths.  Keep this validator concerned with the JSON wire shape
only; semantic physics validation belongs to the IR/runtime validators.
"""

from __future__ import annotations

import math
from typing import Any, Iterable


class AntennaSceneValidationError(ValueError):
    """An antenna SceneDocument record does not match its closed IR shape."""


def _pointer(parts: tuple[str | int, ...]) -> str:
    return "".join(
        f"/{str(part).replace('~', '~0').replace('/', '~1')}" for part in parts
    )


def _fail(parts: tuple[str | int, ...], message: str) -> None:
    raise AntennaSceneValidationError(f"{message} at {_pointer(parts) or '/'}")


def _record(
    value: Any,
    parts: tuple[str | int, ...],
    description: str,
    required: Iterable[str],
    optional: Iterable[str] = (),
) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(parts, f"{description} must be an object")
    required_fields = set(required)
    allowed_fields = required_fields | set(optional)
    unknown = set(value) - allowed_fields
    if unknown:
        names = ", ".join(sorted(unknown)[:4])
        _fail(parts, f"Unsupported {description} fields: {names}; asset semantics are unknown")
    missing = required_fields - set(value)
    if missing:
        names = ", ".join(sorted(missing)[:4])
        _fail(parts, f"{description} is missing required fields: {names}")
    return value


def _array(value: Any, parts: tuple[str | int, ...], description: str) -> list[Any]:
    if not isinstance(value, list):
        _fail(parts, f"{description} must be an array")
    return value


def _string(value: Any, parts: tuple[str | int, ...], description: str) -> None:
    if not isinstance(value, str):
        _fail(parts, f"{description} must be a string")


def _number(value: Any, parts: tuple[str | int, ...], description: str) -> None:
    # bool is a subclass of int in Python, but serde_json does not deserialize
    # a JSON boolean into an f64.
    if type(value) not in (int, float):
        _fail(parts, f"{description} must be a number")
    try:
        finite = math.isfinite(float(value))
    except (OverflowError, ValueError):
        finite = False
    if not finite:
        _fail(parts, f"{description} must be a finite number")


def _u32(value: Any, parts: tuple[str | int, ...], description: str) -> None:
    if type(value) is not int or not 0 <= value <= 0xFFFF_FFFF:
        _fail(parts, f"{description} must be an unsigned 32-bit integer")


def _enum(value: Any, variants: set[str], parts: tuple[str | int, ...], description: str) -> None:
    if not isinstance(value, str) or value not in variants:
        _fail(parts, f"Unsupported {description} discriminator/value")


def _strings(value: Any, parts: tuple[str | int, ...], description: str) -> None:
    for index, item in enumerate(_array(value, parts, description)):
        _string(item, (*parts, index), f"{description} item")


def _number_array(
    value: Any,
    parts: tuple[str | int, ...],
    description: str,
    *,
    exact_length: int | None = None,
) -> None:
    items = _array(value, parts, description)
    if exact_length is not None and len(items) != exact_length:
        _fail(parts, f"{description} must contain exactly {exact_length} values")
    for index, item in enumerate(items):
        _number(item, (*parts, index), f"{description} item")


def _validate_target(value: Any, parts: tuple[str | int, ...]) -> None:
    target = _record(value, parts, "antenna field target", {"kind"}, {"object_id", "region_id"})
    kind = target["kind"]
    if kind == "global":
        expected = {"kind"}
    elif kind == "object":
        expected = {"kind", "object_id"}
    elif kind == "region":
        expected = {"kind", "object_id", "region_id"}
    else:
        _fail((*parts, "kind"), "Unsupported antenna field target discriminator")
    if set(target) != expected:
        _fail(parts, f"Antenna field target '{kind}' has the wrong shape")
    for field in expected - {"kind"}:
        _string(target[field], (*parts, field), f"target {field}")


_SOLUTION_FIELDS = {"stage_id", "output_id", "asset_id", "content_digest"}


def _validate_solution_ref(value: Any, parts: tuple[str | int, ...]) -> None:
    if not isinstance(value, dict):
        _fail(parts, "antenna solution reference must be an object")
    kind = value.get("kind")
    if kind == "stage_output":
        solution = _record(value, parts, "stage-output reference", {"kind", "stage_id", "output_id"})
        fields = {"stage_id", "output_id"}
    elif kind == "resolved_asset":
        solution = _record(value, parts, "resolved antenna asset reference", {"kind", *_SOLUTION_FIELDS})
        fields = _SOLUTION_FIELDS
    elif kind is not None:
        _fail((*parts, "kind"), "Unsupported antenna solution reference discriminator")
    else:
        solution = _record(value, parts, "published antenna solution reference", _SOLUTION_FIELDS)
        fields = _SOLUTION_FIELDS
    for field in fields:
        _string(solution[field], (*parts, field), f"solution reference {field}")


def _validate_waveform(value: Any, parts: tuple[str | int, ...]) -> None:
    if not isinstance(value, dict):
        _fail(parts, "antenna waveform must be an object")
    kind = value.get("kind")
    if kind == "constant":
        _record(value, parts, "constant waveform", {"kind"})
        return
    if kind == "sinusoidal":
        waveform = _record(value, parts, "sinusoidal waveform", {"kind", "frequency_hz"}, {"phase_rad", "offset"})
        fields = {"frequency_hz", "phase_rad", "offset"} & set(waveform)
    elif kind == "pulse":
        waveform = _record(value, parts, "pulse waveform", {"kind", "t_on", "t_off"})
        fields = {"t_on", "t_off"}
    elif kind == "piecewise_linear":
        waveform = _record(value, parts, "piecewise-linear waveform", {"kind", "points"})
        for index, point in enumerate(_array(waveform["points"], (*parts, "points"), "waveform points")):
            _number_array(point, (*parts, "points", index), "waveform point", exact_length=2)
        return
    elif kind == "sinc_pulse":
        waveform = _record(value, parts, "sinc waveform", {"kind", "cutoff_hz"}, {"t0", "amplitude"})
        fields = {"cutoff_hz", "t0", "amplitude"} & set(waveform)
    else:
        _fail((*parts, "kind"), "Unsupported antenna waveform discriminator")
    for field in fields:
        _number(waveform[field], (*parts, field), f"waveform {field}")


def _validate_activation(value: Any, parts: tuple[str | int, ...]) -> None:
    if not isinstance(value, dict):
        _fail(parts, "drive activation must be an object")
    kind = value.get("kind")
    if kind == "all_time_evolution":
        _record(value, parts, "all-time activation", {"kind"})
    elif kind == "stage_ids":
        activation = _record(value, parts, "stage activation", {"kind", "stage_ids"})
        _strings(activation["stage_ids"], (*parts, "stage_ids"), "activation stage_ids")
    else:
        _fail((*parts, "kind"), "Unsupported drive activation discriminator")


def _validate_port_modes(scene: dict[str, Any]) -> None:
    for index, value in enumerate(_array(scene.get("antenna_port_modes", []), ("antenna_port_modes",), "antenna_port_modes")):
        parts = ("antenna_port_modes", index)
        mode = _record(
            value,
            parts,
            "antenna port mode",
            {"schema_version", "id", "source_object_id", "current_transport_id", "branches"},
            {"normalization_current_a"},
        )
        for field in ("schema_version", "id", "source_object_id", "current_transport_id"):
            _string(mode[field], (*parts, field), f"port mode {field}")
        if "normalization_current_a" in mode:
            _number(mode["normalization_current_a"], (*parts, "normalization_current_a"), "normalization_current_a")
        for branch_index, branch_value in enumerate(_array(mode["branches"], (*parts, "branches"), "port mode branches")):
            branch_parts = (*parts, "branches", branch_index)
            branch = _record(
                branch_value,
                branch_parts,
                "antenna port branch",
                {"id", "inlet_terminal_ref", "outlet_terminal_ref", "signed_weight"},
            )
            for field in ("id", "inlet_terminal_ref", "outlet_terminal_ref"):
                _string(branch[field], (*branch_parts, field), f"port branch {field}")
            _number(branch["signed_weight"], (*branch_parts, "signed_weight"), "port branch signed_weight")


def _validate_field_stages(scene: dict[str, Any]) -> None:
    for index, value in enumerate(_array(scene.get("antenna_field_solve_stages", []), ("antenna_field_solve_stages",), "antenna_field_solve_stages")):
        parts = ("antenna_field_solve_stages", index)
        stage = _record(
            value,
            parts,
            "antenna field-solve stage",
            {
                "id", "source_object_id", "current_transport_id", "port_mode_ids", "model",
                "oersted_realization", "conductor_mesh_policy", "field_sampling_domain",
                "target_refs", "solver_policy", "outputs",
            },
            {"conservative_current_view_ref"},
        )
        for field in ("id", "source_object_id", "current_transport_id", "conductor_mesh_policy", "solver_policy"):
            _string(stage[field], (*parts, field), f"field-solve stage {field}")
        _strings(stage["port_mode_ids"], (*parts, "port_mode_ids"), "stage port_mode_ids")
        _enum(stage["model"], {"quasistatic_conduction_biot_savart3d"}, (*parts, "model"), "antenna field model")
        _enum(stage["oersted_realization"], {"direct_tetra_quadrature", "vector_potential_solver"}, (*parts, "oersted_realization"), "Oersted realization")
        if "conservative_current_view_ref" in stage and stage["conservative_current_view_ref"] is not None:
            _string(stage["conservative_current_view_ref"], (*parts, "conservative_current_view_ref"), "current-view reference")
        _validate_target(stage["field_sampling_domain"], (*parts, "field_sampling_domain"))
        for target_index, target in enumerate(_array(stage["target_refs"], (*parts, "target_refs"), "stage target_refs")):
            _validate_target(target, (*parts, "target_refs", target_index))
        for output_index, output_value in enumerate(_array(stage["outputs"], (*parts, "outputs"), "stage outputs")):
            output_parts = (*parts, "outputs", output_index)
            output = _record(output_value, output_parts, "antenna named output", {"id", "quantity"})
            _string(output["id"], (*output_parts, "id"), "antenna output id")
            _string(output["quantity"], (*output_parts, "quantity"), "antenna output quantity")


def _validate_projections(scene: dict[str, Any]) -> None:
    for index, value in enumerate(_array(scene.get("antenna_target_projections", []), ("antenna_target_projections",), "antenna_target_projections")):
        parts = ("antenna_target_projections", index)
        projection = _record(value, parts, "antenna target projection", {"id", "solution", "target", "output_id"})
        for field in ("id", "output_id"):
            _string(projection[field], (*parts, field), f"projection {field}")
        _validate_solution_ref(projection["solution"], (*parts, "solution"))
        _validate_target(projection["target"], (*parts, "target"))


def _validate_drives(scene: dict[str, Any]) -> None:
    for index, value in enumerate(_array(scene.get("solved_antenna_drives", []), ("solved_antenna_drives",), "solved_antenna_drives")):
        parts = ("solved_antenna_drives", index)
        drive = _record(
            value,
            parts,
            "solved antenna drive",
            {"id", "name", "projection_ref", "port_mode_id", "peak_current_a", "waveform", "time_origin", "activation"},
            {"bandwidth_declaration"},
        )
        for field in ("id", "name", "projection_ref", "port_mode_id"):
            _string(drive[field], (*parts, field), f"solved drive {field}")
        _number(drive["peak_current_a"], (*parts, "peak_current_a"), "drive peak_current_a")
        _validate_waveform(drive["waveform"], (*parts, "waveform"))
        _enum(drive["time_origin"], {"stage_local", "absolute"}, (*parts, "time_origin"), "field time origin")
        _validate_activation(drive["activation"], (*parts, "activation"))
        if "bandwidth_declaration" in drive and drive["bandwidth_declaration"] is not None:
            bandwidth_parts = (*parts, "bandwidth_declaration")
            bandwidth = _record(drive["bandwidth_declaration"], bandwidth_parts, "waveform bandwidth declaration", {"f_max_hz"})
            _number(bandwidth["f_max_hz"], (*bandwidth_parts, "f_max_hz"), "bandwidth f_max_hz")


def _validate_sampling_plane(value: Any, parts: tuple[str | int, ...]) -> None:
    plane = _record(
        value,
        parts,
        "antenna spectrum sampling plane",
        {"origin_m", "axis_u", "axis_v", "extent_u_m", "extent_v_m", "sample_count_u", "sample_count_v", "interpolation", "outside_policy"},
    )
    for field in ("origin_m", "axis_u", "axis_v"):
        _number_array(plane[field], (*parts, field), f"sampling plane {field}", exact_length=3)
    for field in ("extent_u_m", "extent_v_m"):
        _number(plane[field], (*parts, field), f"sampling plane {field}")
    for field in ("sample_count_u", "sample_count_v"):
        _u32(plane[field], (*parts, field), f"sampling plane {field}")
    _string(plane["interpolation"], (*parts, "interpolation"), "sampling plane interpolation")
    _enum(plane["outside_policy"], {"error", "zero"}, (*parts, "outside_policy"), "spectrum outside policy")


def _validate_spectrum_requests(scene: dict[str, Any]) -> None:
    for index, value in enumerate(_array(scene.get("antenna_spectrum_requests", []), ("antenna_spectrum_requests",), "antenna_spectrum_requests")):
        parts = ("antenna_spectrum_requests", index)
        request = _record(
            value,
            parts,
            "antenna spectrum request",
            {"id", "solution_ref", "target", "transform", "sampling_plane", "window", "normalization", "component", "output_id"},
            {"port_mode_id", "nonuniform_k_grid", "equilibrium_ref", "mode_basis_ref"},
        )
        for field in ("id", "component", "output_id"):
            _string(request[field], (*parts, field), f"spectrum request {field}")
        _validate_solution_ref(request["solution_ref"], (*parts, "solution_ref"))
        _validate_target(request["target"], (*parts, "target"))
        _enum(request["transform"], {"spatial_fft", "nonuniform_spatial_fft"}, (*parts, "transform"), "spectrum transform")
        _validate_sampling_plane(request["sampling_plane"], (*parts, "sampling_plane"))
        _enum(request["window"], {"rectangular", "hann", "hamming", "blackman"}, (*parts, "window"), "spectrum window")
        _enum(request["normalization"], {"integral_si", "unitary_discrete"}, (*parts, "normalization"), "spectrum normalization")
        for field in ("port_mode_id", "equilibrium_ref", "mode_basis_ref"):
            if field in request and request[field] is not None:
                _string(request[field], (*parts, field), f"spectrum request {field}")
        if "nonuniform_k_grid" in request and request["nonuniform_k_grid"] is not None:
            grid_parts = (*parts, "nonuniform_k_grid")
            grid = _record(request["nonuniform_k_grid"], grid_parts, "spectrum nonuniform k-grid", {"k_u_rad_per_m", "k_v_rad_per_m"})
            for field in ("k_u_rad_per_m", "k_v_rad_per_m"):
                _number_array(grid[field], (*grid_parts, field), f"nonuniform k-grid {field}")


def validate_antenna_scene_collections(scene: dict[str, Any]) -> None:
    """Validate the exact current SceneDocument antenna field shapes.

    Missing collections and empty arrays match SceneDocument's serde defaults.
    Option values may be omitted or null. This intentionally does not enforce
    cross-reference, uniqueness, positivity, or solver semantics.
    """
    _validate_port_modes(scene)
    _validate_field_stages(scene)
    _validate_projections(scene)
    _validate_drives(scene)
    _validate_spectrum_requests(scene)
